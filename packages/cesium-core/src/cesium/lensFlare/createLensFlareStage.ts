// phase2b LensFlare 接线层（spec §3 拓扑 + §5.9 集成）。
//
// 职责：把 T1-T9 的 7 个 shader 构建器组装成 Cesium PostProcessStage 树，供 AtmosphereStage
// （或上层）加入 scene.postProcessStages。返回 handle 持所有 stage/composite 引用，便于运行时
// 控制与销毁。
//
// 拓扑（spec §3）：
//   外层 non-series `lensflare` composite（inputPreviousStageTexture=false）
//   ├─ lf_bloom：series composite（inputPreviousStageTexture=true）
//   │   ├─ lf_threshold（get0，读 atmosphere）→ lf_down0 → ... → lf_down4 → lf_up0 → ... → lf_up4
//   │   └─ up[i].u_downLevel = uniform-name string 引用 down[对应级]（I9 强制约束，避同 scale 共享）
//   ├─ lf_preBlur（u_thresholdTexture = uniform-name string 引用 lf_threshold）
//   ├─ lf_occlusion（textureScale 0.0625 标量降分）
//   ├─ lf_features（u_preBlurTexture/u_occlusionTexture = uniform-name string 引用）
//   └─ lf_composite（u_bloomTexture/u_featuresTexture = uniform-name string 引用）
//
// 三条最高风险评审项（接线层强制）：
//   C2  — lf_bloom.stages[0] = lf_threshold（非 down0）：down0 series 前驱是 threshold，确保
//          bloom 链读阈值化结果而非原 atmosphere。
//   I9  — up[i].uniforms.u_downLevel = string 字面量（非 function）：同 textureScale 的 down/up
//          共享 framebuffer，只有 uniform-name 引用才让 Cesium 依赖图把 down[对应] 排在 up[i] 前；
//          function 返回 texture 对象不建依赖 → up 渲染冲刷 down 输出（白屏）。
//          映射：up0→down3, up1→down2, up2→down1, up3→down0, up4→threshold（同 scale 对齐）。
//   I10 — features/composite 的 uniform-name texture 引用全 string 字面量：non-series 兄弟 stage
//          不在 series 链中，只有 uniform-name 显式引用才构建跨 stage 依赖。
//
// u_texelSize：每帧按各 stage RT 实际尺寸（1/width, 1/height）更新。T11 阶段先用占位闭包返回固定
// Cartesian2（注释标 TODO），test 不验证其值；运行时接 RT 尺寸待 T12 / AtmosphereStage 每帧更新。

import {
  PostProcessStage,
  PostProcessStageComposite,
  PostProcessStageSampleMode,
  PixelDatatype,
  PixelFormat,
  Cartesian2,
  type Scene
} from 'cesium'
import { buildThresholdFragmentShader } from './threshold.frag'
import { buildBloomDownsampleFragmentShader } from './bloomDownsample.frag'
import { buildBloomUpsampleFragmentShader } from './bloomUpsample.frag'
import { buildPreBlurFragmentShader } from './preBlur.frag'
import { buildFeaturesFragmentShader } from './features.frag'
import { buildOcclusionFragmentShader } from './occlusion.frag'
import { buildCompositeFragmentShader } from './composite.frag'
import { resolvePostHdrDatatype, type AtmosphereFrameState } from '../AtmosphereStage'
import { SUN_ANGULAR_RADIUS } from '../../math/atmosphereParameters'
import {
  UPSAMPLE_RADIUS,
  THRESHOLD_LEVEL_DEFAULT,
  THRESHOLD_RANGE_DEFAULT,
  INTENSITY_DEFAULT,
  GHOST_AMOUNT_DEFAULT,
  HALO_AMOUNT_DEFAULT,
  CHROMATIC_ABERRATION,
  OCCLUSION_TEXTURE_SCALE
} from './lensFlareConstants'

/** LensFlare 可调参数（全部可选，缺省取 lensFlareConstants 默认）。 */
export interface LensFlareOptions {
  /** 总强度（线性域乘 bloom+features，spec §5.6）。 */
  intensity?: number
  /** 阈值电平（threshold soft knee 中心，spec §5.1）。 */
  thresholdLevel?: number
  /** 阈值过渡带宽（spec §5.1）。 */
  thresholdRange?: number
  /** ghost 总强度（spec §5.4）。 */
  ghostAmount?: number
  /** halo 总强度（spec §5.4）。 */
  haloAmount?: number
  /** halo 色散偏移强度（texel 倍数，spec §5.4）。 */
  chromaticAberration?: number
}

