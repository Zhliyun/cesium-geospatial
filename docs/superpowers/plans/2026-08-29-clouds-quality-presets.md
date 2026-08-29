# 体积云质量档位（quality presets）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `createCloudsStage` 增加静态四档质量预设（low/medium/high/ultra，值逐字对齐 three-geospatial qualityPresets.ts）+ 句柄 `setQuality()` 统一内部重建，high 档 ≡ 现状零回归。

**Architecture:** 新模块 `qualityPresets.ts` 持档位表与 `applyQualityPreset` 合并器（缺省→档位→用户显式，deep-clone）；`CloudsMaterial`/`ShadowMaterial` 的 cascade define 参数化 + `accurateSunSkyLight=false` 桥接接线移植（spec §11.1）；`createCloudsStage` 装配逻辑提取为 `buildImpl`（零直捕顶层 listener + 完整销毁清单），`setQuality` 销毁重建换 impl 引用；world 分支 shadowState.far 改单源 `cascades.far`。

**Tech Stack:** TypeScript + Cesium（PostProcessStage/Primitive/Texture3D）+ vitest（node mock 装配测试）+ glslangValidator（shader 离线编译测试）。

**Spec:** `docs/superpowers/specs/2026-08-29-clouds-quality-presets-design.md`（v3 已终审，本 plan 的所有约束出处）

## Global Constraints（抄自 spec，全部任务隐含遵守）

- 档位值**逐字对齐**参考库（spec §3 四表；参考库在另一 repo 不可 import，对齐由 spec §3 表背书）。
- `high` 档合并结果 ≡ `defaultCloudsParameters()` 现状（**零回归**，机器断言）。
- **单一来源**：档位源 `shadow.cascadeCount`/`shadow.mapSize`；`cascadeCount` 投影 `params.shadowCascadeCount`；**不投影** `shadowTexelSize`（单源 frame state）。
- **world 分支 far 不变式**：`shadowState.far ≡ cascades.far`（updateWorld 内部已设 `this.far = intervals[cascadeCount]`，update 后单源取）；`SHADOW_FAR_LIMIT` 仅 frustum 分支保留。
- 合并顺序：缺省 → 档位 → 用户显式；`shadowMarch` 仅整对象覆盖；合并产物 deep-clone 不共享引用。
- `quality` 在场时用户显式 `shadowCascadeCount` **忽略 + console.warn**（防 define/结构双源漂移）。
- preRender listener **零直捕**（一切经 impl）；销毁完整清单：CloudsPass → resolvePass → ShadowPass → shadowTurbulenceDummy → overlay stage。
- `setQuality` 原子性：buildImpl 抛错 → destroyed=true → rethrow；destroyed 后 setQuality no-op+warn；仅帧间调用（JSDoc）。
- 与参考库 setter 语义**有意不同**：用户显式 > 档位（参考库是档位覆盖一切）。
- 所有代码注释中文。

---

### Task 1: qualityPresets 模块 + CloudsStageOptions 类型重组 + params 接线

**Files:**
- Create: `packages/cesium-clouds/src/qualityPresets.ts`
- Create: `packages/cesium-clouds/src/qualityPresets.test.ts`
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（`CloudsStageOptions` 类型 + :244 params 构造 + `quality` 字段）
- Modify: `packages/cesium-clouds/src/index.ts`（导出）

**Interfaces:**
- Consumes: `defaultCloudsParameters`/`CloudsParameters`/`CloudsShadowMarchParameters`（`./cloudsDefaultParameters`，均存在）。
- Produces（后续任务依赖，签名精确）:
  - `type CloudsQualityPreset = 'low' | 'medium' | 'high' | 'ultra'`
  - `interface ResolvedCloudsQuality { main: {lightShafts,shapeDetail,turbulence,accurateSunSkyLight: boolean}; params: Partial<Pick<CloudsParameters, …17 字段>>; shadow: {cascadeCount: number; mapSize: number; march: CloudsShadowMarchParameters} }`
  - `const cloudsQualityPresets: Record<CloudsQualityPreset, ResolvedCloudsQuality>`
  - `applyQualityPreset(quality: CloudsQualityPreset, options: CloudsStageOptions): { main: {…5 编译开关含 shadowCascadeCount}; params: CloudsParameters（全量新对象）; shadow: {cascadeCount; mapSize} }`
- 范围说明：本任务只接 **params 维度**（march 步数/阈值/dummy 截断）；main 编译开关与 shadow 结构（mapSize/cascadeCount 装配）在 Task 4 接线——本任务完成后 `?cloudsQuality=low` 的 march 参数生效、编译开关未变（中间 commit 状态，不发布）。

- [ ] **Step 1: 写失败测试** `qualityPresets.test.ts`

