# 体积云 overlay 线性域化与链重排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「lensFlare halo 光晕被体积云覆盖」——云 overlay 从链尾 display 域迁移到 atmosphere 与 lensFlare 之间的线性 HDR 域。

**Architecture:** 三步走：① 云 overlay shader 线性域化（premultiplied over 直加，删云单独 ACES）+ RT HDR 化；② core 新增 `insertStageBeforeLensFlare` 编排 API（重挂式：摘 lf/tm → 插入 → rebuild lf → re-add tm）；③ overlay 从 per-impl 资源迁移为 per-handle（跨 setQuality 存活、不自动 add、demo 显式编排）。

**Tech Stack:** TypeScript + Vitest + GLSL（Cesium PostProcessStage 链）

**Spec:** `docs/superpowers/specs/2026-08-29-clouds-linear-overlay-design.md`（v2.1 已终审）——**spec 是权威，本计划是它的论证；冲突以 spec 为准**

## Global Constraints

- **零回归底线**：`clouds=0` 时链不变（`[dt,] atmo, lf, tm`），insert API 不被调用——所有既有验收 URL 行为不变（spec §3 表第一行）。
- **质量档位合并语义零触碰**（c72dd35）：唯一允许的交叉是 overlay 所有权迁移引起的销毁清单/接口调整 + 配套测试修订（spec §10）。
- **insertStageBeforeLensFlare 全语义逐条实现**（spec §5.1 JSDoc，v2.1 闭环）：入口拒已销毁 stage、contains 前置、同实例且未销毁幂等 no-op、不同实例替换、尽力回滚（回滚撤插入物 + 独立 try/catch 保原始异常）、destroyed guard no-op+warn、lf 不存在只重排 tm、rebuild lf 继承 enabled。
- **setQuality 失败分支必须摘顶层 overlay**（spec §6.2，评审 BLOCKER）——否则悬挂链上每帧读已销毁 bridge，静默黑帧。
- **clouds overlay 创建后不自动 add**（spec §6.3）——add 时机移交消费者（demo 走 insert；独立消费者自行 add）。
- 所有代码注释、测试注释、文档用**中文**（仓库惯例）。
- 测试命令：`pnpm --filter @cesium-geospatial/clouds test` / `pnpm --filter @cesium-geospatial/core test`；单文件 `pnpm --filter @cesium-geospatial/<pkg> exec vitest run src/<path>`。
- 工作目录：worktree `clouds-linear-overlay`（.claude/worktrees/clouds-linear-overlay），所有路径相对 worktree 根。
- **T1 单独合入时视觉暂错**（overlay 在链尾读 display 域按线性处理，云过曝失真）——T1 只做单测验收，demo 视觉验收统一在 T4 后（spec §12）。

---

### Task 1: overlay 线性域 shader + HDR datatype（clouds 包）

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts:210-251`（OVERLAY_SHADER + 常量注释 + :127 JSDoc）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts:216-227`（shader 断言用例改写）+ 新增 datatype 用例

**Interfaces:**
- Consumes: `resolveCloudsHdrDatatype(scene)`（`./CloudsPass` 已导出，`CloudsPass.ts:80`，本文件已 import）
- Produces: 新 OVERLAY_SHADER（含 `cloud.rgb * u_cloudsExposure` 线性式）；`pixelDatatype: resolveCloudsHdrDatatype(scene)`。T3 在此基础上做所有权迁移（不动 shader）。

- [ ] **Step 1: 改写 shader 断言用例（先失败）**

`createCloudsStage.test.ts` 的用例（:216-227 现断言 `cloudsOverlay_ACESFilmic` 在场）改写为：

