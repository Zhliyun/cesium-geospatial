// CloudsPass.ts
//
// M2 T2：云主 march 渲染 Pass——用 M1 基建 createVolumetricPrimitive + FramebufferManager 组装
// 「custom Primitive pass=VOXELS + 3-attachment MRT FBO + 全 business uniform 注入」。
//
// 职责（plan T2）：
//   1. 创建 3 MRT texture（color/depthVelocity/shadowLength，HalfFloat 优先，UNSIGNED_BYTE 兜底）
//   2. 创建 dummy texture（shadowBuffer 2D_ARRAY 1×1×4 全 0 / depthBuffer 1×1 val=1.0 /
//      localWeatherTexture 1×1 / turbulenceTexture 1×1 / stbnTexture 1×1×1）——M3/M4/M5/M6 未接通项
//   3. uniformMap 注入 clouds.frag + parameters.glsl 全部 business uniform（atmosphere LUT 共享
//      AtmosphereStage 的 luts / weather shape+shapeDetail / 每帧闭包 camera/sun / 静态 scatter 参数）
//   4. createVolumetricPrimitive 装配（globeDepthTexture 闭包隔离私有 API scene._view.globeDepth）
//   5. 持 primitive + MRT textures + uniformMap + cloudsBuffer(att0) bridge getter + destroy
//
// czm 桥接（spec §4.2）：reprojectionMatrix/viewReprojectionMatrix = identity（M4 dummy velocity=0）；
// cameraNear/cameraFar/viewMatrix 经 CloudsMaterial.ts #define 重定向到 czm_*（无需 uniformMap）；
// cameraPosition 经桥接 = czm_viewerPositionWC。temporalJitter = (0,0)（M4 Bayer）。
//
// dummy 决策（M2 vs M3/M4/M5/M6 hook 标注）：
//   - shadowBuffer（M3 BSM）：1×1×4 全 0 sampler2DArray → sampleShadowOpticalDepth 返 0 →
//     Beer-Lambert exp(-0)=1（无自阴影，flat lighting）
//   - reprojectionMatrix/viewReprojectionMatrix（M4 temporal）：identity → velocity 非 0 但
//     outputDepthVelocity 在 M2 未被消费
//   - SHADOW_LENGTH（M5 god rays）：CloudsMaterial 不 define → marchShadowLength/outputShadowLength(loc2)
//     不编译；applyAerialPerspective 用 shadowLength=0 调 GetSkyRadianceToPoint（无 god rays）
//   - depthBuffer（M6 提前接通，2026-08-14）：globeDepth.depthStencilTexture（log-depth 编码，
//     CloudsMaterial surgery 把 three reverseLogDepth 版 getRayDistanceToScene 换 czm_reverseLogDepthWindow
//     反演）→ 云被地形截断/遮挡；未就绪时 fallback 1×1 val=1.0 dummy（远截断降级）
//   - localWeatherTexture：weather.localWeather 真 2D 资产（512² RGBA 4 层 coverage，PNG decode +
//     generateMipmap；decode 失败时 loadWeatherTextures 返 1×1 全白 fallback——满 coverage 连续云墙
//     会显形地平线白线）
//   - turbulenceTexture（M2 dummy）：1×1 RGBA（128,128,128,255）→ 中性位移
//   - stbnTexture：weather.stbn 真 3D 资产（128×128×64 R8 蓝噪声；白噪声 dummy 会显形全屏雪花纹）

import {
  Texture,
  Texture3D,
  PixelFormat,
  PixelDatatype,
  Sampler,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  TextureWrap,
  Cartesian2,
  Cartesian3,
  type Scene,
  type Context
} from 'cesium'
import {
  createVolumetricPrimitive,

  type VolumetricPrimitive,
  type AtmosphereLUTs
} from '@cesium-geospatial/core'
import { buildCloudsMainFragmentShader, type CloudsMainOptions } from './CloudsMaterial'
import {
  defaultCloudsParameters,
  type CloudsParameters
} from './cloudsDefaultParameters'
import type { WeatherTextures } from './weatherTextures'

/**
 * 检测 PostProcessStage/RT 可用的最高 HDR 像素数据类型（对齐 core AtmosphereStage.resolvePostHdrDatatype，
 * 但 core 未从 index 导出——本函数内联以遵守「不碰 core」约束）。
 *
 * HALF_FLOAT 优先（精度够 + 性能好），FLOAT 次选，UNSIGNED_BYTE 兜底（线性 >1 段被 clip）。
 * 云 MRT colorTex 需 HDR 承载 applyAerialPerspective 线性输出（>1 段供 overlay ACES 压缩）。
 */