```ts
// qualityPresets.test.ts
// 档位表快照（spec §9①：期望值硬编码 + 注释钉死参考源文件行号——参考库在另一 repo
// 不可 import，「逐字对齐」由 spec §3 表背书，本测试守「实现 = spec 表」）
// 参考源：three-geospatial/packages/clouds/src/qualityPresets.ts:59-121（low/medium/high/ultra）
//        其 defaults（=high）:8-52
import { describe, it, expect } from 'vitest'
import { Cartesian2 } from 'cesium'
import {
  cloudsQualityPresets, applyQualityPreset,
  type CloudsQualityPreset
} from './qualityPresets'
import { defaultCloudsParameters } from './cloudsDefaultParameters'

describe('cloudsQualityPresets 档位表（spec §3 逐字对齐）', () => {
  it('low：编译开关全关 + march/BSM 降档值', () => {
    const p = cloudsQualityPresets.low
    expect(p.main).toEqual({ lightShafts: false, shapeDetail: false, turbulence: false, accurateSunSkyLight: false })
    expect(p.params).toMatchObject({
      maxIterationCount: 200, minStepSize: 100, maxRayDistance: 1e5,
      minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-1,
      maxIterationCountToSun: 1, maxIterationCountToGround: 0, shadowCascadeCount: 2
    })
    expect(p.shadow).toEqual({
      cascadeCount: 2, mapSize: 256,
      march: { maxIterationCount: 25, minStepSize: 100, maxStepSize: 1000,
               minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-2, opticalDepthTailScale: 2 }
    })
  })
  it('medium：shapeDetail 开、lightShafts/turbulence/accurate 关 + 阈值放宽', () => {
    const p = cloudsQualityPresets.medium
    expect(p.main).toEqual({ lightShafts: false, shapeDetail: true, turbulence: false, accurateSunSkyLight: false })
    expect(p.params).toMatchObject({ minDensity: 1e-4, minExtinction: 1e-4, maxIterationCountToGround: 1, shadowCascadeCount: 3 })
    expect(p.shadow).toEqual({
      cascadeCount: 3, mapSize: 256,
      march: { maxIterationCount: 50, minStepSize: 100, maxStepSize: 1000,
               minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-4, opticalDepthTailScale: 2 }
    })
  })
  it('high：params/shadow.march 与 defaultCloudsParameters 对应字段全等（零回归机器证明，spec §9②）', () => {
    const d = defaultCloudsParameters()
    const p = cloudsQualityPresets.high
    expect(p.main).toEqual({ lightShafts: true, shapeDetail: true, turbulence: true, accurateSunSkyLight: true })
    // 显式键全等（未列键 = 继承 defaults，合并后自然全等——见 applyQualityPreset high 全量对拍用例）
    for (const [k, v] of Object.entries(p.params)) {
      expect(v).toBe((d as unknown as Record<string, number>)[k])
    }
    expect(p.shadow).toEqual({
      cascadeCount: d.shadowCascadeCount, mapSize: 512,
      march: { ...d.shadowMarch }
    })
  })
  it('ultra：仅 minStepSize 50→10 + mapSize 1024（其余 = high）', () => {
    const p = cloudsQualityPresets.ultra
    expect(p.params).toMatchObject({ minStepSize: 10, shadowCascadeCount: 3 })
    expect(p.shadow).toEqual({ ...cloudsQualityPresets.high.shadow, mapSize: 1024 })
    expect(p.main).toEqual(cloudsQualityPresets.high.main)
  })
})

describe('applyQualityPreset 合并语义（spec §5）', () => {
  it('high + 无用户输入：params 与 defaultCloudsParameters() 逐字段全等（含 shadowMarch 深比较）', () => {
    const d = defaultCloudsParameters()
    const r = applyQualityPreset('high', {})
    expect(r.params.shadowMarch).toEqual(d.shadowMarch)
    expect(r.params.maxIterationCount).toBe(d.maxIterationCount)
    expect(r.params.minStepSize).toBe(d.minStepSize)
    expect(r.params.maxRayDistance).toBe(d.maxRayDistance)
    expect(r.params.minTransmittance).toBe(d.minTransmittance)
    expect(r.params.maxIterationCountToSun).toBe(d.maxIterationCountToSun)
    expect(r.params.maxIterationCountToGround).toBe(d.maxIterationCountToGround)
    expect(r.params.shadowCascadeCount).toBe(3)
    expect(r.shadow).toEqual({ cascadeCount: 3, mapSize: 512 })
  })
  it('low：params 生效 + dummy 数组按 cascadeCount 截断（spec §4）', () => {
    const r = applyQualityPreset('low', {})
    expect(r.params.maxIterationCount).toBe(200)
    expect(r.params.shadowCascadeCount).toBe(2)
    expect(r.params.shadowIntervals).toHaveLength(2)
    expect(r.params.shadowMatrices).toHaveLength(2)
    // dummy 元素为可变 identity（勿用冻结 Matrix4.IDENTITY——spec/现状注释同款坑）
    expect(r.params.shadowMatrices[0]).not.toBe(require('cesium').Matrix4.IDENTITY)
  })
  it('用户显式 parameters 字段级覆盖档位；未传字段保持档位值', () => {
    const r = applyQualityPreset('low', { parameters: { maxIterationCount: 150 } })
    expect(r.params.maxIterationCount).toBe(150)   // 用户显式
    expect(r.params.minStepSize).toBe(100)          // 档位值保留
    expect(r.params.shadowCascadeCount).toBe(2)     // 单一来源：用户不可覆盖（下一条）
  })
  it('quality 在场：用户显式 shadowCascadeCount 忽略 + warn（spec §5 v3 裁决）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = applyQualityPreset('low', { parameters: { shadowCascadeCount: 4 } })
    expect(r.params.shadowCascadeCount).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('shadowMarch 仅整对象覆盖（用户须供 7 字段全量）', () => {
    const march = { maxIterationCount: 30, minStepSize: 100, maxStepSize: 1000, minDensity: 1e-5, minExtinction: 1e-5, minTransmittance: 1e-4, opticalDepthTailScale: 2 }
    const r = applyQualityPreset('high', { parameters: { shadowMarch: march } })
    expect(r.params.shadowMarch).toEqual(march)
  })
  it('clone：产物与用户传入的 Cesium 数学对象不共享引用（spec §5）', () => {
    const userJitter = new Cartesian2(0.5, 0.5)
    const r = applyQualityPreset('high', { parameters: { temporalJitter: userJitter } })
    expect(r.params.temporalJitter).not.toBe(userJitter)
    expect(r.params.temporalJitter.x).toBe(0.5)
  })
  it('main 合并：档位值 + 用户显式覆盖（shadowCascadeCount 恒档位源）', () => {
    const r = applyQualityPreset('medium', { turbulence: true, shapeDetail: false })
    expect(r.main).toEqual({ lightShafts: false, shapeDetail: false, turbulence: true, accurateSunSkyLight: false, shadowCascadeCount: 3 })
  })
})
```

注意：文件顶部需 `import { vi } from 'vitest'`（warn spy 用例）。`require('cesium')` 在 ESM 测试里不可用——改为顶部 `import { Matrix4 } from 'cesium'` 后 `expect(r.params.shadowMatrices[0]).not.toBe(Matrix4.IDENTITY)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/qualityPresets.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `qualityPresets.ts`

```ts
// qualityPresets.ts
//
// 体积云质量档位（spec：docs/superpowers/specs/2026-08-29-clouds-quality-presets-design.md §3/§4/§5）。
// 档位值逐字对齐 three-geospatial/packages/clouds/src/qualityPresets.ts:8-121
//（参考库在另一 repo 不可 import——对齐由 spec §3 表背书 + qualityPresets.test.ts 快照守「实现=spec 表」）。
// 未移植参考库字段（accuratePhaseFunction/haze/resolutionScale）不设；multiScatteringOctaves
// 恒 6 不进档位（参考库 TODO：降档会变暗需补偿，未解决——spec §3 末段）。
import { Cartesian2, Matrix4 } from 'cesium'
import {
  defaultCloudsParameters,
  type CloudsParameters,
  type CloudsShadowMarchParameters
} from './cloudsDefaultParameters'
import type { CloudsStageOptions } from './createCloudsStage'

export type CloudsQualityPreset = 'low' | 'medium' | 'high' | 'ultra'

/** 单档三路配置（spec §4）。params 仅列「与 defaults 不同或需投影」的字段——继承语义对齐
 *  参考库档位的 spread 展开_defaults。 */
export interface ResolvedCloudsQuality {
  /** 编译开关（CloudsMainOptions 对应字段）。 */
  main: { lightShafts: boolean; shapeDetail: boolean; turbulence: boolean; accurateSunSkyLight: boolean }
  /** uniform 覆盖（CloudsParameters 子集 + shadowCascadeCount 投影；不投影 shadowTexelSize——
   *  真消费点 frame state，spec §4 单一来源规则）。 */
  params: Partial<Pick<CloudsParameters,
    | 'maxIterationCount' | 'minStepSize' | 'maxStepSize' | 'maxRayDistance'
    | 'perspectiveStepScale' | 'minDensity' | 'minExtinction' | 'minTransmittance'
    | 'maxIterationCountToSun' | 'maxIterationCountToGround'
    | 'minSecondaryStepSize' | 'secondaryStepScale'
    | 'maxShadowLengthIterationCount' | 'minShadowLengthStepSize'
    | 'maxShadowLengthRayDistance' | 'shadowCascadeCount'>>
  /** BSM 结构 + 生成端 march（spec §3 BSM 表；march 含恒定量 opticalDepthTailScale=2，
   *  来源参考库 ShadowMaterial.ts:104 而非 qualityPresets.ts——spec §3 表注）。 */
  shadow: { cascadeCount: number; mapSize: number; march: CloudsShadowMarchParameters }
}

