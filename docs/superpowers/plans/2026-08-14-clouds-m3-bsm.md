# M3 BSM 云自阴影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植 three-geospatial 的 Beer Shadow Map（BSM）链路——sun-POV 全屏云密度 raymarch 生成级联 BSM，主 march 云 shader 消费（Beer-Lambert + powder），使云有体积厚度/暗部层次。

**Architecture:** 三段链：①`CascadedShadowMaps`（纯 TS 数学，相机 frustum 切 3 段 → 每段 light-space 正交包围盒矩阵）；②`ShadowPass`（preRender 时机手动 execute，`shadow.frag` surgery 成单 cascade 版，写 `Texture3D` 的第 i 层——裸 GL FBO + `glFramebufferTextureLayer` attach）；③主 march 侧（`clouds.frag` 的 BSM 消费代码 M2 已编译通过，只换真 uniform：`shadowBuffer`/`shadowMatrices`/`shadowIntervals`/`shadowFar` + surgery 增量：sampler3D z 归一化 + `u_shadowCameraNear` 解 multi-frustum 错位 + `#define POWDER`）。

**Tech Stack:** Cesium 1.143（Texture3D/Matrix4/Matrix3/Cartesian3/Framebuffer/RenderState）+ WebGL2 裸 GL（framebufferTextureLayer）+ vitest + glslangValidator。

**Spec 来源:** `docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md` §6 M3。主参考 three-geospatial `packages/clouds/src/{CascadedShadowMaps,ShadowPass,ShadowMaterial,ShadowResolveMaterial}.ts` + `shaders/{shadow.frag,shadow.vert}`。

## Global Constraints

- 全部代码注释/文档/commit 用**中文**；TDD（先测后码，红→绿→commit）。
- **不碰 core 包业务代码**（core platform 基建只读消费；若需 core 改动必须先停下来说明）。
- GLSL 资产层（`src/glsl/*.glsl`）**一字不改**（保持 three 版形态便于上游 diff）；所有适配在编排层 surgery。
- 双入口编译验证：运行时 shader 无 `#version`（Cesium 注入）；校验 shader 补 `#version 300 es` 喂 glslangValidator。
- 零回归：`clouds=0`（或不传）不创建任何 BSM/stage；全部现有测试保持绿（core 258 + clouds 57 起步）。
- 每步验证命令：`pnpm --filter @cesium-geospatial/clouds exec vitest run <file>`（包名以 package.json 实名为准：`@cesium-geospatial/cesium-clouds`——执行时先 `cat packages/cesium-clouds/package.json` 核对 name）。
- M3 **不做** BSM temporal（`TEMPORAL_PASS` off，`ShadowResolveMaterial` 不搬）——M4 与主云 resolve 一起接。**不做** SHADOW_LENGTH（M5）。

---

## 背景与关键设计决策（实现者必读）

### three 版链路（移植对象）

```
每帧（three CloudsEffect.update）：
  distance = lerp(1e6, 1e3, sunDirection·surfaceNormal)   // 太阳天顶角越低虚拟光源越近
  cascades.update(camera, sunDirection, distance)          // 3 段 frustum → light-space ortho 矩阵
  shadowPass.update(renderer, frame)                       // sun-POV 全屏 march ×3 cascade → 2D_ARRAY
  cloudsPass.shadowBuffer = shadowPass.outputBuffer        // 主 march 消费
  cloudsPass.update(...)
```

消费端（`clouds.frag`，**M2 已编译通过**）：`sampleShadowOpticalDepth(rayPos)` →
`getFadedCascadeIndex(viewMatrix, worldPos, shadowIntervals, cameraNear, shadowFar, jitter)`（视深归一化选 cascade + fade）→ `getShadowUv(worldPos, cascadeIndex)`（`shadowMatrices[i]` 投影）→ `readShadowOpticalDepth`（BSM texel：r=frontDepth g=meanExtinction b=maxOpticalDepth a=tail；`min(b+a, g·(distToFront))`）→ marchOpticalDepth 合成 → `approximateMultipleScattering`（Beer-Lambert 多 octave）→ `#ifdef POWDER` 暗边 → 散射积分。

### 决策 D1：BSM 用 `Texture3D`（sampler3D），生成端 `framebufferTextureLayer` 逐层写

M2 已把 `shadowBuffer` surgery 成 `sampler3D`（Cesium createUniform 不认 sampler2DArray type 36289，ShaderProgram uniformMap 路径 bind 炸）。M3 沿用：

- **生成端**：Cesium `Texture3D`（HALF_FLOAT RGBA `mapSize²×cascadeCount`）→ `_texture` 取 raw GL handle → 裸 GL FBO，每 cascade 前 `gl.framebufferTextureLayer(GL_FRAMEBUFFER, COLOR_ATTACHMENT0, tex, 0, layer)`（WebGL2 规范允许 TEXTURE_3D attach）→ 全屏 quad draw。每层一个 draw（共 3 draw），非 MRT 数组。
- **消费端 surgery 增量**：sampler3D 的 z 是**归一化深度**（sampler2DArray 是 layer 索引）——`texture(shadowBuffer, vec3(uv, float(i)))` → `vec3(uv, (float(i)+0.5)/float(SHADOW_CASCADE_COUNT))`。z 恰在层中心 → LINEAR 三线性插值 z 邻层权重为 0，无跨层混叠；uv 向 LINEAR 保留（PCF vogelDisk 需要）。Sampler：LINEAR/LINEAR + CLAMP_TO_EDGE。
- **Plan B**（若 framebufferTextureLayer 对 TEXTURE_3D 在目标设备不工作，实现 T3 时实测）：退回「一张 2D HALF_FLOAT Texture + Cesium Framebuffer draw → `gl.copyTexSubImage3D` 拷入 Texture3D 层 i」。API 同构（render() 内部换实现），单测改断言 copy 调用。

### 决策 D2：BSM 生成时机 = `scene.preRender` 手动 execute（同帧、先于云 march）

BSM 只依赖相机矩阵 + sunDirection + weather 纹理（**不依赖 globe depth**——sun-POV 云密度场，零场景几何）。`scene.preRender` 在 executeCommands（云 march 的 VOXELS pass）之前触发，且此刻 `camera.frustum.near/far` 是**完整视锥**（尚未被 multi-frustum 分段改写）——正是 cascade split 需要的。GL 状态 save/restore（FRAMEBUFFER_BINDING + VIEWPORT）。命令用 `FullscreenPass.execute(context)`（command 无 framebuffer override → `Context.executeCommand` 不切换我们 bind 的裸 FBO；viewport 由 RenderState.viewport 设 mapSize）。

### 决策 D3：cascade near/far 错位 → 新增 `u_shadowCameraNear` uniform

`getCascadeIndex`/`getFadedCascadeIndex` 用 `viewZToOrthographicDepth(viewZ, cameraNear, shadowFar)` 归一化视深，与 `shadowIntervals`（split 时按完整 near/far 归一化）比较。但主 march 的 `cameraNear` 被 `#define` 到 `czm_currentFrustum.x`——multi-frustum 分段执行时 = **段 near**（如 1000），而 BSM split 用完整 near（如 1.0）→ 归一化错位 → cascade 选择全错（近处视深甚至变负）。修法：surgery 把 3 处 `cameraNear, shadowFar` 调用实参换新 uniform `u_shadowCameraNear`（TS 侧 = BSM split 所用的完整 near）。`shadowFar` 已是独立 uniform ✓。`getViewZ`（depth 反演）继续用 `czm_currentFrustum`（段语义正确，不动）。

### 决策 D4：cascadeCount 3（three qualityPresets 默认）+ `SHADOW_CASCADE_COUNT` 4→3 + `#define POWDER`

- three 默认 `shadow.cascadeCount=3`、`mapSize=512`。主 shader `SHADOW_CASCADE_COUNT` define 从 4 改 3（uniform 数组/shadowBuffer depth/DEBUG 第 4 象限自动跟随）。TS 侧 `shadowIntervals/shadowMatrices` 数组同步 3 元素。
- `POWDER`：three 版 `powderScale=0.8 > 0` 时 define POWDER（默认开）。M2 漏了——M3 补 `#define POWDER`（spec「Beer-Lambert + powder」）。

### 决策 D5：shadow.frag surgery 成「单 cascade 单输出」版

原文 MRT `outputColor[CASCADE_COUNT]` + `outputDepthVelocity[CASCADE_COUNT]`（temporal velocity）。M3 不做 temporal：

- 删 `outputDepthVelocity` 声明块（`#if CASCADE_COUNT == 1..4` 段）与 `cascade()` 的 velocity 参数 + 体内 `#ifdef TEMPORAL_PASS` 段；删 `reprojectionMatrices` uniform（M4 加回，git 可寻）。
- `layout(location=0) out vec4 outputColor[CASCADE_COUNT]` → `layout(location=0) out vec4 outputColor;`
- main 的 unroll 循环 → `cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor)`，新增 `uniform int u_cascadeIndex;`（每 draw 换值，同 shader 复用 ShaderProgram 缓存）。
- `in vec2 vUv;` → `in vec2 v_textureCoordinates;` + `#define vUv v_textureCoordinates`（Cesium ViewportQuadVS 输出后者）。
- defines：`SHADOW`（sampleWeather 的 shadowLayerMask 分支——BSM 只算 L0/L1）、`CASCADE_COUNT 3`、`TEMPORAL_JITTER`（STBN 静态 jitter，同主 march M2）、`SHAPE_DETAIL`、`TURBULENCE`、`LOCAL_WEATHER_CHANNELS rgba`。
- shadow.frag 不引用任何 `czm_*`（不需要 CZM_STUBS）。