/** LensFlare stage 树句柄：持所有 stage/composite 引用，便于运行时控制与销毁。 */
export interface LensFlareStageHandle {
  /** 外层 non-series composite（加入 scene.postProcessStages 的根）。 */
  readonly lensflareComposite: PostProcessStageComposite
  /** lf_bloom series composite（threshold + down0-4 + up0-4）。 */
  readonly bloomComposite: PostProcessStageComposite
  /** lf_preBlur（ghost/halo 软化核）。 */
  readonly preBlurStage: PostProcessStage
  /** lf_occlusion（sun 投影 + 椭球遮挡，textureScale 0.0625）。 */
  readonly occlusionStage: PostProcessStage
  /** lf_features（9 ghosts + halo + 色散）。 */
  readonly featuresStage: PostProcessStage
  /** lf_composite（线性域加法叠加 atmosphere + (bloom+features)*intensity）。 */
  readonly compositeStage: PostProcessStage
}

// bloom 级数（spec §3）：threshold(get0) + down0-4（5 级，textureScale 0.5→1/32）+ up0-4（5 级）。
const DOWNSAMPLE_SCALES = [0.5, 0.25, 0.125, 0.0625, 0.03125] // down0-4
const UPSAMPLE_SCALES = [0.0625, 0.125, 0.25, 0.5, 1.0] // up0-4
// I9 映射（spec §3 表）：up[i] 的 support（u_downLevel）= 同 scale 的 down 级。
// up0(scale 0.0625)→down3(0.0625), up1→down2, up2→down1, up3→down0, up4(scale 1.0)→threshold(1.0)。
const UP_DOWN_LEVEL_NAMES = ['lf_down3', 'lf_down2', 'lf_down1', 'lf_down0', 'lf_threshold']

/**
 * u_texelSize 占位闭包（TODO：运行时接各 stage RT 实际尺寸每帧更新，待 T12）。
 *
 * 每个阶段的 RT 尺寸 = viewport × textureScale，故 texel size 随 scale 变化；此处返回固定占位
 * 让 stage 构造期 uniform 形状完整（string/number/function 三类 uniform 都要存在以匹配 shader 声明）。
 * 占位值不影响 T11 结构断言；实际渲染前由 AtmosphereStage 或每帧 hook 替换为真实 1/w,1/h。
 */
function placeholderTexelSize(): Cartesian2 {
  // TODO(T12): 接各 stage RT 实际尺寸（viewport × textureScale）每帧更新。
  return new Cartesian2(1.0 / 1920, 1.0 / 1080)
}

/**
 * 组装 LensFlare PostProcessStage 树（spec §3 拓扑 + §5.9 集成）。
 *
 * 不加入 scene.postProcessStages（由 AtmosphereStage / 上层决定何时 add，便于排序与销毁）。
 * uniforms：uniform-name texture 引用用 string 字面量（I9/I10）；每帧动态量（sunDirection/
 * cameraPosition/ellipsoidRadii/exposure）用 function 闭包读 state/scene。
 */
