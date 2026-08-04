# phase2a HDR 浮点后处理链基建 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 phase1 单 stage 内联 ACES 重构为「大气 stage 输出线性 HalfFloat + 链尾独立 ToneMappingStage（ACES→RGBA8）」两 stage 浮点链，视觉与 phase1 不可区分，为 phase2b image-based LensFlare 提供线性域消费点。

**Architecture:** 新增 `tonemap.frag.ts`（链尾 stage，含 ACES+gamma+dithering + debug=7 HDR 归一化验证），改 `aerialPerspective.frag.ts`（末端输出线性 `finalColor·exposure`、移除内联 ACES、保留 input dithering），改 `AtmosphereStage.ts`（`resolvePostHdrDatatype` 检测 + 建 atmosphere[HalfFloat] + tonemap[RGBA8] 两 stage）。Cesium `PostProcessStage` 链按 add 顺序执行，tonemap 自动读 atmosphere 输出。

**Tech Stack:** Cesium 1.143（`@cesium/engine@26.1.0`）/ WebGL2 / GLSL ES 3.00 / vitest / glslangValidator / pnpm workspace / TypeScript strict。

**Spec:** `docs/superpowers/specs/2026-08-04-phase2a-hdr-pipeline-design.md`（commit `2673375`，含三方评审修订）。

---

## Global Constraints

- **语言**：所有代码注释、文档、对话用中文（遵循全局 + 项目 CLAUDE.md）。
- **GLSL**：WebGL2 / GLSL ES 3.00；运行时 shader 不写 `#version`（Cesium 注入）；`buildStandaloneShaderForValidation` 补 `#version 300 es` + `out_FragColor` 桩供 glslang 校验。
- **测试命令**：
  - 单文件：`pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/<file>.test.ts`
  - 全测：`pnpm -r test`
  - demo tsc：`pnpm --filter demo exec tsc --noEmit`
  - core tsc：`pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
- **NEAREST 钉死**：tonemap stage（及未来中间 stage）必须 `sampleMode: NEAREST`（Cesium 默认，勿显式改 LINEAR）——保护 input dithering 经 HalfFloat RT 中转，否则 phase1 `d0efe87` 修的水波纹回归。
- **参考库定位**：three-geospatial 为主，cesium-clouds-atmosphere 仅 Cesium 适配参考。
- **commit**：中文 conventional commits（`feat(core):` / `test(core):` / `docs:` 等）；每任务结尾 commit。
- **不碰**：DUAL inscatter 主流程（`lookingAtGround`/`baseInscatter`/`foreInscatter`/`mask`）、`reconstructRay`、depth 反演——phase1 闪动/山体修复成果，phase2a 只动末端 tonemap 位置。

---

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/cesium-core/src/cesium/tonemap.frag.ts` | 新增 | 链尾 ToneMapping stage shader 组装：ACES+gamma+display dithering + debug=1..6 透传 + debug=7 线性归一化 |
| `packages/cesium-core/src/cesium/tonemap.frag.test.ts` | 新增 | tonomap shader 组装 + glslang 编译 + uniform 名一致性 |
| `packages/cesium-core/src/cesium/aerialPerspective.frag.ts` | 改 | 末端输出线性；`sky=false` 分支线性；移除 `ACESFilmic`/`tonemapDisplay`；保留 `interleavedGradientNoise`（input dithering）；debug=6 分支加 `< 6.5` 上限（让 debug=7 走正常输出） |
| `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts` | 改 | 去掉 `tonemapDisplay` 断言；加线性输出 + `sky=false` 线性 + `ACESFilmic` 缺失断言 |
| `packages/cesium-core/src/cesium/AtmosphereStage.ts` | 改 | `resolvePostHdrDatatype`；`createAtmosphereStage` 建 atmosphere(HalfFloat)+tonomap 两 stage；`setMode`/`destroy` 管两 stage；`AtmosphereStageHandle` 新字段 |
| `packages/cesium-core/src/cesium/AtmosphereStage.test.ts` | 改 | `resolvePostHdrDatatype` 三分支；双 stage handle；新接口字段 |
| `apps/demo/src/main.ts` | 改（小） | `?hdr=0` 强制 UNSIGNED_BYTE 兜底调试 |
| `docs/superpowers/plans/2026-08-04-phase2a-results.md` | 新增 | 浏览器验收清单（URL + 五项回归 + HDR 验证 + 兜底） |

---

## Task 1: 新增 tonemap.frag.ts（链尾 ToneMapping stage）

