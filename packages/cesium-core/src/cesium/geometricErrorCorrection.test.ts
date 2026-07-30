import { describe, it, expect } from 'vitest'
import {
  computeGeometricErrorCorrectionAmount,
  remapClamp
} from './geometricErrorCorrection'

// WGS84 椭球最大半径（与源仓库 ellipsoid.maximumRadius 对齐）
const WGS84_MAX_RADIUS = 6378137

/**
 * 构造标准透视投影矩阵（列主序 number[16]，与 Cesium Matrix4 内部布局一致）。
 * f = 1 / tan(fovY / 2)
 */
function makePerspectiveMatrix(
  fovYRad: number,
  aspect: number,
  near: number,
  far: number
): number[] {
  const f = 1 / Math.tan(fovYRad / 2)
  const m = new Array(16).fill(0)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) / (near - far)
  m[11] = -1
  m[14] = (2 * far * near) / (near - far)
  return m
}

// Cesium 默认 FOV 60° 的投影矩阵
const CESIUM_FOV = (60 * Math.PI) / 180
const PROJ_FOV60 = makePerspectiveMatrix(CESIUM_FOV, 1, 1, 1e9)
const F_FOV60 = 1 / Math.tan(CESIUM_FOV / 2) // ≈ 1.732

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

  describe('computeGeometricErrorCorrectionAmount（模块内投影）', () => {
    // 端到端：真实透视投影矩阵（FOV 60°，对齐 Cesium 默认）
    it('近地（h=1m）→ projectedScaleY 极大 → amount = 0（保地形法线）', () => {
      expect(
        computeGeometricErrorCorrectionAmount(1, PROJ_FOV60, WGS84_MAX_RADIUS)
      ).toBe(0)
    })
    it('h=0 贴地 → amount = 0（clip.w=0 退化为 +Inf，clamp 到 0）', () => {
      expect(
        computeGeometricErrorCorrectionAmount(0, PROJ_FOV60, WGS84_MAX_RADIUS)
      ).toBe(0)
    })
    it('太空（h=1e8m）→ projectedScaleY 极小 → amount = 1（压远处法线噪声）', () => {
      expect(
        computeGeometricErrorCorrectionAmount(1e8, PROJ_FOV60, WGS84_MAX_RADIUS)
      ).toBe(1)
    })
    it('过渡区线性：h 使 projectedScaleY = 27.65 → amount ≈ 0.5', () => {
      // projectedScale.y = f * R / h（标准透视矩阵下）→ h = f * R / 27.65
      const h = (F_FOV60 * WGS84_MAX_RADIUS) / 27.65
      expect(
        computeGeometricErrorCorrectionAmount(h, PROJ_FOV60, WGS84_MAX_RADIUS)
      ).toBeCloseTo(0.5, 6)
    })
    it('高度单调性：越高 amount 越大', () => {
      const low = computeGeometricErrorCorrectionAmount(
        1e4,
        PROJ_FOV60,
        WGS84_MAX_RADIUS
      )
      const mid = computeGeometricErrorCorrectionAmount(
        4e5,
        PROJ_FOV60,
        WGS84_MAX_RADIUS
      )
      const high = computeGeometricErrorCorrectionAmount(
        1e7,
        PROJ_FOV60,
        WGS84_MAX_RADIUS
      )
      expect(low).toBeLessThanOrEqual(mid)
      expect(mid).toBeLessThanOrEqual(high)
    })
    it('常数可传参覆盖（Cesium FOV 60° 重标定入口）', () => {
      // 自定义标定常数 near=30, far=10：h 使 projectedScaleY = 20 → 0.5
      const h = (F_FOV60 * WGS84_MAX_RADIUS) / 20
      expect(
        computeGeometricErrorCorrectionAmount(
          h,
          PROJ_FOV60,
          WGS84_MAX_RADIUS,
          30,
          10
        )
      ).toBeCloseTo(0.5, 6)
    })
    it('负高度按 max(0, h) 处理（与源公式一致）', () => {
      // h < 0 → z = -max(0,h) = 0，与 h=0 行为一致
      expect(
        computeGeometricErrorCorrectionAmount(
          -100,
          PROJ_FOV60,
          WGS84_MAX_RADIUS
        )
      ).toBe(0)
    })
  })
})