export function createLensFlareStage(
  scene: Scene,
  state: AtmosphereFrameState,
  options: LensFlareOptions = {}
): LensFlareStageHandle {
  const postHdrDatatype = resolvePostHdrDatatype(scene)
  const intensity = options.intensity ?? INTENSITY_DEFAULT
  const thresholdLevel = options.thresholdLevel ?? THRESHOLD_LEVEL_DEFAULT
  const thresholdRange = options.thresholdRange ?? THRESHOLD_RANGE_DEFAULT
  const ghostAmount = options.ghostAmount ?? GHOST_AMOUNT_DEFAULT
  const haloAmount = options.haloAmount ?? HALO_AMOUNT_DEFAULT
  const chromaticAberration = options.chromaticAberration ?? CHROMATIC_ABERRATION

  // ellipsoid.radiiSquared：occlusion ray-ellipsoid 椭球遮挡用。
  // create 时捕获一次——Ellipsoid 在 app 生命周期内固定，radiiSquared Cartesian3 不变。
  const ellipsoidRadiiSquared = scene.globe.ellipsoid.radiiSquared

  // ── lf_bloom series composite ──────────────────────────────────────────────
  // C2：get0 = lf_threshold（非 down0）。down0 的 series 前驱是 threshold，读阈值化结果。
  const threshold = new PostProcessStage({
    name: 'lf_threshold',
    fragmentShader: buildThresholdFragmentShader(),
    uniforms: {
      u_texelSize: placeholderTexelSize,
      u_thresholdLevel: thresholdLevel,
      u_thresholdRange: thresholdRange
    },
    textureScale: 1.0,
    sampleMode: PostProcessStageSampleMode.NEAREST, // 读 atmosphere，NEAREST 保 input dithering
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  const downs = DOWNSAMPLE_SCALES.map(
    (scale, i) =>
      new PostProcessStage({
        name: `lf_down${i}`,
        fragmentShader: buildBloomDownsampleFragmentShader(),
        uniforms: { u_texelSize: placeholderTexelSize },
        textureScale: scale,
        // §5.7：series 链传播用 LINEAR（双线性插值，下采样/上采样标准做法）。
        sampleMode: PostProcessStageSampleMode.LINEAR,
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: postHdrDatatype
      })
  )

  // I9：u_downLevel = uniform-name string 字面量（非 function），强制 Cesium 依赖图把 down[对应]
  // 排在 up[i] 前，避同 scale framebuffer 共享导致 up 渲染冲刷 down 输出。
  const ups = UPSAMPLE_SCALES.map(
    (scale, i) =>
      new PostProcessStage({
        name: `lf_up${i}`,
        fragmentShader: buildBloomUpsampleFragmentShader(),
        uniforms: {
          u_downLevel: UP_DOWN_LEVEL_NAMES[i], // string 字面量（I9）
          u_upsampleRadius: UPSAMPLE_RADIUS,
          u_texelSize: placeholderTexelSize
        },
        textureScale: scale,
        sampleMode: PostProcessStageSampleMode.LINEAR, // §5.7：series 链传播
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: postHdrDatatype
      })
  )

  const bloomComposite = new PostProcessStageComposite({
    name: 'lf_bloom',
    stages: [threshold, ...downs, ...ups],
    inputPreviousStageTexture: true // series：每 stage 读前驱输出
  })

  // ── non-series 兄弟 stage ──────────────────────────────────────────────────
  // I10：u_thresholdTexture = uniform-name string 引用 lf_threshold（强制依赖，保证 threshold 先渲染）。
  const preBlur = new PostProcessStage({
    name: 'lf_preBlur',
    fragmentShader: buildPreBlurFragmentShader(),
    uniforms: {
      u_thresholdTexture: 'lf_threshold', // string 字面量（I10）
      u_texelSize: placeholderTexelSize
    },
    textureScale: 1.0,
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  // occlusion：标量降分（textureScale 0.0625）——36 点 depth 采样网格成本低，输出低分够用。
  const occlusion = new PostProcessStage({
    name: 'lf_occlusion',
    fragmentShader: buildOcclusionFragmentShader(),
    uniforms: {
      u_sunDirectionWC: () => state.sunDirection,
      u_cameraPositionWC: () => scene.camera.positionWC,
      u_sunAngularRadius: SUN_ANGULAR_RADIUS,
      u_ellipsoidRadiiSquared: () => ellipsoidRadiiSquared
    },
    textureScale: OCCLUSION_TEXTURE_SCALE,
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  // I10：u_preBlurTexture/u_occlusionTexture = uniform-name string 引用（强制依赖）。
  const features = new PostProcessStage({
    name: 'lf_features',
    fragmentShader: buildFeaturesFragmentShader(),
    uniforms: {
      u_preBlurTexture: 'lf_preBlur', // string 字面量（I10）
      u_occlusionTexture: 'lf_occlusion', // string 字面量（I10）
      u_texelSize: placeholderTexelSize,
      u_ghostAmount: ghostAmount,
      u_haloAmount: haloAmount,
      u_chromaticAberration: chromaticAberration
    },
    textureScale: 1.0,
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  // I10：u_bloomTexture/u_featuresTexture = uniform-name string 引用（强制依赖）。
  // lf_up4 = lf_bloom series composite 最后一级（全分 bloom 输出）。
  const composite = new PostProcessStage({
    name: 'lf_composite',
    fragmentShader: buildCompositeFragmentShader(),
    uniforms: {
      u_bloomTexture: 'lf_up4', // string 字面量（I10）：lf_bloom 最后一级
      u_featuresTexture: 'lf_features', // string 字面量（I10）
      u_intensity: intensity
    },
    textureScale: 1.0,
    // §5.7：composite 采样 atmosphere 的 input dithering，NEAREST 保噪声经 RT 中转逐像素直通。
    // LINEAR 会插值抹掉 dither → 水波纹回归。
    sampleMode: PostProcessStageSampleMode.NEAREST,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })

  // ── 外层 non-series composite ──────────────────────────────────────────────
  // inputPreviousStageTexture=false：各兄弟 stage 的 colorTexture = composite 输入（atmosphere），
  // 而非 series 前驱；跨 stage 依赖靠 uniform-name string 引用（I10）显式声明。
  const lensflareComposite = new PostProcessStageComposite({
    name: 'lensflare',
    stages: [bloomComposite, preBlur, occlusion, features, composite],
    inputPreviousStageTexture: false // non-series
  })

  return {
    lensflareComposite,
    bloomComposite,
    preBlurStage: preBlur,
    occlusionStage: occlusion,
    featuresStage: features,
    compositeStage: composite
  }
}
