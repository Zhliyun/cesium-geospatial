// Phase 1 Task 6：AtmosphereStage 组装——把 T5 的 shader 生成器接到 Cesium 运行时。
//
// 职责：
// 1. createAtmosphereStage(scene, luts, options) 创建 PostProcessStage 并加入
//    scene.postProcessStages；uniforms 覆盖 AERIAL_PERSPECTIVE_UNIFORM_NAMES 全部
//    （spec §4.1，每帧量走闭包，静态量传值）。
// 2. preRender 每帧更新 sunDirection（Simon1994 + ICRF→Fixed）、altitudeCorrection
//    （密切球再中心化）、geometricErrorCorrectionAmount（T4 CPU 公式）。
//    这套逻辑从 apps/demo 的 SkyStage 下沉到 cesium-core（spec §3.5 旧代码处置：
//    避免双份维护）。
// 3. setMode(newOptions)：A/B 切换 = 销毁旧 stage + 按新 options 重建
//    （fragmentShader 只读，宏是编译期 define，无法运行时切换）。
//    globe.enableLighting/showGroundAtmosphere/fog 的场景开关矩阵由 demo（T7）负责。
//
// 可纯测性：PostProcessStage 需要 WebGL context，node 单测不实例化它。
// uniform 构建（buildAtmosphereUniforms）、选项校验（validateAtmosphereOptions）、
// amount 强制逻辑（resolveGeometricErrorCorrectionAmount）拆成纯函数，
// createAtmosphereStage 只做薄壳组装。

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
  buildAerialPerspectiveFragmentShader,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'
import { computeGeometricErrorCorrectionAmount } from './geometricErrorCorrection'
import { getAltitudeCorrectionOffset } from '../math/altitudeCorrection'
import {
  ATMOSPHERE_BOTTOM_RADIUS_M,
  SUN_ANGULAR_RADIUS
} from '../math/atmosphereParameters'
import type { AtmosphereLUTs } from './lutLoader'

// spec §4.2 options 形状：T5 的宏开关 + 纯数值项（运行时 uniform，可 URL 调）。
export interface AtmosphereStageOptions extends AerialPerspectiveFragOptions {
  albedoScale?: number // A 路径反照率缩放（默认 1）
  exposure?: number // 曝光（默认 3.0，起点值，地表分支接入后需重新定标，§3.4）
  debugMode?: number // u_debugMode：0=正常 1=log 定标 2=太阳方向 3=相机位置量级
}

// 校验后的完整 options（全部字段有值）。
export interface ResolvedAtmosphereStageOptions
  extends Required<AerialPerspectiveFragOptions> {
  albedoScale: number
  exposure: number
  debugMode: number
}

// 每帧可变状态：preRender 原地更新，uniform 闭包持引用读取。
export interface AtmosphereFrameState {
  sunDirection: Cartesian3
  altitudeCorrection: Cartesian3
  geometricErrorCorrectionAmount: number
}

// 相对亮度（relative luminance）常量，照搬 Phase 0 SkyStage（注释见其文件）：
// 源 sky.frag 输出 GetSkyLuminance 不做曝光，uniform 必须传 relative 版本
// = sunRadianceToLuminance / sunLuminance，sunLuminance ≈ 75722.23。
const SUN_LUMINANCE = 75722.23
const SUN_SPECTRAL_RADIANCE_TO_LUMINANCE = new Cartesian3(
  98242.786222 / SUN_LUMINANCE,
  69954.398112 / SUN_LUMINANCE,
  66475.012354 / SUN_LUMINANCE
)
const SKY_SPECTRAL_RADIANCE_TO_LUMINANCE = new Cartesian3(
  114974.916437 / SUN_LUMINANCE,
  71305.954816 / SUN_LUMINANCE,
  65310.548555 / SUN_LUMINANCE
)

// 米 → km（Bruneton 模型长度单位），与 shader 内 METER_TO_LENGTH_UNIT 一致。
const METER_TO_LENGTH_UNIT = 0.001

