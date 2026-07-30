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
  // 相对亮度（relative luminance）：源仓库 sky.frag 输出 GetSkyLuminance 不做曝光，
  // 故 uniform 必须传 relative 版本 = sunRadianceToLuminance / sunLuminance。
  // 照搬 AtmosphereParameters.ts 构造器：luminance = dot((0.2126,0.7152,0.0722), sunRadianceToLuminance)。
  // sunRadianceToLuminance = (98242.786222, 69954.398112, 66475.012354) → sunLuminance ≈ 75722.23
  // 传绝对亮度会导致 radiance ~1e5，任何色调映射都饱和成白（即截图中的白球）。
  const SUN_LUMINANCE = 75722.23
  const SUN_SPECTRAL = new Cartesian3(
    98242.786222 / SUN_LUMINANCE,
    69954.398112 / SUN_LUMINANCE,
    66475.012354 / SUN_LUMINANCE
  )
  const SKY_SPECTRAL = new Cartesian3(
    114974.916437 / SUN_LUMINANCE,
    71305.954816 / SUN_LUMINANCE,
    65310.548555 / SUN_LUMINANCE
  )
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
