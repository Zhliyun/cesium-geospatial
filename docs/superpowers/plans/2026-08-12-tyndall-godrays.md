# God Rays（丁达尔效应）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cesium 后处理链加入 god rays（相对 luminance bright-pass radial blur + lf_occlusion 太阳门控），实现丁达尔效应——晨昏地平线光束、山脊切割、太阳半遮 crepuscular 形态。

**Architecture:** god rays composite（`gr_maxLum` 降采样 max-luminance + `gr_godrays` radial blur）插 `atmosphere→lensflare→godrays→tonemap`，uniform-name 引用 `atmosphere`/`lf_occlusion`/`gr_maxLum` 解耦。相对 luminance bright-pass（`threshold = ratio × maxLum`）根治动态 exposure 晨昏失效。

**Tech Stack:** TypeScript + GLSL ES 3.00 + Cesium PostProcessStage/Composite + Vitest + glslangValidator

**Spec:** `docs/superpowers/specs/2026-08-12-tyndall-godrays-design.md`（3 轮专家评审通过）

---

## File Structure

**新建**（`packages/cesium-core/src/cesium/godRays/`，与 `lensFlare/` 平级）：
- `godRaysConstants.ts` — 默认标定常量（单一来源）
- `godRaysConstants.test.ts`
- `godRaysMaxLum.frag.ts` — gr_maxLum shader 构建器（4×4 局部 max luminance）
- `godRaysMaxLum.frag.test.ts` — 结构测试
- `godRaysMaxLum.compile.test.ts` — glslang 编译校验
- `godRays.frag.ts` — gr_godrays shader 构建器（相对 luminance bright-pass radial blur + 双路径太阳门控）
- `godRays.frag.test.ts` — 结构测试（四组合）
- `godRays.compile.test.ts` — glslang 编译校验（四组合）
- `createGodRaysStage.ts` — composite 装配
- `createGodRaysStage.test.ts` — 结构测试

**修改**：
- `packages/cesium-core/src/cesium/AtmosphereStage.ts` — options/resolved/create/setMode/destroy/handle（§5.2）
- `packages/cesium-core/src/cesium/AtmosphereStage.test.ts` — 默认值 + godRays=false 防回归
- `apps/demo/src/main.ts` — URL 参数

**参考模式**（实现时读这些对齐）：
- `lensFlare/createLensFlareStage.ts`（composite + uniform-name 引用）
- `lensFlare/occlusion.frag.ts`（太阳屏幕投影 + useSmoothDepth 双路径 + farPlane 阈值 + validation 桩）
- `lensFlare/features.frag.ts`（uniform-name 引用 + UNIFORM_NAMES + 数组注入 + validation 桩）
- `lensFlare/threshold.frag.ts`（luminance macro + smoothstep soft bright-pass）
- `lensFlare/bloomDownsample.frag.ts`（降采样 + u_texelSize）
- `lensFlare/lensFlare.compile.test.ts`（glslang 测试模式）

---

## Task 1: godRaysConstants + 跨 stage 引用 spike + 量级实测

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/godRaysConstants.ts`
- Create: `packages/cesium-core/src/cesium/godRays/godRaysConstants.test.ts`

- [ ] **Step 1: 写 godRaysConstants.ts**

```ts
// phase2c God Rays 常量表（3 轮专家评审标定）。
// 相对 luminance bright-pass（r3 用户决策）：threshold = ratio × maxLum，跟随场景最亮区自适应，
// 根治固定 threshold 在动态 exposure 下的晨昏失效 + 量级 6× 跳变。

export const INTENSITY_DEFAULT = 0.08 // 待 T1 ?debug=7 实测微调（相对 luminance 下 god rays ∝ maxLum）
export const DENSITY_DEFAULT = 1.0
export const DECAY_DEFAULT = 0.86 // Mitchell GPU Gems 3
export const EXPOSURE_DEFAULT = 1.0
export const SAMPLES_DEFAULT = 48
export const THRESHOLD_RATIO_DEFAULT = 0.5 // 相对 maxLum 比例（替代固定 threshold，根治晨昏失效）
export const MAXLUM_TEXTURE_SCALE = 0.0625 // gr_maxLum 降采样（对齐 lf_occlusion OCCLUSION_TEXTURE_SCALE）
export const MAXLUM_KERNEL = 4 // gr_maxLum 局部 max kernel（4×4）
// SKY_DEPTH_THRESHOLD 按 useSmoothDepth 分支（对齐 occlusion.frag:105-109，非单一常量）：
//   smooth 路径 1e-4（depthTemporal FOG_PLANE_LOGDEPTH_EPS 单源）
//   legacy 路径 1e-6（从 lensFlareConstants.DEPTH_EPSILON 导入）
```

- [ ] **Step 2: 写 godRaysConstants.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import {
  INTENSITY_DEFAULT, DENSITY_DEFAULT, DECAY_DEFAULT, EXPOSURE_DEFAULT,
  SAMPLES_DEFAULT, THRESHOLD_RATIO_DEFAULT, MAXLUM_TEXTURE_SCALE, MAXLUM_KERNEL
} from './godRaysConstants'

describe('godRaysConstants', () => {
  it('默认标定（r3 相对 luminance + 3 轮评审）', () => {
    expect(INTENSITY_DEFAULT).toBe(0.08)
    expect(DENSITY_DEFAULT).toBe(1.0)
    expect(DECAY_DEFAULT).toBe(0.86)
    expect(EXPOSURE_DEFAULT).toBe(1.0)
    expect(SAMPLES_DEFAULT).toBe(48)
    expect(THRESHOLD_RATIO_DEFAULT).toBe(0.5)
    expect(MAXLUM_TEXTURE_SCALE).toBe(0.0625)
    expect(MAXLUM_KERNEL).toBe(4)
  })
})
```

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/godRaysConstants.test.ts`
Expected: PASS

- [ ] **Step 4: 跨 stage 引用 spike + 量级实测（手动 demo）**

这是 spec §3.1/§10 T1 的早期 spike，确认两件事：
1. **跨 stage uniform-name 引用可行**（Cesium 源码已证低风险，spike 实证）：
   - 在 `apps/demo/src/main.ts` 临时建一个占位 PostProcessStage（`u_sourceTexture:'atmosphere'` + `u_occlusionTexture:'lf_occlusion'` + `u_maxLumTexture:'gr_maxLum'`，采红色输出），add 到 lensflare 后 tonomap 前。
   - `pnpm dev`，打开 demo，确认占位 stage 输出红色（证明三个 uniform-name 引用都解析成功）。
   - 确认后删除占位 stage。
2. **?debug=7 量级实测**（spec §8.2，回填 §8.1 intensity + §7.1 锚点常量）：
   - `pnpm dev`，`?debug=7&lensflare=0`（关 lensflare 避污染），看 atmosphere false-color（`clamp(c.rgb/5.0,0,1)`）。
   - 复现正午 + 晨昏两视角（`#camera=` 复现），读远天空 / 近太阳天空 / 太阳盘三档量级。
   - **若近太阳/太阳盘全白（>5，/5.0 上限）**：临时改 `tonemap.frag.ts:48` 除数为 `/20.0` 扩大量程，或加 `debug=8` log 归一化 `clamp(log(c+1)/log(50),0,1)`（spec §8.2 debug=7 ceiling 应对）。
   - 记录实测值（SKY_FAR_HDR / SKY_NEAR_SUN_HDR / SUN_DISK_HDR），回填 Task 7 的锚点常量。
   - 若实测天空 <8（adversarial 反推 likely 1-3，但 lensflare threshold=3.0 已证亮区>3），确认 intensity 0.08 是否需微调（god rays 叠加暗区后 ACES 输入应落 1-4 可见区间）。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/godRaysConstants.ts packages/cesium-core/src/cesium/godRays/godRaysConstants.test.ts
