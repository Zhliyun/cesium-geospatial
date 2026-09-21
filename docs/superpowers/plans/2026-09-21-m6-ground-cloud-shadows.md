# M6 地面云影实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 atmosphere aerial fragment 中采样云 BSM，把云影折进地表太阳直射份额（`mulSunIrr *= sunTransmittance`），实现云影实时投在地形上，无云像素逐位零回归。

**Architecture:** three-geospatial `HAS_SHADOW` 路径移植 + B 路径手术（不重算照明，乘子化）。双域分工：distToTop 射线球求交在密切球局部系（`posM + altitudeCorrection`），级联选择/BSM UV 用 raw ECEF 米。桥接走 `cloudsShadowLengthBridge` 同款惰性闭包模式（atmosphere 先建、clouds 后建、demo 编排层组装）。样本数 uniform 循环上限（`setQuality` 热切零重建）。

**Tech Stack:** Cesium PostProcessStage（WebGL2/GLSL ES 3.00）、字符串拼装 shader（`?raw` + `resolveIncludes`）、vitest + glslangValidator。

**Spec:** `docs/superpowers/specs/2026-09-21-m6-ground-cloud-shadows-design.md`（r2，4 路专家评审修订——执行者必读，本计划多处直接引用其 §编号）

## Global Constraints

- 所有代码注释用中文（仓库规范）。
- **零回归锚**：`?groundShadow=0` 时（bridge 不注入 → define 不开）新增 GLSL 全部在 `#ifdef HAS_GROUND_SHADOW` 内，shader 与 main 逐字节一致；define 开但无影时 `mulSunIrr *= 1.0` IEEE 精确逐位。
- **双域分工（spec §6.2，一手代码裁决）**：distToTop=局部系（`posM + altitudeCorrection`，米）；级联选择/UV=raw ECEF 米（posM 直投矩阵）。**不许一刀切全减或全不加**。
- 数组 uniform **恒 4 槽**（桥侧 padded 数组维护），运行期循环界 `u_cascadeCount`（现状 2-3）；空槽 intervals=(0,0)（区间测试恒假 → -1）。
- `cameraNear/far` 必须透传 `state.shadow.cameraNear/.far`（world 锚定缺省 **0** / cascades.far），**禁止**自取 `camera.frustum.near`（spec §5 r2 纠偏）。
- 桥数据返回**引用**（preRender 侧已有逐帧快照），禁止逐帧深 clone；`cascadeIndex=-1` 早退必须在 UV 计算之前（identity 矩阵 clip.w=0 → NaN uv 穿透守卫）。
- 桥实现闭包读顶层 impl（setQuality 热切自动切换），impl destroy 后返回 undefined。
- 测试命令：**包目录内直跑** `pnpm exec vitest run <file>`（--filter 有假绿坑，CLAUDE.md）；tsc 同理包目录 `pnpm exec tsc --noEmit`。glslang 编译测试依赖 glslangValidator（缺则 brew install glslang）。
- 每个 Task 结束 commit；GLSL 改动后 vite `?raw` 缓存可能不刷新——真机验证前 `pkill -f vite && rm -rf apps/demo/node_modules/.vite`。

---

### Task 1: core——CloudsShadowBridgeData 契约 + AtmosphereStage 桥接（define + dummy 表）

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`（接口 + validate + buildAtmosphereStage + append helper）
- Modify: `packages/cesium-core/src/index.ts`（类型导出）
- Test: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`

**Interfaces:**
- Consumes: 无（链头）。
- Produces: `CloudsShadowBridgeData`（导出接口，Task 3 clouds 侧 import）；`AtmosphereStageOptions.cloudsShadowBridge?: () => CloudsShadowBridgeData | undefined`；`AtmosphereStageOptions.groundShadowStrength?: number`（缺省 1）；uniform 键 `u_shadowBuffer/u_shadowMatrices/u_shadowInverseMatrices/u_shadowIntervals/u_shadowCameraNear/u_shadowFar/u_shellTopRadius/u_cascadeCount/u_sampleCount/u_groundShadowStrength`（Task 4 shader 声明同名）。

- [ ] **Step 1: 写失败测试**（AtmosphereStage.test.ts 追加）

```typescript
import { Matrix4 } from 'cesium'
// …文件已有 import 区追加（CloudsShadowBridgeData 从 './AtmosphereStage' 导入）

describe('M6 地面云影桥接（spec §5/§8.1）', () => {
  // 桥数据形状（经 createAtmosphereStage 的 uniforms 组装路径间接验证不可行——node 无 GL 上下文，
  // 直接测 validate/append 纯逻辑部分）
  it('validateAtmosphereOptions：groundShadowStrength 缺省 1，显式值透传', () => {
    // validateAtmosphereOptions 为模块内导出？若未导出，经 resolved 默认值断言路径：
    // 用 buildAtmosphereUniforms(luts, validateAtmosphereOptions({}), state) 读 u_groundShadowStrength
    const resolved = validateAtmosphereOptions({ groundShadowStrength: 0.5 })
    expect(resolved.groundShadowStrength).toBe(0.5)
    expect(validateAtmosphereOptions({}).groundShadowStrength).toBe(1)
  })
})
```

注：若 `validateAtmosphereOptions` 未导出，则在本 Task 将其导出（纯函数，导出无副作用）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/AtmosphereStage.test.ts
```
Expected: FAIL——`groundShadowStrength` 属性不存在 / import 编译错。

- [ ] **Step 3: 实现 AtmosphereStage.ts 改动**

3a. 接口（放在 `AtmosphereStageOptions` 定义之前）：

```typescript
/** M6 地面云影桥数据（spec §5）：clouds handle.getGroundShadowBridgeData() 产物，demo 编排层组装。
 *  数组恒 4 槽（实际级联数见 cascadeCount；空槽 intervals=(0,0) → 级联 -1 无影）。 */
