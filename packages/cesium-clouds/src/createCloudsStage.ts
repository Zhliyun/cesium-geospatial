// createCloudsStage.ts
//
// M2 T3：顶层工厂——编排 CloudsPass + cloudsBuffer bridge → 接 createAtmosphereStage PostProcess 链
// （cloudsBuffer overlay 在 atmosphere 之后，spec §4.3）。czm 桥接（spec §4.2）：
//   - sunDirection：Simon1994 + ICRF→Fixed → ECEF（preRender 每帧更新，仿 AtmosphereStage）
//   - altitudeCorrection：getAltitudeCorrectionOffset（密切球再中心化，R2 防大坐标单精度失效）
//   - reprojectionMatrix/viewReprojectionMatrix/temporalJitter：M2 dummy identity/0（M4 temporal 接通）
//
// M3 T5 BSM 编排（本文件新增，plan 决策 D2/D5/D6）：
//   - preRender（sunDirection 更新后）：太阳天顶角 → 虚拟光源距离 lerp(1e6, 1e3, zenith)
//     （three CloudsEffect.ts:387 语义）→ CascadedShadowMaps.update（near/far = 完整视锥
//     preRender 时刻值；far 与 maxRayDistance 取小，D6）→ shadowState.matrices/intervals/
//     cameraNear/far 覆写 → ShadowPass.render()（先于云 march VOXELS pass，此刻 GL 状态干净）
//   - ShadowPass uniformMap = buildSharedCloudsUniforms（与主 march 同源共享段，CloudsPass.ts
//     抽出）+ BSM 专属（inverseShadowMatrices 数组闭包 + shadowMarch 档 7 参数平铺）
//   - options.shadowPass=false（demo ?cloudsShadow=0）→ 诊断基线：不建 cascades/ShadowPass，
//     state.shadow 恒 undefined → 主 march fallback dummy → Beer=1（无自阴影，M2 行为）
//
// BSM world 锚定编排（T4，spec v3 §3.1——缺省 world，?cloudsShadowAnchor=frustum 回退）：
//   - cascades 构造按 shadowAnchor 分支（world 用类内缺省设计值 radii/intervals）
//   - preRender BSM 段：world 分支太阳量化喂矩阵（march/消费端精确，§3.1.8）、far 固定
//     min(maxRayDistance, SHADOW_FAR_LIMIT)（不随视锥）、cameraNear=0（§3.1.5）、distance
//     不传（z 盒解析）；frustum 分支 bit 级保留现行为（AB 基线）
//
// 静止跳过（T5，spec §3.2）：cascades.update 返回矩阵是否变化（world 语义键），静止帧
// 跳过整段矩阵覆写 + shadowPass.render（重 march 必产出相同内容——白赚）；与 shadowFreeze
// 诊断正交（freeze=update 不跑、render 照常每帧——冻结网格重 march 是其噪声分解语义）。
//
// M4 temporal 编排（plan D1/D2/D7）：
//   - 云端（options.temporal≠false，demo ?cloudsTemporal=0 关）：march 1/4 分（CloudsPass
//     temporalUpscale）→ CloudsResolvePass（第二个 VOXELS primitive，add 在 march 之后——
//     同 pass 内 PrimitiveCollection 数组序即执行序）Bayer 4×4 全分重建 + velocity
//     reprojection + variance clipping；overlay 的 u_cloudsBuffer 切读 resolve 输出
//   - preRender 顺序：resolvePass.swapBuffers() 最前（等价 three render 后 swap）→
//     params.frame++（march/BSM 生成端 frame uniform 已按各端 temporal 开关拆分绑定，
//     单端关时不闪烁）→ Bayer jitter + reprojection 矩阵（temporalMath，ECEF 域 +
//     preRender 完整视锥矩阵）→ BSM setCurrentMatrices（render 内部 prev=上帧、末尾存本帧）
//   - BSM 端（options.shadowTemporal≠false）：ShadowPass temporalPass（velocity 层 +
//     shadowResolve ping-pong，T5）；state.shadow.bsm = resolve 后 history（getter 自动）
//
// 集成（spec §4.3 + 附录 F4）：
//   - CloudsPass 是 Primitive（非 PostProcessStage）→ cloudsBuffer（att0）必须用 bridge {_texture,_target}
//     注入 overlay PostProcessStage uniform（不能用 uniform-name string，F4）
//   - overlay 在 atmosphere 链尾 append（Cesium PostProcessStageCollection 仅支持 add 末尾追加，
//     无法 insert 到 atmosphere 与 tonemap 之间——「不碰 core」约束下不修改 createAtmosphereStage）
//   - M2 简化：overlay 读 tonemap 输出（display space）+ cloudsBuffer（linear HDR），对 cloud 先
//     ACES+gamma 到 display space 再 alpha mix。M3+ 若需精确线性合成，可改 createAtmosphereStage 支持
//     stage 插入 hook（或独立 cloudsOverlayStage 提前到 atmosphere 后 tonemap 前）
//
// 零回归：clouds:false（或不传）→ 不创建 primitive/stage，返回 undefined（demo 可无条件调用）。