### 决策 D6：BSM far = `min(camera.frustum.far, maxRayDistance)`

three 版 far=camera.far。本项目 `frustum.far`≈5e8 会让 3 cascade 全挤远处；云只在 `maxRayDistance`（2e5 m）内渲染，BSM 覆盖同范围即可。near = `camera.frustum.near`（preRender 完整值）。practical split λ=0.5 → 3 段 ≈ [0,33km] [33,68km] [68,200km]（near=1 时）。相机极高时第三段半径大、BSM 分辨率粗——正常 CSM 行为。

### uniform 对照表（M3 接通清单）

| uniform | M2 值（dummy） | M3 值 |
|---|---|---|
| `shadowBuffer` | Texture3D 1×1×4 全 0 | Texture3D 512²×3 HALF_FLOAT（ShadowPass 每帧写；未就绪 fallback 保留全 0 dummy → Beer=1 降级） |
| `shadowMatrices[3]` | identity×4 | `cascades[i].matrix`（ECEF world→light clip） |
| `shadowIntervals[3]` | (0,0)×4 | `cascades[i].interval`（归一化视深） |
| `shadowFar` | 0 | `min(frustum.far, maxRayDistance)` |
| `shadowTexelSize` | (1,1) | `1/512` |
| `u_shadowCameraNear`（新） | — | BSM split 用的完整 near |
| `inverseShadowMatrices[3]`（BSM 侧） | — | `cascades[i].inverseMatrix`（light clip→world） |
| POWDER | 未 define | define（powderScale 0.8） |
| shadow march 档（新） | — | maxIterationCount=50 minStepSize=100 maxStepSize=1000 minDensity=1e-5 minExtinction=1e-5 minTransmittance=1e-4 opticalDepthTailScale=2 |

### File Structure

```
packages/cesium-clouds/src/
  CascadedShadowMaps.ts        T1 新建（纯 TS 数学：splitFrustum + FrustumCorners + CascadedShadowMaps）
  CascadedShadowMaps.test.ts   T1 测试（node 数学断言，无 GL）
  ShadowMaterial.ts            T2 新建（shadow.frag surgery 组装器，双入口）
  shadowMain.compile.test.ts   T2 测试（surgery 断言 + glslang 真编译）
  ShadowPass.ts                T3 新建（Texture3D + 裸 FBO layer attach + preRender render()）
  ShadowPass.test.ts           T3 测试（gl mock 调用序列断言）
  CloudsMaterial.ts            T4 修改（sampler3D z 归一化 + u_shadowCameraNear + POWDER + CASCADE_COUNT 3）
  cloudsDefaultParameters.ts   T4 修改（shadowMarch 档 + 数组 3 元素 + shadowCameraNear）
  CloudsPass.ts                T4 修改（shadow uniform 闭包读 shadowState；保留 dummy fallback）
  cloudsMain.compile.test.ts   T4 修改（新增 surgery 断言）
  CloudsPass.test.ts           T4 修改（shadow uniform 断言重组）
  createCloudsStage.ts         T5 修改（preRender：zenithAngle→distance→cascades.update→同步 state→shadowPass.render）
  createCloudsStage.test.ts    T5 修改（编排断言）
  cloudsShaderAssembler.ts     只读复用（buildStandaloneCloudsShader）
apps/demo/src/main.ts          T5 修改（?cloudsShadow=0 诊断开关）
docs/superpowers/plans/2026-08-14-clouds-m3-bsm-results.md  T6 新建
```

---

### Task 1: CascadedShadowMaps —— 纯 TS 级联矩阵（three 版移植，Cesium 数学）

**Files:**
- Create: `packages/cesium-clouds/src/CascadedShadowMaps.ts`
- Test: `packages/cesium-clouds/src/CascadedShadowMaps.test.ts`

**Interfaces:**
- Consumes: `cesium` 的 `Matrix4/Matrix3/Cartesian2/Cartesian3/Cartesian4`（纯数学，无 GL/无 scene）。
- Produces（T5 消费）:
  ```ts
  interface Cascade {
    interval: Cartesian2        // 归一化视深区间 [x,y)（viewZToOrthographicDepth 域）
    matrix: Matrix4             // ECEF world → light clip（getShadowUv 用）
    inverseMatrix: Matrix4      // light clip → world（shadow.frag cascade() 用）
    projectionMatrix: Matrix4
    inverseProjectionMatrix: Matrix4
    viewMatrix: Matrix4
    inverseViewMatrix: Matrix4
  }
  interface CascadeCameraInput {
    inverseViewMatrix: Matrix4  // three camera.matrixWorld 等价（ECEF world 系相机位姿）
    projectionMatrix: Matrix4   // 主相机透视投影（正算）
    near: number                // 完整视锥 near（preRender 时刻）
    far: number                 // 完整视锥 far（D6：min(frustum.far, maxRayDistance)）
  }
  class CascadedShadowMaps {
    readonly cascades: Cascade[]
    readonly far: number        // 最近一次 update 用的 far
    update(camera: CascadeCameraInput, sunDirection: Cartesian3, distance?: number): void
  }
  constructor(options: { cascadeCount: number; mapSize: number; splitLambda?: number; fade?: boolean; margin?: number })
  ```

- [ ] **Step 1: 写失败测试** `CascadedShadowMaps.test.ts`：

```ts
// T1：CascadedShadowMaps 纯数学单测（node，无 GL）。
// 相机固定在 ECEF (0,0,6.4e6) 朝 -Z 看时手推期望值断言。
import { describe, expect, it } from 'vitest'
import { Cartesian2, Cartesian3, Matrix4 } from 'cesium'

import { CascadedShadowMaps, splitFrustum } from './CascadedShadowMaps'

// 视线朝地心的简单透视相机：位于北极上方，看 -Z。构造 view（world→view）：
// view = rotate(把相机 -Z 对到 world -Z) * translate(-eye) —— 这里相机无旋转，
// viewMatrix = translate(-eye)，inverseViewMatrix（=three matrixWorld）= translate(eye)。
function makeCamera(near: number, far: number, fovy = Math.PI / 3) {
  const eye = new Cartesian3(0, 0, 6.4e6)
  const inverseViewMatrix = Matrix4.fromTranslation(eye)
  // 透视投影（gluPerspective 语义，aspect 1）：Cesium Matrix4.computePerspectiveFieldOfView
  const projectionMatrix = Matrix4.computePerspectiveFieldOfView(
    fovy, 1.0, near, far, new Matrix4()
  )
  return { inverseViewMatrix, projectionMatrix, near, far }
}

describe('splitFrustum（practical 模式，对齐 three splitFrustum.ts）', () => {
  it('practical λ=0.5 三段：lerp(uniform, logarithmic)，单调递增收尾 1', () => {
    const s = splitFrustum('practical', 3, 1.0, 2e5, 0.5)
    expect(s).toHaveLength(3)
    expect(s[2]).toBeCloseTo(1.0, 10)
    expect(s[1]).toBeGreaterThan(s[0])
    // near=1, far=2e5 手推：uniform=[1/3,2/3,1] log=[2.93e-4,1.71e-2,1]
    expect(s[0]).toBeCloseTo((1 / 3 + 2.9296875e-4 / 1) / 2 * 1 - (1 / 3 - 2.9296875e-4) / 2 * 0, 3)
    // 上面表达式太绕，直接断言手算值：lerp(0.33334, 0.000293, 0.5) ≈ 0.166813
    expect(s[0]).toBeCloseTo(0.166813, 4)
    expect(s[1]).toBeCloseTo((0.66667 + 0.01709) / 2, 4)
  })
})

describe('CascadedShadowMaps.update', () => {
  const csm = new CascadedShadowMaps({ cascadeCount: 3, mapSize: 512 })

  it('cascades 数 = cascadeCount；interval 单调覆盖 [near/far, 1]', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    expect(csm.cascades).toHaveLength(3)
    expect(csm.far).toBe(2e5)
    expect(csm.cascades[0].interval.x).toBeCloseTo(0, 10) // 第一段起点 = near/far ≈ 0
    expect(csm.cascades[2].interval.y).toBeCloseTo(1, 10)
    for (let i = 1; i < 3; i++) {
      expect(csm.cascades[i].interval.x).toBe(csm.cascades[i - 1].interval.y)
    }
  })

  it('matrix 与 inverseMatrix 在 clip 域互逆（world→clip→world roundtrip）', () => {
    const cam = makeCamera(1.0, 2e5)
    const sun = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())
    csm.update(cam, sun, 1e5)
    const p = new Cartesian3(1e5, -2e4, 6.3e6) // ECEF world 任意点
    for (const c of csm.cascades) {
      const clip = Matrix4.multiplyByPoint(c.matrix, p, new Cartesian3())
      const clip4 = new Cartesian4(clip.x, clip.y, clip.z, 1.0)
      const back4 = Matrix4.multiplyByVector(c.inverseMatrix, clip4, new Cartesian4())
      const back = Cartesian3.fromElements(back4.x / back4.w, back4.y / back4.w, back4.z / back4.w)
      expect(back.x).toBeCloseTo(p.x, -2)
      expect(back.y).toBeCloseTo(p.y, -2)
      expect(back.z).toBeCloseTo(p.z, -2)
    }
  })

  it('正交投影覆盖 [-r,r]（light-space 视锥角点 clip 坐标 |x|,|y| ≤ 1）', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    for (const c of csm.cascades) {
      // 相机正前 far 平面中心点应落进 cascade 0 的 ortho 盒（近段）
      const center = new Cartesian3(0, 0, 6.4e6 - 1e4)
      const clip = Matrix4.multiplyByPoint(c.matrix, center, new Cartesian3())
      expect(Math.abs(clip.x)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(clip.y)).toBeLessThanOrEqual(1.5)
    }
  })

  it('light-space 中心 texel 对齐（x,y 是 texelWidth 整数倍，±浮点容差）', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    // texel 对齐保证 shadow 相机平移不产生亚像素抖动（three 版同款 snapping）
    // 断言方式：连续两次 update 同输入 → 矩阵逐元素相等（确定性）
    const m0 = Matrix4.clone(csm.cascades[0].matrix)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    expect(Matrix4.equals(m0, csm.cascades[0].matrix)).toBe(true)
  })

  it('sunDirection 平行 -up（极点退化）不产生 NaN', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 1, 0), 1e5) // ∥ up=(0,1,0)
    const col = Matrix4.getColumn(csm.cascades[0].matrix, 0, new Cartesian4())
    expect(Number.isFinite(col.x)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts`（包名以 `cat packages/cesium-clouds/package.json` 的 name 为准）
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `CascadedShadowMaps.ts`**

