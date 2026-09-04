// shadowBudgetAdaptation.test.ts —— spec docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md §3
// 自适应预算曲线（r3：B 已弃案，仅 A 太阳角影子预算；常数=起草值）
import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import {
  ADAPTIVE_BUDGET_CONSTANTS,
  localSunElevationDeg, scaledShadowMaxIterations, shadowBudgetMultiplier
} from './shadowBudgetAdaptation'

const C = ADAPTIVE_BUDGET_CONSTANTS

describe('shadowBudgetMultiplier（spec §3：高角=1 零回归、低角=FLOOR、过渡平滑）', () => {
  it('边界与域内三点（期望值按文字语义写——r1 方向反错误正是此类测试抓的）', () => {
    expect(shadowBudgetMultiplier(30, 20, 5, 0.5)).toBe(1)      // ≥FULL 零回归域
    expect(shadowBudgetMultiplier(20, 20, 5, 0.5)).toBe(1)      // =FULL
    expect(shadowBudgetMultiplier(5, 20, 5, 0.5)).toBeCloseTo(0.5, 6)  // ≤FLOOR
    expect(shadowBudgetMultiplier(0, 20, 5, 0.5)).toBeCloseTo(0.5, 6)
    const m12 = shadowBudgetMultiplier(12.5, 20, 5, 0.5)
    expect(m12).toBeGreaterThan(0.5)
    expect(m12).toBeLessThan(1)
    expect(shadowBudgetMultiplier(16, 20, 5, 0.5)).toBeGreaterThan(m12) // 单调升
  })
})

describe('localSunElevationDeg（spec §3：当地径向，非赤纬——r1 C1 修正）', () => {
  const R = 6378137
  // 相机 (R,0,0) → 当地径向 up=x 轴；太阳仰角 e ⇔ sun=(sin e, cos e, 0)（与 up 夹 90°−e）。
  // 注：brief 原稿构造 sun=(cos e, sin e, 0) 与期望仰角不自洽（搭出的是离天顶 e 而非仰角 e，
  // 实测得 90°−e）——TDD 首跑即暴露，按物理语义修构造、期望值不变。
  it('太阳仰角 30° → 返回 30°', () => {
    const e30 = Math.PI / 6
    const sun = new Cartesian3(Math.sin(e30), Math.cos(e30), 0)
    const elev = localSunElevationDeg(sun, new Cartesian3(R, 0, 0))
    expect(elev).toBeCloseTo(30, 4)
  })
  it('黄昏 10° 场景', () => {
    const e10 = Math.PI / 18
    const sun = new Cartesian3(Math.sin(e10), Math.cos(e10), 0)
    expect(localSunElevationDeg(sun, new Cartesian3(R, 0, 0))).toBeCloseTo(10, 4)
  })
  it('太阳在地平下 → 负仰角', () => {
    const e10 = Math.PI / 18
    const sun = new Cartesian3(-Math.sin(e10), Math.cos(e10), 0)
    expect(localSunElevationDeg(sun, new Cartesian3(R, 0, 0))).toBeCloseTo(-10, 4)
  })
})

describe('scaledShadowMaxIterations（spec §3：闭包返回值层，源对象不回写）', () => {
  it('乘数 1 → 原值；0.5 → 四舍五入；钳 1 下防 0 循环空转', () => {
    expect(scaledShadowMaxIterations(50, 1)).toBe(50)
    expect(scaledShadowMaxIterations(25, 0.5)).toBe(13)  // Math.round(12.5)=13（half-up）
    expect(scaledShadowMaxIterations(1, 0.1)).toBe(1)
  })
})

describe('ADAPTIVE_BUDGET_CONSTANTS 红线（spec §3/§8 硬规则）', () => {
  it('FLOOR≥0.5 硬下界、FULL≤30° 硬上界、FLOOR<FULL 门序', () => {
    expect(C.BUDGET_FLOOR).toBeGreaterThanOrEqual(0.5)
    expect(C.SUN_ELEV_FULL_DEG).toBeLessThanOrEqual(30)
    expect(C.SUN_ELEV_FLOOR_DEG).toBeLessThan(C.SUN_ELEV_FULL_DEG)
  })
})
