import { describe, it, expect } from 'vitest'
import {
  computeGeometricErrorCorrectionAmount,
  remapClamp
} from './geometricErrorCorrection'

describe('geometricErrorCorrection', () => {
  describe('remapClamp', () => {
    // 注意：源公式是 a=41.5 > b=13.8 的反向映射，v 越大结果越小
    it('v <= b（投影尺度小=相机远）→ 1', () => {
      expect(remapClamp(0, 41.5, 13.8)).toBe(1)
      expect(remapClamp(13.8, 41.5, 13.8)).toBe(1)
    })
    it('v >= a（投影尺度大=相机近）→ 0', () => {
      expect(remapClamp(41.5, 41.5, 13.8)).toBe(0)
      expect(remapClamp(100, 41.5, 13.8)).toBe(0)
    })
    it('中点线性插值', () => {
      // (41.5 + 13.8) / 2 = 27.65 → 0.5
      expect(remapClamp(27.65, 41.5, 13.8)).toBeCloseTo(0.5, 6)
    })
    it('正向区间也成立（a < b）', () => {
      expect(remapClamp(-1, 0, 10)).toBe(0)
      expect(remapClamp(11, 0, 10)).toBe(1)
      expect(remapClamp(5, 0, 10)).toBeCloseTo(0.5, 6)
    })
  })

  describe('computeGeometricErrorCorrectionAmount', () => {
    // 近地：相机高度 0，投影尺度极大 → amount 趋 0（保留地形法线）
    it('相机近地（projectedScaleY 大）→ amount = 0', () => {
      expect(computeGeometricErrorCorrectionAmount(0, 1000)).toBe(0)
      expect(computeGeometricErrorCorrectionAmount(0, 41.5)).toBe(0)
    })
    // 太空：投影尺度趋 0 → amount 趋 1（压制远处法线噪声）
    it('相机极高（projectedScaleY 小）→ amount = 1', () => {
      expect(computeGeometricErrorCorrectionAmount(1e7, 0)).toBe(1)
      expect(computeGeometricErrorCorrectionAmount(1e7, 13.8)).toBe(1)
    })
    it('过渡区线性', () => {
      expect(
        computeGeometricErrorCorrectionAmount(1e5, 27.65)
      ).toBeCloseTo(0.5, 6)
    })
    it('常数可传参覆盖（Cesium FOV 60° 重标定入口）', () => {
      // 自定义标定常数 a=30, b=10
      expect(computeGeometricErrorCorrectionAmount(0, 31, 30, 10)).toBe(0)
      expect(computeGeometricErrorCorrectionAmount(1e7, 9, 30, 10)).toBe(1)
      expect(
        computeGeometricErrorCorrectionAmount(1e5, 20, 30, 10)
      ).toBeCloseTo(0.5, 6)
    })
  })
})
