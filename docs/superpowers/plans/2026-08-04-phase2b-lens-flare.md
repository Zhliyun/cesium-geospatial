# Phase2b image-based LensFlare 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 实现，task-by-task。Steps 用 checkbox（`- [ ]`）跟踪。
> **前置 spec**：`docs/superpowers/specs/2026-08-04-phase2b-lens-flare-design.md`（v2，三方评审修订）。本 plan 引用 spec §5 的 shader math（source of truth），不重复抄。

**Goal:** 在 `atmosphere → tonomap` 线性 HDR 域插入 image-based LensFlare Composite（threshold + preBlur + bloom CoD:AW/9-tap pyramid + 9 ghosts/halo/色散 + occlusion + composite），忠实移植 three-geospatial WebGL `LensFlareEffect` + 写实 occlusion。硬指标：phase1 五项零回归 + 水波纹专项。

**Architecture:** `lf_bloom` series composite（threshold get0 + 6 down + 5 up）+ `lf_preBlur` + `lf_occlusion`（降分 1/16）+ `lf_features` + `lf_composite`，外层 non-series `lensflare` composite，插 atmosphere→tonomap。全程 HalfFloat 线性，链尾 tonomap ACES 收尾。sampleMode：composite 主 colorTexture NEAREST 保 dithering；bloom down/up LINEAR 靠 series 链传播；up[i] 必须 uniform-name string 引用 down[对应级]（避同 scale framebuffer 共享）。

**Tech Stack:** TypeScript / WebGL2 / GLSL ES 3.00 / Cesium PostProcessStage + Composite（@cesium/engine 26.1.0）/ vitest / glslangValidator。

---

## 文件结构映射（spec §4）

新建 `packages/cesium-core/src/cesium/lensFlare/` 子目录：
- `lensFlareConstants.ts` — 常量表（NUM_BLOOM_LEVELS / 9 ghost offset+tint / halo params / 色散 / depth epsilon / kernel 权重）
- `threshold.frag.ts` — learnopengl 13-tap 加权软阈值
- `bloomDownsample.frag.ts` — CoD:AW 13-tap downsample
- `bloomUpsample.frag.ts` — 9-tap + mix(radius=0.85)
- `preBlur.frag.ts` — Kawase/小高斯软化
- `features.frag.ts` — 9 ghosts + halo + 色散（采 preBlur）
- `occlusion.ts` — 纯函数（computeSunScreenUV / rayEllipsoidIntersect / generateSampleGrid36）
- `occlusion.frag.ts` — sun 投影 + ray-ellipsoid + depth 36 点覆盖率
- `composite.frag.ts` — atmosphere + (bloom+features)*intensity
- `createLensFlareStage.ts` — 组装 lf_bloom series + 4 兄弟 stage + 外层 non-series
- 各 `.test.ts` + `lensFlare.compile.test.ts`（统一 glslang）

改：
- `cesium/AtmosphereStage.ts` — 插 lensflare + handle + enabled 开关
- `apps/demo/src/main.ts` — URL 参数 + debug 探针

**GLSL 组装模式**（对齐 `tonemap.frag.ts`）：`UNIFORMS_GLSL` + `HELPERS_GLSL` + `MAIN_GLSL` + `buildXxxFragmentShader(opts)` + `buildStandaloneShaderForValidation()`（补 `#version 300 es` + precision + `out_FragColor` 桩 + `luminance/saturate` `#define` + 用到的 `czm_*`/`colorTexture`/`depthTexture` 桩）+ `XXX_UNIFORM_NAMES`。

**通用 prefix（所有 lensflare shader 的 standalone validation 共享）**：补 `#define luminance(c) dot(c, vec3(0.2126,0.7152,0.0722))` + `#define saturate(x) clamp(x,0.0,1.0)`（Cesium 无 `<common>`，spec §5/Minor）。

---

## Task 1: lensFlareConstants.ts（常量表）

**Files:**
- Create: `packages/cesium-core/src/cesium/lensFlare/lensFlareConstants.ts`
- Test: `packages/cesium-core/src/cesium/lensFlare/lensFlareConstants.test.ts`

- [ ] **Step 1: 写失败 test**

