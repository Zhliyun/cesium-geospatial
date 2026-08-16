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
        // Cartesian2 无 set 方法（three Vector2 才有）——直接字段赋值
        offset.x = ((i % 4) + 0.5) / 4
        offset.y = (Math.floor(i / 4) + 0.5) / 4
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
 *   reprojectionMatrix     = (prevP + jitter) * prevV        ← hitClouds 分支（world/ECEF 路径）
 *   viewReprojectionMatrix = reprojectionMatrix * invCurV    ← scene/ground 分支（view 路径，精度好）
 *
 * jitter 写入 prevP column2.xy（×2：NDC 域）；首帧 previous=undefined 时 fallback 当前 P/V
 * （velocity=0，three CloudsMaterial previousProjectionMatrix ?? camera.projectionMatrix 同款）。
 *
 * Cesium 适配（M4 plan D5）：矩阵域是 ECEF 世界坐标（worldToECEF=identity，viewMatrix 即相机
 * ECEF→view）；preRender 时刻 frustum.projectionMatrix 为完整视锥（multi-frustum 分段前）；
 * velocity 数学只用投影 xy 系数与 w，与 near/far 分段无关 → 分段执行下依然正确。
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
