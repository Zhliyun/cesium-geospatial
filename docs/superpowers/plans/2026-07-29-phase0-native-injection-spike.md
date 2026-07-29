# Phase 0: 原生注入验证 Spike 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最小 Cesium demo 钉死 go/no-go 三件事——①源仓库 bruneton GLSL 在 Cesium 编译通过；②depthTexture 重建世界坐标正确；③ECEF 相机桥接 + 密切球再中心化正确——为后续 Phase 1+ 扫清致命风险。

**Architecture:** pnpm monorepo，`packages/cesium-core`（渲染器无关 GLSL/数学层 + Cesium 适配基建）+ `apps/demo`（Vite + Cesium）。天空与深度重建各做一个 PostProcessStage。LUT 直接加载源仓库 `.bin` 预计算文件（half-float），不做预计算。

**Tech Stack:** TypeScript 5.9 strict、pnpm workspace、Vite 7、vitest、Cesium（最新稳定版）、`@petamoriken/float16`（half 解码，源仓库同款）。

## Global Constraints

（逐条来自设计文档 `docs/superpowers/specs/2026-07-29-cesium-geospatial-port-design.md`，每个任务隐含遵守）

- **WebGL2 only**，不引入 WebGPU / compute shader。
- **不引入 Three.js**，不 fork Cesium 源码。
- **GLSL 资产层不得出现任何 Cesium/Three 标识符**（`czm_*`、`cameraPosition` 等 three 名）；three/Cesium uniform 桥接集中在 `cesium-core/src/cesium/` 适配层。
- 包名 scope：`@cesium-geospatial/*`。
- MVP 渲染设置：`viewer.scene.logarithmicDepthBuffer = false`（先回避对数深度）。
- 从源仓库拷贝的 GLSL **保持文件名与内容不变**（含 Bruneton 版权头）。
- `AtmosphereParameters.DEFAULT` 物理常量值固定（见 Task 2），不随帧变化。

---

## File Structure

```
cesium-geospatial/
├── package.json                      # T1: pnpm workspace 根
├── pnpm-workspace.yaml               # T1
├── tsconfig.base.json                # T1
├── .gitignore                        # T1
├── packages/
│   └── cesium-core/
│       ├── package.json              # T1
│       ├── tsconfig.json             # T1
│       ├── vitest.config.ts          # T1
│       └── src/
│           ├── index.ts              # T2: 公共导出
│           ├── glsl/                 # T2: 从源仓库拷贝，保持原样
│           │   ├── raySphereIntersection.glsl
│           │   ├── math.glsl transform.glsl packing.glsl depth.glsl
│           │   ├── generators.glsl interleavedGradientNoise.glsl
│           │   ├── cascadedShadowMaps.glsl turbo.glsl vogelDisk.glsl
│           │   └── bruneton/{definitions,common,runtime,precompute}.glsl
│           ├── glslIndex.ts          # T2: ?raw 导出全部 GLSL
│           ├── resolveIncludes.ts    # T2: 从源仓库搬，零改动
│           ├── unrollLoops.ts        # T2: 从源仓库搬，零改动
│           ├── resolveIncludes.test.ts # T2
│           ├── math/
│           │   ├── atmosphereParameters.ts  # T2: DEFAULT 常量（TS）
│           │   ├── altitudeCorrection.ts    # T2: 密切球校正（Cesium 类型）
│           │   └── altitudeCorrection.test.ts
│           └── cesium/               # T3: Cesium 适配基建
│               ├── cesiumCore.ts           # T3: czm 注入前缀（纹理尺寸 #define + ATMOSPHERE const）
│               ├── depthReconstruction.ts  # T3: GLSL 片段 + TS
│               ├── depthReconstruction.test.ts
│               ├── lutLoader.ts            # T4: .bin half-float 解析
│               ├── cesiumTextures.ts       # T4: 2D/3D 纹理创建
│               └── lutLoader.test.ts
├── apps/
│   └── demo/
│       ├── package.json              # T1
│       ├── index.html                # T7
│       ├── vite.config.ts            # T7
│       └── src/
│           ├── main.ts               # T7: Cesium Viewer
│           ├── SkyStage.ts           # T5: 天空 PostProcessStage（G1+G3）
│           ├── skyStage.frag.ts      # T5: 天空 fragment GLSL（组装）
│           ├── DepthDebugStage.ts    # T6: 深度重建可视化（G2）
│           └── depthDebugStage.frag.ts # T6
```

**责任边界**：`glsl/`、`resolveIncludes`、`unrollLoops`、`math/` 是渲染器无关层（纯 JS/GLSL，零 Cesium 依赖）；`cesium/` 是适配层（依赖 cesium）。`apps/demo` 组装验证。

---

## Task 1: 项目骨架（pnpm workspace + TS + 包结构）

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/cesium-core/package.json`, `packages/cesium-core/tsconfig.json`, `packages/cesium-core/vitest.config.ts`
- Create: `apps/demo/package.json`

**Interfaces:**
- Produces: 可 `pnpm install` 的 workspace；`@cesium-geospatial/core` 包名；`cesium` 与 `@petamoriken/float16` 作为依赖。

- [ ] **Step 1: 写根 `package.json`**

```json
{
  "name": "cesium-geospatial",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "scripts": {
    "dev": "pnpm --filter demo dev",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  },
  "packageManager": "pnpm@10.32.1"
}
```

- [ ] **Step 2: 写 `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: 写 `tsconfig.base.json`**（照搬源仓库约定）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: 写 `.gitignore`**

```
node_modules/
dist/
.DS_Store
*.log
.vite/
```

- [ ] **Step 5: 写 `packages/cesium-core/package.json`**

