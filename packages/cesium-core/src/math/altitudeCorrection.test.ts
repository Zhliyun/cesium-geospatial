import { describe, it, expect } from 'vitest'
import { Cartesian3, Ellipsoid } from 'cesium'
import { getAltitudeCorrectionOffset } from './altitudeCorrection'
import { ATMOSPHERE_BOTTOM_RADIUS_M } from './atmosphereParameters'

describe('getAltitudeCorrectionOffset', () => {
  it('相机在地表赤道上时，校正后相机落在密切球半径量级', () => {
    const ellipsoid = Ellipsoid.WGS84
    const camera = new Cartesian3(6378137, 0, 0) // 赤道地表
    const result = new Cartesian3()
    const offset = getAltitudeCorrectionOffset(
      camera,
      ATMOSPHERE_BOTTOM_RADIUS_M,
      ellipsoid,
      result
    )
    const localized = Cartesian3.add(camera, offset, new Cartesian3())
    // 校正后相机相对密切球中心 ≈ bottomRadius 量级
    expect(Cartesian3.magnitude(localized)).toBeGreaterThan(6300000)
    expect(Cartesian3.magnitude(localized)).toBeLessThan(6500000)
  })

  it('相机为 0 向量时返回 0', () => {
    const result = new Cartesian3()
    const offset = getAltitudeCorrectionOffset(
      new Cartesian3(0, 0, 0),
      6360000,
      Ellipsoid.WGS84,
      result
    )
    expect(offset).toEqual(Cartesian3.ZERO)
  })
})
