// shadowBudgetAdaptation.ts
//
// 云预算自适应曲线——A 太阳角影子预算（spec
// docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md §3（r3，B 已弃案））。
// 月光门控的连续化推广，方案 1 开环确定性。纯函数模块：全部 JS 侧数学。
// 常数=起草值（Phase 0 定稿回填）。
import { Cartesian3 } from 'cesium'

/** 自适应预算常数（spec §2 起草常数表；定稿后回填并删「起草」注）。 */
export const ADAPTIVE_BUDGET_CONSTANTS = {
  /** A：乘数=1 的太阳仰角下界（零回归域边界；硬上限 30°——spec §8）。 */
  SUN_ELEV_FULL_DEG: 20, // 起草值，Phase 0 定稿
  /** A：乘数=FLOOR 的太阳仰角上界。 */
  SUN_ELEV_FLOOR_DEG: 5,
  /** A：影子预算乘数下限（硬下界 0.5——spec §3 覆盖约束+§8 红线）。 */
  BUDGET_FLOOR: 0.5
} as const

/** GLSL smoothstep 同式（edge0<edge1 前提由调用方保证——勿反向，r1 C2 教训）。 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const DEG = 180 / Math.PI

/**
 * 当地太阳仰角（度）。r1 C1 修正：dot(sunDir, ECEF z)=赤纬（全球恒值），必须点
 * 相机当地径向——与 clouds.frag:594 muSunLocal=dot(surfaceNormal,sunDirection) 同语义。
 * 贴地机位与云域 up 差 <0.1°，由校准吸收（spec §3）。
 */
export function localSunElevationDeg(sunDirection: Cartesian3, cameraPositionWC: Cartesian3): number {
  const r = Math.sqrt(
    cameraPositionWC.x * cameraPositionWC.x +
    cameraPositionWC.y * cameraPositionWC.y +
    cameraPositionWC.z * cameraPositionWC.z
  )
  const mu =
    (cameraPositionWC.x * sunDirection.x +
      cameraPositionWC.y * sunDirection.y +
      cameraPositionWC.z * sunDirection.z) / r
  return Math.asin(Math.min(1, Math.max(-1, mu))) * DEG
}

/**
 * A 影子预算乘数：elev≥full → 1（零回归域）；elev≤floor → budgetFloor；中间 smoothstep。
 * r1 C2 修正：high=1/low=FLOOR 的方向（r1 公式 smoothstep 边序写反双向失败）。
 */
export function shadowBudgetMultiplier(
  sunElevDeg: number, fullDeg: number, floorDeg: number, budgetFloor: number
): number {
  const s = smoothstep(floorDeg, fullDeg, sunElevDeg)
  return budgetFloor + (1 - budgetFloor) * s
}

/** BSM 生成端步数缩放（钳 1 下防 for 空转 sampleCount=0 无影——渲染专家 m6）。 */
export function scaledShadowMaxIterations(baseMaxIterations: number, mult: number): number {
  return Math.max(1, Math.round(baseMaxIterations * mult))
}