function resolveCloudsHdrDatatype(scene: Scene): number {
  const ctx = (scene as unknown as {
    context: {
      halfFloatingPointTexture: boolean
      colorBufferHalfFloat: boolean
      floatingPointTexture: boolean
      colorBufferFloat: boolean
    }
  }).context
  if (ctx.halfFloatingPointTexture && ctx.colorBufferHalfFloat) {
    return PixelDatatype.HALF_FLOAT
  }
  if (ctx.colorBufferFloat && ctx.floatingPointTexture) {
    return PixelDatatype.FLOAT
  }
  return PixelDatatype.UNSIGNED_BYTE
}

// 相对亮度常量（逐字对齐 core AtmosphereStage.ts:147-157；SUN/SKY_SPECTRAL_RADIANCE_TO_LUMINANCE
// = sunRadianceToLuminance / sunLuminance，sunLuminance ≈ 75722.23）。clouds.frag 声明此二 uniform
// 用于 ACCURATE_SUN_SKY_LIGHT 路径的 GetSunAndSkyScalarIrradiance 量纲换算。
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

// SHADOW_CASCADE_COUNT=4（CloudsMaterial.ts CLOUDS_MAIN_DEFINES）。BSM cascade 数，M2 dummy 全 0/identity。
const SHADOW_CASCADE_COUNT = 4

/**
 * 每帧可变状态（createCloudsStage 持有并 preRender 更新；CloudsPass uniformMap 闭包读引用）。
 * 仿 core AtmosphereFrameState。sunDirection 为 ECEF 单位向量；altitudeCorrection 为密切球偏移（米）。
 */
export interface CloudsFrameState {
  sunDirection: Cartesian3
  altitudeCorrection: Cartesian3
}

/** CloudsPass 构造选项。 */
export interface CloudsPassOptions extends CloudsMainOptions {
  /** 业务参数覆盖（缺省取 defaultCloudsParameters）。M6 qualityPresets 用。 */
  parameters?: CloudsParameters
}

/** CloudsPass 句柄：持 primitive + MRT textures + uniformMap + bridge getter + destroy。 */
export interface CloudsPass {
  /** att0 color Tex bridge（{_texture,_target}，注入 overlay PostProcessStage uniform）。 */
  getColorBridge(): { _texture: unknown; _target: number }
  /** att0 color Tex（直接引用，调试/probe 用）。 */
  readonly colorTexture: Texture
  /** VolumetricPrimitive（已 add 到 scene.primitives；destroy 时摘除）。 */
  readonly primitive: VolumetricPrimitive
  /** 释放：摘 primitive + destroy MRT 3 texture + dummy texture（FBO 由 primitive.destroy 释放）。幂等。 */
  destroy(): void
}

// Cesium 公开 .d.ts 缺 drawingBufferWidth/Height（Context augment 为空 interface）。局部补最小形状。
interface CesiumContext extends Context {
  drawingBufferWidth: number
  drawingBufferHeight: number
}

// scene._view.globeDepth.depthStencilTexture 私有路径（spec 附录 F5）。局部类型隔离私有 API。
interface GlobeDepthView {
  _view?: { globeDepth?: { depthStencilTexture?: Texture } }
}

/**
 * 创建云主 march Pass（custom Primitive pass=VOXELS + 3-attachment MRT FBO + 全 business uniform）。
 *
 * @param scene Cesium scene（取 context + camera + globe ellipsoid；primitive add 到 scene.primitives）。
 * @param luts 大气 LUT（transmittance/scattering/irradiance/single_mie/higher_order；与 AtmosphereStage 共享）。
 * @param weather weather 噪声纹理（shape + shapeDetail 3D Texture；M2 dummy localWeather）。
 * @param state 每帧可变状态（sunDirection/altitudeCorrection；createCloudsStage 持有更新）。
 * @param options 桥接选项 + 业务参数覆盖。
 */