```ts
// lensFlareConstants.test.ts
import { describe, expect, it } from 'vitest'
import {
  NUM_BLOOM_LEVELS, GHOST_OFFSETS, GHOST_TINTS, HALO_RADIUS, HALO_THICKNESS,
  CHROMATIC_ABERRATION, UPSAMPLE_RADIUS, DEPTH_EPSILON,
  LEARNOGLY_DOWNSAMPLE_WEIGHTS, CODAW_DOWNSAMPLE_WEIGHTS, UPSAMPLE_WEIGHTS,
  THRESHOLD_LEVEL_DEFAULT, THRESHOLD_RANGE_DEFAULT,
  INTENSITY_DEFAULT, GHOST_AMOUNT_DEFAULT, HALO_AMOUNT_DEFAULT
} from './lensFlareConstants'

describe('lensFlareConstants', () => {
  it('NUM_BLOOM_LEVELS=6（threshold + down0-4 到 1/32，spec §3/§5.2）', () => {
    expect(NUM_BLOOM_LEVELS).toBe(6)
  })
  it('9 ghost offsets + tints（逐字 three-geospatial，spec §1.4 表）', () => {
    expect(GHOST_OFFSETS).toHaveLength(9)
    expect(GHOST_TINTS).toHaveLength(9)
    expect(GHOST_OFFSETS[0]).toBe(-5.0); expect(GHOST_TINTS[0]).toEqual([0.8, 0.8, 1.0])
    expect(GHOST_OFFSETS[8]).toBe(10.0); expect(GHOST_TINTS[8]).toEqual([0.5, 0.8, 1.0])
  })
  it('halo radius=0.45 thickness=0.25 + 色散 texel=10（逐字）', () => {
    expect(HALO_RADIUS).toBe(0.45); expect(HALO_THICKNESS).toBe(0.25)
    expect(CHROMATIC_ABERRATION).toBe(10.0)
  })
  it('upsample radius=0.85（CoD:AW bloom 软硬旋钮）', () => {
    expect(UPSAMPLE_RADIUS).toBe(0.85)
  })
  it('depth epsilon=1e-6（log 域，spec §5.5/R6）', () => {
    expect(DEPTH_EPSILON).toBe(1e-6)
  })
  it('kernel 权重归一化（learnopengl / CoD:AW / upsample 三组）', () => {
    // learnopengl 13-tap: center 0.125 + 内角×4 0.125 + 边中×4 0.0625 + 外角×4 0.03125 = 1.0
    const l = LEARNOGLY_DOWNSAMPLE_WEIGHTS
    expect(l.center + l.innerCorner * 4 + l.edgeMid * 4 + l.outerCorner * 4).toBeCloseTo(1.0)
    // CoD:AW: 内角 0.125 + (边中+外角+center) 0.05556
    const c = CODAW_DOWNSAMPLE_WEIGHTS
    expect(c.inner).toBe(0.125); expect(c.outer).toBeCloseTo(0.05556)
    // upsample 9-tap: 中 0.25 + 边×4 0.125 + 角×4 0.0625 = 1.0
    const u = UPSAMPLE_WEIGHTS
    expect(u.center + u.edge * 4 + u.corner * 4).toBeCloseTo(1.0)
  })
  it('默认参数起点（spec §5.8，实测非缩放）', () => {
    expect(THRESHOLD_LEVEL_DEFAULT).toBe(3.0)
    expect(THRESHOLD_RANGE_DEFAULT).toBe(1.0)
    expect(INTENSITY_DEFAULT).toBe(0.01)
    expect(GHOST_AMOUNT_DEFAULT).toBe(0.05)
    expect(HALO_AMOUNT_DEFAULT).toBe(0.05)
  })
})
```

- [ ] **Step 2: 跑 test 验证失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/lensFlare/lensFlareConstants.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 lensFlareConstants.ts**

```ts
// lensFlareConstants.ts
// phase2b LensFlare 常量表（逐字 three-geospatial WebGL LensFlareEffect + spec §5 标定）。
// bloom 级数可配置（减法阶段降 NUM_BLOOM_LEVELS）。

export const NUM_BLOOM_LEVELS = 6 // threshold(get0) + down0-4（到 textureScale 1/32），spec §3

// 9 ghost offset + tint（逐字 three-geospatial lensFlareFeatures.frag，spec §1.4 表）
export const GHOST_OFFSETS: number[] = [-5.0, -1.5, -0.4, -0.2, -0.1, 0.7, 1.0, 2.5, 10.0]
export const GHOST_TINTS: [number, number, number][] = [
  [0.8, 0.8, 1.0], [1.0, 0.8, 0.4], [0.9, 1.0, 0.8], [1.0, 0.8, 0.4], [0.9, 0.7, 0.7],
  [0.5, 1.0, 0.4], [0.5, 0.5, 0.5], [1.0, 1.0, 0.6], [0.5, 0.8, 1.0]
]

export const HALO_RADIUS = 0.45      // cubicRingMask radius（逐字）
export const HALO_THICKNESS = 0.25   // cubicRingMask thickness（逐字）
export const HALO_DISPLACEMENT = 0.3 // halo 沿径向位移（lensFlareFeatures.frag）
export const CHROMATIC_ABERRATION = 10.0 // texel 单位（逐字）

export const UPSAMPLE_RADIUS = 0.85  // bloom up mix(support, c, radius)，CoD:AW 软硬旋钮

export const DEPTH_EPSILON = 1e-6    // occlusion log-depth epsilon（spec §5.5/R6）

// bloom kernel 权重（spec §5.1/5.2/5.3）
export const LEARNOGLY_DOWNSAMPLE_WEIGHTS = {
  center: 0.125, innerCorner: 0.125, edgeMid: 0.0625, outerCorner: 0.03125
} // threshold 用（learnopengl）
export const CODAW_DOWNSAMPLE_WEIGHTS = { inner: 0.125, outer: 0.05556 } // bloom down 用（CoD:AW）
export const UPSAMPLE_WEIGHTS = { center: 0.25, edge: 0.125, corner: 0.0625 } // bloom up 9-tap

// 默认参数起点（spec §5.8，实测非 ACES 线性缩放，URL 滑实测定）
export const THRESHOLD_LEVEL_DEFAULT = 3.0
export const THRESHOLD_RANGE_DEFAULT = 1.0
export const INTENSITY_DEFAULT = 0.01
export const GHOST_AMOUNT_DEFAULT = 0.05
export const HALO_AMOUNT_DEFAULT = 0.05
```