export interface CloudsShadowBridgeData {
  /** ShadowPass.bsmTexture；首帧 render 前 undefined → u_shadowBuffer 落 dummy Texture3D。 */
  bsm: Texture3D | undefined
  matrices: Matrix4[]         // raw ECEF 米→light clip ×4 槽
  inverseMatrices: Matrix4[]  // clip→raw ECEF 米 ×4 槽（PCF 半径换算）
  intervals: Cartesian2[]     // ×4 槽；world 锚定=绝对视深/far 归一化
  cameraNear: number          // 透传 state.shadow.cameraNear（world 缺省 0）——禁自取 camera.frustum
  far: number                 // 透传 state.shadow.far（world=cascades.far）
  shellTopRadius: number      // 云壳顶球半径米（CascadedShadowMaps.shellTopRadius，缺省 6362200）——shader 零加法防 km/m 陷阱
  cascadeCount: number        // 实际级联数（low=2 其余=3）
  sampleCount: number         // PCF 样本数（档位，≤16）
}
```

3b. `AtmosphereStageOptions` 追加字段：

```typescript
  /** M6 地面云影桥（spec §5）：非空时 aerial shader 开 HAS_GROUND_SHADOW define。
   *  ?cloudsShadow=0（关自阴影）时地面云影连带消失（README 标注）。 */
  cloudsShadowBridge?: () => CloudsShadowBridgeData | undefined
  /** 地面云影强度（spec §7，0-1 缺省 1）；0 时采样短路（逐位等价）。 */
  groundShadowStrength?: number
```

3c. `validateAtmosphereOptions` 返回对象追加：

```typescript
    groundShadowStrength: options.groundShadowStrength ?? 1,
```

3d. `buildAtmosphereStage` 的 fragmentShader 调用追加 define 开关（`cloudsShadowLength` 行旁）：

```typescript
        groundCloudShadow: options.cloudsShadowBridge != null
```

3e. uniforms IIFE 内（`appendCloudsShadowLengthUniform(...)` 调用之后）追加调用：

```typescript
        // M6 地面云影（spec §5/§8.1）：惰性 dummy 走 append helper（桥 undefined/首帧 bsm 缺 → 无影零回归）。
        // dummy 语义：intervals (0,0) 区间测试恒假 → 级联 -1；cascadeCount=0 → 循环不执行。
        let groundShadowDummyTex: Texture3D | undefined
        appendGroundShadowUniforms(
          u,
          options.cloudsShadowBridge,
          resolved.groundShadowStrength,
          () => {
            groundShadowDummyTex ??= new Texture3D({
              context: (scene as unknown as { context: Context }).context,
              source: {
                width: 1,
                height: 1,
                depth: 1,
                arrayBufferView: new Uint8Array(4) // 全 0
              },
              pixelFormat: PixelFormat.RGBA,
              pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
              flipY: false
            })
            return groundShadowDummyTex
          }
        )
```

3f. append helper（`appendCloudsShadowLengthUniform` 函数之后，同款风格）：

```typescript
// M6 地面云影：groundShadowBridge → atmosphere uniform 表增量（10 键）。
// ⚠️ 与 cloudsShadowLength 同款约束：uniformMap 闭包返回 undefined 会崩帧（Cesium _setUniforms
// 不检查返回值，UniformArrayMat4.set 读 undefined.length）——data() 恒返回完整 bundle。
// 空槽约定（spec §8.1）：intervals (0,0) 区间测试恒假 → -1；matrices identity（-1 路径不消费——
// NaN uv 前提：-1 早退在 getGroundShadowUv 之前，shader 侧保持）。
function appendGroundShadowUniforms(
  uniforms: Record<string, unknown>,
  bridge: (() => CloudsShadowBridgeData | undefined) | undefined,
  groundShadowStrength: number,
  makeDummyTexture3D: () => Texture3D
): void {
  if (bridge == null) return
  const dummyMatrices = Array.from({ length: 4 }, () => Matrix4.clone(Matrix4.IDENTITY)) // 可变副本（防写冻结对象）
  const dummyIntervals = Array.from({ length: 4 }, () => new Cartesian2(0, 0))
  const data = (): CloudsShadowBridgeData =>
    bridge() ?? {
      bsm: undefined,
      matrices: dummyMatrices,
      inverseMatrices: dummyMatrices, // identity 同族可共享
      intervals: dummyIntervals,
      cameraNear: 0,
      far: 1,
      shellTopRadius: 6362200,
      cascadeCount: 0,
      sampleCount: 1
    }
  uniforms.u_shadowBuffer = () => data().bsm ?? makeDummyTexture3D()
  uniforms.u_shadowMatrices = () => data().matrices
  uniforms.u_shadowInverseMatrices = () => data().inverseMatrices
  uniforms.u_shadowIntervals = () => data().intervals
  uniforms.u_shadowCameraNear = () => data().cameraNear
  uniforms.u_shadowFar = () => data().far
  uniforms.u_shellTopRadius = () => data().shellTopRadius
  uniforms.u_cascadeCount = () => data().cascadeCount
  uniforms.u_sampleCount = () => data().sampleCount
  // 强度静态值（0-1；shader 侧 0 → 采样短路逐位等价）。define 关时 shader 无此声明，Cesium 静默忽略。
  uniforms.u_groundShadowStrength = groundShadowStrength
}
```

3g. import 检查：`Texture3D` 若未从 'cesium' import 则补（`cesium-augment.d.ts` 已声明最小类型）。

- [ ] **Step 4: index.ts 导出类型**

`packages/cesium-core/src/index.ts` 的 AtmosphereStage type 导出块（~:40-42）追加：

```typescript
  CloudsShadowBridgeData,
```

- [ ] **Step 5: 跑测试确认通过 + 新增 append 单测**

AtmosphereStage.test.ts 追加（appendGroundShadowUniforms 未导出——经导出后测，或直接 export 该纯函数测；选择**导出**）：

```typescript
import { appendGroundShadowUniforms } from './AtmosphereStage'