**Files:**
- Create: `packages/cesium-core/src/cesium/tonemap.frag.ts`
- Test: `packages/cesium-core/src/cesium/tonemap.frag.test.ts`

**Interfaces:**
- Produces: `buildTonemapFragmentShader(): string`、`buildStandaloneShaderForValidation(): string`、`TONEMAP_UNIFORM_NAMES: string[]`（= `['u_debugMode']`，`colorTexture` 是 Cesium 内建白名单不列入）

- [ ] **Step 1: 写失败测试 `tonemap.frag.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildTonemapFragmentShader,
  buildStandaloneShaderForValidation,
  TONEMAP_UNIFORM_NAMES
} from './tonemap.frag'

describe('buildTonemapFragmentShader（链尾 ToneMapping stage）', () => {
  it('含 ACES + gamma 1/2.2 + display dithering（与 phase1 tonemapDisplay 等价）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('ACESFilmic(')
    expect(s).toContain('pow(t, vec3(1.0 / 2.2))')
    expect(s).toContain('interleavedGradientNoise')
    expect(s).toContain('1.5 / 255.0') // display triangular dithering
  })

  it('debug=1..6 透传（atmosphere 已输出 display ready 可视化值）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('u_debugMode > 0.5')
    expect(s).toMatch(/u_debugMode > 0\.5[^6]*return/) // 透传分支在归一化分支之后
  })

  it('debug=7 线性归一化 false-color（证明 HalfFloat 承载 >1，评审 C2 可证伪方案）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('u_debugMode > 6.5')
    expect(s).toContain('clamp(c.rgb / 5.0, 0.0, 1.0)')
  })

  it('不含 input dithering（input dithering 留 atmosphere stage）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).not.toContain('inDither')
    expect(s).not.toContain('originalColor') // tonomap 读 colorTexture，不碰 originalColor
  })

  it('无 exposure uniform（exposure 在 atmosphere 线性段乘过）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).not.toMatch(/uniform\s+float\s+exposure/)
  })

  it('声明 colorTexture（Cesium 内建，shader 须显式声明）+ u_debugMode', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
    expect(s).toContain('uniform float u_debugMode')
  })
})

describe('TONEMAP_UNIFORM_NAMES', () => {
  it('仅 u_debugMode（colorTexture 是 Cesium 内建白名单）', () => {
    expect(TONEMAP_UNIFORM_NAMES).toEqual(['u_debugMode'])
  })
})

describe('buildStandaloneShaderForValidation（glslang 用）', () => {
  it('以 #version 300 es 开头 + out_FragColor 桩', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败（tonomap.frag.ts 不存在）**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/tonemap.frag.test.ts`
Expected: FAIL — `Failed to resolve import "./tonemap.frag"`

- [ ] **Step 3: 实现 `tonemap.frag.ts`**

```ts
// 链尾 ToneMapping PostProcessStage fragment。
// 读 atmosphere stage 的线性 HDR 输出（HalfFloat 或 RGBA8 兜底），做 ACES + gamma 1/2.2 +
// display triangular dithering → RGBA8 display。与 phase1 aerialPerspective.frag 的 tonemapDisplay
// 视觉等价（ACES 常数/gamma/dithering 系数原样），仅位置移到独立 stage。
//
// ACESFilmic + interleavedGradientNoise 从 aerialPerspective.frag.HELPERS_GLSL 迁来（atmosphere
// 不再需要 ACESFilmic；interleavedGradientNoise 两边各自声明同名纯函数——GLSL 不能跨 stage 共享）。
//
// debug 语义：
// - debug=0：正常 ACES+gamma+dithering。
// - debug=1..6：透传 atmosphere 输出（atmosphere 已算好 0-1 display ready 可视化值）。
// - debug=7：线性归一化 false-color（clamp(c.rgb/5,0,1)）——HalfFloat 设备太阳区 >1 显示亮区，
//   RGBA8 兜底被 clip 到 1.0 显示暗区（0.2），可证伪地证明 HDR 链承载 >1（评审 C2：log 归一化
//   ≤1 两路径都不 clip，无法区分）。
//
// 必须保持 sampleMode: NEAREST（Cesium PostProcessStage 默认）——保护 atmosphere 的 input
// dithering 经 HalfFloat RT 中转逐像素直通；改 LINEAR 会抹掉 dither 噪声 → 水波纹回归。

// 内建纹理 uniform（Cesium 提供值，shader 须显式声明）+ debug 同步 uniform。
const UNIFORMS_GLSL = `
uniform sampler2D colorTexture;
uniform float u_debugMode;
`

// ACESFilmic + interleavedGradientNoise（从 aerialPerspective.frag 迁来，原样）。
const HELPERS_GLSL = `
vec3 ACESFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`

const MAIN_GLSL = `
in vec2 v_textureCoordinates;