- [ ] **Step 4: 跑 test 验证通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/lensFlare/lensFlareConstants.test.ts`
Expected: PASS（7/7）。

- [ ] **Step 5: commit**

```bash
git add packages/cesium-core/src/cesium/lensFlare/lensFlareConstants.ts packages/cesium-core/src/cesium/lensFlare/lensFlareConstants.test.ts
git commit -m "feat(core/lensFlare): 常量表（NUM_BLOOM_LEVELS + 9 ghost + halo + kernel 权重 + 默认参数）"
```

---

## Task 2: threshold.frag.ts（learnopengl 13-tap 加权软阈值）

**Files:**
- Create: `lensFlare/threshold.frag.ts`
- Test: `lensFlare/threshold.frag.test.ts`

**spec §5.1** —— `lf_bloom` series get0，textureScale 1.0 全分，sampleMode NEAREST，读 atmosphere（series input = colorTexture）。13-tap learnopengl 加权（center 0.125 / 内角 0.125 / 边中 0.0625 / 外角 0.03125）+ luminance `smoothstep` 软阈值 + NaN 守护。

- [ ] **Step 1: 写失败 test**（string 断言 + uniform 一致性 + standalone 形状）

```ts
// threshold.frag.test.ts
import { describe, expect, it } from 'vitest'
import { buildThresholdFragmentShader, buildStandaloneShaderForValidation, THRESHOLD_UNIFORM_NAMES } from './threshold.frag'

describe('buildThresholdFragmentShader', () => {
  it('含 learnopengl 13-tap 加权（非均匀平均）', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('0.125')   // center/内角
    expect(s).toContain('0.0625')  // 边中
    expect(s).toContain('0.03125') // 外角
  })
  it('含 luminance smoothstep 软阈值 + NaN 守护', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('smoothstep')
    expect(s).toContain('isnan')
  })
  it('声明 colorTexture（series input）+ threshold uniforms', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
    expect(s).toContain('uniform vec2 u_texelSize')
    expect(s).toContain('uniform float u_thresholdLevel')
  })
  it('不含均匀平均 /13.0', () => {
    const s = buildThresholdFragmentShader()
    expect(s).not.toContain('/ 13.0')
    expect(s).not.toContain('/13.0')
  })
})
describe('THRESHOLD_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单）', () => {
    const s = buildThresholdFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(THRESHOLD_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + out_FragColor + luminance/saturate define', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
    expect(s).toContain('luminance')
  })
})
```

- [ ] **Step 2: 跑 test 验证失败**（Run: vitest run threshold.frag.test.ts，FAIL 模块不存在）

- [ ] **Step 3: 实现 threshold.frag.ts**

按 `tonemap.frag.ts` 模式：`UNIFORMS_GLSL`（`colorTexture` + `u_texelSize` + `u_thresholdLevel` + `u_thresholdRange`）+ `MAIN_GLSL`（spec §5.1 的 13-tap 加权 + smoothstep + NaN 守护，写 `out_FragColor`）+ `THRESHOLD_UNIFORM_NAMES = ['u_texelSize','u_thresholdLevel','u_thresholdRange']` + `buildStandaloneShaderForValidation`（补 `#version 300 es` + precision + `out vec4 out_FragColor` + `#define luminance/saturate`）。GLSL 13-tap 加权用 `LEARNOGLY_DOWNSAMPLE_WEIGHTS`（从 constants 取，避免魔法数字散落）。

- [ ] **Step 4: 跑 test 验证通过**（PASS）

- [ ] **Step 5: commit** — `feat(core/lensFlare): threshold fragment（learnopengl 13-tap 加权软阈值）`

---

## Task 3: bloomDownsample.frag.ts（CoD:AW 13-tap downsample）

**Files:** Create `bloomDownsample.frag.ts` + test.
**spec §5.2** —— `lf_bloom` series down 级，13-tap CoD:AW 权重（`WEIGHT_INNER=0.125` 内角、`WEIGHT_OUTER=0.05556` 边中+外角+center）。**与 threshold learnopengl 核几何同权重不同，不可混**（评审 I4）。`u_texelSize` 是源 texture 的。

- [ ] **Step 1-5**：TDD。test 断言含 `0.125`/`0.05556`、不含 learnopengl 的 `0.0625`/`0.03125`（防混核）、声明 `colorTexture`（series 前驱）+ `u_texelSize`、`BLOOM_DOWNSAMPLE_UNIFORM_NAMES=['u_texelSize']`、standalone 形状。实现：`UNIFORMS_GLSL` + `MAIN_GLSL`（CoD:AW 13-tap，权重从 `CODAW_DOWNSAMPLE_WEIGHTS`）+ standalone。commit `feat(core/lensFlare): bloom downsample fragment（CoD:AW 13-tap）`。

---

## Task 4: bloomUpsample.frag.ts（9-tap + mix radius）

**Files:** Create `bloomUpsample.frag.ts` + test.
**spec §5.3** —— 9-tap 加权（角 0.0625 / 边 0.125 / 中 0.25）累加成 `c`，`mix(support, c, u_upsampleRadius)`，radius=0.85。读 series 前驱（colorTexture）+ `u_downLevel`（uniform-name 引用对应 down 级，**强制**避同 scale framebuffer 共享，评审 I9）。

- [ ] **Step 1-5**：TDD。test 断言含 `0.0625`/`0.125`/`0.25`（9-tap）、含 `mix(`、含 `u_upsampleRadius`、声明 `colorTexture` + `u_downLevel`（sampler2D）+ `u_upsampleRadius` + `u_texelSize`、`BLOOM_UPSAMPLE_UNIFORM_NAMES=['u_downLevel','u_upsampleRadius','u_texelSize']`、standalone 形状（`u_downLevel` 桩声明 sampler2D）。实现：`MAIN_GLSL`（9-tap + mix）+ standalone。commit `feat(core/lensFlare): bloom upsample fragment（9-tap + mix radius=0.85）`。