```ts
  it('overlay fragmentShader 线性域 premultiplied over（v2 spec §4.1：删云单独 ACES，链尾 tonemap 统一）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(handle!.overlayStage.fragmentShader).toContain('colorTexture')
    expect(handle!.overlayStage.fragmentShader).toContain('u_cloudsBuffer')
    // 线性域式在场（spec §4.1）
    expect(handle!.overlayStage.fragmentShader).toContain('scene.rgb * (1.0 - cloud.a)')
    expect(handle!.overlayStage.fragmentShader).toContain('cloud.rgb * u_cloudsExposure')
    // display 域三件套不在场：ACESFilmic 函数 / unpremultiply / gamma
    expect(handle!.overlayStage.fragmentShader).not.toContain('cloudsOverlay_ACESFilmic')
    expect(handle!.overlayStage.fragmentShader).not.toContain('1.0 / 2.2')
    expect(handle!.overlayStage.fragmentShader).not.toContain('max(cloud.a')
    handle!.destroy()
  })

  it('overlay pixelDatatype = resolveCloudsHdrDatatype(scene)（线性 HDR RT，spec §4.2 D6）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    // mock resolveCloudsHdrDatatype 返 0x140b（HALF_FLOAT 哨兵，见 vi.mock('./CloudsPass') :71）
    expect(handle!.overlayStage.pixelDatatype).toBe(0x140b)
    handle!.destroy()
  })
```

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts -t "线性域"`
Expected: FAIL（当前 shader 含 ACESFilmic、不含线性式；pixelDatatype 是 UNSIGNED_BYTE 1）

- [ ] **Step 3: 重写 OVERLAY_SHADER 与常量注释**

`createCloudsStage.ts` :210-247 整段（OVERLAY_SHADER 及其头注释）替换为：

```ts
// overlay fragment shader（v2 spec §4.1 线性域化）：读前一 stage 输出（atmosphere 线性 HDR）+
// cloudsBuffer（march/resolve 输出，premultiplied 线性 HDR）。
// 线性域 premultiplied over：cloud.rgb 已含 opacity 因子，直接加和（无 unpremultiply/ACES/gamma——
// 由链尾 tonemap 统一收尾，消灭 M2「云单独 ACES」display 域双 ACES 债）。
// 位置：atmosphere 之后、lensFlare/tonemap 之前（demo 经 insertStageBeforeLensFlare 编排）——
// halo 光晕叠加在云之上（修复「光晕被云覆盖」）。
//
// 无样本路径 clouds.frag color=vec4(0) → a=0 且 rgb=0 → final = x·1.0 + 0·E = x，逐位透传。
// 颜色标定：u_cloudsExposure = 线性域云 premultiplied 值缩放（three 版 storybook ToneMapping
// exposure=10 → 本项目 display 域时代标定 6 → 线性域起点沿用 6，V2 视觉验收后定稿）。
const OVERLAY_SHADER = `uniform sampler2D colorTexture;
uniform sampler2D u_cloudsBuffer;
uniform float u_cloudsExposure;
in vec2 v_textureCoordinates;

void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  vec4 cloud = texture(u_cloudsBuffer, v_textureCoordinates);
  // 线性域 premultiplied over（spec D5）：E·premultiplied ≡ premultiplied(E·straight)。
  // ACES + gamma 由链尾 tonemap 统一。
  vec3 final = scene.rgb * (1.0 - cloud.a) + cloud.rgb * u_cloudsExposure;
  out_FragColor = vec4(final, scene.a);
}
`
```

常量注释（:249-251）改为：

```ts
// 云 overlay 曝光（v2 spec §4.3/D7）：线性域云 premultiplied 值缩放（链尾统一 ACES）。
// 起点沿用 display 域时代标定 6（不透明云内部新旧式同为 pow(ACES(6·rgb), 1/2.2)），
// V2 视觉验收后定稿并回改此处 + README。
const CLOUDS_OVERLAY_EXPOSURE_DEFAULT = 6
```

`CloudsStageOptions.cloudsOverlayExposure` JSDoc（:127 附近）「默认 10，对齐 three 版 clouds storybook ToneMapping exposure 标定」改为「默认 6，线性域云 premultiplied 值缩放（V2 验收后定稿）；demo `?cloudsExposure=N` 调节」。

- [ ] **Step 4: overlay 构造 pixelDatatype 切换**

`createCloudsStage.ts:466-481` 注释与构造参数改：

```ts
  // ── overlay PostProcessStage（cloudsBuffer bridge + 前一 stage 线性 HDR mix）──
  // sampleMode NEAREST：保护云边缘锐利（cloudsBuffer 是 raymarch 像素对齐数据纹理，LINEAR 会糊边缘）
  //   + atmosphere input dithering 透传（同 tonemap NEAREST 保护的逻辑）。
  // pixelDatatype resolveCloudsHdrDatatype（spec D6）：线性 HDR RT 承载 >1 段（UNSIGNED_BYTE 会
  //   clip，真 8-bit 设备客观降级）；与 march RT / resolvePass 同源检测。
  const overlayStage = new PostProcessStage({
    name: 'clouds_overlay',
    fragmentShader: OVERLAY_SHADER,
    uniforms: {
      // bridge 每帧重新取（防 resize 后 colorTex 引用变更；接口留动态）。
      // temporal 时读 resolve 输出（全分重建后的 cloudsBuffer）；否则 march att0 直读。
      u_cloudsBuffer: () =>
        resolvePass != null ? resolvePass.getResolvedBridge() : cloudsPass.getColorBridge(),
      // 云曝光（线性域缩放，spec §4.3；URL ?cloudsExposure=N 可调）
      u_cloudsExposure: options.cloudsOverlayExposure ?? CLOUDS_OVERLAY_EXPOSURE_DEFAULT
    },
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: resolveCloudsHdrDatatype(scene)
  })
  scene.postProcessStages.add(overlayStage)
```

（本 task 保留 `scene.postProcessStages.add(overlayStage)`——所有权迁移是 Task 3。）

- [ ] **Step 5: 运行两用例验证通过 + 全包回归**

Run: `pnpm --filter @cesium-geospatial/clouds test`
Expected: 全绿（既有用例中 `:229-240`「u_cloudsBuffer = bridge」不受影响；:203-214 add 断言仍过——T3 才改）

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "feat(clouds): overlay 线性域化——premultiplied over 直加删云单独 ACES + RT HDR 化（spec §4，halo 层级修复第一步）"
```

---

### Task 2: insertStageBeforeLensFlare 编排 API（core 包）

**Files:**
- Create: `packages/cesium-core/src/cesium/AtmosphereStage.insert.test.ts`（新测试文件——vi.mock createLensFlareStage 会破坏主测试文件对真实 composite 结构的断言，故隔离）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`（removeAndDestroy 防御 :665-669、handle 接口 :336-355、destroy :724-738、setMode guard :693、新增 insert + rebuildLensFlare）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts:442`（mockSceneWithAddSpy remove spy 化 + 有状态集合）

**Interfaces:**
- Consumes: `createLensFlareStage(scene, state, options, depthSource)`（`./lensFlare/createLensFlareStage`，现有）；`resolved`（闭包变量，rebuild 读当前值非快照）；`temporalEmaEnabled`（创建时常量）
- Produces: `AtmosphereStageHandle.insertStageBeforeLensFlare(stage: PostProcessStage | PostProcessStageComposite): void`（T4 demo 消费）；handle 全方法 destroyed guard。

- [ ] **Step 1: 升级 mockSceneWithAddSpy（有状态集合 + remove/contains spy）**

`AtmosphereStage.test.ts` :422-445 的 mockSceneWithAddSpy 改为（返回值扩展，旧用例解构 `{ scene, addSpy }` 不破坏）：

```ts
function mockSceneWithAddSpy(
  opts: { halfFloat?: boolean } = {}
): {
  scene: import('cesium').Scene
  addSpy: ReturnType<typeof vi.fn>
  removeSpy: ReturnType<typeof vi.fn>
  containsSpy: ReturnType<typeof vi.fn>
  /** add/remove/contains 跨方法调用序（invocationCallOrder 的便捷替身）：按时间序的 'add:x'/'remove:x' 描述串 */
  ops: () => string[]
} {
  const half = opts.halfFloat ?? true
  const addSpy = vi.fn()
  const removeSpy = vi.fn(() => false)
  const containsSpy = vi.fn(() => false)
  const timeline: string[] = []
  addSpy.mockImplementation((s: { name?: string }) => {
    timeline.push(`add:${String(s?.name ?? 'unnamed')}`)
  })
  removeSpy.mockImplementation((s: { name?: string }) => {
    timeline.push(`remove:${String(s?.name ?? 'unnamed')}`)
    return false
  })
  containsSpy.mockImplementation(() => false)
  const scene = {
    context: {
      halfFloatingPointTexture: half,
      colorBufferHalfFloat: half,
      floatingPointTexture: !half,
      colorBufferFloat: false
    },
    globe: { depthTestAgainstTerrain: false, ellipsoid: Ellipsoid.WGS84 },
    camera: { positionWC: new Cartesian3(6378137, 0, 0) },
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    preRender: { addEventListener: () => () => {} },
    postRender: { addEventListener: () => () => {} },
    postProcessStages: { add: addSpy, remove: removeSpy, contains: containsSpy }
  } as unknown as import('cesium').Scene
  return { scene, addSpy, removeSpy, containsSpy, ops: () => [...timeline] }
}
```

