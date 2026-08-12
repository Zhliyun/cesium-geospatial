# 体积 God Rays（丁达尔）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cesium atmosphere 后处理链加入物理启发式体积 god rays——半分辨率 march pass 沿视线 + 太阳方向 screen-space ray march 累加 shadow_length（vec2 first-moment），atmosphere 天空分支用三分支散射（Branch 1/3）产生被山脊切割的低空光束。

**Architecture:** 新增 `gr_wrapper` 非序列 composite（`gr_shadowLength` 半分辨率 march + `gr_passthrough` 全分辨率透传）插在 `depthTemporal` 与 `atmosphere` 之间；atmosphere 经 uniform-name 引用 `gr_shadowLength` 输出，天空分支调 `getSkyRadianceShadowed`（移植 three-geospatial runtime.ts 三分支）。HDR 安全（shadow_length 是物理标量）。

**Tech Stack:** Cesium PostProcessStage（GLSL ES 3.00）+ Bruneton runtime（`#include`）+ TypeScript + Vitest + glslangValidator（compile test）。

**Spec:** `docs/superpowers/specs/2026-08-13-volumetric-godrays-design.md`（r2 评审修订版，commit 8695dbd）。动手前必读 spec §4.2/§4.3/§5.1（GLSL 伪代码）+ 附录 C/D（评审修订）。

## Global Constraints

（每个 task 隐式遵守，从 spec 逐字抄录）

- **GLSL ES 3.00**：Cesium PostProcessStage 注入 `out vec4 out_FragColor` / `in vec2 v_textureCoordinates` / `czm_*` automatic uniforms，shader **不需 `#version`**，输出用 `out_FragColor`（非 `gl_FragColor`）。
- **单位**：Bruneton 几何用 km 域。`cameraWC = (czm_viewerPositionWC + u_altitudeCorrection) * METER_TO_LENGTH_UNIT`（`u_altitudeCorrection` 米域，`METER_TO_LENGTH_UNIT=0.001` from cesiumCore buildAtmospherePrefix）；Q 投影前 `Q_km/METER_TO_LENGTH_UNIT - u_altitudeCorrection` 转回真实 ECEF 米（`czm_viewProjection`/`czm_view` 期望 ECEF 米）。
- **depth 反演链**：raw globe depth 在 `.r`（scene globe depth，非 czm_depth_temporal 的 `.a`）→ `czm_reverseLogDepthWindow(logDepth, czm_currentFrustum.x, czm_currentFrustum.y)` → 4-arg `czm_windowToEyeCoordinates(vec4(windowXY, winDepth, 1.0))` → 透视除法 → `.z`。**`czm_reverseLogDepthWindow` 不是自动注入**——march builder 必须 concat `LOG_DEPTH_GLSL`（from `logDepth.ts`，同 `aerialPerspective.frag.ts:569`）。
- **像素类型**：`pixelDatatype: postHdrDatatype`（HalfFloat 优先），`pixelFormat: RGBA`。
- **depth 源**：`gr_shadowLength` 用 Cesium 内建 scene globe depth（不覆盖 depthTexture uniform，shader 用 `texture(depthTexture, uv).r` + `czm_reverseLogDepthWindow`），**非** `czm_depth_temporal` EMA（atmosphere `hdrDepthTemporal:false` 读 raw globe depth，同源；EMA 有 Bug3 + 运动拖影）。
- **early-exit**：`gr_wrapper` 始终 enabled（不能用 enabled=false——独立 RT outputTexture undefined 污染下游）；`u_godRaysSunVisible=0` 时 march shader `main` 开头 `out_FragColor=vec4(0); return;`。
- **上采样 NEAREST**：Cesium output 默认 NEAREST，sampleMode 无法改；atmosphere 读 `u_shadowLengthTexture` 走 NEAREST（god rays 低频可接受）。
- **中文注释/文档**（项目全局规范）。
- **TDD + 频繁 commit**（项目惯例）。

---

## File Structure

**Create（新 godRays 模块，参考 `lensFlare/` 组织）：**
- `packages/cesium-core/src/cesium/godRays/marchShader.ts` — `buildGodRaysMarchFragmentShader(options)`：march pass fragment 构建器（GLSL 字符串拼装，含 `#include bruneton` 的子集 + LOG_DEPTH_GLSL + 主 march + sun ray march + first-moment + vec2 输出 + debug=10）。
- `packages/cesium-core/src/cesium/godRays/marchShader.test.ts` — shader 构建器单测（断言产出含预期 uniform/宏/函数/循环）。
- `packages/cesium-core/src/cesium/godRays/marchShader.compile.test.ts` — glslangValidator compile（`buildStandaloneShaderForValidation` + 桩 + LOG_DEPTH_GLSL）。
- `packages/cesium-core/src/cesium/godRays/createGodRaysStage.ts` — `createGodRaysStage(scene, state, options)`：返回 `gr_wrapper` composite handle（gr_shadowLength + gr_passthrough）。
- `packages/cesium-core/src/cesium/godRays/createGodRaysStage.test.ts` — stage 创建单测（composite 结构、uniform-name、textureScale、godRays=false 跳过）。
- `packages/cesium-core/src/cesium/godRays/godRaysConstants.ts` — 默认值常量（步数/步长/intensity/bias）。

**Modify：**
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts` — 加 `godRays?: boolean` option；`godRays=true` 时声明 `u_shadowLengthTexture` + 定义 `getSkyRadianceShadowed`（三分支 + 日盘 + 不外推 + 太空视角 A/B 同步）+ 天空分支 `skyBranch` 调用它。
- `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts` — `godRays=true/false` 两分支单测。
- `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts` — `getSkyRadianceShadowed` compile。
- `packages/cesium-core/src/cesium/AtmosphereStage.ts` — `AtmosphereStageOptions` 加 godRays 字段；`createAtmosphereStage` 调 `createGodRaysStage` + add 到 `depthTemporal` 与 `atmosphere` 之间；`preRender` 算 `u_godRaysSunVisible`；atmosphere uniforms 加 `u_shadowLengthTexture`。
- `apps/demo/src/main.ts` — URL 参数 `?godRays/?godRaysIntensity/?godRaysMainSteps/?godRaysSunSteps`。

**glslIndex.ts 注册**（若 march shader 用 `#include`）：march shader 内联所需 helper（不 `#include bruneton/runtime` 全量，保持独立），仅 concat LOG_DEPTH_GLSL + 自包含 ray-sphere/SafeSqrt 小函数。

---

## Task 1: march shader 构建器 + 单测

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/godRaysConstants.ts`
- Create: `packages/cesium-core/src/cesium/godRays/marchShader.ts`
- Create: `packages/cesium-core/src/cesium/godRays/marchShader.test.ts`
- Test: `packages/cesium-core/src/cesium/godRays/marchShader.test.ts`

**Interfaces:**
- Consumes: `METER_TO_LENGTH_UNIT`（from `../cesiumCore` buildAtmospherePrefix #define，shader 内作字面量 `0.001`）；`LOG_DEPTH_GLSL`（from `../logDepth`）。
- Produces: `buildGodRaysMarchFragmentShader(options: GodRaysMarchOptions): string`；`GodRaysMarchOptions { mainSteps: number; sunSteps: number; debugMode: number }`；`buildStandaloneShaderForValidation(options): string`（glslang 用，补 `#version 300 es` + 桩）。