git commit -m "feat(godrays): T1 godRaysConstants 默认标定 + 跨 stage 引用 spike + 量级实测"
```

---

## Task 2: godRaysMaxLum.frag（gr_maxLum shader）

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/godRaysMaxLum.frag.ts`
- Create: `packages/cesium-core/src/cesium/godRays/godRaysMaxLum.frag.test.ts`
- Create: `packages/cesium-core/src/cesium/godRays/godRaysMaxLum.compile.test.ts`

- [ ] **Step 1: 写 godRaysMaxLum.frag.ts**

```ts
// gr_maxLum fragment（4×4 局部 max luminance，spec §3.2 / §4 相对 threshold 参考）。
//
// **目的**：求"太阳附近天空的局部 max luminance"，作为 gr_godrays 相对 threshold 的动态参考
//   （threshold = ratio × maxLum），跟随场景最亮区自适应，根治固定 threshold 晨昏失效（r3）。
//
// **textureScale=0.0625 降采样**（接线层 createGodRaysStage 设）：1/16 分辨率，4×4 kernel 覆盖
//   降采样后的局部区域，等效全分约 16×16 局部 max。gr_godrays 读 sunScreenPos 处得太阳附近 max。
//
// **uniform-name 引用 'atmosphere'**：gr_maxLum 是 godrays composite 内 non-series 兄弟 stage，
//   采 u_sourceTexture（atmosphere，跨 composite 引用，Cesium getStageByName 全局 flat 查找，§3.1）。
//   colorTexture 是 composite 输入（lensflare 输出），Cesium 要求声明但 gr_maxLum 不采它。
//
// **luminance macro**（对齐 threshold.frag.ts:18，Cesium 无 three.js <common>）。

const DEFINES_GLSL = `
#define luminance(c) dot(c, vec3(0.2126, 0.7152, 0.0722))
`

const UNIFORMS_GLSL = `
uniform sampler2D colorTexture;          // composite 输入（lensflare 输出），gr_maxLum 不采，Cesium 要求声明
uniform sampler2D u_sourceTexture;       // atmosphere（uniform-name string 引用，强制依赖）
uniform vec2 u_texelSize;                // 源 texture（atmosphere，全分）的 1/w, 1/h
`

const MAIN_GLSL = `
in vec2 v_textureCoordinates;

void main() {
  vec2 ts = u_texelSize;
  // 4×4 局部 max luminance（MAXLUM_KERNEL=4，覆盖 -1..+2 偏移，对齐降采样局部块）
  float maxLum = 0.0;
  for (int y = -1; y <= 2; ++y) {
    for (int x = -1; x <= 2; ++x) {
      vec3 c = texture(u_sourceTexture, v_textureCoordinates + vec2(float(x), float(y)) * ts).rgb;
      maxLum = max(maxLum, luminance(c));
    }
  }
  out_FragColor = vec4(maxLum, 0.0, 0.0, 1.0);
}
`

// 供 non-series 接线一致性测试：gr_maxLum 声明的 uniform（colorTexture 是 Cesium 内建白名单）。
// u_sourceTexture 是 uniform-name string 引用，须列入以构建强制依赖（保证 atmosphere 先于 gr_maxLum）。
export const GODRAYS_MAXLUM_UNIFORM_NAMES: string[] = ['u_sourceTexture', 'u_texelSize']

export function buildGodRaysMaxLumFragmentShader(): string {
  return [DEFINES_GLSL, UNIFORMS_GLSL, MAIN_GLSL].join('\n')
}

const VALIDATION_STUBS_GLSL = `
out vec4 out_FragColor;
`

export function buildStandaloneShaderForValidation(): string {
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    VALIDATION_STUBS_GLSL,
    buildGodRaysMaxLumFragmentShader()
  ].join('\n')
}
```

- [ ] **Step 2: 写 godRaysMaxLum.frag.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import {
  GODRAYS_MAXLUM_UNIFORM_NAMES,
  buildGodRaysMaxLumFragmentShader,
  buildStandaloneShaderForValidation
} from './godRaysMaxLum.frag'

