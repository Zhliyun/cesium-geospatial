// cloudsDefaultParameters.ts
//
// M2 T2：clouds.frag + parameters.glsl 业务 uniform 默认值（flat 标量/向量，不含 struct——
// ATMOSPHERE / densityProfile 经 CloudsMaterial.ts const 注入，不经 uniformMap）。
//
// 值来源（逐字对齐 three-geospatial）：
//   - 参与 medium / weather / shape 参数：three-geospatial/uniforms.ts createCloudParameterUniforms
//   - raymarch 参数（maxIterationCount 等）：qualityPresets.ts defaults（= high 档）
//   - scatter 视觉参数（skyLightScale/powderScale 等）：CloudsMaterial.ts:212-215
//   - 云层 packed 向量（minLayerHeights/densityScales 等）：CloudLayers.DEFAULT（CloudLayers.ts:31-68）
//     经 packValues / packSums / packIntervalHeights（uniforms.ts:124-186）展开
//   - BSM 参数（shadowMatrices/shadowIntervals 等）：M2 dummy（M3 BSM 接通后由 CascadedShadowMaps 算）
//
// 纯数据模块（无 Cesium 依赖，除 Cartesian2/3/4/Matrix4 类型）→ node 单测可直接断言。
// 参数化：createCloudsStage 透传 options 覆盖默认（M6 qualityPresets 用）。

import { Cartesian2, Cartesian3, Cartesian4, Matrix4 } from 'cesium'

/**
 * M2 clouds 业务 uniform 默认值（flat，struct 已 const 注入）。
 *
 * 分组（对齐 clouds.frag + parameters.glsl 声明顺序）：
 *   - 相机/场景（cameraHeight/resolution/frame/targetUvScale/mipLevelScale）
 *   - 大气（bottomRadius/worldToECEFMatrix/ecefToWorldMatrix/altitudeCorrection/sunDirection）
 *   - 参与 medium（scatteringCoefficient/absorptionCoefficient）
 *   - 主 raymarch（maxIterationCount/minStepSize/...）
 *   - 次 raymarch（maxIterationCountToSun/...）
 *   - scatter 视觉（skyLightScale/powderScale/...）
 *   - weather/shape（coverage/localWeatherRepeat/shapeRepeat/...）
 *   - 云层 packed（minLayerHeights/densityScales/...）
 *   - BSM dummy（shadowMatrices/shadowIntervals/...，M3 接通）
 *   - reprojection dummy（reprojectionMatrix/viewReprojectionMatrix/temporalJitter，M4 接通）
 *   - depth dummy（depthBuffer 占位，M6 接通真实 globe depthTexture）
 *
 * 注：cameraHeight/altitudeCorrection/sunDirection/resolution 是每帧可变量，createCloudsPass
 * 用闭包读 scene/state，本表的值仅作 fallback / 静态量。
 */
export interface CloudsParameters {
  // ── 相机/场景（每帧由 createCloudsPass 闭包覆盖）──
  /** frame 计数（M2 固定 0；M4 temporal 接通后递增）。 */
  frame: number
  /** targetUvScale：M2 全分（1,1）；M4 1/4 分 march 时 (0.25, 0.25)。 */
  targetUvScale: Cartesian2
  /** mipLevelScale：texture mip 级别缩放（three CloudsMaterial 默认 1）。 */
  mipLevelScale: number

  // ── 大气（bottomRadius 静态；altitudeCorrection/sunDirection 每帧由闭包覆盖）──
  /** bottomRadius：密切球底半径 km（= ATMOSPHERE.bottomRadius = 6360，METER_TO_LENGTH_UNIT 换算后）。 */
  bottomRadius: number
  /** worldToECEFMatrix：M2 ECEF 直采（identity）；M6 密切球再中心化时由 scene 算。 */
  worldToECEFMatrix: Matrix4
  /** ecefToWorldMatrix：M2 identity（worldToECEFMatrix 逆）。 */
  ecefToWorldMatrix: Matrix4

  // ── 参与 medium ──
  scatteringCoefficient: number
  absorptionCoefficient: number

  // ── 主 raymarch（qualityPresets high 档）──
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  maxRayDistance: number
  perspectiveStepScale: number
  minDensity: number
  minExtinction: number
  minTransmittance: number

