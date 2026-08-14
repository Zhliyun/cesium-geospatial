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
import { CascadedShadowMaps } from './CascadedShadowMaps'
import { createShadowPass, type ShadowPass } from './ShadowPass'
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
  const context = (scene as unknown as { context: Context }).context

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

  // ── M3 BSM：cascade 矩阵 + shadowState + 生成 pass ──
  const cascadeCount = params.shadowCascadeCount // = shader #define SHADOW_CASCADE_COUNT = CASCADE_COUNT
  const mapSize = 512 // three 默认；BSM 单边尺寸（texelSize 同源）
  const cascades = new CascadedShadowMaps({ cascadeCount, mapSize })

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
  const cloudsPass = createCloudsPass(scene, luts, weather, state, {
    ...options,
    parameters: params
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
  const shadowUniformMap: { [name: string]: () => unknown } = {
    ...buildSharedCloudsUniforms(scene, luts, weather, state, params, shadowTurbulenceDummy!),
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
        }
      })
    : undefined

  if (enableShadow) {
    state.shadow = shadowState
    // 创建即全 0（ShadowPass allocZeroedTexels）→ 首帧 render 前采样 Beer=1，与 dummy
    // 同降级语义（T4 concern：可直接赋值，不必等首次 render）
    shadowState.bsm = shadowPass?.bsmTexture
  }

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

      // ── M3 BSM：级联矩阵更新 + 生成（sunDirection 更新后，本帧矩阵与光照一致）──
      // preRender 时刻 camera.frustum.near/far 是完整视锥值（multi-frustum 分段前）——
      // cascade 归一化域与 u_shadowCameraNear 同帧同源（T4 concern #1）。
      if (shadowPass != null) {
        // 虚拟光源距离：太阳天顶角越高（正午）越近（three CloudsEffect.ts:387 语义
        // lerp(1e6, 1e3, zenith)）。distance 大（晨昏 zenith=0 → 1e6 上限）是安全的：
        // BSM 两端均不消费 clip.z——生成端 cascade() 的 march 起点经 getRayNearFar 与
        // 云层球壳解析求交（inverseShadowMatrices 的 z=-1 反投影只取 xy），消费端
        // getShadowUv 只取 clip.xy（正交投影 xy 与 z 解耦）。CascadedShadowMaps 的
        // 「distance 过大会超出 ortho 盒深、勿传大值」警告（T1）仅针对未来引入
        // clip.z 剔除/依赖的场景，当前管线不受约束。
        const normal = ellipsoid.geodeticSurfaceNormal(camera.positionWC, normalScratch)
        const zenith = Math.max(0, Cartesian3.dot(state.sunDirection, normal))
        const distance = 1e6 + (1e3 - 1e6) * zenith
        // BSM far：完整视锥 far 与 maxRayDistance 取小（决策 D6——云 march 不超 maxRayDistance）
        const far = Math.min(camera.frustum.far, params.maxRayDistance)
        const near = camera.frustum.near
        cascades.update(
          {
            inverseViewMatrix: camera.inverseViewMatrix,
            projectionMatrix: (camera.frustum as unknown as { projectionMatrix: Matrix4 })
              .projectionMatrix,
            near,
            far
          },
          state.sunDirection,
          distance
        )
        for (let i = 0; i < cascadeCount; i++) {
          Matrix4.clone(cascades.cascades[i].matrix, shadowMatrices[i])
          Matrix4.clone(cascades.cascades[i].inverseMatrix, inverseMatrices[i])
          shadowIntervals[i].x = cascades.cascades[i].interval.x
          shadowIntervals[i].y = cascades.cascades[i].interval.y
        }
        shadowState.cameraNear = near
        shadowState.far = far
        shadowState.bsm = shadowPass.bsmTexture
        shadowPass.render()
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
      // 顺序：先 CloudsPass（消费端，撤 bsm 引用）后 ShadowPass（释放 bsmTexture——T3
      // concern #4），最后生成端 turbulence dummy
      cloudsPass.destroy()
      shadowPass?.destroy()
      shadowTurbulenceDummy?.destroy()
      // overlay：PostProcessStageCollection.remove 成功则内部已 destroy，失败则手动 destroy
      if (!scene.postProcessStages.remove(overlayStage)) {
        overlayStage.destroy()
      }
    }
  }
}