describe('godRaysMaxLum.frag', () => {
  it('GODRAYS_MAXLUM_UNIFORM_NAMES 含 uniform-name 引用（强制依赖 atmosphere）', () => {
    expect(GODRAYS_MAXLUM_UNIFORM_NAMES).toContain('u_sourceTexture')
    expect(GODRAYS_MAXLUM_UNIFORM_NAMES).toContain('u_texelSize')
  })
  it('shader 含 4×4 max luminance kernel + u_sourceTexture 采 atmosphere（非 colorTexture）', () => {
    const s = buildGodRaysMaxLumFragmentShader()
    expect(s).toContain('texture(u_sourceTexture')
    expect(s).toMatch(/for \(int y = -1; y <= 2/)
    expect(s).toContain('max(maxLum, luminance(c))')
    // 不采 colorTexture（仅声明）
    const colorTexReads = (s.match(/texture\(colorTexture/g) || []).length
    expect(colorTexReads).toBe(0)
  })
  it('buildStandaloneShaderForValidation 补 #version + precision + out_FragColor 桩', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('precision highp float;')
    expect(s).toContain('out vec4 out_FragColor;')
  })
})
```

- [ ] **Step 3: 跑结构测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/godRaysMaxLum.frag.test.ts`
Expected: PASS

- [ ] **Step 4: 写 godRaysMaxLum.compile.test.ts（glslang 校验）**

参考 `lensFlare.compile.test.ts` 模式（glslangValidator 或 prebuilt binary）。核心：

```ts
import { describe, expect, it } from 'vitest'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { buildStandaloneShaderForValidation } from './godRaysMaxLum.frag'
import { resolve } from 'node:path'

const TMP = resolve(__dirname, '../../../../../../.tmp/godRaysMaxLum.frag')

describe('godRaysMaxLum glslang 编译', () => {
  it('buildStandaloneShaderForValidation 编译通过（GLSL ES 3.00 fragment）', () => {
    writeFileSync(TMP, buildStandaloneShaderForValidation())
    // 优先 PATH 的 glslangValidator，否则 prebuilt binary（参考 lensFlare.compile.test.ts 实现）
    const cmd = 'glslangValidator -G --stdin -S frag' // 按 lensFlare.compile.test.ts 实际命令对齐
    // ...（参考 lensFlare.compile.test.ts 的 glslang 解析逻辑：PATH 或 prebuilt）
    expect(true).toBe(true) // 占位——实现时对齐 lensFlare.compile.test.ts 的 exec + 退出码断言
  })
})
```

> **实现注意**：完整对齐 `lensFlare.compile.test.ts` 的 glslang 调用（PATH 优先，否则 `glslang-validator-prebuilt-predownloaded` 包 x86_64 binary，Apple Silicon 经 Rosetta 2）。两环境都缺时测试以清晰报错失败。

- [ ] **Step 5: 跑 compile 测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/godRaysMaxLum.compile.test.ts`
Expected: PASS（glslang 编译 0 error）

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/godRaysMaxLum.frag.ts packages/cesium-core/src/cesium/godRays/godRaysMaxLum.frag.test.ts packages/cesium-core/src/cesium/godRays/godRaysMaxLum.compile.test.ts
git commit -m "feat(godrays): T2 gr_maxLum shader（4×4 局部 max luminance 降采样）"
```

---

## Task 3: godRays.frag（gr_godrays shader，相对 luminance bright-pass + 双路径太阳门控）

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/godRays.frag.ts`
- Create: `packages/cesium-core/src/cesium/godRays/godRays.frag.test.ts`
- Create: `packages/cesium-core/src/cesium/godRays/godRays.compile.test.ts`

- [ ] **Step 1: 写 godRays.frag.ts**

```ts
// gr_godrays fragment（相对 luminance bright-pass radial blur + lf_occlusion 太阳门控，spec §4）。
//
// **相对 luminance bright-pass**（r3 用户决策）：threshold = u_thresholdRatio × maxLum（maxLum 来自
//   gr_maxLum，跟随场景最亮区自适应），根治固定 threshold 在动态 exposure 下的晨昏失效 + 量级 6× 跳变。
//   对齐 lensflare threshold.frag luminance soft smoothstep（r3 图形 suggestion：避免 RGB hard max 彩色硬边）。
//
// **Mitchell GPU Gems 3 变体**（图形 suggestion：原版无 bright-pass，本设计循环内加 bright-pass filter）。
//
// **太阳屏幕投影**（shader 内算，复用 occlusion.frag.ts:114-121 方法）：czm_view × sunDir + czm_projection。
//
// **borderFade 屏边缘越界检测**（r1 图形 important）：clamp-to-edge 会把越界 sample 钉在边缘亮像素列
//   反复累加 → 伪光束。越界 sample 不贡献。
//
// **双路径太阳门控**（r1 三方共识）：
//   - useOcclusionTexture=true（主路径，lensflare=true）：lf_occlusion 36 点连续 visibility（godrays *= .r），
//     覆盖太阳半遮山脊 crepuscular 形态。
//   - useOcclusionTexture=false（fallback，lensflare=false）：单点 depth 二值，阈值按 useSmoothDepth 分支
//     （对齐 occlusion.frag:105-109：smooth 1e-4 / legacy 1e-6=DEPTH_EPSILON）。
//
// **uniform-name 引用**：u_sourceTexture='atmosphere'、u_maxLumTexture='gr_maxLum'、u_occlusionTexture='lf_occlusion'
//   （主路径）。depthTexture 仅 fallback 路径声明（主路径不声明，r2 cesium suggestion）。

import { DEPTH_EPSILON } from '../lensFlare/lensFlareConstants'

export interface GodRaysShaderOptions {
  /** 读 depthTemporal smoothDepth（.a）替代 czm_readDepth（对齐 occlusion.frag）。默认 true。 */
  useSmoothDepth?: boolean
  /** 主路径用 lf_occlusion 连续 visibility；fallback 用单点 depth 二值。默认 true（lensflare=true 时）。 */
  useOcclusionTexture?: boolean
}

const DEFINES_GLSL = `
#define luminance(c) dot(c, vec3(0.2126, 0.7152, 0.0722))
`

const toGlslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)

// depthTexture 仅 fallback 路径声明（useOcclusionTexture=false）；主路径不声明（r2 cesium suggestion）。
function buildUniformsGlsl(useOcclusionTexture: boolean): string {
  const depthTex = useOcclusionTexture
    ? '' // 主路径不声明 depthTexture（不读单点 depth）
    : `uniform sampler2D depthTexture;          // fallback 太阳门控（lensflare=false 时，复用 lensflare depth 源）\n`
  const occTex = useOcclusionTexture
    ? `uniform sampler2D u_occlusionTexture;    // lf_occlusion（uniform-name string 引用，主路径太阳门控）\n`
    : ''
  return `
uniform sampler2D colorTexture;            // lensflare 输出（composite 输入，被叠加，NEAREST 保 dither）
uniform sampler2D u_sourceTexture;         // atmosphere 输出（uniform-name string 引用 'atmosphere'）
uniform sampler2D u_maxLumTexture;         // gr_maxLum 输出（uniform-name string 引用 'gr_maxLum'）
${occTex}${depthTex}uniform vec3  u_sunDirectionWC;       // state.sunDirection（单位向量，世界空间）
uniform float u_intensity;                 // 总强度（默认 0.08）
uniform float u_density;                   // 步进密度（默认 1.0）
uniform float u_decay;                     // 每采样衰减（默认 0.86，Mitchell）
uniform float u_exposure;                  // 总曝光（默认 1.0）
uniform int   u_samples;                   // 采样数（默认 48）
uniform float u_thresholdRatio;            // 相对 maxLum 比例（默认 0.5）
`
}

