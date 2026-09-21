// shadowBudgetAdaptation.ts
//
// 云预算自适应曲线——A 太阳角影子预算（spec
// docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md §3（r3，B 已弃案））。
// 月光门控的连续化推广，方案 1 开环确定性。纯函数模块：全部 JS 侧数学。
// 常数已定稿（Phase 0 2026-09-04 实测回填）。
import { Cartesian3 } from 'cesium'

/** 自适应预算常数（spec §2 常数表，已定稿回填）。 */
export const ADAPTIVE_BUDGET_CONSTANTS = {
  /** A：乘数=1 的太阳仰角下界（零回归域边界；硬上限 30°——spec §8）。 */
  SUN_ELEV_FULL_DEG: 20, // 定稿 20°（Phase 0 2026-09-04 实测；硬上限 30°）
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
 * 契约：sunDirection 须为 ECEF 单位向量（createCloudsStage preRender normalize 后的
 * state.sunDirection 满足；非单位向量将系统性抬高/压低仰角读数）。
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

// ── P4 兜底光柱步幅自适应（2026-09-21）──
// 兜底分支（!hitClouds）marchShadowLength 成本 ∝ 无云像素占比，随时刻/天气漂移
// （2026-09-21 实测：同机位当前时刻兜底 ~10ms vs 2026-09-05 定标场景 ~3.3ms——
// 该日午后远云排占满天空、09-21 上午天空开阔无云像素多）。倍率上限据 2026-09-05
// 真机定标：×4 白天（高太阳角）逐位零差，仅低太阳角日落海面伤画质（meanΔ13）——
// 与 A 预算同构：高角受益域放开到 MAX，低角保守域守 P3 定稿值 MIN。
export const SHADOW_FALLBACK_SCALE_MIN = 2.0
export const SHADOW_FALLBACK_SCALE_MAX = 4.0

/**
 * P4 兜底步幅乘数：elev≤floor → MIN（P3 定稿 ×2，低角零回归域）；elev≥full → MAX
 * （×4 白天逐位零差域）；中间 smoothstep（复用 A 预算 5°/20° 同曲线）。低角端输出恒
 * =P3 define 2.0，故 ?cloudsShadowAdaptive=0 回退语义=「回到 2026-09-05 静态行为」。
 */
export function shadowFallbackStepScale(
  sunElevDeg: number, fullDeg: number, floorDeg: number
): number {
  return (
    SHADOW_FALLBACK_SCALE_MIN +
    (SHADOW_FALLBACK_SCALE_MAX - SHADOW_FALLBACK_SCALE_MIN) * smoothstep(floorDeg, fullDeg, sunElevDeg)
  )
}