/**
 * 校验并补全 options。非法宏组合在 create/setMode 入口显式报错（spec §4.2）。
 *
 * 非法组合：sun:true 但 sky:false——SUN 日盘代码生成在天空分支
 * （getSkyRadiance）内部，天空分支不存在时日盘无从渲染，属调用方笔误。
 */
export function validateAtmosphereOptions(
  options: AtmosphereStageOptions = {}
): ResolvedAtmosphereStageOptions {
  const resolved: ResolvedAtmosphereStageOptions = {
    sunLight: options.sunLight ?? true,
    skyLight: options.skyLight ?? true,
    transmittance: options.transmittance ?? true,
    inscatter: options.inscatter ?? true,
    sun: options.sun ?? true,
    ground: options.ground ?? true,
    correctGeometricError: options.correctGeometricError ?? true,
    sky: options.sky ?? true,
    albedoScale: options.albedoScale ?? 1,
    exposure: options.exposure ?? 3.0,
    debugMode: options.debugMode ?? 0
  }
  if (resolved.sun && !resolved.sky) {
    throw new Error(
      'AtmosphereStage: 非法宏组合 sun:true + sky:false——SUN 日盘渲染在天空分支内，sky 必须同时为 true（或显式 sun:false）'
    )
  }
  return resolved
}

/**
 * 【T5 移交的契约】correctGeometricError === false 时强制 amount = 0：
 * shader 中 altitudeCorrection 预乘 (1 - amount)，amount=0 使 (1-0)=1
 * 退化为源行为，保证 B 路径/调试组合的高空参考帧一致。
 */
export function resolveGeometricErrorCorrectionAmount(
  correctGeometricError: boolean,
  cameraHeightM: number,
  projectionMatrix: ArrayLike<number>,
  ellipsoidMaximumRadius: number
): number {
  if (!correctGeometricError) return 0
  return computeGeometricErrorCorrectionAmount(
    cameraHeightM,
    projectionMatrix,
    ellipsoidMaximumRadius
  )
}

/**
 * 构建 PostProcessStage 的 uniforms（覆盖 AERIAL_PERSPECTIVE_UNIFORM_NAMES 全部）。
 * 每帧量（sunDirection/altitudeCorrection/cameraNear/cameraFar/
 * geometricErrorCorrectionAmount）走闭包；静态量传值。
 * 纯函数：不实例化 PostProcessStage，node 单测可直接断言。
 */
export function buildAtmosphereUniforms(
  scene: Scene,
  luts: AtmosphereLUTs,
  options: AtmosphereStageOptions,
  state: AtmosphereFrameState
): Record<string, unknown> {
  const radii = scene.globe.ellipsoid.radii
  // correctGeometricError 的 sphereNormal 用（spec §4.1：长度单位 km）
  const ellipsoidRadii = new Cartesian3(
    radii.x * METER_TO_LENGTH_UNIT,
    radii.y * METER_TO_LENGTH_UNIT,
    radii.z * METER_TO_LENGTH_UNIT
  )
  return {
    SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: SUN_SPECTRAL_RADIANCE_TO_LUMINANCE,
    SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: SKY_SPECTRAL_RADIANCE_TO_LUMINANCE,
    transmittance_texture: () => luts.transmittance,
    scattering_texture: () => luts.scattering,
    single_mie_scattering_texture: () => luts.scattering, // COMBINED 模式不用，传同值
    irradiance_texture: () => luts.irradiance,
    sunDirection: () => state.sunDirection,
    altitudeCorrection: () => state.altitudeCorrection,
    cameraNear: () => scene.camera.frustum.near,
    cameraFar: () => scene.camera.frustum.far,
    geometricErrorCorrectionAmount: () => state.geometricErrorCorrectionAmount,
    exposure: options.exposure ?? 3.0,
    u_debugMode: options.debugMode ?? 0,
    ellipsoidRadii,
    albedoScale: options.albedoScale ?? 1,
    cosSunAngularRadius: Math.cos(SUN_ANGULAR_RADIUS)
  }
}