```json
{
  "name": "@cesium-geospatial/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "build": "vite build"
  },
  "dependencies": {
    "@petamoriken/float16": "^3.9.3"
  },
  "peerDependencies": {
    "cesium": "*"
  },
  "devDependencies": {
    "cesium": "^1.125.0",
    "typescript": "^5.9.2",
    "vite": "^7.1.0",
    "vitest": "^4.1.0"
  }
}
```

> 注：Cesium 版本 `^1.125.0` 为占位下限，Task 7 安装后用实际最新稳定版锁定。

- [ ] **Step 6: 写 `packages/cesium-core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 7: 写 `packages/cesium-core/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', globals: true }
})
```

- [ ] **Step 8: 写 `apps/demo/package.json`**

```json
{
  "name": "demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@cesium-geospatial/core": "workspace:*",
    "cesium": "^1.125.0",
    "@petamoriken/float16": "^3.9.3"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vite": "^7.1.0",
    "vite-plugin-cesium": "^1.2.22"
  }
}
```

- [ ] **Step 9: 运行 `pnpm install` 验证 workspace 可装**

Run: `pnpm install`
Expected: 成功，生成 `node_modules`，无 workspace 解析错误。记录 Cesium 实际安装版本，回填到上面 `^1.125.0` 处为精确锁定版本。

- [ ] **Step 10: 初始化 git 并提交**

```bash
git add -A
git commit -m "chore: bootstrap pnpm monorepo skeleton (cesium-core + demo)"
```

---

## Task 2: cesium-core 渲染器无关层（GLSL 资产 + 组装工具 + 数学）

**Files:**
- Create: 从源仓库拷贝 `packages/cesium-core/src/glsl/**`（保持原样）
- Create: `src/glslIndex.ts`, `src/resolveIncludes.ts`, `src/unrollLoops.ts`, `src/resolveIncludes.test.ts`
- Create: `src/math/atmosphereParameters.ts`, `src/math/altitudeCorrection.ts`, `src/math/altitudeCorrection.test.ts`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: 源仓库 `/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial/packages/{core,atmosphere}/src/shaders/**`
- Produces:
  - `resolveIncludes(source: string, includes: Includes): string`
  - `unrollLoops(source: string): string`
  - `glslIndex`：`{ bruneton: {definitions,common,runtime,precompute}, core: {raySphereIntersection, math, ...} }` 全为 `string`
  - `ATMOSPHERE_DEFAULT_GLSL`：`string`，一个 `const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(...);` 构造表达式
  - `getAltitudeCorrectionOffset(cameraECEF: Cartesian3, bottomRadius: number, ellipsoid: Ellipsoid, result: Cartesian3): Cartesian3`（用 Cesium `Ellipsoid`/`Cartesian3`）

- [ ] **Step 1: 拷贝 GLSL 资产，保持原样**

```bash
SRC=/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial/packages
DST=packages/cesium-core/src/glsl
mkdir -p $DST/bruneton
cp $SRC/core/src/shaders/{math,transform,packing,depth,generators,interleavedGradientNoise,cascadedShadowMaps,turbo,vogelDisk,raySphereIntersection}.glsl $DST/
cp $SRC/atmosphere/src/shaders/bruneton/{definitions,common,runtime,precompute}.glsl $DST/bruneton/
```

Expected: 10 个 core `.glsl` + 4 个 bruneton `.glsl` 到位，内容含 Bruneton 版权头，零改动。

- [ ] **Step 2: 拷贝 `resolveIncludes.ts` 与 `unrollLoops.ts`（零改动）**

```bash
SRC=/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial/packages/core/src
cp $SRC/resolveIncludes.ts packages/cesium-core/src/
cp $SRC/unrollLoops.ts packages/cesium-core/src/
```

预期 `resolveIncludes.ts` 内容与源仓库逐字一致（`includePattern` 正则 + 递归 reduce）。

- [ ] **Step 3: 写 `src/glslIndex.ts`（?raw 导出）**

```ts
import _raySphereIntersection from './glsl/raySphereIntersection.glsl?raw'
import _math from './glsl/math.glsl?raw'
import _transform from './glsl/transform.glsl?raw'
import _packing from './glsl/packing.glsl?raw'
import _depth from './glsl/depth.glsl?raw'
import _generators from './glsl/generators.glsl?raw'
import _interleavedGradientNoise from './glsl/interleavedGradientNoise.glsl?raw'
import _cascadedShadowMaps from './glsl/cascadedShadowMaps.glsl?raw'
import _turbo from './glsl/turbo.glsl?raw'
import _vogelDisk from './glsl/vogelDisk.glsl?raw'
import _definitions from './glsl/bruneton/definitions.glsl?raw'
import _common from './glsl/bruneton/common.glsl?raw'
import _runtime from './glsl/bruneton/runtime.glsl?raw'
import _precompute from './glsl/bruneton/precompute.glsl?raw'

export const glslIndex = {
  core: {
    raySphereIntersection: _raySphereIntersection,
    math: _math,
    transform: _transform,
    packing: _packing,
    depth: _depth,
    generators: _generators,
    interleavedGradientNoise: _interleavedGradientNoise,
    cascadedShadowMaps: _cascadedShadowMaps,
    turbo: _turbo,
    vogelDisk: _vogelDisk
  },
  bruneton: {
    definitions: _definitions,
    common: _common,
    runtime: _runtime,
    precompute: _precompute
  }
} as const
```

> 注：vite 内置 `?raw`；vitest 需在 `vitest.config.ts` 加 `assetsInclude: ['**/*.glsl']` 并用 `?raw` loader（见 Step 4 调整）。

- [ ] **Step 4: 调整 `vitest.config.ts` 让 vitest 处理 `?raw`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', globals: true },
  assetsInclude: ['**/*.glsl']
})
```

（vitest 对 `?raw` 默认返回文件内容字符串；如失败，回退用 `fs.readFileSync` 在测试里直接读 `.glsl`。）

- [ ] **Step 5: 写 `src/resolveIncludes.test.ts`（从源仓库同名测试搬并适配）**

```ts
import { describe, it, expect } from 'vitest'
import { resolveIncludes } from './resolveIncludes'