  // ── 次 raymarch（qualityPresets high 档）──
  maxIterationCountToSun: number
  maxIterationCountToGround: number
  minSecondaryStepSize: number
  secondaryStepScale: number

  // ── scatter 视觉（CloudsMaterial.ts 默认）──
  skyLightScale: number
  groundBounceScale: number
  powderScale: number
  powderExponent: number

  // ── weather/shape（uniforms.ts + CloudsEffect 默认）──
  coverage: number
  localWeatherRepeat: Cartesian2
  localWeatherOffset: Cartesian2
  shapeRepeat: Cartesian3
  shapeOffset: Cartesian3
  shapeDetailRepeat: Cartesian3
  shapeDetailOffset: Cartesian3
  turbulenceRepeat: Cartesian2
  turbulenceDisplacement: number

  // ── 云层 packed（CloudLayers.DEFAULT 经 packValues/packSums/packIntervalHeights 展开）──
  /** minLayerHeights = packValues('altitude') = (l0.altitude, l1.altitude, l2.altitude, l3.altitude)。 */
  minLayerHeights: Cartesian4
  /** maxLayerHeights = packSums('altitude','height') = (l0.alt+l0.h, l1.alt+l1.h, ...)。 */
  maxLayerHeights: Cartesian4
  /** minIntervalHeights = packIntervalHeights 第 0/1/2 段 min（见 uniforms.ts:141）。 */
  minIntervalHeights: Cartesian3
  /** maxIntervalHeights = packIntervalHeights 第 0/1/2 段 max。 */
  maxIntervalHeights: Cartesian3
  densityScales: Cartesian4
  shapeAmounts: Cartesian4
  shapeDetailAmounts: Cartesian4
  weatherExponents: Cartesian4
  shapeAlteringBiases: Cartesian4
  coverageFilterWidths: Cartesian4
  minHeight: number
  maxHeight: number
  shadowTopHeight: number
  shadowBottomHeight: number
  shadowLayerMask: Cartesian4

  // ── BSM（M3，M2 dummy）──
  /** shadowTexelSize：M2 dummy (1,1)；M3 BSM 接通后 = 1/mapSize。 */
  shadowTexelSize: Cartesian2
  /** shadowIntervals[4]：M2 dummy 全 0；M3 BSM cascade 区间。 */
  shadowIntervals: Cartesian2[]
  /** shadowMatrices[4]：M2 dummy identity；M3 BSM cascade VP。 */
  shadowMatrices: Matrix4[]
  shadowFar: number
  maxShadowFilterRadius: number

  // ── reprojection（M4，M2 dummy）──
  /** reprojectionMatrix：M2 identity（velocity 0，outputDepthVelocity 写 0 但 M2 不消费）。 */
  reprojectionMatrix: Matrix4
  /** viewReprojectionMatrix：M2 identity。 */
  viewReprojectionMatrix: Matrix4
  /** temporalJitter：M2 (0,0)；M4 Bayer 4×4 抖动。 */
  temporalJitter: Cartesian2
}

/**
 * CloudLayers.DEFAULT（three-geospatial CloudLayers.ts:31-68）packed uniform 默认值。
 *
 * 4 层：
 *   L0 r  altitude=750  height=650   densityScale=0.2   shapeAmount=1    shapeDetail=1  weatherExp=1  shapeAlter=0.35  coverageFW=0.6  shadow=true
 *   L1 g  altitude=1000 height=1200  densityScale=0.2   shapeAmount=1    shapeDetail=1  weatherExp=1  shapeAlter=0.35  coverageFW=0.6  shadow=true
 *   L2 b  altitude=7500 height=500   densityScale=0.003 shapeAmount=0.4  shapeDetail=0  weatherExp=1  shapeAlter=0.35  coverageFW=0.5  shadow=false
 *   L3 a  altitude=0    height=0     (default CloudLayer)
 *
 * packIntervalHeights 算法（uniforms.ts:141-180）：entries 排序后 balance=0 处切区间。
 *   entries: (0,open)(0,close)(750,open)(1000,open)(1400,close)(2200,close)(7500,open)(8000,close)
 *   区间: [0,750] [2200,7500] [0,0]
 *   → minIntervalHeights=(0, 2200, 0), maxIntervalHeights=(750, 7500, 0)
 */