---

## Task 5: preBlur.frag.ts（Kawase/小高斯软化）

**Files:** Create `preBlur.frag.ts` + test.
**spec §5.4 / C1 修复** —— 独立 stage（lensflare non-series 兄弟），读 `lf_threshold`（uniform-name string），Kawase/小高斯软化（ghost/halo 输入）。textureScale 1.0，sampleMode NEAREST。

- [ ] **Step 1-5**：TDD。test 断言含 Kawase/小高斯 4-8 tap（`u_texelSize` 驱动偏移）、声明 `u_thresholdTexture`（sampler2D，uniform-name 引用）+ `u_texelSize`、`PREBLUR_UNIFORM_NAMES=['u_thresholdTexture','u_texelSize']`、standalone 形状。实现：`UNIFORMS_GLSL`（`u_thresholdTexture` + `u_texelSize`，**注意**：主 `colorTexture` 是 non-series input=atmosphere，preBlur 不用它，但 Cesium 要求 stage 有 colorTexture——声明但 main 不采样）+ `MAIN_GLSL`（Kawase 8-tap 软化 `u_thresholdTexture`）+ standalone。commit `feat(core/lensFlare): preBlur fragment（Kawase 软化 threshold）`。

> **实现注意**：preBlur 读 `u_thresholdTexture`（= `'lf_threshold'` string，createLensFlareStage 接线）。Kawase kernel：8 方向 `±u_texelSize` 偏移采样平均（或小高斯 3×3）。忠实 three-geospatial `KawaseBlurPass SMALL`。

---

## Task 6: features.frag.ts（9 ghosts + halo + 色散，采 preBlur）

**Files:** Create `features.frag.ts` + test.
**spec §5.4** —— 9 ghosts（offset/tint 从 constants，`clamp(d,0,1)` + `pow(1-d,3)`）+ halo（cubicRingMask radius/thickness + 色散 R/G/B 偏移）+ occlusion 仅乘 ghosts/halo。**ghost/halo 都采 `u_preBlurTexture`**（C1 忠实移植）。声明 `u_preBlurTexture` + `u_occlusionTexture`（uniform-name）。

- [ ] **Step 1: 写失败 test**

```ts
// features.frag.test.ts
import { describe, expect, it } from 'vitest'
import { buildFeaturesFragmentShader, buildStandaloneShaderForValidation, FEATURES_UNIFORM_NAMES } from './features.frag'

describe('buildFeaturesFragmentShader', () => {
  it('9 ghosts（offset/tint 从 constants 注入）+ clamp(d,0,1) + pow(1-d,3)', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('pow(1.0 - d, 3.0)')
    expect(s).toContain('clamp(length(0.5 - suv)')  // clamp 防负色
    expect(s.match(/for\s*\(\s*int\s+i/g)?.length ?? 0).toBeGreaterThanOrEqual(1) // 9 ghost 循环
  })
  it('ghost + halo 都采 u_preBlurTexture（C1 忠实移植，非采 threshold/bloom）', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('uniform sampler2D u_preBlurTexture')
    const preBlurRefs = (s.match(/u_preBlurTexture/g) ?? []).length
    expect(preBlurRefs).toBeGreaterThanOrEqual(3) // 声明 + ghost + halo ≥3
    expect(s).not.toContain('u_bloomTexture') // features 不采 bloom（bloom 进 composite）
  })
  it('halo cubicRingMask + 色散 R/G/B 偏移', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('cubicRingMask')
    expect(s).toContain('vec3(-1.0, 0.0, 1.0)') // 色散 RGB 偏移
  })
  it('occlusion 仅乘 ghosts/halo（不乘 bloom）', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('u_occlusionTexture')
    expect(s).toMatch(/\*\s*occ/) // (ghosts + halo) * occ
  })
  it('vec2 aspect（非 vec3 笔误）', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('vec2 aspect')
    expect(s).not.toContain('vec3 aspect')
  })
})
describe('FEATURES_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单 + uniform-name texture 计入）', () => {
    const s = buildFeaturesFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture']) // u_preBlurTexture/u_occlusionTexture 是 uniform-name 引用，须列入
    expect(FEATURES_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + 桩（u_preBlurTexture/u_occlusionTexture sampler2D）', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('uniform sampler2D u_preBlurTexture')
    expect(s).toContain('uniform sampler2D u_occlusionTexture')
  })
})
```

- [ ] **Step 2-5**：TDD。实现：`UNIFORMS_GLSL`（`colorTexture`[不用] + `u_preBlurTexture` + `u_occlusionTexture` + `u_texelSize` + `u_ghostAmount`/`u_haloAmount`/`u_chromaticAberration` + ghost offset/tint 作 `const` 数组从 constants 注入）+ `HELPERS_GLSL`（`cubicRingMask`）+ `MAIN_GLSL`（spec §5.4 完整）+ standalone（桩 `u_preBlurTexture`/`u_occlusionTexture` sampler2D）。commit `feat(core/lensFlare): features fragment（9 ghosts + halo + 色散，采 preBlur）`。