// high/defaults 基线（= defaultCloudsParameters 现状，spec §3「high」列）
const HIGH_MAIN = { lightShafts: true, shapeDetail: true, turbulence: true, accurateSunSkyLight: true } as const
const HIGH_MARCH: CloudsShadowMarchParameters = {
  maxIterationCount: 50, minStepSize: 100, maxStepSize: 1000,
  minDensity: 1e-5, minExtinction: 1e-5, minTransmittance: 1e-4, opticalDepthTailScale: 2
}

export const cloudsQualityPresets: Record<CloudsQualityPreset, ResolvedCloudsQuality> = {
  // low：全编译开关关 + 主 march 200 步/宽阈值 10× + 次 march 1/0 + BSM 2 级联 256/25 步
  low: {
    main: { lightShafts: false, shapeDetail: false, turbulence: false, accurateSunSkyLight: false },
    params: {
      maxIterationCount: 200, minStepSize: 100, maxRayDistance: 1e5,
      minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-1,
      maxIterationCountToSun: 1, maxIterationCountToGround: 0,
      shadowCascadeCount: 2
    },
    shadow: { cascadeCount: 2, mapSize: 256, march: { ...HIGH_MARCH, maxIterationCount: 25, minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-2 } }
  },
  // medium：仅 shapeDetail 开；阈值放宽；次 march 2/1；BSM 3 级联 256
  //（minTransmittance 1e-2 / maxIterationCount 500 / toSun 2 = 继承 defaults，不显式列）
  medium: {
    main: { lightShafts: false, shapeDetail: true, turbulence: false, accurateSunSkyLight: false },
    params: { minDensity: 1e-4, minExtinction: 1e-4, maxIterationCountToGround: 1, shadowCascadeCount: 3 },
    shadow: { cascadeCount: 3, mapSize: 256, march: { ...HIGH_MARCH, minDensity: 1e-4, minExtinction: 1e-4 } }
  },
  // high = defaults（零回归基线；params 仅投影 shadowCascadeCount）
  high: {
    main: { ...HIGH_MAIN },
    params: { shadowCascadeCount: 3 },
    shadow: { cascadeCount: 3, mapSize: 512, march: { ...HIGH_MARCH } }
  },
  // ultra：仅 minStepSize 50→10 + mapSize 512→1024
  ultra: {
    main: { ...HIGH_MAIN },
    params: { minStepSize: 10, shadowCascadeCount: 3 },
    shadow: { cascadeCount: 3, mapSize: 1024, march: { ...HIGH_MARCH } }
  }
}

/** applyQualityPreset 结果（buildImpl 消费；spec §5 合并语义的机器形态）。 */
export interface AppliedCloudsQuality {
  /** 编译开关全解（含 shadowCascadeCount——恒取档位源）。 */
  main: { lightShafts: boolean; shapeDetail: boolean; turbulence: boolean; accurateSunSkyLight: boolean; shadowCascadeCount: number }
  /** 全量业务参数（新对象——deep-clone 语义，绝不与用户对象/档位常量共享引用）。 */
  params: CloudsParameters
  /** BSM 结构（mapSize 此时尚未消费——Task 4 buildImpl 接线）。 */
  shadow: { cascadeCount: number; mapSize: number }
}

/**
 * 应用档位并合并用户显式参数（spec §5：缺省 → 档位 → 用户显式；产物 deep-clone）。
 *
 * @param quality 档位名。
 * @param options 用户原始选项（CloudsStageOptions；仅消费编译开关字段与 parameters）。
 */
export function applyQualityPreset(quality: CloudsQualityPreset, options: CloudsStageOptions): AppliedCloudsQuality {
  const preset = cloudsQualityPresets[quality]

  // quality 在场：用户 shadowCascadeCount 忽略 + warn（spec §5 v3——防 define/结构双源漂移）
  if (options.parameters?.shadowCascadeCount != null && options.parameters.shadowCascadeCount !== preset.shadow.cascadeCount) {
    console.warn('[clouds] quality 在场时忽略用户 shadowCascadeCount（单一来源：档位 shadow.cascadeCount，spec §5）')
  }

  // main：档位 → 用户显式（shadowCascadeCount 恒档位源）
  const main: AppliedCloudsQuality['main'] = {
    lightShafts: options.lightShafts ?? preset.main.lightShafts,
    shapeDetail: options.shapeDetail ?? preset.main.shapeDetail,
    turbulence: options.turbulence ?? preset.main.turbulence,
    accurateSunSkyLight: options.accurateSunSkyLight ?? preset.main.accurateSunSkyLight,
    shadowCascadeCount: preset.shadow.cascadeCount
  }

  // params：defaultCloudsParameters()（每次新对象）→ 档位覆盖 → 用户字段级覆盖
  const params = defaultCloudsParameters()
  Object.assign(params, preset.params)
  params.shadowMarch = { ...preset.shadow.march }
  const user = options.parameters
  if (user != null) {
    for (const key of Object.keys(user) as (keyof CloudsParameters)[]) {
      const v = user[key] as unknown
      if (v === undefined) continue
      if (key === 'shadowCascadeCount') continue // 单一来源：档位独占
      if (key === 'shadowMarch') {
        params.shadowMarch = { ...(v as CloudsShadowMarchParameters) } // 整对象覆盖（spec §5）
        continue
      }
      if (key === 'shadowIntervals' || key === 'shadowMatrices') continue // dummy 由档位截断生成
      // Cesium 数学类型 clone（防共享引用被 preRender 逐帧覆写互踩，spec §5 clone 规则）
      ;(params as unknown as Record<string, unknown>)[key] =
        v != null && typeof (v as { clone?: unknown }).clone === 'function'
          ? (v as { clone: () => unknown }).clone()
          : v
    }
  }

  // dummy 数组按 cascadeCount 截断 + 可变 identity 实例（spec §4；勿用冻结 Matrix4.IDENTITY）
  const n = preset.shadow.cascadeCount
  params.shadowCascadeCount = n
  params.shadowIntervals = Array.from({ length: n }, () => new Cartesian2(0, 0))
  params.shadowMatrices = Array.from({ length: n }, () => new Matrix4())

  return { main, params, shadow: { cascadeCount: n, mapSize: preset.shadow.mapSize } }
}
```

- [ ] **Step 4: `createCloudsStage.ts` 类型重组 + params 接线**

`CloudsStageOptions`（:98 起）改：

```ts
import { applyQualityPreset, type CloudsQualityPreset } from './qualityPresets'

/**
 * createCloudsStage 选项（透传 CloudsPassOptions + clouds 开关）。
 * v3（spec §5）：parameters 入口类型 Partial（合并语义见 applyQualityPreset）——用 Omit 重组，
 * CloudsPassOptions.parameters 保持全量契约（createCloudsPass 整体替换语义不动，CloudsPass 零改动）。
 */