import {
  PostProcessStage,
  PostProcessStageSampleMode,
  Cartesian2,
  Cartesian3,
  Matrix4,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  JulianDate,
  PixelFormat,
  PixelDatatype,
  Texture,
  type Scene,
  type Context
} from 'cesium'
import {
  getAltitudeCorrectionOffset,
  ATMOSPHERE_BOTTOM_RADIUS_M,
  type AtmosphereLUTs
} from '@cesium-geospatial/core'
import {
  createCloudsPass,
  buildSharedCloudsUniforms,
  resolveCloudsHdrDatatype,
  type CloudsPass,
  type CloudsFrameState,
  type CloudsPassOptions
} from './CloudsPass'
import { createCloudsResolvePass, type CloudsResolvePass } from './CloudsResolvePass'
import {
  computeTemporalJitter,
  buildReprojectionMatrices,
  type TemporalCameraSnapshot
} from './temporalMath'
import { CascadedShadowMaps } from './CascadedShadowMaps'
import { createShadowPass, type ShadowPass } from './ShadowPass'
import { quantizeSunDirection, SUN_QUANT_STEP } from './sunQuantization'
import {
  defaultCloudsParameters,
  type CloudsParameters,
  type CloudsShadowFrameState
} from './cloudsDefaultParameters'
import type { WeatherTextures } from './weatherTextures'

/** createCloudsStage 选项（透传 CloudsPassOptions + clouds 开关）。 */
export interface CloudsStageOptions extends CloudsPassOptions {
  /**
   * clouds 开关（默认 false → 不创建 stage，零回归）。
   * demo 在 atmosphere mode 内 `?clouds=1` 时传 true。
   */
  clouds?: boolean
  /**
   * overlay 云曝光（默认 10，对齐 three 版 clouds storybook ToneMapping exposure 标定）。
   * demo `?cloudsExposure=N` 调节（偏灰→调大；过曝→调小）。
   */
  cloudsOverlayExposure?: number
  /**
   * M3 BSM 自阴影生成开关（默认 true）。false = 诊断基线：不创建 CascadedShadowMaps/
   * ShadowPass，state.shadow 恒 undefined → 主 march fallback 全 0 dummy → Beer=1
   * （无自阴影，M2 flat 行为；对比云体积感用）。demo `?cloudsShadow=0`。
   */
  shadowPass?: boolean
  /**
   * M4 云 temporal resolve 开关（**默认 false**——2026-08-17 用户验收：静止云明显高频抖动
   * （连拍逐对差分 12-16% 持续），根因是 velocity 含云前点 Bayer 相位跳动分量 + gamma=2
   * 宽 AABB 下 history 错位值不被裁住，收敛锁建立不起来。修复需精化 velocity（相位差
   * 纯化）或自适应 AABB，留专门迭代。true（demo `?cloudsTemporal=1`）= 1/4 分 march +
   * CloudsResolvePass（Bayer 重建 + velocity reprojection + variance clipping）——帧率
   * 优势明显（120fps vs 全分卡死），代价是当前抖动。false = M2/M3 稳定行为（全分 march、
   * 无 resolve、overlay 直读 march att0）。
   */
  temporal?: boolean
  /**
   * M4 BSM temporal resolve 开关（**默认 false**，同上——抖动排查期间保守默认；BSM 端
   * 机制已验证可用，生成端 jitter + 0.01 慢收敛）。demo `?cloudsShadowTemporal=1` 开。
   */
  shadowTemporal?: boolean
  /**
   * 诊断：冻结 cascade 矩阵（首帧 update 后不再更新，BSM 在冻结网格上每帧重 march）。
   * 噪声分解实验用——「冻结矩阵 + 相机移动」录屏差分 = 非矩阵噪声地板（层切换/jitter/
   * 消费端通道），与不冻结对照相减得矩阵通道分量。demo `?cloudsShadowFreeze=1`。
   * 与 T5 静止跳过正交：freeze 下 update 不跑但 render 照常每帧（重 march 正是实验内容）。
   */
  shadowFreeze?: boolean
  /**
   * BSM 矩阵锚定模式（spec v3）：'world'（缺省）= 世界锚定固定网格（interval 常数
   * {0,10,21,60}km、相机 light 投影 snap 固定 texel 网格、太阳量化喂矩阵、far/cameraNear
   * 固定不随视锥——消相机移动/缩放时级联矩阵逐帧重排的闪动）；'frustum' = 现实现视锥
   * 拟合（AB 对照基线，bit 级保留含已知缺陷——distance 入壳、视锥 far 参与等）。
   * demo `?cloudsShadowAnchor=frustum`。
   */
  shadowAnchor?: 'world' | 'frustum'
}