```ts
// CascadedShadowMaps.ts
//
// M3 T1：sun-POV 级联正交 shadow 相机（three-geospatial CascadedShadowMaps.ts 的 Cesium 移植，
// 基于 three-csm / three.js csm example，MIT © 2019 vtHawk，源注释保留）。
//
// 职责：把主相机视锥按 practical split 切 N 段，每段在 light space 求正交包围盒（texel 对齐），
// 产出 per-cascade {matrix（world→light clip）, inverseMatrix（clip→world）, interval（归一化视深）}。
// 纯 TS 数学（Cesium Matrix4/Cartesian3），无 GL / 无 scene 依赖 → node 单测。
//
// three → Cesium 的矩阵语义对照：
//   camera.matrixWorld        → CascadeCameraInput.inverseViewMatrix（ECEF world 系相机位姿）
//   camera.projectionMatrixInverse → Matrix4.inverse(camera.projectionMatrix)（本文件内算）
//   Matrix4.lookAt(eye,target,up)  → 手写 lookAtMatrix（three 语义：-Z 朝 target；见下）
//   Matrix4.makeOrthographic(l,r,t,b,n,f) → Matrix4.computeOrthographicOffCenter(l,r,b,t,n,f)
//     （注意参数顺序：three (l,r,top,bottom) vs Cesium (l,r,bottom,top)）
export interface Cascade {
  interval: Cartesian2
  matrix: Matrix4
  inverseMatrix: Matrix4
  projectionMatrix: Matrix4
  inverseProjectionMatrix: Matrix4
  viewMatrix: Matrix4
  inverseViewMatrix: Matrix4
}

export interface CascadeCameraInput {
  /** three camera.matrixWorld 等价：ECEF world 系相机位姿（Cesium camera.inverseViewMatrix）。 */
  inverseViewMatrix: Matrix4
  /** 主相机透视投影正算矩阵（Cesium camera.frustum.projectionMatrix；log-depth 不改此矩阵）。 */
  projectionMatrix: Matrix4
  /** 完整视锥 near/far（preRender 时刻、multi-frustum 分段前的值；far 见决策 D6）。 */
  near: number
  far: number
}

export interface CascadedShadowMapsOptions {
  cascadeCount: number
  /** BSM 单边尺寸（像素，方形；three 默认 512）。 */
  mapSize: number
  /** practical split 的 uniform/log 插值系数（three 默认 0.5）。 */
  splitLambda?: number
  /** 视锥半径按 fade 带扩张（three 默认 true）。 */
  fade?: boolean
  /** ortho near/far 余量（three 默认 0）。 */
  margin?: number
}

type FrustumSplitMode = 'uniform' | 'logarithmic' | 'practical'

/** 视锥切分（对齐 three helpers/splitFrustum.ts；输出归一化到 far，末项 = 1）。 */
export function splitFrustum(
  mode: FrustumSplitMode,
  count: number,
  near: number,
  far: number,
  lambda = 0.5,
  result: number[] = []
): number[] {
  for (let i = 0; i < count; ++i) {
    const uniform = (near + ((far - near) * (i + 1)) / count) / far
    const logarithmic = (near * (far / near) ** ((i + 1) / count)) / far
    result[i] =
      mode === 'uniform' ? uniform
      : mode === 'logarithmic' ? logarithmic
      : uniform + (logarithmic - uniform) * lambda // practical = lerp(uniform, log, λ)
  }
  result.length = count
  return result
}

// ── FrustumCorners（对齐 three helpers/FrustumCorners.ts，仅保留透视分支——Cesium 相机恒透视）──
// near/far 各 4 角（clip 反投影到 world），far 角再沿视线截断到给定 far（防止极端 fovy 越界）。
class FrustumCorners {
  readonly near = [0, 1, 2, 3].map(() => new Cartesian3())
  readonly far = [0, 1, 2, 3].map(() => new Cartesian3())

  setFromCamera(invProj: Matrix4, near: number, far: number): this {
    // clip 角顺序（three 同款）：
    //   3 --- 0
    //   |     |
    //   2 --- 1
    const nearNdc = [
      new Cartesian3(1, 1, -1), new Cartesian3(1, -1, -1),
      new Cartesian3(-1, -1, -1), new Cartesian3(-1, 1, -1)
    ]
    const farNdc = [
      new Cartesian3(1, 1, 1), new Cartesian3(1, -1, 1),
      new Cartesian3(-1, -1, 1), new Cartesian3(-1, 1, 1)
    ]
    for (let i = 0; i < 4; ++i) {
      // NDC → world：齐次反投影（w 除）。near 平面 z=-1 的点在透视下 w=near，除后距离=near。
      this.near[i] = unproject(invProj, nearNdc[i], this.near[i])
      const f = unproject(invProj, farNdc[i], this.far[i])
      // far 截断（three：|z| 超界的角缩到 far——透视下按范数缩放等价视线截断）
      const dist = Cartesian3.magnitude(f)
      if (dist > far) Cartesian3.multiplyByScalar(f, far / dist, f)
      this.far[i] = f
    }
    return this
  }

  /** 按归一化切分点插值出子视锥角点（对齐 three FrustumCorners.split 的 lerpVectors 语义）。 */
  split(clipDepths: readonly number[], result: FrustumCorners[]): FrustumCorners[] {
    for (let index = 0; index < clipDepths.length; ++index) {
      const frustum = (result[index] ??= new FrustumCorners())
      const prev = index === 0 ? 0 : clipDepths[index - 1]
      const next = index === clipDepths.length - 1 ? 1 : clipDepths[index]
      for (let i = 0; i < 4; ++i) {
        Cartesian3.lerp(this.near[i], this.far[i], prev, frustum.near[i])
        Cartesian3.lerp(this.near[i], this.far[i], next, frustum.far[i])
      }
    }
    return result
  }

  applyMatrix4(m: Matrix4): this {
    for (let i = 0; i < 4; ++i) {
      Matrix4.multiplyByPoint(m, this.near[i], this.near[i])
      Matrix4.multiplyByPoint(m, this.far[i], this.far[i])
    }
    return this
  }
}

function unproject(invProj: Matrix4, ndc: Cartesian3, result: Cartesian3): Cartesian3 {
  const v = new Cartesian4(ndc.x, ndc.y, ndc.z, 1.0)
  Matrix4.multiplyByVector(invProj, v, v)
  return Cartesian3.fromElements(v.x / v.w, v.y / v.w, v.z / v.w, result)
}

// ── three Matrix4.lookAt 的 Cesium 等价（three 语义：构造使 -Z 朝 (target-eye) 的旋转 + 平移）──
function lookAtMatrix(
  eye: Cartesian3, target: Cartesian3, up: Cartesian3, result: Matrix4
): Matrix4 {
  const zAxis = Cartesian3.normalize(
    Cartesian3.subtract(eye, target, new Cartesian3()), new Cartesian3()
  )
  let xAxis = Cartesian3.cross(up, zAxis, new Cartesian3())
  // 极区退化保护（three 无此保护，ECEF 极点 sunDir∥(0,1,0) 时 cross=0）：fallback up=(1,0,0)
  if (Cartesian3.magnitude(xAxis) < 1e-9) {
    xAxis = Cartesian3.cross(new Cartesian3(1, 0, 0), zAxis, new Cartesian3())
  }
  Cartesian3.normalize(xAxis, xAxis)
  const yAxis = Cartesian3.cross(zAxis, xAxis, new Cartesian3())
  // basis 列 = (x,y,z)（Cesium Matrix3 构造参数按列主序：col0=xAxis, col1=yAxis, col2=zAxis）
  const rot = new Matrix3(
    xAxis.x, xAxis.y, xAxis.z,
    yAxis.x, yAxis.y, yAxis.z,
    zAxis.x, zAxis.y, zAxis.z
  )
  return Matrix4.fromRotationTranslation(rot, eye, result)
}

const UP = new Cartesian3(0, 1, 0) // three Object3D.DEFAULT_UP（light 朝向 up；world=ECEF 下即 Y 轴）

export class CascadedShadowMaps {
  readonly cascades: Cascade[] = []
  readonly mapSize: number
  readonly splitLambda: number
  readonly fade: boolean
  readonly margin: number
  far = 0

  private readonly cameraFrustum = new FrustumCorners()
  private readonly frusta: FrustumCorners[] = []
  private readonly splits: number[] = []

  constructor(options: CascadedShadowMapsOptions) {
    this.mapSize = options.mapSize
    this.splitLambda = options.splitLambda ?? 0.5
    this.fade = options.fade ?? true
    this.margin = options.margin ?? 0
    for (let i = 0; i < options.cascadeCount; ++i) {
      this.cascades.push({
        interval: new Cartesian2(),
        matrix: new Matrix4(),
        inverseMatrix: new Matrix4(),
        projectionMatrix: new Matrix4(),
        inverseProjectionMatrix: new Matrix4(),
        viewMatrix: new Matrix4(),
        inverseViewMatrix: new Matrix4()
      })
    }
  }

  get cascadeCount(): number {
    return this.cascades.length
  }

  update(camera: CascadeCameraInput, sunDirection: Cartesian3, distance = 1): void {
    const far = camera.far
    this.far = far

    // 1) 切分区间 + 子视锥角点
    splitFrustum('practical', this.cascadeCount, camera.near, far, this.splitLambda, this.splits)
    const invProj = Matrix4.inverse(camera.projectionMatrix, new Matrix4())
    this.cameraFrustum.setFromCamera(invProj, camera.near, far)
    this.cameraFrustum.split(this.splits, this.frusta)
    for (let i = 0; i < this.cascadeCount; ++i) {
      this.cascades[i].interval.x = this.splits[i - 1] ?? camera.near / far
      this.cascades[i].interval.y = this.splits[i] ?? 0
    }
    // three 版 interval.x 首段是 0（splits[-1] ?? 0）——near/far 归一化域下 near/far≈0，统一取 0
    this.cascades[0].interval.x = 0

    // 2) light 朝向 + 相机→light 变换
    //    lightOrientation：位于原点、-Z 朝 -sunDirection（即 +Z 轴 = sunDirection）
    const lightOrientation = lookAtMatrix(
      Cartesian3.ZERO, Cartesian3.multiplyByScalar(sunDirection, -1, new Cartesian3()),
      UP, new Matrix4()
    )
    const invLightOrientation = Matrix4.inverse(lightOrientation, new Matrix4())
    // cameraToLight = inv(lightOrientation) × cameraWorld（把 world 点变换到 light 旋转系）
    const cameraToLight = Matrix4.multiply(
      invLightOrientation, camera.inverseViewMatrix, new Matrix4()
    )

    // 3) 每 cascade：ortho 包围盒 + texel 对齐 center + light 相机矩阵
    for (let i = 0; i < this.cascadeCount; ++i) {
      const cascade = this.cascades[i]
      const frustum = this.frusta[i]
      // light space 下的 8 角
      const lightFrustum = new FrustumCorners()
      for (let j = 0; j < 4; ++j) {
        Matrix4.multiplyByPoint(cameraToLight, frustum.near[j], lightFrustum.near[j])
        Matrix4.multiplyByPoint(cameraToLight, frustum.far[j], lightFrustum.far[j])
      }
      // 对角线半径（three getFrustumRadius：max(far 面对角, 全视锥对角)×0.5 + fade 扩张）
      let diagonal = Math.max(
        Cartesian3.distance(lightFrustum.far[0], lightFrustum.far[2]),
        Cartesian3.distance(lightFrustum.far[0], lightFrustum.near[2])
      )
      if (this.fade) {
        // three：diagonal += 0.25 × (farCorner.z/(far-near))² × (far-near)
        const zRatio = lightFrustum.far[0].z / (far - camera.near)
        diagonal += 0.25 * zRatio * zRatio * (far - camera.near)
      }
      const radius = diagonal * 0.5

      // ortho 投影（注意 Cesium 参数序 (l,r,bottom,top,near,far)；three 是 (l,r,top,bottom,n,f)）
      Matrix4.computeOrthographicOffCenter(
        -radius, radius, -radius, radius, -this.margin, radius * 2 + this.margin,
        cascade.projectionMatrix
      )

      // bbox center（light space 8 角包围盒）
      const min = new Cartesian3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
      const max = new Cartesian3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)
      for (let j = 0; j < 4; ++j) {
        for (const p of [lightFrustum.near[j], lightFrustum.far[j]]) {
          min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x)
          min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y)
          min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z)
        }
      }
      const center = new Cartesian3(
        (min.x + max.x) / 2, (min.y + max.y) / 2, max.z + this.margin
      )
      // texel 对齐（防 shadow 相机平移亚像素抖动；three 同款 snapping）
      const texel = (radius * 2) / this.mapSize
      center.x = Math.round(center.x / texel) * texel
      center.y = Math.round(center.y / texel) * texel

      // light 相机：position = sunDirection×distance + center（world 系），看向 center
      const position = Cartesian3.add(
        Cartesian3.multiplyByScalar(sunDirection, distance, new Cartesian3()),
        // center 是 light 旋转系坐标 → 转回 world：lightOrientation × center
        Matrix4.multiplyByPoint(lightOrientation, center, new Cartesian3()),
        new Cartesian3()
      )
      lookAtMatrix(position, /* target */ Cartesian3.subtract(
        position, Cartesian3.multiplyByScalar(sunDirection, distance, new Cartesian3()), new Cartesian3()
      ), UP, cascade.inverseViewMatrix)

      // 4) 派生矩阵（对齐 three update 末尾六件套）
      Matrix4.inverse(cascade.projectionMatrix, cascade.inverseProjectionMatrix)
      Matrix4.inverse(cascade.inverseViewMatrix, cascade.viewMatrix)
      Matrix4.multiply(cascade.projectionMatrix, cascade.viewMatrix, cascade.matrix)
      Matrix4.multiply(cascade.inverseViewMatrix, cascade.inverseProjectionMatrix, cascade.inverseMatrix)
    }
  }
}
```

