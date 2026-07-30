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
 *
 * 投影那步留给调用方（Cesium 侧用 `scene.camera.frustum.projectionMatrix`
 * 或着色器内 `czm_projectionMatrix` 计算），本模块只接收已算好的
 * `projectedScale.y`，保持函数纯净可测。
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
 * @param cameraHeightM 相机椭球高度（米）。投影步骤已在调用方完成，此参数
 *   不参与公式，仅用于调用约定对齐与日志/调试。
 * @param projectedScaleY 已算好的 projectedScale.y：
 *   `projectionMatrix * vec3(0, ellipsoidMaximumRadius, -max(0, cameraHeightM))` 的 y 分量。
 * @param near 反向映射上界（默认 41.5，Cesium FOV 60° 需重标定）
 * @param far 反向映射下界（默认 13.8，Cesium FOV 60° 需重标定）
 * @returns [0, 1]：0 = 保留地形法线（近），1 = 椭球法线压噪声（远）
 */
export function computeGeometricErrorCorrectionAmount(
  cameraHeightM: number,
  projectedScaleY: number,
  near: number = GEO_ERROR_CORRECTION_NEAR,
  far: number = GEO_ERROR_CORRECTION_FAR
): number {
  // cameraHeightM 不参与计算（投影已在外部完成），保留以对齐源公式调用约定
  void cameraHeightM
  return remapClamp(projectedScaleY, near, far)
}