export interface AtmosphereStageHandle {
  /** 当前生效的 PostProcessStage（setMode 重建后指向新实例） */
  readonly stage: PostProcessStage
  /** A/B 切换：销毁旧 stage + 按新 options 重建（宏是编译期 define，必须重建） */
  setMode(newOptions: AtmosphereStageOptions): void
  /** 从场景移除并销毁 stage，解除 preRender 监听 */
  destroy(): void
}

/**
 * 创建大气透视 PostProcessStage 并加入 scene.postProcessStages。
 * preRender 每帧更新 sunDirection/altitudeCorrection/geometricErrorCorrectionAmount
 * （逻辑下沉自 apps/demo SkyStage，cesium-core 内聚维护）。
 */
export function createAtmosphereStage(
  scene: Scene,
  luts: AtmosphereLUTs,
  options: AtmosphereStageOptions = {}
): AtmosphereStageHandle {
  let resolved = validateAtmosphereOptions(options)

  const state: AtmosphereFrameState = {
    sunDirection: new Cartesian3(0, 0, 1),
    altitudeCorrection: new Cartesian3(),
    geometricErrorCorrectionAmount: 0
  }
  const sunInertialScratch = new Cartesian3()
  const icrfScratch = new Matrix3()

  function buildStage(): PostProcessStage {
    return new PostProcessStage({
      fragmentShader: buildAerialPerspectiveFragmentShader(resolved),
      uniforms: buildAtmosphereUniforms(scene, luts, resolved, state)
    })
  }

  let stage = buildStage()
  scene.postProcessStages.add(stage)

  // 每帧更新（模式照搬 Phase 0 SkyStage preRender）
  const removePreRender = scene.preRender.addEventListener(
    (_scene: Scene, time: JulianDate) => {
      const camera = scene.camera
      // 密切球再中心化（相机侧 + 几何侧共用同一 offset，几何侧在 shader 内乘 (1-amount)）
      getAltitudeCorrectionOffset(
        camera.positionWC,
        ATMOSPHERE_BOTTOM_RADIUS_M,
        scene.globe.ellipsoid,
        state.altitudeCorrection
      )
      // 太阳方向：inertial 系位置 → ICRF-to-Fixed → ECEF，单位化
      const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        time,
        sunInertialScratch
      )
      const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time, icrfScratch)
      if (icrfToFixed != null) {
        const sunFixed = Matrix3.multiplyByVector(icrfToFixed, sunInertial, sunInertial)
        Cartesian3.normalize(sunFixed, state.sunDirection)
      }
      // 几何误差校正量（T4 CPU 公式；correctGeometricError 关闭时强制 0）
      const cameraHeightM = camera.positionCartographic?.height ?? 0
      state.geometricErrorCorrectionAmount = resolveGeometricErrorCorrectionAmount(
        resolved.correctGeometricError,
        cameraHeightM,
        camera.frustum.projectionMatrix,
        scene.globe.ellipsoid.maximumRadius
      )
    }
  )

  /** 从集合移除并销毁；remove 成功时集合内部已 destroy，失败（不在集合中）则自行销毁 */
  function removeAndDestroy(s: PostProcessStage): void {
    if (!scene.postProcessStages.remove(s)) {
      s.destroy()
    }
  }

  return {
    get stage() {
      return stage
    },
    setMode(newOptions: AtmosphereStageOptions) {
      // 先校验：非法组合抛错时保留旧 stage，不破坏当前渲染状态
      const next = validateAtmosphereOptions(newOptions)
      removeAndDestroy(stage)
      resolved = next
      stage = buildStage()
      scene.postProcessStages.add(stage)
    },
    destroy() {
      removePreRender()
      removeAndDestroy(stage)
    }
  }
}