（`remove` 从裸函数 `() => false` 变 spy + 记时间线——旧用例零依赖 remove，安全。）

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: 既有全绿（mock 升级零破坏验证）

- [ ] **Step 2: 写 insert 全语义用例（新文件，先失败）**

新建 `packages/cesium-core/src/cesium/AtmosphereStage.insert.test.ts`：

```ts
// insertStageBeforeLensFlare 全语义测试（v2.1 spec §5.1/§8.1）。
// 独立文件原因：本文件 vi.mock createLensFlareStage（rebuild 参数断言需可区分实例），
// 而主测试文件断言真实 composite 结构（inputPreviousStageTexture 等）——mock 化会破坏。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Cartesian3, Ellipsoid, type PostProcessStage } from 'cesium'

// vi.hoisted：vi.mock 工厂被提升到文件顶部，工厂内引用的变量须用 vi.hoisted 创建。
// composite mock 带 name:'lensflare'（时间线断言用）与 enabled（继承断言用）。
const lensFlareMock = vi.hoisted(() =>
  vi.fn(() => ({
    lensflareComposite: { name: 'lensflare', enabled: true }
  }))
)

vi.mock('./lensFlare/createLensFlareStage', () => ({
  createLensFlareStage: lensFlareMock
}))

import { createAtmosphereStage } from './AtmosphereStage'

// —— mock 基建（对齐主测试文件 mockSceneWithAddSpy，另有状态 remove + contains + 时间线）——
function makeScene() {
  const timeline: string[] = []
  const inCollection = new Set<unknown>()
  const addSpy = vi.fn((s: { name?: string }) => {
    timeline.push(`add:${String(s?.name ?? 'unnamed')}`)
    inCollection.add(s)
  })
  const removeSpy = vi.fn((s: { name?: string }) => {
    timeline.push(`remove:${String(s?.name ?? 'unnamed')}`)
    if (inCollection.has(s)) {
      inCollection.delete(s)
      return true
    }
    return false
  })
  const containsSpy = vi.fn((s: unknown) => inCollection.has(s))
  const scene = {
    context: {
      halfFloatingPointTexture: true,
      colorBufferHalfFloat: true,
      floatingPointTexture: false,
      colorBufferFloat: false
    },
    globe: { depthTestAgainstTerrain: false, ellipsoid: Ellipsoid.WGS84 },
    camera: { positionWC: new Cartesian3(6378137, 0, 0) },
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    preRender: { addEventListener: () => () => {} },
    postRender: { addEventListener: () => () => {} },
    postProcessStages: { add: addSpy, remove: removeSpy, contains: containsSpy }
  } as unknown as import('cesium').Scene
  return { scene, timeline: () => [...timeline], addSpy, removeSpy, containsSpy }
}

const stubLuts = {
  transmittance: {} as never,
  scattering: {} as never,
  irradiance: {} as never
}

/** 造一个假插入物 stage（带 isDestroyed/destroy/name）。 */
function makeInsertStage(name = 'clouds_overlay') {
  let destroyed = false
  const s = {
    name,
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true
    })
  }
  return s as unknown as PostProcessStage
}

describe('insertStageBeforeLensFlare（v2.1 全语义）', () => {
  beforeEach(() => {
    lensFlareMock.mockClear()
  })

  it('§8.1.1 顺序：[remove lf, remove tm, add clouds, add lf, add tm]', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    handle.insertStageBeforeLensFlare(stage)
    const t = m.timeline().slice(-5)
    expect(t[0]).toBe('remove:lensflare') // mock composite 带 name:'lensflare'
    expect(t[1]).toBe('remove:tonemap')
    expect(t[2]).toBe('add:clouds_overlay')
    expect(t[3]).toBe('add:lensflare')
    expect(t[4]).toBe('add:tonemap')
    handle.destroy()
  })

  it('§8.1.1b lensFlare=false：只重排 tonemap', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, { lensFlare: false })
    const stage = makeInsertStage()
    handle.insertStageBeforeLensFlare(stage)
    const t = m.timeline().slice(-3)
    expect(t).toEqual(['remove:tonemap', 'add:clouds_overlay', 'add:tonemap'])
    handle.destroy()
  })

  it('§8.1.2 rebuild 后 lensFlareStage 是新引用（≠ 旧）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const oldLf = handle.lensFlareStage
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(handle.lensFlareStage).toBeDefined()
    expect(handle.lensFlareStage).not.toBe(oldLf)
    handle.destroy()
  })

  it('§8.1.3 rebuild 参数一致（resolved 五参 + depthSource）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {
      lensFlareIntensity: 0.002, lensFlareThreshold: 3.5, lensFlareGhost: 0.7,
      lensFlareHalo: 0.9, lensFlarePreBlur: 1.5
    })
    lensFlareMock.mockClear()
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(lensFlareMock).toHaveBeenCalledTimes(1)
    const opts = (lensFlareMock.mock.calls[0] as unknown[])[2] as Record<string, number>
    expect(opts.intensity).toBe(0.002)
    expect(opts.thresholdLevel).toBe(3.5)
    expect(opts.ghostAmount).toBe(0.7)
    expect(opts.haloAmount).toBe(0.9)
    expect(opts.preBlurRadius).toBe(1.5)
    expect((lensFlareMock.mock.calls[0] as unknown[])[3]).toBeUndefined() // 非 temporalEma → depthSource undefined
    handle.destroy()
  })

  it('§8.1.4 tonemapStage rebuild 新实例（getter 反映）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const oldTm = handle.tonemapStage
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(handle.tonemapStage).not.toBe(oldTm)
    handle.destroy()
  })

  it('§8.1.5 同实例幂等：第二次 insert(同 stage) 集合零操作', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    handle.insertStageBeforeLensFlare(stage)
    const lenAfterFirst = m.timeline().length
    handle.insertStageBeforeLensFlare(stage) // 同实例 no-op
    expect(m.timeline().length).toBe(lenAfterFirst)
    handle.destroy()
  })

  it('§8.1.6 contains 前置：已 add 的 stage → 抛错且集合零变更', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    m.addSpy(stage) // 模拟消费者已自行 add
    const lenBefore = m.timeline().length
    expect(() => handle.insertStageBeforeLensFlare(stage)).toThrow()
    expect(m.timeline().length).toBe(lenBefore) // 零变更
    handle.destroy()
  })

  it('§8.1.7 destroyed guard：destroy 后 insert no-op+warn；destroy 幂等', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    handle.destroy()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lenBefore = m.timeline().length
    expect(() => handle.insertStageBeforeLensFlare(makeInsertStage())).not.toThrow()
    expect(m.timeline().length).toBe(lenBefore)
    expect(warnSpy).toHaveBeenCalled()
    expect(() => handle.destroy()).not.toThrow() // 幂等
    warnSpy.mockRestore()
  })

  it('§8.1.8 enabled 继承：旧 lf.enabled=false → rebuild 后仍 false', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    handle.lensFlareStage!.enabled = false // 模拟 M1 运行时关
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(handle.lensFlareStage!.enabled).toBe(false)
    handle.destroy()
  })

  it('§8.1.9 depthTemporal 共存：dt 不动 + rebuild depthSource 指名', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, { depthTemporal: true, temporalEma: true })
    expect(handle.depthTemporalStage).toBeDefined()
    lensFlareMock.mockClear()
    handle.insertStageBeforeLensFlare(makeInsertStage())
    // dt 从未被 remove
    const t = m.timeline()
    expect(t.filter((x) => x === 'remove:czm_depth_temporal')).toHaveLength(0)
    // rebuild lf 的 depthSource 指名 dt
    expect((lensFlareMock.mock.calls[0] as unknown[])[3]).toBe('czm_depth_temporal')
    handle.destroy()
  })

  it('§8.1.10 isDestroyed 防御分支：外部摘旧后再 insert(B) 替换成功不抛', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('clouds_overlay')
    handle.insertStageBeforeLensFlare(a)
    m.removeSpy(a) // 模拟 clouds handle.destroy 摘除（a 已销毁语义由测试 destroy() 模拟——此处仅摘集合）
    ;(a as unknown as { destroy: () => void }).destroy() // 外部 destroy（真实链路 remove 即 destroy）
    const b = makeInsertStage('clouds_overlay_new')
    expect(() => handle.insertStageBeforeLensFlare(b)).not.toThrow() // 走 isDestroyed 跳过分支
    const t = m.timeline().slice(-5)
    expect(t).toContain('add:clouds_overlay_new')
    handle.destroy()
  })

  it('§8.1.10b insert(已销毁 stage) → 抛清晰错误且集合零变更', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    stage.destroy()
    const lenBefore = m.timeline().length
    expect(() => handle.insertStageBeforeLensFlare(stage)).toThrow(/已销毁/)
    expect(m.timeline().length).toBe(lenBefore)
    handle.destroy()
  })

  it('§8.1.11 原子回滚：add(插入物) 抛错 → 链恢复 + insertedStage 不变 + rethrow 原始异常', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('clouds_overlay')
    handle.insertStageBeforeLensFlare(a) // 先插一个（成功）
    // 第二次 insert(b)：mock add(b) 抛错（重名场景模拟）
    const b = makeInsertStage('clouds_overlay_b')
    const origAdd = m.addSpy.getMockImplementation()
    m.addSpy.mockImplementation((s: { name?: string }) => {
      if (s === b) throw new Error('mock add 失败')
      origAdd?.(s)
    })
    expect(() => handle.insertStageBeforeLensFlare(b)).toThrow('mock add 失败') // 原始异常（非回滚异常）
    m.addSpy.mockImplementation(origAdd)
    // 回滚：b 被撤 + lf/tm 重建 re-add（时间线尾部：remove b … add lensflare/tonemap）
    const t = m.timeline()
    expect(t.filter((x) => x === 'remove:clouds_overlay_b').length).toBeGreaterThan(0)
    const tail = t.slice(-2)
    expect(tail).toEqual(['add:lensflare', 'add:tonemap'])
    // insertedStage 记忆不变：同实例 a 再 insert → no-op（零集合操作）
    const lenNow = m.timeline().length
    handle.insertStageBeforeLensFlare(a)
    expect(m.timeline().length).toBe(lenNow)
    handle.destroy()
  })
})
```