describe('resolveIncludes', () => {
  it('递归展开 #include 路径', () => {
    const includes = {
      core: { raySphereIntersection: 'float rsi() { return 0.0; }' }
    }
    const source = '#include "core/raySphereIntersection"\nvoid main(){}'
    expect(resolveIncludes(source, includes)).toBe(
      'float rsi() { return 0.0; }\nvoid main(){}'
    )
  })

  it('找不到 include 时抛错', () => {
    expect(() => resolveIncludes('#include "missing"', {})).toThrow(
      /Could not find include for missing/
    )
  })
})
```

- [ ] **Step 6: 运行测试，确认失败→通过**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: 2 个 resolveIncludes 测试通过。

- [ ] **Step 7: 写 `src/math/atmosphereParameters.ts`（DEFAULT 物理常量 → GLSL const 表达式）**

值逐字取自源仓库 `AtmosphereParameters.DEFAULT` + `constants.METER_TO_LENGTH_UNIT`。

```ts
// 物理常量逐字取自 three-geospatial AtmosphereParameters.DEFAULT。
// bottomRadius/topRadius 已乘 METER_TO_LENGTH_UNIT (1/1000) → km。
// 返回 GLSL：`const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(...);`
export const ATMOSPHERE_DEFAULT_GLSL = `const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(
  IrradianceSpectrum(1.474, 1.8504, 1.91198),  // solar_irradiance
  0.004675,                                    // sun_angular_radius
  6360.0,                                      // bottom_radius (km)
  6420.0,                                      // top_radius (km)
  DensityProfile(DensityProfileLayer(0.0, 0.0, 0.0, 0.0, 0.0), DensityProfileLayer(0.0, 1.0, -0.125, 0.0, 0.0)),  // rayleigh_density
  ScatteringSpectrum(0.005802, 0.013558, 0.0331),  // rayleigh_scattering
  DensityProfile(DensityProfileLayer(0.0, 0.0, 0.0, 0.0, 0.0), DensityProfileLayer(0.0, 1.0, -0.833333, 0.0, 0.0)),  // mie_density
  ScatteringSpectrum(0.003996, 0.003996, 0.003996),  // mie_scattering
  ScatteringSpectrum(0.00444, 0.00444, 0.00444),     // mie_extinction
  0.8,                                              // mie_phase_function_g
  DensityProfile(DensityProfileLayer(25.0, 0.0, 0.0, 0.06666667, -0.66666667), DensityProfileLayer(0.0, 0.0, 0.0, -0.06666667, 2.66666667)),  // absorption_density
  ScatteringSpectrum(0.00065, 0.001881, 0.000085),  // absorption_extinction
  DimensionlessSpectrum(0.1, 0.1, 0.1),             // ground_albedo
  -0.5                                               // mu_s_min (cos 120deg)
);`

// CPU 侧需要的标量（密切球校正、cosSunAngularRadius 等）
export const ATMOSPHERE_BOTTOM_RADIUS_M = 6360000
export const SUN_ANGULAR_RADIUS = 0.004675
```

> 关键：源仓库用 `uniform AtmosphereParameters ATMOSPHERE;`（struct uniform，Cesium PostProcessStage 的 uniformMap 无法表达嵌套 struct 数组）。这里改为 `const` 构造注入，绕过障碍（Task 5 在组装时用它替换 `uniform` 声明）。

- [ ] **Step 8: 写 `src/math/altitudeCorrection.ts`（密切球再中心化，Cesium 类型）**

算法逐字取自源仓库 `getAltitudeCorrectionOffset` + `Ellipsoid.getOsculatingSphereCenter`，类型换 Cesium 原生。

```ts
import { Cartesian3, Ellipsoid, type Cartographic } from 'cesium'

const normalScratch = new Cartesian3()
const surfaceScratch = new Cartesian3()

// 源仓库算法：surfacePosition = projectOnSurface(camera)；
// osculatingSphereCenter = surfacePosition - bottomRadius * surfaceNormal；
// 返回 -center（即 altitudeCorrection offset），加到相机 ECEF 上即可把相机
// 平移到"以密切球中心为原点"的局部系。
export function getAltitudeCorrectionOffset(
  cameraECEF: Cartesian3,
  bottomRadius: number,
  ellipsoid: Ellipsoid,
  result: Cartesian3
): Cartesian3 {
  const surface = ellipsoid.scaleToGeodeticSurface(cameraECEF, surfaceScratch)
  if (surface == null) {
    return Cartesian3.clone(Cartesian3.ZERO, result)
  }
  // geodetic surface normal = surface 归一化（球近似下与密切球法线一致；
  // 源仓库用椭球面法线 = (x/a², y/a², z/b²) 归一化，对 WGS84 差异 < 密切球半径量级，
  // G3 验证时确认是否需精确椭球法线）。
  const normal = Cartesian3.normalize(surface, normalScratch)
  // center = surface - bottomRadius * normal；offset = -center = bottomRadius*normal - surface
  result = Cartesian3.multiplyByScalar(normal, bottomRadius, result)
  result = Cartesian3.subtract(result, surface, result)
  return result
}
```

- [ ] **Step 9: 写 `src/math/altitudeCorrection.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { Cartesian3, Ellipsoid } from 'cesium'
import { getAltitudeCorrectionOffset, ATMOSPHERE_BOTTOM_RADIUS_M } from './altitudeCorrection'

