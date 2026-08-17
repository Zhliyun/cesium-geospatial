// CascadedShadowMaps.ts
//
// M3 T1：sun-POV 级联正交 shadow 相机（three-geospatial CascadedShadowMaps.ts 的 Cesium 移植）。
//
// Based on the following work with slight modifications.
// https://github.com/StrandedKitty/three-csm/
// https://github.com/mrdoob/three.js/tree/r169/examples/jsm/csm
//
// MIT License
//
// Copyright (c) 2019 vtHawk
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// 职责：把主相机视锥按 practical split 切 N 段，每段在 light space 求正交包围盒（texel 对齐），
// 产出 per-cascade {matrix（world→light clip）, inverseMatrix（clip→world）, interval（归一化视深）}。
// 纯 TS 数学（Cesium Matrix4/Cartesian3），无 GL / 无 scene 依赖 → node 单测。
//
// three → Cesium 的矩阵语义对照：
//   camera.matrixWorld        → CascadeCameraInput.inverseViewMatrix（ECEF world 系相机位姿）
//   camera.projectionMatrixInverse → Matrix4.inverse(camera.projectionMatrix)（本文件内算）
//   Matrix4.lookAt(eye,target,up)  → lookAtMatrix（zAxis = normalize(eye - target)；three 同式）
//   Matrix4.makeOrthographic(l,r,top,bottom,n,f) → Matrix4.computeOrthographicOffCenter(l,r,bottom,top,n,f)
//     （注意参数顺序：three (l,r,top,bottom) vs Cesium (l,r,bottom,top)）
import { Cartesian2, Cartesian3, Cartesian4, Matrix3, Matrix4 } from 'cesium'

export interface Cascade {
  /** 归一化视深区间 [x,y)（viewZToOrthographicDepth 域，末段 y=1）。 */
  interval: Cartesian2
  /** ECEF world → light clip（消费端 getShadowUv 用）。 */
  matrix: Matrix4
  /** light clip → ECEF world（shadow.frag cascade() 用 z=-1 反投影太阳侧起点）。 */
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
  /** 级联段数（three 版最多 4，与 BSM array texture 层数对应）。 */
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
// near/far 各 4 角（clip 反投影到 camera-local），far 角再沿视线截断到给定 far（防止极端 fovy 越界）。
// 注意：角点在 camera-local 系（未乘 matrixWorld），后续经 cameraToLight 变换到 light 系。
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
      // NDC → camera-local：齐次反投影（w 除）。near 平面 z=-1 的点在透视下 w=near，除后距离=near。
      this.near[i] = unproject(invProj, nearNdc[i], this.near[i])
      const f = unproject(invProj, farNdc[i], this.far[i])
      // far 截断（three：按视深 |z|，multiplyScalar(Math.min(far/absZ, 1))——只截不放大。
      // 不能按欧氏范数：对角射线角点会被拉近到 cos(对角半张角)·far，末段 ortho 盒收窄 20%+）
      const absZ = Math.abs(f.z)
      if (absZ > far) Cartesian3.multiplyByScalar(f, far / absZ, f)
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
    result.length = clipDepths.length
    return result
  }
}

function unproject(invProj: Matrix4, ndc: Cartesian3, result: Cartesian3): Cartesian3 {
  const v = new Cartesian4(ndc.x, ndc.y, ndc.z, 1.0)
  Matrix4.multiplyByVector(invProj, v, v)
  return Cartesian3.fromElements(v.x / v.w, v.y / v.w, v.z / v.w, result)
}

// ── three Matrix4.lookAt 的 Cesium 等价（three 语义：zAxis = normalize(eye - target)，basis 列 = (x,y,z)）──
function lookAtMatrix(
  eye: Cartesian3, target: Cartesian3, up: Cartesian3, result: Matrix4
): Matrix4 {
  const zAxis = Cartesian3.normalize(
    Cartesian3.subtract(eye, target, new Cartesian3()), new Cartesian3()
  )
  let xAxis = Cartesian3.cross(up, zAxis, new Cartesian3())
  // 极区退化保护（three 是扰动 zAxis 0.0001 再重算；此处换 fallback up，效果同为正交基）：
  // sunDir ∥ up=(0,1,0) 时 cross=0 → 用 (1,0,0)（此时 zAxis 必为 (0,±1,0)，与 (1,0,0) 不平行）
  if (Cartesian3.magnitude(xAxis) < 1e-9) {
    xAxis = Cartesian3.cross(new Cartesian3(1, 0, 0), zAxis, new Cartesian3())
  }
  Cartesian3.normalize(xAxis, xAxis)
  const yAxis = Cartesian3.cross(zAxis, xAxis, new Cartesian3())
  // basis 列 = (x,y,z)。⚠️ Cesium Matrix3/4 构造参数是 row-major 传入（参数名 columnNRowM，
  // 第一组三个 = 第 0 行的三列）——「列=basis」矩阵的正确参数序是逐行写各 basis 的分量
  //（M3 初版把 xAxis 填在第 0 组=第 0 行 → 旋转矩阵被转置；极点轴对齐场景 rot=identity
  // 转置不变被掩盖，2026-08-18 BSM 光深排查实锤：生产朝向下级联盒中心偏 189km、UV 全越界）。
  const rot = new Matrix3(
    xAxis.x, yAxis.x, zAxis.x,
    xAxis.y, yAxis.y, zAxis.y,
    xAxis.z, yAxis.z, zAxis.z
  )
  return Matrix4.fromRotationTranslation(rot, eye, result)
}

/** three Object3D.DEFAULT_UP（light 朝向 up；world=ECEF 下即 Y 轴）。 */
const UP = new Cartesian3(0, 1, 0)