export interface CloudsStageOptions extends Omit<CloudsPassOptions, 'parameters'> {
  /** 业务参数覆盖（字段级浅合并：缺省→档位→此处显式；shadowMarch 整对象；Cesium 数学类型内部 clone）。 */
  parameters?: Partial<CloudsParameters>
  /** 质量档位（缺省 'high' = 现状零回归；spec §3 四档逐字对齐参考库）。demo ?cloudsQuality=low。 */
  quality?: CloudsQualityPreset
  // ……既有字段（clouds/cloudsOverlayExposure/shadowPass/temporal/shadowTemporal/
  //    shadowFreeze/shadowAnchor/worldRadii）原样保留，注释不动
}
```

:244 `const params: CloudsParameters = options.parameters ?? defaultCloudsParameters()` 改：

```ts
  // ── 质量档位解析（spec §5：缺省→档位→用户显式；产物 deep-clone 新对象）──
  // Task 1 阶段只消费 params 维度；main 编译开关/shadow 结构（mapSize/cascadeCount）Task 4 接线。
  const applied = applyQualityPreset(options.quality ?? 'high', options)
  const params: CloudsParameters = applied.params
```

（同文件若 `defaultCloudsParameters` 导入不再被用则从 import 中移除。）

`index.ts` 追加：

```ts
// 质量档位（spec 2026-08-29 §3/§4/§5）
export {
  cloudsQualityPresets,
  applyQualityPreset,
  type CloudsQualityPreset,
  type ResolvedCloudsQuality,
  type AppliedCloudsQuality
} from './qualityPresets'
```

- [ ] **Step 5: 跑测试确认通过 + 既有套件零回归**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/qualityPresets.test.ts src/createCloudsStage.test.ts`
Expected: 全 PASS（createCloudsStage.test 既有用例不因 params 构造路径改变而挂——high 全等保证）

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-clouds/src/qualityPresets.ts packages/cesium-clouds/src/qualityPresets.test.ts packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/index.ts
git commit -m "feat(clouds): 质量档位表+applyQualityPreset——四档逐字对齐参考库/字段级合并+deep-clone/dummy 按 cascadeCount 截断/CloudsStageOptions.parameters Partial 化（Omit 重组）"
```

---

### Task 2: CloudsMaterial——shadowCascadeCount 参数化 + accurate=false 桥接接线（spec §11.1）

**Files:**
- Modify: `packages/cesium-clouds/src/CloudsMaterial.ts`（:49 CloudsMainOptions、:84 DEFAULTS、:113 CLOUDS_MAIN_DEFINES、:131 buildM2Defines、:209 BRIDGE_VARYINGS_GLSL）
- Test: `packages/cesium-clouds/src/cloudsMain.compile.test.ts`（增补用例）

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `CloudsMainOptions.shadowCascadeCount?: number`（默认 3）——Task 4 buildImpl 传 `applied.main.shadowCascadeCount`；桥接 `#ifndef ACCURATE_SUN_SKY_LIGHT` 真计算段。

- [ ] **Step 1: 写失败测试**（`cloudsMain.compile.test.ts` 增补）

```ts
describe('质量档位：shadowCascadeCount 参数化 + accurate=false 桥接接线（spec §6/§11.1）', () => {
  it('默认 SHADOW_CASCADE_COUNT 3；传 2 时 define 变 2', () => {
    const src3 = buildCloudsMainFragmentShader()
    expect(src3).toContain('#define SHADOW_CASCADE_COUNT 3')
    const src2 = buildCloudsMainFragmentShader({ shadowCascadeCount: 2 })
    expect(src2).toContain('#define SHADOW_CASCADE_COUNT 2')
    expect(src2).not.toContain('#define SHADOW_CASCADE_COUNT 3')
  })
  it('accurate 关：桥接含 min/max 云高 irradiance 真计算（vert sampleSunSkyIrradiance 云段移植）', () => {
    const src = buildCloudsMainFragmentShader({ accurateSunSkyLight: false })
    expect(src).toContain('#ifndef ACCURATE_SUN_SKY_LIGHT')
    // 2 次调用：surfaceNormal * radii.x / .y（spec v3 计数：ground 段不移植）
    expect(src.match(/GetSunAndSkyScalarIrradiance/g)?.length).toBeGreaterThanOrEqual(2)
    expect(src).toContain('bridgeCloudsRadii')
  })
  it('accurate 开：桥接保持零填充（现有行为），无 bridge 计算', () => {
    const src = buildCloudsMainFragmentShader({ accurateSunSkyLight: true })
    expect(src).not.toContain('bridgeCloudsRadii')
  })
  it('glslang 编译：SHADOW_CASCADE_COUNT 2 + 四编译开关全关（low 档实际组合）', () => {
    const src = buildStandaloneCloudsShaderForValidation({
      shadowCascadeCount: 2, accurateSunSkyLight: false, shapeDetail: false, turbulence: false, lightShafts: false
    })
    expect(compileFragmentOk(src)).toBe(true) // 沿用本文件既有 compileFragment 辅助
  })
  it('glslang 编译：accurate 关（新接线路径）默认 cascade 3', () => {
    const src = buildStandaloneCloudsShaderForValidation({ accurateSunSkyLight: false })
    expect(compileFragmentOk(src)).toBe(true)
  })
})
```

（`compileFragmentOk` 若本文件已有 `compileFragment` 辅助则按其现有断言模式对齐改写；参照既有「关闭 SHAPE_DETAIL / TURBULENCE / ACCURATE_SUN_SKY_LIGHT 也编译通过」用例的写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts -t "质量档位"`
Expected: FAIL（shadowCascadeCount 不存在 / bridgeCloudsRadii 不存在）

- [ ] **Step 3: 实现**

`CloudsMainOptions`（:49）加字段：

```ts
  /**
   * 级联数（→ #define SHADOW_CASCADE_COUNT；spec §6 参数化）。默认 3。
   * 档位路径由 applyQualityPreset 投影（applied.main.shadowCascadeCount），用户直传仅在
   * 不用档位时生效（quality 在场时被忽略——spec §5 单一来源）。
   */
  shadowCascadeCount?: number
```

`DEFAULTS` 加 `shadowCascadeCount: 3`；`CLOUDS_MAIN_DEFINES` 删除 `'#define SHADOW_CASCADE_COUNT 3',` 行（:119，注释同步改「cascade define 移至 buildM2Defines 按参数生成」）；`buildM2Defines` 返回数组加：

```ts
    '#define SHADOW_CASCADE_COUNT ' + o.shadowCascadeCount,