export function createCloudsPass(
  scene: Scene,
  luts: AtmosphereLUTs,
  weather: WeatherTextures,
  state: CloudsFrameState,
  options: CloudsPassOptions = {}
): CloudsPass {
  const context = (scene as unknown as { context: CesiumContext }).context
  const params = options.parameters ?? defaultCloudsParameters()
  const width = context.drawingBufferWidth || 256
  const height = context.drawingBufferHeight || 256

  // ── HDR pixel datatype 检测（内联，对齐 core resolvePostHdrDatatype）──
  // colorTex 需 HDR 承载线性云 radiance（applyAerialPerspective 输出线性 >1 段）；depthVel/shadowLen
  // 跟随同类型（M2 不消费，但保持 MRT attachment 类型一致避免类型 mismatch）。
  const pixelDatatype = resolveCloudsHdrDatatype(scene)

  // ── 3 MRT color attachment（NEAREST 像素对齐 + CLAMP_TO_EDGE，同 spike SPIKE_SAMPLER）──
  const mrtSampler = new Sampler({
    minificationFilter: TextureMinificationFilter.NEAREST,
    magnificationFilter: TextureMagnificationFilter.NEAREST,
    wrapS: TextureWrap.CLAMP_TO_EDGE,
    wrapT: TextureWrap.CLAMP_TO_EDGE
  })
  const mkMrtTex = (): Texture =>
    new Texture({
      context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype,
      sampler: mrtSampler
    })
  const colorTex = mkMrtTex() // att0：云 color（RGB linear HDR）+ transmittance（A）
  const depthVelTex = mkMrtTex() // att1：depthVelocity（M4 temporal 接通；M2 写 0 不消费）
  // M2 只 attach 2（color + depthVelocity）：FBO drawBuffers 数必须匹配 shader out 数——
  // M2 不 define SHADOW_LENGTH，shader 只有 location 0/1 两个 out；3 attachment + 2 out 触发
  // GL_INVALID_OPERATION "Active draw buffers with missing fragment shader outputs"（实测）。
  // M5 define SHADOW_LENGTH 时 shader 加 location 2 out（outputShadowLength），届时加 shadowLenTex
  // 成 3 attachment。
  const mrtTextures = [colorTex, depthVelTex]

  // ── dummy texture（M3/M4/M5/M6 未接通项）──
  // shadowBuffer 用 Texture3D（sampler3D）：Cesium createUniform 不认 sampler2DArray（type 36289，
  // bind 炸 "Unrecognized uniform type"）。CloudsMaterial.ts surgery 把 clouds.frag
  // `uniform sampler2DArray shadowBuffer` → `uniform sampler3D shadowBuffer`。depth=SHADOW_CASCADE_COUNT
  // 当 cascade 维度，全 0 → Beer-Lambert 1（M3 BSM）。texture(sampler3D, vec3) 与 sampler2DArray
  // 调用兼容；M3 真实 BSM 时 cascade 离散化处理。
  const dummyShadowBuffer = new Texture3D({
    context,
    source: {
      width: 1,
      height: 1,
      depth: SHADOW_CASCADE_COUNT,
      arrayBufferView: new Uint8Array(SHADOW_CASCADE_COUNT * 4) // 全 0
    },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    flipY: false
  })

  const dummyDepthBuffer = new Texture({
    context,
    source: {
      width: 1,
      height: 1,
      arrayBufferView: new Uint8Array([255, 255, 255, 255])
    },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE
  }) // depth=1.0 → getRayDistanceToScene 远截断（M6 接通真实 globe depthTexture + log-depth 转换）

  const dummyTurbulence = new Texture({
    context,
    source: {
      width: 1,
      height: 1,
      arrayBufferView: new Uint8Array([128, 128, 128, 255])
    },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE
  }) // 中性位移（M2 dummy；procedural turbulence M6 接通）

  // STBN 蓝噪声（march per-pixel jitter）：weather.stbn 真 3D 资产（128×128×64 R8，takram 打包）。
  // 白噪声 dummy（CPU Math.random 64×64×4）会让 jitter 显形为全屏雪花纹（实测 2026-08-14）——
  // 蓝噪声误差能量在人眼不敏感高频段，观感平滑。frame=0 静态采样 layer 0（M4 temporal 接通后
  // 递增轮换层 + temporal reprojection 收敛）。

  // ── globe depth 闭包（spec 附录 F5：私有 API scene._view.globeDepth.depthStencilTexture）──
  // M6 提前接通（2026-08-14）：depthBuffer uniform 直连 globe depth（云被地形截断/遮挡）；
  // 未就绪时 uniformMap fallback 1×1 val=1.0 dummy（远截断，无遮挡降级）。
  const globeDepthTexture = (): Texture | undefined => {
    const view = (scene as unknown as GlobeDepthView)._view
    return view?.globeDepth?.depthStencilTexture
  }

  // ── uniformMap：注入 clouds.frag + parameters.glsl 全部 business uniform ──
  // 每帧可变量（sun/altitude/cameraHeight/resolution）走闭包读 state/scene；静态量取 params。
  // ATMOSPHERE / densityProfile 已由 CloudsMaterial.ts const 注入，不在此声明。
  // viewMatrix/cameraNear/cameraFar 已由 CloudsMaterial.ts #define 重定向到 czm_*，不在此声明。
  // cameraHeight：测地高度（米，ellipsoid 起算）——clouds.frag L745 与 minHeight/maxHeight（米）
  // 比较（云层上下判定）。用 camera.positionCartographic.height（Cesium 内置换算，勿用
  // |positionWC| 地心距——赤道海平面地心距 6.378e6 ≠ 测地高 0，会错走「相机在云上方」分支）。
  const cameraHeight = (): number => scene.camera.positionCartographic.height
  // resolution scratch：闭包持 module-scratch Cartesian2（避免每帧分配，仿 lensflare texelSizeForSourceScale）。
  const resolutionScratch = new Cartesian2()
  const resolution = (): Cartesian2 => {
    resolutionScratch.x = context.drawingBufferWidth
    resolutionScratch.y = context.drawingBufferHeight
    return resolutionScratch
  }

  const uniformMap: { [name: string]: () => unknown } = {
    // 大气 LUT（与 AtmosphereStage buildAtmosphereUniforms 同源）
    transmittance_texture: () => luts.transmittance,
    scattering_texture: () => luts.scattering,
    single_mie_scattering_texture: () => luts.scattering, // COMBINED 模式不采样，传同值占位
    irradiance_texture: () => luts.irradiance,
    higher_order_scattering_texture: () => luts.higherOrderScattering, // C9：云 god rays 防过暗

    // SUN/SKY 光度换算（const，ACCURATE_SUN_SKY_LIGHT 路径用）
    SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: () => SUN_SPECTRAL_RADIANCE_TO_LUMINANCE,
    SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: () => SKY_SPECTRAL_RADIANCE_TO_LUMINANCE,

    // 相机/场景（每帧闭包）
    cameraHeight,
    resolution,
    frame: () => params.frame,
    targetUvScale: () => params.targetUvScale,
    mipLevelScale: () => params.mipLevelScale,

    // 大气（bottomRadius 静态；altitudeCorrection/sunDirection/worldToECEFMatrix 每帧闭包）
    bottomRadius: () => params.bottomRadius,
    worldToECEFMatrix: () => params.worldToECEFMatrix,
    ecefToWorldMatrix: () => params.ecefToWorldMatrix,
    altitudeCorrection: () => state.altitudeCorrection,
    sunDirection: () => state.sunDirection,

    // 参与 medium
    scatteringCoefficient: () => params.scatteringCoefficient,
    absorptionCoefficient: () => params.absorptionCoefficient,

    // 主 raymarch
    maxIterationCount: () => params.maxIterationCount,
    minStepSize: () => params.minStepSize,
    maxStepSize: () => params.maxStepSize,
    maxRayDistance: () => params.maxRayDistance,
    perspectiveStepScale: () => params.perspectiveStepScale,
    minDensity: () => params.minDensity,
    minExtinction: () => params.minExtinction,
    minTransmittance: () => params.minTransmittance,

    // 次 raymarch
    maxIterationCountToSun: () => params.maxIterationCountToSun,
    maxIterationCountToGround: () => params.maxIterationCountToGround,
    minSecondaryStepSize: () => params.minSecondaryStepSize,
    secondaryStepScale: () => params.secondaryStepScale,

    // scatter 视觉
    skyLightScale: () => params.skyLightScale,
    groundBounceScale: () => params.groundBounceScale,
    powderScale: () => params.powderScale,
    powderExponent: () => params.powderExponent,

    // weather/shape（localWeather 真纹理——decode 失败时 loadWeatherTextures 提供 1×1 全白
    // fallback；turbulence dummy）
    localWeatherTexture: () => weather.localWeather,
    localWeatherRepeat: () => params.localWeatherRepeat,
    localWeatherOffset: () => params.localWeatherOffset,
    coverage: () => params.coverage,
    shapeTexture: () => weather.shape,
    shapeRepeat: () => params.shapeRepeat,
    shapeOffset: () => params.shapeOffset,
    shapeDetailTexture: () => weather.shapeDetail,
    shapeDetailRepeat: () => params.shapeDetailRepeat,
    shapeDetailOffset: () => params.shapeDetailOffset,
    turbulenceTexture: () => dummyTurbulence,
    turbulenceRepeat: () => params.turbulenceRepeat,
    turbulenceDisplacement: () => params.turbulenceDisplacement,

    // 云层 packed（CloudLayers.DEFAULT 展开）
    minLayerHeights: () => params.minLayerHeights,
    maxLayerHeights: () => params.maxLayerHeights,
    minIntervalHeights: () => params.minIntervalHeights,
    maxIntervalHeights: () => params.maxIntervalHeights,
    densityScales: () => params.densityScales,
    shapeAmounts: () => params.shapeAmounts,
    shapeDetailAmounts: () => params.shapeDetailAmounts,
    weatherExponents: () => params.weatherExponents,
    shapeAlteringBiases: () => params.shapeAlteringBiases,
    coverageFilterWidths: () => params.coverageFilterWidths,
    minHeight: () => params.minHeight,
    maxHeight: () => params.maxHeight,
    shadowTopHeight: () => params.shadowTopHeight,
    shadowBottomHeight: () => params.shadowBottomHeight,
    shadowLayerMask: () => params.shadowLayerMask,

    // BSM（M3，M2 dummy）
    shadowBuffer: () => dummyShadowBuffer,
    shadowTexelSize: () => params.shadowTexelSize,
    shadowIntervals: () => params.shadowIntervals,
    shadowMatrices: () => params.shadowMatrices,
    shadowFar: () => params.shadowFar,
    maxShadowFilterRadius: () => params.maxShadowFilterRadius,

    // reprojection（M4，M2 dummy identity → velocity 0）
    reprojectionMatrix: () => params.reprojectionMatrix,
    viewReprojectionMatrix: () => params.viewReprojectionMatrix,
    temporalJitter: () => params.temporalJitter,

    // depth（M6 提前接通，2026-08-14）：真实 globe depthTexture（log-depth 编码，shader 内
    // czm_reverseLogDepthWindow 反演）→ 云被地形正确截断/遮挡（青藏「云浮地形上」修）。
    // globeDepth 未就绪（首帧/_view 缺失）时 fallback 1×1 val=1.0 dummy（远截断，无遮挡降级）。
    depthBuffer: () => globeDepthTexture() ?? dummyDepthBuffer,

    // STBN（weather.stbn 真 3D 资产；M4 temporal 接通后 frame 递增轮换层）
    stbnTexture: () => weather.stbn
  }

  // ── VolumetricPrimitive 装配（M1 基建）──
  const fragmentShaderSource = buildCloudsMainFragmentShader(options)
  const primitive = createVolumetricPrimitive({
    context,
    fragmentShaderSource,
    uniformMap,
    mrtColorTextures: mrtTextures,
    globeDepthTexture
  })
  const primitives = scene.primitives as unknown as {
    add: (p: VolumetricPrimitive) => void
    remove: (p: VolumetricPrimitive) => boolean
  }
  primitives.add(primitive)

  // ── att0 bridge（注入 overlay PostProcessStage uniform，仿 historyBlit getHistoryBridge）──
  const colorBridge = (): { _texture: unknown; _target: number } => {
    const internal = colorTex as unknown as { _texture: unknown; _target: number }
    return { _texture: internal._texture, _target: internal._target }
  }

  let destroyed = false
  return {
    primitive,
    colorTexture: colorTex,
    getColorBridge: colorBridge,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      primitives.remove(primitive)
      primitive.destroy() // 释放 MRT FBO（GL framebuffer handle），destroyAttachments=false 不连带 texture
      mrtTextures.forEach((t) => t.destroy())
      dummyDepthBuffer.destroy()
      dummyTurbulence.destroy()
      // dummyShadowBuffer Texture3D destroy（公开 .d.ts 未声明 destroy，cast 调用）
      ;(dummyShadowBuffer as unknown as { destroy: () => void }).destroy() // sampler3D dummy，M3 BSM 接通时换真实；公开 .d.ts 未声明 destroy，cast
    }
  }
}