export class CascadedShadowMaps {
  readonly cascades: Cascade[] = []
  readonly mapSize: number
  readonly splitLambda: number
  readonly fade: boolean
  readonly margin: number
  /** 最近一次 update 用的 far（= camera.far）。 */
  far = 0

  private readonly cameraFrustum = new FrustumCorners()
  private readonly frusta: FrustumCorners[] = []
  private readonly lightFrustum = new FrustumCorners() // 每 cascade 复用（three scratch 风格）
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

  /**
   * @param sunDirection 指向太阳的单位向量（ECEF world 系；与 camera.inverseViewMatrix 同系）
   * @param distance shadow 相机沿 sunDirection 相对包盒的偏移（three 默认 1；
   *   ortho 盒深 = radius*2 + margin，distance 过大时场景会超出盒深——编排侧应传小值）
   */
  update(camera: CascadeCameraInput, sunDirection: Cartesian3, distance = 1): void {
    const far = camera.far
    this.far = far

    // 1) 切分区间 + 子视锥角点（camera-local 系）
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
    //    lightOrientation：位于原点、zAxis = normalize(0 - (-sunDir)) = sunDirection（+Z 指向太阳）
    const lightOrientation = lookAtMatrix(
      Cartesian3.ZERO, Cartesian3.multiplyByScalar(sunDirection, -1, new Cartesian3()),
      UP, new Matrix4()
    )
    const invLightOrientation = Matrix4.inverse(lightOrientation, new Matrix4())
    // cameraToLight = inv(lightOrientation) × cameraWorld（camera-local 点 → light 旋转系；
    // light 旋转系原点仍在 world 原点——ECEF 下即地心）
    const cameraToLight = Matrix4.multiply(
      invLightOrientation, camera.inverseViewMatrix, new Matrix4()
    )

    // 3) 每 cascade：ortho 包围盒 + texel 对齐 center + light 相机矩阵
    for (let i = 0; i < this.cascadeCount; ++i) {
      const cascade = this.cascades[i]
      const frustum = this.frusta[i]
      // light space 下的 8 角（bbox 用；diagonal 距离是旋转不变量，在 camera-local 系算等价）
      for (let j = 0; j < 4; ++j) {
        Matrix4.multiplyByPoint(cameraToLight, frustum.near[j], this.lightFrustum.near[j])
        Matrix4.multiplyByPoint(cameraToLight, frustum.far[j], this.lightFrustum.far[j])
      }
      // 对角线半径（three getFrustumRadius：max(far 面对角, 全视锥对角)×0.5 + fade 扩张）。
      // fade 的 z 分量必须取 camera-local z（= 视线深度，|z| ≤ far）；light 旋转系原点在地心，
      // 其 z ≈ 6.4e6，若在该系取值会把扩张量放大 ~30×（ECEF 移植坑，three 原版即在变换前取值）。
      let diagonal = Math.max(
        Cartesian3.distance(frustum.far[0], frustum.far[2]),
        Cartesian3.distance(frustum.far[0], frustum.near[2])
      )
      if (this.fade) {
        // three：diagonal += 0.25 × (farCorner.z/(far-near))² × (far-near)
        const zRatio = frustum.far[0].z / (far - camera.near)
        diagonal += 0.25 * zRatio * zRatio * (far - camera.near)
      }
      const radius = diagonal * 0.5

      // ortho 投影（注意 Cesium 参数序 (l,r,bottom,top,near,far)；three 是 (l,r,top,bottom,n,f)）
      Matrix4.computeOrthographicOffCenter(
        -radius, radius, -radius, radius, -this.margin, radius * 2 + this.margin,
        cascade.projectionMatrix
      )

      // bbox center（light space 8 角包围盒；z 取 max.z + margin = 最靠太阳侧的面外 margin）
      const min = new Cartesian3(
        Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY
      )
      const max = new Cartesian3(
        Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY
      )
      for (let j = 0; j < 4; ++j) {
        for (const p of [this.lightFrustum.near[j], this.lightFrustum.far[j]]) {
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

      // light 相机：position = sunDirection×distance + centerWorld（world 系，朝太阳侧偏移），
      // centerWorld = lightOrientation × center（light 旋转系 → world）。
      const centerWorld = Matrix4.multiplyByPoint(lightOrientation, center, new Cartesian3())
      const position = Cartesian3.add(
        Cartesian3.multiplyByScalar(sunDirection, distance, new Cartesian3()),
        centerWorld,
        new Cartesian3()
      )
      // 朝向取 zAxis = +sunDirection（相机 -Z 视线沿 -sunDirection 朝场景）：
      // three 原式 lookAt(center, position) 的 zAxis = -sunDirection，与本写法差一个绕 up 的 180°
      // 旋转（x 镜像）。BSM 管线（生成 shadow.frag z=-1 反投影 + 消费 getShadowUv）只在 clip.x,y
      // 取 uv、深度在 ray 距离域比较，生成/消费共用同一矩阵 → 两种朝向数学等价；此处取「看向
      // 场景」的自然朝向，使 clip.z 语义（[-1,1] ↔ 场景盒）在 cascade 调试可视化/未来 z 剔除下默认正确。
      lookAtMatrix(position, centerWorld, UP, cascade.inverseViewMatrix)

      // 4) 派生矩阵（对齐 three update 末尾六件套）
      Matrix4.inverse(cascade.projectionMatrix, cascade.inverseProjectionMatrix)
      Matrix4.inverse(cascade.inverseViewMatrix, cascade.viewMatrix)
      Matrix4.multiply(cascade.projectionMatrix, cascade.viewMatrix, cascade.matrix)
      Matrix4.multiply(cascade.inverseViewMatrix, cascade.inverseProjectionMatrix, cascade.inverseMatrix)
    }
  }
}