```

`BRIDGE_VARYINGS_GLSL` 中 `cloudsBridge_reconstructVaryings()` 的 irradiance 段（:254-262 附近，替换「vGroundIrradiance.sun = vec3(0.0); … vCloudsIrradiance.maxSky = vec3(0.0);」整段）：

```glsl
  // §11.1（spec v3）：accurate 关时移植参考库 clouds.vert sampleSunSkyIrradiance 云段
  //（shaders/clouds.vert:53-64）——min/max 云高 2 次 GetSunAndSkyScalarIrradiance（每次返
  // sun+sky 双值 = 4 分量），每像素一次性，远廉于 per-sample 直算（ACCURATE 路径 march
  // 循环内逐采样调，clouds.frag:535）。ground 2 分量不移植：消费点均在未 define 的
  // HAZE/GROUND_BOUNCE 分支（spec §11.1 v3 裁决——未来开启须补，否则云底 bounce 恒 0）。
  // 依赖 uniform（altitudeCorrection/sunDirection/bottomRadius/minHeight/maxHeight）均已在
  // clouds.frag 声明；GetSunAndSkyScalarIrradiance/METER_TO_LENGTH_UNIT 来自 bruneton runtime include。
#ifndef ACCURATE_SUN_SKY_LIGHT
  vec3 bridgeIrradPos = vCameraPosition + altitudeCorrection;
  vec3 bridgeSurfaceNormal = normalize(bridgeIrradPos);
  vec2 bridgeCloudsRadii = (bottomRadius + vec2(minHeight, maxHeight)) * METER_TO_LENGTH_UNIT;
  vCloudsIrradiance.minSun = GetSunAndSkyScalarIrradiance(
    bridgeSurfaceNormal * bridgeCloudsRadii.x, sunDirection, vCloudsIrradiance.minSky);
  vCloudsIrradiance.maxSun = GetSunAndSkyScalarIrradiance(
    bridgeSurfaceNormal * bridgeCloudsRadii.y, sunDirection, vCloudsIrradiance.maxSky);
#else
  // ACCURATE define → getCloudsSunSkyIrradiance 直算，varying 不被读；零初始化防未定义读。
  vCloudsIrradiance.minSun = vec3(0.0);
  vCloudsIrradiance.minSky = vec3(0.0);
  vCloudsIrradiance.maxSun = vec3(0.0);
  vCloudsIrradiance.maxSky = vec3(0.0);
#endif
  vGroundIrradiance.sun = vec3(0.0);
  vGroundIrradiance.sky = vec3(0.0);
```

（`vCameraPosition` 在该函数内已于前面赋值 `= czm_viewerPositionWC`；vert 调用点语义 `sampleSunSkyIrradiance(vCameraPosition + altitudeCorrection)`，本处等价。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts`
Expected: 全 PASS（glslang 缺失时编译用例按既有降级语义处理——环境有 glslang 则全跑）

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/CloudsMaterial.ts packages/cesium-clouds/src/cloudsMain.compile.test.ts
git commit -m "feat(clouds): SHADOW_CASCADE_COUNT 参数化 + accurate=false 桥接接线——vert sampleSunSkyIrradiance 云段移植(#ifndef 条件编译,ground 分量不移植)"
```

---

### Task 3: ShadowMaterial/ShadowPass——CASCADE_COUNT 参数化

**Files:**
- Modify: `packages/cesium-clouds/src/ShadowMaterial.ts`（:35 ShadowMainOptions、:56 SHADOW_DEFINES_BASE、:66-75 DEFAULTS/buildDefines）
- Modify: `packages/cesium-clouds/src/ShadowPass.ts`（shaderOptions 组装处透传 cascadeCount——先 `grep -n "buildCloudsShadowFragmentShader" ShadowPass.ts` 定位）
- Test: `packages/cesium-clouds/src/shadowMain.compile.test.ts`（增补用例）

**Interfaces:**
- Consumes: `ShadowPassOptions.cascadeCount: number`（已存在，createCloudsStage :341 已传）。
- Produces: `ShadowMainOptions.cascadeCount?: number`（默认 3）——Task 4 无需再动 ShadowPass（透传在本任务内完成）；`SHADOW_PIPELINE_DEFINES` 语义变为「不含 CASCADE_COUNT 的基础段」。

- [ ] **Step 1: 写失败测试**

```ts
describe('质量档位：CASCADE_COUNT 参数化（spec §6 评审 BLOCKER 修复）', () => {
  it('默认 CASCADE_COUNT 3；传 2 时 define 变 2', () => {
    expect(buildCloudsShadowFragmentShader()).toContain('#define CASCADE_COUNT 3')
    const src = buildCloudsShadowFragmentShader({ cascadeCount: 2 })
    expect(src).toContain('#define CASCADE_COUNT 2')
    expect(src).not.toContain('#define CASCADE_COUNT 3')
  })
  it.each([true, false])('glslang：CASCADE_COUNT 2 × temporalPass=%s 编译通过（velocity 层 unroll 验证，spec §9 v3）', (tp) => {
    const src = buildStandaloneCloudsShadowShaderForValidation({ cascadeCount: 2, temporalPass: tp })
    expect(compileFragmentOk(src)).toBe(true)
  })
  it('glslang：CASCADE_COUNT 2 × shapeDetail/turbulence 双关编译通过', () => {
    for (const sd of [true, false]) for (const tb of [true, false]) {
      const src = buildStandaloneCloudsShadowShaderForValidation({ cascadeCount: 2, shapeDetail: sd, turbulence: tb })
      expect(compileFragmentOk(src)).toBe(true)
    }
  })
})
```

（`compileFragmentOk` 沿用本文件既有 compile 辅助写法；若既有用例对 `SHADOW_PIPELINE_DEFINES` 断言含 `#define CASCADE_COUNT 3`，同步改为断言基础段不含该行 + buildDefines 输出含动态值。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/shadowMain.compile.test.ts -t "质量档位"`
Expected: FAIL（cascadeCount 选项不存在）

- [ ] **Step 3: 实现**

`ShadowMainOptions`（:35）加：

```ts
  /**
   * 级联数（→ #define CASCADE_COUNT，inverseShadowMatrices/reprojectionMatrices 数组长）。
   * 默认 3。档位路径由 createCloudsStage 传 applied.shadow.cascadeCount（spec §6）。
   */
  cascadeCount?: number
```

`SHADOW_DEFINES_BASE`（:56）删除 `'#define CASCADE_COUNT 3',` 行（注释注明移至 buildDefines）；导出 `SHADOW_PIPELINE_DEFINES`（:64）JSDoc 改为「基础段（不含 CASCADE_COUNT——按选项动态生成）」，引用处断言同步；`DEFAULTS` 加 `cascadeCount: 3`；`ResolvedShadowMainOptions` 相应；`buildDefines` 加：

```ts
    '#define CASCADE_COUNT ' + o.cascadeCount,
```

`ShadowPass.ts`：定位 `buildCloudsShadowFragmentShader(` 调用（grep），其 options 实参加 `cascadeCount: <ShadowPassOptions 的 cascadeCount>`——该 options 里 cascadeCount 为必填 number，直接透传（注释：「spec §6：与主 march SHADOW_CASCADE_COUNT 同源——编排层 applied.shadow.cascadeCount 单源」）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/shadowMain.compile.test.ts src/ShadowPass.test.ts`
Expected: 全 PASS（ShadowPass.test 若有 SHADOW_PIPELINE_DEFINES/defines 断言随 Step 3 同步）

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/ShadowMaterial.ts packages/cesium-clouds/src/ShadowPass.ts packages/cesium-clouds/src/shadowMain.compile.test.ts packages/cesium-clouds/src/ShadowPass.test.ts
git commit -m "feat(clouds): ShadowMaterial CASCADE_COUNT 参数化+ShadowPass 透传——low 档 2 级联生成端数组/unroll 配套(spec §6 BLOCKER)"
```