- [ ] **Step 3: 运行验证失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.insert.test.ts`
Expected: FAIL（insertStageBeforeLensFlare 不存在——TS 类型错 + 运行时 undefined）

- [ ] **Step 4: 实现 insert + rebuildLensFlare + 全套 guard**

`AtmosphereStage.ts` 改动四处：

**(a) handle 接口加方法**（:336-355 的 AtmosphereStageHandle，`setMode` 声明前插）：

```ts
  /**
   * 把外部 stage 插入 atmosphere 与 lensFlare 之间（云 overlay 线性域合成用，v2.1 spec §5.1）。
   * 语义：入口拒已销毁/已 add 的 stage（抛错）；同实例未销毁幂等 no-op；不同实例替换；
   * 尽力回滚（失败撤插入物 + 重建 lf/tm，回滚自身失败保原始异常）；destroy 后 no-op+warn；
   * lensFlare 不存在时只重排 tonemap；rebuild 的 lf 继承旧 enabled。
   * 摘除由 stage 拥有者自行 removeAndDestroy——摘除后链自动闭合（lf 紧贴 atmosphere）。
   * 限制：setMode（dead code）在插入后行为未定义（其已有顺序 TODO）。
   */
  insertStageBeforeLensFlare(stage: PostProcessStage | PostProcessStageComposite): void
```

（import 处补 `type PostProcessStageComposite`——检查现有 import 是否已含。）

**(b) removeAndDestroy 加 isDestroyed 防御**（:665-669）：

```ts
  /**
   * 从集合移除并销毁；remove 成功时集合内部已 destroy，失败（不在集合中）则自行销毁。
   * 接受 PostProcessStage 或 PostProcessStageComposite（Cesium remove/add 重载都收两者）。
   * v2 防御（spec §5.2）：已销毁的 stage 直接跳过——destroyObject 把 destroy 替换成
   * throwOnDestroyed，对已销毁 stage 再 .destroy() 会抛「This object was destroyed」断链。
   */
  function removeAndDestroy(s: PostProcessStage | PostProcessStageComposite): void {
    if (s.isDestroyed()) return
    if (!scene.postProcessStages.remove(s)) {
      s.destroy()
    }
  }