export function defaultCloudsParameters(): CloudsParameters {
  return {
    // 相机/场景
    frame: 0,
    targetUvScale: new Cartesian2(1.0, 1.0),
    mipLevelScale: 1.0,

    // 大气（bottomRadius = ATMOSPHERE.bottomRadius = 6360000 米——clouds.frag 坐标全程米：
    // L369 height = length(position) - bottomRadius、L736 bottomRadius + minHeight 均 meter 单位。
    // 注意：这与 Bruneton GLSL const ATMOSPHERE.bottom_radius=6360（km，经 METER_TO_LENGTH_UNIT）
    // 不同——clouds 的 bottomRadius uniform 是 three-atmosphere TS 侧原始米值）
    bottomRadius: 6360000,
    worldToECEFMatrix: Matrix4.IDENTITY,
    ecefToWorldMatrix: Matrix4.IDENTITY,

    // 参与 medium（uniforms.ts:50-51）
    scatteringCoefficient: 1.0,
    absorptionCoefficient: 0.0,

    // 主 raymarch（qualityPresets defaults = high）
    maxIterationCount: 500,
    minStepSize: 50,
    maxStepSize: 1000,
    maxRayDistance: 2e5,
    perspectiveStepScale: 1.01,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 1e-2,

    // 次 raymarch（qualityPresets defaults）
    maxIterationCountToSun: 2,
    maxIterationCountToGround: 3,
    minSecondaryStepSize: 100,
    secondaryStepScale: 2,

    // scatter 视觉（CloudsMaterial.ts:212-215）
    skyLightScale: 1.0,
    groundBounceScale: 1.0,
    powderScale: 0.8,
    powderExponent: 150.0,

    // weather/shape（uniforms.ts:54 + CloudsEffect.ts:180-186）
    coverage: 0.3,
    localWeatherRepeat: new Cartesian2(100.0, 100.0),
    localWeatherOffset: new Cartesian2(0.0, 0.0),
    shapeRepeat: new Cartesian3(0.0003, 0.0003, 0.0003),
    shapeOffset: new Cartesian3(0.0, 0.0, 0.0),
    shapeDetailRepeat: new Cartesian3(0.006, 0.006, 0.006),
    shapeDetailOffset: new Cartesian3(0.0, 0.0, 0.0),
    turbulenceRepeat: new Cartesian2(20.0, 20.0),
    turbulenceDisplacement: 350.0,

    // 云层 packed（CloudLayers.DEFAULT）
    minLayerHeights: new Cartesian4(750, 1000, 7500, 0),
    maxLayerHeights: new Cartesian4(1400, 2200, 8000, 0),
    minIntervalHeights: new Cartesian3(0, 2200, 0),
    maxIntervalHeights: new Cartesian3(750, 7500, 0),
    densityScales: new Cartesian4(0.2, 0.2, 0.003, 0.2),
    shapeAmounts: new Cartesian4(1, 1, 0.4, 1),
    shapeDetailAmounts: new Cartesian4(1, 1, 0, 1),
    weatherExponents: new Cartesian4(1, 1, 1, 1),
    shapeAlteringBiases: new Cartesian4(0.35, 0.35, 0.35, 0.35),
    coverageFilterWidths: new Cartesian4(0.6, 0.6, 0.5, 0.6),
    minHeight: 750,
    maxHeight: 8000,
    shadowTopHeight: 2200, // layer 0,1 shadow=true → max(altitude+height) = 2200
    shadowBottomHeight: 750, // min(altitude) with shadow=true
    shadowLayerMask: new Cartesian4(1, 1, 0, 0),

    // BSM（M3，M2 dummy）
    shadowTexelSize: new Cartesian2(1.0, 1.0),
    shadowIntervals: [
      new Cartesian2(0, 0),
      new Cartesian2(0, 0),
      new Cartesian2(0, 0),
      new Cartesian2(0, 0)
    ],
    shadowMatrices: [
      Matrix4.IDENTITY,
      Matrix4.IDENTITY,
      Matrix4.IDENTITY,
      Matrix4.IDENTITY
    ],
    shadowFar: 0,
    maxShadowFilterRadius: 6,

    // reprojection（M4，M2 dummy identity → velocity 0）
    reprojectionMatrix: Matrix4.IDENTITY,
    viewReprojectionMatrix: Matrix4.IDENTITY,
    temporalJitter: new Cartesian2(0.0, 0.0)
  }
}
