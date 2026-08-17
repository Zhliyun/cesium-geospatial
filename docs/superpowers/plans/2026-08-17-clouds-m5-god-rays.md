# 体积云 M5 云 god rays 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接通 clouds.frag 的 SHADOW_LENGTH 链路（`marchShadowLength` 沿视线累加 BSM 光深 → `applyAerialPerspective` 以 `shadow_length` 调 `GetSkyRadianceToPoint` 的 higher-order 分支），云前表面的大气散射被云影调制 → 朝太阳方向的云间体积光柱。

**Architecture:** 全部逻辑在 clouds.frag 原文（M2 移植时未 define 的编译分支）——M5 只做三件事：① `CloudsMaterial` 加 `lightShafts` option（define `SHADOW_LENGTH`）；② 参数三件套（`maxShadowLengthIterationCount/minShadowLengthStepSize/maxShadowLengthRayDistance`，three 默认 500/50/2e5）进 `cloudsDefaultParameters` + `CloudsPass` uniformMap；③ MRT 扩到 3 attachment（`outputShadowLength` loc2 out 写入，无消费者也必须 attach——M2 坑：attachment 数必须 = out 数）。overlay/大气钩子零改动（spec r1：god rays 在云 shader 内完成，非喂 atmosphere 钩子）。

**Tech Stack:** TypeScript + Cesium（Texture MRT）+ Vitest + glslangValidator。

**Spec:** `docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md` §6 M5。验收：朝太阳方向云间体积光柱；无同心波纹（BSM 是 sun-POV 密度场，避开历史 screen-space god rays 的 Q 投影不稳定）；无过暗（higher-order LUT 已 define，M1 成果）。

**前置核实（已完成 2026-08-17）**：three-geospatial storybook `clouds-clouds--basic`（lightShafts 默认 on）实跑——太阳方向穿云隙的放射状光芒**存在且有效**（强度 subtle）。「作者称 WebGL 未实现」矛盾解决：有实现。

## Global Constraints

- **不碰 GLSL 资产层**；组装层手术/define。
- three-geospatial 逐字对齐（参数默认值 500/50/2e5 来自 `qualityPresets.ts defaults.clouds`）。
- 零回归：`lightShafts=false`（demo `?cloudsLightShafts=0`）= M4 后行为（无 SHADOW_LENGTH 编译分支、MRT 2 attachment）。诊断基线。
- 全中文注释/commit；TDD；每任务一 commit。
- `pnpm --filter @cesium-geospatial/clouds test` 全绿 + `tsc --noEmit` 0。
- temporal（默认关）下 `cloudsResolve` 的 SHADOW_LENGTH 分支不做（M4 回退语境，留收敛修复迭代一并）。

## 已核实的技术事实（implementer 免查）

- clouds.frag SHADOW_LENGTH 分支全部原文就绪：uniform 三件套声明（L81-85）、`outputShadowLength` loc2 out（L97-99）、`marchShadowLength`（L620-650，消费 M3 的 `sampleShadowOpticalDepth`/BSM）、`getShadowRayNearFar`（L771-790，消费 `shadowTopHeight`/`cameraHeight` uniform——均已绑定）、main 的 `shadowRayNearFar` 计算/scene clamp/frontDepth mix（L840-929）、`applyAerialPerspective`（L701，`GetSkyRadianceToPoint(camera, frontPos, shadowLength, ...)` → bruneton runtime `HAS_HIGHER_ORDER_SCATTERING_TEXTURE` 分支——M1 已 define）。
- `GetSkyRadianceToPoint` 3 参（shadowLength>0）版本在 core `glsl/bruneton/runtime.glsl:253`，higher-order 只遮 single 分支已验证（M1 C9）。
- M2 坑（CloudsPass.ts 注释）：**FBO drawBuffers 数必须 = shader out 数**——SHADOW_LENGTH define 后 out=3 → 必须 3 attachment，反之不 define 时 2 attachment（`lightShafts=false` 分支维持 2）。
- `out float` 写 RGBA attachment 合法（写 R 通道）；att2 无消费者（three 喂 atmosphereShadowLength 的路径 spec 明确不做）。

---

### Task 1: CloudsMaterial lightShafts option + 编译测试

**Files:**
- Modify: `packages/cesium-clouds/src/CloudsMaterial.ts`
- Test: `packages/cesium-clouds/src/cloudsMain.compile.test.ts`

