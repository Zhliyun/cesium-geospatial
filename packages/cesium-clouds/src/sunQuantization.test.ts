import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import { quantizeSunDirection, SUN_QUANT_STEP } from './sunQuantization'

describe('quantizeSunDirection（spec §3.1.8 太阳向量量化）', () => {
  it('幂等：量化结果再量化不变', () => {
    const d = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())
    const q1 = quantizeSunDirection(d, SUN_QUANT_STEP, new Cartesian3())
    const q2 = quantizeSunDirection(q1, SUN_QUANT_STEP, new Cartesian3())
    expect(q2).toEqual(q1)
  })
  it('步进边界：输入微动 (<step/4) 不跨格；跨格跳变角 ≤ step', () => {
    const d = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())
    const q = quantizeSunDirection(d, SUN_QUANT_STEP, new Cartesian3())
    const angle = Math.acos(Math.min(1, Math.max(-1, Cartesian3.dot(d, q))))
    expect(angle).toBeLessThanOrEqual(SUN_QUANT_STEP * 1.5)
    // 微动 1e-6 rad：量化结果不变（同格）
    const d2 = Cartesian3.normalize(
      Cartesian3.add(d, new Cartesian3(1e-6, 0, 0), new Cartesian3()), new Cartesian3())
    const q2 = quantizeSunDirection(d2, SUN_QUANT_STEP, new Cartesian3())
    expect(Cartesian3.dot(q, q2)).toBeCloseTo(1, 12)
  })
  it('输出恒单位向量', () => {
    for (const d of [
      new Cartesian3(0, 0, 1), new Cartesian3(1, 0, 0),
      Cartesian3.normalize(new Cartesian3(-0.5, 0.8, 0.3), new Cartesian3())
    ]) {
      const q = quantizeSunDirection(d, SUN_QUANT_STEP, new Cartesian3())
      expect(Math.abs(Cartesian3.magnitude(q) - 1)).toBeLessThan(1e-9)
    }
  })
})