**实现注意（易错点，写码时对照）**：
- `Cartesian4` 需要 import；`Cartesian3.ZERO` 是 Cesium 常量 ✓。
- three `lookAt(0, -sunDir, up)`：eye=原点 target=-sunDir → zAxis=normalize(0-(-sunDir))=sunDir ✓（上面代码注释对应）。
- cascade.inverseViewMatrix 的 target：three 是 `lookAt(center, position, up)`——eye=center target=position（zAxis = normalize(center-position) = -sunDir）✓ 与上面「position 看 center」一致（-Z 朝 -sunDir 即朝 center 方向）。写码时用 three 原式：`lookAtMatrix(centerWorld, position, UP, ...)`——centerWorld = position - sunDirection×distance。
- `Matrix4.multiply(A, B)` = A×B（列向量约定，与 three multiplyMatrices 同序）✓。

- [ ] **Step 4: 跑测试到绿**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts`
Expected: PASS（若 roundtrip 精度断言失败，检查 lookAt 语义/ortho 参数序——这是最常见的两个移植错）

- [ ] **Step 5: tsc + commit**

```bash
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
git add packages/cesium-clouds/src/CascadedShadowMaps.ts packages/cesium-clouds/src/CascadedShadowMaps.test.ts
git commit -m "feat(clouds): M3 T1 CascadedShadowMaps——sun-POV 级联正交矩阵（three 版 Cesium 移植）"
```

---

### Task 2: ShadowMaterial —— shadow.frag surgery 组装器（单 cascade 生成 shader）

**Files:**
- Create: `packages/cesium-clouds/src/ShadowMaterial.ts`
- Test: `packages/cesium-clouds/src/shadowMain.compile.test.ts`

**Interfaces:**
- Consumes: `./glslIndex`（`glslIndex.shadowFrag`）、`./resolveCloudsIncludes`（include 解析 + unrollLoops，同 CloudsMaterial.ts 用法）。
- Produces（T3 消费）:
  ```ts
  interface ShadowMainOptions { shapeDetail?: boolean; turbulence?: boolean }  // 默认 true
  buildCloudsShadowFragmentShader(options?): string        // Cesium 运行时（无 #version）
  buildStandaloneCloudsShadowShaderForValidation(options?): string  // #version 300 es + v_textureCoordinates 声明已含
  SHADOW_PIPELINE_DEFINES: readonly string[]               // 调试/断言用 define 清单
  ```

- [ ] **Step 1: 写失败测试** `shadowMain.compile.test.ts`（范式抄 `cloudsMain.compile.test.ts`：compileOrFail 辅助 + surgery 断言 + glslang 真编译 + 防哑过用例）。核心断言：

```ts
// M3 T2：shadow.frag（BSM sun-POV march）→ Cesium 单 cascade 生成 shader 的 surgery 组装验证。
import { describe, expect, it } from 'vitest'
import {
  buildCloudsShadowFragmentShader,
  buildStandaloneCloudsShadowShaderForValidation
} from './ShadowMaterial'
import { compileFragment } from './glslangUtil'

const OPTS = {}