describe('getAltitudeCorrectionOffset', () => {
  it('相机在地表赤道上时，校正后相机 ≈ 密切球半径量级', () => {
    const ellipsoid = Ellipsoid.WGS84
    const camera = new Cartesian3(6378137, 0, 0) // 赤道地表
    const result = new Cartesian3()
    const offset = getAltitudeCorrectionOffset(camera, ATMOSPHERE_BOTTOM_RADIUS_M, ellipsoid, result)
    // offset 应使 camera + offset 落在 ~bottomRadius 量级（密切球中心化）
    const localized = Cartesian3.add(camera, offset, new Cartesian3())
    expect(Cartesian3.magnitude(localized)).toBeGreaterThan(6300000)
    expect(Cartesian3.magnitude(localized)).toBeLessThan(6500000)
  })

  it('相机为 0 向量时返回 0', () => {
    const result = new Cartesian3()
    const offset = getAltitudeCorrectionOffset(new Cartesian3(0, 0, 0), 6360000, Ellipsoid.WGS84, result)
    expect(offset).toEqual(Cartesian3.ZERO)
  })
})
```

> 注：`scaleToGeodeticSurface(0,0,0)` 返回 undefined → 返回 ZERO，符合源仓库 `surfacePosition != null ? ... : setScalar(0)`。

- [ ] **Step 10: 运行全部 core 测试**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: resolveIncludes (2) + altitudeCorrection (2) 全通过。

- [ ] **Step 11: 写 `src/index.ts` 公共导出**

```ts
export { resolveIncludes } from './resolveIncludes'
export { unrollLoops } from './unrollLoops'
export { glslIndex } from './glslIndex'
export {
  ATMOSPHERE_DEFAULT_GLSL,
  ATMOSPHERE_BOTTOM_RADIUS_M,
  SUN_ANGULAR_RADIUS
} from './math/atmosphereParameters'
export { getAltitudeCorrectionOffset } from './math/altitudeCorrection'
```

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "feat(core): port renderer-agnostic GLSL assets, assembly tools, atmosphere math"
```

---

## Task 3: cesium-core 适配层 — czm 注入前缀 + 深度重建

**Files:**
- Create: `src/cesium/cesiumCore.ts`, `src/cesium/depthReconstruction.ts`, `src/cesium/depthReconstruction.test.ts`
- Modify: `src/index.ts`（导出新模块）

**Interfaces:**
- Consumes: Task 2 的 `glslIndex`、`ATMOSPHERE_DEFAULT_GLSL`、`resolveIncludes`
- Produces:
  - `buildAtmospherePrefix(): string` —— 拼装 `#define`（PI、纹理尺寸、METER_TO_LENGTH_UNIT、COMBINED_SCATTERING_TEXTURES）+ `ATMOSPHERE_DEFAULT_GLSL`，作为任何大气 shader 的前缀
  - `DEPTH_RECONSTRUCTION_GLSL: string` —— `reconstructWorldPosition(depthTexture, uv)` 函数片段
  - `reconstructWorldPositionCPU(...)` —— 纯函数版本供单测

- [ ] **Step 1: 写 `src/cesium/cesiumCore.ts`（czm 注入前缀）**

纹理尺寸值逐字取自源仓库 `atmosphere/constants.ts`。

```ts
import { ATMOSPHERE_DEFAULT_GLSL } from '../math/atmosphereParameters'

// 所有大气 shader 的公共前缀：纹理尺寸 #define + METER_TO_LENGTH_UNIT +
// COMBINED_SCATTERING_TEXTURES（默认合并编码）+ const ATMOSPHERE。
// 这些值逐字取自 three-geospatial atmosphere/constants.ts 与
// AtmosphereMaterialBase.defines。
export function buildAtmospherePrefix(): string {
  return [
    '#define PI 3.14159265358979323846',
    '#define TRANSMITTANCE_TEXTURE_WIDTH 256',
    '#define TRANSMITTANCE_TEXTURE_HEIGHT 64',
    '#define SCATTERING_TEXTURE_R_SIZE 32',
    '#define SCATTERING_TEXTURE_MU_SIZE 128',
    '#define SCATTERING_TEXTURE_MU_S_SIZE 32',
    '#define SCATTERING_TEXTURE_NU_SIZE 8',
    '#define IRRADIANCE_TEXTURE_WIDTH 64',
    '#define IRRADIANCE_TEXTURE_HEIGHT 16',
    '#define METER_TO_LENGTH_UNIT 0.0010000',
    '#define COMBINED_SCATTERING_TEXTURES',
    ATMOSPHERE_DEFAULT_GLSL
  ].join('\n')
}
```

- [ ] **Step 2: 写 `src/cesium/depthReconstruction.ts`（GLSL 片段 + CPU 纯函数）**

```ts
// GLSL 片段：从 depthTexture 重建 ECEF 世界坐标。
// 用 czm_inverseProjection 反投影 NDC → eye，czm_inverseView → world(ECEF)。
// 多视锥深度语义（czm_currentFrustum 分段）在 G2 验证时钉死；
// MVP 先 logarithmicDepthBuffer=false 单视锥。
export const DEPTH_RECONSTRUCTION_GLSL = `
vec3 reconstructWorldPositionECEF(sampler2D depthTexture, vec2 uv) {
  float depth = texture(depthTexture, uv).r;
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 eyeCoord = czm_inverseProjection * vec4(ndc, depth * 2.0 - 1.0, 1.0);
  eyeCoord /= eyeCoord.w;
  vec4 worldCoord = czm_inverseView * eyeCoord;
  return worldCoord.xyz;
}

float linearDepth01(sampler2D depthTexture, vec2 uv) {
  float depth = texture(depthTexture, uv).r;
  float near = czm_currentFrustum.x;
  float far = czm_currentFrustum.y;
  float ndc = depth * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - ndc * (far - near)) / far;
}
`

// CPU 纯函数版本（供单测验证反投影数学正确）
export function reconstructNDCFromWindow(
  uv: [number, number],
  depth: number
): [number, number, number] {
  return [uv[0] * 2 - 1, uv[1] * 2 - 1, depth * 2 - 1]
}

export function linearDepth01CPU(
  depth: number,
  near: number,
  far: number
): number {
  const ndc = depth * 2 - 1
  const linear = (2 * near * far) / (far + near - ndc * (far - near))
  return linear / far
}
```