**Interfaces:**
- Produces: `CloudsMainOptions.lightShafts?: boolean`（默认 **true**）；`buildCloudsMainFragmentShader` 输出含/不含 `#define SHADOW_LENGTH`。

- [ ] **Step 1: 写失败测试（cloudsMain.compile.test.ts 追加 describe）**

```ts
describe('M5 T1 SHADOW_LENGTH（lightShafts）编译分支', () => {
  it('默认开：#define SHADOW_LENGTH + loc2 out + marchShadowLength + 三 uniform 声明', () => {
    const src = buildCloudsMainFragmentShader({})
    expect(src).toContain('#define SHADOW_LENGTH')
    expect(src).toContain('layout(location = 2) out float outputShadowLength;')
    expect(src).toContain('float marchShadowLength(')
    expect(src).toContain('uniform int maxShadowLengthIterationCount;')
    expect(src).toContain('uniform float minShadowLengthStepSize;')
    expect(src).toContain('uniform float maxShadowLengthRayDistance;')
    // applyAerialPerspective 消费 shadowLength（GetSkyRadianceToPoint 3 参）
    expect(src).toContain('applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);')
  })

  it('lightShafts=false：无 SHADOW_LENGTH 分支（M4 后行为零回归）', () => {
    const src = buildCloudsMainFragmentShader({ lightShafts: false })
    expect(src).not.toContain('#define SHADOW_LENGTH')
    expect(src).not.toContain('outputShadowLength')
  })

  it('glslang：lightShafts 开真编译（out 3 + marchShadowLength + GetSkyRadianceToPoint shadow_length 分支）', () => {
    const src = buildStandaloneCloudsShaderForValidation({ lightShafts: true })
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(`glslang 编译失败:\n${output}\n` + src.split('\n').slice(0, 60).map((l, i) => `${i + 1}: ${l}`).join('\n'))
    }
    expect(ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts
```

- [ ] **Step 3: 实现**——`CloudsMainOptions` 加字段（注释：默认 true 对齐 three `defaults.lightShafts`；false = 诊断基线）；`DEFAULTS` 加 `lightShafts: true`；`buildM2Defines` 加 `o.lightShafts ? '#define SHADOW_LENGTH' : ''`。文件头 M4 注释段的「M5 god rays：不 define SHADOW_LENGTH」更新为已接通描述。

- [ ] **Step 4: 跑测试确认通过 + Commit**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts
git add -A packages/cesium-clouds/src/ && git commit -m "feat(clouds): M5 T1 CloudsMaterial lightShafts option——SHADOW_LENGTH 编译分支接通（marchShadowLength/applyAerialPerspective/loc2 out）"
```

---

### Task 2: 参数三件套 + CloudsPass MRT 3 attachment

**Files:**
- Modify: `packages/cesium-clouds/src/cloudsDefaultParameters.ts`、`packages/cesium-clouds/src/CloudsPass.ts`
- Test: `packages/cesium-clouds/src/cloudsDefaultParameters` 相关断言（`CloudsPass.test.ts` 扩展）

**Interfaces:**
- `CloudsParameters` 增加（主 raymarch 段后）：

```ts
  // ── 云 god rays（M5，SHADOW_LENGTH——marchShadowLength 沿视线累加 BSM 光深）──
  /** shadowLength march 最大步数（three defaults.clouds 逐字：500）。 */
  maxShadowLengthIterationCount: number
  /** shadowLength march 最小步长（米，three：50）。 */
  minShadowLengthStepSize: number
  /** shadowLength march 最大距离（米，three：2e5 = 主 march maxRayDistance 同域）。 */
  maxShadowLengthRayDistance: number
