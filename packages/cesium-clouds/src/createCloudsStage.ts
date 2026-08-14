// createCloudsStage.ts
//
// M2 T3：顶层工厂——编排 CloudsPass + cloudsBuffer bridge → 接 createAtmosphereStage PostProcess 链
// （cloudsBuffer overlay 在 atmosphere 之后，spec §4.3）。czm 桥接（spec §4.2）：
//   - sunDirection：Simon1994 + ICRF→Fixed → ECEF（preRender 每帧更新，仿 AtmosphereStage）
//   - altitudeCorrection：getAltitudeCorrectionOffset（密切球再中心化，R2 防大坐标单精度失效）
//   - reprojectionMatrix/viewReprojectionMatrix/temporalJitter：M2 dummy identity/0（M4 temporal 接通）
//   - shadowMatrices/shadowIntervals：M2 dummy（M3 BSM 接通）
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
  Cartesian3,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  JulianDate,
  PixelFormat,
  PixelDatatype,
  type Scene
} from 'cesium'
import {
  getAltitudeCorrectionOffset,
  ATMOSPHERE_BOTTOM_RADIUS_M,
  type AtmosphereLUTs
} from '@cesium-geospatial/core'
import {
  createCloudsPass,
  type CloudsPass,
  type CloudsFrameState,
  type CloudsPassOptions
} from './CloudsPass'
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
}

/** createCloudsStage 句柄：持 CloudsPass + overlay stage + destroy。 */
export interface CloudsStageHandle {
  /** CloudsPass（primitive + MRT + uniformMap）。 */
  readonly cloudsPass: CloudsPass
  /** cloudsBuffer overlay PostProcessStage（add 到 scene.postProcessStages 末尾）。 */
  readonly overlayStage: PostProcessStage
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

  // ── 每帧可变状态（createCloudsStage 持有；preRender 更新；CloudsPass uniformMap 闭包读引用）──
  const state: CloudsFrameState = {
    sunDirection: new Cartesian3(0, 0, 1),
    altitudeCorrection: new Cartesian3()
  }
  const sunInertialScratch = new Cartesian3()
  const icrfScratch = new Matrix3()

  // ── CloudsPass（custom Primitive pass=VOXELS + MRT + 全 business uniform）──
  const cloudsPass = createCloudsPass(scene, luts, weather, state, options)

  // ── overlay PostProcessStage（cloudsBuffer bridge + tonemap 输出 mix）──
  // sampleMode NEAREST：保护云边缘锐利（cloudsBuffer 是 raymarch 像素对齐数据纹理，LINEAR 会糊边缘）。
  // pixelDatatype UNSIGNED_BYTE：overlay 输出 display ready（已 ACES+gamma），下游无 HDR 需求。
  const overlayStage = new PostProcessStage({
    name: 'clouds_overlay',
    fragmentShader: OVERLAY_SHADER,
    uniforms: {
      // bridge 每帧重新取（防 resize 后 colorTex 引用变更；M2 不处理 resize 但接口留动态）。
      u_cloudsBuffer: () => cloudsPass.getColorBridge(),
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
  const removePreRender = scene.preRender.addEventListener(
    (_scene: Scene, time: JulianDate) => {
      const camera = scene.camera

      // 密切球再中心化（相机侧；shader 内 camera/scenePos 都用全量 altitudeCorrection）。
      // bottomRadius = ATMOSPHERE_BOTTOM_RADIUS_M（云层 minHeight=750m ≪ atmosphere bottom，密切球 recenter
      // 在 atmosphere bottom 足够覆盖云层范围）。
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
    }
  )

  let destroyed = false
  return {
    cloudsPass,
    overlayStage,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      removePreRender()
      cloudsPass.destroy()
      // overlay：PostProcessStageCollection.remove 成功则内部已 destroy，失败则手动 destroy
      if (!scene.postProcessStages.remove(overlayStage)) {
        overlayStage.destroy()
      }
    }
  }
}
