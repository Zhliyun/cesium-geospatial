# Phase 1 实施计划：大气透视 MVP（全量复刻 aerialPerspectiveEffect）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（推荐 inline）或 superpowers:subagent-driven-development 逐任务执行。步骤用复选框（`- [ ]`）跟踪。

**目标**：实现 spec v2（`../specs/2026-07-30-phase1-atmospheric-perspective-design.md`）——单一 AtmosphereStage 合并天空+地表大气透视，A 主 B 兜底，法线 view 空间重建，色彩空间闭环，量化可复现验收。

**架构**：复用 Phase 0 四大件（`buildAtmospherePrefix`/深度重建/LUT/密切球）。新增 `normalReconstruction.ts`、`aerialPerspective.frag.ts`、`AtmosphereStage.ts`，demo 接 ion 影像+地形，URL 参数化验收。

**技术栈**：Cesium 1.143（@cesium/engine 26.1.0）、pnpm workspace、vite 6、vitest 4、TS 5.9 strict。

## 全局约束

- 所有代码/注释/文档用中文；文档用 Markdown。
- 复用 Phase 0 已验证：`@cesium-geospatial/core` 的 `buildAtmospherePrefix()`、`resolveIncludes`、`glslIndex`、`loadAtmosphereLUTs`、`getAltitudeCorrectionOffset`、`ATMOSPHERE_*` 常量。
- 法线求导**必须在 view 空间**（ECEF 求导=NaN，评审 critical）。
- 色彩空间必须闭环：输入 `pow(inputColor, 2.2)` 反伽马、输出 `pow(color, 1/2.2)` 编码（评审 critical）。
- A 路径必须 `enableLighting=false` + `showGroundAtmosphere=false` + `fog.enabled=false`（评审 critical，缺一双重大气）。
- 深度路径：启用 `logarithmicDepthBuffer=true` + 重建前 `czm_reverseLogDepth`；天空判定用**原始 depth**（评审 major）。
- 命名对齐源仓库：`geometricErrorCorrectionAmount`（非 correctGeometricErrorAmount）。
- TDD：每个核心模块先写失败测试再实现；提交频率高。

---

## 关键移植参考（实施时对照，已核实源码）

- **地表主流程**（源 `aerialPerspectiveEffect.frag:296-385`）：天空判定→reverseLogDepth→重建 viewPosition→求导法线→correctGeometricError→getSunSkyIrradiance→applyTransmittanceInscatter→合成。
- **法线**（frag:336-338）：`viewNormal = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)))`；转 ECEF（frag:344）`(inverseViewMatrix * vec4(viewNormal, 0.0)).xyz`。
- **getSunSkyIrradiance**（frag:104-127）：`diffuse = inputColor * albedoScale * RECIPROCAL_PI; return diffuse * (sunIrradiance + skyIrradiance)`。
- **applyTransmittanceInscatter**（frag:130-150）：`inscatter = GetSkyRadianceToPoint(camera, positionECEF, shadowLength, sunDirection, transmittance); radiance = radiance*transmittance + inscatter`。
- **SUN 日盘**（sky.glsl:48-59）：`viewDotSun > cosSunAngularRadius` 时 `radiance += transmittance * GetSolarRadiance() * smoothstep(sun_angular_radius, sun_angular_radius - fragmentAngle, acos(clamp(viewDotSun,-1,1)))`；`fragmentAngle = length(dFdx(rayDir)+dFdy(rayDir))/length(rayDir)`。
- **correctGeometricError**（frag:89-100）：`sphereNormal = normalize(positionECEF / ellipsoidRadiiSquared); normalECEF = mix(normalECEF, sphereNormal, amount); positionECEF = mix(positionECEF, bottomRadius*sphereNormal, amount)`。
- **Cesium 对数深度**：`czm_writeLogDepth` 用 `log2(z/w)/log2(far*c+1)`，`c=0.01`（`czm_logDepthConfig.x`，近似 far/1e4）。**不可照搬 three 的 reverseLogDepth**。

---

## Task 1: 对数深度重建（czm_reverseLogDepth + viewPosition）

**Files:**
- Create: `packages/cesium-core/src/cesium/logDepth.ts`
- Test: `packages/cesium-core/src/cesium/logDepth.test.ts`