void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  if (u_debugMode > 6.5) {
    // debug=7：线性归一化 false-color 证明 HalfFloat 承载 >1（评审 C2 可证伪方案）。
    // HalfFloat：太阳区 finalColor·exposure>1 → 接近 1（亮）；RGBA8 兜底：被 clip 到 1.0 → 0.2（暗）。
    out_FragColor = vec4(clamp(c.rgb / 5.0, 0.0, 1.0), 1.0);
    return;
  }
  if (u_debugMode > 0.5) {
    // debug=1..6 透传（atmosphere 已输出 display ready 可视化值）。
    out_FragColor = c;
    return;
  }
  // ACES filmic + gamma 1/2.2（与 phase1 tonemapDisplay 等价）。
  vec3 t = ACESFilmic(c.rgb);
  t = pow(t, vec3(1.0 / 2.2));
  // display triangular dithering ±1.5 LSB 打散 8-bit output 量化。
  float dither = interleavedGradientNoise(gl_FragCoord.xy)
    + interleavedGradientNoise(gl_FragCoord.xy + vec2(7.11, 5.17)) - 1.0;  // [-1,1] triangular
  t += dither * 1.5 / 255.0;
  out_FragColor = vec4(t, c.a);
}
`

// 供 Task 3 接线一致性测试：tonomap stage 声明的 uniform（colorTexture 是 Cesium 内建白名单）。
export const TONEMAP_UNIFORM_NAMES: string[] = ['u_debugMode']

// 组装 PostProcessStage 用 fragment shader（含 czm_* automatic uniform 引用，仅供 Cesium 运行时）。
export function buildTonemapFragmentShader(): string {
  return [UNIFORMS_GLSL, HELPERS_GLSL, MAIN_GLSL].join('\n')
}

// 供 glslang 独立校验：补 #version 300 es + precision + out_FragColor 桩。
// colorTexture/v_textureCoordinates/u_debugMode 在主体声明，此处仅补 Cesium 运行时注入的 out_FragColor。
const VALIDATION_STUBS_GLSL = `
out vec4 out_FragColor;
`

export function buildStandaloneShaderForValidation(): string {
  return [
    '#version 300 es',
    'precision highp float;',
    VALIDATION_STUBS_GLSL,
    buildTonemapFragmentShader()
  ].join('\n')
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/tonemap.frag.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: glslang 编译校验（在既有 `aerialPerspective.compile.test.ts` 加 tonomap 用例，复用 helper）**

`aerialPerspective.compile.test.ts` 已有 `compileFragment(src)` + `getGlslangValidatorPath()` 私有 helper（见该文件）。在**同一文件**加 tonomap 编译用例（复用 helper，DRY，不重复二进制发现逻辑）：

文件顶部 import 追加（别名避免与 aerialPerspective 的 `buildStandaloneShaderForValidation` 同名冲突）：

```ts
import { buildStandaloneShaderForValidation as buildTonemapStandalone } from './tonomap.frag'
```

在既有 `describe('GLSL 编译验证（glslangValidator，全合法宏组合）')` 内追加 it：

```ts
  it('编译通过：tonomap stage（链尾 ToneMapping）', () => {
    const src = buildTonemapStandalone()
    expect(src.startsWith('#version 300 es')).toBe(true)
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(`glslangValidator 编译失败（tonomap）:
${output}`)
    }
    expect(ok).toBe(true)
  })
```

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`
Expected: PASS（新 tonomap 用例 + 既有 3 组合 + 防回归用例全过）

- [ ] **Step 6: 提交**

```bash
git add packages/cesium-core/src/cesium/tonomap.frag.ts packages/cesium-core/src/cesium/tonomap.frag.test.ts packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts
git commit -m "feat(core): 新增 tonomap.frag 链尾 ToneMapping stage（ACES+gamma+dithering + debug=7 HDR 归一化）"
```

---

## Task 2: 改 aerialPerspective.frag.ts（输出线性 + 移除内联 ACES）

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`
- Test: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`

**Interfaces:**
- Consumes: 无（atmosphere 自身改造）
- Produces: `buildAerialPerspectiveFragmentShader()` 输出线性（末端 `vec4(finalColor*exposure, a)`）；不再含 `ACESFilmic`/`tonemapDisplay`

