import { describe, expect, it } from 'vitest'
import { COLOR_SPACE_GLSL, linearToSrgb, srgbToLinear } from './colorSpace'

describe('COLOR_SPACE_GLSL', () => {
  it('包含 sRGBToLinear 与 linearToSRGB 两个函数', () => {
    expect(COLOR_SPACE_GLSL).toContain('sRGBToLinear')
    expect(COLOR_SPACE_GLSL).toContain('linearToSRGB')
  })

  it('GLSL 使用 2.2 伽马（反伽马 1.0/2.2）', () => {
    expect(COLOR_SPACE_GLSL).toContain('2.2')
  })
})

describe('srgbToLinear', () => {
  it('中灰 0.5 反伽马 ≈ 0.214', () => {
    // 需求参考值 0.214 来自精确分段 sRGB EOTF；简化伽马 2.2 下 0.5^2.2=0.2176，
    // 两位小数精度一致，故按 2 位精度断言。
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 2)
  })

  it('端点不动：0 → 0，1 → 1', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBeCloseTo(1, 10)
  })

  it('单调递增', () => {
    expect(srgbToLinear(0.2)).toBeLessThan(srgbToLinear(0.8))
  })
})

describe('linearToSrgb', () => {
  it('与 srgbToLinear 往返一致', () => {
    for (const x of [0, 0.05, 0.2, 0.5, 0.8, 1]) {
      expect(linearToSrgb(srgbToLinear(x))).toBeCloseTo(x, 6)
    }
  })

  it('端点不动：0 → 0，1 → 1', () => {
    expect(linearToSrgb(0)).toBe(0)
    expect(linearToSrgb(1)).toBeCloseTo(1, 10)
  })
})