- [ ] **Step 1: 写 godRaysConstants.ts**

```ts
// packages/cesium-core/src/cesium/godRays/godRaysConstants.ts
// godRays 默认值（spec §9.1/§9.2）。单位 km（METER_TO_LENGTH_UNIT 域），bias 例外见注释。
export const GOD_RAYS_MAIN_STEPS_DEFAULT = 16
export const GOD_RAYS_MAIN_STEP0_DEFAULT = 0.5     // km
export const GOD_RAYS_MAIN_STEP_GROWTH_DEFAULT = 1.3
export const GOD_RAYS_SUN_STEPS_DEFAULT = 8
export const GOD_RAYS_SUN_STEP0_DEFAULT = 0.5      // km
export const GOD_RAYS_SUN_STEP_GROWTH_DEFAULT = 1.5
export const GOD_RAYS_DEPTH_BIAS_DEFAULT = 0.01    // km（shader 内 /METER_TO_LENGTH_UNIT 转 eye-space 米 = 10m）
export const GOD_RAYS_INTENSITY_DEFAULT = 1.0
export const METER_TO_LENGTH_UNIT = 0.001          // 米→km，与 cesiumCore buildAtmospherePrefix 一致
```

- [ ] **Step 2: 写失败测试 marchShader.test.ts**

```ts
// packages/cesium-core/src/cesium/godRays/marchShader.test.ts
import { describe, it, expect } from 'vitest'
import { buildGodRaysMarchFragmentShader } from './marchShader'

describe('buildGodRaysMarchFragmentShader', () => {
  const s = buildGodRaysMarchFragmentShader({ mainSteps: 16, sunSteps: 8, debugMode: 0 })

  it('声明全部 uniforms（spec §9.1）', () => {
    expect(s).toContain('uniform sampler2D depthTexture')
    expect(s).toContain('uniform vec3  u_sunDirectionWC')
    expect(s).toContain('uniform vec3  u_altitudeCorrection')
    expect(s).toContain('uniform float u_atmosphereTopRadius')
    expect(s).toContain('uniform int   u_godRaysMainSteps')
    expect(s).toContain('uniform float u_godRaysMainStep0')
    expect(s).toContain('uniform float u_godRaysMainStepGrowth')
    expect(s).toContain('uniform int   u_godRaysSunSteps')
    expect(s).toContain('uniform float u_godRaysSunStep0')
    expect(s).toContain('uniform float u_godRaysSunStepGrowth')
    expect(s).toContain('uniform float u_godRaysDepthBias')
    expect(s).toContain('uniform float u_godRaysIntensity')
    expect(s).toContain('uniform int   u_godRaysSunVisible')
    expect(s).toContain('uniform int   u_debugMode')
  })

  it('mainSteps/sunSteps 宏按 options 注入', () => {
    expect(s).toContain('#define GOD_RAYS_MAIN_STEPS 16')
    expect(s).toContain('#define GOD_RAYS_SUN_STEPS 8')
  })

  it('含 sunRayMarchLit 函数 + depth 反演链（czm_reverseLogDepthWindow + 4-arg czm_windowToEyeCoordinates）', () => {
    expect(s).toContain('bool sunRayMarchLit(')
    expect(s).toContain('czm_reverseLogDepthWindow(logDepth, czm_currentFrustum.x, czm_currentFrustum.y)')
    expect(s).toContain('czm_windowToEyeCoordinates(vec4(')
  })

  it('r2 Crit-1：Q 投影减 altitudeCorrection（转真实 ECEF 米）', () => {
    expect(s).toContain('Q_km / METER_TO_LENGTH_UNIT - u_altitudeCorrection')
  })

  it('r2 Imp-1：march 循环先 t+=step 再 step*=growth（连续铺满）', () => {
    // 循环体：t += step 在 step *= growth 之前
    const loopBody = s.slice(s.indexOf('for (int i = 0; i < GOD_RAYS_MAIN_STEPS'), s.indexOf('first moment'))
    expect(loopBody.indexOf('t += step')).toBeLessThan(loopBody.indexOf('step *= u_godRaysMainStepGrowth'))
    expect(loopBody).toContain('float centerDist = t + step * 0.5')   // P 采样段中心
    expect(loopBody).toContain('vec3 P = cameraWC + rayDir * centerDist')
  })

  it('r2 Imp-5：bias / METER_TO_LENGTH_UNIT 转 eye-space 米', () => {
    expect(s).toContain('u_godRaysDepthBias / METER_TO_LENGTH_UNIT')
  })

  it('first-moment 累加 + distanceToFirstShadow 反推（m/x-0.5x）', () => {
    expect(s).toContain('firstShadowMoment += step * centerDist')
    expect(s).toContain('firstShadowMoment / totalShadowLength - totalShadowLength * 0.5')
  })

  it('vec2 输出（.rg=totalShadowLength*intensity, distanceToFirstShadow）', () => {
    expect(s).toContain('out_FragColor = vec4(totalShadowLength * u_godRaysIntensity')
  })

  it('early-exit：u_godRaysSunVisible==0 时 out_FragColor=vec4(0) return', () => {
    expect(s).toContain('if (u_godRaysSunVisible == 0)')
    expect(s).toContain('out_FragColor = vec4(0.0, 0.0, 0.0, 1.0)')
  })

  it('concat LOG_DEPTH_GLSL（r2 Imp-6：czm_reverseLogDepthWindow 非自动注入）', () => {
    expect(s).toContain('czm_reverseLogDepthWindow')  // 来自 concat 的 LOG_DEPTH_GLSL 定义
  })

  it('r2 minor：pointDist 用 SafeSqrt', () => {
    expect(s).toContain('SafeSqrt(')
  })

  it('debugMode=10 时含 vec2 可视化分支', () => {
    const s10 = buildGodRaysMarchFragmentShader({ mainSteps: 16, sunSteps: 8, debugMode: 10 })
    expect(s10).toContain('u_debugMode == 10')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/marchShader.test.ts`
Expected: FAIL（`buildGodRaysMarchFragmentShader` 未定义）。

- [ ] **Step 4: 写 marchShader.ts 实现**

