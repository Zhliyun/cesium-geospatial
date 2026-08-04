// 运动门控：position + direction 双项 + 高度归一化。
// 评审 critical：旧 ShadowResolvePass 只检测 positionDelta，旋转/orbit 时 positionDelta 小但画面大变 → 旁路门控 → 拖影。
// direction 项（1 - dot(dir, prevDir)）补这个缺口：旋转/orbit 必走高 alpha（偏 current）。
import { DIRECTION_WEIGHT } from './depthTemporalConstants'

export interface TemporalAlphaInput {
  cameraHeight: number
  maxDelta: number // cameraHeight * MAX_DELTA_K（高度归一化，1Mm → 10km）
  positionDelta: number // distance(positionWC, prevPositionWC)，平移量
  directionDelta: number // 1 - dot(directionWC, prevDir)，旋转量（0=同向，2=反向）
  lowAlpha: number
  highAlpha: number
}

// 标准 smoothstep（GLSL 内建不可在 TS 用，本地实现）。
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// 计算 EMA 时变 alpha：静止 → lowAlpha（强平滑/history 主导）→ 运动 → highAlpha（偏 current/减拖影）。
// motion = positionDelta/maxDelta + DIRECTION_WEIGHT * directionDelta（position 项归一化到 maxDelta，高度自适应）。
export function computeTemporalAlpha(input: TemporalAlphaInput): number {
  const motion =
    input.positionDelta / input.maxDelta + DIRECTION_WEIGHT * input.directionDelta
  const t = smoothstep(0, 1, motion)
  return input.lowAlpha + (input.highAlpha - input.lowAlpha) * t
}
