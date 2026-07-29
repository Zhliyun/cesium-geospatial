import { describe, it, expect } from 'vitest'
import { parseHalfFloatBin } from './lutLoader'

describe('parseHalfFloatBin', () => {
  it('half=0x3C00 (1.0) → 1.0', () => {
    const buf = new Uint16Array([0x3c00]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(1.0, 3)
  })
  it('half=0xBC00 (-1.0) → -1.0', () => {
    const buf = new Uint16Array([0xbc00]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(-1.0, 3)
  })
  it('half=0x4000 (2.0) → 2.0', () => {
    const buf = new Uint16Array([0x4000]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(2.0, 3)
  })
  it('half=0x0000 → 0.0', () => {
    const buf = new Uint16Array([0x0000]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBe(0)
  })
})