- [ ] **Step 1: 改测试 `aerialPerspective.frag.test.ts`**

在 `describe('buildAerialPerspectiveFragmentShader...')` 块内：

**删除断言**（phase1 内联 ACES 相关）：
- 删掉任何 `expect(s).toContain('tonemapDisplay(` 断言（若存在）。
- 删掉 `expect(s).toContain('ACESFilmic(')` 断言（ACES 迁到 tonomap）。

**新增/改断言**：
```ts
it('末端输出线性 finalColor·exposure（不再内联 ACES，由链尾 tonomap stage 收尾）', () => {
  const s = buildAerialPerspectiveFragmentShader({})
  expect(s).toContain('out_FragColor = vec4(finalColor * exposure, originalColor.a)')
  expect(s).not.toContain('tonemapDisplay(')
  expect(s).not.toContain('ACESFilmic(') // 已迁到 tonomap.frag
})

it('sky=false 分支也线性输出（否则 tonomapDisplay 移除后编译失败）', () => {
  const s = buildAerialPerspectiveFragmentShader({ sky: false })
  expect(s).toContain('finalColor = originalColor.rgb')
  expect(s).toContain('out_FragColor = vec4(finalColor * exposure, originalColor.a)')
  expect(s).not.toContain('tonemapDisplay(')
})

it('仍含 input dithering（打散 originalColor RGBA8 banding，留在 atmosphere）', () => {
  const s = buildAerialPerspectiveFragmentShader({})
  expect(s).toContain('inDither')
  expect(s).toContain('interleavedGradientNoise') // input dithering 用，保留
})

it('debug=6 分支上限 < 6.5（让 debug=7 走正常线性输出，由 tonomap 归一化验证 HDR）', () => {
  const s = buildAerialPerspectiveFragmentShader({})
  expect(s).toContain('u_debugMode > 5.5 && u_debugMode < 6.5')
})
```

保留 DUAL inscatter 相关断言不动（`lookingAtGround`/`brunetonIntersectsGround`/`hasScene`/`muLook` 等）。

- [ ] **Step 2: 运行测试，确认失败（atmosphere 仍含 tonomapDisplay）**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts`
Expected: FAIL — 新断言失败（仍含 `tonemapDisplay`/`ACESFilmic`，末端未改线性）

- [ ] **Step 3: 改 `aerialPerspective.frag.ts`**

**改动 1 · `HELPERS_GLSL`**（移除 `ACESFilmic` + `tonemapDisplay`，保留 `interleavedGradientNoise`）：

删掉 `HELPERS_GLSL` 里的 `ACESFilmic` 函数和整个 `tonemapDisplay` 函数。**保留** `interleavedGradientNoise` 函数（input dithering 仍用）。改后 `HELPERS_GLSL` 起始应为：
```glsl
const HELPERS_GLSL = `
// interleavedGradientNoise（屏幕空间低频噪声，input dithering 用，无纹理依赖）。
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
// 视线重建：czm_windowToEyeCoordinates 近/远平面差分（源库 reconstructRay）。
...（reconstructRay / rayForwardHitsSphere / cameraInAtmosphereShell 不变）
```
（即只删 `ACESFilmic` 和 `tonemapDisplay` 两个函数，其余 helper 不动。）

**改动 2 · `buildMainFn` 的 `skyBranch`**（`o.sky=false` 分支线性输出）：

把：
```ts
const skyBranch = o.sky
  ? `
    inscatter = getSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, fragmentAngle, transmittance);
`
  : `
    finalColor = originalColor.rgb;
    out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
    return;
`
```
改为：
```ts
const skyBranch = o.sky
  ? `
    inscatter = getSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, fragmentAngle, transmittance);
`
  : `
    finalColor = originalColor.rgb;
    out_FragColor = vec4(finalColor * exposure, originalColor.a);  // 线性，链尾 tonomap 收尾
    return;
`
```

**改动 3 · main 末端**（输出线性）：

把 main 末端的：
```glsl
  out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
```
改为：
```glsl
  out_FragColor = vec4(finalColor * exposure, originalColor.a);  // 线性 HDR，由链尾 tonomap stage 收尾
```

**改动 4 · debug=6 分支上限**（让 debug=7 走正常输出）：

把诊断块里的：
```glsl
  if (u_debugMode > 5.5) {
    out_FragColor = originalColor;
    return;
  }
```
改为：
```glsl
  if (u_debugMode > 5.5 && u_debugMode < 6.5) {
    out_FragColor = originalColor;
    return;
  }
```
（debug=1/2/3/5 分支不变。debug=7（>6.5）不进任何 debug 分支，走 main 末端线性输出 `finalColor*exposure`，由 tonomap 的 debug=7 子分支归一化验证。）