/** createCloudsStage 句柄：持 CloudsPass + overlay stage + destroy。 */
export interface CloudsStageHandle {
  /** CloudsPass（primitive + MRT + uniformMap）。 */
  readonly cloudsPass: CloudsPass
  /** cloudsBuffer overlay PostProcessStage（add 到 scene.postProcessStages 末尾）。 */
  readonly overlayStage: PostProcessStage
  /** ShadowPass（BSM 生成端；options.shadowPass=false 时 undefined）。调试/探针采样用。 */
  readonly shadowPass?: ShadowPass
  /** BSM 帧状态（级联矩阵/分段/near/far——preRender 每帧覆写；数值调试只读用）。 */
  readonly shadowState: CloudsShadowFrameState
  /** CascadedShadowMaps 实例（级联 split/frusta/bbox 中间量调试用）。 */
  readonly cascades: CascadedShadowMaps
  /** 释放：摘 preRender listener + CloudsPass.destroy + overlay stage destroy。幂等。 */
  destroy(): void
}

// overlay fragment shader：读 tonemap 输出（display space）+ cloudsBuffer（linear HDR）。
// M2 简化：cloud 先 ACES+gamma 到 display space，再 alpha mix（cloud.a = transmittance → opacity = 1-a）。
// colorTexture 由 Cesium PostProcessStage 内建提供（前一 stage 输出）；u_cloudsBuffer 由 bridge 注入。
// out_FragColor 不声明——Cesium 单输出 stage 自动注入 layout(location=0) out（同 CloudsSpikeMRT OVERLAY_SHADER）。
//
// 颜色链两处标定（2026-08-14 偏灰排查）：
//   1. unpremultiply：cloud.rgb 是 premultiplied（云色×opacity），直接 ACES 会在薄云/边缘处被
//      低值段压暗 ~5 倍（ACES(0.3L) ≠ 0.3·ACES(L)）→ 先 /a 还原 straight 云色再 tonemap。
//   2. exposure：three 版 clouds storybook ToneMapping exposure=10（云线性 radiance 量级 ~0.1，
//      ×10 拉进 ACES 工作区）；不乘则云整体暗 ~10 倍 → 偏灰。u_cloudsExposure uniform 可调。
const OVERLAY_SHADER = `uniform sampler2D colorTexture;
uniform sampler2D u_cloudsBuffer;
uniform float u_cloudsExposure;
in vec2 v_textureCoordinates;

// ACES filmic（对齐 core tonemap.frag ACESFilmic 常数）。
vec3 cloudsOverlay_ACESFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  vec4 cloud = texture(u_cloudsBuffer, v_textureCoordinates);
  // three 版 cloudsEffect.frag 语义（premultiplied over blend）：clouds.a = 云 opacity
  // （无样本 clouds.frag:863 color=vec4(0) → a=0 → 不覆盖，scene 透传）；clouds.rgb premultiplied。
  // M2 overlay 在 tonemap 后：cloud 线性 HDR（premultiplied）→ unpremultiply → ×exposure →
  // ACES + gamma 到 display space → straight-alpha over（ACES 非线性下的近似，flat 阶段可接受）。
  vec3 cloudLinear = cloud.rgb / max(cloud.a, 1e-4);
  vec3 cloudDisplay = pow(cloudsOverlay_ACESFilmic(cloudLinear * u_cloudsExposure), vec3(1.0 / 2.2));
  vec3 final = scene.rgb * (1.0 - cloud.a) + cloud.a * cloudDisplay;
  out_FragColor = vec4(final, scene.a);
}
`

// 云 overlay ACES 曝光：three 版 clouds storybook ToneMapping exposure=10 标定，本项目
// 视觉验收校准为 6（用户 2026-08-14 标定——云暗灰修正后 10 略过曝）。
const CLOUDS_OVERLAY_EXPOSURE_DEFAULT = 6