> **ghost offset/tint 注入**：GLSL 不支持动态数组循环索引（const array 可），把 `GHOST_OFFSETS`/`GHOST_TINTS` 编译成 `const float GHOST_OFFSETS[9] = float[](…)` + `const vec3 GHOST_TINTS[9] = vec3[](…)`，或展开 9 个 `#pragma unroll` 循环。建议 const array（GLSL ES 3.00 支持）。

---

## Task 7: occlusion.ts（纯函数 + 36 点网格）

**Files:** Create `occlusion.ts` + test.
**spec §5.5** —— 纯函数：`computeSunScreenUV(sunDirectionWC, cameraPositionWC, view, projection)` / `rayEllipsoidIntersect(ro, rd, ellipsoidRadiiSquared)` / `generateSampleGrid36()`。

- [ ] **Step 1: 写失败 test**

```ts
// occlusion.test.ts
import { describe, expect, it } from 'vitest'
import { computeSunScreenUV, rayEllipsoidIntersect, generateSampleGrid36 } from './occlusion'

describe('computeSunScreenUV', () => {
  it('sun 在视椎内 → UV in [0,1]', () => {
    // sun 沿 +z（view 空间正前方），投影到屏幕中心
    const uv = computeSunScreenUV([0,0,1], [0,0,0], IDENTITY_VIEW, PERSP_PROJ)
    expect(uv[0]).toBeGreaterThanOrEqual(0); expect(uv[0]).toBeLessThanOrEqual(1)
    expect(uv).toBeTruthy()
  })
  it('sun 在视椎外/背面 → null', () => {
    expect(computeSunScreenUV([0,0,-1], [0,0,0], IDENTITY_VIEW, PERSP_PROJ)).toBeNull()
  })
})
describe('rayEllipsoidIntersect', () => {
  it('射线击中椭球 → t>0', () => {
    const t = rayEllipsoidIntersect([0,0,7000e3], [0,0,-1], [6378e3**2, 6378e3**2, 6356e3**2])
    expect(t).toBeGreaterThan(0)
  })
  it('射线背离椭球 → -1', () => {
    expect(rayEllipsoidIntersect([0,0,7000e3], [0,0,1], [6378e3**2,6378e3**2,6356e3**2])).toBe(-1)
  })
})
describe('generateSampleGrid36', () => {
  it('36 点（6×6），归一化 [-1,1]', () => {
    const pts = generateSampleGrid36()
    expect(pts).toHaveLength(36)
    expect(pts.every(p => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1)).toBe(true)
  })
})
```

- [ ] **Step 2-5**：TDD。实现：`computeSunScreenUV`（`czm_view`/`czm_projection` 在 shader 内，纯函数版用传入的 view/projection 矩阵算 NDC→UV，sun 在背面/w<0 → null）；`rayEllipsoidIntersect`（椭球求交，返回 t 或 -1）；`generateSampleGrid36`（6×6 网格 [-1,1]²，或加每帧旋转抖动）。commit `feat(core/lensFlare): occlusion 纯函数（sun 投影 + ray-ellipsoid + 36 点网格）`。

> **注**：`computeSunScreenUV` 在 node 单测用纯数学（mock view/proj 矩阵）；shader 内用 `czm_view`/`czm_projection` 自动注入。纯函数确保逻辑可单测，shader 内联网格/复用纯函数逻辑。

---

## Task 8: occlusion.frag.ts（shader：sun 投影 + depth 36 点覆盖率）

**Files:** Create `occlusion.frag.ts` + test.
**spec §5.5** —— textureScale **0.0625**（标量降分，评审专2 I9）+ sampleMode NEAREST。sun 投影（`czm_view * vec4(sunDirWC, 0.0)` w=0）+ ray-ellipsoid（背面=0）+ `depthTexture` 36 点覆盖率（`sceneDepth < 1.0 - DEPTH_EPSILON`）→ 0-1 写 `out_FragColor.r`。声明 `depthTexture`（Cesium 内建）+ `u_sunDirectionWC`/`u_cameraPositionWC`/`u_sunAngularRadius`/`u_ellipsoidRadiiSquared`。

- [ ] **Step 1-5**：TDD。test 断言含 `czm_readDepth`、`1.0 - DEPTH_EPSILON`（log epsilon）、36 点循环（或 `generateSampleGrid36` 注入）、`rayEllipsoid`（或 `dot(ro,rd)` 球交展开）、声明 `depthTexture` + sun uniforms、`OCCLUSION_UNIFORM_NAMES`（depthTexture 白名单 + 内建 `czm_*` 白名单）、standalone 桩（`depthTexture` + `czm_view`/`czm_projection`/`czm_readDepth`/`czm_viewerPositionWC` 桩）。实现：`UNIFORMS_GLSL` + `MAIN_GLSL`（spec §5.5 算法）+ standalone。commit `feat(core/lensFlare): occlusion fragment（sun 投影 + ray-ellipsoid + 36 点 depth 覆盖率）`。

> **clear depth 陷阱（R6）**：天空与远面几何 depthTexture 同值（=1.0），太阳落远处 globe 边缘可能误判。spec 注明，验收 L4 盯。

---

## Task 9: composite.frag.ts（叠加）

**Files:** Create `composite.frag.ts` + test.
**spec §5.6** —— textureScale 1.0 全分，sampleMode NEAREST（**dithering 硬约束**：主 colorTexture = atmosphere）。`out = atmosphere + (bloom + features) * intensity`。声明 `colorTexture`（主，atmosphere）+ `u_bloomTexture` + `u_featuresTexture`（uniform-name）+ `u_intensity`。

