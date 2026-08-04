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
  PostProcessStageComposite,
  PostProcessStageSampleMode,
  Cartesian3,
  Matrix3,
  Matrix4,
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
import { createLensFlareStage } from './lensFlare/createLensFlareStage'
import {
  INTENSITY_DEFAULT,
  THRESHOLD_LEVEL_DEFAULT,
  GHOST_AMOUNT_DEFAULT,
  HALO_AMOUNT_DEFAULT
} from './lensFlare/lensFlareConstants'
import { getAltitudeCorrectionOffset } from '../math/altitudeCorrection'
import {
  ATMOSPHERE_BOTTOM_RADIUS_M,
  SUN_ANGULAR_RADIUS
} from '../math/atmosphereParameters'
import type { AtmosphereLUTs } from './lutLoader'
import { buildDepthTemporalFragmentShader } from './depthTemporal/depthTemporal.frag'
import {
  createHistoryState,
  getHistoryBridge,
  sanityCheckOutputTexture,
  type HistoryState
} from './depthTemporal/historyBlit'
import { DEPTH_THRESHOLD_DEFAULT, HIGH_ALPHA } from './depthTemporal/depthTemporalConstants'

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
  // phase2b LensFlare（spec §5.9）：lensflare 作为第三 stage 插在 atmosphere 与 tonomap 之间。
  // lensFlare=false → 不创建 lensflare composite（phase2a 两 stage 行为，防回归）。
  // ?lensflare=0 运行时切换走 lensFlareStage.enabled=false（M1：非 setMode rebuild 15 子 stage）。
  lensFlare?: boolean // 默认 true
  lensFlareIntensity?: number // 总强度（默认 INTENSITY_DEFAULT）
  lensFlareThreshold?: number // 阈值电平（默认 THRESHOLD_LEVEL_DEFAULT）
  lensFlareGhost?: number // ghost 总强度（默认 GHOST_AMOUNT_DEFAULT）
  lensFlareHalo?: number // halo 总强度（默认 HALO_AMOUNT_DEFAULT）
  distanceScale?: number // 散射距离缩放（方案 A，1.0=phase1 物理，>1 中近距散射强，建议 1.0-3.0，超 3 需评估 half-float 灾消）
  inscatterScale?: number // inscatter 放大（方案 B 远处白雾浓，1.0=phase1 物理，>1 远处雾浓，直接 ×inscatter 可超物理饱和）
  ditherScale?: number // input+display dithering 强度倍率（1.0=phase1 默认；>1 更强打散 inscatterScale 放大 ACES 输入暴露的 banding，但噪声增）
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
  // phase2b LensFlare resolved 字段（spec §5.9）
  lensFlare: boolean
  lensFlareIntensity: number
  lensFlareThreshold: number
  lensFlareGhost: number
  lensFlareHalo: number
  distanceScale: number
  inscatterScale: number
  ditherScale: number
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
    debugMode: options.debugMode ?? 0,
    // phase2b LensFlare 默认（spec §5.9）：透传 lensFlareConstants 标定值。
    lensFlare: options.lensFlare ?? true,
    lensFlareIntensity: options.lensFlareIntensity ?? INTENSITY_DEFAULT,
    lensFlareThreshold: options.lensFlareThreshold ?? THRESHOLD_LEVEL_DEFAULT,
    lensFlareGhost: options.lensFlareGhost ?? GHOST_AMOUNT_DEFAULT,
    lensFlareHalo: options.lensFlareHalo ?? HALO_AMOUNT_DEFAULT,
    distanceScale: options.distanceScale ?? 1.0, // 默认 1.0 = phase1 行为零回归
    inscatterScale: options.inscatterScale ?? 25.0, // 用户验收远处白雾浓默认 25；URL ?inscatterScale=1 回退 phase1 物理量级
    ditherScale: options.ditherScale ?? 1.0 // 默认 1.0 = phase1 dithering ±1.5/255 零回归
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
    u_distanceScale: options.distanceScale,
    u_inscatterScale: options.inscatterScale,
    // u_ditherScale 不传：aerialPerspective.frag 回退到 363e441（input dithering 用固定 1.5/255，无 uniform）。
    // display dithering 的 u_ditherScale 仍在 tonomapStage 消费（?ditherScale= 仍有效）。
    cosSunAngularRadius: Math.cos(SUN_ANGULAR_RADIUS)
  }
}

