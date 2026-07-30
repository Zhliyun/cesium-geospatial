import { describe, expect, it } from 'vitest'
import { reverseLogDepthWindow } from './logDepth'

// 与 Cesium czm_writeLogDepth 一致的正算（单测构造数据用）：
// gl_FragDepth = log2(d) / log2(far - near + 1)，d = 视角距离 - near + 1（近平面 d=1）
const forwardLogDepth = (zDist: number, near: number, far: number): number =>
  Math.log2(zDist - near + 1) / Math.log2(far - near + 1)

// 透视投影下视角距离 → 线性 windowZ
const windowZFromViewDist = (
  zDist: number,
  near: number,
  far: number
): number => {
  const a = far / (far - near)
  const b = (far * near) / (near - far)
  return a + b / zDist
}

describe('reverseLogDepthWindow', () => {
  it('depth=1 → 远平面 windowZ≈1', () => {
    expect(reverseLogDepthWindow(1, 0.1, 1e8)).toBeCloseTo(1, 5)
  })

  it('depth=0 → 近平面 windowZ≈0', () => {
    expect(reverseLogDepthWindow(0, 0.1, 1e8)).toBeCloseTo(0, 5)
  })

  it('中间深度落在 [0,1] 内', () => {
    const r = reverseLogDepthWindow(0.5, 0.1, 1e8)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  })

  it('往返一致：正算 logDepth 后反演还原线性 windowZ', () => {
    const near = 0.1
    const far = 1e8
    for (const zDist of [0.1, 1, 100, 1e4, 1e6, 1e8]) {
      const logDepth = forwardLogDepth(zDist, near, far)
      const expected = windowZFromViewDist(zDist, near, far)
      expect(reverseLogDepthWindow(logDepth, near, far)).toBeCloseTo(
        expected,
        5
      )
    }
  })
})