```

**(c) 闭包内新增 destroyed/insertedStage/rebuildLensFlare/insert**（放 `let tonemapStage = buildTonemapStage()` 与链 add（:610-614）之后、preRender listener 之前）：

```ts
  // ── v2.1 insertStageBeforeLensFlare（spec §5）：把外部 stage（云 overlay）插入
  //    atmosphere 与 lensFlare 之间。重挂式：摘 lf/tm → 插入 → rebuild lf → re-add tm。──
  let destroyed = false
  let insertedStage: PostProcessStage | PostProcessStageComposite | undefined

  // lf rebuild：参数读闭包 resolved 当前值（与 setMode 重建语义一致，非创建时快照）；
  // depthSource 是创建时常量（temporalEmaEnabled）。lfHandle 无 destroy（三方核实：
  // plain handle 纯引用），composite remove 即级联销毁子 stage，无泄漏。
  function rebuildLensFlare(): PostProcessStageComposite | undefined {
    if (!resolved.lensFlare) return undefined
    const lfHandle = createLensFlareStage(
      scene,
      state,
      {
        intensity: resolved.lensFlareIntensity,
        thresholdLevel: resolved.lensFlareThreshold,
        ghostAmount: resolved.lensFlareGhost,
        haloAmount: resolved.lensFlareHalo,
        ...(resolved.lensFlarePreBlur != null
          ? { preBlurRadius: resolved.lensFlarePreBlur }
          : {})
      },
      temporalEmaEnabled ? 'czm_depth_temporal' : undefined
    )
    return lfHandle.lensflareComposite
  }

  function insertStageBeforeLensFlare(
    stage: PostProcessStage | PostProcessStageComposite
  ): void {
    if (destroyed) {
      console.warn('[atmosphere] insertStageBeforeLensFlare 于 destroy 后调用，no-op')
      return
    }
    // 入口拒绝（v2.1 C1）：已销毁 stage 的 add 不抛错，但下一帧 collection.update 调
    // stage.update 直接崩渲染（destroyObject 遮蔽 prototype 方法）。
    if (stage.isDestroyed()) {
      throw new DeveloperError('insertStageBeforeLensFlare: stage 已销毁，不可插入')
    }
    // contains 前置（v2）：已在集合中——后续 add 名字冲突抛错会留「lf/tm 已摘、链残缺」半途状态。
    if (scene.postProcessStages.contains(stage)) {
      throw new DeveloperError(
        'insertStageBeforeLensFlare: stage 已在集合中，须传入未 add 的 stage'
      )
    }
    // 同实例幂等（v2.1 C3 收紧：仅未销毁时 no-op——已销毁的同实例走替换，防静默无云）
    if (insertedStage === stage && !stage.isDestroyed()) return

    const prevLfEnabled = lensFlareStage?.enabled
    try {
      // 替换场景：摘旧插入物（isDestroyed 防御在 removeAndDestroy 内）
      if (insertedStage != null) removeAndDestroy(insertedStage)
      // 摘序 = spec §8.1.1：先 lf 后 tm（回滚/测试时间线断言与此对齐）
      if (lensFlareStage) removeAndDestroy(lensFlareStage)
      removeAndDestroy(tonemapStage)
      scene.postProcessStages.add(stage)
      const newLf = rebuildLensFlare()
      if (newLf != null) {
        if (prevLfEnabled === false) newLf.enabled = false // enabled 继承（spec §5.2）
        lensFlareStage = newLf
        scene.postProcessStages.add(newLf)
      }
      tonemapStage = buildTonemapStage()
      scene.postProcessStages.add(tonemapStage)
      insertedStage = stage // 成功才记忆（回滚不动它）
    } catch (e) {
      // 尽力回滚（v2.1 C2：撤插入物 + 重建 lf/tm；回滚自身独立 try/catch 保原始异常）
      try {
        removeAndDestroy(stage)
        const rbLf = rebuildLensFlare()
        if (rbLf != null) {
          if (prevLfEnabled === false) rbLf.enabled = false
          lensFlareStage = rbLf
          scene.postProcessStages.add(rbLf)
        }
        tonemapStage = buildTonemapStage()
        scene.postProcessStages.add(tonemapStage)
      } catch (rollbackErr) {
        console.error('[atmosphere] insertStageBeforeLensFlare 回滚失败', rollbackErr)
      }
      throw e // 原始异常
    }
  }
```

（import 补 `DeveloperError`——检查现有 cesium import 列表加 `DeveloperError`。）

**(d) handle 对象**（:671-738）：
- `setMode` 开头加 guard：`if (destroyed) { console.warn('[atmosphere] setMode 于 destroy 后调用，no-op'); return }`
- `destroy()` 开头加：`if (destroyed) return; destroyed = true`
- 对象字面量加方法：`insertStageBeforeLensFlare,`

- [ ] **Step 5: 运行 insert 用例 + core 全量回归**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: 全绿（既有 281 + 新 12 条；注意既有用例不断 remove——mock 升级安全）

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts packages/cesium-core/src/cesium/AtmosphereStage.insert.test.ts
git commit -m "feat(core): insertStageBeforeLensFlare 编排 API——重挂式插云+lf rebuild+幂等/contains/原子回滚/destroyed guard/enabled 继承/isDestroyed 防御（spec §5）"
```

---

### Task 3: overlay 所有权迁移 per-impl → per-handle（clouds 包）

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（impl 接口 :254-263、impl 组装 :646-669、overlay 构造 :464-483 移顶层、顶层 :682-754、setQuality/destroy）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`（mock stage 加 isDestroyed :29-37、mock scene remove 有状态化 :157-158、旧用例改写 :203-214、destroy 用例修订 :272-288、新增跨 impl/失败分支用例）

**Interfaces:**
- Consumes: T1 的 OVERLAY_SHADER/HDR datatype；顶层 `impl` 变量（闭包）
- Produces: `CloudsStageHandle.overlayStage` 返回顶层 stage（跨 setQuality 引用恒定、创建后未 add）；`CloudsStageImpl` 含 `resolvePass`。T4 demo 消费。

- [ ] **Step 1: 升级 mocks + 改写旧用例（先失败）**

(a) `createCloudsStage.test.ts` :29-37 的 PostProcessStage mock 加 `isDestroyed`：

```ts
    PostProcessStage: function (this: any, opts: any) {
      this.name = opts.name
      this.fragmentShader = opts.fragmentShader
      this.uniforms = opts.uniforms
      this.sampleMode = opts.sampleMode
      this.pixelFormat = opts.pixelFormat
      this.pixelDatatype = opts.pixelDatatype
      this.isDestroyed = () => false // v2.1 spec §8.0.4：clouds 侧摘除带 isDestroyed 防御
      this.destroy = vi.fn()
    },