```

  默认值 `500 / 50 / 2e5`。
- `CloudsPassOptions` 无新字段（`lightShafts` 经 `CloudsMainOptions` 透传——`createCloudsPass` 的 options 已 extends）。
- `CloudsPass` 行为变化：`temporalUpscale`（现在恒 false）与 `lightShafts` 共同决定 MRT attachment 数——**2（color+depthVel）或 3（+shadowLen）**；`mrtTextures` 数组按 `options.lightShafts !== false` 追加第三张。句柄增加 `readonly shadowLengthTexture: Texture`（lightShafts 关时为 undefined 类型上不可表达——用 `Texture | undefined` 或仅在开时存在；**定案：`readonly shadowLengthTexture: Texture | undefined`**）。
- uniformMap 增加：`maxShadowLengthIterationCount/minShadowLengthStepSize/maxShadowLengthRayDistance: () => params.…`（SHADOW_LENGTH define 时 shader 才声明——不 define 时绑了是未声明 uniform，Cesium 静默忽略无警告 ✓ 安全）。

- [ ] **Step 1: 写失败测试（CloudsPass.test.ts 追加）**

```ts
describe('M5 T2 SHADOW_LENGTH MRT/参数', () => {
  it('lightShafts 默认开：MRT 3 attachment（含 shadowLengthTexture）+ uniformMap 三参数', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), mkState(), {
      parameters: defaultCloudsParameters()
    })
    expect(pass.shadowLengthTexture).toBeDefined()
    expect(pass.shadowLengthTexture.width).toBe(1920) // 全分（temporal 关）
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.maxShadowLengthIterationCount()).toBe(500)
    expect(um.minShadowLengthStepSize()).toBe(50)
    expect(um.maxShadowLengthRayDistance()).toBe(2e5)
    pass.destroy()
  })

  it('lightShafts=false：MRT 2 attachment、无 shadowLengthTexture（零回归）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), mkState(), {
      lightShafts: false
    })
    expect(pass.shadowLengthTexture).toBeUndefined()
    pass.destroy()
  })
})
```

（`mkState` 等用文件现有 helper；import `defaultCloudsParameters` 已在 M4 测试段引入。）

- [ ] **Step 2: 跑测试确认失败 → Step 3: 实现**——
  (a) `cloudsDefaultParameters.ts`：接口三字段 + 默认值（注释：three `qualityPresets.ts defaults.clouds` 逐字）。
  (b) `CloudsPass.ts`：`const lightShafts = options.lightShafts !== false`；`const shadowLenTex = lightShafts ? mkMrtTex() : undefined`；`mrtTextures = lightShafts ? [colorTex, depthVelTex, shadowLenTex] : [colorTex, depthVelTex]`（替换现有数组字面量，注释引用 M2 坑「attachment 数=out 数」）；uniformMap 追加三闭包；destroy 补 `shadowLenTex?.destroy()`；句柄返回 `shadowLengthTexture: shadowLenTex`。文件头 M5 注释段更新。

- [ ] **Step 4: 全量 + Commit**

```bash
pnpm --filter @cesium-geospatial/clouds test && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
git add -A packages/cesium-clouds/src/ && git commit -m "feat(clouds): M5 T2 shadowLength 参数三件套 + MRT 3 attachment（lightShafts 分支）"
```

---

### Task 3: demo URL + 视觉验收 + results

**Files:**
- Modify: `apps/demo/src/main.ts`（`?cloudsLightShafts=0`）
- Create: `docs/superpowers/plans/2026-08-17-clouds-m5-god-rays-results.md`

- [ ] **Step 1: main.ts**——clouds 参数段加 `...(getString('cloudsLightShafts') === '0' ? { lightShafts: false } : {})`，console info 更新提示。

- [ ] **Step 2: 全量回归**

```bash
pnpm test && pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
```

- [ ] **Step 3: Commit 代码**

- [ ] **Step 4: 技术 smoke（headless）**——朝太阳视角（太阳低角度 + 云隙），`cloudsLightShafts=0/1` 截图对比（分区亮度/方差差分——god rays 区应可见差异）；console 无 GL/TS 错误。

- [ ] **Step 5: 用户视觉验收**——验收点：① 朝太阳方向云间体积光柱（subtle 强度对齐 three 前置核实结论）② `cloudsLightShafts=0/1` 对比可辨 ③ 无同心波纹（vs 历史 screen-space god rays 的失败模式）④ 无过暗（云影区不死黑——higher-order LUT 生效）⑤ 静止无新增抖动（BSM 采样路径同 M3）。

- [ ] **Step 6: results 文档 + Commit**（对齐 M4 results 格式）

## Self-Review

- **Spec 覆盖**：M5 r1 三条（云 shader 内完成 ✓ 零 atmosphere 钩子改动；验收对比 ✓ T3；debug probe 可视化 shadowLength——spec 原文针对 temporal 语境的 1/4 分方块检查，temporal 已默认关，该条不适用，results 记录说明）。
- **占位符扫描**：无（三任务均完整代码/断言）。
- **类型一致性**：`lightShafts` 经 `CloudsMainOptions`（T1）→ `CloudsPassOptions` extends 透传（T2 消费 `options.lightShafts !== false`）✓；三参数名 shader 声明与 TS 字段逐字一致 ✓。
