// AtmosphereStage 组装——把 B 路径 shader 接到 Cesium 运行时（完全参考 cesium-clouds-atmosphere）。
//
// 职责：
// 1. createAtmosphereStage(scene, luts, options) 创建 PostProcessStage 并加入 scene.postProcessStages；
//    uniforms 覆盖 AERIAL_PERSPECTIVE_UNIFORM_NAMES 全部。
// 2. preRender 每帧更新 sunDirection（Simon1994 + ICRF→Fixed）、altitudeCorrection（密切球再中心化）、
//    exposure（动态：按相机当地太阳高度角在 day/night 间插值，对齐源库 _getEffectiveAtmosphereExposure）。
// 3. depthTestAgainstTerrain=true（Cesium 地形 depth 硬前提，见 createAtmosphereStage 注释）。
//
// 与原 A 路径 AtmosphereStage 的差异：去 geometricErrorCorrectionAmount（B 路径不用法线/几何误差校正）、
// albedoScale/ellipsoidRadii（A 路径 lighting 用）、cameraNear/cameraFar（改用 czm_readDepth +
// czm_windowToEyeCoordinates，Cesium 内置 log depth 处理）；exposure 固定→动态。

import {
  PostProcessStage,
  PostProcessStageSampleMode,
  Cartesian3,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  JulianDate,
  Math as CesiumMath,
  PixelDatatype,
  PixelFormat,
  type Scene,
  type Camera,
  type Ellipsoid
} from 'cesium'
import {
  buildAerialPerspectiveFragmentShader,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'
import { buildTonemapFragmentShader } from './tonemap.frag'
import { getAltitudeCorrectionOffset } from '../math/altitudeCorrection'
import {
  ATMOSPHERE_BOTTOM_RADIUS_M,
  SUN_ANGULAR_RADIUS
} from '../math/atmosphereParameters'
import type { AtmosphereLUTs } from './lutLoader'

// B 路径 options：天空/日盘宏开关 + 动态曝光参数。
export interface AtmosphereStageOptions extends AerialPerspectiveFragOptions {
  // 动态曝光（对齐源库 _getEffectiveAtmosphereExposure）：按相机当地太阳高度角在 day/night 插值。
  exposureFollowTimeline?: boolean // 默认 true；false 时用手动 exposure
  exposureDay?: number // 太阳高于晨昏带时的曝光（默认 1.5，源库默认值）
  exposureNight?: number // 太阳低于晨昏带时的曝光（默认 0.1）
  exposureTwilightAngleDegrees?: number // 晨昏过渡半角（默认 6°）：地平下 -angle 到地平上 +angle 间线性插值
  exposure?: number // 手动曝光（仅 exposureFollowTimeline=false 时生效）
  groundDim?: number // 地面反射衰减（finalColor=originalColor·trans·groundDim+inscatter，分离 exposure 压地面过曝，默认 0.5）
  debugMode?: number // u_debugMode
  disableHalfFloat?: boolean // URL ?hdr=0 强制 UNSIGNED_BYTE 兜底调试（跳过 HalfFloat 能力检测）
}

// 校验后的完整 options。
export interface ResolvedAtmosphereStageOptions extends Required<AerialPerspectiveFragOptions> {
  exposureFollowTimeline: boolean
  exposureDay: number
  exposureNight: number
  exposureTwilightAngleDegrees: number
  exposure: number
  groundDim: number
  debugMode: number
}

// 每帧可变状态：preRender 原地更新，uniform 闭包持引用读取。
export interface AtmosphereFrameState {
  sunDirection: Cartesian3
  altitudeCorrection: Cartesian3
  exposure: number
}

// 相对亮度（relative luminance）常量，照搬 Phase 0 SkyStage：
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

/**
 * 动态曝光：按相机当地太阳高度角在 exposureNight/exposureDay 之间线性插值（移植源库
 * _getEffectiveAtmosphereExposure）。太阳在地平下 twilightAngle 到地平上 twilightAngle 之间
 * 从 night 线性升到 day，解决日夜固定曝光的过曝/欠曝。
 *
 * 太阳高度角 = asin(dot(sunDirection, up))，up 为相机处 WGS84 测地法向（ECEF）。
 * 纯函数：node 单测可直接断言（正午≈day、午夜≈night、晨昏介于之间）。
 */
export function getEffectiveAtmosphereExposure(
  cameraPositionWC: Cartesian3,
  ellipsoid: Ellipsoid,
  sunDirection: Cartesian3,
  exposureDay: number,
  exposureNight: number,
  twilightAngleDegrees: number
): number {
  const surface = ellipsoid.scaleToGeodeticSurface(cameraPositionWC, exposureSurfaceScratch)
  if (surface == null) return exposureDay
  // 测地法向（ECEF）：∇F/|∇F|，F=(x/a)²+(y/b)²+(z/c)²-1 → ∇F ∝ (x/a²,y/b²,z/c²)
  const up = Cartesian3.divideComponents(
    surface,
    ellipsoid.radiiSquared,
    exposureNormalScratch
  )
  // 防御：cameraPositionWC 极端（NaN/原点，如相机 morph/underground 瞬态）时 up 退化，
  // Cesium normalize 对 0/NaN 抛 DeveloperError 并中断渲染。检查 magnitude 兜底返回默认曝光。
  const upMag = Cartesian3.magnitude(up)
  if (!Number.isFinite(upMag) || upMag < 1e-15) return exposureDay
  Cartesian3.normalize(up, up)
  const sinEl = CesiumMath.clamp(Cartesian3.dot(sunDirection, up), -1.0, 1.0)
  const elevDeg = CesiumMath.toDegrees(Math.asin(sinEl))
  const half = twilightAngleDegrees
  const t = CesiumMath.clamp((elevDeg - -half) / (2.0 * half), 0.0, 1.0)
  return exposureNight + t * (exposureDay - exposureNight)
}

const exposureSurfaceScratch = new Cartesian3()
const exposureNormalScratch = new Cartesian3()

/**
 * 校验并补全 options。
 */
export function validateAtmosphereOptions(
  options: AtmosphereStageOptions = {}
): ResolvedAtmosphereStageOptions {
  return {
    sun: options.sun ?? true,
    sky: options.sky ?? true,
    exposureFollowTimeline: options.exposureFollowTimeline ?? true,
    exposureDay: options.exposureDay ?? 1.2,
    exposureNight: options.exposureNight ?? 0.1,
    exposureTwilightAngleDegrees: options.exposureTwilightAngleDegrees ?? 6,
    exposure: options.exposure ?? 1.5,
    groundDim: options.groundDim ?? 0.5,
    debugMode: options.debugMode ?? 0
  }
}

/**
 * PostProcessStage RT 所需的 WebGL 浮点能力子集（Cesium Context 运行时持有，但 Scene.context 及这些
 * capability 字段不在公开类型里——这里声明用到的最小集合做受控访问）。
 */
interface PostProcessGpuContextCaps {
  halfFloatingPointTexture: boolean
  colorBufferHalfFloat: boolean
  floatingPointTexture: boolean
  colorBufferFloat: boolean
}

/**
 * 检测 PostProcessStage 可用的最高 HDR 像素数据类型（对齐 cesium-clouds-atmosphere AtmospherePostProcess）。
 *
 * atmosphere stage 需 HDR 中间 RT 承载 finalColor·exposure 的线性 >1 段（供链尾 tonemap 做 ACES 压缩）。
 * HALF_FLOAT 优先（精度够 + 性能好 + 32-bit color buffer 罕见）；FLOAT 次选；UNSIGNED_BYTE 兜底（>1 被 clip，
 * tonemap debug=7 false-color 会显示暗区，可证伪 HDR 链是否生效）。
 *
 * WebGL2 下 halfFloatingPointTexture 恒 true（管 RGBA16F 采样），colorBufferHalfFloat 实测
 * EXT_color_buffer_float（覆盖 RGBA16F renderable）。两者配合覆盖采样 + 渲染两端：缺任一则不能作 RT。
 *
 * 纯函数：node 单测 mock context 即可断言三分支。
 */
export function resolvePostHdrDatatype(scene: Scene): PixelDatatype {
  // Scene.context 运行时存在但不在公开类型——同 demo/main.ts 的访问方式，受控 cast。
  const ctx = (scene as unknown as { context: PostProcessGpuContextCaps }).context
  // HALF_FLOAT：采样（halfFloatingPointTexture）+ 渲染目标（colorBufferHalfFloat）须同时支持。
  if (ctx.halfFloatingPointTexture && ctx.colorBufferHalfFloat) {
    return PixelDatatype.HALF_FLOAT
  }
  // FLOAT：32-bit color buffer + 32-bit 采样（更罕见，但某些桌面 GPU 支持全精度浮点链）。
  if (ctx.colorBufferFloat && ctx.floatingPointTexture) {
    return PixelDatatype.FLOAT
  }
  return PixelDatatype.UNSIGNED_BYTE
}

/**
 * 构建 PostProcessStage 的 uniforms（覆盖 AERIAL_PERSPECTIVE_UNIFORM_NAMES 全部）。
 * 每帧量（sunDirection/altitudeCorrection/exposure）走闭包；静态量传值。
 * 纯函数：不实例化 PostProcessStage，node 单测可直接断言。
 */
export function buildAtmosphereUniforms(
  luts: AtmosphereLUTs,
  options: ResolvedAtmosphereStageOptions,
  state: AtmosphereFrameState
): Record<string, unknown> {
  return {
    SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: SUN_SPECTRAL_RADIANCE_TO_LUMINANCE,
    SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: SKY_SPECTRAL_RADIANCE_TO_LUMINANCE,
    transmittance_texture: () => luts.transmittance,
    scattering_texture: () => luts.scattering,
    single_mie_scattering_texture: () => luts.scattering, // COMBINED 模式不采样，传同值占位
    irradiance_texture: () => luts.irradiance,
    sunDirection: () => state.sunDirection,
    altitudeCorrection: () => state.altitudeCorrection,
    exposure: () => state.exposure, // 动态（preRender 更新）
    u_debugMode: options.debugMode,
    u_groundDim: options.groundDim,
    cosSunAngularRadius: Math.cos(SUN_ANGULAR_RADIUS)
  }
}

export interface AtmosphereStageHandle {
  readonly atmosphereStage: PostProcessStage
  readonly tonemapStage: PostProcessStage
  readonly postHdrDatatype: PixelDatatype
  setMode(newOptions: AtmosphereStageOptions): void
  destroy(): void
}

/**
 * 创建大气透视 PostProcessStage 并加入 scene.postProcessStages。
 * preRender 每帧更新 sunDirection/altitudeCorrection/exposure（动态）。
 */
export function createAtmosphereStage(
  scene: Scene,
  luts: AtmosphereLUTs,
  options: AtmosphereStageOptions = {}
): AtmosphereStageHandle {
  let resolved = validateAtmosphereOptions(options)

  // depthTestAgainstTerrain=true：PostProcessStage depthTexture 拿真实地形 depth（B 路径合成需真实
  // sceneDist）。false 时 depth 走 DepthPlane（椭球面），山体像素 depth 被算到视线与椭球面的远交点
  // （地平线量级），transmittance 过低 + inscatter 主导 → 山体持续透明、能看到背后地平线大气散射
  // （用户实测「山体和大气散射地平线混合渲染在一起」）。true 下 B 路径 sceneDist=真实地形距离，山体
  // 不透明、空气透视正确。代价：瓦片异步加载期间未渲染区域 depth=1（与真天空同色 clearColor，无法用
  // 亮度区分），shader 改用视线方向判定（视线朝地球=未渲染地面透传原色 fallback；仅「未渲染山顶+视线
  // 朝上」无法与真天空区分，会短暂截断，加载完恢复——这是 Cesium globe 异步渲染的固有限制）。
  scene.globe.depthTestAgainstTerrain = true

  const ellipsoid = scene.globe.ellipsoid
  const state: AtmosphereFrameState = {
    sunDirection: new Cartesian3(0, 0, 1),
    altitudeCorrection: new Cartesian3(),
    exposure: resolved.exposureDay
  }
  const sunInertialScratch = new Cartesian3()
  const icrfScratch = new Matrix3()

  // phase2a HDR 管线：一次性检测 atmosphere stage 中间 RT 可用的最高 HDR 像素类型。
  // HALF_FLOAT 优先（精度够 + 性能好），FLOAT 次选，UNSIGNED_BYTE 兜底。
  // options.disableHalfFloat=true 时跳过检测直接 UNSIGNED_BYTE（URL ?hdr=0 调试用：
  // 在 HalfFloat 设备上对比验证兜底路径——线性 >1 段被 clip，tonemap debug=7 false-color 显示暗区）。
  const postHdrDatatype = options.disableHalfFloat
    ? PixelDatatype.UNSIGNED_BYTE
    : resolvePostHdrDatatype(scene)

  // atmosphere stage：aerialPerspective fragment（Task 2 末端线性输出 finalColor·exposure）。
  // pixelDatatype=HalfFloat 带兜底让中间 RT 承载线性 >1 段，供链尾 tonemap ACES 压缩。
  function buildAtmosphereStage(): PostProcessStage {
    return new PostProcessStage({
      fragmentShader: buildAerialPerspectiveFragmentShader(resolved),
      uniforms: buildAtmosphereUniforms(luts, resolved, state),
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: postHdrDatatype
    })
  }
  // tonemap stage：链尾 ACES + gamma 1/2.2 + display triangular dithering → RGBA8 display。
  // sampleMode 显式 NEAREST——保护 atmosphere 的 input dithering 经 HalfFloat RT 中转逐像素直通；
  // 若上游默认值变更或改 LINEAR，会插值抹掉 dither 噪声 → 水波纹回归。默认 RGBA8 兜底（display ready）。
  function buildTonemapStage(): PostProcessStage {
    return new PostProcessStage({
      fragmentShader: buildTonemapFragmentShader(),
      uniforms: { u_debugMode: resolved.debugMode }, // 与 atmosphere 同源；setMode rebuild 同步
      sampleMode: PostProcessStageSampleMode.NEAREST // 显式钉死（防上游默认变更；保护 input dithering 经 RT 中转）
    })
  }

  let atmosphereStage = buildAtmosphereStage()
  let tonemapStage = buildTonemapStage()
  scene.postProcessStages.add(atmosphereStage)
  scene.postProcessStages.add(tonemapStage) // 链尾，读 atmosphere 线性输出

  // 每帧更新：altitudeCorrection + sunDirection（Simon1994）+ 动态曝光
  const removePreRender = scene.preRender.addEventListener((_scene: Scene, time: JulianDate) => {
    const camera = scene.camera

    // 密切球再中心化（相机侧，shader 内 camera/scenePos 都用全量 altitudeCorrection）
    getAltitudeCorrectionOffset(
      camera.positionWC,
      ATMOSPHERE_BOTTOM_RADIUS_M,
      ellipsoid,
      state.altitudeCorrection
    )

    // 太阳方向：inertial 系位置 → ICRF-to-Fixed → ECEF，单位化
    const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      sunInertialScratch
    )
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time, icrfScratch)
    if (icrfToFixed != null && sunInertial != null) {
      const sunFixed = Matrix3.multiplyByVector(icrfToFixed, sunInertial, sunInertial)
      const sunMag = Cartesian3.magnitude(sunFixed)
      if (Number.isFinite(sunMag) && sunMag > 1e-15) {
        Cartesian3.normalize(sunFixed, state.sunDirection)
      }
    }

    // 动态曝光（按相机当地太阳高度角）或手动
    state.exposure = resolved.exposureFollowTimeline
      ? getEffectiveAtmosphereExposure(
          camera.positionWC,
          ellipsoid,
          state.sunDirection,
          resolved.exposureDay,
          resolved.exposureNight,
          resolved.exposureTwilightAngleDegrees
        )
      : resolved.exposure
  })

  /** 从集合移除并销毁；remove 成功时集合内部已 destroy，失败（不在集合中）则自行销毁 */
  function removeAndDestroy(s: PostProcessStage): void {
    if (!scene.postProcessStages.remove(s)) {
      s.destroy()
    }
  }

  return {
    get atmosphereStage() {
      return atmosphereStage
    },
    get tonemapStage() {
      return tonemapStage
    },
    get postHdrDatatype() {
      return postHdrDatatype
    },
    setMode(newOptions: AtmosphereStageOptions) {
      // setMode/destroy 全仓库 0 调用属 dead code（demo 切 mode 靠页面重载）。
      // 简化为 rebuild 两 stage（不 removePreRender——preRender 闭包持 state/resolved 引用，
      // resolved 更新后自动生效）。两 stage uniform 同源 u_debugMode 同步重建。
      removeAndDestroy(atmosphereStage)
      removeAndDestroy(tonemapStage)
      resolved = validateAtmosphereOptions(newOptions)
      atmosphereStage = buildAtmosphereStage()
      tonemapStage = buildTonemapStage()
      scene.postProcessStages.add(atmosphereStage)
      scene.postProcessStages.add(tonemapStage)
    },
    destroy() {
      removePreRender()
      removeAndDestroy(atmosphereStage)
      removeAndDestroy(tonemapStage)
    }
  }
}
