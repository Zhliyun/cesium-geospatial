# 体积云 M4 temporal resolve 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 three-geospatial 的 temporal resolve（云 color 端 `cloudsResolve.frag` Bayer 4×4 upscale + variance clipping + velocity reprojection + history ping-pong；BSM 端 `shadowResolve.frag` 同款）移植进 Cesium 管线，march 降到 1/4 分辨率、resolve 重建全分。

**Architecture:** 云端：march（1/4 分 MRT）→ **第二个 VolumetricPrimitive（pass=VOXELS，add 在 march 之后）** 跑 `cloudsResolve.frag` 写自建全分 resolve RT（与 history RT 每帧 preRender swap）→ overlay 读 resolve 输出。BSM 端：生成端 FBO 双 attach（BSM 层 + velocity 层塞进同一张 depth=2N 的 Texture3D），`shadowResolve.frag` 逐 cascade 手动 execute 写 resolve Texture3D ping-pong。jitter/reprojection 矩阵在 preRender 用 TS 算好经 uniformMap 注入（Bayer 相位与 `params.frame` 同帧递增，march/BSM/resolve 三端共享）。

**Tech Stack:** TypeScript + Cesium（VolumetricPrimitive/Texture/Texture3D/Framebuffer/裸 WebGL2 FBO）+ Vitest + glslangValidator（编译校验）。GLSL 资产层（`glsl/*.glsl`）M1 已搬齐且与 three 版逐字一致——**不动**。

**Spec:** `docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md` §6 M4（验收：云边缘干净无 banding；动态相机拖影可接受；1/4 分静态收敛近全分）。r1 注记：云 temporal 走 `cloudsResolve.frag` 方差裁剪，**不复用**本项目 depthTemporal/historyBlit（那是 NEAREST+EMA 的 depth 专用）；云场演化区 temporal 糊为已知限制。

## Global Constraints

- **不碰 GLSL 资产层**：`packages/cesium-clouds/src/glsl/*.glsl` 一字不改；所有适配（sampler3D 手术、varying 桥接、宏替换）在组装器（`*Material.ts`）的字符串 surgery 层做。
- **three-geospatial 为主参考**：uniform 名、默认值（varianceGamma=2/temporalAlpha=0.1 云端、1/0.01 BSM 端）、Bayer 表、ping-pong 语义逐字对齐 three 版；Cesium 差异处（ECEF 直采、multi-frustum、无 postprocessing 库）在代码注释声明。
- **零回归**：`clouds=false` 不创建任何对象；`cloudsTemporal=0`（URL）时云 color 链行为与 M3 完全一致（全分 march、无 resolve、overlay 直读 march att0）；`cloudsShadowTemporal=0` 时 BSM 链与 M3 完全一致（单 attach、无 velocity 层、无 resolve）。三者均为诊断基线。
- 全部代码注释、commit message、文档用**中文**；TDD（先写失败测试）；每任务一 commit。
- 复用既有基建：`resolveCloudsIncludes`（include + unrollLoops）、`buildSharedCloudsUniforms`、`FullscreenPass`、`createVolumetricPrimitive`、`resolveCloudsHdrDatatype`。不新造平行机制。
- **resize 不处理**（M2 已知限制，沿用）：纹理尺寸取创建时刻 `drawingBufferWidth/Height`，窗口 resize 后需刷新页面。
- `pnpm --filter @cesium-geospatial/clouds test`（clouds 包）与 `pnpm --filter @cesium-geospatial/core test`（T6 改 core 时）必须全绿；`pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit` 0 error。

---

## 背景与设计决策（implementer 必读）

### three 版机制速览（`packages/clouds/src/`，主参考）

```
CloudsEffect.update()（每帧）:
  ++frame → shadowPass.update(renderer, frame) → cloudsPass.update(renderer, frame)

CloudsPass.update():
  frame uniform 同步（march + resolve 同帧）
  copyCameraSettings: temporalUpscale 时
    temporalJitter = bayerOffsets[frame%16] → dx=(offset.x-0.5)/lowResW（低分 UV 单位）
    inverseProjection 塞 jitter（elements[8]+=dx*2, [9]+=dy*2 —— NDC 平移项，×2 因 NDC 域 [-1,1]）
  currentPass.render → 1/4 分 MRT（color + depthVelocity [+ shadowLength]，HalfFloat）
  resolvePass.render → 全分（读 current 1/4 分 + history 全分 → 写 resolve）
  copyReprojection()（存本帧 P/V 供下帧 velocity）
  swapBuffers()（resolve ↔ history）

cloudsResolve.frag TEMPORAL_UPSCALE:
  lowResCoord = coord / 4；bayerIndices[x%4][y%4] == frame%16 的 texel 直通 current
  其余 texel: getClosestFragment(3×3 最近 depth) → velocity → prevUv=vUv-velocity
  越界 rejection（返 current）；否则 varianceClipping(current 邻域 clip history)

clouds.frag velocity（两分支都在原文里，M2 未消费）:
  hitClouds:   prevClip = reprojectionMatrix * vec4(frontPositionWorld,1)   // world 路径
  scene/ground: prevClip = viewReprojectionMatrix * vec4(vViewPosition*frontDepth,1)  // view 路径（精度好）

ShadowPass.update(): currentPass.render（BSM cascade 层 + velocity 层塞同一 array RT depth=2N）
  → temporalPass 时 resolvePass.render（shadowResolve.frag：逐 cascade 3×3 closest + variance clip + temporalAlpha=0.01 mix）
  → copyReprojection（本帧 cascade.matrix 存为下帧 reprojectionMatrices）→ swap
shadow.frag velocity: (vUv - prevUv) * resolution（texel 单位）；shadowResolve 端 * texelSize 转回 UV
```

### 本项目设计决策

- **D1 云 resolve 执行点**：第二个 `VolumetricPrimitive`（pass=VOXELS，`scene.primitives.add` 在 march primitive 之后）。依据：PrimitiveCollection 数组序 → update 顺序 → 同 pass commandList push 顺序 = 执行顺序（march 先、resolve 后，GL 串行无 hazard）。PostProcessStage 写不了自建 RT（history ping-pong 需要）、preRender 时机在 march 前（读不到本帧 march 输出），均不可行。
- **D2 云 history ping-pong**：2 张全分 `Texture`（LINEAR）+ 各挂一个 Cesium `Framebuffer`（FBO 的 attachment 固定，swap 靠换 FBO/纹理引用）。**swap 在 preRender 开头**（等价 three 的 render 后 swap：swap 后 historyRef=上帧输出、resolveRef=待写；渲染中 resolve 写 resolveRef，overlay 的 `u_cloudsBuffer` 闭包在 PostProcess 阶段取值 = 本帧输出）。
- **D3 march 1/4 分**（temporal 开启时）：MRT 尺寸 `ceil(w/4)×ceil(h/4)`；`resolution` uniform = lowRes*4（4 对齐的"全分等效"——three 语义）；`targetUvScale` = (lowRes*4/w, lowRes*4/h)（低分 UV → 全分 depth 纹理子区域，`ceil` 后 *4 可能 > 全分，故 <1）；`mipLevelScale` = 0.25；**march FBO 必须 viewport=低分尺寸**（Cesium RenderState 不设 viewport 时保持 GL 当前 viewport=drawingBuffer，低分 FBO 下写越界）。temporal 关闭时全部维持 M2 现状。
- **D4 jitter 注入**：TS 侧 `temporalMath.ts`（bayer 表 + jitter + reprojection 矩阵）。本项目 ray 重建不走 inverseProjection（走 `czm_windowToEyeCoordinates` 差分），jitter 以 **`gl_FragCoord.xy + temporalJitter * resolution`**（像素偏移）注入——与 depth 采样 UV（原文 `vUv * targetUvScale + temporalJitter`）、噪声种子（原文 `interleavedGradientNoise(gl_FragCoord.xy + temporalJitter * resolution)`）三处原文语义对齐。量纲：temporalJitter 是低分 UV 分数（±0.5 低分 texel），*resolution（=lowRes*4）→ ±2 全分像素 = ±0.5 低分 texel ✓。
- **D5 velocity 对 Cesium multi-frustum 的稳健性**：velocity 数学只用投影矩阵 **xy 系数与 w**（透视投影 xy 只依赖 fovy/aspect，w=-z_view，均与 near/far 分段无关；log-depth 是 shader 侧编码不改矩阵）→ preRender 时刻取完整视锥 `camera.frustum.projectionMatrix` 与 `camera.viewMatrix` 做 prev 矩阵即正确。`worldToECEFMatrix=identity`（本项目 ECEF 直采）→ `reprojectionMatrix = jitteredPrevP * prevV` 直接作用 ECEF 坐标（float32 相对误差 ~0.8m，velocity UV 误差 ~1e-6 量级，无害）；`vViewPosition` 保持 normalize（与 three 未归一化版共线，投影 w 除法抵消标量差）。首帧 prev 缺失时 fallback 当前帧矩阵（velocity=0，three 同款）。
- **D6 BSM temporal**：`bsmTexture` depth = `cascadeCount*2`（前 N 层 BSM、后 N 层 velocity，rgba = (frontDepth, velocity.xy, _)）；生成端裸 FBO 双 attach（`glFramebufferTextureLayer` att0=层 i、att1=层 N+i，`glDrawBuffers` 创建时设一次）；`reprojectionMatrices[i]` = **上帧** `cascades[i].matrix`（render 前取 prev，render 后存本帧）；resolve = `shadowResolve.frag` 组装版逐 cascade 手动 execute（FullscreenPass + 裸 FBO attach resolve Texture3D 层 i），resolve(A/B) ping-pong，消费端 `state.shadow.bsm` = swap 后的 history。velocity texel 单位（`*resolution` = mapSize）与 resolve 端 `*texelSize` 对称。
- **D7 frame 递增与拆分绑定**：`params.frame` 单一计数，preRender 开头 `if (temporal || shadowTemporal) params.frame++`。**但 march 与 BSM 生成端的 `frame` uniform 各自按其 temporal 开关绑定**（开 → `() => params.frame`，关 → `() => 0`）：frame 是共享 uniform（`buildSharedCloudsUniforms`），若单端关 temporal 而计数仍递增，该端 stbn jitter 相位每帧变却没有 temporal resolve 平滑 → 回归 M3 之前的逐帧闪烁（M3 行为 = frame 静态 0）。具体：`createCloudsPass` 的 uniformMap 在共享段之后覆写 `frame: () => temporal ? params.frame : 0`；`createCloudsStage` 组 `shadowUniformMap` 时同样覆写。resolve 的 frame 闭包读 `params.frame`（resolvePass 只在 temporal 时存在）。
- **D8 诊断开关**：`createCloudsStage` options 加 `temporal`（默认 true）/`shadowTemporal`（默认 true）；demo URL `?cloudsTemporal=0` / `?cloudsShadowTemporal=0`。
- **D9 组装器手术要点**（详见各任务）：
  - cloudsResolve：`in vec2 vUv;` → `in vec2 v_textureCoordinates;` + `#define vUv v_textureCoordinates`；删 `uniform vec2 jitterOffset;`（声明了但 frag 未消费）；define `TEMPORAL_UPSCALE`（**不** define `SHADOW_LENGTH`——M5）；不 define 两个 VARIANCE 宏（走默认 sampler2D/ivec2 分支）。
  - shadowResolve：L4-5 `#define VARIANCE_9_SAMPLES 1` + `#define VARIANCE_SAMPLER_ARRAY 1` → `#define VARIANCE_SAMPLER sampler3D` + `#define VARIANCE_SAMPLER_COORD ivec3`（varianceClipping 的宏体系支持自定义组合）；`uniform sampler2DArray` → `uniform sampler3D`；`texture(historyBuffer, vec3(prevUv, float(cascadeIndex)))` 的 z 归一化 `(float(cascadeIndex)+0.5)/float(CASCADE_COUNT)`；MRT out 数组 → 单 out；main unroll → `u_cascadeIndex` 单 cascade。
  - ShadowMaterial（生成端）加回 TEMPORAL_PASS：`reprojectionMatrices[CASCADE_COUNT]` uniform 恢复（M3 surgery 4 改为条件跳过）；out 数组声明块 → `layout(location = 1) out vec3 outputDepthVelocity;`；cascade() 签名恢复 velocity 出参；TEMPORAL_PASS 段恢复；main 调用带 velocity 出参。`resolution` uniform 已在 parameters.glsl 声明（M3 就编译着，只是未消费），M4 绑 `(mapSize, mapSize)` 即可。
- **D10 `resolution` uniform 的 dual 语义**：march 端 = lowRes*4（temporal）/ drawingBuffer（非 temporal）；BSM 生成端 = (mapSize, mapSize)；cloudsResolve 不用 resolution（用 texelSize）。

### 文件结构（M4 后 clouds 包新增/修改）

```
packages/cesium-clouds/src/
  temporalMath.ts                  [新] bayer 表 + jitter + reprojection 矩阵（纯 TS，node 可测）
  CloudsResolveMaterial.ts         [新] cloudsResolve.frag 组装器（surgery + defines + 双入口）
  ShadowResolveMaterial.ts         [新] shadowResolve.frag 组装器（sampler3D 手术 + 双入口）
  CloudsResolvePass.ts             [新] 云 resolve primitive + ping-pong FBO + uniformMap
  CloudsMaterial.ts                [改] surgery：ray 重建加 jitter（T6）
  CloudsPass.ts                    [改] 低分模式 + viewport + 暴露 depthVelTexture（T6）
  ShadowMaterial.ts                [改] TEMPORAL_PASS 条件加回（T3）
  ShadowPass.ts                    [改] velocity 层双 attach + resolve + ping-pong（T5）
  cloudsDefaultParameters.ts       [改] temporal 参数组（T7）
  createCloudsStage.ts             [改] 编排：frame/jitter/reprojection/swap/URL 开关（T7）
  temporalMath.test.ts / cloudsResolve.compile.test.ts / shadowResolve.compile.test.ts
  CloudsResolvePass.test.ts / ShadowPass.test.ts / CloudsPass.test.ts / createCloudsStage.test.ts  [改/新]
packages/cesium-core/src/cesium/platform/VolumetricPrimitive.ts  [改] viewport 选项（T6）
apps/demo/src/main.ts             [改] URL 参数（T8）
```