```

(b) `createMockScene`（:116-168）改有状态集合——工厂顶部（`const listeners` 同级）加 `const addedStages = new Set<unknown>()`，postProcessStages（:142-147）改为：

```ts
    postProcessStages: {
      // v2.1 spec §8.0.4：有状态——add 过的 stage remove 才返 true（已 add/未 add 两分支用例）
      add: vi.fn((s: unknown) => {
        addedStages.add(s)
      }),
      remove: vi.fn((s: unknown) => addedStages.delete(s)),
      contains: vi.fn((s: unknown) => addedStages.has(s)),
      length: 0,
      get: vi.fn()
    },
```

（旧用例只断「remove 被调用」不断返回值——恒 true → 有状态的迁移零影响。）

(c) 旧用例 :203-214 改写（新语义）：

```ts
  it('clouds:true → 创建 CloudsPass + overlay stage（v2 §6.3：不自动 add，add 时机移交消费者）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(handle).toBeDefined()
    expect(createCloudsPass).toHaveBeenCalledTimes(1)
    expect(scene.postProcessStages.add).not.toHaveBeenCalled() // 零 add
    handle!.destroy()
  })
```

(d) destroy 用例 :272-288 修订——语义仍是 handle.destroy 摘 overlay，但补充未 add 分支新用例：

```ts
  it('v2 §8.2.4 handle.destroy：已 add 分支走 remove；未 add 分支 destroy 直调', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    // 分支 A：模拟消费者已 insert（手动 add 进有状态集合）→ destroy 走 remove 成功
    scene.postProcessStages.add(overlay)
    handle!.destroy()
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(overlay)
    expect(overlay.destroy).not.toHaveBeenCalled() // remove 成功 → 不走直调
    // 分支 B：未 add 的句柄 → remove 返 false → overlay.destroy 直调
    const handle2 = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay2 = handle2!.overlayStage
    handle2!.destroy()
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(overlay2)
    expect(overlay2.destroy).toHaveBeenCalled()
  })
```

（分支 B 断言 remove 也被调用（返 false）+ destroy 直调——对应实现 `if (!remove(s)) { if (!s.isDestroyed()) s.destroy() }`。）

(e) 新增跨 impl 存活 + 失败分支用例：

```ts
  it('v2 §8.2.3 overlay 跨 impl 存活：setQuality 换档后引用不变 + u_cloudsBuffer 切新 bridge', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    const bridgeBefore = (overlay.uniforms.u_cloudsBuffer as () => unknown)()
    handle!.setQuality('low')
    expect(handle!.overlayStage).toBe(overlay) // 引用恒定
    const newCloudsPass = (createCloudsPass as any).mock.calls.at(-1) // 新 impl 的 pass
    expect(handle!.cloudsPass).not.toBe(undefined)
    // u_cloudsBuffer 闭包切到新 impl 的 bridge（非 temporal → getColorBridge）
    const bridgeAfter = (overlay.uniforms.u_cloudsBuffer as () => unknown)()
    expect(bridgeAfter).not.toBe(bridgeBefore) // 新 bridge 对象
    handle!.destroy()
  })

  it('v2 §8.2.6 setQuality 重建失败：顶层 overlay 被摘除（BLOCKER 用例）+ 句柄作废', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    scene.postProcessStages.add(overlay) // 模拟 demo 已 insert
    // mock createCloudsPass：下一次调用（换档 buildImpl）抛错（mockImplementationOnce 一次即耗，
    // 无需恢复基础实现）
    ;(createCloudsPass as any).mockImplementationOnce(() => {
      throw new Error('mock 换档重建失败')
    })
    expect(() => handle!.setQuality('low')).toThrow('mock 换档重建失败')
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(overlay) // overlay 已摘
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => handle!.setQuality('high')).not.toThrow() // 句柄作废 no-op+warn
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('v2 §8.2.4 impl.destroy 不摘 overlay（collection.remove 不触 overlay）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    handle!.setQuality('medium') // 换档触发 impl.destroy
    expect(scene.postProcessStages.remove).not.toHaveBeenCalledWith(overlay)
    handle!.destroy()
  })
```

（`mockImplementationOnce` 时序注意：`setQuality('low')` 内 buildImpl 会完整跑——createCloudsPass 是 impl 内**第一个**被 mock 的构造调用，`mockImplementationOnce` 精确拦截。若实际顺序不符（buildImpl 先调其它 mock），改用对 `createCloudsResolvePass` 或 `createShadowPass` 抛错——以「抛错点在 impl 构造期」为准则。）

- [ ] **Step 2: 运行验证失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts`
Expected: FAIL（当前 impl 内自动 add、destroy 在 impl 内摘 overlay、无顶层 overlay）

- [ ] **Step 3: 实现所有权迁移**

`createCloudsStage.ts` 五处改动：

**(a) CloudsStageImpl 接口**（:254-263）：

```ts
/** 模块内 impl（spec §6.1 v2）：一次装配的全部资源 + 每帧逻辑 + 完整销毁。
 *  overlay 已移出 impl（per-handle 资源，spec §6.2）——impl 销毁清单不含 overlay。 */
interface CloudsStageImpl {
  readonly cloudsPass: CloudsPass
  /** M4 resolve pass（temporal 时；overlay uniform 源切换用，spec §6.1 v2 新增）。 */
  readonly resolvePass: CloudsResolvePass | undefined
  readonly cascades: CascadedShadowMaps
  readonly shadowPass: ShadowPass | undefined
  readonly shadowState: CloudsShadowFrameState
  readonly params: CloudsParameters
  onPreRender(time: JulianDate): void
  destroy(): void
}
```

**(b) buildImpl 内 overlay 构造与 add 整段删除**（:464-483），impl 组装（:646-669）改为：