/**
 * 创建体积云 stage（CloudsPass + overlay）并接入 PostProcess 链。
 *
 * @param scene Cesium scene（cloudsPass.primitive add 到 scene.primitives；overlay add 到 postProcessStages）。
 * @param luts 大气 LUT（与 AtmosphereStage 共享）。
 * @param weather weather 噪声纹理（shape + shapeDetail）。
 * @param options clouds 开关 + CloudsPassOptions 透传。
 * @returns handle；options.clouds=false 时返 undefined（零回归，demo 可无条件调用）。
 */
export function createCloudsStage(
  scene: Scene,
  luts: AtmosphereLUTs,
  weather: WeatherTextures,
  options: CloudsStageOptions = {}
): CloudsStageHandle | undefined {
  // 零回归：clouds:false（或不传）→ 不创建任何 primitive/stage。
  if (options.clouds !== true) return undefined

  const ellipsoid = scene.globe.ellipsoid
  // Cesium 公开 .d.ts 缺 drawingBufferWidth/Height（同 CloudsPass/ShadowPass 局部 augment 模式）
  const context = (scene as unknown as {
    context: Context & { drawingBufferWidth: number; drawingBufferHeight: number }
  }).context

  // ── M4 temporal 开关（默认关——收敛抖动待修，见 CloudsStageOptions 注释；URL 显式开）──
  const temporal = options.temporal === true
  const shadowTemporal = options.shadowTemporal === true

  // ── 业务参数同源（M3 T5 上提）：CloudsPass 与 ShadowPass/共享 uniform 段共用一份 ──
  // （若各自 defaultCloudsParameters() 会得两份独立对象——默认值恰好一致但参数化后漂移；
  // 注入 options.parameters 后 createCloudsPass 内 `options.parameters ?? default` 取到同一份）
  const params: CloudsParameters = options.parameters ?? defaultCloudsParameters()

  // ── 每帧可变状态（createCloudsStage 持有；preRender 更新；CloudsPass uniformMap 闭包读引用）──
  const state: CloudsFrameState = {
    sunDirection: new Cartesian3(0, 0, 1),
    altitudeCorrection: new Cartesian3()
  }
  const sunInertialScratch = new Cartesian3()
  const icrfScratch = new Matrix3()
  const normalScratch = new Cartesian3()
  // world 分支量化太阳 scratch（spec §3.1.8：仅矩阵输入量化，逐帧覆写复用）
  const qSunScratch = new Cartesian3()

  // ── M3 BSM：cascade 矩阵 + shadowState + 生成 pass ──
  const cascadeCount = params.shadowCascadeCount // = shader #define SHADOW_CASCADE_COUNT = CASCADE_COUNT
  const mapSize = 512 // three 默认；BSM 单边尺寸（texelSize 同源）
  // BSM 有效距离上限（2026-08-28 远端深色斑）：最远 cascade texel ≈ 2·(far段宽)/512；
  // far=2e5 时 texel ~1km → frontDepth 精度崩 → 远端云过暗斑块。60km 时最远 texel ~200m。
  const SHADOW_FAR_LIMIT = 6e4
  // BSM 锚定模式（T4，spec v3）：缺省 world；frustum = AB 对照基线（bit 级现行为）。
  // 构造期一次定死（cascades 分支选择）——运行期不切换。
  const worldAnchor = (options.shadowAnchor ?? 'world') === 'world'
  // world 分支：anchor 之外全走类内缺省设计值（worldRadii {16,33.6,96}km、worldIntervals
  // {0,10,21,60}km——Global Constraints：设计值单源于类缺省，编排不重复传）
  const cascades = new CascadedShadowMaps({
    cascadeCount,
    mapSize,
    ...(worldAnchor ? { anchor: 'world' as const } : {})
  })

  // shadowState 数组用新分配实例（勿复用 params.shadowMatrices/shadowIntervals 默认数组：
  // 默认 shadowMatrices 元素是 Object.freeze 的全局 Matrix4.IDENTITY——Matrix4.clone 逐项
  // 覆写会抛 TypeError（ESM 严格模式写冻结对象），且即使可写也会污染全局 identity 常量）。
  // CloudsPass uniformMap 闭包读 state.shadow 引用，preRender 逐帧覆写即可。
  const shadowMatrices = [new Matrix4(), new Matrix4(), new Matrix4()]
  const shadowIntervals = [new Cartesian2(), new Cartesian2(), new Cartesian2()]
  const shadowState: CloudsShadowFrameState = {
    matrices: shadowMatrices,
    intervals: shadowIntervals,
    cameraNear: 0,
    far: 0, // preRender 首帧填（min(frustum.far, maxRayDistance)）
    texelSize: new Cartesian2(1 / mapSize, 1 / mapSize),
    bsm: undefined
  }

  // ── CloudsPass（custom Primitive pass=VOXELS + MRT + 全 business uniform）──
  // M4 T6：temporal 时 temporalUpscale=true（march 1/4 分 + velocity 写 att1）
  const cloudsPass = createCloudsPass(scene, luts, weather, state, {
    ...options,
    parameters: params,
    temporalUpscale: temporal
  })

  // ── ShadowPass 生成端（options.shadowPass=false 跳过——诊断基线 Beer=1）──
  const enableShadow = options.shadowPass !== false
  // 生成端 turbulence dummy（与 CloudsPass 同款 1×1 中性灰 (128,128,128)——sampleMedia
  // TURBULENCE 分支采样；两端各自持有便于独立 destroy）
  const shadowTurbulenceDummy = enableShadow
    ? new Texture({
        context,
        source: {
          width: 1,
          height: 1,
          arrayBufferView: new Uint8Array([128, 128, 128, 255])
        },
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: PixelDatatype.UNSIGNED_BYTE
      })
    : undefined

  // BSM 专属 inverseShadowMatrices[CASCADE_COUNT]（shadow.frag cascade() z=-1 反投影太阳侧
  // 起点）：preRender 逐帧覆写的 mutable 数组，uniform 闭包持引用。
  const inverseMatrices = shadowMatrices.map(() => new Matrix4())

  // shadow uniformMap = 共享段（与主 march 同源闭包）+ BSM 专属（反投影矩阵 + shadowMarch 档
  // 平铺——Cesium uniformMap 不支持 struct；同名 maxIterationCount 等与主 march 档不同值，
  // 故 march 档不进共享段、各端自绑）。u_cascadeIndex 由 ShadowPass 内部注入（勿重复绑）。
  // D7 frame 拆分：BSM 生成端的 stbn jitter 相位只在 shadowTemporal 开时递增（关 = M3 恒 0）。
  const shadowUniformMap: { [name: string]: () => unknown } = {
    ...buildSharedCloudsUniforms(scene, luts, weather, state, params, shadowTurbulenceDummy!),
    frame: () => (shadowTemporal ? params.frame : 0),
    inverseShadowMatrices: () => inverseMatrices,
    // shadowMarch 档（qualityPresets.ts defaults.shadow：50/100/1000/1e-5/1e-5/1e-4/2）
    maxIterationCount: () => params.shadowMarch.maxIterationCount,
    minStepSize: () => params.shadowMarch.minStepSize,
    maxStepSize: () => params.shadowMarch.maxStepSize,
    minDensity: () => params.shadowMarch.minDensity,
    minExtinction: () => params.shadowMarch.minExtinction,
    minTransmittance: () => params.shadowMarch.minTransmittance,
    opticalDepthTailScale: () => params.shadowMarch.opticalDepthTailScale
  }

  const shadowPass: ShadowPass | undefined = enableShadow
    ? createShadowPass({
        context,
        cascadeCount,
        mapSize,
        // RGBA16F 作 FBO color attachment 需 colorBufferHalfFloat——resolveCloudsHdrDatatype
        // 检测恰好覆盖（HALF_FLOAT→FLOAT→UNSIGNED_BYTE 兜底）；FBO 不完整时 render 内部
        // warn+跳过（消费端保全 0 Beer=1 降级，不炸）
        pixelDatatype: resolveCloudsHdrDatatype(scene),
        uniformMap: shadowUniformMap,
        // 编译分支与主 march 同步（BSM 与主 march 的云密度必须同分布——shapeDetail/turbulence
        // 单端关闭会造成阴影与云形错位）。?? true 必须：本字面量无条件建键，若透传 undefined，
        // ShadowMaterial 的 {...DEFAULTS, ...options} 会被「显式 undefined 键」覆盖默认 true
        // （spread 按键存在性覆盖）→ 生成端不 define 而主 march define（M3 终审修复）
        shaderOptions: {
          shapeDetail: options.shapeDetail ?? true,
          turbulence: options.turbulence ?? true
        },
        // M4：BSM temporal（velocity 层 + resolve ping-pong + prevMatrices 编排）
        temporalPass: shadowTemporal
      })
    : undefined

  if (enableShadow) {
    state.shadow = shadowState
    // 创建即全 0（ShadowPass allocZeroedTexels）→ 首帧 render 前采样 Beer=1，与 dummy
    // 同降级语义（T4 concern：可直接赋值，不必等首次 render）
    shadowState.bsm = shadowPass?.bsmTexture
  }

  // ── M4 云 resolve Pass（temporal 时；primitive add 在 march 之后——D1 执行顺序契约：
  //    同 pass=VOXELS 内 PrimitiveCollection 数组序 → update 顺序 → commandList 序）──
  const resolvePass: CloudsResolvePass | undefined = temporal
    ? createCloudsResolvePass({
        context,
        width: context.drawingBufferWidth,
        height: context.drawingBufferHeight,
        pixelDatatype: resolveCloudsHdrDatatype(scene),
        colorBuffer: cloudsPass.colorTexture,
        depthVelocityBuffer: cloudsPass.depthVelocityTexture,
        frame: () => params.frame,
        varianceGamma: params.temporalVarianceGamma,
        temporalAlpha: params.temporalAlpha
      })
    : undefined
  if (resolvePass != null) {
    ;(scene.primitives as unknown as { add: (p: unknown) => void }).add(resolvePass.primitive)
  }

  // ── overlay PostProcessStage（cloudsBuffer bridge + tonemap 输出 mix）──
  // sampleMode NEAREST：保护云边缘锐利（cloudsBuffer 是 raymarch 像素对齐数据纹理，LINEAR 会糊边缘）。
  // pixelDatatype UNSIGNED_BYTE：overlay 输出 display ready（已 ACES+gamma），下游无 HDR 需求。
  const overlayStage = new PostProcessStage({
    name: 'clouds_overlay',
    fragmentShader: OVERLAY_SHADER,
    uniforms: {
      // bridge 每帧重新取（防 resize 后 colorTex 引用变更；M2 不处理 resize 但接口留动态）。
      // M4：temporal 时读 resolve 输出（全分重建后的 cloudsBuffer）；否则 march att0 直读
      //（swap 后的 resolveRef 即本帧输出——overlay 在 PostProcess 阶段取值）。
      u_cloudsBuffer: () =>
        resolvePass != null ? resolvePass.getResolvedBridge() : cloudsPass.getColorBridge(),
      // 云曝光（three 版 ToneMapping exposure=10 标定；URL ?cloudsExposure=N 可调）
      u_cloudsExposure: options.cloudsOverlayExposure ?? CLOUDS_OVERLAY_EXPOSURE_DEFAULT
    },
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE
  })
  scene.postProcessStages.add(overlayStage)

  // ── preRender：每帧更新 sunDirection（Simon1994 + ICRF→Fixed）+ altitudeCorrection（密切球）──
  // 仿 AtmosphereStage.ts:568-604。state 更新后 CloudsPass uniformMap 闭包自动反映（同引用）。
  // M4 temporal 状态：上帧相机快照（velocity reprojection 用；首帧 undefined → fallback 当前
  // 矩阵，velocity=0——three previousProjectionMatrix ?? camera.projectionMatrix 同款）。
  let prevCamera: TemporalCameraSnapshot | undefined
  // 诊断冻结状态（?cloudsShadowFreeze=1）：首帧 update 过后置 true
  let matricesFrozen = false
  const removePreRender = scene.preRender.addEventListener(
    (_scene: Scene, time: JulianDate) => {
      const camera = scene.camera

      // ── M4 temporal：swap 最前（D2：swap 后 history=上帧输出、resolve=待写）+ frame 递增
      //    （D7：单端全关时不递增；march/BSM 生成端的 frame uniform 已按各端开关拆分绑定）──
      resolvePass?.swapBuffers()
      if (temporal || shadowTemporal) {
        params.frame++
      }

      // 密切球再中心化（相机侧；shader 内 camera/scenePos 都用全量 altitudeCorrection）。
      // bottomRadius = ATMOSPHERE_BOTTOM_RADIUS_M（云层 minHeight=750m ≪ atmosphere bottom，密切球 recenter
      // 在 atmosphere bottom 足够覆盖云层范围）。
      getAltitudeCorrectionOffset(
        camera.positionWC,
        ATMOSPHERE_BOTTOM_RADIUS_M,
        ellipsoid,
        state.altitudeCorrection
      )

      // 太阳方向：inertial 系位置 → central-body-fixed → ECEF，单位化。
      // 【ICRF 竞态修复 2026-08-16】与 AtmosphereStage 同款切换
      // computeIcrfToFixedMatrix → computeIcrfToCentralBodyFixedMatrix（XYS 懒加载竞态 +
      // 网络依赖 → GMST fallback 恒有值；详见 AtmosphereStage.ts 同位注释）。
      const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        time,
        sunInertialScratch
      )
      const icrfToFixed = Transforms.computeIcrfToCentralBodyFixedMatrix(time, icrfScratch)
      if (icrfToFixed != null && sunInertial != null) {
        const sunFixed = Matrix3.multiplyByVector(icrfToFixed, sunInertial, sunInertial)
        const sunMag = Cartesian3.magnitude(sunFixed)
        if (Number.isFinite(sunMag) && sunMag > 1e-15) {
          Cartesian3.normalize(sunFixed, state.sunDirection)
        }
      }

      // ── M4 temporal：Bayer jitter + reprojection 矩阵（march ray 重建偏移 + velocity 两分支消费）──
      // 矩阵域 ECEF（worldToECEF=identity）；preRender 时刻 frustum.projectionMatrix 为完整视锥
      //（multi-frustum 分段前，velocity 数学只用投影 xy 系数与 w → 分段无关，plan D5）。
      // 写入 params 的既有 Matrix4 实例（clone 覆写不换引用——uniformMap 闭包持引用）。
      if (temporal) {
        computeTemporalJitter(
          params.frame,
          cloudsPass.marchWidth,
          cloudsPass.marchHeight,
          params.temporalJitter
        )
        const viewMatrix = camera.viewMatrix
        const projectionMatrix = (camera.frustum as unknown as { projectionMatrix: Matrix4 })
          .projectionMatrix
        buildReprojectionMatrices(prevCamera, viewMatrix, projectionMatrix, camera.inverseViewMatrix, params.temporalJitter, {
          reprojectionMatrix: params.reprojectionMatrix,
          viewReprojectionMatrix: params.viewReprojectionMatrix
        })
        // 帧末存本帧快照（clone——Cesium camera 矩阵是 live 引用，必须拷贝）
        prevCamera = {
          viewMatrix: Matrix4.clone(viewMatrix, new Matrix4()),
          projectionMatrix: Matrix4.clone(projectionMatrix, new Matrix4())
        }
      }

      // ── M3 BSM：级联矩阵更新 + 生成（sunDirection 更新后，本帧矩阵与光照一致）──
      // preRender 时刻 camera.frustum.near/far 是完整视锥值（multi-frustum 分段前）——
      // cascade 归一化域与 u_shadowCameraNear 同帧同源（T4 concern #1）。
      if (shadowPass != null) {
        // T4 world 分支（spec v3 §3.1）：矩阵输入太阳量化（0.05° 网格——跑钟时矩阵只在
        // 格点跳变，静止相机+慢太阳下矩阵稳定）；march 与消费端 state.sunDirection 保持
        // 精确（§3.1.8）。frustum 分支原引用直传（bit 级现行为）。
        const sunForMatrices = worldAnchor
          ? quantizeSunDirection(state.sunDirection, SUN_QUANT_STEP, qSunScratch)
          : state.sunDirection
        // 虚拟光源距离（仅 frustum 分支：three CloudsEffect.ts:387 语义 lerp(1e6, 1e3, zenith)）。
        // distance 大（晨昏 zenith=0 → 1e6 上限）是安全的：BSM 两端均不消费 clip.z——生成端
        // cascade() 的 march 起点经 getRayNearFar 与云层球壳解析求交（inverseShadowMatrices
        // 的 z=-1 反投影只取 xy），消费端 getShadowUv 只取 clip.xy（正交投影 xy 与 z 解耦）。
        // CascadedShadowMaps 的「distance 过大会超出 ortho 盒深、勿传大值」警告（T1）仅针对
        // 未来引入 clip.z 剔除/依赖的场景，当前管线不受约束。world 分支不传（z 盒解析式定
        // near/far，不消费 distance——spec §3.2）。
        let distance: number | undefined
        if (!worldAnchor) {
          const normal = ellipsoid.geodeticSurfaceNormal(camera.positionWC, normalScratch)
          const zenith = Math.max(0, Cartesian3.dot(state.sunDirection, normal))
          distance = 1e6 + (1e3 - 1e6) * zenith
        }
        // BSM far/near（spec §3.1.5）——world 固定：far = min(maxRayDistance, SHADOW_FAR_LIMIT)
        // 常数（去掉 camera.frustum.far 参与，multi-frustum 缩放时不再变；与 worldIntervals
        // 常数域 [0,60km] 归一化同域）、cameraNear 固定 0（u_shadowCameraNear 源头注入 0）。
        // frustum 分支 bit 级现行为：完整视锥 far 与 maxRayDistance 取小（决策 D6——云 march
        // 不超 maxRayDistance）；2026-08-28 远端深色斑修复再与 SHADOW_FAR_LIMIT 取小——
        // maxRayDistance=200km 时最远 cascade 的 texel 达 ~1km，frontDepth 精度崩 → 远端云
        // 自阴影过暗斑块（屏幕锚定、随相机前进）。收缩到 60km 后三层 split 重排（最远 texel
        // ~200m），远端云走 uv 越界 fallback（光深 0=无自阴影）——低太阳角远端云的自阴影
        // 视觉贡献本就弱。
        const far = worldAnchor
          ? Math.min(params.maxRayDistance, SHADOW_FAR_LIMIT)
          : Math.min(camera.frustum.far, params.maxRayDistance, SHADOW_FAR_LIMIT)
        const near = worldAnchor ? 0 : camera.frustum.near
        // ── 静止跳过（T5，spec §3.2）与诊断冻结（?cloudsShadowFreeze=1）正交组合 ──
        // - freeze 激活（开且首帧已过）：update/矩阵覆写整段跳过（T4 行为），render 照常
        //   每帧——freeze 语义是「冻结矩阵重 march」（噪声分解实验：冻结网格上逐帧差 =
        //   非矩阵噪声地板），跳 render 会破坏该语义。
        // - 非 freeze：update 照跑，返回 changed（world = 语义键比较；frustum 恒 true）。
        //   changed=false（矩阵静止帧）→ 矩阵覆写 + setCurrentMatrices + render 全跳——
        //   BSM 纹理内容只依赖矩阵/云场/量化太阳格点，静止帧重 march 必产出相同内容，
        //   跳过即白赚（m7 不变量：跳过帧 shadowMatrices、ShadowPass 内 current/prev
        //   matrices 与 temporal history 三者冻结不变——render 内部的 prev←本帧登记也
        //   不发生，静止期结束后首帧 velocity 用冻结 prev，矩阵连续 → 无假速度）。
        // - shadowTemporal 开时不跳 render：BSM resolve 时序累积依赖逐帧 jitter 相位
        //   （frame 递增）——「重 march 相同内容」前提被 jitter 破坏，跳帧=累积停更。
        const freezeActive = options.shadowFreeze === true && matricesFrozen
        let changed = false
        if (!freezeActive) {
          changed = cascades.update(
            {
              inverseViewMatrix: camera.inverseViewMatrix,
              projectionMatrix: (camera.frustum as unknown as { projectionMatrix: Matrix4 })
                .projectionMatrix,
              near,
              far
            },
            sunForMatrices,
            distance
          )
          if (changed) {
            for (let i = 0; i < cascadeCount; i++) {
              Matrix4.clone(cascades.cascades[i].matrix, shadowMatrices[i])
              Matrix4.clone(cascades.cascades[i].inverseMatrix, inverseMatrices[i])
              shadowIntervals[i].x = cascades.cascades[i].interval.x
              shadowIntervals[i].y = cascades.cascades[i].interval.y
            }
            // M4：本帧矩阵先登记（render 内部 velocity 用 prevMatrices=上帧、末尾 prev ← 本帧）
            shadowPass.setCurrentMatrices(shadowMatrices)
            shadowState.cameraNear = near
            shadowState.far = far
            shadowState.bsm = shadowPass.bsmTexture
          }
          matricesFrozen = true
        }
        if (freezeActive || changed || shadowTemporal) {
          shadowPass.render()
        }
      }
    }
  )

  let destroyed = false
  return {
    cloudsPass,
    overlayStage,
    // ShadowPass 引用（调试/探针采样 BSM 用；shadowPass=false 时 undefined）
    shadowPass,
    // BSM 帧状态（matrices/intervals/cameraNear/far——级联投影数值调试用）
    shadowState,
    // CascadedShadowMaps 实例（frusta/bbox 中间量调试用）
    cascades,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      removePreRender()
      // 顺序：先 CloudsPass（消费端，撤 bsm 引用）→ 云 resolve（march 后第二个 VOXELS 实例）→
      // ShadowPass（释放 bsmTexture——T3 concern #4），最后生成端 turbulence dummy
      cloudsPass.destroy()
      resolvePass?.destroy()
      shadowPass?.destroy()
      shadowTurbulenceDummy?.destroy()
      // overlay：PostProcessStageCollection.remove 成功则内部已 destroy，失败则手动 destroy
      if (!scene.postProcessStages.remove(overlayStage)) {
        overlayStage.destroy()
      }
    }
  }
}