---

### Task 1: temporalMath.ts——bayer 表 + jitter + reprojection 矩阵

**Files:**
- Create: `packages/cesium-clouds/src/temporalMath.ts`
- Test: `packages/cesium-clouds/src/temporalMath.test.ts`

**Interfaces:**
- Consumes: `cesium` 的 `Cartesian2/Matrix4`（纯数学，无 WebGL 依赖）。
- Produces（后续任务依赖的精确签名）:
  - `bayerIndices: readonly number[]`（16 项）
  - `bayerOffsets: readonly Cartesian2[]`（16 项，单位 [0,1] texel 中心）
  - `computeTemporalJitter(frame: number, lowResWidth: number, lowResHeight: number, result: Cartesian2): Cartesian2`
  - `interface TemporalCameraSnapshot { viewMatrix: Matrix4; projectionMatrix: Matrix4 }`
  - `buildReprojectionMatrices(previous: TemporalCameraSnapshot | undefined, currentViewMatrix: Matrix4, currentProjectionMatrix: Matrix4, currentInverseViewMatrix: Matrix4, jitter: Cartesian2, result: { reprojectionMatrix: Matrix4; viewReprojectionMatrix: Matrix4 }): void`

- [ ] **Step 1: 写失败测试**

```ts
// temporalMath.test.ts
//
// M4 T1：temporal 数学单测——bayer 表逐字对齐 three bayer.ts；jitter 量纲（低分 UV）；
// reprojection 矩阵三性质（jitter 进 prevP 的 column2.xy、首帧 fallback 当前、
// viewReprojection = (jitteredPrevP*prevV)*inverseView）。

import { describe, expect, it } from 'vitest'
import { Cartesian2, Matrix4 } from 'cesium'

import {
  bayerIndices,
  bayerOffsets,
  computeTemporalJitter,
  buildReprojectionMatrices,
  type TemporalCameraSnapshot
} from './temporalMath'

describe('M4 T1 temporalMath', () => {
  it('bayerIndices 逐字对齐 three bayer.ts（4×4 序列）', () => {
    expect(bayerIndices).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5])
  })

  it('bayerOffsets：index i 的 offset = 值为 i 的格中心（three 同款反查）', () => {
    expect(bayerOffsets).toHaveLength(16)
    // bayerIndices[5] = 4 → offset[4] 在格 (5%4, floor(5/4)) = (1,1) 中心 → (0.375+0.125? 不：
    // ((i%4)+0.5)/4 = (1.5)/4 = 0.375, (floor(5/4)+0.5)/4 = 1.5/4 = 0.375
    expect(bayerOffsets[4].x).toBeCloseTo(0.375)
    expect(bayerOffsets[4].y).toBeCloseTo(0.375)
    // bayerIndices[0] = 0 → 格 (0,0) 中心 (0.125, 0.125)
    expect(bayerOffsets[0].x).toBeCloseTo(0.125)
    expect(bayerOffsets[0].y).toBeCloseTo(0.125)
  })

  it('computeTemporalJitter：frame 0 低分 480×270 → ±半低分 texel（three CloudsMaterial:342-344 等价）', () => {
    const j = computeTemporalJitter(0, 480, 270, new Cartesian2())
    // offset[0]=(0.125,0.125) → dx=(0.125-0.5)/480
    expect(j.x).toBeCloseTo(-0.375 / 480)
    expect(j.y).toBeCloseTo(-0.375 / 270)
  })

  it('buildReprojectionMatrices：jitter 写入 prevP column2.xy（×2，NDC 域 [-1,1]）且 viewReprojection 链式正确', () => {
    const prevV = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationZ(0.3),
      new Cartesian3(100, 200, 300)
    )
    const prevP = new PerspectiveFrustumP(0.5, 1.5, 10, 1e6).projectionMatrix // 见下方 helper
    const prev: TemporalCameraSnapshot = { viewMatrix: prevV, projectionMatrix: prevP }

    const curV = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationZ(0.31),
      new Cartesian3(110, 205, 299)
    )
    const curInvV = Matrix4.inverse(curV, new Matrix4())
    const curP = prevP.clone()

    const jitter = new Cartesian2(0.001, -0.002)
    const reprojectionMatrix = new Matrix4()
    const viewReprojectionMatrix = new Matrix4()
    buildReprojectionMatrices(prev, curV, curP, curInvV, jitter, {
      reprojectionMatrix,
      viewReprojectionMatrix
    })

    // 性质 1：reprojection = (prevP + jitter) * prevV —— 用列分量验证 jitter 已进 column2
    const expected = prevP.clone()
    const col = Matrix4.getColumn(expected, 2, new Cartesian4())
    col.x += jitter.x * 2
    col.y += jitter.y * 2
    Matrix4.setColumn(expected, 2, col, expected)
    Matrix4.multiply(expected, prevV, expected)
    expect(reprojectionMatrix).toEqual(expected)

    // 性质 2：viewReprojection = reprojection * currentInverseView
    const expected2 = Matrix4.multiply(
      reprojectionMatrix,
      curInvV,
      new Matrix4()
    )
    expect(viewReprojectionMatrix).toEqual(expected2)
  })

  it('buildReprojectionMatrices：首帧 previous=undefined → fallback 当前 P/V（velocity=0，three 同款）', () => {
    const curV = Matrix4.fromRotationTranslation(
      Matrix3.IDENTITY,
      new Cartesian3(0, 0, 0)
    )
    const curInvV = Matrix4.inverse(curV, new Matrix4())
    const curP = new PerspectiveFrustumP(0.5, 1.5, 10, 1e6).projectionMatrix
    const jitter = new Cartesian2(0.01, 0.01)
    const reprojectionMatrix = new Matrix4()
    const viewReprojectionMatrix = new Matrix4()
    buildReprojectionMatrices(undefined, curV, curP, curInvV, jitter, {
      reprojectionMatrix,
      viewReprojectionMatrix
    })
    // jittered curP * curV
    const expected = curP.clone()
    const col = Matrix4.getColumn(expected, 2, new Cartesian4())
    col.x += jitter.x * 2
    col.y += jitter.y * 2
    Matrix4.setColumn(expected, 2, col, expected)
    Matrix4.multiply(expected, curV, expected)
    expect(reprojectionMatrix).toEqual(expected)
  })
})

// 测试 helper：透视投影矩阵（near/far 域，标准列主序）——避免依赖 Cesium PerspectiveFrustum
// （它有额外 getter 行为）。列主序：col0=(f/aspect,0,0,0) col1=(0,f,0,0) col2=(0,0,(far+near)/(near-far),-1) col3=(0,0,2*far*near/(near-far),0)
import { Cartesian3, Cartesian4, Matrix3 } from 'cesium'
class PerspectiveFrustumP {
  private m: Matrix4
  constructor(fovY: number, aspect: number, near: number, far: number) {
    const f = 1 / Math.tan(fovY / 2)
    this.m = new Matrix4(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0
    )
  }
  get projectionMatrix(): Matrix4 {
    return this.m
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/temporalMath.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 temporalMath.ts**

```ts
// temporalMath.ts
//
// M4 T1：temporal resolve 的 TS 侧数学——Bayer 4×4 相位表 + jitter 计算 + reprojection 矩阵。
// 逐字对齐 three-geospatial/packages/clouds/src/bayer.ts 与 CloudsMaterial.ts:337-368
// （copyCameraSettings 的 temporalUpscale 分支），供 createCloudsStage preRender 每帧调用。
//
// 量纲约定（three 同款）：
//   - bayerOffsets 单位 [0,1]（4×4 格中心，(i%4+0.5)/4）
//   - temporalJitter 单位 = 低分 UV（(offset-0.5)/lowRes）——three 原式
//     dx = ((offset.x-0.5)/resolution.x)*4，resolution=lowRes*4 → 化简 (offset.x-0.5)/lowResW
//   - jitter 进投影矩阵：column2.xy += jitter*2（column-major 下 col2.x/y 即 three
//     elements[8]/[9]——NDC 平移项 x_w 系数；×2 因 NDC 域 [-1,1] 而 jitter 是 UV 域）

import { Cartesian2, Cartesian4, Matrix4 } from 'cesium'

// prettier-ignore
export const bayerIndices: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5
]

/** 帧 i（%16）的 Bayer 采样偏移（4×4 格中心，单位 [0,1]）。three bayer.ts 同款反查构造。 */
export const bayerOffsets: readonly Cartesian2[] = bayerIndices.reduce<Cartesian2[]>(
  (result, _, index) => {
    const offset = new Cartesian2()
    for (let i = 0; i < 16; ++i) {
      if (bayerIndices[i] === index) {
        offset.set(((i % 4) + 0.5) / 4, (Math.floor(i / 4) + 0.5) / 4)
        break
      }
    }
    result.push(offset)
    return result
  },
  []
)

/**
 * 计算本帧 march jitter（低分 UV 单位，写入 params.temporalJitter → shader 三处消费：
 * ray 重建 gl_FragCoord 偏移 / depth 采样 UV / 噪声种子）。
 */
export function computeTemporalJitter(
  frame: number,
  lowResWidth: number,
  lowResHeight: number,
  result: Cartesian2
): Cartesian2 {
  const offset = bayerOffsets[frame % 16]
  result.x = (offset.x - 0.5) / lowResWidth
  result.y = (offset.y - 0.5) / lowResHeight
  return result
}

/** 上帧相机快照（preRender 存，下帧算 velocity 用）。 */
export interface TemporalCameraSnapshot {
  viewMatrix: Matrix4
  projectionMatrix: Matrix4
}

const columnScratch = new Cartesian4()

/**
 * 组装 reprojection 矩阵（clouds.frag velocity 两分支消费）：
 *
 *   reprojectionMatrix    = (prevP + jitter) * prevV      ← hitClouds 分支（world/ECEF 路径）
 *   viewReprojectionMatrix = reprojectionMatrix * invCurV ← scene/ground 分支（view 路径，精度好）
 *
 * jitter 写入 prevP column2.xy（×2：NDC 域）；首帧 previous=undefined 时 fallback 当前 P/V
 * （velocity=0，three CloudsMaterial previousProjectionMatrix ?? camera.projectionMatrix 同款）。
 *
 * Cesium 适配（D5）：矩阵域是 ECEF 世界坐标（worldToECEF=identity，viewMatrix 即相机 ECEF→view）；
 * preRender 时刻 frustum.projectionMatrix 为完整视锥（multi-frustum 分段前）；velocity 数学只用
 * 投影 xy 系数与 w，与 near/far 分段无关 → 分段执行下依然正确。
 */