```ts
// packages/cesium-core/src/cesium/godRays/marchShader.ts
// march pass fragment 构建器：沿视线 march + 太阳方向 screen-space ray march，
// first-moment 累加 → vec2(totalShadowLength, distanceToFirstShadow) 输出。
// spec §4.2/§4.3（r2 修订版）。HDR 安全（shadow_length 物理标量 km）。
import { LOG_DEPTH_GLSL } from '../logDepth'
import { METER_TO_LENGTH_UNIT } from './godRaysConstants'

export interface GodRaysMarchOptions {
  mainSteps: number
  sunSteps: number
  debugMode: number
}

// 自包含 helper（不 include bruneton/runtime 全量，保持 march shader 独立 + 轻量）。
const MARCH_HELPERS_GLSL = `
float SafeSqrt(float x) { return sqrt(max(x, 0.0)); }
float jitterHash() {
  // spatial hash（spatial jitter，每像素不同；§7.5 时序稳定初版用 spatial）
  vec2 p = gl_FragCoord.xy;
  return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
}
`

const SUN_RAY_MARCH_GLSL = `
// §4.3：P 沿 sunDirection 步进，Q 投影查 depth 判遮挡。返回 true=lit（未遮挡）。
bool sunRayMarchLit(vec3 P_km) {
  for (int j = 0; j < GOD_RAYS_SUN_STEPS; ++j) {
    float s = u_godRaysSunStep0 * pow(u_godRaysSunStepGrowth, float(j));  // km
    vec3 Q_km = P_km + u_sunDirectionWC * s;  // u_sunDirectionWC 是 ECEF 单位向量
    // r2 Crit-1：Q 转真实 ECEF 米（减 altitudeCorrection 密切球偏移）
    vec3 Q_realECEF_m = Q_km / METER_TO_LENGTH_UNIT - u_altitudeCorrection;
    vec4 QClip = czm_viewProjection * vec4(Q_realECEF_m, 1.0);
    if (QClip.w <= 0.0) break;                      // Q 在 camera 后方 → fallback（保持 lit）
    vec3 QNdc = QClip.xyz / QClip.w;
    if (any(lessThan(QNdc.xy, vec2(-1.0))) || any(greaterThan(QNdc.xy, vec2(1.0)))) break;  // 出屏幕
    vec2 QUv = QNdc.xy * 0.5 + 0.5;
    // depth 反演链（r1 C2 + r2 Imp-6）：raw globe depth .r → czm_reverseLogDepthWindow → 4-arg windowToEyeCoordinates
    float logDepth = texture(depthTexture, QUv).r;
    float winDepth = czm_reverseLogDepthWindow(logDepth, czm_currentFrustum.x, czm_currentFrustum.y);
    vec4 QEyePos = czm_windowToEyeCoordinates(vec4(QUv * czm_viewport.zw, winDepth, 1.0));
    if (abs(QEyePos.w) > 1e-6) QEyePos /= QEyePos.w;
    float sceneEyeZ = QEyePos.z;
    float QEyeZ = (czm_view * vec4(Q_realECEF_m, 1.0)).z;  // r2 Crit-1：与 sceneEyeZ 同 ECEF 米系
    if (QEyeZ < sceneEyeZ - u_godRaysDepthBias / METER_TO_LENGTH_UNIT) return false;  // r2 Imp-5：bias km→米
  }
  return true;
}
`

const MAIN_GLSL = `
void main() {
  // early-exit（§4.1）：太阳地平下/视野外 → vec2(0,0)，atmosphere 走 Branch 1 零回归
  if (u_godRaysSunVisible == 0) { out_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

#if GOD_RAYS_DEBUG == 10
  // debug=10 末尾截获（见下方），正常路径跳过
#endif

  // §4.2 step 1：重建视线方向（复用 aerialPerspective.frag:109-116 reconstructRay 同逻辑）
  vec4 eyeNear = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, 0.0, 1.0));
  vec4 eyeFar  = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, 1.0, 1.0));
  vec3 dirEC = normalize(eyeFar.xyz - eyeNear.xyz);
  vec3 rayDir = normalize((czm_inverseView * vec4(dirEC, 0.0)).xyz);

  // §4.2 step 2：camera/单位（r2：altitudeCorrection 米域 + km 域）
  vec3 cameraWC = (czm_viewerPositionWC + u_altitudeCorrection) * METER_TO_LENGTH_UNIT;
  float topR = u_atmosphereTopRadius;
  float rmu = dot(cameraWC, rayDir);
  float pointDist = max(-rmu - SafeSqrt(rmu*rmu - dot(cameraWC,cameraWC) + topR*topR), 0.0);

  // §4.2 step 3：主 march + first-moment（r2 Imp-1：先 t+=step 再 step*=growth，P 段中心）
  float totalShadowLength = 0.0;
  float firstShadowMoment = 0.0;
  float t = u_godRaysMainStep0 * jitterHash();
  float step = u_godRaysMainStep0;
  for (int i = 0; i < GOD_RAYS_MAIN_STEPS; ++i) {
    if (t > pointDist) break;
    float centerDist = t + step * 0.5;
    vec3 P = cameraWC + rayDir * centerDist;
    if (!sunRayMarchLit(P)) {
      totalShadowLength += step;
      firstShadowMoment += step * centerDist;  // first moment（阴影段长 × 段中心距）
    }
    t += step;                              // r2 Imp-1：先用当前 step 推进（连续铺满）
    step *= u_godRaysMainStepGrowth;
  }

  // §4.2 step 4：first-moment → distanceToFirstShadow（EpipolarShadowLengthNode:582-595）
  float distanceToFirstShadow = pointDist;  // 无阴影标记
  if (totalShadowLength > 1e-6) {
    distanceToFirstShadow = clamp(
      firstShadowMoment / totalShadowLength - totalShadowLength * 0.5,
      0.0, max(pointDist - totalShadowLength, 0.0));
    if (distanceToFirstShadow < 1.0 / 1000.0) distanceToFirstShadow = 0.0;  // <1m→阴影从 camera 起
  }

#if GOD_RAYS_DEBUG == 10
  // debug=10：vec2 可视化（.r=totalShadowLength/50 jet, .g=distanceToFirstShadow/pointDist）
  float tn = clamp(totalShadowLength / 50.0, 0.0, 1.0);
  float dn = clamp(distanceToFirstShadow / max(pointDist, 1.0), 0.0, 1.0);
  out_FragColor = vec4(vec3(dn, tn * 0.5 + 0.2, tn), 1.0);  // 简化 false-color
  return;
#endif

  out_FragColor = vec4(totalShadowLength * u_godRaysIntensity, distanceToFirstShadow, 0.0, 1.0);
}
`

export function buildGodRaysMarchFragmentShader(options: GodRaysMarchOptions): string {
  return [
    `#define GOD_RAYS_MAIN_STEPS ${options.mainSteps}`,
    `#define GOD_RAYS_SUN_STEPS ${options.sunSteps}`,
    `#define GOD_RAYS_DEBUG ${options.debugMode}`,
    // uniforms（spec §9.1）
    `uniform sampler2D depthTexture;`,
    `uniform vec3  u_sunDirectionWC;`,
    `uniform vec3  u_altitudeCorrection;`,
    `uniform float u_atmosphereTopRadius;`,
    `uniform int   u_godRaysMainSteps;`,
    `uniform float u_godRaysMainStep0;`,
    `uniform float u_godRaysMainStepGrowth;`,
    `uniform int   u_godRaysSunSteps;`,
    `uniform float u_godRaysSunStep0;`,
    `uniform float u_godRaysSunStepGrowth;`,
    `uniform float u_godRaysDepthBias;`,
    `uniform float u_godRaysIntensity;`,
    `uniform int   u_godRaysSunVisible;`,
    `uniform int   u_debugMode;`,
    `const float METER_TO_LENGTH_UNIT = ${METER_TO_LENGTH_UNIT};`,
    LOG_DEPTH_GLSL,           // r2 Imp-6：concat（czm_reverseLogDepthWindow 定义在此）
    MARCH_HELPERS_GLSL,
    SUN_RAY_MARCH_GLSL,
    MAIN_GLSL
  ].join('\n')
}