- [ ] **Step 1-5**：TDD。test 断言含 `texture(colorTexture,`（主 atmosphere）+ `(bloom + features)` + `u_intensity`、声明 `u_bloomTexture`/`u_featuresTexture`/`u_intensity`、`COMPOSITE_UNIFORM_NAMES=['u_bloomTexture','u_featuresTexture','u_intensity']`（colorTexture 白名单）、standalone 桩。实现：`UNIFORMS_GLSL` + `MAIN_GLSL`（spec §5.6）+ standalone。commit `feat(core/lensFlare): composite fragment（atmosphere + (bloom+features)*intensity）`。

---

## Task 10: lensFlare.compile.test.ts（统一 glslang 全组合）

**Files:** Create `lensFlare/lensFlare.compile.test.ts`（复用 `aerialPerspective.compile.test.ts` 的 `compileFragment`/`getGlslangValidatorPath` helper —— **抽到共享 `glslangUtil.ts`** 或 import）。

- [ ] **Step 1: 抽 glslang helper 共享**（避免重复）—— 把 `aerialPerspective.compile.test.ts` 的 `compileFragment`/`getGlslangValidatorPath`/`whichSystem` 抽到 `cesium/glslangUtil.ts`，两 compile test 都 import。

- [ ] **Step 2: 写 lensFlare.compile.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { compileFragment } from '../glslangUtil'
import { buildStandaloneShaderForValidation as threshold } from './threshold.frag'
import { buildStandaloneShaderForValidation as down } from './bloomDownsample.frag'
import { buildStandaloneShaderForValidation as up } from './bloomUpsample.frag'
import { buildStandaloneShaderForValidation as preBlur } from './preBlur.frag'
import { buildStandaloneShaderForValidation as features } from './features.frag'
import { buildStandaloneShaderForValidation as occlusion } from './occlusion.frag'
import { buildStandaloneShaderForValidation as composite } from './composite.frag'

const SHADERS = [ ['threshold', threshold], ['bloomDown', down], ['bloomUp', up],
  ['preBlur', preBlur], ['features', features], ['occlusion', occlusion], ['composite', composite] ]