export function buildReprojectionMatrices(
  previous: TemporalCameraSnapshot | undefined,
  currentViewMatrix: Matrix4,
  currentProjectionMatrix: Matrix4,
  currentInverseViewMatrix: Matrix4,
  jitter: Cartesian2,
  result: { reprojectionMatrix: Matrix4; viewReprojectionMatrix: Matrix4 }
): void {
  const prevP = previous?.projectionMatrix ?? currentProjectionMatrix
  const prevV = previous?.viewMatrix ?? currentViewMatrix

  // jitteredPrevP：clone 后改 column2
  Matrix4.clone(prevP, result.reprojectionMatrix)
  const col = Matrix4.getColumn(result.reprojectionMatrix, 2, columnScratch)
  col.x += jitter.x * 2
  col.y += jitter.y * 2
  Matrix4.setColumn(result.reprojectionMatrix, 2, col, result.reprojectionMatrix)

  // reprojectionMatrix = jitteredPrevP * prevV
  Matrix4.multiply(result.reprojectionMatrix, prevV, result.reprojectionMatrix)
  // viewReprojectionMatrix = reprojectionMatrix * currentInverseView
  Matrix4.multiply(
    result.reprojectionMatrix,
    currentInverseViewMatrix,
    result.viewReprojectionMatrix
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/temporalMath.test.ts
```
预期：PASS（4 用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/temporalMath.ts packages/cesium-clouds/src/temporalMath.test.ts
git commit -m "feat(clouds): M4 T1 temporalMath——Bayer 4×4 表 + jitter 计算 + reprojection 矩阵（three bayer.ts/CloudsMaterial 逐字对齐）"
```

---

### Task 2: CloudsResolveMaterial.ts——cloudsResolve.frag 组装器

**Files:**
- Create: `packages/cesium-clouds/src/CloudsResolveMaterial.ts`
- Test: `packages/cesium-clouds/src/cloudsResolve.compile.test.ts`

**Interfaces:**
- Consumes: `glslIndex`（`glslIndex.cloudsResolveFrag`）、`resolveCloudsIncludes`（include + unrollLoops）。
- Produces:
  - `interface CloudsResolveOptions { temporalUpscale?: boolean }`（默认 true；false 走 `temporalAntialiasing` 同分 TAA 分支——编译分支保留，M4 只用 true）
  - `buildCloudsResolveFragmentShader(options?: CloudsResolveOptions): string`（Cesium 运行时）
  - `buildStandaloneCloudsResolveShaderForValidation(options?: CloudsResolveOptions): string`（glslang 校验）
  - 云 resolve shader 的 uniform 清单（T4 uniformMap 依据）：`colorBuffer`/`depthVelocityBuffer`/`colorHistoryBuffer`（sampler2D）、`texelSize`（vec2）、`frame`（int）、`varianceGamma`（float，默认 2）、`temporalAlpha`（float，默认 0.1）。

- [ ] **Step 1: 写失败测试**

```ts
// cloudsResolve.compile.test.ts
//
// M4 T2：cloudsResolve.frag surgery 组装验证 + glslang 真编译。
// 对齐 shadowMain.compile.test.ts 范式（compileFragment helper + 防哑过用例）。

import { describe, expect, it } from 'vitest'

import {
  buildCloudsResolveFragmentShader,
  buildStandaloneCloudsResolveShaderForValidation,
  type CloudsResolveOptions
} from './CloudsResolveMaterial'
import { compileFragment } from './glslangUtil'

const OPTS: CloudsResolveOptions = {}

function compileOrFail(src: string, label: string): void {
  const { ok, output } = compileFragment(src)
  if (!ok) {
    throw new Error(
      `glslangValidator 编译失败（${label}）:\n${output}\n` +
        `---- shader 前 60 行（1-based）----\n${src
          .split('\n')
          .slice(0, 60)
          .map((l, i) => `${i + 1}: ${l}`)
          .join('\n')}`
    )
  }
  expect(ok).toBe(true)
}

describe('M4 T2 cloudsResolve.frag surgery 断言', () => {
  it('vUv → v_textureCoordinates 桥接（Cesium ViewportQuadVS）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).toContain('in vec2 v_textureCoordinates;')
    expect(src).toContain('#define vUv v_textureCoordinates')
    expect(src).not.toMatch(/in vec2 vUv;/)
  })

  it('删 jitterOffset（frag 声明未消费——组装层清掉，免绑空 uniform）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).not.toContain('jitterOffset')
  })

  it('defines：TEMPORAL_UPSCALE 开；SHADOW_LENGTH 关（M5 接 god rays 时再开）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).toContain('#define TEMPORAL_UPSCALE')
    expect(src).not.toContain('#define SHADOW_LENGTH')
    // SHADOW_LENGTH 关 → loc1 out 不编译、局部 outputShadowLength 声明存在
    expect(src).not.toMatch(/layout\(location = 1\)/)
  })

  it('temporalUpscale=false：走 temporalAntialiasing 分支（无 TEMPORAL_UPSCALE define）', () => {
    const src = buildCloudsResolveFragmentShader({ temporalUpscale: false })
    expect(src).not.toContain('#define TEMPORAL_UPSCALE')
  })

  it('防哑过：删掉 v_textureCoordinates 声明后 glslang 必须报错（证明编译器真在跑）', () => {
    const broken = buildStandaloneCloudsResolveShaderForValidation(OPTS).replace(
      'in vec2 v_textureCoordinates;',
      ''
    )
    const { ok } = compileFragment(broken)
    expect(ok).toBe(false)
  })

  it('glslang 真编译：runtime 双分支均过（含 include 展开 + unrollLoops）', () => {
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: true }),
      'temporalUpscale=true'
    )
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: false }),
      'temporalUpscale=false'
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsResolve.compile.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 CloudsResolveMaterial.ts**

```ts
// CloudsResolveMaterial.ts
//
// M4 T2：three cloudsResolve.frag（temporal upscale resolve）→ Cesium fragment 组装器。
//
// cloudsResolve.frag 是 three.js 全分 resolve fragment：TEMPORAL_UPSCALE 分支（1/4 分 march →
// Bayer 4×4 全分重建：1/16 texel 直通 current，其余 velocity reprojection + variance clipping）
// 或 temporalAntialiasing 分支（同分 TAA）。本项目 M4 用 upscale 分支（D3 march 1/4 分）。
//
// 手术（不动 glsl/cloudsResolve.frag 原文，保持 three 版形态便于上游 diff）：
//   1. `in vec2 vUv;` → `in vec2 v_textureCoordinates;` + `#define vUv v_textureCoordinates`
//      （Cesium ViewportQuadVS 只输出 v_textureCoordinates——同 ShadowMaterial.ts 手法）
//   2. 删 `uniform vec2 jitterOffset;`（three 原文声明但 frag 未消费；删掉免绑空 uniform）
//
// 非 surgery：`#include "core/turbo" / "catmullRomSampling" / "varianceClipping"` 经
// resolveCloudsIncludes 内联（glslIndex 已注册）；`#pragma unroll_loop_*` 由其内 unrollLoops 展开。
// precision：cloudsResolve.frag 头部自带 highp float/sampler2DArray。
// uniform 清单（T4 uniformMap 依据）：colorBuffer/depthVelocityBuffer/colorHistoryBuffer
// (sampler2D) + texelSize(vec2) + frame(int) + varianceGamma(float=2) + temporalAlpha(float=0.1)。
//
// 双入口（仿 CloudsMaterial.ts）：运行时无 #version（Cesium ShaderProgram 注入）；
// 校验入口补 #version 300 es + precision（sampler2DArray 覆盖 include 链）。

import { glslIndex } from './glslIndex'
import { resolveCloudsIncludes } from './resolveCloudsIncludes'

// M4 T2 桥接选项。
export interface CloudsResolveOptions {
  /**
   * TEMPORAL_UPSCALE 编译分支开关（默认 true）：1/4 分 march → Bayer 4×4 全分重建。
   * false 走 temporalAntialiasing（同分 TAA）分支——M4 不用，编译分支保留对齐 three。
   */
  temporalUpscale?: boolean
}

type ResolvedCloudsResolveOptions = Required<CloudsResolveOptions>

const DEFAULTS: ResolvedCloudsResolveOptions = {
  temporalUpscale: true
}

// 文本手术：vUv 桥接 + 删 jitterOffset。锚点唯一性：`in vec2 vUv;` 一处、
// `uniform vec2 jitterOffset;` 一处（grep 验证 cloudsResolve.frag L23/L21）。
function surgeryCloudsResolveFrag(source: string): string {
  let src = source
  // 1) varying 桥接（注释放声明上一行，保证精确串存在——防哑过用例依赖）
  src = src.replace(
    /in vec2 vUv;\n/,
    '// Cesium ViewportQuadVS 注入 v_textureCoordinates\n' +
      'in vec2 v_textureCoordinates;\n' +
      '#define vUv v_textureCoordinates\n'
  )
  // 2) 删 jitterOffset（three 声明未消费）
  src = src.replace(/uniform vec2 jitterOffset;\n/, '')
  return src
}

/**
 * 组装 Cesium 运行时云 resolve fragment shader（three cloudsResolve.frag → Cesium 桥接）。
 *
 * 结构：defines + surgery 后 cloudsResolve.frag（#include 内联 + unrollLoops 由
 * resolveCloudsIncludes 处理）。不写 #version——由 Cesium ShaderProgram 注入。
 */
export function buildCloudsResolveFragmentShader(
  options: CloudsResolveOptions = {}
): string {
  const o: ResolvedCloudsResolveOptions = { ...DEFAULTS, ...options }
  const defines = [
    o.temporalUpscale ? '#define TEMPORAL_UPSCALE' : ''
  ]
    .filter((s) => s.length > 0)
    .join('\n')
  const merged = [defines, surgeryCloudsResolveFrag(glslIndex.cloudsResolveFrag)].join('\n\n')
  return resolveCloudsIncludes(merged)
}

/**
 * glslang 校验入口：补 #version 300 es + precision。
 *
 * cloudsResolve.frag 不引用 czm_*（纯纹理进纹理出），无需 CZM_STUBS。precision 覆盖
 * include 链 sampler 类型（sampler2D/sampler2DArray）。
 */
export function buildStandaloneCloudsResolveShaderForValidation(
  options: CloudsResolveOptions = {}
): string {
  const runtime = buildCloudsResolveFragmentShader(options)
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp sampler2DArray;',
    runtime
  ].join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsResolve.compile.test.ts
```
预期：PASS（6 用例）。若 glslang 报 `texelFetchOffset`/`textureOffset` 相关错，检查 unrollLoops 是否展开（resolveCloudsIncludes 内已含；`#pragma unroll_loop_start` 必须在 include 内联后消失）。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/CloudsResolveMaterial.ts packages/cesium-clouds/src/cloudsResolve.compile.test.ts
git commit -m "feat(clouds): M4 T2 CloudsResolveMaterial——cloudsResolve.frag 组装器（vUv 桥接 + 删 jitterOffset + TEMPORAL_UPSCALE 双分支）"
```

---

### Task 3: ShadowMaterial TEMPORAL_PASS 加回 + ShadowResolveMaterial.ts

**Files:**
- Modify: `packages/cesium-clouds/src/ShadowMaterial.ts`（surgery 条件化：temporalPass=true 时保留 velocity 相关段并单 cascade 化）
- Create: `packages/cesium-clouds/src/ShadowResolveMaterial.ts`
- Test: `packages/cesium-clouds/src/shadowResolve.compile.test.ts`

**Interfaces:**
- Consumes: `glslIndex.shadowResolveFrag`、`resolveCloudsIncludes`；现有 `ShadowMainOptions`。
- Produces:
  - `ShadowMainOptions` 增加 `temporalPass?: boolean`（默认 true；false = M3 行为：无 velocity out、无 reprojectionMatrices）。
  - `buildCloudsShadowFragmentShader(options)` 行为变化：temporalPass=true 时输出含 `layout(location = 1) out vec3 outputDepthVelocity;`、`uniform mat4 reprojectionMatrices[CASCADE_COUNT];`、velocity 段用 `u_cascadeIndex`。
  - `interface ShadowResolveOptions { cascadeCount?: number }`（默认 3）
  - `buildShadowResolveFragmentShader(options?: ShadowResolveOptions): string`
  - `buildStandaloneShadowResolveShaderForValidation(options?: ShadowResolveOptions): string`
  - shadowResolve shader uniform 清单（T5 uniformMap 依据）：`inputBuffer`/`historyBuffer`（**sampler3D**）、`texelSize`（vec2，=1/mapSize）、`varianceGamma`（float=1）、`temporalAlpha`（float=0.01）、`u_cascadeIndex`（int，ShadowPass 注入）。

- [ ] **Step 1: 写失败测试**

```ts
// shadowResolve.compile.test.ts
//
// M4 T3：ShadowMaterial TEMPORAL_PASS 加回（单 cascade 化）+ shadowResolve.frag sampler3D
// 手术验证 + glslang 真编译。

import { describe, expect, it } from 'vitest'

import {
  buildCloudsShadowFragmentShader,
  buildStandaloneCloudsShadowShaderForValidation
} from './ShadowMaterial'
import {
  buildShadowResolveFragmentShader,
  buildStandaloneShadowResolveShaderForValidation
} from './ShadowResolveMaterial'
import { compileFragment } from './glslangUtil'

function compileOrFail(src: string, label: string): void {
  const { ok, output } = compileFragment(src)
  if (!ok) {
    throw new Error(
      `glslangValidator 编译失败（${label}）:\n${output}\n` +
        `---- shader 前 60 行（1-based）----\n${src
          .split('\n')
          .slice(0, 60)
          .map((l, i) => `${i + 1}: ${l}`)
          .join('\n')}`
    )
  }
  expect(ok).toBe(true)
}

describe('M4 T3 ShadowMaterial TEMPORAL_PASS 加回', () => {
  it('temporalPass=true：velocity 单 out + reprojectionMatrices uniform + velocity 段（单 cascade 化）', () => {
    const src = buildCloudsShadowFragmentShader({ temporalPass: true })
    expect(src).toContain('layout(location = 1) out vec3 outputDepthVelocity;')
    expect(src).toContain('uniform mat4 reprojectionMatrices[CASCADE_COUNT];')
    // velocity 段经 surgery 单 cascade 化：cascade() 内用 u_cascadeIndex 索引
    expect(src).toMatch(/reprojectionMatrices\[u_cascadeIndex\]/)
    expect(src).toContain('#define TEMPORAL_PASS')
    // main 调用带 velocity 出参
    expect(src).toMatch(
      /cascade\(u_cascadeIndex, mipLevels\[u_cascadeIndex\], outputColor, outputDepthVelocity\)/
    )
  })

  it('temporalPass=false：与 M3 完全一致（零回归基线）', () => {
    const src = buildCloudsShadowFragmentShader({ temporalPass: false })
    expect(src).not.toContain('outputDepthVelocity')
    expect(src).not.toContain('reprojectionMatrices')
    expect(src).not.toContain('TEMPORAL_PASS')
    expect(src).toMatch(
      /cascade\(u_cascadeIndex, mipLevels\[u_cascadeIndex\], outputColor\)/
    )
  })

  it('glslang：生成端双档真编译', () => {
    compileOrFail(
      buildStandaloneCloudsShadowShaderForValidation({ temporalPass: true }),
      '生成端 temporalPass=true'
    )
    compileOrFail(
      buildStandaloneCloudsShadowShaderForValidation({ temporalPass: false }),
      '生成端 temporalPass=false'
    )
  })
})

describe('M4 T3 ShadowResolveMaterial sampler3D 手术', () => {
  it('sampler2DArray → sampler3D + varianceClipping 宏重定向（sampler3D/ivec3）', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).toContain('uniform sampler3D inputBuffer;')
    expect(src).toContain('uniform sampler3D historyBuffer;')
    expect(src).not.toMatch(/sampler2DArray/)
    // 宏手术：不再 define VARIANCE_SAMPLER_ARRAY，改为直接指定 sampler3D
    expect(src).toContain('#define VARIANCE_SAMPLER sampler3D')
    expect(src).toContain('#define VARIANCE_SAMPLER_COORD ivec3')
    expect(src).not.toContain('VARIANCE_SAMPLER_ARRAY')
  })

  it('history 采样 z 归一化（sampler3D z∈[0,1] 层中心，非 layer 索引）', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).toMatch(
      /texture\(historyBuffer, vec3\(prevUv, \(float\(u_cascadeIndex\) \+ 0\.5\) \/ float\(CASCADE_COUNT\)\)\)/
    )
  })

  it('MRT out 数组 → 单 out + main 单 cascade（u_cascadeIndex）', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).toContain('layout(location = 0) out vec4 outputColor;')
    expect(src).not.toMatch(/out vec4 outputColor\[CASCADE_COUNT\]/)
    expect(src).toContain('uniform int u_cascadeIndex;')
    expect(src).toMatch(/void main\(\)\s*\{\s*cascade\(u_cascadeIndex, outputColor\)/)
  })

  it('防哑过 + glslang 真编译', () => {
    const broken = buildStandaloneShadowResolveShaderForValidation().replace(
      'uniform sampler3D inputBuffer;',
      ''
    )
    const { ok } = compileFragment(broken)
    expect(ok).toBe(false)
    compileOrFail(buildStandaloneShadowResolveShaderForValidation(), 'shadowResolve')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/shadowResolve.compile.test.ts
```
预期：FAIL（temporalPass 选项不存在 / ShadowResolveMaterial 模块不存在）。

- [ ] **Step 3: 改 ShadowMaterial.ts（surgery 条件化）**

对 `ShadowMaterial.ts` 做以下精确修改（其余不动）：

(a) `ShadowMainOptions` 加字段：

```ts
  /**
   * TEMPORAL_PASS 编译分支开关（默认 true，M4）：velocity 输出（MRT loc1）+
   * reprojectionMatrices uniform。false = M3 行为（单 out、无 velocity）——诊断基线。
   */
  temporalPass?: boolean
```

`DEFAULTS` 加 `temporalPass: true`。

(b) `SHADOW_DEFINES_BASE` 中 `'#define TEMPORAL_JITTER'` 保持；`buildDefines` 追加一行：

```ts
    o.temporalPass ? '#define TEMPORAL_PASS' : ''
```

(c) `surgeryShadowFrag(source)` 改签名 `surgeryShadowFrag(source: string, temporalPass: boolean)`，修改 4 处手术：

```ts
  // 3) out 数组声明：temporalPass 时 velocity 单 out 加回（M4）；否则维持 M3 删法
  //    （「Redundant notation for prettier」#if 块一并删除）
  src = src.replace(/\n\/\/ Redundant notation for prettier\.\n#if CASCADE_COUNT == 1\n[\s\S]*?#endif \/\/ CASCADE_COUNT\n/, '\n')
  // 4) reprojectionMatrices uniform：temporalPass 保留（velocity 消费），否则删（M3 行为）
  if (!temporalPass) {
    src = src.replace(/uniform mat4 reprojectionMatrices\[CASCADE_COUNT\];\n/, '')
  }
  // 5) cascade() 签名：temporalPass 保留 velocity 出参（单 cascade 化非数组）
  src = src.replace(
    /  const float mipLevel,\n  out vec4 outputColor,\n  out vec3 outputDepthVelocity\n\) \{/,
    temporalPass
      ? '  const float mipLevel,\n  out vec4 outputColor,\n  out vec3 outputDepthVelocity\n) {'
      : '  const float mipLevel,\n  out vec4 outputColor\n) {'
  )
  if (!temporalPass) {
    // M3 删法：TEMPORAL_PASS 段整体移除（temporalPass 时保留——velocity 数学原文）
    src = src.replace(
      /\n  #ifdef TEMPORAL_PASS\n[\s\S]*?#else \/\/ TEMPORAL_PASS\n  outputDepthVelocity = vec3\(0\.0\);\n  #endif \/\/ TEMPORAL_PASS\n/,
      '\n'
    )
  } else {
    // 单 cascade 化：velocity 段的 reprojectionMatrices[cascadeIndex] → [u_cascadeIndex]
    // （cascade() 的参数 cascadeIndex 与 u_cascadeIndex 同值，改写以匹配 main 的 uniform 传参形态）
    src = src.replace(
      'vec4 prevClip = reprojectionMatrices[cascadeIndex] * vec4(frontPositionWorld, 1.0);',
      'vec4 prevClip = reprojectionMatrices[u_cascadeIndex] * vec4(frontPositionWorld, 1.0);'
    )
  }
  // 6) main：temporalPass 调用带 velocity 出参 + 顶部声明 loc1 out（out 数组声明的单 cascade 替身）
  src = src.replace(
    /void main\(\) \{\n  #pragma unroll_loop_start\n[\s\S]*?#pragma unroll_loop_end\n\}/,
    (temporalPass ? 'layout(location = 1) out vec3 outputDepthVelocity;\n' : '') +
      'uniform int u_cascadeIndex;  // 每 draw 换值（同 shader 复用 ShaderProgram 缓存）\n' +
      'void main() {\n' +
      (temporalPass
        ? '  cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor, outputDepthVelocity);\n'
        : '  cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor);\n') +
      '}'
  )
```

> 注意手术 3 的锚点：M3 版删的是同一块（`#if CASCADE_COUNT == 1 ... #endif // CASCADE_COUNT`）——temporalPass=true 时它也要删（velocity 用单 out 声明替代，由手术 6 注入）。手术 5 的 TEMPORAL_PASS 段锚点正则与 M3 相同但**只在 !temporalPass 时执行**。
>
> `resolution` uniform 已在 `parameters.glsl` L1 声明（M3 就在编译），velocity 段 `(vUv - prevUv) * resolution` 直接可用——T5 绑 `(mapSize, mapSize)`。
>
> `ecefToWorldMatrix` 已在共享 uniform 段（buildSharedCloudsUniforms）绑定。

`buildCloudsShadowFragmentShader` 内调用点同步：`surgeryShadowFrag(glslIndex.shadowFrag, o.temporalPass)`。

(d) 文件头注释「3. 删 outputDepthVelocity …」更新为「temporalPass（M4 默认开）保留 velocity 出参与 TEMPORAL_PASS 段（单 cascade 化：`reprojectionMatrices[u_cascadeIndex]`）；false 时与 M3 相同」。

- [ ] **Step 4: 实现 ShadowResolveMaterial.ts**

```ts
// ShadowResolveMaterial.ts
//
// M4 T3：three shadowResolve.frag（BSM temporal resolve）→ Cesium 单 cascade 组装器。
//
// shadowResolve.frag 是 three.js array RT resolve fragment：MRT out[CASCADE_COUNT] +
// unroll 循环逐 cascade（3×3 closest-fragment velocity reprojection + variance clipping +
// temporalAlpha 慢混合）。本项目 M3 生成端是 Texture3D 逐层——resolve 同款单 cascade 化：
//
// 手术（不动 glsl/shadowResolve.frag 原文）：
//   1. varianceClipping 宏重定向：`#define VARIANCE_9_SAMPLES 1` + `#define VARIANCE_SAMPLER_ARRAY 1`
//      → `#define VARIANCE_SAMPLER sampler3D` + `#define VARIANCE_SAMPLER_COORD ivec3`
//      （varianceClipping.glsl 的宏体系：SAMPER_ARRAY 分支给 sampler2DArray/ivec3 用；
//      sampler3D 同为 ivec3 texelFetchOffset 域，直接指定类型组合即可，不动资产层）
//   2. `uniform sampler2DArray inputBuffer;` / `historyBuffer` → `uniform sampler3D ...`
//   3. history 采样 z 归一化：`texture(historyBuffer, vec3(prevUv, float(cascadeIndex)))` →
//      z = (cascadeIndex+0.5)/CASCADE_COUNT（sampler3D z∈[0,1] 层中心——同 CloudsMaterial
//      手术 6 的 BSM 消费端语义）
//   4. MRT out 数组 → 单 out vec4；main unroll → u_cascadeIndex 单 cascade
//
// texelFetch 路径（getClosestFragment / varianceClipping 的 ivec3 coord）不手术：
// texelFetch(sampler3D, ivec3, lod, ivec2 offset) 是合法 GLSL ES 3.0，velocity 层经
// coord + ivec3(0,0,CASCADE_COUNT) 寻址（bsmTexture depth=2N 的后半）与原文一致。
//
// uniform 清单（T5 uniformMap 依据）：inputBuffer/historyBuffer(sampler3D) + texelSize(vec2)
// + varianceGamma(float=1) + temporalAlpha(float=0.01，three 注释：BSM 单像素闪烁显眼，
// 极慢混合) + u_cascadeIndex(int，ShadowPass 注入)。

import { glslIndex } from './glslIndex'
import { resolveCloudsIncludes } from './resolveCloudsIncludes'

// M4 T3 桥接选项。
export interface ShadowResolveOptions {
  /** cascade 数（默认 3；须与 ShadowPass cascadeCount / 生成端 CASCADE_COUNT 一致）。 */
  cascadeCount?: number
}

type ResolvedShadowResolveOptions = Required<ShadowResolveOptions>

const DEFAULTS: ResolvedShadowResolveOptions = {
  cascadeCount: 3
}

function surgeryShadowResolveFrag(source: string): string {
  let src = source
  // 1) varianceClipping 宏重定向（sampler2DArray → sampler3D）
  src = src.replace(
    /#define VARIANCE_9_SAMPLES 1\n#define VARIANCE_SAMPLER_ARRAY 1\n/,
    '#define VARIANCE_SAMPLER sampler3D\n#define VARIANCE_SAMPLER_COORD ivec3\n'
  )
  // 2) uniform 类型
  src = src.replace('uniform sampler2DArray inputBuffer;', 'uniform sampler3D inputBuffer;')
  src = src.replace('uniform sampler2DArray historyBuffer;', 'uniform sampler3D historyBuffer;')
  // 3) history 采样 z 归一化（层中心）
  src = src.replace(
    'vec4 history = texture(historyBuffer, vec3(prevUv, float(cascadeIndex)));',
    'vec4 history = texture(historyBuffer, vec3(prevUv, (float(cascadeIndex) + 0.5) / float(CASCADE_COUNT)));'
  )
  // 3b) cascade() 内 coord 仍是 ivec3(gl_FragCoord.xy, cascadeIndex)——texelFetch 域 OK 不动。
  //     velocity 层寻址 coord + ivec3(0,0,CASCADE_COUNT) 原文保留。
  // 4) MRT out 数组 → 单 out
  src = src.replace(
    /layout\(location = 0\) out vec4 outputColor\[CASCADE_COUNT\];\n/,
    'layout(location = 0) out vec4 outputColor;\n'
  )
  // 5) cascade 签名去 cascadeIndex 参数（u_cascadeIndex 化）+ main 单 cascade。
  //    注：cascade() 体内 cascadeIndex 全部换 u_cascadeIndex（coord 组装/history 寻址）。
  src = src.replace(
    /void cascade\(\n  const int cascadeIndex,\n  out vec4 outputColor\n\) \{/,
    'uniform int u_cascadeIndex;  // 每 draw 换值（同生成端模式）\n' +
      'void cascade(out vec4 outputColor) {'
  )
  src = src.replaceAll('cascadeIndex', 'u_cascadeIndex')
  src = src.replace(
    /void main\(\) \{\n  #pragma unroll_loop_start\n[\s\S]*?#pragma unroll_loop_end\n\}/,
    'void main() {\n  cascade(outputColor);\n}'
  )
  return src
}

/**
 * 组装 Cesium 运行时 BSM resolve fragment shader（three shadowResolve.frag → 单 cascade 桥接）。
 *
 * 结构：defines（CASCADE_COUNT）+ surgery 后 shadowResolve.frag。precision 头部自带。
 */
export function buildShadowResolveFragmentShader(
  options: ShadowResolveOptions = {}
): string {
  const o: ResolvedShadowResolveOptions = { ...DEFAULTS, ...options }
  const defines = [`#define CASCADE_COUNT ${o.cascadeCount}`]
  const merged = [defines.join('\n'), surgeryShadowResolveFrag(glslIndex.shadowResolveFrag)].join(
    '\n\n'
  )
  return resolveCloudsIncludes(merged)
}

/**
 * glslang 校验入口：补 #version 300 es + precision（sampler3D 覆盖 include 链）。
 * shadowResolve.frag 不引用 czm_*（vUv 经手术 5 后仅剩 u_cascadeIndex 化的 v_textureCoordinates 桥——
 * 见下）。⚠️ shadowResolve.frag 的 `in vec2 vUv;` 也要桥接（与生成端同款）——手术 6：
 */
export function buildStandaloneShadowResolveShaderForValidation(
  options: ShadowResolveOptions = {}
): string {
  const runtime = buildShadowResolveFragmentShader(options)
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

> ⚠️ 实现时注意（写 plan 时已核对 shadowResolve.frag 原文）：`in vec2 vUv;` 桥接手术**必须加**（shadowResolve.frag L17 `in vec2 vUv;`）：
>
> ```ts
> // 0) varying 桥接（放最前）
> src = src.replace(
>   /in vec2 vUv;\n/,
>   '// Cesium ViewportQuadVS 注入 v_textureCoordinates\n' +
>     'in vec2 v_textureCoordinates;\n#define vUv v_textureCoordinates\n'
> )
> ```
>
> 且 `cascade(const int cascadeIndex, out vec4 outputColor)` 的真实原文签名是
> `void cascade(const int cascadeIndex, out vec4 outputColor) {`（单行参数，与 clouds 版多行不同）——
> 手术 5 的正则**以实际文件为准**（实现时先 `grep -n 'void cascade' glsl/shadowResolve.frag` 核对再写锚点，宁可先跑测试看失败信息）。`replaceAll('cascadeIndex', 'u_cascadeIndex')` 会同时覆盖参数名/coord 组装/getClosestFragment 调用——保留原文形态，最小 diff。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/shadowResolve.compile.test.ts src/shadowMain.compile.test.ts
```
预期：PASS。**同时跑 shadowMain.compile.test.ts**（M3 既有断言「无 outputDepthVelocity」会与新默认 temporalPass=true 冲突——把该 M3 用例改为显式传 `{ temporalPass: false }` 断言 M3 基线不变，另加 temporalPass=true 断言在 T3 新测试里已覆盖）。若 M3 测试文件里有依赖 `OPTS = {}` 输出无 velocity 的用例，全部改为 `OPTS: ShadowMainOptions = { temporalPass: false }` 并注明「M3 基线」。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-clouds/src/ShadowMaterial.ts packages/cesium-clouds/src/ShadowResolveMaterial.ts packages/cesium-clouds/src/shadowResolve.compile.test.ts packages/cesium-clouds/src/shadowMain.compile.test.ts
git commit -m "feat(clouds): M4 T3 ShadowMaterial TEMPORAL_PASS 加回 + ShadowResolveMaterial（sampler3D 手术单 cascade 化）"
```

---

### Task 4: CloudsResolvePass.ts——云 resolve primitive + ping-pong

**Files:**
- Create: `packages/cesium-clouds/src/CloudsResolvePass.ts`
- Test: `packages/cesium-clouds/src/CloudsResolvePass.test.ts`

**Interfaces:**
- Consumes: `createVolumetricPrimitive`（core）、`Framebuffer/Texture/Sampler/Cartesian2`（cesium）、`buildCloudsResolveFragmentShader`（T2）、`resolveCloudsHdrDatatype`（本包 CloudsPass.ts 已导出）。
- Produces（T6/T7 依赖）:
  - `interface CloudsResolvePassOptions { context: unknown（Cesium Context）; width: number; height: number; pixelDatatype: number; colorBuffer: Texture; depthVelocityBuffer: Texture; frame: () => number; varianceGamma?: number(=2); temporalAlpha?: number(=0.1) }`
  - `interface CloudsResolvePass { readonly resolvedTexture: Texture; readonly primitive: VolumetricPrimitive; swapBuffers(): void; getResolvedBridge(): { _texture: unknown; _target: number }; destroy(): void }`
  - **语义**：构造即创建 resolve/history 两张全分 Texture + 各自 Framebuffer + 一个 VolumetricPrimitive（FBO 指向 resolveRef 当前纹理——⚠️ FBO 创建后 attachment 固定，swap 靠**两个 FBO 引用一起换**：`resolveFBO`/`historyFBO` 与 `resolveTex`/`historyTex` 同步交换，primitive 的 command framebuffer 每 swap 后重建？**不**——见 Step 3 实现注释：用「双 FBO + command 每帧重建」代价高，改为「两 FBO + primitive command framebuffer 切换」不可行（command 持引用）。**定案：两个 VolumetricPrimitive 不必要——resolve FBO 单个，attachment 每次 swap 后重建 Cesium Framebuffer（轻对象，内部 glFramebufferTexture2D 一次），或者双 FBO 双 command、swap 换 command。取双 FBO + 双 command（每帧 0 分配，FBO/command 创建各 2 次固定）**——primitive 接口暴露当前 command：见实现。
  - `swapBuffers()`：resolve↔history（纹理/FBO/command 三引用齐换）+ history uniform 指新 historyTex。preRender 开头调（D2）。

- [ ] **Step 1: 写失败测试**

```ts
// CloudsResolvePass.test.ts
//
// M4 T4：createCloudsResolvePass 单测（node 无 WebGL——mock 模式仿 CloudsPass.test.ts）。
// 验：双 Texture（全分 LINEAR）+ 双 FBO 装配；uniformMap（color/depthVel 闭包 + history swap
// 后换引用 + texelSize/frame/varianceGamma/temporalAlpha）；swapBuffers 三引用齐换；
// getResolvedBridge 读 resolveRef；destroy 幂等。

import { describe, it, expect, vi } from 'vitest'

vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const created: any[] = []
  const mkTexCtor = () =>
    function (this: any, opts: any) {
      this.width = opts.width
      this.height = opts.height
      this.pixelDatatype = opts.pixelDatatype
      this.sampler = opts.sampler
      this._texture = { id: created.length }
      this._target = 0x0de1
      this.destroy = vi.fn()
      created.push(this)
    }
  return {
    ...actual,
    Texture: mkTexCtor(),
    Sampler: function (this: any, opts: any) {
      Object.assign(this, opts)
    },
    Framebuffer: function (this: any, opts: any) {
      this.colorTextures = opts.colorTextures
      this.destroy = vi.fn()
    }
  }
})

vi.mock('@cesium-geospatial/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createVolumetricPrimitive: vi.fn((opts: any) => ({
      update: vi.fn(),
      isDestroyed: () => false,
      destroy: vi.fn(),
      __fbo: opts.mrtColorTextures[0]
    }))
  }
})

import { Framebuffer, Texture } from 'cesium'
import { createVolumetricPrimitive } from '@cesium-geospatial/core'
import { createCloudsResolvePass } from './CloudsResolvePass'

const frameRef = { value: 7 }

function mkOpts(width = 1920, height = 1080) {
  const colorBuffer = new Texture({ width: 480, height: 270 } as any)
  const depthVelocityBuffer = new Texture({ width: 480, height: 270 } as any)
  return {
    context: { drawingBufferWidth: width, drawingBufferHeight: height } as any,
    width,
    height,
    pixelDatatype: 0x140b,
    colorBuffer,
    depthVelocityBuffer,
    frame: () => frameRef.value
  }
}

describe('M4 T4 CloudsResolvePass', () => {
  it('装配：两张全分 LINEAR Texture + 两个 Framebuffer（各挂一张）+ primitive', () => {
    const p = createCloudsResolvePass(mkOpts())
    const texes = (Texture as any).created ?? []
    expect(texes.length).toBe(2)
    expect(p.resolvedTexture.width).toBe(1920)
    expect(p.resolvedTexture.height).toBe(1080)
    expect(createVolumetricPrimitive).toHaveBeenCalled()
    p.destroy()
  })

  it('uniformMap：color/depthVel 闭包 + texelSize/frame/varianceGamma/temporalAlpha 默认值', () => {
    const opts = mkOpts()
    const p = createCloudsResolvePass(opts)
    const call = (createVolumetricPrimitive as any).mock.calls.at(-1)[0]
    const um = call.uniformMap
    expect(um.colorBuffer()).toBe(opts.colorBuffer)
    expect(um.depthVelocityBuffer()).toBe(opts.depthVelocityBuffer)
    expect(um.texelSize().x).toBeCloseTo(1 / 1920)
    expect(um.frame()).toBe(7)
    expect(um.varianceGamma()).toBe(2)
    expect(um.temporalAlpha()).toBe(0.1)
    p.destroy()
  })

  it('swapBuffers：history uniform 换引用 + resolvedTexture/getResolvedBridge 换到本帧输出', () => {
    const opts = mkOpts()
    const p = createCloudsResolvePass(opts)
    const before = p.resolvedTexture
    const call = (createVolumetricPrimitive as any).mock.calls.at(-1)[0]
    const um = call.uniformMap
    const histBefore = um.colorHistoryBuffer()
    p.swapBuffers()
    // swap 后：resolveRef=旧 history（待写），history uniform=旧 resolve（上帧输出）
    expect(p.resolvedTexture).not.toBe(before)
    expect(um.colorHistoryBuffer()).toBe(before)
    expect(um.colorHistoryBuffer()).not.toBe(histBefore)
    // 再 swap 回（ping-pong）
    p.swapBuffers()
    expect(p.resolvedTexture).toBe(before)
    p.destroy()
  })

  it('destroy：双 Texture + 双 FBO + primitive 释放，幂等', () => {
    const p = createCloudsResolvePass(mkOpts())
    p.destroy()
    p.destroy()
    expect((p.resolvedTexture as any).destroy).toHaveBeenCalled()
  })
})
```

> 测试里 `(Texture as any).created` 需要 mock 构造器上挂静态数组——实现 mock 时在 `mkTexCtor` 外层声明 `const created: any[] = []` 并 `(Texture as any).created = created`（vitest vi.mock 工厂内）。实现者按 CloudsPass.test.ts 现有范式微调（核心断言不变）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/CloudsResolvePass.test.ts
```

- [ ] **Step 3: 实现 CloudsResolvePass.ts**

```ts
// CloudsResolvePass.ts
//
// M4 T4：云 resolve Pass——第二个 VolumetricPrimitive（pass=VOXELS，add 在 march 之后）
// 跑 cloudsResolve.frag：读 march 低分 MRT（color/depthVelocity）+ 全分 history → 写全分
// resolve RT。resolve/history 双 Texture ping-pong（D2）。
//
// 执行点（D1）：march primitive 与本 primitive 同 pass=VOXELS，PrimitiveCollection 数组序
// → update 顺序 → commandList 序 = march 先 resolve 后（GL 串行无读写 hazard）。
// createCloudsStage 负责按「先 march 后 resolve」的顺序 add（T7）。
//
// swap 时机（D2）：createCloudsStage preRender **开头**调 swapBuffers()——等价 three 的
// render 后 swap：swap 后 historyRef=上帧输出（resolve 读）、resolveRef=待写（渲染中写入、
// overlay 闭包此时取值=本帧输出）。

import {
  Texture,
  Sampler,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  TextureWrap,
  Framebuffer,
  Cartesian2,
  PixelFormat
} from 'cesium'
import type { Context } from 'cesium'
import { createVolumetricPrimitive, type VolumetricPrimitive } from '@cesium-geospatial/core'
import { buildCloudsResolveFragmentShader } from './CloudsResolveMaterial'

/** 云 resolve Pass 构造选项。 */
export interface CloudsResolvePassOptions {
  /** Cesium Context。 */
  context: Context
  /** 全分宽（drawingBufferWidth）。 */
  width: number
  /** 全分高。 */
  height: number
  /** HDR 像素类型（与 march MRT 同源 resolveCloudsHdrDatatype）。 */
  pixelDatatype: number
  /** march 低分 color（att0）。 */
  colorBuffer: Texture
  /** march 低分 depthVelocity（att1）。 */
  depthVelocityBuffer: Texture
  /** frame 闭包（读 params.frame——与 march/BSM 同帧递增）。 */
  frame: () => number
  /** variance clipping γ（three 默认 2）。 */
  varianceGamma?: number
  /** temporal 混合 α（three 默认 0.1；upscale 分支不消费此值，编译进 TAA 分支）。 */
  temporalAlpha?: number
}

/** 云 resolve Pass 句柄。 */
export interface CloudsResolvePass {
  /** 本帧 resolve 输出纹理（swap 后的 resolveRef——渲染中写入，overlay 读它）。 */
  readonly resolvedTexture: Texture
  /** 稳定外壳 primitive（createCloudsStage add 到 scene.primitives——swap 不换引用，
   *  update 转发到内部 active primitive）。 */
  readonly primitive: VolumetricPrimitive
  /** resolve↔history 交换（preRender 开头调）。 */
  swapBuffers(): void
  /** resolve 输出的 bridge（{_texture,_target}——overlay u_cloudsBuffer 用，temporal 开启时）。 */
  getResolvedBridge(): { _texture: unknown; _target: number }
  /** 释放：双 primitive（各含 FBO）+ 双 Texture。幂等。 */
  destroy(): void
}

/**
 * 创建云 resolve Pass（双 Texture/双 primitive ping-pong + 稳定外壳）。
 *
 * ⚠️ 为什么双 primitive + 外壳（而非 swap 时重建 primitive）：PrimitiveCollection 持
 * primitive 引用——swap 时 destroy 旧实例会让 collection 里的引用失效（destroyed 后
 * update 不再 push command，resolve 停摆）。故内部持两个 VolumetricPrimitive（各挂一张
 * Texture 的 FBO），对外暴露稳定外壳（update 转发到 active），swap 只切 active 引用，
 * 零重建、零 GC。
 */
export function createCloudsResolvePass(
  options: CloudsResolvePassOptions
): CloudsResolvePass {
  const { context } = options
  const varianceGamma = options.varianceGamma ?? 2
  const temporalAlpha = options.temporalAlpha ?? 0.1

  // history 采样 texture() bilinear → LINEAR（march 输出走 texelFetch 与 filter 无关）
  const sampler = new Sampler({
    minificationFilter: TextureMinificationFilter.LINEAR,
    magnificationFilter: TextureMagnificationFilter.LINEAR,
    wrapS: TextureWrap.CLAMP_TO_EDGE,
    wrapT: TextureWrap.CLAMP_TO_EDGE
  })
  const mkTex = (): Texture =>
    new Texture({
      context,
      width: options.width,
      height: options.height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: options.pixelDatatype,
      sampler
    })

  let resolveTex = mkTex() // 本帧写入
  let historyTex = mkTex() // 上帧输出（resolve 读）

  const texelSize = new Cartesian2(1 / options.width, 1 / options.height)
  const uniformMap: { [name: string]: () => unknown } = {
    colorBuffer: () => options.colorBuffer,
    depthVelocityBuffer: () => options.depthVelocityBuffer,
    colorHistoryBuffer: () => historyTex,
    texelSize: () => texelSize,
    frame: options.frame,
    varianceGamma: () => varianceGamma,
    temporalAlpha: () => temporalAlpha
  }

  const fragmentShaderSource = buildCloudsResolveFragmentShader({ temporalUpscale: true })
  const mkPrim = (tex: Texture): VolumetricPrimitive =>
    createVolumetricPrimitive({
      context,
      fragmentShaderSource,
      uniformMap,
      mrtColorTextures: [tex]
    })
  let resolvePrim = mkPrim(resolveTex)
  let primB = mkPrim(historyTex)

  let destroyed = false
  // 稳定外壳：swap 只切 active（march 先 resolve 后的 D1 执行序由 add 顺序保证，
  // 两内部 primitive 只有一个被外壳转发 → 每帧恰好一次 resolve draw）
  const shell: VolumetricPrimitive = {
    update(frameState: unknown): void {
      if (destroyed) return
      resolvePrim.update(frameState)
    },
    isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      resolvePrim.destroy()
      primB.destroy()
      resolveTex.destroy()
      historyTex.destroy()
    }
  }
  return {
    get resolvedTexture(): Texture {
      return resolveTex
    },
    primitive: shell,
    swapBuffers(): void {
      if (destroyed) return
      // 三引用轮换（resolvePrim/primB/resolveTex 与 historyTex 对齐）：
      // primB 挂的正是换入的 resolveTex（初值 historyTex 对应），换出者下轮复用
      const nextResolveTex = historyTex
      const nextResolvePrim = primB
      historyTex = resolveTex
      resolveTex = nextResolveTex
      primB = resolvePrim
      resolvePrim = nextResolvePrim
    },
    getResolvedBridge(): { _texture: unknown; _target: number } {
      const internal = resolveTex as unknown as { _texture: unknown; _target: number }
      return { _texture: internal._texture, _target: internal._target }
    },
    destroy(): void {
      shell.destroy()
    }
  }
}
```

> ⚠️ 实现说明（最终代码以此为准）：
> 1. `mkFBO`/`resolveFBO`/`historyFBO`/`Framebuffer` import 均不需要——VolumetricPrimitive 自建 FBO（挂 mrtColorTextures），history 纹理只被采样。最终结构：双 Texture + 双 VolumetricPrimitive（各挂一张）+ 稳定外壳 + swap 三引用轮换。
> 2. 测试的 swap 断言：`p.primitive` swap 后**同引用**（外壳稳定）；`resolvedTexture` 换到另一张；`colorHistoryBuffer()` 换引用。Step 1 测试代码相应处调整（外壳语义）。
> 3. swap 每帧零 GL 调用（纯引用轮换）——无 GC/驱动开销。

- [ ] **Step 4: 跑测试确认通过 + 包内全量回归**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/CloudsResolvePass.test.ts
pnpm --filter @cesium-geospatial/clouds test
```

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/CloudsResolvePass.ts packages/cesium-clouds/src/CloudsResolvePass.test.ts
git commit -m "feat(clouds): M4 T4 CloudsResolvePass——resolve primitive（VOXELS 第二实例）+ 双 Texture ping-pong"
```

---

### Task 5: ShadowPass temporal——velocity 层 + resolve + ping-pong

**Files:**
- Modify: `packages/cesium-clouds/src/ShadowPass.ts`
- Test: `packages/cesium-clouds/src/ShadowPass.test.ts`（扩展）

**Interfaces:**
- Consumes: T3 的 `buildCloudsShadowFragmentShader({temporalPass})` / `buildShadowResolveFragmentShader`；现有 `ShadowDrawPass/ShadowDrawPassFactory` 注入机制。
- Produces（T7 依赖）:
  - `ShadowPassOptions` 增加：
    - `temporalPass?: boolean`（默认 true）
    - `createResolveDrawPass?: ShadowDrawPassFactory`（测试注入；缺省 FullscreenPass 同款）
  - `ShadowPass` 接口变化：
    - `readonly velocityLayerOffset: number`（= cascadeCount，velocity 层 z 起点；temporalPass=false 时无效）
    - `render()` 行为扩展：temporalPass 时逐 cascade 双 attach（att0=层 i、att1=层 cascadeCount+i）单 draw（shader 双 out），随后 resolve 逐 cascade（attach resolveTex 层 i）draw，末尾 swap resolveTex↔historyTex。
    - `setReprojectionMatrices(matrices: Matrix4[]): void`——preRender 传入**上帧** cascade 矩阵（velocity 用）；render 内部 draw 后自动把本帧矩阵存入内部 prev（由 createCloudsStage 每帧先 setReprojectionMatrices(prev) 再传新矩阵进 cascades——见 T7；**简化：ShadowPass 自己持 prevMatrices，render() 末尾从 options.uniformMap 闭包外的「本帧矩阵」拷贝**——本帧矩阵由调用方经 `setCurrentMatrices(matrices)` 传入）。最终接口定案：
      - `setCurrentMatrices(matrices: Matrix4[]): void`（preRender 里 cascades.update 后传本帧 cascade.matrix 数组）
      - uniformMap 的 `reprojectionMatrices` 闭包读 ShadowPass 内部 `prevMatrices`（首帧初始化 = identity → prevClip 巨值 → prevUv 越界 rejection → resolve 返 current，安全降级）
    - `readonly bsmTexture: Texture3D`：temporalPass 时返回 **swap 后的 history resolve 纹理**（本帧 resolve 输出）；false 时返回生成端 current（M3 行为）。
- 编排契约（T7 实现依据）：每帧顺序 `cascades.update(...) → setCurrentMatrices(本帧矩阵) → shadowPass.render()`；render 内部 `reprojectionMatrices uniform ← prevMatrices（上帧）→ draw 生成（velocity 用上帧矩阵）→ draw resolve → swap → prevMatrices ← 本帧矩阵`。

- [ ] **Step 1: 写失败测试（ShadowPass.test.ts 新增 describe）**

在现有 `ShadowPass.test.ts` 末尾追加（沿用文件已有 gl mock / vi.mock cesium / createMockContext——`framebufferTexture2D` 若 mock 缺则补；`drawBuffers` 同）：

```ts
describe('M4 T5 ShadowPass temporal', () => {
  const N = 3
  function mkTemporalOpts() {
    const drawCalls: string[] = []
    const mkFactory = (tag: string): ShadowDrawPassFactory => () => ({
      execute: () => drawCalls.push(tag),
      destroy: () => {}
    })
    return {
      opts: {
        context: createMockContext(),
        cascadeCount: N,
        mapSize: 512,
        pixelDatatype: 0x140b,
        uniformMap: {},
        temporalPass: true,
        createDrawPass: mkFactory('gen'),
        createResolveDrawPass: mkFactory('res')
      } as any,
      drawCalls
    }
  }

  it('temporalPass：bsmTexture depth=2N（velocity 层）+ 双 attach + 生成 N 次 + resolve N 次', () => {
    const { opts, drawCalls } = mkTemporalOpts()
    const pass = createShadowPass(opts)
    // Texture3D 构造参数（gl mock 记录 lastOptions）
    expect((Texture3D as any).lastOptions.source.depth).toBe(2 * N)
    pass.render()
    // 生成 3 draw（每 cascade：att0=层 i、att1=层 N+i）+ resolve 3 draw（层 i）= 6
    expect(drawCalls.filter((c) => c === 'gen').length).toBe(N)
    expect(drawCalls.filter((c) => c === 'res').length).toBe(N)
    // velocity 层 attach 记录：attachments 里出现 layer=3/4/5（att1）
    const layers = (gl.framebufferTextureLayer as any).mock.calls.map(
      (c: any[]) => c[4]
    )
    expect(layers).toContain(N + 0)
    expect(layers).toContain(N + 2)
    pass.destroy()
  })

  it('setCurrentMatrices → render：reprojectionMatrices uniform 读上帧矩阵（首帧 identity 降级）', () => {
    const { opts } = mkTemporalOpts()
    const pass = createShadowPass(opts)
    const um = (pass as any) // bsmTexture 只读；uniformMap 经 createDrawPass 收集——改用工厂捕获
    // 工厂捕获 uniformMap：
    let captured: any
    opts.createDrawPass = ((_c: any, _s: any, uniformMap: any) => {
      captured = uniformMap
      return { execute: () => {}, destroy: () => {} }
    }) as any
    const pass2 = createShadowPass(opts)
    const m0 = [Matrix4.clone(Matrix4.IDENTITY), Matrix4.clone(Matrix4.IDENTITY), Matrix4.clone(Matrix4.IDENTITY)]
    const m1 = [Matrix4.fromTranslation(new Cartesian3(1, 0, 0)), Matrix4.fromTranslation(new Cartesian3(2, 0, 0)), Matrix4.fromTranslation(new Cartesian3(3, 0, 0))]
    pass2.setCurrentMatrices(m1 as any)
    // 首帧 render：reprojectionMatrices = identity（prevMatrices 初始值）
    const rep = () => captured.reprojectionMatrices() as Matrix4[]
    pass2.render()
    expect(Matrix4.equals(rep()[0], Matrix4.IDENTITY)).toBe(true)
    // render 末尾 prevMatrices ← 本帧（m1）；下帧 render 读到 m1
    pass2.render()
    expect(Matrix4.equals(rep()[0], m1[0] as any)).toBe(true)
    pass2.destroy()
    pass.destroy()
  })

  it('temporalPass=false：M3 行为——depth=N + 单 attach + 无 resolve draw（零回归）', () => {
    const drawCalls: string[] = []
    const opts = {
      context: createMockContext(),
      cascadeCount: N,
      mapSize: 512,
      pixelMap: {},
      uniformMap: {},
      temporalPass: false,
      createDrawPass: (() => ({ execute: () => drawCalls.push('gen'), destroy: () => {} })) as any,
      createResolveDrawPass: (() => ({ execute: () => drawCalls.push('res'), destroy: () => {} })) as any
    } as any
    const pass = createShadowPass(opts)
    expect((Texture3D as any).lastOptions.source.depth).toBe(N)
    pass.render()
    expect(drawCalls).toEqual(['gen', 'gen', 'gen'])
    pass.destroy()
  })
})
```

> mock 补充：现有 gl mock 的 `framebufferTextureLayer` 已记录（ShadowPass.test 现状）；若 `drawBuffers` 未 mock，在 gl 对象加 `drawBuffers: vi.fn()`。`Matrix4/Cartesian3` 从 'cesium' importOriginal 保真（现有 mock 已保真 math）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/ShadowPass.test.ts
```

- [ ] **Step 3: 实现 ShadowPass.ts 扩展**

对 `ShadowPass.ts` 的修改（保留 M3 全部现有结构与注释，新增 temporal 路径）：

(a) import 增加 `Matrix4`（cesium）+ `buildShadowResolveFragmentShader`（T3）。

(b) `ShadowPassOptions` 增加字段（带中文注释：temporalPass 默认 true；createResolveDrawPass 测试注入）。`ShadowPass` 接口增加 `setCurrentMatrices(matrices: Matrix4[]): void` + `velocityLayerOffset: number`。

(c) `createShadowPass` 内：

```ts
  const temporalPass = options.temporalPass ?? true
  const layerDepth = temporalPass ? cascadeCount * 2 : cascadeCount
  // bsmTexture 构造的 depth 参数改用 layerDepth（velocity 层在后半——shadowResolve 经
  // coord + ivec3(0,0,CASCADE_COUNT) 寻址）
```

velocity/resolve 纹理与状态：

```ts
  // ── M4 temporal：resolve ping-pong（两Texture3D depth=cascadeCount，LINEAR）+ prevMatrices ──
  const resolveTexA = temporalPass ? mkBsmTex('Shadow.Resolve.A') : undefined
  const resolveTexB = temporalPass ? mkBsmTex('Shadow.Resolve.B') : undefined
  let resolveTex = resolveTexA   // 本帧写
  let historyTex = resolveTexB  // 上帧输出（resolve 读）
  const prevMatrices: Matrix4[] = Array.from({ length: cascadeCount }, () => Matrix4.clone(Matrix4.IDENTITY))
  let currentMatrices: Matrix4[] = prevMatrices.map((m) => Matrix4.clone(m))
```

（`mkBsmTex` 是把现有 bsmTexture 构造抽出的本地工厂——同参（mapSize、cascadeCount 层、LINEAR、HALF_FLOAT 预置 0）。生成端 bsmTexture 的 `allocZeroedTexels` texelCount 用 `mapSize*mapSize*layerDepth*4`。）

uniformMap 扩展（现有 `...options.uniformMap` 之上）：

```ts
  const uniformMap = {
    ...options.uniformMap,
    u_cascadeIndex: () => cascadeIndex,
    ...(temporalPass
      ? {
          // 生成端 velocity 用（D6）：texel 单位 velocity 的 resolution = mapSize
          resolution: () => resolutionScratch, // Cartesian2(mapSize, mapSize)，构造时设
          reprojectionMatrices: () => prevMatrices
        }
      : {})
  }
```

resolve draw pass（temporalPass 时）：

```ts
  const resolveUniformMap: { [name: string]: () => unknown } = {
    inputBuffer: () => bsmTexture,       // 生成端 current（含 velocity 层）
    historyBuffer: () => historyTex,
    texelSize: () => shadowTexelSize,    // Cartesian2(1/mapSize, 1/mapSize)
    varianceGamma: () => 1,
    temporalAlpha: () => 0.01,           // three：BSM 单像素闪烁显眼 → 极慢混合
    u_cascadeIndex: () => cascadeIndex
  }
  const resolveDrawPass = temporalPass
    ? (options.createResolveDrawPass ?? defaultCreateDrawPass)(
        context,
        buildShadowResolveFragmentShader({ cascadeCount }),
        resolveUniformMap,
        mapSize
      )
    : undefined
```

render() 重写（temporalPass 分支；M3 路径原样保留在 else）：

```ts
    render(): void {
      if (destroyed) return
      const prevFbo = gl.getParameter(GL_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      gl.bindFramebuffer(GL_FRAMEBUFFER, fbo)
      try {
        if (temporalPass) {
          gl.drawBuffers([GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1])
        }
        for (let i = 0; i < cascadeCount; i++) {
          gl.framebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, rawTex, 0, i)
          if (temporalPass) {
            // velocity 层（后半）：同一 draw 双 out（outputColor→att0 层 i、
            // outputDepthVelocity→att1 层 cascadeCount+i）
            gl.framebufferTextureLayer(
              GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT1, rawTex, 0, cascadeCount + i
            )
          }
          if (i === 0 && gl.checkFramebufferStatus(GL_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
            console.warn('[clouds] BSM FBO 不完整，跳过本帧（主 march fallback Beer=1）')
            return
          }
          cascadeIndex = i
          drawPass.execute(context)
        }
        // ── M4 resolve：逐 cascade 写 resolveTex 层 i（单 attach 恢复）──
        if (temporalPass && resolveDrawPass != null && resolveTex != null) {
          gl.drawBuffers([GL_COLOR_ATTACHMENT0])
          const rawResolve = (resolveTex as unknown as { _texture: WebGLTexture })._texture
          for (let i = 0; i < cascadeCount; i++) {
            gl.framebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, rawResolve, 0, i)
            cascadeIndex = i
            resolveDrawPass.execute(context)
          }
          // swap + prevMatrices ← 本帧（下帧 velocity 用）
          const nextResolve = historyTex!
          historyTex = resolveTex
          resolveTex = nextResolve
          for (let i = 0; i < cascadeCount; i++) {
            Matrix4.clone(currentMatrices[i], prevMatrices[i])
          }
        }
      } finally {
        gl.bindFramebuffer(GL_FRAMEBUFFER, prevFbo)
        gl.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight)
      }
    }
```

`setCurrentMatrices`（句柄上新方法）：

```ts
    setCurrentMatrices(matrices: Matrix4[]): void {
      for (let i = 0; i < cascadeCount; i++) {
        Matrix4.clone(matrices[i], currentMatrices[i])
      }
    }
```

`bsmTexture` getter 化（temporalPass 时返回 swap 后 historyTex）：

```ts
  return {
    get bsmTexture(): Texture3D {
      // temporal：resolve/history 已 swap——historyTex = 本帧 resolve 输出（消费端 state.shadow.bsm）
      return (temporalPass ? historyTex! : bsmTexture) as Texture3D
    },
    ...
  }
```

> ⚠️ 现有 `readonly bsmTexture: Texture3D` 字段改 getter 时，`state.shadow.bsm = shadowPass?.bsmTexture`（createCloudsStage）每帧取值即可拿到最新（M3 现状就是 preRender 里逐帧赋值 ✓ 无需改）。
> destroy：补 `resolveTex?.destroy() / historyTex?.destroy() / resolveDrawPass?.destroy()`。
> `gl.drawBuffers` 常量：`const GL_COLOR_ATTACHMENT1 = 0x8ce1`。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/ShadowPass.test.ts
pnpm --filter @cesium-geospatial/clouds test
```

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/ShadowPass.ts packages/cesium-clouds/src/ShadowPass.test.ts
git commit -m "feat(clouds): M4 T5 ShadowPass temporal——velocity 层双 attach + shadowResolve 逐 cascade + ping-pong + prevMatrices"
```

---

### Task 6: CloudsPass 低分模式 + CloudsMaterial jitter surgery + core viewport 选项

**Files:**
- Modify: `packages/cesium-core/src/cesium/platform/VolumetricPrimitive.ts`（viewport 选项）
- Modify: `packages/cesium-clouds/src/CloudsMaterial.ts`（ray 重建 jitter surgery + vViewPosition 注释）
- Modify: `packages/cesium-clouds/src/CloudsPass.ts`（temporalUpscale 低分模式 + 暴露 depthVelocityTexture + resolution/targetUvScale 语义）
- Test: `packages/cesium-clouds/src/CloudsPass.test.ts`（扩展）+ `packages/cesium-clouds/src/cloudsMain.compile.test.ts`（jitter 断言）

**Interfaces:**
- Consumes: 无新外部依赖（`temporalMath` 不在此消费——jitter 值由 T7 编排注入 uniform）。
- Produces:
  - `VolumetricPrimitiveOptions` 增加 `viewport?: BoundingRectangle`（core 公开导出类型）；renderState.viewport 传入。
  - `CloudsPassOptions`（= CloudsMainOptions 扩展处）增加 `temporalUpscale?: boolean`（默认 **false**——保持 M3 零回归；T7 createCloudsStage 按 URL 决定传入）。
  - `CloudsPass` 接口增加 `readonly depthVelocityTexture: Texture`（T4 resolve 消费）+ `readonly marchWidth/marchHeight: number`（低分尺寸，T7 算 jitter 用）。
  - `buildCloudsMainFragmentShader` 输出变化：`cloudsBridge_reconstructVaryings` 内 `czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy + temporalJitter * resolution, ...))`（近/远两处）。

- [ ] **Step 1: 写失败测试**

(a) `cloudsMain.compile.test.ts` 末尾追加 describe：

```ts
describe('M4 T6 jitter surgery', () => {
  it('ray 重建消费 temporalJitter（gl_FragCoord + temporalJitter * resolution，近/远两处）', () => {
    const src = buildCloudsMainFragmentShader({})
    const n = (src.match(/czm_windowToEyeCoordinates\(vec4\(gl_FragCoord\.xy \+ temporalJitter \* resolution/g) ?? []).length
    expect(n).toBe(2)
  })
  it('vViewPosition 保持 normalize（与 three 未归一化版共线——投影 w 除法抵消标量差，注释声明）', () => {
    const src = buildCloudsMainFragmentShader({})
    expect(src).toContain('vViewPosition = normalize(dirEC)')
  })
})
```

(b) `CloudsPass.test.ts` 追加 describe（沿用文件已有 mock scene/context 模式）：

```ts
describe('M4 T6 temporalUpscale 低分模式', () => {
  it('temporalUpscale=true：MRT 尺寸 ceil(w/4)×ceil(h/4) + resolution=lowRes*4 + targetUvScale/mipLevelScale', () => {
    const scene = createMockScene() // 1920×1080 → lowRes 480×270
    const handle = createCloudsPass(scene, mkLuts(), mkWeather(), mkState(), {
      temporalUpscale: true,
      parameters: defaultCloudsParameters()
    })
    expect(handle.colorTexture.width).toBe(480)
    expect(handle.depthVelocityTexture.height).toBe(270)
    expect(handle.marchWidth).toBe(480)
    // resolution uniform：lowRes*4（480*4=1920 恰等 drawingBuffer；用 1081 高度验证 ceil：
    // ceil(1081/4)=271 → 271*4=1084 ≠ 1081）
    const um = captureUniformMap() // 按文件现有 capture 手法（mock createVolumetricPrimitive 收集 opts.uniformMap）
    const res = um.resolution()
    expect(res.x).toBe(1920)
    // targetUvScale = lowRes*4/full
    const tus = um.targetUvScale()
    expect(tus.y).toBeCloseTo(1080 / 1080) // 1920×1080 恰整除 → (1,1)；另用 1081 场景断言 1084/1081
    expect(um.mipLevelScale()).toBe(0.25)
    handle.destroy()
  })
  it('temporalUpscale 默认 false（M3 零回归）：MRT 全分 + mipLevelScale=1', () => {
    const handle = createCloudsPass(createMockScene(), mkLuts(), mkWeather(), mkState())
    expect(handle.colorTexture.width).toBe(1920)
    const um = captureUniformMap()
    expect(um.mipLevelScale()).toBe(1.0)
    handle.destroy()
  })
})
```

> `captureUniformMap()/mkLuts()/mkWeather()/mkState()` 用文件现有 helper 同名或按现文件实际命名调整——CloudsPass.test.ts 已有完整 mock scene/luts/weather/state 构造与 uniformMap 捕获手法（`createVolumetricPrimitive` mock 收集 `opts`），实现者复用，断言值不变。1081 场景：`scene.context.drawingBufferHeight = 1081` 覆写后断言 `tus.y ≈ 1084/1081` 与 `res.y === 1084`。

(c) core `VolumetricPrimitive.test.ts` 追加：

```ts
it('M4：viewport 选项透传 RenderState.fromCache', () => {
  const viewport = new BoundingRectangle(0, 0, 480, 270)
  createVolumetricPrimitive({ ...baseOpts, viewport })
  expect(RenderState.fromCache).toHaveBeenCalledWith(
    expect.objectContaining({ viewport, depthTest: { enabled: false }, depthMask: false })
  )
})
```

（按该文件现有 mock/构造手法适配 `baseOpts`。）

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts src/CloudsPass.test.ts
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/platform/VolumetricPrimitive.test.ts
```

- [ ] **Step 3: 实现**

(a) core `VolumetricPrimitive.ts`：

```ts
import { Framebuffer, RenderState, BoundingRectangle } from 'cesium'
// options 加：
  /** 可选：FBO viewport（低分 march 必须设——不设时 GL viewport 保持 drawingBuffer，低分 FBO 写越界）。 */
  viewport?: BoundingRectangle
// renderState 构造改为：
  const renderState = RenderState.fromCache({
    viewport: options.viewport,
    depthTest: { enabled: false },
    depthMask: false
  })
```

（`viewport: undefined` 时 fromCache 视为未设——与现状等价。core 测试 + clouds 回归都要跑。）

(b) `CloudsMaterial.ts` surgery——`BRIDGE_VARYINGS_GLSL` 的 `cloudsBridge_reconstructVaryings` 内两处窗口坐标加 jitter：

```glsl
  // 视线方向（view space）：czm_windowToEyeCoordinates 近/远平面差分（仿 core reconstructRay）。
  // M4 temporal：窗口坐标加 Bayer jitter（temporalJitter*resolution = 全分像素单位偏移
  // ±2px = ±0.5 低分 texel；与 depth 采样 UV / 噪声种子三处原文 jitter 语义对齐——
  // three 版 jitter 走 inverseProjectionMatrix 注入，本项目重建路径等价改为 gl_FragCoord 偏移）。
  vec4 eyeNear = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy + temporalJitter * resolution, 0.0, 1.0));
  vec4 eyeFar = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy + temporalJitter * resolution, 1.0, 1.0));
```

同步更新 `vViewPosition` 行尾注释：`// view-space 单位方向（M4：与 three 未归一化 vViewPosition 共线——velocity 投影经 prevClip.w 除法抵消标量差）`。文件头「M4 temporal：不摘 reprojectionMatrix…」注释段更新为已接通描述。

(c) `CloudsPass.ts`：

```ts
export interface CloudsPassOptions extends CloudsMainOptions {
  parameters?: CloudsParameters
  /** M4 temporal upscale 开关（默认 false = M3 全分零回归；true 时 march 降到 ceil(w/4)）。 */
  temporalUpscale?: boolean
}
```

`createCloudsPass` 内：

```ts
  const temporalUpscale = options.temporalUpscale === true
  // 低分尺寸（three CloudsPass.setSize temporalUpscale 分支同款）：ceil(w/4)
  const marchWidth = temporalUpscale ? Math.ceil(width / 4) : width
  const marchHeight = temporalUpscale ? Math.ceil(height / 4) : height
```

- `mkMrtTex` 用 `marchWidth/marchHeight`。
- `resolution` 闭包改：

```ts
  const resolutionScratch = new Cartesian2()
  // M4 temporal（D3/D10）：resolution = lowRes*4（4 对齐全分等效——three 语义：噪声种子
  // gl_FragCoord+jitter*resolution 的量纲基底）；非 temporal = drawingBuffer（M2 语义）。
  const resolutionFullW = temporalUpscale ? marchWidth * 4 : width
  const resolutionFullH = temporalUpscale ? marchHeight * 4 : height
  const resolution = (): Cartesian2 => {
    resolutionScratch.x = resolutionFullW
    resolutionScratch.y = resolutionFullH
    return resolutionScratch
  }
```

- `targetUvScale`：temporal 时返回 `(marchWidth*4/width, marchHeight*4/height)` 的常量 Cartesian2（闭包外预构造 `const targetUvScaleTemporal = new Cartesian2(...)`）；非 temporal 维持 `params.targetUvScale`。
- `mipLevelScale`：temporal 时 `() => 0.25`；否则 `() => params.mipLevelScale`。
- **frame 拆分（D7）**：uniformMap 在 `...buildSharedCloudsUniforms(...)` 之后覆写 `frame: () => (temporalUpscale ? params.frame : 0)`——march 的 stbn 噪声相位只在 temporal 开时递增（无 resolve 平滑时逐帧换相位 = 回归闪烁；M3 行为 = 恒 0）。
- `createVolumetricPrimitive` 调用加 `viewport: temporalUpscale ? new BoundingRectangle(0, 0, marchWidth, marchHeight) : undefined`（import BoundingRectangle）。
- 句柄返回加 `depthVelocityTexture: depthVelTex`、`marchWidth/marchHeight`。
- 文件头注释「temporalJitter = (0,0)（M4 Bayer）」更新为「M4 T7 编排注入 Bayer 值」。

- [ ] **Step 4: 跑测试确认通过 + 双包回归**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/cloudsMain.compile.test.ts src/CloudsPass.test.ts
pnpm --filter @cesium-geospatial/core test
pnpm --filter @cesium-geospatial/clouds test
```

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/platform/VolumetricPrimitive.ts packages/cesium-core/src/cesium/platform/VolumetricPrimitive.test.ts packages/cesium-clouds/src/CloudsMaterial.ts packages/cesium-clouds/src/CloudsPass.ts packages/cesium-clouds/src/CloudsPass.test.ts packages/cesium-clouds/src/cloudsMain.compile.test.ts
git commit -m "feat(clouds): M4 T6 march 1/4 分模式——jitter 注入 ray 重建 + viewport 选项 + resolution/targetUvScale/mipLevelScale 语义切换"
```

---

### Task 7: createCloudsStage 编排——frame 递增 + jitter/reprojection + resolve/swap + URL 开关

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`
- Modify: `packages/cesium-clouds/src/cloudsDefaultParameters.ts`（temporal 参数组）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`（扩展）

**Interfaces:**
- Consumes: T1 `computeTemporalJitter/buildReprojectionMatrices/TemporalCameraSnapshot`、T4 `createCloudsResolvePass`、T5 `ShadowPass.setCurrentMatrices`、T6 `CloudsPass.temporalUpscale/marchWidth/marchHeight/depthVelocityTexture`。
- Produces:
  - `CloudsStageOptions` 增加 `temporal?: boolean`（默认 true）、`shadowTemporal?: boolean`（默认 true）。
  - `CloudsParameters` 增加：

```ts
  // ── M4 temporal ──
  /** 云 resolve variance clipping γ（three 默认 2）。 */
  temporalVarianceGamma: number
  /** 云 resolve temporal 混合 α（three 默认 0.1；upscale 分支不消费，TAA 分支用）。 */
  temporalAlpha: number
  /** BSM resolve variance clipping γ（three 默认 1）。 */
  shadowResolveVarianceGamma: number
  /** BSM resolve temporal 混合 α（three 默认 0.01——BSM 单像素闪烁显眼，极慢混合）。 */
  shadowResolveTemporalAlpha: number
```

（`defaultCloudsParameters()` 返回值同步加 4 个字段：2 / 0.1 / 1 / 0.01。）

- 编排契约（本任务的实现规格，逐帧 preRender 顺序）：

```
1. resolvePass?.swapBuffers()            ← 最前（D2：swap 后 history=上帧输出、resolve=待写）
2. if (temporal || shadowTemporal) params.frame++   ← D7：单端全关时不递增（M3 行为）
3. altitudeCorrection / sunDirection 更新（现有，不动）
4. jitter/reprojection（temporal 时）：
     computeTemporalJitter(params.frame, cloudsPass.marchWidth, cloudsPass.marchHeight, params.temporalJitter)
     取完整视锥矩阵：camera.viewMatrix / camera.frustum.projectionMatrix / camera.inverseViewMatrix
     buildReprojectionMatrices(prevCamera, view, proj, invView, params.temporalJitter,
       { reprojectionMatrix: params.reprojectionMatrix, viewReprojectionMatrix: params.viewReprojectionMatrix })
     ⚠️ 写入 params 的既有 Matrix4 实例（Matrix4.clone 覆写，不换引用——uniformMap 闭包持引用）
     prevCamera ← { viewMatrix: clone(本帧 view), projectionMatrix: clone(本帧 proj) }（帧末存）
5. BSM（现有 cascades.update 段内）：
     cascades.update(...) 后 shadowPass.setCurrentMatrices(shadowMatrices)
     （render 内部自动：velocity 用 prevMatrices → resolve → swap → prevMatrices←本帧）
     ShadowPass 构造传 temporalPass: options.shadowTemporal !== false
6. render 后 state.shadow.bsm = shadowPass.bsmTexture（现有——T5 后 getter 已返回 resolve 输出）
```

- frame uniform 拆分（D7）：`createCloudsPass` 内 uniformMap 在共享段后覆写 `frame: () => temporalUpscale ? params.frame : 0`；`createCloudsStage` 组 `shadowUniformMap` 时在 `...buildSharedCloudsUniforms(...)` 后覆写 `frame: () => shadowTemporal ? params.frame : 0`。

- overlay 的 `u_cloudsBuffer` 闭包切换：temporal 时 `() => resolvePass.getResolvedBridge()`，否则 `() => cloudsPass.getColorBridge()`。

- [ ] **Step 1: 写失败测试（createCloudsStage.test.ts 追加）**

```ts
describe('M4 T7 temporal 编排', () => {
  it('temporal 默认开：创建 CloudsResolvePass 且 primitive add 顺序 = march 先 resolve 后', () => {
    const { scene, handle } = createStage({ clouds: true }) // 文件现有 mock scene/handler 手法
    const added = scene.primitives.add.mock.calls.map((c) => c[0])
    expect(added.length).toBeGreaterThanOrEqual(2)
    expect(added[0]).toBe((handle.cloudsPass as any).primitive)
    // resolve primitive 是第二实例（CloudsResolvePass.primitive）
    expect(added[1]).toBeTruthy()
  })

  it('frame 每帧递增 + temporalJitter 写入 params（Bayer 相位随帧变化）', () => {
    const { scene, firePreRender, params } = createStage({ clouds: true })
    firePreRender(); firePreRender(); firePreRender()
    expect(params.frame).toBe(3)
    // frame 1 与 2 的 jitter 不同（Bayer 表不同相位）
    const j1 = Cartesian2.clone(params.temporalJitter)
    firePreRender()
    expect(params.frame).toBe(4)
    expect(params.temporalJitter.x).not.toBeCloseTo(j1.x, 6) // 4×4 表相邻相位不同
  })

  it('temporalJitter=0 时 reprojectionMatrix = jittered prevP*prevV（mock 相机静止 → velocity=0 路径）', () => {
    const { firePreRender, params, camera } = createStage({ clouds: true })
    firePreRender()
    firePreRender()
    // 静止相机：prev=current → reprojection 投影回自身。断言 viewReprojection = reprojection * invView
    const expected = Matrix4.multiply(
      params.reprojectionMatrix,
      camera.inverseViewMatrix,
      new Matrix4()
    )
    expect(Matrix4.equals(params.viewReprojectionMatrix, expected)).toBe(true)
  })

  it('temporal=false：不建 resolvePass、march 全分（M3 零回归）+ march frame uniform 恒 0（D7 拆分）', () => {
    const { handle, params, firePreRender, captureMarchUniformMap } = createStage({
      clouds: true,
      temporal: false
    })
    expect((handle.cloudsPass as any).colorTexture.width).toBe(1920) // mock 全分
    firePreRender()
    // params.frame 仍递增（shadowTemporal 默认 true——BSM jitter 需要），但 march 的
    // frame uniform 恒 0（temporal=false → M3 静态噪声，D7 拆分绑定）
    expect(params.frame).toBe(1)
    expect(captureMarchUniformMap().frame()).toBe(0)
  })
})
```

> `createStage/firePreRender` 是测试内组装 helper（按 createCloudsStage.test.ts 现有 mock scene + `scene.preRender.addEventListener` 捕获 listener 的手法构造——该文件已捕获过 listener 调 BSM 编排断言，沿用）。断言细节以现有文件手法适配，**语义不变**。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts
```

- [ ] **Step 3: 实现 createCloudsStage.ts**

(a) options 加 `temporal?: boolean`（默认 true）/`shadowTemporal?: boolean`（默认 true）字段与注释。

(b) `const temporal = options.temporal !== false`；`const shadowTemporal = options.shadowTemporal !== false`。

(c) `createCloudsPass(scene, luts, weather, state, { ...options, parameters: params, temporalUpscale: temporal })`。**`CloudsPass.ts`（T6 已加 `temporalUpscale`）的 uniformMap 在共享段之后覆写**：

```ts
    // D7 frame 拆分：march 的 stbn 噪声相位只在 temporal 开时跟随 params.frame 递增
    //（无 temporal resolve 平滑时逐帧换相位 = 回归闪烁；M3 行为 = 恒 0）
    frame: () => (temporalUpscale ? params.frame : 0),
```

（此覆写在 T6 实现段一并落地——T7 测试消费；若 T6 已写 `frame: () => params.frame` 则 T7 修正。）

(d) `createCloudsStage` 组 `shadowUniformMap` 处（现有 `...buildSharedCloudsUniforms(...)` 之后）覆写：

```ts
    // D7 frame 拆分：BSM 生成端同理（shadowTemporal 关 → 恒 0 = M3 静态 jitter）
    frame: () => (shadowTemporal ? params.frame : 0),
```

(e) ShadowPass 构造 options 加 `temporalPass: shadowTemporal`。

(f) resolve pass（temporal 时）：

```ts
  // ── M4 云 resolve Pass（temporal 时；primitive add 在 march 之后——D1 执行顺序契约）──
  const resolvePass = temporal
    ? createCloudsResolvePass({
        context,
        width: context.drawingBufferWidth,
        height: context.drawingBufferHeight,
        pixelDatatype: resolveCloudsHdrDatatype(scene),
        colorBuffer: cloudsPass.colorTexture,
        depthVelocityBuffer: cloudsPass.depthVelocityTexture,
        frame: () => params.frame,
        varianceGamma: params.temporalVarianceGamma,
        temporalAlpha: params.temporalAlpha
      })
    : undefined
  if (resolvePass != null) {
    ;(scene.primitives as unknown as { add: (p: unknown) => void }).add(resolvePass.primitive)
  }
```

(g) overlay `u_cloudsBuffer` 闭包切换：

```ts
      u_cloudsBuffer: () =>
        resolvePass != null ? resolvePass.getResolvedBridge() : cloudsPass.getColorBridge(),
```

(h) preRender listener 改造（现有函数体头部插入 + BSM 段内插一行）：

```ts
      // ── M4 temporal：swap 最前（D2：history=上帧输出、resolve=待写）+ frame 递增（D7：
      //    单端全关时不递增；march/BSM 生成端的 frame uniform 已按各端开关拆分绑定）──
      resolvePass?.swapBuffers()
      if (temporal || shadowTemporal) {
        params.frame++
      }

      // ……（现有 altitudeCorrection / sunDirection 更新不动）……

      // ── M4 temporal：jitter + reprojection 矩阵（march velocity 两分支 + ray 重建消费）──
      if (temporal) {
        computeTemporalJitter(
          params.frame,
          cloudsPass.marchWidth,
          cloudsPass.marchHeight,
          params.temporalJitter
        )
        const viewMatrix = camera.viewMatrix
        const projectionMatrix = (camera.frustum as unknown as { projectionMatrix: Matrix4 })
          .projectionMatrix
        buildReprojectionMatrices(
          prevCamera,
          viewMatrix,
          projectionMatrix,
          camera.inverseViewMatrix,
          params.temporalJitter,
          {
            reprojectionMatrix: params.reprojectionMatrix,
            viewReprojectionMatrix: params.viewReprojectionMatrix
          }
        )
        // 帧末存本帧快照（clone——Cesium camera 矩阵是 live getter，必须拷贝）
        Matrix4.clone(viewMatrix, prevCamera.viewMatrix)
        Matrix4.clone(projectionMatrix, prevCamera.projectionMatrix)
      }
```

`prevCamera` 声明（listener 外）：`const prevCamera: TemporalCameraSnapshot = { viewMatrix: new Matrix4(), projectionMatrix: new Matrix4() }`——首帧 buildReprojectionMatrices 收到的是「零矩阵」而非 undefined？⚠️ 首帧语义：three fallback 当前帧矩阵（velocity=0）。用 `let hasPrevCamera = false` 标志：首帧传 `undefined`，帧末置 true。或初始化 prevCamera 为 undefined-able：`let prevCamera: TemporalCameraSnapshot | undefined`，帧末 `prevCamera = { viewMatrix: Matrix4.clone(...), projectionMatrix: Matrix4.clone(...) }`。

BSM 段内（`cascades.update(...)` 与矩阵 clone 循环之后、`shadowPass.render()` 之前）：

```ts
        // M4：本帧矩阵先登记（render 内部 velocity 用 prevMatrices=上帧、末尾 prev←本帧）
        shadowPass.setCurrentMatrices(shadowMatrices)
```

(i) destroy 顺序补 `resolvePass?.destroy()`（march destroy 后、shadowPass 前）+ import（`computeTemporalJitter/buildReprojectionMatrices/TemporalCameraSnapshot` from './temporalMath'、`createCloudsResolvePass` from './CloudsResolvePass'）。

(j) 文件头注释补 M4 段（编排契约 + D1/D2/D7 引用）。

- [ ] **Step 4: 跑测试确认通过 + 包全量 + tsc**

```bash
pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts
pnpm --filter @cesium-geospatial/clouds test
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/cloudsDefaultParameters.ts packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "feat(clouds): M4 T7 编排——frame 递增 + Bayer jitter/reprojection 矩阵 + resolve swap/bridge 切换 + temporal URL 开关"
```

---

### Task 8: demo URL 参数 + 视觉验收 + results 文档

**Files:**
- Modify: `apps/demo/src/main.ts`
- Create: `docs/superpowers/plans/2026-08-17-clouds-m4-temporal-results.md`

**Interfaces:**
- Consumes: T7 的 `temporal`/`shadowTemporal` options。
- Produces: demo URL `cloudsTemporal=0|1`（默认 1）、`cloudsShadowTemporal=0|1`（默认 1）。

- [ ] **Step 1: main.ts URL 解析**

在现有 clouds 参数解析处（`cloudsShadow` 旁）加：

```ts
  // M4 temporal 开关（默认开；0 = 诊断基线：云端回 M3 全分无 resolve / BSM 端回 M3 无 temporal）
  const cloudsTemporal = params.get('cloudsTemporal') !== '0'
  const cloudsShadowTemporal = params.get('cloudsShadowTemporal') !== '0'
```

`createCloudsStage(...)` 调用透传 `temporal: cloudsTemporal, shadowTemporal: cloudsShadowTemporal`。

- [ ] **Step 2: 单测/编译回归**

```bash
pnpm test
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
```

- [ ] **Step 3: Commit（代码部分）**

```bash
git add apps/demo/src/main.ts
git commit -m "feat(demo): M4 temporal URL 开关 cloudsTemporal/cloudsShadowTemporal"
```

- [ ] **Step 4: 视觉验收（用户参与）**

启动 `pnpm dev`（后台），给出验收 URL 并等用户确认（现在本地深夜——带白天 time 参数）：

```
主验收（temporal 默认开，1/4 分 + resolve）：
http://localhost:5173/?mode=atmosphere&clouds=1&camera=54.2518,37.3749,-12,279.9,0.6&time=2026-08-15T13:41:00Z

诊断基线 A（M3 行为，全分无 resolve）：
…&cloudsTemporal=0

诊断基线 B（BSM 无 temporal）：
…&cloudsShadowTemporal=0
```

验收点（spec §6 M4）：
1. **云边缘干净无 banding**：主验收 vs 基线 A——1/4 分 march 的块状边缘经 Bayer 重建后应无可见网格/banding（相机静止 1–2 秒后收敛）。
2. **动态相机拖影可接受**：缓慢拖动相机——云边缘短暂拖影后收敛为可接受（ghosting 是 variance clipping 大 γ 的已知权衡，three 注释同款）。
3. **1/4 分静态收敛近全分**：静止数秒后云细节接近基线 A 的全分质感。
4. **BSM 自阴影无闪烁**：`cloudsShadowTemporal=0/1` 对比——temporal 后 BSM 单像素闪烁应消失/减弱（temporalAlpha=0.01 慢收敛）。
5. **性能**：主验收帧率应显著高于基线 A（march 像素量 1/16）。
6. 既有回归：水下四视角、天空/大气正常。

若验收不过的已知抓手：拖影过重 → `temporalVarianceGamma` 降（2→1.5）；云场演化区糊（spec 已知限制）；resolve 顺序异常（云不显示/全黑）→ 检查 primitive add 顺序与 swap 时机（D1/D2）。

- [ ] **Step 5: results 文档 + 终审**

用户验收通过后写 `docs/superpowers/plans/2026-08-17-clouds-m4-temporal-results.md`（对齐 M3 results 格式：任务清单、测试统计、决策记录、验收截图说明、已知限制）并 commit：

```bash
git add docs/superpowers/plans/2026-08-17-clouds-m4-temporal-results.md
git commit -m "docs(clouds): M4 results——temporal resolve 全过（1/4 分 Bayer 重建 + BSM temporal + 编排契约）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§6 M4 的 CloudsResolveMaterial（T2）/ history ping-pong（T4）/ velocity reprojection（T1+T6+T7）/ variance clipping（T2+T3 内联资产）/ Bayer 4×4 jitter（T1+T7）/ 1/4 分→全分（T4+T6）全覆盖；BSM temporal resolve（记忆锚点「ShadowMaterial 删掉的 TEMPORAL_PASS 段加回」）由 T3+T5 覆盖；验收三条对应 T8 Step 4。r1「不复用 depthTemporal」遵守（自建 ping-pong，D2）。
- **占位符扫描**：测试 helper（`createStage/firePreRender/captureUniformMap/mkLuts` 等）均指向既有测试文件的现成手法并注明「按现有文件适配，断言语义不变」——这是对既有代码的复用指引而非未定义引用；所有新函数/类型有完整签名与实现代码。
- **类型一致性**：`computeTemporalJitter(frame, lowResWidth, lowResHeight, result)` T1 定义 = T7 调用；`buildReprojectionMatrices(previous, currentViewMatrix, currentProjectionMatrix, currentInverseViewMatrix, jitter, result)` 六参一致；`CloudsResolvePass.resolvedTexture/primitive/swapBuffers/getResolvedBridge/destroy` T4 定义 = T7 消费；`ShadowPass.setCurrentMatrices(matrices)` T5 定义 = T7 调用；`CloudsPass.depthVelocityTexture/marchWidth/marchHeight/temporalUpscale` T6 定义 = T4/T7 消费。
- **已知风险**（评审关注点）：① T3 手术锚点（shadowResolve.frag 的 cascade 签名/`replaceAll('cascadeIndex',...)` 的副作用）需实现时 grep 核对——测试兜底；② D1 执行顺序依赖 PrimitiveCollection 数组序（Cesium 源码行为，无公开 API 保证）——T8 视觉验收兜底（云不显示即顺序假设破裂，回落方案：resolve primitive 改 pass 更后的自定义值或 preUpdate 手动 execute）；③ hitClouds velocity 走 ECEF 大坐标（D5 论证误差 ~1e-6 UV，验收兜底）；④ T4 swap 用双 primitive 轮换 + 稳定外壳（自审已消除「swap 重建致 collection 引用失效」缺陷——评审复核 shell.update 转发与 destroy 幂等）。