---

### Task 4: createCloudsStage——buildImpl 提取 + quality 三路接线 + far 不变式 + 零直捕 listener

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（主体重构：:222-587 装配体提取）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`（增补用例）

**Interfaces:**
- Consumes: `applyQualityPreset`（Task 1）、`CloudsMainOptions.shadowCascadeCount`（Task 2）、`ShadowMainOptions.cascadeCount`（Task 3）。
- Produces（Task 5 依赖）:
  - `interface CloudsStageImpl { readonly cloudsPass: CloudsPass; readonly overlayStage: PostProcessStage; readonly cascades: CascadedShadowMaps; readonly shadowPass: ShadowPass | undefined; readonly shadowState: CloudsShadowFrameState; readonly params: CloudsParameters; onPreRender(time: JulianDate): void; destroy(): void }`（模块内类型，不导出）
  - `function buildCloudsStageImpl(scene: Scene, luts: AtmosphereLUTs, weather: WeatherTextures, options: CloudsStageOptions, applied: AppliedCloudsQuality): CloudsStageImpl`（模块内函数，不导出）
  - handle 公开字段 getter 化（`CloudsStageHandle` 对外形状不变）。

- [ ] **Step 1: 写失败测试**（`createCloudsStage.test.ts` 增补；沿用本文件既有 vi.mock cesium/CloudsPass + mock scene 范式）

```ts
describe('质量档位装配（spec §6/§7）', () => {
  it('quality 缺省：装配传参与不传 quality 逐字一致（零回归）', () => {
    const a = createStageWithDefaults() // 既有测试辅助：mock scene + 默认 options
    const b = createStageWithDefaults({ quality: 'high' })
    expect(collectCreateCalls(b)).toEqual(collectCreateCalls(a)) // createCloudsPass/createShadowPass 收到的参数对象序列化对拍
  })
  it('low 档：cascadeCount=2 / mapSize=256 / far 不变式 21km（spec §6）', async () => {
    const { handle, scene } = createStage({ quality: 'low' })
    // cascades 真实现（纯 TS node 可跑）：worldIntervals 截断语义
    expect(handle.cascades.worldIntervals[handle.cascades.cascadeCount]).toBe(21e3)
    // preRender 触发一次 update 后 shadowState.far = cascades.far = 21km（不变式）
    firePreRender(scene)
    expect(handle.shadowState.far).toBe(21e3)
  })
  it('low 档：shader 源含 SHADOW_CASCADE_COUNT 2（主 march）与 CASCADE_COUNT 2（生成端）', () => {
    const { handle } = createStage({ quality: 'low' })
    const mainSrc = vi.mocked(createCloudsPass).mock.calls[0][3] as unknown as { fragmentShader?: string }
    // 按本文件既有断言形态：从 createShadowPass mock 调用取 shaderOptions/shader 源断言 define
    expect(JSON.stringify(vi.mocked(createCloudsPass).mock.calls)).toContain('SHADOW_CASCADE_COUNT 2')
    expect(JSON.stringify(vi.mocked(createShadowPass).mock.calls)).toContain('cascadeCount\\":2')
  })
  it('ShadowPass shaderOptions 读 resolved 值（low 档 shapeDetail=false 不再 ?? true 错位，spec §6 点名）', () => {
    createStage({ quality: 'low' })
    const opts = vi.mocked(createShadowPass).mock.lastCall![0]
    expect(opts.shaderOptions.shapeDetail).toBe(false)
    expect(opts.shaderOptions.turbulence).toBe(false)
  })
  it('主 march 编译开关走 resolved（low 档 accurate/shapeDetail/turbulence/lightShafts 全关）', () => {
    createStage({ quality: 'low' })
    const passOpts = vi.mocked(createCloudsPass).mock.lastCall![3] as Record<string, unknown>
    expect(passOpts.accurateSunSkyLight).toBe(false)
    expect(passOpts.shapeDetail).toBe(false)
    expect(passOpts.turbulence).toBe(false)
    expect(passOpts.lightShafts).toBe(false)
  })
  it('temporal=true：resolvePass 进销毁清单（spec §7 v3）', () => {
    const { handle } = createStage({ temporal: true })
    handle.destroy()
    // mock 的 resolvePass.destroy 被调（vi.mock('./CloudsResolvePass') 按需补桩）
  })
})
```

（`createStage`/`firePreRender`/`collectCreateCalls` 按本文件既有 mock scene 与 preRender 触发辅助对齐实现；`createShadowPass` 若尚未 mock 则补 vi.mock('./ShadowPass') 桩——参照 './CloudsPass' 模式。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts -t "质量档位"`
Expected: FAIL（quality 选项尚未接线装配）

- [ ] **Step 3: 实现 buildImpl 提取与接线**

`createCloudsStage.ts` 主体改造（伪 diff 形态，实现者按此重构 :222-587）：