```ts
  return {
    cloudsPass,
    resolvePass,
    shadowPass,
    shadowState,
    cascades,
    params,
    onPreRender,
    destroy(): void {
      // 顺序：先 CloudsPass（消费端，撤 bsm 引用）→ 云 resolve（march 后第二个 VOXELS 实例）→
      // ShadowPass（释放 bsmTexture），最后生成端 turbulence dummy。
      // overlay 不在此清单（v2 spec §6.1：per-handle 资源，由顶层 handle.destroy/setQuality 失败分支摘）
      cloudsPass.destroy()
      resolvePass?.destroy()
      shadowPass?.destroy()
      shadowTurbulenceDummy?.destroy()
    }
  }
```

**(c) 顶层 createCloudsStage**（:682-754）：`let impl = ...` 之后建顶层 overlay（构造参数同 T1，uniforms 闭包读顶层 `impl`）；删除 buildImpl 内 add 依赖；handle 调整：

```ts
  const initialQuality = options.quality ?? 'high'
  let impl = buildCloudsStageImpl(scene, luts, weather, options, applyQualityPreset(initialQuality, options))
  let currentQuality: CloudsQualityPreset = initialQuality
  let destroyed = false

  // ── 顶层 overlay（spec §6.2 v2）：per-handle 资源，跨 impl 存活（换档只切 uniform 源）。
  //    不自动 add——add 时机移交消费者（demo 走 insertStageBeforeLensFlare；spec §6.3）。──
  const overlayStage = new PostProcessStage({
    name: 'clouds_overlay',
    fragmentShader: OVERLAY_SHADER,
    uniforms: {
      // 闭包读顶层 impl（换档后自动指向新 bridge；setQuality 失败分支摘本 stage 前不会读旧 bridge）
      u_cloudsBuffer: () =>
        impl.resolvePass != null
          ? impl.resolvePass.getResolvedBridge()
          : impl.cloudsPass.getColorBridge(),
      u_cloudsExposure: options.cloudsOverlayExposure ?? CLOUDS_OVERLAY_EXPOSURE_DEFAULT
    },
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: resolveCloudsHdrDatatype(scene)
  })

  // 摘 overlay 的统一出口（handle.destroy 与 setQuality 失败分支共用；remove 失败则自行 destroy）
  const removeOverlay = (): void => {
    if (!scene.postProcessStages.remove(overlayStage)) {
      if (!overlayStage.isDestroyed()) overlayStage.destroy()
    }
  }

  const removePreRender = scene.preRender.addEventListener(
    (_scene: Scene, time: JulianDate) => {
      if (!destroyed) impl.onPreRender(time)
    }
  )

  const handle: CloudsStageHandle = {
    get cloudsPass() {
      return impl.cloudsPass
    },
    // 顶层 stage（v2 §6.2：跨 impl 引用恒定；创建后未 add，消费者编排）
    get overlayStage() {
      return overlayStage
    },
    get shadowPass() {
      return impl.shadowPass
    },
    get shadowState() {
      return impl.shadowState
    },
    get cascades() {
      return impl.cascades
    },
    setQuality(next: CloudsQualityPreset): void {
      if (destroyed) {
        console.warn('[clouds] setQuality 于 destroy 后调用，no-op')
        return
      }
      if (next === currentQuality) return
      impl.destroy()
      try {
        impl = buildCloudsStageImpl(scene, luts, weather, options, applyQualityPreset(next, options))
        currentQuality = next
      } catch (e) {
        // 原子性（spec §7 v3）+ v2 BLOCKER 修订：顶层 overlay 必须同步摘除——否则残留链上
        // 每帧读已销毁 impl 的悬空 bridge（GL 纹理名已删），静默黑帧/脏画面。
        destroyed = true
        removeOverlay()
        throw e
      }
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      removePreRender()
      impl.destroy()
      removeOverlay()
    }
  }
  return handle
```

**(d)** `CloudsStageHandle.overlayStage` 的 JSDoc（:181-182）改：「cloudsBuffer overlay PostProcessStage（per-handle，跨 setQuality 引用恒定；创建后**未 add**——demo 走 `insertStageBeforeLensFlare` 编排，独立消费者自行 `scene.postProcessStages.add`，见 README）」。

**(e)** buildImpl 的 JSDoc `@param scene` 行（:274「overlay add 到 postProcessStages」）改为「（overlay 已移出 impl，顶层管理）」。

- [ ] **Step 4: 运行 clouds 全量**