**改动 5 · 顶部注释**：把文件头注释里提到「末端 ACES tonemap」的描述更新为「末端输出线性，链尾 tonomap stage 收尾」。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts`
Expected: PASS（全部用例，含新断言）

- [ ] **Step 5: 全宏组合 glslang 编译校验**

确认 `aerialPerspective.compile.test.ts`（既有 glslang 编译测试）在全宏组合（SKY+SUN / SUN关 / SKY关 / 全关）下仍编译通过——`sky=false` 分支去掉 `tonemapDisplay` 后不应有未定义符号。

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`
Expected: PASS（4 组合全编译通过）

- [ ] **Step 6: core tsc**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/cesium-core/src/cesium/aerialPerspective.frag.ts packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts
git commit -m "feat(core): atmosphere stage 输出线性 finalColor·exposure（拆 ACES 到链尾 tonomap stage）"
```

---

## Task 3: 改 AtmosphereStage.ts（双 stage + HalfFloat 检测 + Handle）

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`
- Test: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`

**Interfaces:**
- Consumes: Task 1 `buildTonemapFragmentShader()`；Task 2 改造后的 `buildAerialPerspectiveFragmentShader()`
- Produces: `resolvePostHdrDatatype(scene): PixelDatatype`；`createAtmosphereStage` 建 atmosphere+tonomap 两 stage；`AtmosphereStageHandle` 含 `atmosphereStage`/`tonemapStage`/`postHdrDatatype`（移除 `stage` 字段）

- [ ] **Step 1: 改测试 `AtmosphereStage.test.ts`**

新增 `resolvePostHdrDatatype` 三分支测试（mock context）：
```ts
import { resolvePostHdrDatatype } from './AtmosphereStage'
import { PixelDatatype } from 'cesium'

describe('resolvePostHdrDatatype', () => {
  function makeCtx(half: boolean, halfCb: boolean, full: boolean, fullCb: boolean) {
    return {
      halfFloatingPointTexture: half,
      colorBufferHalfFloat: halfCb,
      floatingPointTexture: full,
      colorBufferFloat: fullCb
    } as unknown as import('cesium').Scene['context']
  }
  function makeScene(ctx: unknown) {
    return { context: ctx } as unknown as import('cesium').Scene
  }

  it('HalfFloat 支持 → HALF_FLOAT', () => {
    expect(resolvePostHdrDatatype(makeScene(makeCtx(true, true, false, false)))).toBe(PixelDatatype.HALF_FLOAT)
  })
  it('仅 float 支持 → FLOAT', () => {
    expect(resolvePostHdrDatatype(makeScene(makeCtx(false, false, true, true)))).toBe(PixelDatatype.FLOAT)
  })
  it('都不支持 → UNSIGNED_BYTE', () => {
    expect(resolvePostHdrDatatype(makeScene(makeCtx(false, false, false, false)))).toBe(PixelDatatype.UNSIGNED_BYTE)
  })
})
```

**更新既有 `AtmosphereStageHandle` 相关断言**：把引用 `.stage` 的断言改为 `.atmosphereStage` / `.tonomapStage`。若既有测试用 `createAtmosphereStage` 实例化（需 WebGL，node 跑不了），保留为 mock 或 skipped，重点是纯函数（`resolvePostHdrDatatype`/`buildAtmosphereUniforms`/`validateAtmosphereOptions`）可测。新增断言：
```ts
it('buildAtmosphereUniforms 覆盖 AERIAL_PERSPECTIVE_UNIFORM_NAMES（不变，phase1 已有，保留）', () => {
  // 保留 phase1 既有断言
})
```

- [ ] **Step 2: 运行测试，确认失败（resolvePostHdrDatatype 未导出）**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts`
Expected: FAIL — `resolvePostHdrDatatype is not exported`

- [ ] **Step 3: 改 `AtmosphereStage.ts`**

**改动 1 · import**：加 `PixelDatatype`、`PixelFormat`，import `buildTonemapFragmentShader`：
```ts
import {
  PostProcessStage,
  Cartesian3,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  JulianDate,
  Math as CesiumMath,
  PixelDatatype,
  PixelFormat,
  type Scene,
  type Camera,
  type Ellipsoid
} from 'cesium'
import {
  buildAerialPerspectiveFragmentShader,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'
import { buildTonemapFragmentShader } from './tonemap.frag'  // 新增
```

