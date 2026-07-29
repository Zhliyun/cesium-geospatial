import { describe, it, expect } from 'vitest'
import { linearDepth01CPU, reconstructNDCFromWindow } from './depthReconstruction'

describe('depthReconstruction', () => {
  it('depth=1（far）→ 线性深度接近 1', () => {
    expect(linearDepth01CPU(1.0, 1, 10000)).toBeCloseTo(1.0, 3)
  })
  it('depth=0（near）→ 线性深度接近 0', () => {
    expect(linearDepth01CPU(0.0, 1, 10000)).toBeCloseTo(0.0, 3)
  })
  it('NDC 反推：uv=0.5 → ndc=0', () => {
    const [x, y, z] = reconstructNDCFromWindow([0.5, 0.5], 0.5)
    expect(x).toBe(0)
    expect(y).toBe(0)
    expect(z).toBe(0)
  })
})