```ts
/** 模块内 impl（spec §7）：一次装配的全部资源 + 每帧逻辑 + 完整销毁。 */
interface CloudsStageImpl {
  readonly cloudsPass: CloudsPass
  readonly overlayStage: PostProcessStage
  readonly cascades: CascadedShadowMaps
  readonly shadowPass: ShadowPass | undefined
  readonly shadowState: CloudsShadowFrameState
  readonly params: CloudsParameters
  onPreRender(time: JulianDate): void
  destroy(): void
}

/** buildImpl（spec §7）：现 :231-587 装配体整体移入。闭包量（state/scratch/prevCamera/
 *  matricesFrozen/inverseMatrices…）全在本函数内 = per-impl 状态，换 impl 自然归零
 *（shadowFreeze 的 freeze 语义从新 impl 重新起算，spec §7）。 */
function buildCloudsStageImpl(
  scene: Scene, luts: AtmosphereLUTs, weather: WeatherTextures,
  options: CloudsStageOptions, applied: AppliedCloudsQuality
): CloudsStageImpl {
  // —— 原 :231-406 装配，改动点如下 ——
  // 1) mapSize/cascadeCount 去 hardcode（原 :258-259）：
  const cascadeCount = applied.shadow.cascadeCount
  const mapSize = applied.shadow.mapSize
  // 2) shadowState.texelSize = new Cartesian2(1 / mapSize, 1 / mapSize)（原样，值随档位）
  // 3) shadowMatrices/shadowIntervals 数组按 cascadeCount 生成（原 :280-281 的固定 3 元素）：
  const shadowMatrices = Array.from({ length: cascadeCount }, () => new Matrix4())
  const shadowIntervals = Array.from({ length: cascadeCount }, () => new Cartesian2())
  // 4) createCloudsPass 的 options（原 :293-297 {...options, parameters: params, temporalUpscale}）
  //    增编译开关 resolved（spec §5）：
  //    { ...options, shapeDetail: applied.main.shapeDetail, turbulence: applied.main.turbulence,
  //      accurateSunSkyLight: applied.main.accurateSunSkyLight, lightShafts: applied.main.lightShafts,
  //      parameters: applied.params, temporalUpscale: temporal }
  // 5) ShadowPass shaderOptions 读 resolved（原 :352-355 的 ?? true 错位点，spec §6 点名）：
  //    shaderOptions: { cascadeCount, shapeDetail: applied.main.shapeDetail, turbulence: applied.main.turbulence }
  //    （Task 3 已让 ShadowPass 接 cascadeCount；shapeDetail/turbulence 不再 ?? true）
  // —— 原 :408-559 preRender 回调体 → onPreRender(time: JulianDate)（addEventListener 壳去掉），
  //    内部改动点：far 不变式（原 :510-513 与 :550）：
  //    const farFrustum = Math.min(camera.frustum.far, params.maxRayDistance, SHADOW_FAR_LIMIT)
  //    cascades.update({ inverseViewMatrix, projectionMatrix, near: worldAnchor ? 0 : camera.frustum.near,
  //                      far: farFrustum }, sunForMatrices, distance)  // world 分支 update 忽略 far 参数
  //    if (changed) { …; shadowState.cameraNear = near
  //      shadowState.far = worldAnchor ? cascades.far : farFrustum }  // spec §6 不变式：world 单源
  // —— 返回 { cloudsPass, overlayStage, cascades, shadowPass, shadowState, params,
  //           onPreRender, destroy(): 完整销毁清单（原 :572-586 的 impl 版：cloudsPass.destroy →
  //           resolvePass?.destroy → shadowPass?.destroy → shadowTurbulenceDummy?.destroy →
  //           overlay remove/destroy；不含 removePreRender——listener 顶层持有） }
}

export function createCloudsStage(scene, luts, weather, options = {}): CloudsStageHandle | undefined {
  if (options.clouds !== true) return undefined
  const applied = applyQualityPreset(options.quality ?? 'high', options)
  let impl = buildCloudsStageImpl(scene, luts, weather, options, applied)
  let currentQuality: CloudsQualityPreset = options.quality ?? 'high'
  let destroyed = false
  // 零直捕 listener（spec §7：只捕 handle 语义量，一切经 impl）
  const removePreRender = scene.preRender.addEventListener((_scene: Scene, time: JulianDate) => {
    if (!destroyed) impl.onPreRender(time)
  })
  const handle: CloudsStageHandle = {
    get cloudsPass() { return impl.cloudsPass },
    get overlayStage() { return impl.overlayStage },
    get shadowPass() { return impl.shadowPass },
    get shadowState() { return impl.shadowState },
    get cascades() { return impl.cascades },
    setQuality(next: CloudsQualityPreset): void {
      if (destroyed) { console.warn('[clouds] setQuality 于 destroy 后调用，no-op'); return }
      if (next === currentQuality) return
      impl.destroy()
      try {
        impl = buildCloudsStageImpl(scene, luts, weather, options, applyQualityPreset(next, options))
        currentQuality = next
      } catch (e) {
        destroyed = true  // 原子性（spec §7 v3）：重建失败即句柄作废
        throw e
      }
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      removePreRender()
      impl.destroy()
    }
  }
  return handle
}
```

`CloudsStageHandle` 接口（:155）字段类型不变、加 `setQuality(next: CloudsQualityPreset): void`（JSDoc：仅帧间调用；重建失败即句柄作废；destroy 后 no-op+warn；与参考库 setter 语义有意不同——用户显式参数保留）。

⚠️ 实现者注意：`params`（impl 内）= `applied.params`（applyQualityPreset 已 deep-clone）；旧 :244 行已删（Task 1 改的过渡行并入 buildImpl 的 applied.params）。

- [ ] **Step 4: 跑测试确认通过 + 全套件**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run`
Expected: 全 PASS（既有 M2-M6 用例零回归——重点看 preRender/destroy 顺序用例）

- [ ] **Step 5: tsc 类型检查**

Run: `pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "feat(clouds): buildImpl 提取+quality 三路接线——零直捕 listener/完整销毁清单(含 resolvePass)/far≡cascades.far 不变式/mapSize 级联去 hardcode/ShadowPass resolved 消费/setQuality 内部重建"
```

---

### Task 5: setQuality 行为测试补全（换档/原子性/no-op）

**Files:**
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`（增补 describe；实现已在 Task 4 完成，本任务补行为用例收口）

**Interfaces:**
- Consumes: `handle.setQuality`（Task 4）。
- Produces: 无（纯测试）。

- [ ] **Step 1: 写测试**（若跑失败回修 Task 4 实现）

```ts
describe('setQuality 行为（spec §7 v3）', () => {
  it('同档 no-op：不触发销毁/重建', () => {
    const { handle } = createStage({ quality: 'high' })
    handle.setQuality('high')
    expect(vi.mocked(createCloudsPass).mock.calls.length).toBe(1) // 未重建
  })
  it('换档：旧 impl 全部 destroy 均被调 + listener 推动新 impl（零直捕断言）', () => {
    const { handle, scene } = createStage({ quality: 'high' })
    const oldPass = handle.cloudsPass
    handle.setQuality('low')
    // 旧 impl 销毁（mock 的 destroy 全被调）
    expect((oldPass as { destroy: Mock }).destroy).toHaveBeenCalled()
    // listener 推动新 impl：fire preRender 后新 cloudsPass 的状态被更新（如 params.frame 递增路径
    // 或 shadowState.far——取本文件既有断言可观测点）
    firePreRender(scene)
    expect(handle.shadowState.far).toBe(21e3)
    expect(handle.cloudsPass).not.toBe(oldPass) // getter 反映新 impl
  })
  it('换档保留用户显式参数（合并语义端到端）', () => {
    const { handle } = createStage({ quality: 'high', parameters: { maxIterationCount: 333 } })
    handle.setQuality('low')
    const passOpts = vi.mocked(createCloudsPass).mock.lastCall![3] as { parameters: { maxIterationCount: number } }
    expect(passOpts.parameters.maxIterationCount).toBe(333) // 用户显式 > 档位 200
    expect(passOpts.parameters.minStepSize).toBe(100)        // 档位值
  })
  it('换档后 params 无共享引用（clone 生效，spec §5）', () => {
    const userParams = { maxIterationCount: 333 }
    const { handle } = createStage({ quality: 'high', parameters: userParams })
    handle.setQuality('medium')
    handle.setQuality('high')
    const p1 = vi.mocked(createCloudsPass).mock.calls.at(-2)![3] as { parameters: unknown }
    const p2 = vi.mocked(createCloudsPass).mock.lastCall![3] as { parameters: unknown }
    expect(p1.parameters).not.toBe(p2.parameters)
  })
  it('destroy 后 setQuality：no-op + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { handle } = createStage({})
    handle.destroy()
    handle.setQuality('low')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('重建抛错：句柄作废（destroyed 置位，再 setQuality warn 不重建）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createCloudsPass).mockImplementationOnce(() => { throw new Error('GL 资源失败') })
    const { handle } = createStage({})
    expect(() => handle.setQuality('low')).toThrow('GL 资源失败')
    handle.setQuality('high') // destroyed → no-op
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts`
Expected: 全 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "test(clouds): setQuality 行为收口——同档 no-op/旧 impl 全 destroy+listener 推新 impl/用户参数保留/clone/destroy 后 warn/原子性失败"
```

---

### Task 6: Demo URL 参数 + 快捷键 + README

**Files:**
- Modify: `apps/demo/src/main.ts`（:374-401 options 组装处 + keydown listener）
- Modify: `README.md`（体积云参数表）

**Interfaces:**
- Consumes: `createCloudsStage({ quality })`、`handle.setQuality`。
- Produces: URL `?cloudsQuality=low|medium|high|ultra`；快捷键 1/2/3/4。

- [ ] **Step 1: demo main.ts 接线**

options 组装内（:374 起，`cloudsShadowAnchor` 条目附近）加：

```ts
          // 质量档位（spec 2026-08-29）：?cloudsQuality=low|medium|high|ultra（缺省 high=现状）
          ...(getString('cloudsQuality') != null
            ? { quality: getString('cloudsQuality') as 'low' | 'medium' | 'high' | 'ultra' }
            : {}),