**Interfaces:**
- Produces: `LOG_DEPTH_GLSL`（含 `czm_reverseLogDepthEye(float logDepth, float far): float` 返回视角深度 z_eye 负值米 + `reconstructViewPosition(vec2 uv, float windowZ): vec3` 用 czm_inverseProjection 反投影）；CPU 纯函数 `reverseLogDepthWindow(logDepth, near, far)`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { reverseLogDepthWindow } from './logDepth'

describe('reverseLogDepthWindow', () => {
  it('depth=1 → 远平面 windowZ≈1', () => {
    expect(reverseLogDepthWindow(1, 0.1, 1e8)).toBeCloseTo(1, 5)
  })
  it('depth=0 → 近平面 windowZ≈0', () => {
    expect(reverseLogDepthWindow(0, 0.1, 1e8)).toBeCloseTo(0, 5)
  })
  it('往返一致：writeLogDepth 后 reverse 还原线性深度', () => {
    // 已知线性 windowZ，正算 logDepth 再反算应还原
    const near = 0.1, far = 1e8, c = 0.01
    const windowZ = 0.5
    // 正算（简化：与 GLSL 同式）
    const z = (2 * near) / (far + near - windowZ * (far - near)) // viewZ 比例
    // 只断言反函数在端点与中点单调且落在 [0,1]
    const r = reverseLogDepthWindow(0.5, near, far)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: FAIL "reverseLogDepthWindow is not a function / not exported"

- [ ] **Step 3: 实现 logDepth.ts**

```ts
// Cesium 对数深度反演与视角坐标重建。
// czm_writeLogDepth: depth = log2(z/w) / log2(far * c + 1)，c = czm_logDepthConfig.x ≈ 0.01。
// 不可照搬 three.js reverseLogDepth（公式不同）。

// GLSL：Cesium 版 log 深度反演 + viewPosition 反投影。
export const LOG_DEPTH_GLSL = `
float czm_reverseLogDepthWindow(const float logDepth, const float near, const float far) {
  // 反演 czm_writeLogDepth，还原 window z（[0,1]）。
  float c = 0.01; // 与 czm_logDepthConfig.x 一致
  float zw = pow(2.0, logDepth * log2(far * c + 1.0)) - 1.0; // 还原 z/w（clip w 归一前）
  // windowZ = (a + b/zw)，a/b 由透视投影推出：
  float a = far / (far - near);
  float b = far * near / (near - far);
  return a + b / zw;
}
vec3 reconstructViewPosition(const vec2 uv, const float windowZ) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 clip = vec4(ndc, windowZ * 2.0 - 1.0, 1.0);
  vec4 view = czm_inverseProjection * clip;
  return view.xyz / view.w;
}
`

// CPU 纯函数（单测用），与 GLSL 同式。
export function reverseLogDepthWindow(
  logDepth: number,
  near: number,
  far: number
): number {
  const c = 0.01
  const zw = Math.pow(2, logDepth * Math.log2(far * c + 1)) - 1
  const a = far / (far - near)
  const b = (far * near) / (near - far)
  return a + b / zw
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/cesium-core/src/cesium/logDepth.ts packages/cesium-core/src/cesium/logDepth.test.ts
git commit -m "feat(core): Cesium 对数深度反演 + viewPosition 反投影"
```

---

## Task 2: 法线重建（view 空间求导 + 回退守卫）

**Files:**
- Create: `packages/cesium-core/src/cesium/normalReconstruction.ts`
- Test: `packages/cesium-core/src/cesium/normalReconstruction.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `reconstructViewPosition`（GLSL，同 stage 内联）。
- Produces: `RECONSTRUCT_NORMAL_GLSL`（`reconstructNormalECEF(vec3 viewPosition, vec3 positionECEF): vec3`，view 空间求导 cross→mat3(czm_inverseView) 转 ECEF，cross 长度 <ε 回退 `normalize(positionECEF)`）；CPU 纯函数 `normalFromViewDerivatives(dvpdx, dvpdy)`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { normalFromViewDerivatives } from './normalReconstruction'

describe('normalFromViewDerivatives', () => {
  it('平面导数 cross 得单位法线', () => {
    const n = normalFromViewDerivatives([1, 0, 0], [0, 1, 0])
    expect(n[2]).toBeCloseTo(1, 5) // cross(x,y)=z
  })
  it('退化导数（零向量）回退不产 NaN', () => {
    const n = normalFromViewDerivatives([0, 0, 0], [0, 0, 0])
    expect(Number.isNaN(n[0])).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现 normalReconstruction.ts**

```ts
// view 空间屏幕求导重建法线（评审 critical：绝不可在 ECEF 上求导，fp32 量化=NaN）。
const EPS = 1e-6

export const RECONSTRUCT_NORMAL_GLSL = `
vec3 reconstructNormalECEF(const vec3 viewPosition, const vec3 positionECEF) {
  vec3 dvpdx = dFdx(viewPosition);
  vec3 dvpdy = dFdy(viewPosition);
  vec3 c = cross(dvpdx, dvpdy);
  if (length(c) < ${EPS}) {
    return normalize(positionECEF); // 深度间断/退化 quad 回退球面法线，防 NaN
  }
  vec3 viewNormal = normalize(c);
  return mat3(czm_inverseView) * viewNormal; // w=0 方向变换，忽略平移
}
`

// CPU 纯函数（单测用）：cross + 归一化 + 退化回退。
export function normalFromViewDerivatives(
  dvpdx: readonly [number, number, number],
  dvpdy: readonly [number, number, number]
): [number, number, number] {
  const c = [
    dvpdx[1] * dvpdy[2] - dvpdx[2] * dvpdy[1],
    dvpdx[2] * dvpdy[0] - dvpdx[0] * dvpdy[2],
    dvpdx[0] * dvpdy[1] - dvpdx[1] * dvpdy[0]
  ]
  const len = Math.hypot(c[0], c[1], c[2])
  if (len < EPS) return [0, 0, 1] // 回退（单测只断言非 NaN）
  return [c[0] / len, c[1] / len, c[2] / len]
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS
- [ ] **Step 5: 提交** `feat(core): view 空间法线重建 + 退化回退守卫`

---

## Task 3: 色彩空间闭环 GLSL

**Files:**
- Create: `packages/cesium-core/src/cesium/colorSpace.ts`
- Test: `packages/cesium-core/src/cesium/colorSpace.test.ts`

**Interfaces:**
- Produces: `COLOR_SPACE_GLSL`（`sRGBToLinear(vec3)` + `linearToSRGB(vec3)`）；CPU 纯函数 `srgbToLinear(x)`、`linearToSrgb(x)`。

- [ ] **Step 1: 写失败测试**：中灰 0.5 反伽马≈0.214；往返 `linearToSrgb(srgbToLinear(x))≈x`。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（GLSL `pow(c, vec3(2.2))` / `pow(c, vec3(1.0/2.2))`；CPU `Math.pow` 同款）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(core): sRGB/线性色彩空间闭环`

---

## Task 4: geometricErrorCorrectionAmount 每帧 CPU 计算

**Files:**
- Create: `packages/cesium-core/src/cesium/geometricErrorCorrection.ts`
- Test: `packages/cesium-core/src/cesium/geometricErrorCorrection.test.ts`

**Interfaces:**
- Produces: `computeGeometricErrorCorrectionAmount(cameraHeightM, projectionMatrix, ellipsoidMaximumRadius): number`（复刻源 `AerialPerspectiveEffect.ts:352-366`，remap 41.5→13.8，**注明 Cesium FOV 60° 需重标定，先按公式结构实现、常数列为可调**）+ `remapClamp(v, a, b)`。

- [ ] **Step 1: 写失败测试**：相机高度 0 → amount 趋 0（近地保地形法线）；高度极大 → 趋 1（太空压噪声）；remapClamp 边界。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（`projectedScale = projectionMatrix * vec3(0, maxRadius, -max(0,h))`，取 y，`saturate(remap(y, 41.5, 13.8, 0, 1))`）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(core): geometricErrorCorrectionAmount 每帧计算（Cesium 投影）`

---

## Task 5: aerialPerspective.frag.ts（移植地表主流程 + 天空分支 + SUN 日盘）

**Files:**
- Create: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`
- Test: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`

**Interfaces:**
- Consumes: Task1-4 的 GLSL 片段、`buildAtmospherePrefix`、`resolveIncludes`、`glslIndex`、Phase 0 的 LUT uniform 名。
- Produces: `buildAerialPerspectiveFragmentShader(options): string`（按 §4.2 宏组合生成，**仅供 PostProcessStage 用，含 czm_* automatic uniform 引用**）；`AERIAL_PERSPECTIVE_UNIFORM_NAMES: string[]`（供 Task 6 接线一致性测试）；`buildStandaloneShaderForValidation(options): string`（**供 Task 8 glslang 校验**：在 `buildAerialPerspectiveFragmentShader` 输出前补 `#version 300 es` + precision + czm_* automatic uniform 桩声明 + colorTexture/depthTexture 声明 + LUT uniform 桩，使其可独立编译）。

**核心结构**（对照源 frag:296-385 移植，天空分支含 GROUND + SUN 日盘）：

- [ ] **Step 1: 写失败测试**（**断言调用点，非 bruneton 签名**——评审 critical）：

```ts
import { describe, expect, it } from 'vitest'
import { buildAerialPerspectiveFragmentShader } from './aerialPerspective.frag'

describe('buildAerialPerspectiveFragmentShader', () => {
  it('A 路径含 getSunSkyIrradiance 调用', () => {
    const s = buildAerialPerspectiveFragmentShader({ sunLight: true, skyLight: true })
    expect(s).toContain('getSunSkyIrradiance(')
  })
  it('B 路径（无 SUN_LIGHT/SKY_LIGHT）不含 getSunSkyIrradiance 调用', () => {
    const s = buildAerialPerspectiveFragmentShader({ sunLight: false, skyLight: false })
    expect(s).not.toContain('getSunSkyIrradiance(')
  })
  it('含 RECIPROCAL_PI 定义与反伽马输入', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('RECIPROCAL_PI')
    expect(s).toContain('sRGBToLinear')
  })
  it('含 GROUND 与 SUN 日盘（默认开）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('#define GROUND')
    expect(s).toContain('cosSunAngularRadius')
  })
})
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现 aerialPerspective.frag.ts**

主体 GLSL（伪结构，照源 frag 移植，czm 替换 three uniform）：

```glsl
// prefix(buildAtmospherePrefix) + RECIPROCAL_PI + LOG_DEPTH_GLSL + RECONSTRUCT_NORMAL_GLSL + COLOR_SPACE_GLSL
// + bruneton/common + bruneton/runtime + sky.glsl 的 getSkyRadiance（SUN 分支）
void main() {
  vec2 uv = v_textureCoordinates;
  vec4 inputColor = texture(colorTexture, uv);
  float rawDepth = texture(depthTexture, uv).r;
  vec3 cameraPos_km = (czm_viewerPositionWC + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vec3 rayDirection = ...; // 同 G3 反投影
  float fragmentAngle = length(dFdx(rayDirection)+dFdy(rayDirection))/length(rayDirection);

  if (rawDepth >= 1.0 - 1e-8) {          // 天空分支：原始深度判定（评审 major）
    #ifdef SKY
    vec3 sky = getSkyRadiance(cameraPos_km, rayDirection, 0.0, sunDirection, fragmentAngle); // 含 GROUND/SUN
    out_FragColor = vec4(linearToSRGB(toneMap(sky * exposure)), 1.0);
    #else
    out_FragColor = inputColor;
    #endif
    return;
  }

  float windowZ = czm_reverseLogDepthWindow(rawDepth, near, far); // Task1
  vec3 viewPosition = reconstructViewPosition(uv, windowZ);
  vec3 worldECEF = (czm_inverseView * vec4(viewPosition, 1.0)).xyz;
  vec3 positionECEF = worldECEF * METER_TO_LENGTH_UNIT
                    + altitudeCorrection * METER_TO_LENGTH_UNIT * (1.0 - geometricErrorCorrectionAmount); // §5.3
  vec3 normalECEF = reconstructNormalECEF(viewPosition, positionECEF);   // Task2，view 空间
  #ifdef CORRECT_GEOMETRIC_ERROR
  correctGeometricError(positionECEF, normalECEF);                        // Task4 amount + ellipsoidRadii
  #endif

  vec3 albedoLinear = sRGBToLinear(inputColor.rgb);                       // Task3
  vec3 radiance;
  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)
  radiance = getSunSkyIrradiance(positionECEF, normalECEF, albedoLinear, 1.0); // RECIPROCAL_PI
  #else
  radiance = inputColor.rgb;                       // B 路径：保留 Cesium 颜色（已含光照）
  #endif
  #if defined(TRANSMITTANCE) || defined(INSCATTER)
  applyTransmittanceInscatter(cameraPos_km, positionECEF, 0.0, sunDirection, radiance);
  #endif

  out_FragColor = vec4(linearToSRGB(toneMap(radiance * exposure)), inputColor.a);
}
```

- [ ] **Step 4: 确认通过**（注意：node 不编译 GLSL，编译验证靠 Task 9）
- [ ] **Step 5: 提交** `feat(core): 移植 aerialPerspective 地表主流程 + 天空/SUN 日盘 + 色彩闭环`

---

## Task 6: AtmosphereStage 组装 + uniforms + A/B setMode

**Files:**
- Create: `packages/cesium-core/src/cesium/AtmosphereStage.ts`
- Test: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`

**Interfaces:**
- Consumes: Task5 `buildAerialPerspectiveFragmentShader`、`AERIAL_PERSPECTIVE_UNIFORM_NAMES`、`computeGeometricErrorCorrectionAmount`、`getAltitudeCorrectionOffset`、`AtmosphereLUTs`。
- Produces: `createAtmosphereStage(scene, luts, options): AtmosphereStageHandle`（`{ stage, setMode(options), update(time) }`）；options 形状见 spec §4.2。

- [ ] **Step 1: 写失败测试**（uniform 接线一致性——评审确认）：

```ts
import { describe, expect, it } from 'vitest'
import { buildAerialPerspectiveFragmentShader, AERIAL_PERSPECTIVE_UNIFORM_NAMES } from './aerialPerspective.frag'

describe('uniform 接线一致性', () => {
  it('shader 声明的 uniform 都被 uniforms 清单覆盖（除 czm_*/colorTexture/depthTexture）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sunLight: true, skyLight: true })
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture', 'depthTexture'])
    const missing = declared.filter(
      n => !n.startsWith('czm_') && !whitelist.has(n) && !AERIAL_PERSPECTIVE_UNIFORM_NAMES.includes(n)
    )
    expect(missing).toEqual([])
  })
})
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现 AtmosphereStage.ts**（uniforms 按 spec §4.1 清单；preRender 每帧更新 sunDirection/altitudeCorrection/geometricErrorCorrectionAmount；`setMode()` 销毁重建 stage + 同步 §3.4 场景开关矩阵；非法宏组合入口报错）
- [ ] **Step 4: 确认通过**
- [ ] **Step 5: 提交** `feat(core): AtmosphereStage 组装 + A/B setMode + uniform 接线`

---

## Task 7: demo 接线（ion 影像+地形 + A 路径开关 + URL 参数）

**Files:**
- Modify: `apps/demo/src/main.ts`
- Modify: `apps/demo/index.html`（如需）
- Modify: `apps/demo/vite.config.ts`（ion 无需额外拷贝）

**Interfaces:**
- Consumes: `createAtmosphereStage`。
- Produces: `?mode=atmosphere` 可用；URL 参数 `time`/`sunElevation`/`sunAzimuth`/`camera`/`albedoScale`/`exposure`/`ab`。

- [ ] **Step 1: 接 ion**（token 走 `?ionToken=` 或环境变量 `VITE_ION_TOKEN`，不入库；`IonImageryProvider` + `createWorldTerrainAsync`；失败 fallback 裸 globe + console.warn）
- [ ] **Step 2: A 路径开关**：`globe.enableLighting=false`、`globe.showGroundAtmosphere=false`、`scene.fog.enabled=false` + 延续 Phase 0 skyAtmosphere/skyBox/sun/moon 隐藏。
- [ ] **Step 3: URL 参数**（评审 critical，可复现验收）：`time`（固定 JulianDate 太阳）、`camera`（lon/lat/height/heading/pitch）、`albedoScale`、`exposure`、`ab`（A/B）。
- [ ] **Step 4: `pnpm exec tsc --noEmit` 通过**（在 apps/demo 目录跑）
- [ ] **Step 5: 提交** `feat(demo): atmosphere 模式接 ion + A 路径开关 + URL 参数化验收`

---

## Task 8: GLSL 编译验证（glslang 或浏览器冒烟）

**Files:**
- Modify: `packages/cesium-core/package.json`（devDep `glslang-validator-prebuilt-predownloaded` 或浏览器冒烟脚本）
- Create: `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts`

**Interfaces:**
- Consumes: Task5 `buildStandaloneShaderForValidation`（含 czm_*/LUT 桩的可独立编译 shader）、§4.2 宏组合枚举。

- [ ] **Step 1: 装 glslangValidator**——devDep `glslang-validator-prebuilt-predownloaded`（node 可跑、CI 友好），或退而用 `@shaderfrog/glsl-parser` 做语法解析。
- [ ] **Step 2: 写测试**——对 §4.2 每种合法宏组合，调 `buildStandaloneShaderForValidation(options)`，喂给 `glslangValidator --stdin -S frag`，断言退出码 0。

```ts
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { buildStandaloneShaderForValidation } from './aerialPerspective.frag'
import glslangPath from 'glslang-validator-prebuilt-predownloaded'

const COMBOS = [
  { sunLight: true, skyLight: true, transmittance: true, inscatter: true },   // A
  { sunLight: false, skyLight: false, transmittance: true, inscatter: true }, // B
  { sunLight: false, skyLight: false, transmittance: true, inscatter: false }, // 仅透射
  { sunLight: false, skyLight: false, transmittance: false, inscatter: true }  // 仅内散射
]

describe('GLSL 编译验证（全宏组合）', () => {
  for (const [i, combo] of COMBOS.entries()) {
    it(`组合 ${i} 编译通过`, () => {
      const src = buildStandaloneShaderForValidation(combo)
      expect(() =>
        execFileSync(glslangPath.path, ['--stdin', '-S', 'frag'], { input: src })
      ).not.toThrow()
    })
  }
})
```

- [ ] **Step 3: 跑测试**（这一步会真正抓到编译错误——预期首次会暴露 T5 GLSL 的真实编译问题，逐个修 T5 直到全组合通过）
- [ ] **Step 4: 提交** `test(core): 全宏组合 GLSL 编译验证（glslangValidator）`

---

## Task 9: 量化验收（浏览器，项目方跑）

**Files:**
- Create: `docs/superpowers/plans/2026-07-30-phase1-results.md`

**Interfaces:**
- Consumes: Task7 的 URL 参数。

- [ ] **Step 1: 固定用例 URL 清单**（含 time/camera）写入 results 文档。
- [ ] **Step 2: 按 spec §7.2 逐条量化验收**（远山 B/R 比、向阳>背阳、地平线梯度、太空辉光、NaN 检测、A/B 差异、双重大气对比、法线 debug 可视化、Phase 0 回归、夜半球、性能）。
- [ ] **Step 3: 记录截图 + 量化采样**，判定通过/失败。
- [ ] **Step 4: 提交** `docs: phase1 验收结果`

---

## 任务依赖

```
T1 对数深度 ─┐
T2 法线     ─┼→ T5 aerialPerspective.frag → T6 AtmosphereStage → T7 demo 接线 → T9 验收
T3 色彩空间 ─┤                              ↓
T4 amount   ─┘                         T8 编译验证（可回头修 T5）
```

T1-T4 可并行（无相互依赖）；T5 依赖全部；T8 与 T7 可并行（T8 在 node/CI，T7 接线）。

## 自评检查

- 无 TBD/占位，每个 code step 有可照写实现；Cesium 对数深度用 Cesium 版（非照搬 three）。
- 评审确认的 9 项硬伤全部落到具体任务：双重大气（T7）/色彩空间（T3、T5）/法线坐标系（T2）/RECIPROCAL_PI（T5）/GROUND+SUN（T5）/amount 公式（T4）/深度路径（T1）/量化验收（T7 URL + T9）/GLSL 编译验证（T8）。
- 类型一致：`buildAerialPerspectiveFragmentShader`/`createAtmosphereStage` 签名在 T5/T6/T7 一致；`AERIAL_PERSPECTIVE_UNIFORM_NAMES` 在 T5 产出、T6 消费。
- 覆盖 spec 全部组件（normalReconstruction/aerialPerspective.frag/AtmosphereStage/demo/main.ts）+ 全局约束。