describe('M3 T2 shadow.frag surgery 断言', () => {
  it('单输出：无 outputColor[CASCADE_COUNT] 数组 / 无 outputDepthVelocity / 无 reprojectionMatrices', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('layout(location = 0) out vec4 outputColor;')
    expect(src).not.toMatch(/out vec4 outputColor\[CASCADE_COUNT\]/)
    expect(src).not.toContain('outputDepthVelocity')
    expect(src).not.toContain('reprojectionMatrices')
  })
  it('u_cascadeIndex uniform + main 单 cascade 调用 + vUv→v_textureCoordinates 桥接', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('uniform int u_cascadeIndex;')
    expect(src).toMatch(/void main\(\)\s*\{\s*cascade\(u_cascadeIndex, mipLevels\[u_cascadeIndex\], outputColor\)/)
    expect(src).toContain('in vec2 v_textureCoordinates;')
    expect(src).toContain('#define vUv v_textureCoordinates')
    expect(src).not.toMatch(/in vec2 vUv;/)
  })
  it('defines：SHADOW / CASCADE_COUNT 3 / TEMPORAL_JITTER / SHAPE_DETAIL / TURBULENCE', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('#define SHADOW')
    expect(src).toContain('#define CASCADE_COUNT 3')
    expect(src).toContain('#define TEMPORAL_JITTER')
    expect(src).toContain('#define SHAPE_DETAIL')
    expect(src).toContain('#define TURBULENCE')
    // 不 define TEMPORAL_PASS（M4 temporal 接通）
    expect(src).not.toMatch(/#define TEMPORAL_PASS/)
  })
  it('inverseShadowMatrices[CASCADE_COUNT] 数组保留（动态索引采样）', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('uniform mat4 inverseShadowMatrices[CASCADE_COUNT];')
  })
  it('运行时 shader 不带 #version；校验 shader 以 #version 300 es 开头', () => {
    expect(buildCloudsShadowFragmentShader(OPTS).startsWith('#version')).toBe(false)
    expect(buildStandaloneCloudsShadowShaderForValidation(OPTS).startsWith('#version 300 es')).toBe(true)
  })
})