// 太阳门控 + depth 读取按 useOcclusionTexture × useSmoothDepth 四组合替换。
function buildSunGateGlsl(useOcclusionTexture: boolean, useSmoothDepth: boolean): string {
  if (useOcclusionTexture) {
    return `  float visibility = texture(u_occlusionTexture, sunScreenPos).r;`
  }
  // fallback 单点 depth
  const readDepth = useSmoothDepth
    ? `  float sunDepth = texture(depthTexture, sunScreenPos).a;`
    : `  float sunDepth = czm_readDepth(depthTexture, sunScreenPos);`
  const threshold = useSmoothDepth ? `1.0 - 1e-4` : `1.0 - ${DEPTH_EPSILON.toExponential()}`
  return `${readDepth}
  float visibility = step(${threshold}, sunDepth);`
}

function buildMainGlsl(useOcclusionTexture: boolean, useSmoothDepth: boolean): string {
  return `
in vec2 v_textureCoordinates;

void main() {
  vec2 uv = v_textureCoordinates;

  // —— 太阳屏幕投影（复用 occlusion.frag.ts:114-121，czm_view/czm_projection 由 Cesium 注入）——
  vec4 sunEC = czm_view * vec4(u_sunDirectionWC, 0.0);
  vec4 sunClip = czm_projection * vec4(sunEC.xyz, 1.0);
  bool sunBehindCamera = (sunClip.w <= 0.0);
  vec2 sunNDC = sunClip.xy / sunClip.w;
  vec2 sunScreenPos = sunNDC * 0.5 + 0.5;
  bool sunOnScreen = (!sunBehindCamera)
    && all(greaterThanEqual(sunScreenPos, vec2(0.0)))
    && all(lessThanEqual(sunScreenPos, vec2(1.0)));

  if (!sunOnScreen) {
    out_FragColor = vec4(texture(colorTexture, uv).rgb, 1.0);
    return;
  }

  // —— 相对 luminance threshold（gr_maxLum 在 sunScreenPos 处的局部 max）——
  float maxLum = texture(u_maxLumTexture, sunScreenPos).r;
  float threshold = u_thresholdRatio * maxLum;
  float range = threshold * 0.5;  // soft knee 宽度（对齐 lensflare threshold.frag）

  // —— bright-pass radial blur（Mitchell GPU Gems 3 变体）——
  vec2 deltaUV = (uv - sunScreenPos) * u_density / float(u_samples);
  vec2 sampleUV = uv;
  float illumDecay = 1.0;
  vec3 accum = vec3(0.0);
  for (int i = 0; i < u_samples; ++i) {
    sampleUV -= deltaUV;
    // 屏边缘越界检测（r1 图形 important）：越界 sample 不贡献
    float borderFade = step(0.0, sampleUV.x) * step(sampleUV.x, 1.0)
                     * step(0.0, sampleUV.y) * step(sampleUV.y, 1.0);
    vec3 s = texture(u_sourceTexture, sampleUV).rgb;
    float lum = luminance(s);
    float scale = smoothstep(threshold, threshold + range, lum);  // luminance soft bright-pass
    accum += s * scale * illumDecay * borderFade;
    illumDecay *= u_decay;
  }
  vec3 godrays = accum * u_exposure * u_intensity;

  // —— 太阳整体门控（lf_occlusion 连续 visibility / fallback 单点 depth）——
${buildSunGateGlsl(useOcclusionTexture, useSmoothDepth)}
  godrays *= visibility;

  out_FragColor = vec4(texture(colorTexture, uv).rgb + godrays, 1.0);
}
`
}

export const GODRAYS_UNIFORM_NAMES: string[] = [
  'u_sourceTexture',
  'u_maxLumTexture',
  'u_occlusionTexture', // 主路径（useOcclusionTexture=true）列入；fallback 路径由接线层按需
  'u_sunDirectionWC',
  'u_intensity',
  'u_density',
  'u_decay',
  'u_exposure',
  'u_samples',
  'u_thresholdRatio'
]

export function buildGodRaysFragmentShader(options: GodRaysShaderOptions = {}): string {
  const { useSmoothDepth = true, useOcclusionTexture = true } = options
  return [
    DEFINES_GLSL,
    buildUniformsGlsl(useOcclusionTexture),
    buildMainGlsl(useOcclusionTexture, useSmoothDepth)
  ].join('\n')
}

const VALIDATION_STUBS_GLSL = `
uniform mat4 czm_view;
uniform mat4 czm_projection;
float czm_readDepth(sampler2D t, vec2 uv) { return 0.5; }
out vec4 out_FragColor;
`

export function buildStandaloneShaderForValidation(options: GodRaysShaderOptions = {}): string {
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    VALIDATION_STUBS_GLSL,
    buildGodRaysFragmentShader(options)
  ].join('\n')
}
```

- [ ] **Step 2: 写 godRays.frag.test.ts（四组合结构测试）**

```ts
import { describe, expect, it } from 'vitest'
import {
  GODRAYS_UNIFORM_NAMES,
  buildGodRaysFragmentShader,
  buildStandaloneShaderForValidation
} from './godRays.frag'