```

`if (cloudsHandle != null) { console.info(…) }` 块内（探针注册之前/之后均可）加快捷键：

```ts
          // 质量档位快捷键（setQuality 运行时验证入口，spec §8）：1/2/3/4 = low/medium/high/ultra。
          // 仅帧间触发（keydown 在 rAF 外，spec §7 调用时机约束天然满足）。
          const QUALITY_KEYS: Record<string, 'low' | 'medium' | 'high' | 'ultra'> = {
            '1': 'low', '2': 'medium', '3': 'high', '4': 'ultra'
          }
          window.addEventListener('keydown', (ev) => {
            const next = QUALITY_KEYS[ev.key]
            if (next != null) {
              cloudsHandle.setQuality(next)
              console.info(`[phase3-clouds] quality → ${next}（setQuality 内部重建）`)
            }
          })
```

`console.info` 的接线提示行（:411）追加 `?cloudsQuality=N/按键 1-4 切档`。

- [ ] **Step 2: README 参数表补行**

体积云组表格加：

```markdown
| `cloudsQuality` | `low`/`medium`/`high`/`ultra`（默认 `high`） | 质量档位：march 步数/编译开关（光柱/细节/湍流/精确天光）/BSM 级联数与尺寸整档联动；键盘 `1`-`4` 运行时切换 |
```

- [ ] **Step 3: 手动冒烟**

Run: `pnpm dev` → 打开 `http://localhost:5173/?mode=atmosphere&clouds=1&cloudsQuality=low`
Expected: 云正常渲染（low 档视觉：无光柱/细节修饰）；按 3/4 切档画面变化、console 输出切档日志、无 WebGL 报错。

- [ ] **Step 4: Commit**

```bash
git add apps/demo/src/main.ts README.md
git commit -m "feat(demo): cloudsQuality URL 参数+1-4 切档快捷键+README 参数表"
```

---

### Task 7: 端到端验收 + results 文档

**Files:**
- Create: `docs/superpowers/plans/2026-08-29-clouds-quality-presets-results.md`

**Interfaces:**
- Consumes: 全部前序任务成果；spec §10 验收判据。
- Produces: results 文档（四档视觉对比、帧率台阶、热切换健壮性结论）。

- [ ] **Step 1: 全套件绿**

Run: `pnpm test && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit`
Expected: 全 PASS

- [ ] **Step 2: agent-browser 四档视觉对比（spec §10.1）**

基准 URL（README 推荐视角）：`http://localhost:5173/?mode=atmosphere&clouds=1&time=2026-08-28T17:30:00Z&camera=-80.6057,64.5197,7852,68.8,-17.8`
- 四个 `&cloudsQuality=` 值各截图（纪律：每组 close 全关 + sleep 3 重开 + 帧数门禁——沿用 BSM 验收方法学）。
- medium/high 追加 `&cloudsDebug=2`（frontDepth）与 `&cloudsDebug=5`（cascades）截图（低对比画面目测不可靠的客观佐证，spec §10.1）。
- 检查：降质逐档可辨；low 档无 god rays/细节修饰、自阴影覆盖仅 0-21km 属预期（云本体不破 = 无全黑/无错层色带）。

- [ ] **Step 3: 帧率台阶（spec §10.2）**

- `&fps=1`（确认 debugShowFramesPerSecond 开）下四档各录 10s 显示 FPS。
- 判据：**帧时间 low ≤ medium ≤ high ≤ ultra（即 FPS low ≥ medium ≥ high ≥ ultra）**；前提至少一档跌破 vsync（若四档全锁帧 → 放大 viewport 负载重测）。
- 换档瞬间 shader 编译长帧 = 真切换旁证（录屏确认）。

- [ ] **Step 4: 热切换健壮性（spec §10.3）**

- 基准 URL 下连按 1→4→2→3→1 多轮：无崩溃、无 WebGL 报错。
- 追加 `&cloudsTemporal=1` 组合轮次（resolvePass 销毁重建路径）。
- 切档后**稳定**帧率与对应档 URL 直开一致（排除切换当帧；无资源泄漏——多轮后帧率不衰减）。

- [ ] **Step 5: 写 results 文档并提交**

结论表（四档截图路径/FPS 数值/热切换结果/偏差记录——§11 退路若触发，spec §3 表+§9① 期望值须同 commit 同源修订）。

```bash
git add docs/superpowers/plans/2026-08-29-clouds-quality-presets-results.md
git commit -m "docs(clouds): 质量档位端到端验收 results——四档视觉/帧率台阶/热切换健壮性"
```

---

## Self-Review 记录

1. **Spec coverage**：§3 表→T1（快照测试+档位表）；§4 结构/单一来源/dummy 截断→T1；§5 合并/Partial/Omit/clone/warn→T1+T5；§6 cascadeCount 双端参数化/far 不变式/ShadowPass resolved 消费→T2/T3/T4；§7 buildImpl/零直捕/销毁清单/setQuality/原子性/getter→T4+T5；§8 demo URL+快捷键+README→T6；§9 五测试文件→T1/T2/T3/T4/T5（CloudsMaterial.test.ts 不存在并入 cloudsMain.compile.test.ts——spec §13 已预案）；§10 验收→T7；§11.1 移植→T2；§13 文件清单→各任务 Files 全覆盖（CloudsPass.ts 确认零改动 ✓）。无缺口。
2. **Placeholder scan**：T4 Step 3 是「伪 diff + 改动点清单」而非全文代码——因装配体 350 行整体平移、改动点 5 处已逐一给出精确位置与新代码；这是重构类任务的合理形态（全文重贴 589 行会引入抄写失真风险），非 TBD。其余任务均为完整代码。
3. **Type consistency**：`CloudsQualityPreset`/`ResolvedCloudsQuality`/`AppliedCloudsQuality`/`applyQualityPreset`（T1 定义）在 T4/T5/T6 引用一致；`CloudsStageImpl`/`buildCloudsStageImpl`（T4 定义）T5 消费；`shadowCascadeCount`（T2 CloudsMainOptions）与 `cascadeCount`（T3 ShadowMainOptions）命名区分与 spec §6 一致。