describe('appendGroundShadowUniforms（spec §8.1 dummy 表）', () => {
  it('bridge=null 时不加任何键', () => {
    const u: Record<string, unknown> = {}
    appendGroundShadowUniforms(u, undefined, 1, () => ({}) as never)
    expect(Object.keys(u)).toHaveLength(0)
  })
  it('bridge 在场：10 键齐；bridge()=undefined 时 bundle 完整（intervals 4×(0,0)、cascadeCount=0）', () => {
    const u: Record<string, unknown> = {}
    const dummyTex = { _texture: 'd' } as never
    appendGroundShadowUniforms(
      u,
      () => undefined,
      1,
      () => dummyTex
    )
    const keys = ['u_shadowBuffer', 'u_shadowMatrices', 'u_shadowInverseMatrices', 'u_shadowIntervals',
      'u_shadowCameraNear', 'u_shadowFar', 'u_shellTopRadius', 'u_cascadeCount', 'u_sampleCount',
      'u_groundShadowStrength']
    for (const k of keys) expect(u[k], k).toBeDefined()
    expect((u.u_shadowIntervals as () => unknown)()).toHaveLength(4)
    expect((u.u_cascadeCount as () => number)()).toBe(0)
    expect((u.u_groundShadowStrength as unknown) as number).toBe(1)
  })
  it('bridge 返回数据：字段透传；bsm=undefined 时 u_shadowBuffer 落 dummy', () => {
    const u: Record<string, unknown> = {}
    const dummyTex = { _texture: 'd' } as never
    const live: CloudsShadowBridgeData = {
      bsm: undefined, matrices: [], inverseMatrices: [], intervals: [],
      cameraNear: 0, far: 6e4, shellTopRadius: 6362200, cascadeCount: 3, sampleCount: 16
    }
    appendGroundShadowUniforms(u, () => live, 0.5, () => dummyTex)
    expect((u.u_shadowBuffer as () => unknown)()).toBe(dummyTex)
    expect((u.u_shadowFar as () => number)()).toBe(6e4)
    expect((u.u_cascadeCount as () => number)()).toBe(3)
    expect((u.u_groundShadowStrength as unknown) as number).toBe(0.5)
  })
})
```

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/AtmosphereStage.test.ts
```
Expected: PASS。

- [ ] **Step 6: tsc + commit**

```bash
cd packages/cesium-core && pnpm exec tsc --noEmit
git add -A && git commit -m "feat(core): M6 桥接契约——CloudsShadowBridgeData+appendGroundShadowUniforms（dummy 表防 undefined 崩帧）"
```

---

### Task 2: clouds——qualityPresets 增 groundShadowSamples