Run: `pnpm --filter @cesium-geospatial/clouds test`
Expected: 全绿（含既有「换档×temporal 完整销毁清单」用例——若其断言 impl 销毁清单含 overlay，按 spec §8.2.7 修订该断言：overlay 移出清单、由顶层摘）

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "feat(clouds): overlay 所有权迁移 per-handle——跨 impl 存活+不自动 add+setQuality 失败摘 overlay（BLOCKER）+impl 销毁清单修订（spec §6）"
```

---

### Task 4: demo 编排接线 + 文档

**Files:**
- Modify: `apps/demo/src/main.ts`（atmosphereHandle 作用域 :281、clouds 块 insert :421-429、:412 注释 10→6）
- Modify: `README.md`（:92 cloudsExposure 行 + 新增「体积云 stage API」段）

**Interfaces:**
- Consumes: T2 `handle.insertStageBeforeLensFlare(stage)`；T3 `cloudsHandle.overlayStage`（未 add）
- Produces: 完整修复的 demo（视觉验收 T5 的载体）

- [ ] **Step 1: atmosphereHandle 作用域提升**

`main.ts` :280-281 现状（else 块内 `const atmosphereHandle = createAtmosphereStage(...)`）：

块外（与 `skipAtmosphere` 声明同级）加：

```ts
let atmosphereHandle: AtmosphereStageHandle | undefined
```

else 块内改赋值 `atmosphereHandle = createAtmosphereStage(scene, luts, {...})`（原 const 声明去掉）。import 补 `type AtmosphereStageHandle`（:17 的 core import 列表加）。

- [ ] **Step 2: clouds 块 insert 编排 + 失败处置**

clouds 块内 `if (cloudsHandle != null) {`（:421 console.info 之前）插入：

```ts
        if (cloudsHandle != null) {
          // v2 spec §7：云 overlay 编排——插入 atmosphere 与 lensFlare 之间（halo 画在云上）。
          // insert 失败处置（spec §6.3）：console.error（区别 weather 失败的 warn）+ 回收
          // cloudsHandle（march primitive 不白跑）+ 清 shadow bridge（防读已销毁 cloudsPass）。
          if (atmosphereHandle != null) {
            try {
              atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)
            } catch (e) {
              console.error('[clouds] 后处理链插入失败，云已回收', e)
              cloudsHandle.destroy()
              cloudsShadowBridge = undefined
            }
          } else {
            scene.postProcessStages.add(cloudsHandle.overlayStage) // 独立消费者 fallback（demo 不可达，防御）
          }
          console.info(...)
```

注意：`cloudsShadowBridge` 赋值（:416-418）在 insert 之前——失败处置置 undefined 覆盖它 ✓。若 `cloudsHandle.destroy()` 后代码继续用 `cloudsHandle`（window 暴露 :419-420 在 insert 前已赋值，保持）——把 insert 块放在 window 赋值与 bridge 赋值**之后**、console.info 之前，失败时覆盖 bridge。

`:412` 注释「云 overlay 曝光（默认 10 对齐 three 版 storybook 标定；偏灰调大/过曝调小）」改「云 overlay 曝光（默认 6 线性域缩放，V2 验收后定稿；偏灰调大/过曝调小）」。

- [ ] **Step 3: README**

(a) :92 行 `| cloudsExposure | 10 | 云层曝光（偏灰调大、过曝调小） |` 改：

```markdown
| `cloudsExposure` | 6 | 云层曝光（线性域缩放，链尾统一 tonemap；偏灰调大、过曝调小） |
```

(b) 「### 体积云」段（:87 起）末尾加子段：

```markdown
#### 体积云 stage API（库消费者必读）

`createCloudsStage` 返回的 `overlayStage` **不会自动 add** 到 `scene.postProcessStages`——
add 时机由消费者编排，否则云不可见：

- **配合 atmosphere（推荐，demo 同款）**：把 overlay 插到 atmosphere 与 lensFlare 之间，
  云在线性 HDR 域合成、halo 光晕叠加在云上：

  ```ts
  const cloudsHandle = createCloudsStage(scene, luts, weather, { clouds: true })
  atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)
  ```

- **独立使用（无 atmosphere stage）**：自行 add 到链尾（云在 display 域直接上屏，
  无 halo 层级保证）：`scene.postProcessStages.add(cloudsHandle.overlayStage)`

`insertStageBeforeLensFlare` 语义：同实例幂等、传已 add/已销毁的 stage 抛错、失败尽力回滚；
云销毁调 `cloudsHandle.destroy()` 即可（链自动闭合）。
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit && pnpm test`
Expected: 全绿（demo 无独立测试，tsc 在 packages 层验证类型；demo 的 tsc 由 vite build 隐式覆盖——可跑 `pnpm --filter demo exec tsc --noEmit` 若该包有 tsconfig，无则跳过）

- [ ] **Step 5: Commit**

```bash
git add apps/demo/src/main.ts README.md
git commit -m "feat(demo): 云 overlay 链编排接线——insertStageBeforeLensFlare 插入+失败回收+README API 段与曝光值修正（spec §7/§11）"
```

---

### Task 5: 视觉验收 + 曝光定稿 + results 文档

**Files:**
- Create: `docs/superpowers/plans/2026-08-29-clouds-linear-overlay-results.md`
- Modify（若 V2 改默认值）: `packages/cesium-clouds/src/createCloudsStage.ts`（CLOUDS_OVERLAY_EXPOSURE_DEFAULT）+ `README.md`

**Interfaces:**
- Consumes: T4 完成的 demo（worktree 内 dev server：`pnpm dev -- --port 5199` 起新端口，避让主 checkout 的 5173）
- Produces: 验收结论 + 定稿曝光值。

- [ ] **Step 1: 启动 worktree dev server**

```bash
pnpm dev -- --port 5199
```

（后台起；agent-browser 用 `http://localhost:5199/?...`。若 agent-browser 会话已有实例，先 `agent-browser close`。）

- [ ] **Step 2: V1 主判据——halo 完整叠在云上**

URL：`http://localhost:5199/?mode=atmosphere&clouds=1&time=2026-08-29T09:30:00Z&camera=120,30,800,268,20&lfHalo=0.5&lfIntensity=0.005`

agent-browser open → wait networkidle → sleep 8 → screenshot `v1-fixed.png`。与修复前基线（`repro-2.png`，主 checkout 5173 可复拍）对比：4~8 点弧段（云区）halo 不再被切断。**AI 读图仅参考——层级结论以像素 diff（同视角 clouds=0 vs clouds=1 的 halo 弧段差异）与用户目验为准**（memory 教训：AI 读图数字/低对比结论必须交叉验证）。

- [ ] **Step 3: V2 云视觉重标 + lf 同屏目测**

同视角遍历 `&cloudsExposure=3/6/10/15`，截图四张。**请用户目验选定**（E 与 lf flare 阈值强耦合——spec §9.2：E 调高云会批量过 lf 阈值 3.0 使 flare 骤增，挑值必须同屏看 lf）。选定后回改 `CLOUDS_OVERLAY_EXPOSURE_DEFAULT` + README + demo 注释三处同值，commit。

- [ ] **Step 4: V3-V6 回归面**

- V3：`clouds=0` 跑既有 atmosphere 验收 URL 集（无云画面与 main 一致）
- V4：`&lensflare=0&clouds=1`——云正常合成（atmo → clouds → tm 链）
- V5：同视角键盘按 `3`（high）→ 截图 → 按 `1`（low）→ 截图：halo 层级不破（overlay 位置恒定）
- V6：`&hdr=0&clouds=1`——画面可看无崩溃（atmosphere RT 8-bit 降级；真 8-bit 全链路本机不可复现，如实记录）

- [ ] **Step 5: 全套件终跑 + results 文档**

```bash
pnpm test
```

写 `docs/superpowers/plans/2026-08-29-clouds-linear-overlay-results.md`：V1-V6 每条判据结论 + 截图文件引用 + 定稿曝光值 + 遗留（§9 已知限制逐条确认）+ 帧率简测（insert 长帧现象记录）。**所有数字须有截图/命令输出来源**（T7 两次数据事故教训）。

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-29-clouds-linear-overlay-results.md packages/cesium-clouds/src/createCloudsStage.ts README.md
git commit -m "docs(clouds): overlay 线性域化验收 results——V1-V6 结论+曝光定稿（spec §8.3）"
```