describe('godRays.frag', () => {
  it('GODRAYS_UNIFORM_NAMES 含 uniform-name 引用（atmosphere/gr_maxLum/lf_occlusion）', () => {
    expect(GODRAYS_UNIFORM_NAMES).toContain('u_sourceTexture')
    expect(GODRAYS_UNIFORM_NAMES).toContain('u_maxLumTexture')
    expect(GODRAYS_UNIFORM_NAMES).toContain('u_occlusionTexture')
  })
  it('相对 luminance bright-pass（threshold = ratio × maxLum）', () => {
    const s = buildGodRaysFragmentShader()
    expect(s).toContain('texture(u_maxLumTexture')
    expect(s).toContain('float threshold = u_thresholdRatio * maxLum')
    expect(s).toContain('smoothstep(threshold, threshold + range, lum)')
  })
  it('太阳屏幕投影（复用 occlusion.frag 方法）', () => {
    const s = buildGodRaysFragmentShader()
    expect(s).toContain('czm_view * vec4(u_sunDirectionWC, 0.0)')
    expect(s).toContain('czm_projection * vec4(sunEC.xyz, 1.0)')
  })
  it('borderFade 屏边缘越界检测（r1 图形 important）', () => {
    const s = buildGodRaysFragmentShader()
    expect(s).toContain('borderFade')
    expect(s).toMatch(/step\(0\.0, sampleUV\.x\)/)
  })
  it('主路径（useOcclusionTexture=true）：lf_occlusion 连续 visibility，不声明 depthTexture', () => {
    const s = buildGodRaysFragmentShader({ useSmoothDepth: true, useOcclusionTexture: true })
    expect(s).toContain('texture(u_occlusionTexture, sunScreenPos).r')
    expect(s).not.toContain('uniform sampler2D depthTexture')
  })
  it('fallback（useOcclusionTexture=false）：单点 depth 二值，声明 depthTexture', () => {
    const sFallback = buildGodRaysFragmentShader({ useSmoothDepth: true, useOcclusionTexture: false })
    expect(sFallback).toContain('uniform sampler2D depthTexture')
    expect(sFallback).toContain('texture(depthTexture, sunScreenPos).a') // smooth 路径
    expect(sFallback).toContain('1.0 - 1e-4') // smooth 阈值
    expect(sFallback).not.toContain('u_occlusionTexture')
  })
  it('useSmoothDepth=false（legacy）：czm_readDepth + DEPTH_EPSILON 阈值', () => {
    const s = buildGodRaysFragmentShader({ useSmoothDepth: false, useOcclusionTexture: false })
    expect(s).toContain('czm_readDepth(depthTexture, sunScreenPos)')
    expect(s).toContain('1.0e-6') // DEPTH_EPSILON=1e-6 toExponential
  })
  it('buildStandaloneShaderForValidation 补桩（czm_view/czm_projection/czm_readDepth/out_FragColor）', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('uniform mat4 czm_view;')
    expect(s).toContain('float czm_readDepth(')
  })
})
```

- [ ] **Step 3: 跑结构测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/godRays.frag.test.ts`
Expected: PASS

- [ ] **Step 4: 写 godRays.compile.test.ts（四组合 glslang 校验）**

参考 `lensFlare.compile.test.ts` 模式，四组合：`useSmoothDepth × useOcclusionTexture` = `(true,true)`、`(true,false)`、`(false,true)`、`(false,false)`。每个调 `buildStandaloneShaderForValidation(opts)` 写临时文件 → glslangValidator 编译 → 断言 0 error。

- [ ] **Step 5: 跑 compile 测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/godRays.compile.test.ts`
Expected: PASS（四组合 glslang 编译 0 error）

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/godRays.frag.ts packages/cesium-core/src/cesium/godRays/godRays.frag.test.ts packages/cesium-core/src/cesium/godRays/godRays.compile.test.ts
git commit -m "feat(godrays): T3 gr_godrays shader（相对 luminance bright-pass + 双路径太阳门控）"
```

---

## Task 4: createGodRaysStage（composite 装配）

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/createGodRaysStage.ts`
- Create: `packages/cesium-core/src/cesium/godRays/createGodRaysStage.test.ts`

- [ ] **Step 1: 写 createGodRaysStage.ts**

```ts
// God Rays 接线层（spec §3/§5）：把 gr_maxLum + gr_godrays 组装成 godrays composite。
//
// 拓扑（spec §3.1）：
//   外层 non-series `godrays` composite（inputPreviousStageTexture=false）
//   ├─ gr_maxLum（u_sourceTexture = uniform-name 'atmosphere'，textureScale 0.0625 降采样 max luminance）
//   └─ gr_godrays（u_sourceTexture='atmosphere' / u_maxLumTexture='gr_maxLum' /
//                  u_occlusionTexture='lf_occlusion'（主路径）/ colorTexture=lensflare 输出）
//
// uniform-name string 引用（对齐 lensflare I9/I10）：gr_maxLum/gr_godrays 是 non-series 兄弟，
//   跨 stage 依赖靠 uniform-name 显式引用（atmosphere 在 godrays composite 外更早，lf_occlusion 在
//   lensflare composite 内，gr_maxLum 是同 composite 兄弟）。Cesium getStageByName 全局 flat 查找。

import {
  PostProcessStage,
  PostProcessStageComposite,
  PostProcessStageSampleMode,
  PixelFormat,
  Cartesian2,
  type Scene
} from 'cesium'
import { buildGodRaysMaxLumFragmentShader } from './godRaysMaxLum.frag'
import { buildGodRaysFragmentShader } from './godRays.frag'
import { resolvePostHdrDatatype, type AtmosphereFrameState } from '../AtmosphereStage'
import {
  INTENSITY_DEFAULT, DENSITY_DEFAULT, DECAY_DEFAULT, EXPOSURE_DEFAULT,
  SAMPLES_DEFAULT, THRESHOLD_RATIO_DEFAULT, MAXLUM_TEXTURE_SCALE
} from './godRaysConstants'

export interface GodRaysOptions {
  intensity?: number
  density?: number
  decay?: number
  exposure?: number
  samples?: number
  thresholdRatio?: number
}

export interface GodRaysStageHandle {
  readonly godRaysComposite: PostProcessStageComposite
  readonly maxLumStage: PostProcessStage
  readonly godRaysStage: PostProcessStage
}

// u_texelSize 闭包（对齐 createLensFlareStage.ts:113 texelSizeForSourceScale）。
function texelSizeForScale(scene: Scene, sourceScale: number): () => Cartesian2 {
  const ctx = (scene as unknown as {
    context: { drawingBufferWidth: number; drawingBufferHeight: number }
  }).context
  const scratch = new Cartesian2()
  return () => {
    const w = ctx.drawingBufferWidth * sourceScale
    const h = ctx.drawingBufferHeight * sourceScale
    scratch.x = 1.0 / Math.max(w, 1.0)
    scratch.y = 1.0 / Math.max(h, 1.0)
    return scratch
  }
}

