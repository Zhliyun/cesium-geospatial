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