export interface AtmosphereStageHandle {
  readonly atmosphereStage: PostProcessStage
  /**
   * depthTemporal EMA stage（activeStages[0]，atmosphere 前）。UNSIGNED_BYTE 设备（无 float RT 能力）
   * 或 disableHalfFloat 时 undefined——跳过 EMA，回退现状。Task 7 装配 + uniforms 接线 + sanity check；
   * lifecycle（resize/postRender blit+swap/每帧 prevVP+alpha/首帧 clear）由 Task 8 接。
   */
  readonly depthTemporalStage?: PostProcessStage
  /** depthTemporal 是否启用（= postHdrDatatype !== UNSIGNED_BYTE）。false 时 depthTemporalStage undefined。 */
  readonly temporalEmaEnabled: boolean
  /** phase2b LensFlare 外层 non-series composite（lensFlare=false 时 undefined）。 */
  readonly lensFlareStage?: PostProcessStageComposite
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
      uniforms: { u_debugMode: resolved.debugMode, u_ditherScale: resolved.ditherScale }, // 与 atmosphere 同源；setMode rebuild 同步
      sampleMode: PostProcessStageSampleMode.NEAREST // 显式钉死（防上游默认变更；保护 input dithering 经 RT 中转）
    })
  }

  // phase2b LensFlare（spec §5.9）：外层 non-series composite，插在 atmosphere 与 tonomap 之间。
  // lensFlare=false → 不创建（phase2a 两 stage 行为，防回归）。
  // ?lensflare=0 运行时切换走 lensFlareStage.enabled=false（M1：非 setMode rebuild 15 子 stage），
  // 由上层（demo main.ts）持 handle 直接设；stage 仍 add 在集合中，透传 atmosphere 输出。
  let lensFlareStage: PostProcessStageComposite | undefined
  if (resolved.lensFlare) {
    const lfHandle = createLensFlareStage(scene, state, {
      intensity: resolved.lensFlareIntensity,
      thresholdLevel: resolved.lensFlareThreshold,
      ghostAmount: resolved.lensFlareGhost,
      haloAmount: resolved.lensFlareHalo
    })
    lensFlareStage = lfHandle.lensflareComposite
  }

  // depthTemporal EMA（Task 7）：复用 atmosphere 同套 HDR 检测。UNSIGNED_BYTE → 跳过（无 float history RT，
  // EMA 在 8-bit 量化 depth 上无意义且灾消），回退现状（仅 atmosphere → lensflare → tonomap）。
  const temporalEmaEnabled = postHdrDatatype !== PixelDatatype.UNSIGNED_BYTE

  let depthTemporalStage: PostProcessStage | undefined
  let historyState: HistoryState | undefined
  // prevViewProjection / temporalAlpha 初始值（Task 8 lifecycle 每帧更新：postRender 写本帧 VP、
  // preRender 算 motion→alpha）。Task 7 只接线 uniforms 函数形式，值由 Task 8 更新即生效。
  // !!Task 8 lifecycle 注意：reassign prevViewProjection 时用 new Matrix4() 作 result（如
  // prevViewProjection = Matrix4.multiply(view, proj, new Matrix4())），勿 in-place mutate
  // （如 Matrix4.multiply(view, proj, prevViewProjection)）——IDENTITY 是 Object.freeze 的 frozen
  // 共享常量（Core/Matrix4.js:3070），首帧 prevVP===IDENTITY 时 in-place mutate 在 strict mode fail-fast 抛错。
  let prevViewProjection = Matrix4.IDENTITY
  let temporalAlpha = HIGH_ALPHA // 首帧偏 current（避免 history 未就绪时空值累积）
  let removeSanityCheck: (() => void) | undefined

  if (temporalEmaEnabled) {
    const context = (scene as unknown as { context: unknown }).context
    historyState = createHistoryState(
      context,
      scene.drawingBufferWidth,
      scene.drawingBufferHeight,
      postHdrDatatype
    )
    depthTemporalStage = new PostProcessStage({
      name: 'czm_depth_temporal',
      fragmentShader: buildDepthTemporalFragmentShader({ enabled: true }),
      pixelDatatype: postHdrDatatype, // float RT 承载 smoothDepth 精度（HALF_FLOAT/FLOAT）
      textureScale: 1.0, // 全分辨率（与 globe depth 1:1 像素对齐）
      sampleMode: PostProcessStageSampleMode.NEAREST, // 显式钉死：smoothDepth 打包进 .a，LINEAR 插值产无意义中间 depth → 污染 atmosphere sceneDist 反演（比 tonomap 只处理 color 更敏感）
      uniforms: {
        // 函数形式（每帧调用取最新值）：Task 8 lifecycle 更新 historyState/prevVP/alpha 后自动反映。
        u_historyTexture: () => (historyState ? getHistoryBridge(historyState) : null),
        u_prevViewProjection: () => prevViewProjection,
        u_temporalAlpha: () => temporalAlpha,
        u_depthThreshold: DEPTH_THRESHOLD_DEFAULT // 静态值（log-depth 相对阈值 0.1 ≈ 7% 距离变化容差）
      }
    })
    // depthTemporal 必须在 atmosphereStage add 前 add（activeStages[0]）：
    // atmosphere 的 colorTexture = depthTemporal 输出（含 smoothDepth.a 透传），保证
    // aerialPerspective 读到的 scene color 已经过 EMA 平滑的 depth 通道。
    scene.postProcessStages.add(depthTemporalStage)

    // sanity check（评审：graceful degrade）：outputTexture 首帧/stage 未就绪时可 undefined，不崩。
    // Task 8 lifecycle postRender blit 也判空跳过；此处仅启动期首次 dev console.debug 诊断（不重复 warn）。
    let sanityWarned = false
    removeSanityCheck = scene.preRender.addEventListener(() => {
      if (
        !sanityWarned &&
        depthTemporalStage &&
        !sanityCheckOutputTexture(depthTemporalStage.outputTexture)
      ) {
        sanityWarned = true
        console.debug(
          '[depthTemporal] outputTexture undefined at startup（stage 未就绪；Task 8 blit 判空跳过）'
        )
      }
    })
  }

  let atmosphereStage = buildAtmosphereStage()
  let tonemapStage = buildTonemapStage()
  scene.postProcessStages.add(atmosphereStage)
  if (lensFlareStage) scene.postProcessStages.add(lensFlareStage) // atmosphere → lensflare → tonomap
  scene.postProcessStages.add(tonemapStage) // 链尾，读 lensflare（或 atmosphere）线性输出

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

  /**
   * 从集合移除并销毁；remove 成功时集合内部已 destroy，失败（不在集合中）则自行销毁。
   * 接受 PostProcessStage 或 PostProcessStageComposite（Cesium remove/add 重载都收两者；
   * lensflare 外层是 Composite，destroy 链尾时走本路径）。
   */
  function removeAndDestroy(s: PostProcessStage | PostProcessStageComposite): void {
    if (!scene.postProcessStages.remove(s)) {
      s.destroy()
    }
  }

  return {
    get atmosphereStage() {
      return atmosphereStage
    },
    get depthTemporalStage() {
      return depthTemporalStage
    },
    get temporalEmaEnabled() {
      return temporalEmaEnabled
    },
    get lensFlareStage() {
      return lensFlareStage
    },
    get tonemapStage() {
      return tonemapStage
    },
    get postHdrDatatype() {
      return postHdrDatatype
    },
    setMode(newOptions: AtmosphereStageOptions) {
      // setMode/destroy 全仓库 0 调用属 dead code（demo 切 mode 靠页面重载）。
      // 既有逻辑：rebuild atmosphere+tonomap（不 removePreRender——preRender 闭包持 state/resolved
      // 引用，resolved 更新后自动生效）。两 stage uniform 同源 u_debugMode 同步重建。
      // TODO(Task 8): depthTemporal 不随 setMode rebuild（enabled 由 HDR caps 决定，非 options），
      // 但 setMode remove+re-add atmosphere/tonomap 会打乱 activeStages 顺序（depthTemporal 应在 atmosphere 前）。
      // setMode 是 dead code，暂不处理；Task 8 lifecycle 接入后若需 rebuild depthTemporal 再补。
      removeAndDestroy(atmosphereStage)
      removeAndDestroy(tonemapStage)
      resolved = validateAtmosphereOptions(newOptions)
      atmosphereStage = buildAtmosphereStage()
      tonemapStage = buildTonemapStage()
      scene.postProcessStages.add(atmosphereStage)
      // lensflare：用 enabled 开关（M1，非 rebuild 15 子 stage）。
      // - 之前未建（lensFlare=false）且新 options.lensFlare=true → 按需 create + add；
      // - 既有 lensflare composite 不 remove/re-add（Cesium remove 会 destroy，违背"enabled 非 rebuild"
      //   原则），仅按 newResolved.lensFlare 切 enabled。dead code 简化：集合内位置不调整。
      if (!lensFlareStage && resolved.lensFlare) {
        const lfHandle = createLensFlareStage(scene, state, {
          intensity: resolved.lensFlareIntensity,
          thresholdLevel: resolved.lensFlareThreshold,
          ghostAmount: resolved.lensFlareGhost,
          haloAmount: resolved.lensFlareHalo
        })
        lensFlareStage = lfHandle.lensflareComposite
        scene.postProcessStages.add(lensFlareStage)
      } else if (lensFlareStage) {
        lensFlareStage.enabled = resolved.lensFlare
      }
      scene.postProcessStages.add(tonemapStage)
    },
    destroy() {
      removePreRender()
      if (removeSanityCheck) removeSanityCheck()
      // historyState ping-pong Texture 销毁（createHistoryState 创建的两张 RT）。
      if (historyState) {
        historyState.textures.forEach((t) => t.destroy())
      }
      if (depthTemporalStage) removeAndDestroy(depthTemporalStage)
      removeAndDestroy(atmosphereStage)
      if (lensFlareStage) removeAndDestroy(lensFlareStage)
      removeAndDestroy(tonemapStage)
    }
  }
}