**Files:**
- Modify: `packages/cesium-clouds/src/qualityPresets.ts`
- Test: `packages/cesium-clouds/src/qualityPresets.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `ResolvedCloudsQuality.groundShadowSamples: number`；`AppliedCloudsQuality.groundShadowSamples: number`（low 4 / medium 8 / high 16 / ultra 16）——Task 3 桥 sampleCount 源。

- [ ] **Step 1: 写失败测试**（qualityPresets.test.ts 追加）

```typescript
describe('M6 groundShadowSamples 档位（spec §7：three 缺省 8/上限 16，medium=three 缺省档）', () => {
  it('四档映射 low4/medium8/high16/ultra16', () => {
    expect(cloudsQualityPresets.low.groundShadowSamples).toBe(4)
    expect(cloudsQualityPresets.medium.groundShadowSamples).toBe(8)
    expect(cloudsQualityPresets.high.groundShadowSamples).toBe(16)
    expect(cloudsQualityPresets.ultra.groundShadowSamples).toBe(16)
  })
  it('applyQualityPreset 产物透传', () => {
    expect(applyQualityPreset('low', {}).groundShadowSamples).toBe(4)
    expect(applyQualityPreset('high', {}).groundShadowSamples).toBe(16)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/cesium-clouds && pnpm exec vitest run src/qualityPresets.test.ts
```
Expected: FAIL（属性不存在）。

- [ ] **Step 3: 实现**

qualityPresets.ts 三处：

```typescript
// ResolvedCloudsQuality 接口追加（upscaleDivisor 注释上方）：
  /** M6 地面云影 PCF 样本数（spec §7）：low4/medium8/high16/ultra16。medium=three 缺省档
   *  （shadowSampleCount=8），16=其 define 上限（high/ultra 画质取向，实测超预算可下调）。 */
  groundShadowSamples: number

// 四个档位对象各追加（low 内 / medium 内 / high 内 / ultra 内）：
    groundShadowSamples: 4,   // low
    groundShadowSamples: 8,   // medium
    groundShadowSamples: 16,  // high
    groundShadowSamples: 16,  // ultra

// AppliedCloudsQuality 接口追加：
  /** M6 地面云影样本数（恒档位源，无用户覆盖——逃生门 ?groundShadow=0 整体关）。 */
  groundShadowSamples: number

// applyQualityPreset 返回对象追加：
    groundShadowSamples: preset.groundShadowSamples,
```

- [ ] **Step 4: 跑测试确认通过；若文件含档位快照测试，同步更新快照**

```bash
cd packages/cesium-clouds && pnpm exec vitest run src/qualityPresets.test.ts
```
Expected: PASS（快照测试若因新增字段失败——更新快照并在 commit message 注明）。

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(clouds): M6 档位 groundShadowSamples——low4/medium8/high16/ultra16"
```

---

### Task 3: clouds——getGroundShadowBridgeData（4 槽 padded 数组 + handle 委托）

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（CloudsStageImpl 接口 + buildImpl + handle）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`

**Interfaces:**
- Consumes: Task 1 `CloudsShadowBridgeData`（from '@cesium-geospatial/core'）；Task 2 `applied.groundShadowSamples`。
- Produces: `CloudsStageHandle.getGroundShadowBridgeData(): CloudsShadowBridgeData | undefined`——Task 6 demo 消费。

- [ ] **Step 1: 写失败测试**（createCloudsStage.test.ts 追加；参考文件内既有 createCloudsStage 测试的 scene mock 构造方式）

```typescript
describe('M6 getGroundShadowBridgeData（spec §5）', () => {
  it('clouds=false 时不产生 handle（既有行为，防回归锚）', () => {
    expect(createCloudsStage(mockScene(), luts, weather, {})).toBeUndefined()
  })

  it('handle.getGroundShadowBridgeData：数组恒 4 槽；cascadeCount/增补字段与档位一致', () => {
    const handle = createCloudsStage(mockScene(), luts, weather, { clouds: true })
    const d = handle!.getGroundShadowBridgeData()
    expect(d).toBeDefined()
    expect(d!.matrices).toHaveLength(4)
    expect(d!.inverseMatrices).toHaveLength(4)
    expect(d!.intervals).toHaveLength(4)
    expect(d!.cascadeCount).toBe(3) // 缺省 high 档
    expect(d!.sampleCount).toBe(16)
    expect(d!.shellTopRadius).toBe(6362200)
    expect(d!.cameraNear).toBe(0) // world 锚定缺省（spec §5 r2 纠偏）
    expect(d!.bsm).toBeUndefined() // 首帧 preRender 前
    handle!.destroy()
  })

  it('destroy 后返回 undefined', () => {
    const handle = createCloudsStage(mockScene(), luts, weather, { clouds: true })!
    handle.destroy()
    expect(handle.getGroundShadowBridgeData()).toBeUndefined()
  })
})
```

（mock 场景构造复用文件内既有 helper——若既有测试用 `createCloudsStage` 的最小 mock scene，照抄；本 Task 执行者先读该测试文件顶部既有 mock。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/cesium-clouds && pnpm exec vitest run src/createCloudsStage.test.ts -t "getGroundShadowBridgeData"
```
Expected: FAIL——方法不存在。

- [ ] **Step 3: 实现 createCloudsStage.ts**

3a. import 区追加（from '@cesium-geospatial/core' 的既有 import 语句内）：`type CloudsShadowBridgeData`。

3b. `CloudsStageImpl` 接口（~:458）追加方法声明：

```typescript
  /** M6 地面云影桥数据（spec §5）：shadowState + inverseMatrices + 档位样本数组装；引用语义零 clone。 */
  getGroundShadowBridgeData(): CloudsShadowBridgeData | undefined
```

3c. `buildCloudsStageImpl` 内，`shadowState` 构造（~:662-668）之后追加 padded 桥数组：

```typescript
    // ── M6 地面云影桥（spec §5/§8.1）：恒 4 槽 padded 数组（GLSL uniform 数组编译期定长 [4]，
    //    实际级联 2-3 槽——不足槽保持 identity/(0,0)，(0,0) 区间测试恒假 → 级联 -1 无影）。
    //    与 shadowState.matrices（长度=cascadeCount，喂 shadow.frag 的 define 定长 uniform）分列，
    //    两套数组长度语义不同勿合并。changed 分支同步 clone（下方）。 ──
    const bridgeMatrices = Array.from({ length: 4 }, () => new Matrix4())
    const bridgeInverseMatrices = Array.from({ length: 4 }, () => new Matrix4())
    const bridgeIntervals = Array.from({ length: 4 }, () => new Cartesian2(0, 0))
```

3d. preRender changed 分支（~:1033-1038，`Matrix4.clone(cascades.cascades[i].inverseMatrix, inverseMatrices[i])` 所在循环内）追加三行：

```typescript
              Matrix4.clone(cascades.cascades[i].matrix, bridgeMatrices[i])
              Matrix4.clone(cascades.cascades[i].inverseMatrix, bridgeInverseMatrices[i])
              bridgeIntervals[i].x = cascades.cascades[i].interval.x
              bridgeIntervals[i].y = cascades.cascades[i].interval.y
```

3e. `buildImpl` 返回的 impl 对象追加方法（`onPreRender`/`destroy` 同级；闭包量 enableShadow/shadowState/bridge*/cascades/applied 均在本函数作用域）：

```typescript
    getGroundShadowBridgeData(): CloudsShadowBridgeData | undefined {
      // ?cloudsShadow=0（shadowPass=false）→ 无 BSM，桥整体关闭（README 标注连带语义）
      if (!enableShadow) return undefined
      return {
        bsm: shadowState.bsm,
        matrices: bridgeMatrices,
        inverseMatrices: bridgeInverseMatrices,
        intervals: bridgeIntervals,
        cameraNear: shadowState.cameraNear,
        far: shadowState.far,
        shellTopRadius: cascades.shellTopRadius,
        cascadeCount,
        sampleCount: applied.groundShadowSamples
      }
    },
```

3f. 顶层 `handle` 对象（~:1200）追加方法（闭包读顶层 impl——setQuality 重建后自动指向新 impl，对齐既有 getter 模式）：

```typescript
    // M6 地面云影桥（spec §5）：destroy 后 undefined（零回归路径）；setQuality 换 impl 引用自动切换
    getGroundShadowBridgeData(): CloudsShadowBridgeData | undefined {
      return destroyed ? undefined : impl.getGroundShadowBridgeData()
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/cesium-clouds && pnpm exec vitest run src/createCloudsStage.test.ts
```
Expected: PASS（含既有全部用例——特别注意 setQuality 相关既有用例不回归）。

- [ ] **Step 5: tsc + commit**

```bash
cd packages/cesium-clouds && pnpm exec tsc --noEmit
git add -A && git commit -m "feat(clouds): M6 桥出口 getGroundShadowBridgeData——恒4槽padded数组+引用语义+destroy守卫"
```

---

### Task 4: core——aerial frag GLSL 函数族（uniform 块 + 级联变体 + PCF）+ glslang 编译测试

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`
- Test: `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts`

**Interfaces:**
- Consumes: Task 1 define 开关名 `groundCloudShadow`（buildAerialPerspectiveFragmentShader options）。
- Produces: GLSL 函数 `getGroundCascadeIndex/getGroundShadowUv/readGroundShadowOpticalDepth/sampleGroundShadowOpticalDepthPCF/getGroundShadowRadius`（Task 5 main 消费）；GLSL 常量 `HAS_GROUND_SHADOW` define。

- [ ] **Step 1: 写失败编译测试**（aerialPerspective.compile.test.ts 的 COMBOS 数组追加两项）

```typescript
  ['M6 地面云影（GROUND_CLOUD_SHADOW define 全函数族）', { groundCloudShadow: true }],
  ['M6 地面云影+光柱组合（双云 uniform 块共存）', { groundCloudShadow: true, cloudsShadowLength: true }]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.compile.test.ts
```
Expected: FAIL——buildAerialPerspectiveFragmentShader 不识别 groundCloudShadow（TS 编译错或 define 不生效断言失败）。

- [ ] **Step 3: 实现 aerialPerspective.frag.ts**

3a. `AerialPerspectiveFragOptions` 追加：

```typescript
  /**
   * M6 地面云影（spec 2026-09-21 r2 §6）：地面像素采样云 BSM → exp(-光深) 乘太阳直射份额。
   * 默认 false（零回归）；由 AtmosphereStage 依 cloudsShadowBridge 非空开启。
   * 双域分工（§6.2 一手代码裁决）：distToTop=密切球局部系（posM+altitudeCorrection）；
   * 级联选择/UV=raw ECEF 米。全部新增代码在 #ifdef HAS_GROUND_SHADOW 内（define 关=逐字节同 main）。
   */
  groundCloudShadow?: boolean
```

3b. `buildAerialPerspectiveFragmentShader` 的 resolved defaults 追加 `groundCloudShadow: false`；defines 区（`CLOUDS_SHADOW_LENGTH` 行后）追加：

```typescript
  if (o.groundCloudShadow) defines.push('#define HAS_GROUND_SHADOW') // M6 地面云影
```

3c. uniforms 区（`o.cloudsShadowLength` 块后）追加：

```typescript
  // M6 地面云影 uniform（spec §5；值由 AtmosphereStage appendGroundShadowUniforms 注入）
  if (o.groundCloudShadow) uniforms.push(GROUND_SHADOW_UNIFORMS_GLSL)
```

3d. 模块级新常量（`FRAME_UNIFORMS_GLSL` 之后）：

```typescript
// M6 地面云影 uniform 块（GROUND_CLOUD_SHADOW define 时拼入；命名 spec §5）。
// 数组恒 [4] 槽（GLSL 编译期定长；实际级联数 u_cascadeCount 运行期界，空槽值由桥侧 dummy 约定保证无消费）。
const GROUND_SHADOW_UNIFORMS_GLSL = `
uniform sampler3D u_shadowBuffer;
uniform mat4 u_shadowMatrices[4];
uniform mat4 u_shadowInverseMatrices[4];
uniform vec2 u_shadowIntervals[4];
uniform float u_shadowCameraNear;
uniform float u_shadowFar;
uniform float u_shellTopRadius;
uniform float u_cascadeCount;
uniform float u_sampleCount;
`
// u_groundShadowStrength 在 FRAME_UNIFORMS 语义（静态标量，A/B 旋钮）——并入本块尾部声明：
// （保持单块好裁剪；define 关时整块不进 shader，Cesium 对 uniformMap 多余键静默忽略）
```
（`u_groundShadowStrength` 一并写进上面块：`uniform float u_groundShadowStrength;`）

3e. 函数族常量（HELPERS_GLSL 之后）：

```typescript
// M6 地面云影函数族（three aerialPerspectiveEffect.frag HAS_SHADOW 段移植 + 本仓库双域手术，spec §6）。
// 依赖：interleavedGradientNoise（本文件 HELPERS_GLSL 已有）、core/raySphereIntersection、core/vogelDisk
//（resolveIncludes 表扩展见 3g）。sunDirection/altitudeCorrection 为既有 FRAME uniform。
const GROUND_SHADOW_FUNCTIONS_GLSL = `
#include "core/raySphereIntersection"
#include "core/vogelDisk"

// —— 级联选择：core chunk getFadedCascadeIndex 的运行期变体（spec §6.3）——
// 不逐字 include chunk：其 #error 宏守卫 + #pragma unroll_loop 预处理（core resolveIncludes 无此 pass）
// + viewZToOrthographicDepth 等 clouds 侧依赖在 aerial 语境不可用。语义逐行复刻：
// 区间匹配 + margin dithered fade + 末层远端上界 depth<1.0（云侧 2026-08-28 修复同款）。
float groundViewZToOrthographicDepth(const float viewZ, const float near, const float far) {
  return (viewZ + near) / (near - far);
}
float groundSaturate(const float x) { return clamp(x, 0.0, 1.0); }

int getGroundCascadeIndex(const vec3 posM, const float jitter) {
  vec4 viewPosition = czm_view * vec4(posM, 1.0);
  float depth = groundViewZToOrthographicDepth(viewPosition.z, u_shadowCameraNear, u_shadowFar);
  int count = int(u_cascadeCount);
  int nextIndex = -1;
  int prevIndex = -1;
  float alpha = 0.0;
  for (int i = 0; i < count; ++i) {
    vec2 interval = u_shadowIntervals[i];
    float intervalCenter = (interval.x + interval.y) * 0.5;
    float closestEdge = depth < intervalCenter ? interval.x : interval.y;
    float margin = closestEdge * closestEdge * 0.5;
    interval += margin * vec2(-0.5, 0.5);
    if (i < count - 1) {
      if (depth >= interval.x && depth < interval.y) {
        prevIndex = nextIndex;
        nextIndex = i;
        alpha = groundSaturate(min(depth - interval.x, interval.y - depth) / margin);
      }
    } else {
      // 末层：远端上界 depth < 1.0（=u_shadowFar）+ 远端 fade-out（alpha 含 1.0-depth 项）
      if (depth >= interval.x && depth < 1.0) {
        prevIndex = nextIndex;
        nextIndex = i;
        alpha = groundSaturate(min(depth - interval.x, 1.0 - depth) / margin);
      }
    }
  }
  return jitter <= alpha ? nextIndex : prevIndex;
}

// BSM UV：raw ECEF 米 → cascade light clip（矩阵 JS 侧从 raw positionWC 构建——域分工 §6.2）。
vec2 getGroundShadowUv(const vec3 posM, const int cascadeIndex) {
  vec4 clip = u_shadowMatrices[cascadeIndex] * vec4(posM, 1.0);
  clip /= clip.w;
  return clip.xy * 0.5 + 0.5;
}

// 光深（three 逐字移植，米制零换算）：r=frontDepth g=meanExtinction(1/m) b=maxOpticalDepth a=tail。
// 尾项 a 不加（three 注释：地面影会被 inscatter 衰减，加尾项反而锯齿明显）。
float readGroundShadowOpticalDepth(const vec2 uv, const float distToTopM, const int cascadeIndex) {
  vec4 s = texture(u_shadowBuffer, vec3(uv, (float(cascadeIndex) + 0.5) / u_cascadeCount));
  return min(s.b, s.g * max(0.0, distToTopM - s.r));
}

// vogel disk PCF + IGN 旋转（不引 STBN——16 样本+IGN=three 原版域内画质；uv 越界守卫防
// CLAMP_TO_EDGE 边缘 texel 条纹，three aerial L192 同款）。
float sampleGroundShadowOpticalDepthPCF(
  const vec3 posM,
  const float distToTopM,
  const float radius,
  const int cascadeIndex
) {
  vec2 uv = getGroundShadowUv(posM, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  vec2 texelSize = vec2(1.0) / vec2(textureSize(u_shadowBuffer, 0).xy);
  float sum = 0.0;
  float rot = interleavedGradientNoise(gl_FragCoord.xy) * 6.283185307179586;
  int n = int(u_sampleCount);
  for (int i = 0; i < n; ++i) {
    vec2 offset = vogelDisk(i, n, rot);
    sum += readGroundShadowOpticalDepth(uv + offset * radius * texelSize, distToTopM, cascadeIndex);
  }
  return sum / float(n);
}

// PCF 半径随屏幕像素密度自适应（three getShadowRadius 逐字移植，r2 核验 czm_view/projection/viewport
// automatic uniform 可用）：BSM clip 空间 2px 反投影测像素尺寸 → remap 10-50px → 0-3 texel。
float getGroundShadowRadius(const vec3 posM) {
  vec4 clip = u_shadowMatrices[0] * vec4(posM, 1.0);
  clip /= clip.w;
  vec2 shadowSize = vec2(textureSize(u_shadowBuffer, 0));
  vec3 offset = vec3(2.0 / shadowSize, 0.0);
  vec4 worldX = u_shadowInverseMatrices[0] * (clip + offset.xzzz);
  vec4 worldY = u_shadowInverseMatrices[0] * (clip + offset.zyzz);
  mat4 viewProjectionMatrix = czm_projection * czm_view;
  vec4 projected = viewProjectionMatrix * vec4(posM, 1.0);
  vec4 projectedX = viewProjectionMatrix * worldX;
  vec4 projectedY = viewProjectionMatrix * worldY;
  projected /= projected.w;
  projectedX /= projectedX.w;
  projectedY /= projectedY.w;
  vec2 center = (projected.xy * 0.5 + 0.5) * czm_viewport.zw;
  vec2 offsetX = (projectedX.xy * 0.5 + 0.5) * czm_viewport.zw;
  vec2 offsetY = (projectedY.xy * 0.5 + 0.5) * czm_viewport.zw;
  float size = max(length(offsetX - center), length(offsetY - center));
  float t = clamp((size - 10.0) / 40.0, 0.0, 1.0); // remapClamped(size, 10, 50, 0, 3)
  return t * 3.0;
}
`
```

3f. functions 数组与 resolveIncludes 表（`buildAerialPerspectiveFragmentShader` 内）：

```typescript
  const functions: string[] = [HELPERS_GLSL, LOG_DEPTH_GLSL]
  if (o.groundCloudShadow) functions.push(GROUND_SHADOW_FUNCTIONS_GLSL) // M6（在 HELPERS 后——用其 IGN）
```

resolveIncludes 第二参表扩展（core 两项；确认 glslIndex.core.vogelDisk / raySphereIntersection 已注册——已核均在）：

```typescript
    {
      bruneton: { common: glslIndex.bruneton.common, runtime: glslIndex.bruneton.runtime },
      core: {
        raySphereIntersection: glslIndex.core.raySphereIntersection,
        vogelDisk: glslIndex.core.vogelDisk
      }
    }
```

3g. `VALIDATION_STUBS_GLSL` 追加桩（函数族消费的 automatic uniform）：

```typescript
uniform mat4 czm_view;
uniform mat4 czm_projection;
uniform vec4 czm_viewport;
```

- [ ] **Step 4: 跑编译测试确认通过**

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.compile.test.ts
```
Expected: PASS——含两个新 combo（glslang 真编译；若报 vogelDisk/raySphere 标识符冲突，检查 chunk 是否自带 #include——按报错就地调整 include 位置）。同时跑既有 frag 测试防 wiring 回归：

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.frag.test.ts
```
Expected: PASS（ground uniform 键**不进** AERIAL_PERSPECTIVE_UNIFORM_NAMES——沿 u_cloudsShadowLength 先例）。

- [ ] **Step 5: commit**

```bash
git add -A && git commit -m "feat(core): M6 aerial GLSL 函数族——运行期级联变体+vogel PCF+半径自适应（glslang 双 combo）"
```

---

### Task 5: core——乘子插入 + 短路 + debug=11 + 零回归锚测试

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`（buildMainFn 的 main GLSL）
- Test: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`（或 compile.test.ts 追加锚测试）

**Interfaces:**
- Consumes: Task 4 全部函数；既有 `hasScene/sceneWorldPosKm/tHitG/discG/mulNormal/mulSunIrr`。
- Produces: `groundSunTrans`（debug=11 直显）；最终像素行为。

- [ ] **Step 1: 写失败锚测试**（frag.test.ts 追加——字符串锚 + 公式 TS 镜像）

```typescript
describe('M6 乘子插入锚（spec §6.6 零回归锚）', () => {
  const src = buildAerialPerspectiveFragmentShader({ groundCloudShadow: true })
  it('mulSunIrr 乘法行存在（唯一插入点）', () => {
    expect(src).toContain('mulSunIrr *= mix(1.0, groundSunTrans, u_groundShadowStrength);')
  })
  it('短路条件含 strength>0 与太阳项>0', () => {
    expect(src).toContain('u_groundShadowStrength > 0.0')
    expect(src).toContain('max(dot(mulNormal, sunDirection), 0.0) > 0.0')
  })
  it('define 关闭时无任何 groundShadow GLSL（零回归：逐字节同 main）', () => {
    const off = buildAerialPerspectiveFragmentShader({})
    expect(off).not.toContain('groundSunTrans')
    expect(off).not.toContain('u_shadowBuffer')
    expect(off).toBe(buildAerialPerspectiveFragmentShader({})) // 确定性
  })
  it('TS 镜像公式性质（spec §9.1.2）：sunTrans=1 ≡ 现状；sunTrans=0 = 纯天光+夜地板', () => {
    const solar = 1.0, skyIrr = 0.3, sunIrrDot = 0.7, ambient = 0.01
    // 与 GLSL 逐式对应：eff = mix(1.0, sunTrans, strength)；groundLightColor = max((sunIrrDot*eff + skyIrr)/solar, ambient)
    const groundLightColor = (sunTrans: number, strength: number) => {
      const eff = 1 * (1 - strength) + sunTrans * strength
      return Math.max((sunIrrDot * eff + skyIrr) / solar, ambient)
    }
    expect(groundLightColor(1, 1)).toBe(Math.max((sunIrrDot + skyIrr) / solar, ambient)) // 无云≡现状
    expect(groundLightColor(0, 1)).toBe(Math.max(skyIrr / solar, ambient))               // 全影=天光地板
    expect(groundLightColor(0.5, 0)).toBe(Math.max((sunIrrDot + skyIrr) / solar, ambient)) // strength=0 短路≡现状
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.frag.test.ts
```
Expected: FAIL——锚字符串不存在。

- [ ] **Step 3: 实现 buildMainFn 的 main GLSL 三处改动**

3a. hasScene 块前（`bool hasScene = false;` 声明之前）提升声明：

```glsl
#ifdef HAS_GROUND_SHADOW
  // M6：depth 重建的 raw ECEF 米制位置（§6.2 posM 主路径；hasScene=false 时由 tHitG 兜底覆盖）
  vec3 sceneWorldPosM = vec3(0.0);
#endif
```

hasScene 块内（`vec3 sceneWorldPosKm = worldPos4.xyz * METER_TO_LENGTH_UNIT ...` 行之前，同一作用域）：

```glsl
#ifdef HAS_GROUND_SHADOW
        sceneWorldPosM = worldPos4.xyz; // raw ECEF 米（altCorr 加之前的原始值）
#endif
```

3b. `vec3 groundLightColor;` 之前（main 作用域，debug 段可见）：

```glsl
#ifdef HAS_GROUND_SHADOW
  // M6 地面云影透射率（debug=11 直显；初始 1=无影，采样后 exp(-光深)）
  float groundSunTrans = 1.0;
#endif
```

groundLightColor 块内（`mulSunIrr` 赋值语句之后、`mulSkyIrr` 之前）插入采样与乘法：

```glsl
#ifdef HAS_GROUND_SHADOW
    // —— M6 地面云影（spec §6.2/§6.6）——
    // 采样点：hasScene → depth 重建 raw ECEF 米；瓦片流送缺失（discG>0）→ tHitG 椭球兜底
    //（继承 fore fallback 语义，防流送边界「影有/无」直线——mul 直线/depth 灰膜同型前科）；
    // 真天空（discG<0）不采样恒 1。距离量 km×1000 转米。
    vec3 groundShadowPosM = hasScene
      ? sceneWorldPosM
      : czm_viewerPositionWC + rayDirection * (tHitG * 1000.0);
    // 双域：distToTop 在密切球局部系求交（米；altitudeCorrection FRAME uniform 为米制）；
    // 级联/UV 用 raw posM。distToTop<=0（太阳沉没等）→ 级联 -1 路径。
    float groundDistToTopM = raySphereSecondIntersection(
      groundShadowPosM + altitudeCorrection, sunDirection, vec3(0.0), u_shellTopRadius);
    int groundCascade = -1;
    float groundRadius = 0.0;
    if (groundDistToTopM > 0.0) {
      groundCascade = getGroundCascadeIndex(groundShadowPosM, interleavedGradientNoise(gl_FragCoord.xy));
      groundRadius = getGroundShadowRadius(groundShadowPosM);
    }
    // 短路（spec §6.7，逐位等价）：strength=0 / 夜晚背阳（太阳项=0，mulSunIrr 太阳分量恒 0）/ 级联外
    if (u_groundShadowStrength > 0.0
        && max(dot(mulNormal, sunDirection), 0.0) > 0.0
        && groundCascade >= 0) {
      float groundOd = sampleGroundShadowOpticalDepthPCF(
        groundShadowPosM, groundDistToTopM, groundRadius, groundCascade);
      groundSunTrans = exp(-groundOd);
    }
    // 零回归锚：strength=0 或 sunTrans=1 时 mix 结果恒 1.0，×1.0 IEEE 精确
    mulSunIrr *= mix(1.0, groundSunTrans, u_groundShadowStrength);
#endif
```

3c. debug 级联尾部（`if (u_debugMode > 9.5) {` 之前）追加：

```glsl
      if (u_debugMode > 10.5) {
        // 11：M6 地面云影透射率灰度（R=groundSunTrans；无 define 恒白）
#ifdef HAS_GROUND_SHADOW
        out_FragColor = vec4(groundSunTrans, 0.0, 0.0, 1.0);
#else
        out_FragColor = vec4(1.0);
#endif
        return;
      }
```

- [ ] **Step 4: 跑测试确认通过 + 编译测试回归**

```bash
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.frag.test.ts src/cesium/aerialPerspective.compile.test.ts
```
Expected: 全 PASS（新 combo 重新编译含乘子段）。

- [ ] **Step 5: tsc + commit**

```bash
cd packages/cesium-core && pnpm exec tsc --noEmit
git add -A && git commit -m "feat(core): M6 乘子插入——mulSunIrr*=sunTransmittance（三重短路逐位零回归）+debug=11"
```

---

### Task 6: demo——main.ts 接线 + README 参数表

**Files:**
- Modify: `apps/demo/src/main.ts`（外层声明 + atmosphere options + clouds 后赋值 + 失败回收）
- Modify: `README.md`（URL 参数表；以 `grep -n cloudsShaftStep README.md` 定位表位置）

**Interfaces:**
- Consumes: Task 1 `cloudsShadowBridge/groundShadowStrength` options；Task 3 `handle.getGroundShadowBridgeData()`。
- Produces: URL `?groundShadow=0` / `?groundShadowStrength=N`。

- [ ] **Step 1: 外层声明**（`let atmosphereHandle` 声明附近，~L436「两块平级，需在外层声明共享」注释块）

```typescript
    // M6 地面云影桥（spec §5）：clouds 建后赋值（惰性闭包后补引用——atmosphere 先建零编排改动）；
    // ?groundShadow=0 → atmosphere options 不带 cloudsShadowBridge → define 不开 → 完全零回归。
    let groundShadowBridge: (() => CloudsShadowBridgeData | undefined) | undefined
```

import 区从 '@cesium-geospatial/core' 追加 `type CloudsShadowBridgeData`。

- [ ] **Step 2: atmosphere options**（~L441 `cloudsShadowLengthBridge` 行旁）

```typescript
        ...(getString('groundShadow') !== '0'
          ? { cloudsShadowBridge: () => groundShadowBridge?.() }
          : {}),
        ...(getNumber('groundShadowStrength') != null
          ? { groundShadowStrength: getNumber('groundShadowStrength')! }
          : {}),
```

- [ ] **Step 3: clouds 建后赋值**（~L747 `cloudsShadowBridge = cloudsHandle != null ? ...` 旁）

```typescript
        // M6 地面云影桥（spec §5）：闭包读 handle（内部读顶层 impl——setQuality 自动切换）
        groundShadowBridge = cloudsHandle != null
          ? () => cloudsHandle.getGroundShadowBridgeData()
          : undefined
```

catch 回收分支（`cloudsShadowBridge = undefined` 处）追加：

```typescript
              groundShadowBridge = undefined
```

- [ ] **Step 4: README 参数表追加三行**（定位既有云参数行，同格式）

```markdown
| `groundShadow` | `1` | M6 地面云影总开关；`0`=桥不注入（define 不开，与 main 逐位零回归）。注意 `cloudsShadow=0`（关自阴影）时地面云影连带关闭（无 BSM）。 |
| `groundShadowStrength` | `1` | 地面云影强度 0-1；`0` 时采样短路（与 `groundShadow=0` 像素等价，便宜逐位门）。 |
| `debug=11` | — | 地面云影透射率灰度直显（R=groundSunTrans，定位采样/级联问题）。 |
```

- [ ] **Step 5: 类型检查 + 手动冒烟**

```bash
cd apps/demo && pnpm exec tsc --noEmit
```
Expected: PASS。手动冒烟（清缓存后）：

```bash
pkill -f vite; rm -rf apps/demo/node_modules/.vite; pnpm dev
```
浏览器开 `http://localhost:5173/?time=2026-09-21T06:00:00Z&play=0`（白天高太阳角、有云场景）：console 无 GL 报错、画面与 `?groundShadow=0` 无明显差异（有云遮挡地面时应有影子——若时间点无云盖地，换 `debug=11` 看透射率分布非恒白）。

- [ ] **Step 6: commit**

```bash
git add -A && git commit -m "feat(demo): M6 地面云影接线——?groundShadow/?groundShadowStrength+README 参数表"
```

---

### Task 7: 全量回归 + 真机验收（spec §9.2 协议）

**Files:**
- Create: `docs/superpowers/plans/2026-09-21-m6-ground-cloud-shadows-results.md`（验收记录）

- [ ] **Step 1: 全量测试 + 双包 tsc**

```bash
pnpm test && cd packages/cesium-core && pnpm exec tsc --noEmit && cd ../../packages/cesium-clouds && pnpm exec tsc --noEmit
```
Expected: 全绿。

- [ ] **Step 2: 清缓存起服**

```bash
pkill -f vite; rm -rf apps/demo/node_modules/.vite; pnpm dev
```

- [ ] **Step 3: 逐场景验收**（每场景 `?time=`+`?play=0` 成对钉时间；ego-browser 截图；tilesLoaded 连续保持 5s 后判定）

| # | URL 要点 | 通过判据 |
|---|---|---|
| 1 | 白天高太阳角+贴地平视山体 | 云影投山、PCF 软边、影随云动 |
| 2 | 高空俯瞰 | 云影扫过地形、级联切换无硬缝 |
| 3 | 云影扫海面（低对比） | 无 banding/等值线新 artifact |
| 4 | 夜晚（太阳 <-6°） | 无影（与 main 一致） |
| 5 | `?groundShadow=0` vs 不带 | 像素 maxΔ/超差占比 = 噪声地板（逐位门） |
| 6 | 低太阳角（el<10°） | 影子极软极粗=预期；盯明暗帧间抖动 |
| 7 | 晨昏带 | 无新暮光 artifact（历史泛红域） |
| 8 | 瓦片流送窗口（刷新后立即观察） | 无「影有/无」直线（hasScene 兜底生效） |
| 9 | `debug=11` | 透射率灰度与云形对应；并排 `cloudsDebug=6` 比对无系统性错位 |
| 10 | `?groundShadowStrength=0` vs `?groundShadow=0` | 像素等价（便宜逐位门） |

- [ ] **Step 4: 性能成对测量**（`?fps=1`；同扫描成对、首尾锚点；headless 不可信）

贴地满屏地面 worst case 场景：main（groundShadow=0）vs 开启，记录 p50/p90 帧时与 Δ；`<3ms delta 不可分辨` 纪律下结论如实入 results。

- [ ] **Step 5: results 文档落盘 + commit**

按仓库惯例写 results（交付表/验收现象/已知项/测量数据）；update CLAUDE.md 状态行（M6 已落地）随合并 commit。

---

## Self-Review 记录

- **Spec 覆盖**：§5 契约→T1/T3；§6.1 宏→T4；§6.2 双域+hasScene 兜底→T5；§6.3 级联变体→T4；§6.4 光深→T4；§6.5 PCF→T4；§6.6/§6.7 乘子短路→T5；§7 档位/URL/debug→T2/T6/T5；§8.1 dummy 表→T1；§8.3-8.9→T3/T4/T5 对应实现；§9.1 测试→T1-T5 各 Step；§9.2 验收→T7。无缺口。
- **占位符扫描**：无 TBD/TODO；T5 Step1 的 TS 镜像含一段标注「删除」的占位行——已注明执行时删除，以「真实镜像」段为准。
- **类型一致性**：`CloudsShadowBridgeData` 字段名在 T1（定义）/T3（组装）/T6（消费）一致；uniform 键名 T1/T4 一致；`getGroundShadowBridgeData` T3/T6 一致；`groundCloudShadow` option 名 T1（开关生成）/T4（消费）一致。
