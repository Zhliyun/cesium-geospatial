import {
  PostProcessStage,
  Cartesian3,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  JulianDate,
  type Scene
} from 'cesium'
import {
  getAltitudeCorrectionOffset,
  ATMOSPHERE_BOTTOM_RADIUS_M,
  type AtmosphereLUTs
} from '@cesium-geospatial/core'
import { buildSkyFragmentShader } from './skyStage.frag'

export function createSkyStage(
  scene: Scene,
  luts: AtmosphereLUTs
): PostProcessStage {
  const altitudeCorrection = new Cartesian3()
  const sunDirection = new Cartesian3(0, 0, 1)
  // 逐字取自 AtmosphereParameters.DEFAULT 的 sunRadianceToLuminance / skyRadianceToLuminance
  const SUN_SPECTRAL = new Cartesian3(98242.786222, 69954.398112, 66475.012354)
  const SKY_SPECTRAL = new Cartesian3(114974.916437, 71305.954816, 65310.548555)
  const sunInertialScratch = new Cartesian3()
  const icrfScratch = new Matrix3()

  const stage = new PostProcessStage({
    fragmentShader: buildSkyFragmentShader(),
    uniforms: {
      sunDirection: () => sunDirection,
      altitudeCorrection: () => altitudeCorrection,
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: SUN_SPECTRAL,
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: SKY_SPECTRAL,
      transmittance_texture: () => luts.transmittance,
      scattering_texture: () => luts.scattering,
      single_mie_scattering_texture: () => luts.scattering, // COMBINED 模式不用，传同值
      irradiance_texture: () => luts.irradiance
    }
  })

  // 每帧更新 altitudeCorrection（密切球再中心化）+ sunDirection（真实太阳 ECEF）
  scene.preRender.addEventListener((_scene: Scene, time: JulianDate) => {
    const cameraECEF = scene.camera.positionWC
    getAltitudeCorrectionOffset(
      cameraECEF,
      ATMOSPHERE_BOTTOM_RADIUS_M,
      scene.globe.ellipsoid,
      altitudeCorrection
    )
    // 太阳：inertial 系位置 → ICRF-to-Fixed 矩阵 → ECEF，单位化得指向太阳方向。
    const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      sunInertialScratch
    )
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time, icrfScratch)
    if (icrfToFixed != null) {
      const sunFixed = Matrix3.multiplyByVector(icrfToFixed, sunInertial, sunInertial)
      Cartesian3.normalize(sunFixed, sunDirection)
    }
  })

  return stage
}