**改动 2 · 新增 `resolvePostHdrDatatype`**（纯函数，放在 `validateAtmosphereOptions` 附近）：
```ts
/**
 * 检测 PostProcessStage 可用的最高 HDR 像素数据类型（对齐 cesium-clouds-atmosphere AtmospherePostProcess）。
 * HALF_FLOAT 优先（精度够+性能好），FLOAT 次选（32-bit color buffer 罕见），UNSIGNED_BYTE 兜底。
 * WebGL2 下 halfFloatingPointTexture 恒 true（管 RGBA16F 采样），colorBufferHalfFloat 实测
 * EXT_color_buffer_float（覆盖 RGBA16F renderable）。两者配合覆盖采样+渲染两端。
 */
export function resolvePostHdrDatatype(scene: Scene): PixelDatatype {
  const ctx = scene.context
  if (ctx.halfFloatingPointTexture && ctx.colorBufferHalfFloat) return PixelDatatype.HALF_FLOAT
  if (ctx.colorBufferFloat && ctx.floatingPointTexture) return PixelDatatype.FLOAT
  return PixelDatatype.UNSIGNED_BYTE
}
```

**改动 3 · `AtmosphereStageHandle` 接口**（移除 `stage`，加 `atmosphereStage`/`tonomapStage`/`postHdrDatatype`）：
```ts
export interface AtmosphereStageHandle {
  readonly atmosphereStage: PostProcessStage
  readonly tonemapStage: PostProcessStage
  readonly postHdrDatatype: PixelDatatype
  setMode(newOptions: AtmosphereStageOptions): void
  destroy(): void
}
```

**改动 4 · `createAtmosphereStage` 主体**（建两 stage）：

把 phase1 的单 stage 逻辑：
```ts
function buildStage(): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildAerialPerspectiveFragmentShader(resolved),
    uniforms: buildAtmosphereUniforms(luts, resolved, state)
  })
}
let stage = buildStage()
scene.postProcessStages.add(stage)
```
改为：
```ts
const postHdrDatatype = resolvePostHdrDatatype(scene)  // 一次性检测

function buildAtmosphereStage(): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildAerialPerspectiveFragmentShader(resolved),  // Task 2 改造后的线性输出
    uniforms: buildAtmosphereUniforms(luts, resolved, state),
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype  // HALF_FLOAT 带兜底；phase1 未传此字段
  })
}
function buildTonemapStage(): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildTonemapFragmentShader(),
    uniforms: { u_debugMode: resolved.debugMode }  // 与 atmosphere 同源；setMode rebuild 时同步
    // sampleMode 默认 NEAREST——勿改（保护 input dithering 经 RT 中转，见 tonemap.frag 注释）
  })  // 默认 RGBA8
}

let atmosphereStage = buildAtmosphereStage()
let tonemapStage = buildTonemapStage()
scene.postProcessStages.add(atmosphereStage)
scene.postProcessStages.add(tonemapStage)  // 链尾，读 atmosphere 输出
```

**改动 5 · `removeAndDestroy` 不变**（已存在）。

**改动 6 · 返回的 handle**：
```ts
return {
  get atmosphereStage() {
    return atmosphereStage
  },
  get tonemapStage() {
    return tonemapStage
  },
  get postHdrDatatype() {
    return postHdrDatatype
  },
  setMode(newOptions: AtmosphereStageOptions) {
    // setMode/destroy 全仓库 0 调用属 dead code（demo 切 mode 靠页面重载）。
    // 简化为 rebuild 两 stage（不 removePreRender——preRender 闭包持 state/resolved 引用，resolved 更新后自动生效）。
    removeAndDestroy(atmosphereStage)
    removeAndDestroy(tonemapStage)
    resolved = validateAtmosphereOptions(newOptions)
    atmosphereStage = buildAtmosphereStage()
    tonemapStage = buildTonemapStage()
    scene.postProcessStages.add(atmosphereStage)
    scene.postProcessStages.add(tonemapStage)
  },
  destroy() {
    removePreRender()
    removeAndDestroy(atmosphereStage)
    removeAndDestroy(tonemapStage)
  }
}
```