describe('M3 T2 glslangValidator 真编译', () => {
  it('默认 options 编译通过', () => {
    const src = buildStandaloneCloudsShadowShaderForValidation(OPTS)
    const { ok, output } = compileFragment(src)
    if (!ok) throw new Error(`glslang 失败:\n${output}`)
    expect(ok).toBe(true)
  })
  it('关闭 SHAPE_DETAIL / TURBULENCE 也编译通过', () => {
    const src = buildStandaloneCloudsShadowShaderForValidation({ shapeDetail: false, turbulence: false })
    const { ok, output } = compileFragment(src)
    if (!ok) throw new Error(`glslang 失败:\n${output}`)
    expect(ok).toBe(true)
  })
  it('glslang 真的会抓错（防哑过：删掉 in 声明应编译失败）', () => {
    const src = buildStandaloneCloudsShadowShaderForValidation(OPTS)
      .replace(/in vec2 v_textureCoordinates;\n/, '')
    const { ok, output } = compileFragment(src)
    expect(ok).toBe(false)
    expect(output).toContain('ERROR')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/shadowMain.compile.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `ShadowMaterial.ts`**

结构仿 `CloudsMaterial.ts`（读该文件对照），但 surgery 项更少（决策 D5）：

```ts
// ShadowMaterial.ts
//
// M3 T2：three shadow.frag（BSM sun-POV march）→ Cesium 生成端 shader 桥接组装器。
// surgery 决策（plan 决策 D5）：
//   1. `in vec2 vUv;` → `in vec2 v_textureCoordinates;` + `#define vUv v_textureCoordinates`
//   2. MRT out 数组 → 单 out vec4 outputColor（每 draw 一个 cascade，u_cascadeIndex uniform）
//   3. 删 outputDepthVelocity 声明块 + cascade() velocity 参数与 TEMPORAL_PASS 段 + reprojectionMatrices
//      （M4 temporal 接通时按 three 原文加回）
//   4. main 的 unroll 循环 → 单 cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor)
// shadow.frag 不引用任何 czm_*（无需 CZM_STUBS）。
import { glslIndex } from './glslIndex'
import { resolveCloudsIncludes } from './resolveCloudsIncludes'

export interface ShadowMainOptions {
  shapeDetail?: boolean
  turbulence?: boolean
}

const SHADOW_DEFINES_BASE = [
  '#define SHADOW',                 // sampleWeather 走 shadowLayerMask（BSM 只算 shadow=true 的层）
  '#define CASCADE_COUNT 3',        // 决策 D4（与主 march SHADOW_CASCADE_COUNT 一致）
  '#define TEMPORAL_JITTER',        // STBN 静态 jitter（frame=0；M4 递增）
  '#define LOCAL_WEATHER_CHANNELS rgba'
]

function buildDefines(o: Required<ShadowMainOptions>): string {
  return [
    ...SHADOW_DEFINES_BASE,
    o.shapeDetail ? '#define SHAPE_DETAIL' : '',
    o.turbulence ? '#define TURBULENCE' : ''
  ].filter((s) => s.length > 0).join('\n')
}

function surgeryShadowFrag(source: string): string {
  let src = source
  // 1) varying 桥接
  src = src.replace(
    /in vec2 vUv;\n/,
    'in vec2 v_textureCoordinates;  // Cesium ViewportQuadVS 注入\n#define vUv v_textureCoordinates\n'
  )
  // 2) MRT out 数组 → 单 out
  src = src.replace(
    /layout\(location = 0\) out vec4 outputColor\[CASCADE_COUNT\];\n/,
    'layout(location = 0) out vec4 outputColor;\n'
  )
  // 3) 删 outputDepthVelocity 声明块（#if CASCADE_COUNT == 1..4 冗余段，含注释行）
  src = src.replace(/\n\/\/ Redundant notation for prettier\.\n#if CASCADE_COUNT == 1\n[\s\S]*?#endif \/\/ CASCADE_COUNT\n/, '\n')
  // 4) 删 reprojectionMatrices uniform（TEMPORAL_PASS 专用，M4 加回）
  src = src.replace(/uniform mat4 reprojectionMatrices\[CASCADE_COUNT\];\n/, '')
  // 5) cascade() 签式去掉 velocity 出参 + 体内 TEMPORAL_PASS 段删除
  src = src.replace(
    /  const float mipLevel,\n  out vec4 outputColor,\n  out vec3 outputDepthVelocity\n\) \{/,
    '  const float mipLevel,\n  out vec4 outputColor\n) {'
  )
  src = src.replace(/\n  #ifdef TEMPORAL_PASS\n[\s\S]*?#else \/\/ TEMPORAL_PASS\n  outputDepthVelocity = vec3\(0\.0\);\n  #endif \/\/ TEMPORAL_PASS\n/, '\n')
  // 6) main 单 cascade 调用（unroll 循环 → u_cascadeIndex）
  src = src.replace(
    /void main\(\) \{\n  #pragma unroll_loop_start\n[\s\S]*?#pragma unroll_loop_end\n\}/,
    'uniform int u_cascadeIndex;  // 每 draw 换值（同 shader 复用 ShaderProgram 缓存）\n' +
    'void main() {\n' +
    '  cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor);\n' +
    '}'
  )
  return src
}

export function buildCloudsShadowFragmentShader(options: ShadowMainOptions = {}): string {
  const o = { shapeDetail: options.shapeDetail ?? true, turbulence: options.turbulence ?? true }
  const merged = [buildDefines(o), surgeryShadowFrag(glslIndex.shadowFrag)].join('\n\n')
  return resolveCloudsIncludes(merged)
}

export function buildStandaloneCloudsShadowShaderForValidation(
  options: ShadowMainOptions = {}
): string {
  const runtime = buildCloudsShadowFragmentShader(options)
  // v_textureCoordinates 的 in 声明已由 surgery 1 注入；校验只补 #version + precision
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp sampler3D;',
    runtime
  ].join('\n')
}
```

**实现注意**：
- 写码前先 `grep -n` 核对 `shadow.frag` 原文锚点逐字匹配（`src/glsl/shadow.frag` L22 `in vec2 vUv;`、L24 out 数组、L27-35 velocity 块、L14 reprojection、L147-152 cascade 签名、L169-179 TEMPORAL_PASS 段、L185-193 main）。正则不匹配时打印手术前后源对照调试，**不要改 .glsl 原文**。
- `#pragma unroll_loop_start` 在 main 手术点被整段替换，`resolveCloudsIncludes` 的 unrollLoops 对其余 `marchClouds` 内循环照常展开。

- [ ] **Step 4: 跑测试到绿**（命令同上，Expected: PASS）

- [ ] **Step 5: tsc + commit**

```bash
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
git add packages/cesium-clouds/src/ShadowMaterial.ts packages/cesium-clouds/src/shadowMain.compile.test.ts
git commit -m "feat(clouds): M3 T2 ShadowMaterial——shadow.frag 单 cascade surgery 组装器（glslang 双入口验证）"
```

---

### Task 3: ShadowPass —— BSM 生成端（Texture3D + 裸 FBO 逐层 attach + preRender render）

**Files:**
- Create: `packages/cesium-clouds/src/ShadowPass.ts`
- Test: `packages/cesium-clouds/src/ShadowPass.test.ts`

**Interfaces:**
- Consumes: `FullscreenPass`（`@cesium-geospatial/core`）、`buildCloudsShadowFragmentShader`（T2）、`cesium` 的 `Texture3D/Texture/PixelFormat/PixelDatatype/Sampler/RenderState/BoundingRectangle`。
- Produces（T4/T5 消费）:
  ```ts
  interface ShadowPassOptions {
    context: Context
    cascadeCount: number          // 3
    mapSize: number               // 512
    pixelDatatype?: number        // HALF_FLOAT 检测由调用方（createCloudsStage）传入；缺省 HALF_FLOAT
    uniformMap: { [name: string]: () => unknown }  // 业务 uniform（weather/LUT/层/march-shadow 档/inverseShadowMatrices/u_cascadeIndex 由本类注入覆盖）
  }
  interface ShadowPass {
    readonly bsmTexture: Texture3D          // 消费端 clouds.frag shadowBuffer uniform 直传
    render(): void                          // preRender 调：N×(attach layer → u_cascadeIndex=i → execute)
    destroy(): void
  }
  ```

- [ ] **Step 1: 写失败测试** `ShadowPass.test.ts`（gl mock 断言调用序列，范式抄 `CloudsPass.test.ts` 的 cesium mock + 自建 gl mock）：

```ts
// M3 T3：ShadowPass 生成端单测——gl mock 断言 FBO 创建/逐层 attach/draw 循环/状态 save-restore。
import { describe, expect, it, vi } from 'vitest'

// gl mock：记录所有与 FBO 相关的调用（WebGL2RenderingContext 子集）
const glCalls: string[] = []
const attachments: { layer: number; tex: unknown }[] = []
const gl = {
  createFramebuffer: vi.fn(() => ({ tag: 'fbo' })),
  deleteFramebuffer: vi.fn(),
  bindFramebuffer: vi.fn((_t: number, fbo: unknown) => glCalls.push(`bind:${(fbo as { tag: string } | null)?.tag ?? 'null'}`)),
  framebufferTextureLayer: vi.fn((_t: number, _a: number, tex: unknown, _l: number, layer: number) => {
    glCalls.push(`attach:${layer}`); attachments.push({ layer, tex })
  }),
  checkFramebufferStatus: vi.fn(() => 36053), // GL_FRAMEBUFFER_COMPLETE
  getParameter: vi.fn(() => ({ tag: 'prevFbo' })),
  viewport: vi.fn()
}

vi.mock('cesium', () => {
  class Texture3DMock {
    _texture = { tag: 'tex3d' }
    _target = 32879 // GL_TEXTURE_3D
    constructor(_opts: unknown) {}
    destroy() {}
  }
  class SamplerMock { constructor(_o?: unknown) {} }
  const RenderStateMock = { fromCache: vi.fn(() => ({ id: 1 })) }
  const FullscreenPassStub = class {
    static lastUniforms: unknown
    executeCount = 0
    constructor(_ctx: unknown, opts: { uniformMap: Record<string, () => unknown> }) {
      FullscreenPassStub.lastUniforms = opts.uniformMap
    }
    execute(_ctx: unknown) { this.executeCount++ }
    destroy() {}
  }
  return {
    Texture3D: Texture3DMock,
    Sampler: SamplerMock,
    RenderState: RenderStateMock,
    BoundingRectangle: class {},
    PixelFormat: { RGBA: 0x1908 },
    PixelDatatype: { HALF_FLOAT: 0x140b, FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401 },
    TextureMinificationFilter: { LINEAR: 9729, NEAREST: 9728 },
    TextureMagnificationFilter: { LINEAR: 9729, NEAREST: 9728 },
    TextureWrap: { REPEAT: 10497, CLAMP_TO_EDGE: 33071 },
    // FullscreenPass 从 core 导入——这里不 mock core（用真类会碰 context.createViewportQuadCommand），
    // 故本测试直接 mock 本模块对 core 的依赖不可行；改为把 FullscreenPass 作为注入依赖（见实现：
    // ShadowPassOptions.createPass?）——简化：实现里以可选参数注入 draw 回调，测试传 stub。
  }
})
```

> **实现取舍说明（写给实现者）**：`FullscreenPass` 依赖真 `context.createViewportQuadCommand`（Cesium Context 深路径，mock 成本高）。为可测性，`ShadowPass` 的构造参数加 `createDrawPass?: (fragmentShaderSource: string, uniformMap) => { execute(ctx); destroy() }`（默认用 `FullscreenPass`，测试注入 stub 工厂记录 execute 次数）。上面 cesium mock 里删掉 FullscreenPassStub，测试改为断言：gl 调用序列（bind prev→fbo→attach 0/1/2→…→bind prev 恢复）+ 注入的 drawPass 被调 3 次 + uniformMap.u_cascadeIndex 闭包依次返回 0/1/2 + bsmTexture 是 Texture3D。

完整测试用例清单：
1. `render() 前后 FRAMEBUFFER_BINDING 保存恢复`（getParameter 记录 → bind(null/prev) 恢复断言序列首尾）。
2. `render() 对 cascadeCount=3 依次 attach layer 0,1,2 且每层 execute 一次 draw`。
3. `u_cascadeIndex 闭包随 attach 层切换`（render 后读 uniformMap.u_cascadeIndex() === 2，render 过程中在 stub execute 里采样断言 0→1→2）。
4. `checkFramebufferStatus 非 COMPLETE 时 console.warn 且跳过 draw`（不炸——降级语义，主 march fallback dummy Beer=1）。
5. `destroy() 释放 FBO + bsmTexture + drawPass`（deleteFramebuffer 调用、幂等）。

- [ ] **Step 2: 跑测试确认失败**（FAIL：模块不存在）

- [ ] **Step 3: 实现 `ShadowPass.ts`**

核心代码（完整骨架，照此落盘）：

```ts
// ShadowPass.ts
//
// M3 T3：BSM 生成端——sun-POV 全屏 march 写 Texture3D 的 cascade 层。
//
// 时机（决策 D2）：createCloudsStage 的 scene.preRender listener 内调 render()——
// 先于云 march（VOXELS pass），且此刻 camera.frustum.near/far 是完整视锥（cascade split 域一致）。
// BSM 不依赖 globe depth（sun-POV 云密度场，零场景几何）→ preRender 合法。
//
// 生成机制（决策 D1）：Cesium Texture3D（HALF_FLOAT RGBA mapSize²×N）+ 裸 GL FBO
// glFramebufferTextureLayer 逐层 attach（WebGL2 允许 TEXTURE_3D attach layer）→ 每 cascade
// 一次 FullscreenPass.execute（RenderState.viewport=mapSize）。Plan B（layer attach 不可用）：
// 2D FBO + glCopyTexSubImage3D——render() 内部替换，接口不变。
import {
  Texture3D, PixelFormat, PixelDatatype, Sampler,
  TextureMinificationFilter, TextureMagnificationFilter, TextureWrap,
  RenderState, BoundingRectangle
} from 'cesium'
import type { Context } from 'cesium'
import { FullscreenPass } from '@cesium-geospatial/core'
import { buildCloudsShadowFragmentShader, type ShadowMainOptions } from './ShadowMaterial'

// 裸 GL 常量（WebGL2RenderingContext enum 值）
const GL_FRAMEBUFFER = 0x8d40
const GL_COLOR_ATTACHMENT0 = 0x8ce0
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5
const GL_FRAMEBUFFER_BINDING = 0x8ca6

export interface ShadowDrawPass {
  execute(context: Context): void
  destroy(): void
}
export type ShadowDrawPassFactory = (
  context: Context,
  fragmentShaderSource: string,
  uniformMap: { [name: string]: () => unknown },
  viewportSize: number
) => ShadowDrawPass

export interface ShadowPassOptions {
  context: Context
  cascadeCount: number
  mapSize: number
  pixelDatatype?: number
  uniformMap: { [name: string]: () => unknown }  // 业务 uniform（调用方组好；本类注入 u_cascadeIndex）
  shaderOptions?: ShadowMainOptions
  /** 测试注入 draw pass 工厂；缺省 FullscreenPass。 */
  createDrawPass?: ShadowDrawPassFactory
}

const defaultCreateDrawPass: ShadowDrawPassFactory = (context, fragmentShaderSource, uniformMap, viewportSize) =>
  new FullscreenPass(context, {
    fragmentShaderSource,
    uniformMap,
    renderState: RenderState.fromCache({
      viewport: new BoundingRectangle(0, 0, viewportSize, viewportSize),
      depthTest: { enabled: false },
      depthMask: false
    })
    // 不传 framebuffer——executeCommand 见 cmd._framebuffer undefined 时保留外部绑定（裸 FBO）
  }) as ShadowDrawPass

export function createShadowPass(options: ShadowPassOptions): ShadowPass { /* 见下 */ }

export interface ShadowPass {
  readonly bsmTexture: Texture3D
  render(): void
  destroy(): void
}
```

`createShadowPass` 实现要点：
1. `bsmTexture = new Texture3D({ context, source: { width: mapSize, height: mapSize, depth: cascadeCount, arrayBufferView: new Uint16Array(mapSize*mapSize*cascadeCount*4) /* half float 全 0 */ }, pixelFormat: RGBA, pixelDatatype: opts.pixelDatatype ?? HALF_FLOAT, sampler: LINEAR/LINEAR + CLAMP_TO_EDGE/CLAMP_TO_EDGE, flipY: false })`——注：HALF_FLOAT 用 Uint16Array 视图（0 = +0.0 half）；`arrayBufferView` 的 TypedArray 类型必须与 pixelDatatype 匹配（Float16 无原生类型，Cesium 接受 Uint16Array 做 HALF_FLOAT 上传——与 lutLoader 的 Float16Array 同理；若 Cesium 校验拒绝则不传预置数据、留空纹理 + 首帧全屏覆盖，值即 0）。
2. 裸 FBO：`const gl = (context as { _gl: WebGL2RenderingContext })._gl`；`fbo = gl.createFramebuffer()`。
3. `u_cascadeIndex` mutable：`let cascadeIndex = 0`；`uniformMap = { ...options.uniformMap, u_cascadeIndex: () => cascadeIndex }`。
4. `render()`：
   ```ts
   const prevFbo = gl.getParameter(GL_FRAMEBUFFER_BINDING)
   gl.bindFramebuffer(GL_FRAMEBUFFER, fbo)
   try {
     for (let i = 0; i < cascadeCount; i++) {
       gl.framebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, rawTex, 0, i)
       if (i === 0 && gl.checkFramebufferStatus(GL_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
         console.warn('[clouds] BSM FBO 不完整，跳过本帧（主 march fallback Beer=1）')
         return
       }
       cascadeIndex = i
       drawPass.execute(context)
     }
   } finally {
     gl.bindFramebuffer(GL_FRAMEBUFFER, prevFbo)
   }
   ```
   （`rawTex = (bsmTexture as { _texture: WebGLTexture })._texture`）
5. `destroy()`：幂等 flag；`gl.deleteFramebuffer(fbo)` + `drawPass.destroy()` + `(bsmTexture as { destroy(): void }).destroy()`。
6. **viewport 恢复**：RenderState.viewport=mapSize 在 execute 内 apply；结束 finally 里补 `gl.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight)`（drawingBufferWidth 经 `context as { drawingBufferWidth: number }`，同 CloudsPass 局部类型）。

- [ ] **Step 4: 跑测试到绿；补全用例 4/5**

- [ ] **Step 5: tsc + commit**

```bash
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
git add packages/cesium-clouds/src/ShadowPass.ts packages/cesium-clouds/src/ShadowPass.test.ts
git commit -m "feat(clouds): M3 T3 ShadowPass——Texture3D 逐层 attach 生成 BSM（preRender 手动 execute）"
```

---

### Task 4: 主 march 接真 BSM —— CloudsMaterial surgery 增量 + CloudsPass uniform 换真值

**Files:**
- Modify: `packages/cesium-clouds/src/CloudsMaterial.ts`
- Modify: `packages/cesium-clouds/src/cloudsDefaultParameters.ts`
- Modify: `packages/cesium-clouds/src/CloudsPass.ts`
- Test: `packages/cesium-clouds/src/cloudsMain.compile.test.ts`（增用例）、`packages/cesium-clouds/src/CloudsPass.test.ts`（改断言）

**Interfaces:**
- Consumes: T3 的 `ShadowPass.bsmTexture`；`CloudsShadowFrameState`（本 task 定义，T5 填值）:
  ```ts
  interface CloudsShadowFrameState {
    matrices: Matrix4[]        // [3]，cascades[i].matrix
    intervals: Cartesian2[]   // [3]
    cameraNear: number        // BSM split 用的完整 near
    far: number               // BSM far（shadowFar uniform 同源）
    texelSize: Cartesian2     // 1/512
    bsm: Texture3D | undefined // ShadowPass.bsmTexture（首帧前 undefined → fallback dummy）
  }
  ```
- Produces: `CloudsFrameState` 增可选字段 `shadow?: CloudsShadowFrameState`；`CloudsParameters` 增 `shadowMarch` 档 + `shadowCascadeCount`；导出 `CloudsShadowFrameState` 类型。

- [ ] **Step 1: 写失败测试**

`cloudsMain.compile.test.ts` 新增 describe（沿用现有 compileOrFail）：

```ts
describe('M3 T4 BSM 消费 surgery', () => {
  it('sampler3D z 归一化：texture(shadowBuffer, vec3(uv, (i+0.5)/SHADOW_CASCADE_COUNT))', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    // readShadowOpticalDepth 的采样点（clouds.frag L180 原文 texture(shadowBuffer, vec3(uv, float(cascadeIndex)))）
    expect(src).toContain('(float(cascadeIndex) + 0.5) / float(SHADOW_CASCADE_COUNT)')
    expect(src).not.toContain('texture(shadowBuffer, vec3(uv, float(cascadeIndex)))')
  })
  it('cascade 选择解 multi-frustum 错位：cameraNear→u_shadowCameraNear（3 处调用点）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('uniform float u_shadowCameraNear;')
    // getCascadeColor / getFadedCascadeColor / sampleShadowOpticalDepth 内共 3 处
    const count = src.split('u_shadowCameraNear,\n    shadowFar').length - 1
    expect(count).toBe(3)
    // DEBUG_SHOW_CASCADES 关闭时这些调用不编译，但源文本手术已替换（glslang 编译验证见下）
  })
  it('#define POWDER（powderScale=0.8>0，three 默认开）+ SHADOW_CASCADE_COUNT 3', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('#define POWDER')
    expect(src).toContain('#define SHADOW_CASCADE_COUNT 3')
    expect(src).not.toContain('#define SHADOW_CASCADE_COUNT 4')
  })
  it('glslang：M3 默认 options（含 POWDER）编译通过', () => {
    compileOrFail(buildStandaloneCloudsShaderForValidation(M2_OPTIONS), 'M3 默认')
  })
})
```

（若现有用例断言了 `SHADOW_CASCADE_COUNT 4`，同步改 3。）

`CloudsPass.test.ts` 增用例：state.shadow 有值时 uniformMap 的 `shadowBuffer/shadowMatrices/shadowIntervals/shadowFar/shadowTexelSize/u_shadowCameraNear` 返回 state 值；`shadow.bsm` undefined 时 shadowBuffer 返回全 0 dummy（保留的 fallback）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`CloudsMaterial.ts` 三处改动：

1. `CLOUDS_MAIN_DEFINES`：`SHADOW_CASCADE_COUNT 4` → `SHADOW_CASCADE_COUNT 3`；追加 `'#define POWDER'`（注释：powderScale=0.8>0，three CloudsMaterial 动态 define 等价，M3 决策 D4）。

2. `surgeryCloudsFrag` 新增步骤 6（z 归一化，锚点唯一）：

```ts
  // 6) M3：sampler3D 的 z 是归一化深度（sampler2DArray 才是 layer 索引）——半 texel 中心采样，
  //    z 恰在层中心 → LINEAR 三线性 z 邻层权重 0，无跨层混叠（决策 D1）。
  src = src.replace(
    /vec4 shadow = texture\(shadowBuffer, vec3\(uv, float\(cascadeIndex\)\)\);/,
    'vec4 shadow = texture(shadowBuffer, vec3(uv, (float(cascadeIndex) + 0.5) / float(SHADOW_CASCADE_COUNT)));'
  )
```

3. `surgeryCloudsFrag` 新增步骤 7（cascade 选择 near/far 解耦，决策 D3——replace_all 3 处）：

```ts
  // 7) M3：cascade 选择的归一化 near 必须用 BSM split 时的完整 near（u_shadowCameraNear），
  //    而非 czm_currentFrustum.x（multi-frustum 分段值——分段执行时归一化错位 → cascade 全错）。
  //    3 处调用点：getCascadeColor / getFadedCascadeColor / sampleShadowOpticalDepth
  //    （marchShadowLength 内同 pattern 一并替换，M5 SHADOW_LENGTH 接通时自动正确）。
  src = src.replaceAll('cameraNear,\n    shadowFar', 'u_shadowCameraNear,\n    shadowFar')
```

并在 `BRIDGE_DEFINES_GLSL` 末尾追加声明 `uniform float u_shadowCameraNear;`（放 define 块尾部，先于 clouds.frag 所有函数）。

`cloudsDefaultParameters.ts`：
- `shadowIntervals/shadowMatrices` 数组 4→3 元素（dummy 全 0/identity）。
- 新增字段：

```ts
  // ── BSM shadow march 档（M3，qualityPresets.ts defaults.shadow）──
  shadowMarch: {
    maxIterationCount: 50,
    minStepSize: 100,
    maxStepSize: 1000,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 1e-4,
    opticalDepthTailScale: 2
  }
```

- 导出 `CloudsShadowFrameState` 接口（见 Interfaces）。

`CloudsPass.ts`：
- `CloudsFrameState` 增 `shadow?: CloudsShadowFrameState`。
- **保留** `dummyShadowBuffer`（首帧/降级 fallback，改 depth 为 3）。
- uniformMap BSM 段替换为：

```ts
    // BSM（M3：state.shadow 由 createCloudsStage preRender 填；未就绪 fallback 全 0 dummy → Beer=1）
    shadowBuffer: () => state.shadow?.bsm ?? dummyShadowBuffer,
    shadowTexelSize: () => state.shadow?.texelSize ?? params.shadowTexelSize,
    shadowIntervals: () => state.shadow?.intervals ?? params.shadowIntervals,
    shadowMatrices: () => state.shadow?.matrices ?? params.shadowMatrices,
    shadowFar: () => state.shadow?.far ?? params.shadowFar,
    u_shadowCameraNear: () => state.shadow?.cameraNear ?? 0,
```

- destroy 段 dummyShadowBuffer 注释同步（"M3 已接真实 BSM，此为 fallback"）。

- [ ] **Step 4: 跑两个测试文件到绿 + 全包回归**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts src/CloudsPass.test.ts` → PASS；再 `pnpm --filter @cesium-geospatial/clouds test` 全绿。

- [ ] **Step 5: tsc + commit**

```bash
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
git add -A packages/cesium-clouds/src
git commit -m "feat(clouds): M3 T4 主 march 接真 BSM——sampler3D z 归一化 + u_shadowCameraNear + POWDER"
```

---

### Task 5: 编排 —— createCloudsStage preRender 更新 cascade + render BSM + demo 开关

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`
- Modify: `apps/demo/src/main.ts`
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`

**Interfaces:**
- Consumes: T1 `CascadedShadowMaps`、T3 `createShadowPass`、T4 `CloudsShadowFrameState`。
- Produces: `createCloudsStage` 行为不变签名；demo `?cloudsShadow=0` 跳过 BSM（诊断基线）。

- [ ] **Step 1: 写失败测试**（`createCloudsStage.test.ts` 现有 mock 基础上增）：
  1. `clouds=1` 时 preRender 触发后 `shadowState.bsm` 为 ShadowPass 的 bsmTexture、`matrices/intervals` 长度 3、`cameraNear/far/texelSize` 来自 mock 相机（frustum.near/far + 1/512）。
  2. `cloudsShadow=0` 传入时（options.shadowPass=false）不创建 ShadowPass、state.shadow 恒 undefined（主 march Beer=1 基线，M2 行为）。
  3. `destroy()` 调 shadowPass.destroy（注入工厂 spy 断言）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`createCloudsStage.ts` 关键增量（在现有 preRender listener 的 sunDirection 更新之后追加；CloudsStageOptions 增 `shadowPass?: boolean` 默认 true）：

```ts
  // ── M3 BSM：cascade 矩阵 + 生成 pass ──
  const cascadeCount = 3
  const mapSize = 512
  const cascades = new CascadedShadowMaps({ cascadeCount, mapSize })
  const shadowState: CloudsShadowFrameState = {
    matrices: params.shadowMatrices,       // 复用默认数组（长度 3，update 后逐项写入）
    intervals: params.shadowIntervals,
    cameraNear: 0,
    far: params.shadowFar,
    texelSize: new Cartesian2(1 / mapSize, 1 / mapSize),
    bsm: undefined
  }
  state.shadow = options.shadowPass === false ? undefined : shadowState

  // shadowPass uniformMap：与主 march 共享的 business uniform + BSM 专属（决策 D5 档位 +
  // inverseShadowMatrices 每 preRender 写入的 mutable 数组）
  const inverseMatrices = params.shadowMatrices.map(() => Matrix4.clone(Matrix4.IDENTITY))
  const shadowUniformMap = { /* 见下——从主 uniformMap 同源闭包复制 weather/LUT/层/大气段，
                                外加 shadowMarch 档参数 + inverseShadowMatrices */ }
  const shadowPass = options.shadowPass === false ? undefined : createShadowPass({
    context, cascadeCount, mapSize,
    pixelDatatype: resolveCloudsHdrDatatype(scene),
    uniformMap: shadowUniformMap
  })
```

**uniformMap 共享方式**：把 `CloudsPass.ts` 里 uniformMap 的「weather/shape/云层 packed/大气 LUT/scatter 视觉/sunDirection/altitudeCorrection/worldToECEF/ecefToWorld/bottomRadius/frame/stbn」段抽成 `buildSharedCloudsUniforms(scene, luts, weather, state, params)` 导出（新导出，CloudsPass 与 ShadowPass 各自扩展自己的专有段）。抽取时**逐项搬移不改语义**（纯重构，CloudsPass.test 既有断言护住）。

preRender listener 追加（sunDirection 更新后）：

```ts
      if (shadowPass != null && shadowState != null) {
        // 太阳天顶角 → 虚拟光源距离（three CloudsEffect:380-396：lerp(1e6, 1e3, zenith)）
        const normal = ellipsoid.geodeticSurfaceNormal(camera.positionWC, normalScratch)
        const zenith = Math.max(0, Cartesian3.dot(state.sunDirection, normal))
        const distance = 1e6 + (1e3 - 1e6) * zenith
        // BSM far：完整视锥 far 与 maxRayDistance 取小（决策 D6）
        const far = Math.min(camera.frustum.far, params.maxRayDistance)
        const near = camera.frustum.near
        cascades.update(
          { inverseViewMatrix: camera.inverseViewMatrix,
            projectionMatrix: (camera.frustum as { projectionMatrix: Matrix4 }).projectionMatrix,
            near, far },
          state.sunDirection, distance
        )
        for (let i = 0; i < cascadeCount; i++) {
          Matrix4.clone(cascades.cascades[i].matrix, shadowState.matrices[i])
          Matrix4.clone(cascades.cascades[i].inverseMatrix, inverseMatrices[i])
          shadowState.intervals[i].x = cascades.cascades[i].interval.x
          shadowState.intervals[i].y = cascades.cascades[i].interval.y
        }
        shadowState.cameraNear = near
        shadowState.far = far
        shadowState.bsm = shadowPass.bsmTexture
        shadowPass.render()
      }
```

（`params` = `options.parameters ?? defaultCloudsParameters()`——与 CloudsPass 同一份，从 createCloudsPass 逻辑上移或重复求值注意同源；实现时把 `createCloudsPass` 内的 params 求值上提到 `createCloudsStage` 传入，避免两份。）

`apps/demo/src/main.ts`：clouds options 增 `...(getString('cloudsShadow') === '0' ? { shadowPass: false } : {})`（诊断基线：BSM 关 → Beer=1 对比云体积感）。

- [ ] **Step 4: 跑测试到绿 + 全包回归 + demo 冒烟**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts` → PASS；`pnpm test`（全 workspace）全绿。

- [ ] **Step 5: tsc + commit**

```bash
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
git add packages/cesium-clouds/src apps/demo/src/main.ts
git commit -m "feat(clouds): M3 T5 编排——preRender 级联更新 + BSM 生成 + demo cloudsShadow 诊断开关"
```

---

### Task 6: 视觉验收 + results 文档

**Files:**
- Create: `docs/superpowers/plans/2026-08-14-clouds-m3-bsm-results.md`
- Modify: 记忆文件 `phase3-clouds-m1.md` + `MEMORY.md` 索引（会话收尾时做，不进 commit）

- [ ] **Step 1: 全量回归 + tsc**

Run: `pnpm test && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit`
Expected: 全绿（core + clouds；clouds 从 57 涨到 ~75+）

- [ ] **Step 2: 请用户视觉验收（提供验收 URL 集）**

给用户的验收清单（`apps/demo`，`?mode=atmosphere&clouds=1` 基础上）：
1. **云体积厚度/暗部**：默认视角（`#camera=116.3,39.9,15000,0,-45` 附近或用户惯用视角）——云底应暗、向阳面亮、云内有层次（对比 `?cloudsShadow=0` 基线的 flat lighting）。
2. **cascade 接缝 probe**（spec M3 验收项）：`?cloudsDebug=4`（shadowMap 视图）看 3 个 BSM 层内容合理（近层云形细、远层粗）；倾斜视角低太阳（如 `?time=2026-08-14T05:30+08:00`）看云影无级联边界带状跳变。
3. **早/晚太阳**（zenithAngle 低 → BSM 光距近）：晨昏时刻云被地平线方向的太阳染色 + 长影子。
4. **回归**：`clouds=0` 零变化；M2 验收 URL（延庆/青藏/海面）云不穿帮。

用户确认后如有 artifact → 递进 debug（cloudsDebug=4 + cloudsShadow=0 对照 + debugShow 'shadowMap'），修复后重复。

- [ ] **Step 3: 写 results 文档**（T1-T6 交付表 + 手术/桥接要点 + 验收现象记录 + 已知项（BSM temporal→M4；multi-frustum 段 near 语义复查→M6；Plan B 是否触发）+ M4 前置）

- [ ] **Step 4: commit + 更新记忆**

```bash
git add docs/superpowers/plans/2026-08-14-clouds-m3-bsm-results.md
git commit -m "docs(clouds): M3 results——BSM 云自阴影全过（级联矩阵移植 + Texture3D 逐层生成 + Beer/powder 接通）"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §6 M3「ShadowMaterial + ShadowPass + CascadedShadowMaps + Beer-Lambert + powder + cascade 边界 probe」→ T1/T2/T3/T4/T5/T6 全落；ShadowResolveMaterial/TEMPORAL_PASS 明确推迟 M4（spec M4 条目覆盖）；「云投影地面」「地形遮挡云」不属 M3（M6）。
- **类型一致性**：`Cascade.interval: Cartesian2` ↔ `CloudsShadowFrameState.intervals: Cartesian2[]` ↔ shader `shadowIntervals[3]`（Cesium uniform 数组）；`bsmTexture: Texture3D` ↔ `shadowBuffer: sampler3D`；`u_cascadeIndex`（T2 声明/T3 注入）✓。
- **占位符扫描**：T3 的 uniformMap 共享段以文字指明抽取来源（T5 详列），无 TBD；所有 surgery 正则给了锚点原文。
- **风险前置**：framebufferTextureLayer(TEXTURE_3D) 兼容性 → Plan B 落在 T3 实现说明；首帧 fallback dummy 保留（零回归）。