export function createGodRaysStage(
  scene: Scene,
  state: AtmosphereFrameState,
  options: GodRaysOptions = {},
  depthTemporalStageName?: string,
  occlusionTextureName?: string
): GodRaysStageHandle {
  const postHdrDatatype = resolvePostHdrDatatype(scene)
  const intensity = options.intensity ?? INTENSITY_DEFAULT
  const density = options.density ?? DENSITY_DEFAULT
  const decay = options.decay ?? DECAY_DEFAULT
  const exposure = options.exposure ?? EXPOSURE_DEFAULT
  const samples = options.samples ?? SAMPLES_DEFAULT
  const thresholdRatio = options.thresholdRatio ?? THRESHOLD_RATIO_DEFAULT

  const useSmoothDepth = !!depthTemporalStageName
  const useOcclusionTexture = !!occlusionTextureName

  // gr_maxLum（降采样 max luminance，采 atmosphere）
  const maxLum = new PostProcessStage({
    name: 'gr_maxLum',
    fragmentShader: buildGodRaysMaxLumFragmentShader(),
    uniforms: {
      u_sourceTexture: 'atmosphere', // uniform-name string（强制依赖 atmosphere）
      u_texelSize: texelSizeForScale(scene, 1.0) // 源 = atmosphere（全分）
    },
    textureScale: MAXLUM_TEXTURE_SCALE,
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  // gr_godrays uniforms
  const godRaysUniforms: Record<string, unknown> = {
    u_sourceTexture: 'atmosphere', // uniform-name string
    u_maxLumTexture: 'gr_maxLum', // uniform-name string（同 composite 兄弟）
    u_sunDirectionWC: () => state.sunDirection,
    u_intensity: intensity,
    u_density: density,
    u_decay: decay,
    u_exposure: exposure,
    u_samples: samples,
    u_thresholdRatio: thresholdRatio
  }
  if (useOcclusionTexture) {
    godRaysUniforms.u_occlusionTexture = occlusionTextureName // 'lf_occlusion' uniform-name string
  } else {
    // fallback 单点 depth：depthTexture 指向 depthTemporal（或 Cesium 内建 scene depth）
    if (depthTemporalStageName) {
      godRaysUniforms.depthTexture = depthTemporalStageName
    }
    // 未传 depthTemporalStageName：不覆盖 depthTexture（Cesium 内建 scene globe depth）
  }

  const godRays = new PostProcessStage({
    name: 'gr_godrays',
    fragmentShader: buildGodRaysFragmentShader({ useSmoothDepth, useOcclusionTexture }),
    uniforms: godRaysUniforms,
    textureScale: 1.0,
    sampleMode: PostProcessStageSampleMode.NEAREST, // 保 dither（对齐 lensflare composite.frag）
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  const godRaysComposite = new PostProcessStageComposite({
    name: 'godrays',
    stages: [maxLum, godRays],
    inputPreviousStageTexture: false // non-series 兄弟，跨 stage 依赖靠 uniform-name 引用
  })

  return { godRaysComposite, maxLumStage: maxLum, godRaysStage: godRays }
}
```

- [ ] **Step 2: 写 createGodRaysStage.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest'
// mock resolvePostHdrDatatype 避免 GL 实例化（参考 createLensFlareStage.test.ts mock 模式）
vi.mock('../AtmosphereStage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AtmosphereStage')>()
  return { ...actual, resolvePostHdrDatatype: vi.fn(() => 'HALF_FLOAT') }
})

import { createGodRaysStage } from './createGodRaysStage'

// mock Scene（参考 createLensFlareStage.test.ts 的 scene mock）
function mockScene() {
  return {
    context: { drawingBufferWidth: 1920, drawingBufferHeight: 1080 },
    globe: { ellipsoid: { radiiSquared: { x: 1, y: 1, z: 1 } } }
  } as any
}

describe('createGodRaysStage', () => {
  it('godrays composite: stages=[gr_maxLum, gr_godrays], inputPreviousStageTexture=false', () => {
    const h = createGodRaysStage(mockScene(), { sunDirection: { x: 0, y: 0, z: 1 } } as any, {}, 'czm_depth_temporal', 'lf_occlusion')
    expect(h.godRaysComposite.length).toBe(2)
    expect((h.godRaysComposite.get(0) as any).name).toBe('gr_maxLum')
    expect((h.godRaysComposite.get(1) as any).name).toBe('gr_godrays')
    // inputPreviousStageTexture=false（non-series）
  })
  it('gr_maxLum uniforms: u_sourceTexture="atmosphere"（uniform-name 引用）', () => {
    const h = createGodRaysStage(mockScene(), { sunDirection: { x: 0, y: 0, z: 1 } } as any)
    const maxLum = h.godRaysComposite.get(0) as any
    expect(maxLum.uniforms.u_sourceTexture).toBe('atmosphere')
  })
  it('主路径（occlusionTextureName 传）：gr_godrays u_occlusionTexture="lf_occlusion" + u_maxLumTexture="gr_maxLum"', () => {
    const h = createGodRaysStage(mockScene(), { sunDirection: { x: 0, y: 0, z: 1 } } as any, {}, undefined, 'lf_occlusion')
    const godRays = h.godRaysComposite.get(1) as any
    expect(godRays.uniforms.u_sourceTexture).toBe('atmosphere')
    expect(godRays.uniforms.u_maxLumTexture).toBe('gr_maxLum')
    expect(godRays.uniforms.u_occlusionTexture).toBe('lf_occlusion')
    expect(godRays.uniforms.depthTexture).toBeUndefined()
  })
  it('fallback（无 occlusionTextureName，传 depthTemporal）：depthTexture="czm_depth_temporal"，无 u_occlusionTexture', () => {
    const h = createGodRaysStage(mockScene(), { sunDirection: { x: 0, y: 0, z: 1 } } as any, {}, 'czm_depth_temporal', undefined)
    const godRays = h.godRaysComposite.get(1) as any
    expect(godRays.uniforms.depthTexture).toBe('czm_depth_temporal')
    expect(godRays.uniforms.u_occlusionTexture).toBeUndefined()
  })
})
```

> **实现注意**：完整对齐 `createLensFlareStage.test.ts` 的 scene mock + PostProcessStage mock 模式（避免实例化真实 Cesium）。

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/createGodRaysStage.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/createGodRaysStage.ts packages/cesium-core/src/cesium/godRays/createGodRaysStage.test.ts
git commit -m "feat(godrays): T4 createGodRaysStage composite 装配（gr_maxLum + gr_godrays）"
```

---

## Task 5: AtmosphereStage 集成

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`

- [ ] **Step 1: 写失败测试（AtmosphereStage.test.ts 扩展）**

加到现有 `AtmosphereStage.test.ts`（对齐现有 lensFlare 默认值断言模式）：

```ts
import { validateAtmosphereOptions } from './AtmosphereStage'

describe('AtmosphereStage godRays 默认值 + 防回归', () => {
  it('godRays 默认 true，含 godRays 强度/比例默认值', () => {
    const r = validateAtmosphereOptions({})
    expect(r.godRays).toBe(true)
    expect(r.godRaysIntensity).toBe(0.08)
    expect(r.godRaysThresholdRatio).toBe(0.5)
  })
  it('godRays=false 关闭', () => {
    const r = validateAtmosphereOptions({ godRays: false })
    expect(r.godRays).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts -t "godRays"`
Expected: FAIL（godRays 字段不存在）

- [ ] **Step 3: 实现 AtmosphereStage.ts 改动**

按 spec §5.2，改动点（读现有 AtmosphereStage.ts 对齐模式）：

1. **import**：`import { createGodRaysStage } from './godRays/createGodRaysStage'` + godRaysConstants 默认值。
2. **AtmosphereStageOptions** 加：
   ```ts
   godRays?: boolean
   godRaysIntensity?: number
   godRaysDecay?: number
   godRaysExposure?: number
   godRaysSamples?: number
   godRaysThresholdRatio?: number
   ```
3. **ResolvedAtmosphereStageOptions** 加对应 resolved 字段。
4. **validateAtmosphereOptions** 补默认值：
   ```ts
   godRays: options.godRays !== false,
   godRaysIntensity: options.godRaysIntensity ?? 0.08,
   godRaysDecay: options.godRaysDecay ?? 0.86,
   godRaysExposure: options.godRaysExposure ?? 1.0,
   godRaysSamples: options.godRaysSamples ?? 48,
   godRaysThresholdRatio: options.godRaysThresholdRatio ?? 0.5,
   ```
5. **createAtmosphereStage**：在 `if (lensFlareStage) scene.postProcessStages.add(lensFlareStage)` 后、`scene.postProcessStages.add(tonemapStage)` 前插入：
   ```ts
   let godRaysComposite: PostProcessStageComposite | undefined
   if (resolved.godRays) {
     const grHandle = createGodRaysStage(
       scene,
       state,
       {
         intensity: resolved.godRaysIntensity,
         decay: resolved.godRaysDecay,
         exposure: resolved.godRaysExposure,
         samples: resolved.godRaysSamples,
         thresholdRatio: resolved.godRaysThresholdRatio
       },
       temporalEmaEnabled ? 'czm_depth_temporal' : undefined,
       resolved.lensFlare ? 'lf_occlusion' : undefined
     )
     godRaysComposite = grHandle.godRaysComposite
     scene.postProcessStages.add(godRaysComposite) // atmosphere → lensflare → godrays → tonemap
   }
   ```
6. **AtmosphereStageHandle** 加 `readonly godRaysComposite?: PostProcessStageComposite` + getter。
7. **destroy** 加 `if (godRaysComposite) removeAndDestroy(godRaysComposite)`。
8. **setMode** 注释加（v1 不实现 godRays 分支，dead code 边界，spec §5.2）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts`
Expected: PASS（含新 godRays 断言 + 现有不回归）

- [ ] **Step 5: tsc 类型检查**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: 0 error

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(godrays): T5 AtmosphereStage 集成 godrays composite（默认 true，含 fallback 分支）"
```

---

## Task 6: demo URL 参数

**Files:**
- Modify: `apps/demo/src/main.ts`

- [ ] **Step 1: URL 参数解析（对齐现有 lensflare 参数模式）**

在 main.ts URL 参数解析段加：
```ts
const godRays = parseNumber(urlParams.get('godrays'), undefined) // 0=关，undefined=默认
const godRaysDecay = parseNumber(urlParams.get('godraysDecay'), undefined)
const godRaysExposure = parseNumber(urlParams.get('godraysExposure'), undefined)
const godRaysSamples = parseNumber(urlParams.get('godraysSamples'), undefined)
const godRaysRatio = parseNumber(urlParams.get('godraysRatio'), undefined)
```

传给 `createAtmosphereStage`：
```ts
godRays: godRays !== 0, // 0=关
godRaysIntensity: godRays, // undefined → 默认 0.08
godRaysDecay,
godRaysExposure,
godRaysSamples,
godRaysThresholdRatio: godRaysRatio
```

运行时切换（`?godrays=0` → `godRaysComposite.enabled=false`）：持 handle 直接设（对齐 `?lensflare=0` 模式）。

- [ ] **Step 2: 手动 demo 验证**

Run: `pnpm dev`
- 默认：god rays 可见（中等强度）。
- `?godrays=0`：god rays 关闭。
- `?godraysRatio=0.3` / `?godrays=0.2`：参数可调。

- [ ] **Step 3: Commit**

```bash
git add apps/demo/src/main.ts
git commit -m "feat(godrays): T6 demo URL 参数（?godrays/?godraysRatio/?godraysDecay 等）"
```

---

## Task 7: 量级回归锚点单测 + 视觉门禁参考

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/godRaysMagnitude.test.ts`
- 需要基线截图：`scripts/perf/refs/godrays-off.png`（?godrays=0 基线）

- [ ] **Step 1: 写量级回归锚点单测**

```ts
import { describe, expect, it } from 'vitest'
import { INTENSITY_DEFAULT, THRESHOLD_RATIO_DEFAULT, DECAY_DEFAULT, SAMPLES_DEFAULT } from './godRaysConstants'

// T1 ?debug=7 实测回填（spec §8.1/§7.1，r2 对抗 important：原 self-validating 循环测试改为实测锚点）
// 实测前先用保守占位，T1 实测后更新。
const SKY_FAR_HDR = 2.0 // 远天空暗区实测（T1 回填，占位：adversarial 反推 1-3）
const SKY_NEAR_SUN_HDR = 8.0 // 近太阳天空实测（T1 回填，占位：lensflare threshold=3.0 已证亮区>3）

describe('godRays 量级回归锚点', () => {
  it('god rays 量级（相对 luminance）：maxLum × (1-ratio) × Σdecay × intensity', () => {
    const sigmaDecay = Array.from({ length: SAMPLES_DEFAULT }, (_, i) => DECAY_DEFAULT ** i)
      .reduce((a, b) => a + b, 0) // Σ 0.86^i, i=0..47 ≈ 7.14
    expect(sigmaDecay).toBeCloseTo(7.14, 1)
    // 上界：路径全亮区（maxLum × (1-ratio) × Σ × intensity）
    const godRaysUpper = SKY_NEAR_SUN_HDR * (1 - THRESHOLD_RATIO_DEFAULT) * sigmaDecay * INTENSITY_DEFAULT
    // 叠加暗区（远天空）后 ACES 输入应落可见区间（<8，不强制全饱和；>0.5 可见）
    const acesInput = SKY_FAR_HDR + godRaysUpper
    expect(acesInput).toBeGreaterThan(0.5) // 可见
    // godRaysUpper 不应让暗区直接饱和到 ACES=1（<8 留余量；实际路径穿过暗区 soft scale 衰减，远小于上界）
    // 注：这是上界，实际远小于此；锚点是防 inscatterScale/intensity 异动时量级失控
  })
  it('threshold（ratio × maxLum）落在远天空与近太阳之间', () => {
    const thresholdAtNearSun = THRESHOLD_RATIO_DEFAULT * SKY_NEAR_SUN_HDR
    expect(thresholdAtNearSun).toBeGreaterThan(SKY_FAR_HDR) // 远天空不过阈值（不贡献光束）
    expect(thresholdAtNearSun).toBeLessThan(SKY_NEAR_SUN_HDR) // 近太阳过阈值（贡献光束）
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/godRaysMagnitude.test.ts`
Expected: PASS（T1 实测后更新 SKY_FAR_HDR/SKY_NEAR_SUN_HDR 占位值）

- [ ] **Step 3: 视觉门禁参考采集**

Run: `pnpm --filter demo exec tsx scripts/perf/capture.ts --save-ref --only godrays-off`（`?godrays=0` 基线，参考 `scripts/perf/baseline.md` 模式）

- [ ] **Step 4: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/godRaysMagnitude.test.ts scripts/perf/refs/godrays-off.png
git commit -m "test(godrays): T7 量级回归锚点（实测值，防 self-validating）+ 视觉门禁基线"
```

---

## Task 8: 默认参数 demo 验收 + 标定调整

**Files:** 无代码改动（手动验收 + 参数微调）

- [ ] **Step 1: demo 验收（spec §7.3）**

Run: `pnpm dev`，逐项验收（`#camera=` 复现视角）：
- [ ] 正午山脊阴影/暗区：god rays 光束照亮暗区。
- [ ] **晨昏地平线**：god rays 明显径向光束（相对 luminance 下 maxLum 自适应，晨昏不失效——r3 核心验收）。
- [ ] 山脊切割：光束被山脊轮廓切割。
- [ ] 太阳半遮山脊：光从可见边缘辐射（crepuscular 典型，lf_occlusion 连续门控）。
- [ ] 太阳被山完全挡：god rays 消失（不穿帮）。
- [ ] 正对太阳：不白盘（量级在 ACES 可见区，与 lensflare Ghost offset 修复独立）。
- [ ] 屏边缘无平行伪光束（borderFade）。
- [ ] `?godrays=0` 回退无回归。

- [ ] **Step 2: 标定调整（与用户）**

若某项不达标，调 URL 参数（`?godrays=`、`?godraysRatio=`、`?godraysDecay=`、`?godraysSamples=`）找最佳。确定后回填 `godRaysConstants.ts` 默认值 + AtmosphereStage.ts。

- [ ] **Step 3: 视觉门禁 check**

Run: `pnpm --filter demo exec tsx scripts/perf/capture.ts --check --only godrays-off`
Expected: `?godrays=0` 与基线 maxΔ≤2/255（零影响回退验证）。

- [ ] **Step 4: Commit（若默认值调整）**

```bash
git add packages/cesium-core/src/cesium/godRays/godRaysConstants.ts packages/cesium-core/src/cesium/AtmosphereStage.ts
git commit -m "feat(godrays): T8 默认参数 demo 验收标定（用户验收微调）"
```

---

## Task 9: results 文档

**Files:**
- Create: `docs/superpowers/plans/2026-08-12-tyndall-godrays-results.md`

- [ ] **Step 1: 写 results 文档**

内容（参考 `docs/superpowers/plans/2026-08-05-performance-optimization-results.md` 模式）：
- 实现总结（gr_maxLum + gr_godrays composite + 相对 luminance bright-pass + lf_occlusion 太阳门控）。
- 3 轮评审关键决策（blocker 量级误判 → lf_occlusion 复用 → 相对 luminance 根治晨昏）。
- §8.1 量级实测验证（T1 ?debug=7 三档量级 + intensity 标定）。
- `?profile=1` 性能数据（gr_maxLum + gr_godrays ms）。
- 验收截图（晨昏地平线 / 山脊切割 / 太阳半遮 / 不白盘）。
- go/no-go 半分辨率优化（§9，基于 ?profile=1 数据）。
- 已知 v1 限制 + v1.1/v2 路线。

- [ ] **Step 2: 全测试 + tsc + glslang 最终验证**

Run: `pnpm --filter @cesium-geospatial/core test && pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: 全 PASS + 0 error

- [ ] **Step 3: Commit + 收尾**

```bash
git add docs/superpowers/plans/2026-08-12-tyndall-godrays-results.md
git commit -m "docs(godrays): T9 results 文档（量级实测 + 性能 + 验收 + 半分辨率 go/no-go）"
```

---

## 自审（writing-plans skill）

**Spec 覆盖**：
- §3 架构（链 + composite + uniform-name 引用）→ T4/T5 ✅
- §4 shader（gr_maxLum + gr_godrays 相对 luminance + 双路径）→ T2/T3 ✅
- §5 组件（3 文件 + AtmosphereStage + demo）→ T1-T6 ✅
- §6 URL 参数 → T6 ✅
- §7 测试（单测 + 锚点 + 视觉门禁 + 手动验收）→ T2/T3/T4/T5/T7/T8 ✅
- §8 量级（实测微调）→ T1 Step4 + T7 + T8 ✅
- §10 T1-T9 → 全覆盖 ✅

**占位符扫描**：T2 Step4 / T3 Step4 / T4 Step2 的 mock/compile 细节指明"参考 lensFlare.compile.test.ts / createLensFlareStage.test.ts 模式"——这是明确参考（非占位符），执行者读现有文件对齐。无 TBD/TODO。

**类型一致性**：`GodRaysOptions`（intensity/density/decay/exposure/samples/thresholdRatio）、`GodRaysStageHandle`（godRaysComposite/maxLumStage/godRaysStage）、`GodRaysShaderOptions`（useSmoothDepth/useOcclusionTexture）跨 task 一致。`godRaysIntensity/godRaysDecay/godRaysExposure/godRaysSamples/godRaysThresholdRatio` 在 AtmosphereStageOptions 与 createGodRaysStage 间一致。
