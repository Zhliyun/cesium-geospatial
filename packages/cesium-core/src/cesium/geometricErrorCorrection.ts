/**
 * geometricErrorCorrectionAmount 每帧 CPU 计算。
 *
 * 复刻源仓库（three.js）`AerialPerspectiveEffect.ts:352-366`：
 * ```js
 * const cameraHeight = geodetic.setFromECEF(cameraPositionECEF).height
 * const projectedScale = vec
 *   .set(0, ellipsoid.maximumRadius, -Math.max(0, cameraHeight))
 *   .applyMatrix4(projectionMatrix)
 * amount = saturate(remap(projectedScale.y, 41.5, 13.8, 0, 1))
 * ```
 * 投影步骤在模块内完成：projectionMatrix 以列主序 number[16] 传入
 * （Cesium `Matrix4` 内部即列主序 number[]，可直接传
 * `scene.camera.frustum.projectionMatrix`）。
 *
 * 方向说明（重要）：
 * - 透视投影下 projectedScale.y ≈ (ellipsoidMaximumRadius / tan(fov/2)) / cameraHeight，
 *   即相机越近 y 越大，相机越远 y 越小。
 * - remap 的区间是 a=41.5 > b=13.8 的**反向映射**：y 大（相机近）→ amount 小
 *   （保留真实地形的法线细节）；y 小（相机远/太空）→ amount 大
 *   （用椭球法线压制远处几何误差带来的法线噪声）。
 *
 * 常数标定：
 * - 默认 41.5 / 13.8 绑定 three.js 投影（FOV 50°）+ 源仓库 PR#23 的标定结果。
 * - Cesium 默认 FOV 为 60°，投影矩阵尺度不同，**这两个常数需在 Cesium 下
 *   重新标定**；因此做成可传参数，标定列为验收项。
 */

/**
 * saturate(remap(v, a, b, 0, 1))：把 v 从区间 [a, b] 线性映射到 [0, 1] 并截断。
 * 支持 a > b 的反向区间（v 越大结果越小）。
 */
export function remapClamp(v: number, a: number, b: number): number {
  const t = (v - a) / (b - a)
  return Math.min(1, Math.max(0, t))
}

/** 源公式默认标定常数（three.js FOV 50°）。Cesium FOV 60° 下需重标定。 */
export const GEO_ERROR_CORRECTION_NEAR = 41.5
export const GEO_ERROR_CORRECTION_FAR = 13.8

/**
 * 计算 geometricErrorCorrectionAmount（每帧 CPU 侧）。
 *
 * @param cameraHeightM 相机椭球高度（米），负值按 max(0, h) 处理（与源公式一致）
 * @param projectionMatrix 投影矩阵，列主序 number[16]（Cesium Matrix4 内部布局，
 *   直接传 `scene.camera.frustum.projectionMatrix` 即可）
 * @param ellipsoidMaximumRadius 椭球最大半径（米），如 WGS84 的 6378137
 * @param near 反向映射上界（默认 41.5，Cesium FOV 60° 需重标定）
 * @param far 反向映射下界（默认 13.8，Cesium FOV 60° 需重标定）
 * @returns [0, 1]：0 = 保留地形法线（近），1 = 椭球法线压噪声（远）
 */
export function computeGeometricErrorCorrectionAmount(
  cameraHeightM: number,
  projectionMatrix: ArrayLike<number>,
  ellipsoidMaximumRadius: number,
  near: number = GEO_ERROR_CORRECTION_NEAR,
  far: number = GEO_ERROR_CORRECTION_FAR
): number {
  // 源公式：projectedScale = projectionMatrix * vec4(0, R, -max(0,h), 1)，取 NDC y
  // （applyMatrix4 含透视除法）。列主序下只需 y 行（索引 1,5,9,13）
  // 与 w 行（索引 3,7,11,15）做点积再相除；x=0、w=1 可化简。
  const z = -Math.max(0, cameraHeightM)
  const clipY =
    projectionMatrix[5] * ellipsoidMaximumRadius +
    projectionMatrix[9] * z +
    projectionMatrix[13]
  const clipW =
    projectionMatrix[7] * ellipsoidMaximumRadius +
    projectionMatrix[11] * z +
    projectionMatrix[15]
  const projectedScaleY = clipY / clipW
  return remapClamp(projectedScaleY, near, far)
}
