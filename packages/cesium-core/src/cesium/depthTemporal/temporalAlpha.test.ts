// temporalAlpha 单元测试。
// 运动门控：position + direction 双项 + 高度归一化（评审 critical：cameraDelta 不检测旋转/orbit 旁路）。
import { describe, it, expect } from 'vitest'
import { computeTemporalAlpha, computeMaxDelta } from './temporalAlpha'
import { LOW_ALPHA, HIGH_ALPHA, MAX_DELTA_K, MIN_CAMERA_HEIGHT_M } from './depthTemporalConstants'

describe('computeTemporalAlpha', () => {
  const cameraHeight = 1_000_000 // 1Mm
  const maxDelta = cameraHeight * MAX_DELTA_K // 10km

  it('静止（position+direction 不变）→ lowAlpha（强平滑）', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 0,
      directionDelta: 0, // 1 - dot(dir, dir) = 0
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    expect(a).toBeCloseTo(LOW_ALPHA, 3)
  })

  it('纯平移（positionDelta >> maxDelta，无旋转）→ highAlpha（偏 current）', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 50_000, // 50km >> 10km
      directionDelta: 0,
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    expect(a).toBeCloseTo(HIGH_ALPHA, 2)
  })

  it('纯旋转（positionDelta=0，directionDelta 大）→ 趋 highAlpha（旋转不旁路）', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 0,
      directionDelta: 0.5, // 1 - dot = 0.5（~60° 旋转）
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    // motion = 0 + 0.5*0.5 = 0.25 → smoothstep(0,1,0.25) 中间值
    expect(a).toBeGreaterThan(LOW_ALPHA + 0.01)
    expect(a).toBeLessThan(HIGH_ALPHA)
  })

  it('orbit（position+direction 都大）→ highAlpha', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 50_000,
      directionDelta: 0.5,
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    expect(a).toBeCloseTo(HIGH_ALPHA, 2)
  })
})

describe('computeMaxDelta（Bug2：离地高度归一化，修 camera 低门控失效）', () => {
  // 诊断：原 maxDelta = cameraHeight(地心距)*K，camera 低 camR≈6371km → maxDelta=63.7km
  // → 平移 1km motion=0.016 → alpha≈0.053（几乎全 history，门控失效 → EMA 滞后 → camera 低异常）。
  // 修复：maxDelta = 离地高度*K，camera 低 maxDelta 小 → 平移触发 highAlpha。
  const EARTH_RADIUS = 6_378_000 // 赤道半径（ellipsoid.maximumRadius，保守下限）

  it('camera 低（离地 5km）→ maxDelta≈50m（平移 1km 触发 highAlpha，修复）', () => {
    const cameraHeight = EARTH_RADIUS + 5_000
    expect(computeMaxDelta(cameraHeight, EARTH_RADIUS)).toBeCloseTo(50, 0) // 5km * 0.01
  })

  it('高空（离地 1000km）→ maxDelta≈10km（保持高空敏感度）', () => {
    const cameraHeight = EARTH_RADIUS + 1_000_000
    expect(computeMaxDelta(cameraHeight, EARTH_RADIUS)).toBeCloseTo(10_000, 0) // 1000km * 0.01
  })

  it('地表（离地 0）→ maxDelta 下限 MIN*K（防 altitudeAboveGround→0）', () => {
    const cameraHeight = EARTH_RADIUS
    expect(computeMaxDelta(cameraHeight, EARTH_RADIUS)).toBeCloseTo(
      MIN_CAMERA_HEIGHT_M * MAX_DELTA_K,
      0
    )
  })

  it('极区（cameraHeight < maximumRadius）→ maxDelta 下限（防负，保守赤道半径）', () => {
    const cameraHeight = 6_356_000 + 5_000 // 极半径+5km < 赤道 maximumRadius
    expect(computeMaxDelta(cameraHeight, EARTH_RADIUS)).toBeCloseTo(
      MIN_CAMERA_HEIGHT_M * MAX_DELTA_K,
      0
    )
  })

  it('回归对比：原地心距公式 camera 低 maxDelta=63.7km（失效），新公式 50m（小 >1000 倍）', () => {
    const cameraHeight = EARTH_RADIUS + 5_000
    const oldMaxDelta = cameraHeight * MAX_DELTA_K // 原地心距公式（Bug，~63.8km）
    const newMaxDelta = computeMaxDelta(cameraHeight, EARTH_RADIUS) // 新离地高度（~50m）
    expect(newMaxDelta).toBeLessThan(oldMaxDelta / 1000) // 新比原小 >1000 倍
  })
})