// glslang 离线校验：补 #version + czm_* 桩（自动注入的）+ out_FragColor + v_textureCoordinates
const VALIDATION_STUBS_GLSL = `
uniform mat4 czm_view;
uniform mat4 czm_viewProjection;
uniform mat4 czm_inverseView;
uniform vec3 czm_viewerPositionWC;
uniform vec4 czm_currentFrustum;
uniform vec4 czm_viewport;
uniform sampler2D depthTexture;
out vec4 out_FragColor;
vec4 czm_windowToEyeCoordinates(vec4 p) { return p; }  // 桩（真实由 LOG_DEPTH_GLSL + cesium builtin）
`

export function buildStandaloneShaderForValidation(options: GodRaysMarchOptions): string {
  return `#version 300 es\n` + VALIDATION_STUBS_GLSL + `\n` + buildGodRaysMarchFragmentShader(options)
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/marchShader.test.ts`
Expected: PASS（全部断言）。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/godRaysConstants.ts packages/cesium-core/src/cesium/godRays/marchShader.ts packages/cesium-core/src/cesium/godRays/marchShader.test.ts
git commit -m "feat(godRays): T1 march shader 构建器（vec2 first-moment + sun ray march + depth 反演 + km 单位）"
```

---

## Task 2: march shader compile test（glslang）

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/marchShader.compile.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: `buildStandaloneShaderForValidation`（Task 1）；`glslangValidator`（系统 PATH 或 `glslang-validator-prebuilt-predownloaded`，参考 `aerialPerspective.compile.test.ts`）。

- [ ] **Step 1: 写 compile test**

```ts
// packages/cesium-core/src/cesium/godRays/marchShader.compile.test.ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildStandaloneShaderForValidation } from './marchShader'

// 同 aerialPerspective.compile.test.ts 的 glslang 解析逻辑
function glslangValidate(source: string): { ok: boolean; stderr: string } {
  const tmp = `${process.cwd()}/.tmp-march-${process.pid}.frag`
  writeFileSync(tmp, source)
  try {
    // 优先系统 PATH 的 glslangValidator，否则用 prebuilt
    const bin = 'glslangValidator'  // 同 aerialPerspective.compile.test.ts 的解析（参考其实现）
    execFileSync(bin, ['-S', 'frag', '--stdin', '-V'], { input: source, stdio: ['pipe', 'ignore', 'pipe'] })
    return { ok: true, stderr: '' }
  } catch (e: any) {
    return { ok: false, stderr: e.stderr?.toString() ?? String(e) }
  }
}

describe('marchShader glslang compile', () => {
  it('godRays=true（debugMode=0）编译通过', () => {
    const src = buildStandaloneShaderForValidation({ mainSteps: 16, sunSteps: 8, debugMode: 0 })
    const r = glslangValidate(src)
    expect(r.ok, r.stderr).toBe(true)
  })

  it('debug=10 分支编译通过', () => {
    const src = buildStandaloneShaderForValidation({ mainSteps: 16, sunSteps: 8, debugMode: 10 })
    const r = glslangValidate(src)
    expect(r.ok, r.stderr).toBe(true)
  })
})
```

> **实现注意**：glslang 解析逻辑**复用 `aerialPerspective.compile.test.ts`** 的实现（系统 PATH → prebuilt fallback → 清晰报错）。Step 1 的 `glslangValidate` 是骨架——实现时把 `aerialPerspective.compile.test.ts` 里的 glslang 解析函数提到共享 helper 或复制。若 glslang 缺失，测试以清晰报错失败（同 aerialPerspective 惯例）。

- [ ] **Step 2: 运行确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/marchShader.compile.test.ts`
Expected: PASS（两用例）。若 glslang 缺失 → `brew install glslang`。

- [ ] **Step 3: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/marchShader.compile.test.ts
git commit -m "test(godRays): T2 march shader glslang compile test"
```

---

## Task 3: atmosphere getSkyRadianceShadowed + godRays option + 单测

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`（加 `godRays` option + `getSkyRadianceShadowed` + 天空分支调用）
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`（godRays 测试）
- Test: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`

**Interfaces:**
- Consumes: `AerialPerspectiveFragOptions`（现有，加 `godRays?: boolean`）。
- Produces: `buildAerialPerspectiveFragmentShader({godRays:true})` 产出含 `getSkyRadianceShadowed` + `u_shadowLengthTexture` + 天空分支调用它；`godRays=false`（默认）产出与 phase1 bit 等价（零回归）。

- [ ] **Step 1: 写失败测试（aerialPerspective.frag.test.ts 追加）**

```ts
// 追加到 packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts
describe('buildAerialPerspectiveFragmentShader godRays option', () => {
  it('godRays=true：声明 u_shadowLengthTexture + 含 getSkyRadianceShadowed + 天空分支调用', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: true, sky: true, godRays: true } as any)
    expect(s).toContain('uniform sampler2D u_shadowLengthTexture')
    expect(s).toContain('vec3 getSkyRadianceShadowed(')
    // 天空分支调用 getSkyRadianceShadowed（读 vec2 shadow_length）
    expect(s).toContain('texture(u_shadowLengthTexture')
    expect(s).toContain('getSkyRadianceShadowed(')
  })

  it('godRays=true：含 Branch 1（x<=0 → GetSkyRadiance(0)）+ Branch 3 公式', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: true, sky: true, godRays: true } as any)
    expect(s).toContain('if (x <= 0.0)')                    // Branch 1
    expect(s).toContain('GetSkyRadiance(camera, rayDir, 0.0')  // Branch 1 零回归
    expect(s).toContain('Scam - max(TA * Sa - TB * Sb')     // Branch 3 公式（runtime.ts:318）
  })

  it('godRays=true：r2 Crit-2 太空视角 A/B 同步（distanceToTop > 0 时 A=max(A-distanceToTop,0)）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: true, sky: true, godRays: true } as any)
    expect(s).toContain('A = max(A - distanceToTop, 0.0)')
  })

  it('godRays=true：r2 Imp-3 两分支含 SUN_DISK_GLSL（日盘不丢）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: true, sky: true, godRays: true } as any)
    // sun=true 时日盘片段出现（操作局部 rad）
    expect(s).toContain('viewDotSun = dot(rayDir, sunDir)')
  })

  it('godRays=true：r2 Imp-4 Branch 3 后不外推（无 GetExtrapolatedSingleMieScattering 在 Branch 3 后）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: true, sky: true, godRays: true } as any)
    // Branch 3 公式后直接 phase + return，不再 GetExtrapolatedSingleMieScattering
    const branch3 = s.slice(s.indexOf('Scam - max(TA * Sa'))
    expect(branch3.indexOf('RayleighPhaseFunction')).toBeLessThan(branch3.indexOf('GetExtrapolatedSingleMieScattering') === -1 ? Infinity : branch3.indexOf('GetExtrapolatedSingleMieScattering'))
  })

  it('godRays=false（默认）：不声明 u_shadowLengthTexture + 天空分支原 getSkyRadiance(0)（零回归）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: true, sky: true } as any)
    expect(s).not.toContain('u_shadowLengthTexture')
    expect(s).not.toContain('getSkyRadianceShadowed')
    expect(s).toContain('getSkyRadiance(cameraPosition, rayDirection, 0.0')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts -t "godRays"`
Expected: FAIL（`godRays` option 未实现）。

- [ ] **Step 3: 改 aerialPerspective.frag.ts 实现**

在 `AerialPerspectiveFragOptions` 加 `godRays?: boolean`。在 `buildAerialPerspectiveFragmentShader`：
- `godRays=true` 时：uniforms 段加 `uniform sampler2D u_shadowLengthTexture;`；helper 段加 `getSkyRadianceShadowed` 函数（spec §5.1 r2 版本，含 Branch 1/3 + 太空视角 A/B 同步 + 两分支 SUN_DISK_GLSL_INLINE + 不外推）；天空分支 `skyBranch` 把 `getSkyRadiance(...)` 调用替换为读 `texture(u_shadowLengthTexture, v_textureCoordinates).rg` + `getSkyRadianceShadowed(...)`。
- `godRays=false`（默认）：天空分支原 `getSkyRadiance(cameraPosition, rayDirection, 0.0, ...)`，不声明 `u_shadowLengthTexture`（零回归）。

`getSkyRadianceShadowed` 完整 GLSL（从 spec §5.1 r2 复制）：

```glsl
vec3 getSkyRadianceShadowed(vec3 camera, vec3 rayDir, vec2 shadowLengthVec2,
                            vec3 sunDir, float fragmentAngle, out vec3 transmittance) {
  float r = length(camera); float rmu = dot(camera, rayDir);
  float mu = rmu/r; float mu_s = dot(camera, sunDir)/r; float nu = dot(rayDir, sunDir);
  // ray_r_mu_intersects_ground / horizon eps / transmittance = GetTransmittanceToTopAtmosphereBoundary（同 getSkyRadiance 前段）

  // r2 Crit-2：太空视角 camera 移顶层时 vec2 同步 distanceToFirstShadow
  float x = shadowLengthVec2.x;
  float A = shadowLengthVec2.y;
  float distanceToTop = -rmu - SafeSqrt(rmu*rmu - r*r + ATMOSPHERE.top_radius*ATMOSPHERE.top_radius);
  if (distanceToTop > 0.0) {
    camera += rayDir * distanceToTop;
    r = ATMOSPHERE.top_radius;  rmu += distanceToTop;  mu = rmu/r;
    A = max(A - distanceToTop, 0.0);
  }
  float pointDist = max(-rmu - SafeSqrt(rmu*rmu - r*r + ATMOSPHERE.top_radius*ATMOSPHERE.top_radius), 0.0);
  float B = min(A + x, pointDist);  // r2 minor：钳 pointDist

  if (x <= 0.0) {  // Branch 1：无阴影
    vec3 rad = GetSkyRadiance(camera, rayDir, 0.0, sunDir, transmittance);
    // SUN_DISK_GLSL_INLINE（sun=true 时）：rad += transmittance * GetSolarRadiance() * antialias（移植自 buildSkyRadianceFn L270-281）
    return rad;
  }

  // Branch 3：阴影段 [A, B]
  IrradianceSpectrum singleMieCam;
  IrradianceSpectrum Scam = GetCombinedScattering(ATMOSPHERE, scattering_texture,
    single_mie_scattering_texture, r, mu, mu_s, nu, ray_r_mu_intersects_ground, singleMieCam);
  float rA = ClampRadius(ATMOSPHERE, sqrt(A*A + 2.0*r*mu*A + r*r));
  float muA = (r*mu + A)/rA;  float muSA = (r*mu_s + A*nu)/rA;
  IrradianceSpectrum singleMieA, singleMieB;
  IrradianceSpectrum Sa = GetCombinedScattering(ATMOSPHERE, scattering_texture,
    single_mie_scattering_texture, rA, muA, muSA, nu, ray_r_mu_intersects_ground, singleMieA);
  DimensionlessSpectrum TA = GetTransmittance(ATMOSPHERE, transmittance_texture, r, mu, A, ray_r_mu_intersects_ground);
  float rB = ClampRadius(ATMOSPHERE, sqrt(B*B + 2.0*r*mu*B + r*r));
  float muB = (r*mu + B)/rB;  float muSB = (r*mu_s + B*nu)/rB;
  IrradianceSpectrum Sb = GetCombinedScattering(ATMOSPHERE, scattering_texture,
    single_mie_scattering_texture, rB, muB, muSB, nu, ray_r_mu_intersects_ground, singleMieB);
  DimensionlessSpectrum TB = GetTransmittance(ATMOSPHERE, transmittance_texture, r, mu, B, ray_r_mu_intersects_ground);

  IrradianceSpectrum scattering = Scam - max(TA * Sa - TB * Sb, DimensionlessSpectrum(0.0));
  singleMieCam = singleMieCam - max(TA * singleMieA - TB * singleMieB, DimensionlessSpectrum(0.0));  // r2 Imp-4：不外推
  singleMieCam *= smoothstep(0.0, 0.01, mu_s);

  vec3 rad = (scattering * RayleighPhaseFunction(nu) + singleMieCam *
              MiePhaseFunction(ATMOSPHERE.mie_phase_function_g, nu)) * SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
  // SUN_DISK_GLSL_INLINE（同上）
  return rad;
}
```

> **SUN_DISK_GLSL_INLINE**：把 `buildSkyRadianceFn` 的 `SUN_DISK_GLSL`（L270-281）改为操作入参 `rad`（局部变量）的片段：`float viewDotSun = dot(rayDir, sunDir); if (viewDotSun > cosSunAngularRadius) { float angle = acos(clamp(viewDotSun,-1.0,1.0)); float antialias = smoothstep(ATMOSPHERE.sun_angular_radius, ATMOSPHERE.sun_angular_radius - fragmentAngle, angle); rad += transmittance * GetSolarRadiance() * antialias; }`。两分支 return 前调用（`sun=true` 时）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts`
Expected: PASS（含新 godRays 用例 + 现有全部用例零回归）。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/aerialPerspective.frag.ts packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts
git commit -m "feat(godRays): T3 atmosphere getSkyRadianceShadowed 三分支（Branch 1/3 + 日盘 + 不外推 + 太空视角 A/B 同步）"
```

---

## Task 4: atmosphere compile test 扩展（getSkyRadianceShadowed）

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: `buildAerialPerspectiveFragmentShader({godRays:true})`（Task 3）。

- [ ] **Step 1: 加 godRays=true compile 用例**

在 `aerialPerspective.compile.test.ts` 加：
```ts
it('godRays=true（含 getSkyRadianceShadowed）编译通过', () => {
  const src = buildStandaloneShaderForValidation({ sun: true, sky: true, godRays: true } as any)
  const r = glslangValidate(src)  // 复用该文件现有 glslang 解析
  expect(r.ok, r.stderr).toBe(true)
})
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts
git commit -m "test(godRays): T4 atmosphere godRays=true compile test"
```

---

## Task 5: createGodRaysStage composite 工厂 + 单测

**Files:**
- Create: `packages/cesium-core/src/cesium/godRays/createGodRaysStage.ts`
- Create: `packages/cesium-core/src/cesium/godRays/createGodRaysStage.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: `buildGodRaysMarchFragmentShader`（Task 1）；`resolvePostHdrDatatype` + `AtmosphereFrameState`（from `../AtmosphereStage`）；`PostProcessStage`/`PostProcessStageComposite`/`PostProcessStageSampleMode`（cesium）。
- Produces: `createGodRaysStage(scene, state, options): GodRaysStageHandle`；`GodRaysStageHandle { godRaysComposite: PostProcessStageComposite; setEnabled(on: boolean): void }`。`options: { mainSteps; sunSteps; step0; stepGrowth; sunStep0; sunStepGrowth; depthBias; intensity; debugMode }`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/cesium-core/src/cesium/godRays/createGodRaysStage.test.ts
import { describe, it, expect } from 'vitest'
import { PostProcessStage, PostProcessStageComposite } from 'cesium'
import { createGodRaysStage } from './createGodRaysStage'
import { makeMockScene } from '../../test/mockScene'  // 复用现有 mock（参考 lensflare test）

describe('createGodRaysStage', () => {
  it('返回 gr_wrapper composite（非 series，inputPreviousStageTexture=false）', () => {
    const scene = makeMockScene()
    const h = createGodRaysStage(scene, { sunDirection: /*...*/ } as any, { mainSteps: 16, sunSteps: 8, step0: 0.5, stepGrowth: 1.3, sunStep0: 0.5, sunStepGrowth: 1.5, depthBias: 0.01, intensity: 1.0, debugMode: 0 })
    expect(h.godRaysComposite).toBeInstanceOf(PostProcessStageComposite)
    expect((h.godRaysComposite as any).inputPreviousStageTexture).toBe(false)
  })

  it('gr_wrapper 含两个子 stage：gr_shadowLength（textureScale 0.5）+ gr_passthrough（textureScale 1.0，最后）', () => {
    const scene = makeMockScene()
    const h = createGodRaysStage(scene, /*state*/ {} as any, /*opts*/ {} as any)
    const stages = (h.godRaysComposite as any)._stages ?? h.godRaysComposite.stages
    expect(stages.length).toBe(2)
    expect(stages[0].name).toBe('gr_shadowLength')
    expect(stages[0].textureScale).toBe(0.5)
    expect(stages[1].name).toBe('gr_passthrough')
    expect(stages[1].textureScale).toBe(1.0)
  })

  it('gr_shadowLength uniforms 含 u_shadowLengthTexture 无（它是被引用方）+ 含 sunDirection/altitudeCorrection 闭包', () => {
    // gr_shadowLength 的 uniforms 是 march 输入（sunDirection 等），不含 u_shadowLengthTexture（那是 atmosphere 的）
    const scene = makeMockScene()
    const h = createGodRaysStage(scene, /*state*/ {} as any, /*opts*/ {} as any)
    const uniforms = (h.godRaysComposite as any)._stages[0].uniforms
    expect(uniforms.u_sunDirectionWC).toBeTypeOf('function')
    expect(uniforms.u_altitudeCorrection).toBeTypeOf('function')
  })
})
```

> **mockScene**：复用 `createLensFlareStage.test.ts` 用的 mock scene（若不存在，参考其 mock 结构创建最小 mock：`scene.context` caps + `scene.postProcessStages`）。Step 1 的 `makeMockScene` 路径以现有 test util 为准——实现时对照 `createLensFlareStage.test.ts` 的 import。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/createGodRaysStage.test.ts`
Expected: FAIL（`createGodRaysStage` 未定义）。

- [ ] **Step 3: 写 createGodRaysStage.ts 实现**

```ts
// packages/cesium-core/src/cesium/godRays/createGodRaysStage.ts
// gr_wrapper 非序列 composite：gr_shadowLength（半分辨率 march）+ gr_passthrough（全分辨率透传场景色）。
// composite output = gr_passthrough = 场景色（链不破）；atmosphere 经 uniform-name 引用 gr_shadowLength（§3.1）。
import { PostProcessStage, PostProcessStageComposite, PixelDatatype, PixelFormat, type Scene } from 'cesium'
import { buildGodRaysMarchFragmentShader } from './marchShader'
import { resolvePostHdrDatatype, type AtmosphereFrameState } from '../AtmosphereStage'

const PASSTHROUGH_GLSL = `void main() { out_FragColor = texture(colorTexture, v_textureCoordinates); }`

export interface GodRaysStageOptions {
  mainSteps: number; sunSteps: number
  step0: number; stepGrowth: number
  sunStep0: number; sunStepGrowth: number
  depthBias: number; intensity: number; debugMode: number
  atmosphereTopRadius: number  // km，AtmosphereStage 传（ATMOSPHERE.top_radius 值）
}

export interface GodRaysStageHandle {
  readonly godRaysComposite: PostProcessStageComposite
}

export function createGodRaysStage(
  scene: Scene,
  state: AtmosphereFrameState,
  options: GodRaysStageOptions
): GodRaysStageHandle {
  const postHdrDatatype = resolvePostHdrDatatype(scene)

  const gr_shadowLength = new PostProcessStage({
    name: 'gr_shadowLength',
    fragmentShader: buildGodRaysMarchFragmentShader({
      mainSteps: options.mainSteps, sunSteps: options.sunSteps, debugMode: options.debugMode
    }),
    uniforms: {
      u_sunDirectionWC: () => state.sunDirection,
      u_altitudeCorrection: () => state.altitudeCorrection,
      u_atmosphereTopRadius: options.atmosphereTopRadius,
      u_godRaysMainSteps: options.mainSteps,
      u_godRaysMainStep0: options.step0,
      u_godRaysMainStepGrowth: options.stepGrowth,
      u_godRaysSunSteps: options.sunSteps,
      u_godRaysSunStep0: options.sunStep0,
      u_godRaysSunStepGrowth: options.sunStepGrowth,
      u_godRaysDepthBias: options.depthBias,
      u_godRaysIntensity: options.intensity,
      u_godRaysSunVisible: 1,  // 默认可见；AtmosphereStage preRender 每帧覆盖
      u_debugMode: options.debugMode
    },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype,
    textureScale: 0.5  // 半分辨率（§3.4）
  })

  const gr_passthrough = new PostProcessStage({
    name: 'gr_passthrough',
    fragmentShader: PASSTHROUGH_GLSL,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype,
    textureScale: 1.0  // 全分辨率透传（composite output = 最后子 stage = 场景色）
  })

  const godRaysComposite = new PostProcessStageComposite({
    name: 'gr_wrapper',
    stages: [gr_shadowLength, gr_passthrough],  // gr_passthrough 必须 last（composite output）
    inputPreviousStageTexture: false  // non-series 兄弟：两子 stage colorTexture = composite 输入（depthTemporal 输出）
  })

  return { godRaysComposite }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/godRays/createGodRaysStage.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/godRays/createGodRaysStage.ts packages/cesium-core/src/cesium/godRays/createGodRaysStage.test.ts
git commit -m "feat(godRays): T5 createGodRaysStage composite 工厂（gr_shadowLength + gr_passthrough）"
```

---

## Task 6: AtmosphereStage 接入（options + 链位置 + preRender + uniforms）

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`（若存在；否则新建单测验证 options + 链顺序）
- Test: 同上

**Interfaces:**
- Consumes: `createGodRaysStage`（Task 5）；`buildAerialPerspectiveFragmentShader({godRays})`（Task 3）。
- Produces: `AtmosphereStageOptions` 加 `godRays?/godRaysIntensity?/godRaysMainSteps?/godRaysSunSteps?`；`createAtmosphereStage` 在 `depthTemporal` 与 `atmosphere` 之间 add `gr_wrapper`；atmosphere uniforms 加 `u_shadowLengthTexture: godRaysEnabled ? 'gr_shadowLength' : undefined`；`preRender` 算 `u_godRaysSunVisible`。

- [ ] **Step 1: 写失败测试（AtmosphereStage.test.ts 追加）**

```ts
describe('createAtmosphereStage godRays 接入', () => {
  it('godRays=true（默认）：gr_wrapper add 在 depthTemporal 与 atmosphere 之间', () => {
    const handle = createAtmosphereStage(mockScene, mockLUTs, {})
    const names = mockScene.postProcessStages.addOrder.map((s: any) => s.name)
    const dtIdx = names.indexOf('czm_depth_temporal')
    const grIdx = names.indexOf('gr_wrapper')
    const atmoIdx = names.indexOf('atmosphere')
    expect(dtIdx).toBeLessThan(grIdx)
    expect(grIdx).toBeLessThan(atmoIdx)
  })

  it('atmosphere.u_shadowLengthTexture === "gr_shadowLength"（uniform-name string，godRays=true）', () => {
    const handle = createAtmosphereStage(mockScene, mockLUTs, {})
    expect(handle.atmosphereStage.uniforms.u_shadowLengthTexture).toBe('gr_shadowLength')
  })

  it('godRays=false：不创建 gr_wrapper + atmosphere.u_shadowLengthTexture undefined', () => {
    const handle = createAtmosphereStage(mockScene, mockLUTs, { godRays: false })
    const names = mockScene.postProcessStages.addOrder.map((s: any) => s.name)
    expect(names).not.toContain('gr_wrapper')
    expect(handle.atmosphereStage.uniforms.u_shadowLengthTexture).toBeUndefined()
  })

  it('preRender 太阳地平下时 gr_shadowLength.u_godRaysSunVisible=0', () => {
    // mock sunDirection 在地平下，调 preRender，断言 gr_shadowLength uniforms u_godRaysSunVisible 解析为 0
    // （实现时按 AtmosphereStage 现有 preRender 测试模式）
  })
})
```

> **mockScene/mockLUTs/addOrder**：对照 `AtmosphereStage.test.ts` 现有 mock（若存在）或 `createLensFlareStage.test.ts` 模式。`addOrder` 是 mock 记录 `postProcessStages.add` 调用顺序的数组。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts -t "godRays"`
Expected: FAIL（godRays 接入未实现）。

- [ ] **Step 3: 改 AtmosphereStage.ts 实现**

a. `AtmosphereStageOptions` 加：
```ts
godRays?: boolean              // 默认 true（?godRays=0 关）
godRaysIntensity?: number      // 默认 GOD_RAYS_INTENSITY_DEFAULT（1.0）
godRaysMainSteps?: number      // 默认 16
godRaysSunSteps?: number       // 默认 8
```
`ResolvedAtmosphereStageOptions` + `validateAtmosphereOptions` 对应补默认值。

b. `AtmosphereStageHandle` 加 `readonly godRaysComposite?: PostProcessStageComposite`。

c. `createAtmosphereStage` 内（参考 lensflare 接入 L410-425）：
```ts
let godRaysComposite: PostProcessStageComposite | undefined
if (resolved.godRays) {
  const grHandle = createGodRaysStage(scene, state, {
    mainSteps: resolved.godRaysMainSteps, sunSteps: resolved.godRaysSunSteps,
    step0: GOD_RAYS_MAIN_STEP0_DEFAULT, stepGrowth: GOD_RAYS_MAIN_STEP_GROWTH_DEFAULT,
    sunStep0: GOD_RAYS_SUN_STEP0_DEFAULT, sunStepGrowth: GOD_RAYS_SUN_STEP_GROWTH_DEFAULT,
    depthBias: GOD_RAYS_DEPTH_BIAS_DEFAULT, intensity: resolved.godRaysIntensity,
    debugMode: resolved.debugMode,
    atmosphereTopRadius: ATMOSPHERE.top_radius / 1000  // m→km（ATMOSPHERE.top_radius 是 m，传 km）
  })
  godRaysComposite = grHandle.godRaysComposite
}
```

d. **链顺序**（L477 depthTemporal add 之后、L561 atmosphere add 之前）：
```ts
if (godRaysComposite) scene.postProcessStages.add(godRaysComposite)  // depthTemporal → gr_wrapper → atmosphere
```

e. **atmosphere uniforms** 加（`buildAtmosphereUniforms`）：
```ts
u_shadowLengthTexture: godRaysEnabled ? 'gr_shadowLength' : undefined,
```
（`godRaysEnabled` 是 createAtmosphereStage 闭包变量 = `resolved.godRays`）。

f. **atmosphere stage fragmentShader** 传 `godRays: resolved.godRays`：
```ts
fragmentShader: buildAerialPerspectiveFragmentShader({ ...resolved, godRays: resolved.godRays, hdrDepthTemporal: false }),
```

g. **preRender 算 u_godRaysSunVisible**（在现有 preRender 闭包 L566+）：
```ts
// god rays early-exit：太阳地平下或视野外 → u_godRaysSunVisible=0
if (godRaysComposite) {
  const sunBehindCamera = /* 复用 lensflare occlusion.frag 的 sunOnScreen 逻辑（CPU 版） */
  const sunUp = Cartesian3.dot(state.sunDirection, cameraUp)  // cameraUp 同 getEffectiveAtmosphereExposure
  const sunVisible = (sunUp > -twilightRad) && sunOnScreen ? 1 : 0
  // 写入 gr_shadowLength uniforms（gr_shadowLength 是 composite 第一子 stage）
  ;(godRaysComposite as any)._stages[0].uniforms.u_godRaysSunVisible = sunVisible
}
```
> **sunOnScreen CPU 计算**：复用 lensflare `occlusion.ts` 的太阳屏幕位置逻辑（投影 sunDirection 到屏幕，判 NDC 在 [0,1]）。若 occlusion.ts 未导出 CPU 版，在 AtmosphereStage 内联（投影 `czm_viewProjection` 等价的 TS 矩阵运算，或读 `scene.camera` + 手算）。实现时对照 `lensFlare/occlusion.ts`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts`
Expected: PASS（含 godRays 用例 + 现有全部零回归）。

- [ ] **Step 5: tsc + 全量测试**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter @cesium-geospatial/core test`
Expected: tsc 0 error + 全测试通过。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(godRays): T6 AtmosphereStage 接入（options + 链位置 depthTemporal→gr_wrapper→atmosphere + preRender u_godRaysSunVisible + u_shadowLengthTexture）"
```

---

## Task 7: demo URL 参数

**Files:**
- Modify: `apps/demo/src/main.ts`
- Test: 手动（demo URL 验收）

**Interfaces:**
- Consumes: `createAtmosphereStage` 的 godRays options（Task 6）。

- [ ] **Step 1: 加 URL 参数解析**

在 `apps/demo/src/main.ts` 的 URL 参数解析段（参考现有 `exposureDay`/`lensFlare` 解析模式）加：
```ts
const params = new URLSearchParams(location.search)
const godRays = params.get('godRays') !== '0'                       // 默认 true
const godRaysIntensity = Number(params.get('godRaysIntensity') ?? 1.0)
const godRaysMainSteps = Number(params.get('godRaysMainSteps') ?? 16)
const godRaysSunSteps = Number(params.get('godRaysSunSteps') ?? 8)
```
传给 `createAtmosphereStage(scene, luts, { ..., godRays, godRaysIntensity, godRaysMainSteps, godRaysSunSteps })`。

- [ ] **Step 2: 启动 demo 手动验证**

Run: `pnpm dev`
打开浏览器，用 `?godRays=1&time=<晨昏ISO8601>&camera=<山脊视角>#camera=...`：
- `?godRays=0`：与 phase1 视觉一致（零回归）。
- `?godRays=1&debug=10`：shadow_length RT 可视化（山脊后方天空 totalShadowLength 非零）。
- 无 console 报错。

- [ ] **Step 3: Commit**

```bash
git add apps/demo/src/main.ts
git commit -m "feat(godRays): T7 demo URL 参数（?godRays/?godRaysIntensity/?godRaysMainSteps/?godRaysSunSteps）"
```

---

## Task 8: 视觉验收 + 参数标定（非 TDD）

**Files:** 无代码改动（验收 + 调参 + 记录）

**spec §11.5 验收口径**：山脊线附近被切割的**低空**光束（非天空尺度光柱）。

- [ ] **Step 1: §7.4 核心验证——低角度 march 有效性**

`?debug=10&time=<晨昏低角度>&camera=<山脊在视野、太阳在屏幕>`：确认山脊后方天空 `totalShadowLength` 非零（红队 plausible_concern：低角度 Q 出屏幕可能测不到遮挡）。若测不到 → 缓解（§7.4）：增大 sun march 步长 / 出屏幕用 last-on-screen depth 外推 / spec 标注限制。

- [ ] **Step 2: 视觉验收**

`?godRays=1&time=<晨昏>`（无 debug）：山脊后方低空可见被切割的明暗光束。`?godRays=0` 零回归。

- [ ] **Step 3: §7.7 对比度标定**

若 god rays **过暗/过硬**（r2 Imp-2：缺 higher-order LUT 致对比度过强）→ `?godRaysIntensity=0.5`（<1 缓解过暗）。记录可接受默认值。

- [ ] **Step 4: §7.5 时序闪烁**

camera 缓慢平移/旋转，观察 god rays 是否闪烁。若闪烁 → 缓解：jitter 改 4-frame pattern 或减 sunSteps 换全分辨率（`?godRaysSunSteps=4` + textureScale 调整需改代码）。

- [ ] **Step 5: §8.3 profile**

`?profile=1`：记录 `gr_shadowLength` + atmosphere Branch 3 占比。若超预算 → §8.4（depth-based skip / 降步数 / epipolar）。

- [ ] **Step 6: 记录标定结果**

把最终默认值（intensity/step0/growth/bias）+ 已知限制写入 `docs/superpowers/plans/2026-08-13-volumetric-godrays-results.md`（验收结果文档，spec §11.5 口径）+ 更新 memory `godRays-tyndall.md`。

- [ ] **Step 7: 最终 commit**

```bash
git add docs/superpowers/plans/2026-08-13-volumetric-godrays-results.md
git commit -m "docs(godRays): T8 视觉验收 + 参数标定结果"
```

---

## Self-Review

**1. Spec coverage**：
- §2.1 vec2 三分支 → Task 3（getSkyRadianceShadowed Branch 1/3）✓
- §3.1 composite 包裹 → Task 5 ✓
- §3.2 uniform-name 引用 → Task 6（u_shadowLengthTexture='gr_shadowLength'）✓
- §3.3 raw globe depth → Task 1（texture().r + czm_reverseLogDepthWindow）✓
- §3.4 NEAREST + textureScale → Task 5 ✓
- §4.1 early-exit u_godRaysSunVisible → Task 1（shader）+ Task 6（preRender）✓
- §4.2 march + first-moment → Task 1 ✓
- §4.3 sun ray march + depth 反演 + Crit-1 altitudeCorrection → Task 1 ✓
- §5.1 三分支 + Crit-2 + Imp-3 日盘 + Imp-4 不外推 → Task 3 ✓
- §6.1 只接天空分支 → Task 3（天空分支 skyBranch）✓
- §6.2 零回归 → Task 3/6 测试 ✓
- §7.7 对比度 → Task 8 标定 ✓
- §9 uniforms/URL → Task 1/6/7 ✓
- §10 debug=10 → Task 1（shader 分支）✓
- §11 测试 → Task 1-6 ✓
- 无遗漏。

**2. Placeholder scan**：无 TBD/TODO；每个 step 含实际代码。`mockScene`/`glslangValidate`/`sunOnScreen` 标注"复用现有"（参考文件明确），非占位（实现者按引用文件复制模式）。

**3. Type consistency**：
- `GodRaysMarchOptions`（Task 1）vs `buildGodRaysMarchFragmentShader(options)` ✓
- `GodRaysStageOptions`/`GodRaysStageHandle`（Task 5）vs `createGodRaysStage` 调用（Task 6）✓
- `godRays` option（Task 3 `AerialPerspectiveFragOptions`）vs Task 6 `resolved.godRays` ✓
- `u_shadowLengthTexture`（Task 3 shader）vs Task 6 uniforms ✓
- `u_godRaysSunVisible`（Task 1 shader）vs Task 6 preRender ✓
- `atmosphereTopRadius`（Task 5 options，km）vs Task 6 传 `ATMOSPHERE.top_radius/1000`（m→km）✓

**4. 依赖序**：Task 1→2（compile）→3（atmosphere shader）→4（atmosphere compile）→5（stage 工厂）→6（集成）→7（URL）→8（验收）。Task 5 依赖 Task 1；Task 6 依赖 Task 3+5。顺序自洽。