- [ ] **Step 3: 写 `src/cesium/depthReconstruction.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { linearDepth01CPU, reconstructNDCFromWindow } from './depthReconstruction'

describe('depthReconstruction', () => {
  it('depth=1（far）→ 线性深度接近 1', () => {
    expect(linearDepth01CPU(1.0, 1, 10000)).toBeCloseTo(1.0, 3)
  })
  it('depth=0（near）→ 线性深度接近 0', () => {
    expect(linearDepth01CPU(0.0, 1, 10000)).toBeCloseTo(0.0, 3)
  })
  it('NDC 反推：uv=0.5 → ndc=0', () => {
    const [x, y, z] = reconstructNDCFromWindow([0.5, 0.5], 0.5)
    expect(x).toBe(0)
    expect(y).toBe(0)
    expect(z).toBe(0)
  })
})
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: depthReconstruction (3) + 之前全通过。

- [ ] **Step 5: 导出新模块到 `src/index.ts`**

在 `src/index.ts` 追加：
```ts
export { buildAtmospherePrefix } from './cesium/cesiumCore'
export { DEPTH_RECONSTRUCTION_GLSL } from './cesium/depthReconstruction'
```

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(core): add czm injection prefix and depth reconstruction"
```

---

## Task 4: LUT 加载器（.bin half-float 解析 + Cesium 纹理创建）