describe('GLSL 编译验证（lensFlare 全 shader）', () => {
  for (const [name, build] of SHADERS) {
    it(`编译通过：${name}`, () => {
      const src = (build as () => string)()
      expect(src.startsWith('#version 300 es')).toBe(true)
      const { ok, output } = compileFragment(src)
      if (!ok) throw new Error(`glslang 失败（${name}）:\n${output}`)
      expect(ok).toBe(true)
    })
  }
  it('glslang 真抓错误（防哑过）', () => {
    const { ok } = compileFragment('#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){o=vec4(noSuchThing);}')
    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 3: 跑**（`vitest run lensFlare.compile.test.ts`，全 PASS）
- [ ] **Step 4: 跑 phase2a 防回归**（`vitest run aerialPerspective.compile.test.ts` 仍过——抽 helper 后 import 路径变了，确认 helper 抽取不破坏）
- [ ] **Step 5: commit** — `test(core/lensFlare): glslang 全 shader 编译验证 + 抽 glslangUtil 共享`

---

## Task 11: createLensFlareStage.ts（组装 lensflare Composite）

**Files:** Create `lensFlare/createLensFlareStage.ts` + test.
**spec §3/§5.9** —— 组装：`lf_bloom` series composite（threshold get0 + down0-4 + up0-4，**up[i] uniform-name 引用 down[对应级]**）+ lf_preBlur + lf_occlusion（textureScale 0.0625）+ lf_features + lf_composite，外层 non-series `lensflare` composite。uniforms：uniform-name texture 引用 **string 字面量**（`u_preBlurTexture: 'lf_preBlur'`），动态值 function 闭包（`sunDirection`）。

- [ ] **Step 1: 写失败 test**

```ts
// createLensFlareStage.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createLensFlareStage } from './createLensFlareStage'

describe('createLensFlareStage', () => {
  it('lf_bloom series composite get0=threshold（C2 拓扑）', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const stages = bloomComposite.stages
    expect(stages[0].name).toBe('lf_threshold') // get0 = threshold，非 down0
    expect(stages[1].name).toBe('lf_down0')     // down0 是 get1，series 前驱=threshold
  })
  it('lf_bloom 含 NUM_BLOOM_LEVELS down + (N-1) up', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const downs = bloomComposite.stages.filter(s => s.name.startsWith('lf_down'))
    const ups = bloomComposite.stages.filter(s => s.name.startsWith('lf_up'))
    expect(downs).toHaveLength(5) // down0-4
    expect(ups).toHaveLength(5)   // up0-4
  })
  it('up[i] uniform u_downLevel = string 字面量（避同 scale 共享，I9）+ 非 function', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const up0 = bloomComposite.stages.find(s => s.name === 'lf_up0')!
    expect(typeof up0.uniforms.u_downLevel).toBe('string') // string 字面量非 function
    expect(up0.uniforms.u_downLevel).toBe('lf_down3')
  })
  it('features uniform-name texture 引用全 string 字面量（I10）', () => {
    const { featuresStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(featuresStage.uniforms.u_preBlurTexture).toBe('lf_preBlur')
    expect(featuresStage.uniforms.u_occlusionTexture).toBe('lf_occlusion')
  })
  it('occlusion textureScale=0.0625（标量降分）', () => {
    const { occlusionStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(occlusionStage.textureScale).toBe(0.0625)
  })
  it('composite sampleMode=NEAREST（dithering 硬约束）', () => {
    const { compositeStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(compositeStage.sampleMode).toBe(PostProcessStageSampleMode.NEAREST)
  })
  it('全 stage pixelDatatype=postHdrDatatype（HalfFloat 线性链）', () => {
    const handle = createLensFlareStage(mockScene(HALF_FLOAT), mockState(), {})
    expect(handle.bloomComposite.pixelDatatype).toBe(PixelDatatype.HALF_FLOAT)
  })
  it('外层 non-series lensflare composite', () => {
    const { lensflareComposite } = createLensFlareStage(mockScene(), mockState(), {})
    expect(lensflareComposite.inputPreviousStageTexture).toBe(false)
  })
})
```

- [ ] **Step 2-5**：TDD。实现 `createLensFlareStage(scene, state, options)`：
  - 建 `lf_threshold`/`lf_down0-4`/`lf_up0-4` 11 个 PostProcessStage（textureScale 1.0/0.5/0.25/0.125/0.0625/0.03125 down，0.0625/0.125/0.25/0.5/1.0 up；threshold sampleMode NEAREST，down/up LINEAR）。
  - `lf_up[i].uniforms.u_downLevel = 'lf_down[对应级]'`（**string 字面量**）。
  - `lf_bloom = new PostProcessStageComposite({ name:'lf_bloom', stages:[threshold, ...downs, ...ups], inputPreviousStageTexture:true })`（series）。
  - 建 `lf_preBlur`/`lf_occlusion`（textureScale 0.0625）/`lf_features`/`lf_composite`，uniform-name texture 引用全 string 字面量。
  - `lensflare = new PostProcessStageComposite({ name:'lensflare', stages:[lf_bloom, lf_preBlur, lf_occlusion, lf_features, lf_composite], inputPreviousStageTexture:false })`（non-series）。
  - 返回 `{ lensflareComposite, bloomComposite, preBlurStage, occlusionStage, featuresStage, compositeStage }`（测试 + AtmosphereStage 用）。
  - mock：`mockScene(postHdrDatatype)` 提供 `scene.context` caps + `scene.postProcessStages`（spy 不真 add）；PostProcessStage/Composite 用真实构造（仅 new，不 add）或 mock 记录 options。
  - commit `feat(core/lensFlare): createLensFlareStage 组装（lf_bloom series + 4 兄弟 + non-series 外层）`。

> **mock 策略**：PostProcessStage/Composite 构造不依赖 WebGL（仅记 options），可直接 `new`。`scene.postProcessStages.add` 不在 createLensFlareStage 内调（由 AtmosphereStage add 外层 composite），故 mockScene 仅提供 `context` caps（postHdrDatatype 检测）。

---

## Task 12: AtmosphereStage.ts 集成（插 lensflare + handle + enabled）

**Files:** Modify `cesium/AtmosphereStage.ts` + `cesium/AtmosphereStage.test.ts`.
**spec §5.9** —— `createAtmosphereStage` 在 `add(atmosphere)` 后、`add(tonomap)` 前 `add(lensflare)`（options.lensFlare 默认 true）。`AtmosphereStageHandle` 加 `lensFlareStage?`。`?lensflare=0` → `lensFlareStage.enabled = false`（非 setMode rebuild）。`setMode` 用 `enabled` 切 lensflare on/off。

- [ ] **Step 1: 改 AtmosphereStage.test.ts 加失败 test**

```ts
// 加断言：
it('createAtmosphereStage 产三 stage（atmosphere + lensflare + tonomap），add 顺序正确', () => {
  const handle = createAtmosphereStage(mockScene(), luts, {})
  expect(handle.atmosphereStage).toBeDefined()
  expect(handle.lensFlareStage).toBeDefined()  // 新增
  expect(handle.tonemapStage).toBeDefined()
  // add 顺序：atmosphere → lensflare → tonomap（spy 记录）
  const names = addSpy.calls.map(c => c[0].name)
  expect(names.indexOf('lensflare') - names.indexOf(<atmosphere>)).toBe(1)
  expect(names.indexOf(<tonomap>) - names.indexOf('lensflare')).toBe(1)
})
it('lensFlare=false 不创建 lensflare（phase2a 两 stage 行为）', () => {
  const handle = createAtmosphereStage(mockScene(), luts, { lensFlare: false })
  expect(handle.lensFlareStage).toBeUndefined()
})
it('AtmosphereStageOptions 加 lensFlare/lensFlareIntensity/lensFlareThreshold（默认）', () => {
  const r = validateAtmosphereOptions({})
  expect(r.lensFlare).toBe(true)
  expect(r.lensFlareIntensity).toBe(0.01)
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 改 AtmosphereStage.ts**

```ts
// validateAtmosphereOptions 加：lensFlare: options.lensFlare ?? true,
//   lensFlareIntensity: options.lensFlareIntensity ?? INTENSITY_DEFAULT,（从 lensFlareConstants）
//   lensFlareThreshold: options.lensFlareThreshold ?? THRESHOLD_LEVEL_DEFAULT, ...
// AtmosphereStageOptions 接口加这些字段
// AtmosphereStageHandle 加 readonly lensFlareStage?: PostProcessStageComposite

// createAtmosphereStage 内：
const lensFlareStage = resolved.lensFlare
  ? createLensFlareStage(scene, state, { intensity: resolved.lensFlareIntensity, ... })
  : undefined
scene.postProcessStages.add(atmosphereStage)
if (lensFlareStage) {
  const lf = lensFlareStage.lensflareComposite
  scene.postProcessStages.add(lf)
}
scene.postProcessStages.add(tonomapStage)
// handle getter 加 lensFlareStage: lensFlareStage?.lensflareComposite
// setMode 不 rebuild lensflare（用 enabled）；destroy removeAndDestroy lensflare（若存在）
```

- [ ] **Step 4: 跑通过**（`vitest run AtmosphereStage.test.ts`）
- [ ] **Step 5: 跑全 core 测**（`pnpm --filter @cesium-geospatial/core test`，确保 phase2a 不回归）
- [ ] **Step 6: commit** — `feat(core): AtmosphereStage 插 lensflare Composite（三 stage + handle + enabled 开关）`

---

## Task 13: demo 接线（main.ts URL 参数 + debug 探针）+ results.md

**Files:** Modify `apps/demo/src/main.ts` + Create `docs/superpowers/plans/2026-08-04-phase2b-results.md`.
**spec §5.10** —— URL：`?lensflare=0`（lensFlare=false）/`?lfIntensity=`/`?lfThreshold=`/`?lfGhost=`/`?lfHalo=`。debug 探针 `?debug=8..12`（threshold/bloom/preBlur/occlusion/features 逐项）。

- [ ] **Step 1: 改 main.ts** —— URL 解析加 `lensflare`（getString 'lensflare' === '0' → false）/ `lfIntensity`/`lfThreshold`/`lfGhost`/`lfHalo`（getNumber），传 createAtmosphereStage options。

```ts
// main.ts 加：
const lensFlare = getString('lensflare') !== '0'  // 默认 true
const lfIntensity = getNumber('lfIntensity', INTENSITY_DEFAULT)
const lfThreshold = getNumber('lfThreshold', THRESHOLD_LEVEL_DEFAULT)
// ... lfGhost / lfHalo
createAtmosphereStage(scene, luts, { ..., lensFlare, lensFlareIntensity: lfIntensity, lensFlareThreshold: lfThreshold, ... })
```

- [ ] **Step 2: demo tsc**（`pnpm --filter demo exec tsc --noEmit`，0 错）
- [ ] **Step 3: 写 results.md**（验收清单：单测 + glslang + phase1 五项零回归 + 水波纹专项 + L1-L5 lensflare + ?lensflare=0 兜底，spec §6.3/§6.4）

- [ ] **Step 4: 视觉验收（项目方浏览器，spec §6.3）**
  - `pnpm dev` → `?mode=atmosphere` + phase2a 验收 URL（camera=93.1569,31.6636,13469,32,-4.2 + time=2026-08-04T06:30Z）
  - **phase1 五项零回归** + **水波纹专项**（俯视 nadir 远景）
  - **L1 ghosts**（转向太阳，9 重影沿轴）+ **L2 halo**（紧环 + 色散）+ **L3 bloom**（辉光 6 级）+ **L4 occlusion**（太阳被山挡 ghosts/halo 平滑衰减，36 点无台阶）+ **L5 ?hdr=0 兜底**
  - debug=8..12 逐项隔离
  - `?lensflare=0` 回退 phase2a

- [ ] **Step 5: 填 results.md 实际验收结果**
- [ ] **Step 6: commit** — `feat(demo): phase2b lensflare URL 参数 + debug 探针 + 验收`

---

## Self-Review（writing-plans 第 7 步，写完后跑）

**1. Spec 覆盖**：spec §5.1-5.10 + §6 + §7 全有 task。threshold(T2)/bloomDown(T3)/bloomUp(T4)/preBlur(T5)/features(T6)/occlusion.ts(T7)/occlusion.frag(T8)/composite(T9) = §5.1-5.6；compile(T10) = §6.2；createLensFlareStage(T11) = §3/§5.9；AtmosphereStage(T12) = §5.9；main+results(T13) = §5.10/§6.3。✅

**2. Placeholder 扫描**：无 TBD/TODO。shader 代码引用 spec §5（complete）+ plan 给 GLSL 骨架 + test 断言 + 命令。constants/createLensFlareStage 给完整 TS。✅

**3. 类型一致**：`AtmosphereStageHandle.lensFlareStage?: PostProcessStageComposite`（T11 返回 lensflareComposite）+ T12 handle getter 一致。`createLensFlareStage` 返回 `{ lensflareComposite, bloomComposite, preBlurStage, occlusionStage, featuresStage, compositeStage }`（T11/T12 一致）。uniform-name string 字面量（`u_downLevel: 'lf_down3'`）T11 测试钉死。✅

**4. 评审风险覆盖**：C2（threshold get0）T11 测试；C1（preBlur）T5/T6；sampleMode（composite NEAREST）T11 测试；up→down 强制依赖 T11 测试；uniform-name string T11 测试；occlusion 降分 T11 测试；depth epsilon T8；水波纹专项 T13。✅

---

## 执行交接

**Subagent-Driven（推荐）**：fresh implementer per task + spec review + code quality review（phase2a 模式）。13 tasks 串行。

**Inline**：executing-plans batch 执行。

**建议 Subagent-Driven**：shader 移植 + Cesium Composite 拓扑（T11）是 phase2b 最易错点（评审 C2/I9/I10 都是接线 bug），两阶段 review 把关。