> **注意**：`removePreRender` 是 phase1 既有（`scene.preRender.addEventListener` 返回的解绑函数）。`buildAtmosphereUniforms` 不变（exposure 仍 atmosphere uniform）。`buildAtmosphereStage`/`buildTonemapStage` 是 `createAtmosphereStage` 内的闭包函数（读 `resolved`/`luts`/`state`/`postHdrDatatype`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts`
Expected: PASS（`resolvePostHdrDatatype` 三分支 + 既有断言）

- [ ] **Step 5: core tsc**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(core): AtmosphereStage 双 stage（atmosphere HalfFloat + tonomap RGBA8）+ resolvePostHdrDatatype"
```

---

## Task 4: demo 接线 `?hdr=0` 兜底调试开关

**Files:**
- Modify: `apps/demo/src/main.ts`

**Interfaces:**
- Consumes: Task 3 `createAtmosphereStage`（内部已改双 stage）；新增 URL 参数 `?hdr=0`

- [ ] **Step 1: 改 `main.ts` 加 `?hdr=0` 解析**

在 atmosphere 分支的 `createAtmosphereStage(scene, luts, options)` 调用前，解析 `?hdr=0` 并通过 options 传递（强制 UNSIGNED_BYTE）。但 `resolvePostHdrDatatype` 在 `createAtmosphereStage` 内部检测——为支持 `?hdr=0` 强制覆盖，需给 `AtmosphereStageOptions` 加可选字段 `forcePostHdrDatatype?: PixelDatatype`，或加 `?hdr=0` 时跳过检测。

**更简洁的实现**：`AtmosphereStageOptions` 加 `disableHalfFloat?: boolean`，`createAtmosphereStage` 内 `const postHdrDatatype = options.disableHalfFloat ? PixelDatatype.UNSIGNED_BYTE : resolvePostHdrDatatype(scene)`。

**改 `AtmosphereStageOptions` 接口**（`AtmosphereStage.ts`）加：
```ts
disableHalfFloat?: boolean  // URL ?hdr=0 强制 UNSIGNED_BYTE 兜底调试
```
**改 `createAtmosphereStage`**（Task 3 改动 4 的第一行）：
```ts
const postHdrDatatype = options.disableHalfFloat
  ? PixelDatatype.UNSIGNED_BYTE
  : resolvePostHdrDatatype(scene)
```

**改 `main.ts`** atmosphere 分支的 options 构造：
```ts
const options: AtmosphereStageOptions = {
  debugMode: getNumber('debug') ?? 0,
  ...(getNumber('exposureDay') != null ? { exposureDay: getNumber('exposureDay')! } : {}),
  ...(getNumber('exposureNight') != null ? { exposureNight: getNumber('exposureNight')! } : {}),
  ...(getNumber('groundDim') != null ? { groundDim: getNumber('groundDim')! } : {}),
  ...(getString('hdr') === '0' ? { disableHalfFloat: true } : {})  // 新增：强制 RGBA8 兜底
}
```

- [ ] **Step 2: demo tsc**

Run: `pnpm --filter demo exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 全测回归（确保未破坏）**

Run: `pnpm -r test`
Expected: core 全测通过

- [ ] **Step 4: 提交**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts apps/demo/src/main.ts
git commit -m "feat(demo): ?hdr=0 强制 RGBA8 兜底调试开关（disableHalfFloat）"
```

---

## Task 5: 浏览器验收文档

**Files:**
- Create: `docs/superpowers/plans/2026-08-04-phase2a-results.md`

**Interfaces:**
- Consumes: 全部前序任务（demo 可运行 + `?debug=7` + `?hdr=0`）

- [ ] **Step 1: 写验收文档**

