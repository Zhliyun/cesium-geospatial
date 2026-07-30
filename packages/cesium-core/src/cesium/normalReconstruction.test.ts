import { describe, expect, it } from 'vitest'
import { normalFromViewDerivatives } from './normalReconstruction'

describe('normalFromViewDerivatives', () => {
  it('平面导数 cross 得单位法线', () => {
    const n = normalFromViewDerivatives([1, 0, 0], [0, 1, 0])
    expect(n[2]).toBeCloseTo(1, 5) // cross(x,y)=z
  })
  it('退化导数（零向量）回退不产 NaN', () => {
    const n = normalFromViewDerivatives([0, 0, 0], [0, 0, 0])
    expect(Number.isNaN(n[0])).toBe(false)
  })
})