**Files:**
- Create: `src/cesium/lutLoader.ts`, `src/cesium/cesiumTextures.ts`, `src/cesium/lutLoader.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: 源仓库 `packages/atmosphere/assets/*.bin`（half-float binary）；`@petamoriken/float16`
- Produces:
  - `parseHalfFloatBin(buffer: ArrayBuffer, expected: number): Float32Array`
  - `createLUT2D(context: Context, data: Float32Array, width, height): Texture`
  - `createLUT3D(context: Context, data: Float32Array, width, height, depth): WebGLTexture`（裸 `gl.texImage3D`，因 Cesium 无 3D 纹理创建 API）
  - `loadAtmosphereLUTs(context, baseUrl): Promise<AtmosphereLUTs>`

- [ ] **Step 1: 写 `src/cesium/cesiumTextures.ts`**

```ts
import { Texture, PixelFormat, PixelDatatype, Sampler, type Context } from 'cesium'

// 2D LUT（transmittance 256x64, irradiance 64x16）—— RGBA half-float → Float32
export function createLUT2D(
  context: Context,
  data: Float32Array,
  width: number,
  height: number
): Texture {
  return new Texture({
    context,
    source: { width, height, arrayBufferView: data as unknown as Uint8Array },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.FLOAT,
    sampler: new Sampler({ wrapS: 0, wrapT: 0, minificationFilter: 9728, magnificationFilter: 9728 })
    // 9728=LINEAR, 0=CLAMP_TO_EDGE
  })
}

// 3D LUT（scattering 256x128x32）—— Cesium 无 3D 纹理封装，回退裸 gl.texImage3D。
// 返回裸 WebGLTexture，在 stage 的 uniformMap 里手动绑定。
export function createLUT3D(
  context: Context,
  data: Float32Array,
  width: number,
  height: number,
  depth: number
): WebGLTexture {
  const gl = context.context as WebGL2RenderingContext
  // 注意：Cesium Context 的实际 gl 句柄访问，执行时确认字段名（context._gl 或通过
  // context 的公开属性）。G1 验证点之一。
  const texture = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, texture)
  gl.texImage3D(
    gl.TEXTURE_3D, 0, gl.RGBA32F,
    width, height, depth, 0,
    gl.RGBA, gl.FLOAT, data
  )
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_3D, null)
  return texture
}
```

> 注：`context.context` 访问 WebGL2 句柄的确切路径在 Task 7 接入时确认；Cesium `Context` 暴露 `context._gl`（私有）或通过 `context.context`。这是 R7 风险的实测点。

- [ ] **Step 2: 写 `src/cesium/lutLoader.ts`**

```ts
import { Float16Array } from '@petamoriken/float16'
import { createLUT2D, createLUT3D } from './cesiumTextures'
import type { Context, Texture } from 'cesium'

export interface AtmosphereLUTs {
  transmittance: Texture
  scattering: WebGLTexture
  irradiance: Texture
}

// .bin 文件是 half-float (Uint16Array) RGBA，逐像素 4 通道。
// 文件大小 = width*height*depth * 4 * 2 字节。
// @petamoriken/float16 的 Float16Array 把 buffer 当 half 视图，Float32Array.from 转 float。
export function parseHalfFloatBin(buffer: ArrayBuffer): Float32Array {
  const f16 = new Float16Array(buffer)
  return Float32Array.from(f16)
}

const TRANSMITTANCE_W = 256, TRANSMITTANCE_H = 64
const SCATTERING_W = 256, SCATTERING_H = 128, SCATTERING_D = 32
const IRRADIANCE_W = 64, IRRADIANCE_H = 16

export async function loadAtmosphereLUTs(
  context: Context,
  baseUrl: string
): Promise<AtmosphereLUTs> {
  const [tBuf, sBuf, iBuf] = await Promise.all([
    fetch(`${baseUrl}/transmittance.bin`).then(r => r.arrayBuffer()),
    fetch(`${baseUrl}/scattering.bin`).then(r => r.arrayBuffer()),
    fetch(`${baseUrl}/irradiance.bin`).then(r => r.arrayBuffer())
  ])
  return {
    transmittance: createLUT2D(context, parseHalfFloatBin(tBuf), TRANSMITTANCE_W, TRANSMITTANCE_H),
    scattering: createLUT3D(context, parseHalfFloatBin(sBuf), SCATTERING_W, SCATTERING_H, SCATTERING_D),
    irradiance: createLUT2D(context, parseHalfFloatBin(iBuf), IRRADIANCE_W, IRRADIANCE_H)
  }
}
```

- [ ] **Step 3: 先把源仓库 assets 拷进 demo 静态目录（供 fetch）**

```bash
SRC=/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial/packages/atmosphere/assets
mkdir -p apps/demo/public/luts
cp $SRC/{transmittance,scattering,irradiance}.bin apps/demo/public/luts/
```

- [ ] **Step 4: 写 `src/cesium/lutLoader.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { parseHalfFloatBin } from './lutLoader'

describe('parseHalfFloatBin', () => {
  it('half=0x3C00 (1.0) → 1.0', () => {
    const buf = new Uint16Array([0x3c00]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(1.0, 3)
  })
  it('half=0xBC00 (-1.0) → -1.0', () => {
    const buf = new Uint16Array([0xbc00]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(-1.0, 3)
  })
  it('half=0x4000 (2.0) → 2.0', () => {
    const buf = new Uint16Array([0x4000]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(2.0, 3)
  })
  it('half=0x0000 → 0.0', () => {
    const buf = new Uint16Array([0x0000]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBe(0)
  })
})
```

- [ ] **Step 5: 运行测试，修正 parseHalfFloatBin 用 `@petamoriken/float16`**

Run: `pnpm --filter @cesium-geospatial/core test`
Expected: 4 个 parseHalfFloatBin 测试通过（`@petamoriken/float16` 的 `Float16Array` 解析 0x3C00→1.0、0xBC00→-1.0、0x4000→2.0、0x0000→0）。

- [ ] **Step 6: 导出 + 提交**

在 `src/index.ts` 追加：
```ts
export { loadAtmosphereLUTs, parseHalfFloatBin } from './cesium/lutLoader'
export type { AtmosphereLUTs } from './cesium/lutLoader'
```

```bash
git add -A
git commit -m "feat(core): add LUT loader (half-float bin parse + 2D/3D texture creation)"
```

---

## Task 5: 天空 PostProcessStage（G1 GLSL 编译 + G3 ECEF 桥接）

**Files:**
- Create: `apps/demo/src/skyStage.frag.ts`, `apps/demo/src/SkyStage.ts`

**Interfaces:**
- Consumes: Task 2 `glslIndex`/`resolveIncludes`/`buildAtmospherePrefix`/`getAltitudeCorrectionOffset`/`ATMOSPHERE_BOTTOM_RADIUS_M`/`SUN_ANGULAR_RADIUS`；Task 4 `loadAtmosphereLUTs`
- Produces: `createSkyStage(scene: Scene, luts: AtmosphereLUTs): PostProcessStage`

**G1 关键验证点**：sampler3D（scattering）能否在 PostProcessStage 的 uniformMap 绑定。若失败 → 切换天空为 FullscreenPass(DrawCommand)，手动绑定 3D texture。

- [ ] **Step 1: 写 `skyStage.frag.ts`（组装天空 fragment shader）**

把源仓库 `sky.vert` 的射线重建（inverseProj/inverseView）+ `sky.frag` 的采样，合并进单个 PostProcessStage fragment，用 `czm_*` 替代 three uniform。

```ts
import { glslIndex, resolveIncludes, buildAtmospherePrefix } from '@cesium-geospatial/core'

// 源仓库 sky.frag 主体（已 #include 组装）。我们把 uniform AtmosphereParameters ATMOSPHERE
// 去掉（由 buildAtmospherePrefix 的 const 提供），保留 LUT sampler 与 sun/moon uniform。
const skyFragBody = `
precision highp float;
precision highp sampler3D;

#define RECIPROCAL_PI 0.3183098861837907
#include "core/raySphereIntersection"
#include "bruneton/definitions"

uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;

#include "bruneton/common"
#include "bruneton/runtime"

uniform vec3 sunDirection;
uniform float cosSunAngularRadius;

// 替换源仓库 sky.glsl 的 getSkyRadiance（去掉 moon/ground 分支以最小化 G1 验证面）
vec3 getSkyRadianceSimple(const vec3 cameraPosition, const vec3 rayDirection,
    const vec3 sunDirection) {
  vec3 transmittance;
  return GetSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, transmittance);
}

in vec2 v_textureCoordinates;
void main() {
  // —— 替代 sky.vert：从 v_textureCoordinates + czm 反投影重建相机射线 ——
  vec2 ndc = v_textureCoordinates * 2.0 - 1.0;
  vec4 viewCoord = czm_inverseProjection * vec4(ndc, -1.0, 1.0);
  vec3 viewRay = normalize(viewCoord.xyz);
  vec3 rayDirection = normalize((czm_inverseView * vec4(viewRay, 0.0)).xyz);

  // —— ECEF 桥接：Cesium world 即 ECEF，czm_viewerPositionWC 直接给相机 ECEF 米 ——
  vec3 cameraECEF = czm_viewerPositionWC;
  vec3 vCameraPosition = (cameraECEF + altitudeCorrection) * METER_TO_LENGTH_UNIT;

  vec3 radiance = getSkyRadianceSimple(vCameraPosition, rayDirection, sunDirection);

  // 简单 tone map（G1/G3 先不管精确 HDR，仅验证非黑）
  radiance = 1.0 - exp(-radiance * 1.0);
  out_FragColor = vec4(radiance, 1.0);
}
`

export function buildSkyFragmentShader(): string {
  // 用 resolveIncludes 展开 #include（路径键与源仓库一致）
  const assembled = resolveIncludes(skyFragBody, {
    core: { raySphereIntersection: glslIndex.core.raySphereIntersection },
    bruneton: {
      definitions: glslIndex.bruneton.definitions,
      common: glslIndex.bruneton.common,
      runtime: glslIndex.bruneton.runtime
    }
  })
  // 前缀：#define 纹理尺寸 + const ATMOSPHERE；altitudeCorrection/METER_TO_LENGTH_UNIT
  // 作为 uniform 在运行时由 SkyStage 传（METER_TO_LENGTH_UNIT 可改为 #define，见下）
  return buildAtmospherePrefix() + '\n' + assembled
}
```

> 注：`altitudeCorrection`（vec3 uniform）与 `METER_TO_LENGTH_UNIT`（已在前缀 #define）—— `altitudeCorrection` 须作为 uniform 在 SkyStage 传入。`METER_TO_LENGTH_UNIT` 已由 `buildAtmospherePrefix` 定义为 const 宏，fragment 里可直接用。

- [ ] **Step 2: 写 `SkyStage.ts`（PostProcessStage + 每帧更新 altitudeCorrection/sunDirection）**

```ts
import { PostProcessStage, Cartesian3, Simon1994PlanetaryPositions, type Scene } from 'cesium'
import {
  getAltitudeCorrectionOffset,
  ATMOSPHERE_BOTTOM_RADIUS_M,
  SUN_ANGULAR_RADIUS,
  type AtmosphereLUTs
} from '@cesium-geospatial/core'
import { buildSkyFragmentShader } from './skyStage.frag'

export function createSkyStage(scene: Scene, luts: AtmosphereLUTs): PostProcessStage {
  const altitudeCorrection = new Cartesian3()
  const sunDirection = new Cartesian3(0, 0, 1)
  const SUN_SPECTRAL = new Cartesian3(98242.786222, 69954.398112, 66475.012354)
  const SKY_SPECTRAL = new Cartesian3(114974.916437, 71305.954816, 65310.548555)

  const stage = new PostProcessStage({
    fragmentShader: buildSkyFragmentShader(),
    uniforms: {
      sunDirection: () => sunDirection,
      cosSunAngularRadius: Math.cos(SUN_ANGULAR_RADIUS),
      altitudeCorrection: () => altitudeCorrection,
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: SUN_SPECTRAL,
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: SKY_SPECTRAL,
      transmittance_texture: () => luts.transmittance,
      irradiance_texture: () => luts.irradiance
      // scattering_texture（sampler3D）：见 Step 3 关键验证
    }
  })

  // 每帧更新 altitudeCorrection（密切球再中心化）+ sunDirection
  scene.preRender.addEventListener(() => {
    const cameraECEF = scene.camera.positionWC
    getAltitudeCorrectionOffset(cameraECEF, ATMOSPHERE_BOTTOM_RADIUS_M, scene.globe.ellipsoid, altitudeCorrection)
    // 太阳方向：Simon1994PlanetaryPositions 给太阳 ECEF 位置（地心系），
    // 太阳极远，单位化即得“指向太阳”方向，与源仓库 sunDirection 语义一致。
    const sun = Simon1994PlanetaryPositions.computeSunPosition(scene.time, new Cartesian3())
    Cartesian3.normalize(sun, sunDirection)
  })

  return stage
}
```

- [ ] **Step 3: sampler3D 绑定的关键验证（G1 障碍点）**

尝试给 PostProcessStage 的 uniforms 加 `scattering_texture: () => luts.scattering`（裸 WebGLTexture）。
- 若 Cesium 报错"unsupported uniform type"或类似 → PostProcessStage uniformMap 不支持 sampler3D，**记录此结论**，切换方案：天空改用自定义 DrawCommand（FullscreenPass），在 `uniformMap` 里返回 `{ scattering_texture: () => luts.scattering }` 配合 Cesium 的 texture 绑定机制（或裸 `gl.uniform1i` 在 `DrawCommand` 的自定义渲染里）。
- 这一步的结论写入 go/no-go 文档（Task 7 Step 4）。

> 多数 Cesium 版本下，PostProcessStage 的 uniform 系统通过 `PostProcessStageLibrary` 的 texture uniform 支持 sampler2D；sampler3D 支持不保证。本步即验证。

- [ ] **Step 4: 在 demo 里临时挂载 stage，跑起来看是否编译（视觉结果在 Task 7）**

在 `apps/demo/src/main.ts` 临时加：
```ts
const luts = await loadAtmosphereLUTs(scene.context, '/luts')
const sky = createSkyStage(scene, luts)
scene.postProcessStages.add(sky)
```
Run: `pnpm --filter demo dev`，浏览器打开。
Expected（G1）：浏览器 console **无 shader 编译错误**（Cesium 会打印 GLSL 编译日志）；即使颜色不对，只要全屏不是黑/崩溃即 G1 过。把 console 输出截图记录。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(demo): sky PostProcessStage with bruneton GLSL + ECEF bridge (G1/G3)"
```

---

## Task 6: 深度重建可视化 Stage（G2）

**Files:**
- Create: `apps/demo/src/depthDebugStage.frag.ts`, `apps/demo/src/DepthDebugStage.ts`

**Interfaces:**
- Consumes: Task 3 `DEPTH_RECONSTRUCTION_GLSL`
- Produces: `createDepthDebugStage(scene: Scene): PostProcessStage`

- [ ] **Step 1: 写 `depthDebugStage.frag.ts`**

```ts
import { DEPTH_RECONSTRUCTION_GLSL } from '@cesium-geospatial/core'

export function buildDepthDebugFragmentShader(): string {
  return `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
${DEPTH_RECONSTRUCTION_GLSL}
void main() {
  // 重建 ECEF 世界坐标，分量归一化可视化
  vec3 worldPos = reconstructWorldPositionECEF(depthTexture, v_textureCoordinates);
  vec3 vis = fract(worldPos / 1000000.0); // 每 1000km 一个色环
  float linDepth = linearDepth01(depthTexture, v_textureCoordinates);
  // 天空（无几何）depth=1 → 显示线性深度条带；地物应显示彩虹分量
  out_FragColor = vec4(mix(vis, vec3(linDepth), step(0.999, texture(depthTexture, v_textureCoordinates).r)), 1.0);
}
`
}
```

- [ ] **Step 2: 写 `DepthDebugStage.ts`**

```ts
import { PostProcessStage, type Scene } from 'cesium'
import { buildDepthDebugFragmentShader } from './depthDebugStage.frag'

export function createDepthDebugStage(scene: Scene): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildDepthDebugFragmentShader()
    // depthTexture 由 Cesium 自动提供（shader 里声明了即自动绑定）
  })
}
```

- [ ] **Step 3: demo 里加开关切换天空/深度 stage**

在 `main.ts` 加 URL 参数 `?mode=depth` 切到深度 stage，默认天空。
Run: `pnpm --filter demo dev`，开 `?mode=depth`。
Expected（G2）：地物（globe/3D Tiles）显示彩虹分量（世界坐标变化连续），多视锥边界处无明显条带；移动相机时分量平滑变化。把截图记录。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(demo): depth reconstruction debug stage (G2)"
```

---

## Task 7: demo 组装 + go/no-go 评估文档

**Files:**
- Create: `apps/demo/index.html`, `apps/demo/vite.config.ts`, `apps/demo/src/main.ts`
- Create: `docs/superpowers/plans/2026-07-29-phase0-results.md`（go/no-go 结论）

**Interfaces:**
- Consumes: Task 1-6 全部产物
- Produces: 可运行 demo + go/no-go 评估

- [ ] **Step 1: 写 `apps/demo/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import cesium from 'vite-plugin-cesium'

export default defineConfig({
  plugins: [
    cesium(),  // 处理 Cesium Workers/Assets 静态资源
    viteStaticCopy([{ src: 'public/luts/*', dest: 'luts' }])
  ],
  optimizeDeps: { exclude: ['cesium'] }
})
```

> 注：`vite-plugin-cesium` 与 `vite-plugin-static-copy` 二选一可能冗余；若 `vite-plugin-cesium` 已 copy `public/`，则去掉 staticCopy。执行时按实际插件行为调整。

- [ ] **Step 2: 写 `apps/demo/index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Cesium Geospatial · Phase 0 Spike</title>
    <style>html,body,#cesium{margin:0;width:100%;height:100%;}</style>
  </head>
  <body>
    <div id="cesium"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: 写 `apps/demo/src/main.ts`**

```ts
import { Viewer, SceneMode } from 'cesium'
import { loadAtmosphereLUTs } from '@cesium-geospatial/core'
import { createSkyStage } from './SkyStage'
import { createDepthDebugStage } from './DepthDebugStage'

async function main() {
  const viewer = new Viewer('cesium', {
    baseLayer: false, // Phase 0 无需底图（globe 地形即可验证天空/深度，且免 ion token）
    baseLayerPicker: false,
    geocoder: false,
    sceneMode: SceneMode.SCENE3D
  })
  viewer.scene.logarithmicDepthBuffer = false // MVP 回避对数深度
  viewer.scene.skyBox.show = false
  viewer.scene.skyAtmosphere.show = false
  viewer.scene.sun.show = false
  viewer.scene.moon.show = false

  const mode = new URLSearchParams(location.search).get('mode') ?? 'sky'
  if (mode === 'sky') {
    const luts = await loadAtmosphereLUTs(viewer.scene.context as any, '/luts')
    viewer.scene.postProcessStages.add(createSkyStage(viewer.scene, luts))
  } else {
    viewer.scene.postProcessStages.add(createDepthDebugStage(viewer.scene))
  }
}
main()
```

- [ ] **Step 4: 跑 demo，按 G1/G2/G3 判据评估，写 `phase0-results.md`**

Run: `pnpm dev`，分别测 `?mode=sky` 与 `?mode=depth`，覆盖三个场景：贴地中低空、太空俯视、日出/日落方向。

写 `docs/superpowers/plans/2026-07-29-phase0-results.md`，包含：
- **G1（GLSL 编译）**：console 是否无编译错误；sampler3D 在 PostProcessStage 是否可绑（Task 5 Step 3 结论）。
- **G2（深度重建）**：深度可视化是否正确（地物彩虹连续、多视锥接缝情况）。
- **G3（ECEF/密切球）**：天空 `?mode=sky` 是否非黑、相机移动无抖动/错位；与 three 版 Sky-Basic 同机位截图比对（若可获取）。
- **go/no-go 结论**：三项全过 → 进 Phase 1；任一失败 → 记录失败模式 + 备选（FullscreenPack/双渲染器重新评估）。
- 三个场景的截图说明。

- [ ] **Step 5: 锁定 Cesium 版本**

把 Task 1 中 `^1.125.0` 改为 demo 实际安装并验证通过的精确版本，记入 `phase0-results.md`。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(demo): assemble phase0 spike + go/no-go results"
```

---

## 依赖与顺序

```
T1 (骨架) → T2 (core 无关层) → T3 (适配层) → T4 (LUT)
                                      ↓
                          T5 (天空, 依赖 T2/T4) ─┐
                          T6 (深度, 依赖 T3)    ├→ T7 (组装+评估)
```

T5 与 T6 可并行。T7 依赖全部。

## 验证清单（对应设计文档 G1/G2/G3）

- G1：Task 5 Step 4（console 无编译错误 + sampler3D 绑定结论）
- G2：Task 6 Step 3（深度可视化连续、多视锥接缝）
- G3：Task 5 Step 4 + Task 7 Step 4（天空非黑、相机移动无抖动、同机位比对）
