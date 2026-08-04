// temporalAlpha 单元测试。
// 运动门控：position + direction 双项 + 高度归一化（评审 critical：cameraDelta 不检测旋转/orbit 旁路）。
import { describe, it, expect } from 'vitest'
import { computeTemporalAlpha } from './temporalAlpha'
import { LOW_ALPHA, HIGH_ALPHA, MAX_DELTA_K } from './depthTemporalConstants'

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