```markdown
# phase2a 验收结果：HDR 浮点后处理链基建

> **日期**：2026-08-04
> **关联**：spec `../specs/2026-08-04-phase2a-hdr-pipeline-design.md`；计划 `2026-08-04-phase2a-hdr-pipeline.md`
> **状态**：⏳ 待项目方浏览器验收（无 GPU 环境无法自动跑）
> **分支**：`phase2a/hdr-pipeline`

## 0. 前置
- dev server：`pnpm dev`（http://localhost:5173/）
- ion token：`apps/demo/.env.local` 的 `VITE_ION_TOKEN`（不入库），无 token 裸 globe 仍可验收大气/天空。

## 1. 单测（自动，项目方跑）
- [ ] `pnpm -r test`：core 全测通过（含 tonomap.frag.test / aerialPerspective.frag.test / AtmosphereStage.test）
- [ ] `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`：全宏组合 glslang 编译通过
- [ ] `pnpm --filter demo exec tsc --noEmit`：demo 类型干净

## 2. 视觉回归（硬指标：五项与 phase1 不可区分）

复用 phase1 验收 URL（`mode=atmosphere`，B 路径参数）。建议视角：`camera=93.1569,31.6636,13469,32.0,-4.2`（phase1 闪动验收视角）+ 太阳低角 `time=...`。

| # | 回归项 | 通过? | 备注 |
|---|---|---|---|
| 1 | 水波纹（俯视 nadir 远处渐变无同心色带） | ⬜ | input dithering 仍打散 |
| 2 | 转动地平线闪动（掠射角无绿/红条纹） | ⬜ | DUAL inscatter 仍平滑 |
| 3 | 山体不透明（近处山峰不透出地平线） | ⬜ | hasScene/mask 仍 work |
| 4 | 天空/太阳盘（ACES 后颜色/亮度与 phase1 一致） | ⬜ | ACES 输入仍 HDR float，数学等价 |
| 5 | 地表过曝（groundDim=0.5 仍压住） | ⬜ | groundDim 不变 |

## 3. HDR 链验证（debug=7，证明 HalfFloat 承载 >1）

- [ ] `?debug=7`：tonomap 输出 `clamp(linearHdr/5,0,1)` false-color。HalfFloat 设备：太阳/天空高光区显示**亮区**（接近 1，证明 finalColor·exposure>1 未被 clip）。
- [ ] 对比 `?hdr=0`（强制兜底）：atmosphere RT 被 RGBA8 clip 到 1.0 → debug=7 显示**暗区**（≈0.2）。
- [ ] 两路径太阳区亮度差异 = HalfFloat 承载 >1 的证据（log 归一化无法区分，故用线性归一化）。

## 4. 兜底验证（?hdr=0）

- [ ] `?hdr=0` 不崩，画面除太阳盘变暗 ~20% 外与 HalfFloat 路径基本一致（预期退化）。
- [ ] 切回默认（无 ?hdr=0）：HalfFloat 路径太阳盘亮白恢复。

## 5. 验收结论
- [ ] 单测全过 + 五项视觉回归不可区分 + debug=7 证明 HDR + ?hdr=0 兜底不崩 → phase2a 通过，可 finishing-a-development-branch 合并 main，进 phase2b（LensFlare）设计。
- [ ] 任一失败 → 记录失败项，回对应 Task 修复后复验。
```

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/plans/2026-08-04-phase2a-results.md
git commit -m "docs: phase2a 验收文档（五项视觉回归 + debug=7 HDR 验证 + ?hdr=0 兜底）"
```

---

## Self-Review（plan 自检）

**1. Spec 覆盖**：
- §2.1 目标 1（atmosphere 输出线性）→ Task 2 ✅
- §2.1 目标 2（独立链尾 ToneMappingStage）→ Task 1 ✅
- §2.1 目标 3（HalfFloat 检测+降级）→ Task 3 `resolvePostHdrDatatype` ✅
- §2.1 目标 4（视觉不可区分）→ Task 5 验收五项 ✅
- §2.1 目标 5（HalfFloat 可消费）→ Task 5 debug=7 ✅
- §5.1 HalfFloat 检测+兜底 → Task 3 + Task 4（?hdr=0）✅
- §5.2 atmosphere 改造（末端线性 + sky=false + 函数迁移 + debug 上限）→ Task 2 ✅
- §5.3 tonomap stage（ACES+gamma+dithering + debug=7 + NEAREST）→ Task 1 ✅
- §5.4 AtmosphereStage 双 stage + Handle → Task 3 ✅
- §5.5 demo 接线（?hdr=0 + debug=7）→ Task 4 + Task 5 ✅
- §6 测试策略 → Task 1/2/3 测试 + Task 5 验收 ✅

**2. 占位符扫描**：Task 1 Step 5 的 glslang 编译用例放在既有 `aerialPerspective.compile.test.ts`（复用 `compileFragment` helper，DRY），无占位。其余步骤代码完整。✅

**3. 类型一致**：
- `buildTonemapFragmentShader()` 在 Task 1 定义，Task 3 import 使用 ✅
- `TONEMAP_UNIFORM_NAMES = ['u_debugMode']` Task 1 定义，Task 3 不直接用（uniforms 内联）✅
- `resolvePostHdrDatatype(scene): PixelDatatype` Task 3 定义 + 导出 ✅
- `AtmosphereStageHandle` 字段 `atmosphereStage`/`tonemapStage`/`postHdrDatatype` 一致 ✅
- `disableHalfFloat` Task 4 加到 `AtmosphereStageOptions`，main.ts 用 ✅

无遗漏。Plan 可执行。
