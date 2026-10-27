// install 编排与失败回滚（产品化 spec §8.1 / §8.2 / §8.5）。
//
// 一行接入的编排层：解析 target → 自检/前置检查 → 场景快照+接管 → 资产（LUT/月面/天气）
// → 大气 stage → 云 stage → overlay 插入 → 返回 handle。
//
// 失败语义（spec §8.2，逐行对应下方实现）：
// - 自检/非 3D/既有 stage 拒绝：此刻**零改动**，直接抛错；迁移步骤里必须写明「经 handle
//   插入的 stage 拿到的是线性 HDR 输入」。
// - log-depth 读回 / 资产 / 大气创建失败：场景已接管 → **还原场景**（+ 释放已建纹理）后抛错。
// - 月面纹理解码失败：warn，回退库内白 dummy（月面是可选增强，不阻断安装）。
// - 天气/云创建失败（抛错或返回 undefined）：大气已挂 → warn，返回只含大气的 handle +
//   `cloudsError`；天气纹理无消费者，立即释放。
// - overlay 插入失败：全量回滚（云 → 大气 → 纹理 → 场景）后抛原始异常。
//
// 本任务范围：生命周期（viewer/widget destroy 包装、并发 Map、取消、3D morph 守卫）由
// Task 10/10A 接入；`autoDestroy` 此处只记录开关，不注册任何监听。

import * as CesiumRuntime from 'cesium'
import {
  SceneMode,
  Texture3D,
  type CesiumWidget,
  type Context,
  type PostProcessStage,
  type PostProcessStageComposite,
  type Scene,
  type Texture,
  type Viewer
} from 'cesium'
import {
  createAtmosphereStage,
  loadAtmosphereLUTs,
  type AtmosphereLUTs,
  type AtmosphereStageHandle,
  type AtmosphereStageOptions
} from '@cesium-geospatial/core'
import {
  createCloudsStage,
  loadWeatherTextures,
  type CloudsQualityPreset,
  type CloudsStageHandle,
  type CloudsStageOptions,
  type WeatherTextures
} from '@cesium-geospatial/clouds'
import { resolveAssetUrls, type AssetOverrides } from './assets'
import { checkCompat, type CompatResult } from './compat'
import { DEMO_PROFILE } from './demoProfile'
import { loadMoonTextures } from './moonTexture'
import { applySceneTakeover, captureSceneState } from './sceneTakeover'

/** 安装目标：Viewer / CesiumWidget 取 `.scene`，Scene 直接使用。 */
export type AtmosphereCloudsTarget = Viewer | CesiumWidget | Scene

/** 一行安装的选项（spec §8）。 */
export interface InstallOptions {
  /**
   * 大气 stage 选项。云桥与月面纹理由 install 自有，因此从类型上排除
   * （`moonSurfaceTexture` 由资产管线加载后注入）。
   */
  atmosphere?: Omit<
    AtmosphereStageOptions,
    'cloudsShadowLengthBridge' | 'cloudsOcclusionBridge' | 'cloudsShadowBridge' | 'moonSurfaceTexture'
  >
  /**
   * 体积云选项；`false` 关闭云（不加载天气/不请求 higher_order/不传三个云桥，与
   * demo `?clouds=0` 零回归路径一致）。`quality` 只能从顶层传（spec §8）。
   */
  clouds?: Omit<CloudsStageOptions, 'clouds' | 'quality'> | false
  /** 云的初始质量档位（仅在装云且非 undefined 时转发 `setQuality`）。 */
  quality?: CloudsQualityPreset
  /** 资产根目录（末尾斜杠可选）；缺省相对 `document.baseURI` 的 `cesium-geospatial-assets/`。 */
  assetsBaseUrl?: string
  /** 逐项资产 URL 覆盖（传完整 URL，不再拼默认目录）。 */
  assets?: AssetOverrides
  /** 是否执行 spec §7.6 完整场景接管表（默认 true）。 */
  takeOverScene?: boolean
  /** 场景已有 postProcessStage 时是否放行（默认 false，放行后链顺序由调用方自负）。 */
  allowExistingStages?: boolean
  /**
   * Viewer / CesiumWidget 的 `destroy` 是否自动联动本 handle（默认 true）。
   * 生命周期包装在 Task 10 接入；本任务只记录该开关。
   */
  autoDestroy?: boolean
}

/** 安装成功后的句柄（spec §8）。 */
export interface AtmosphereCloudsHandle {
  /** 大气 stage handle。 */
  readonly atmosphere: AtmosphereStageHandle
  /** 体积云 handle（`clouds: false` 或云创建失败时不存在）。 */
  readonly clouds?: CloudsStageHandle
  /** 云创建失败的原始错误（抛错或 `createCloudsStage` 返回 undefined 都记在这里）。 */
  readonly cloudsError?: unknown
  /**
   * 把宿主 stage 插入 atmosphere 与 lensflare/tonemap 之间（转发到 atmosphere 的多槽链）。
   * 经本 handle 插入的 stage **所有权在安装期间转移给库**：`destroy()` 会一并移除并销毁。
   */
  insertStageBeforeLensFlare(
    stage: PostProcessStage | PostProcessStageComposite,
    opts?: { protectedStage?: boolean }
  ): void
  /** 移除并销毁经本 handle 插入的宿主 stage（未插入时转发给 atmosphere 的 no-op 语义）。 */
  removeInsertedStage(stage: PostProcessStage | PostProcessStageComposite): void
  /** 换云质量档位；无云或 `cloudsError` 时 no-op + warn。 */
  setQuality(quality: CloudsQualityPreset): void
  /** 幂等释放：云 → 宿主 stage → 大气 → 纹理（4 LUT + 4 weather + 月面合成）。 */
  destroy(): void
}

/**
 * 可注入依赖（Task 10 的生命周期测试与无 GPU 的 Node 单测均经此注入）。
 * `runCompat` 与 Task 4 的纯函数 `checkCompat(input)` 不同名，避免调用点混淆。
 */
export interface InstallDeps {
  /** 组装 CompatInput 后调用 `checkCompat` 的纯函数。 */
  runCompat(scene: Scene): CompatResult
  loadLuts(
    context: Context,
    baseUrl: string,
    opts: { higherOrderScattering: boolean }
  ): Promise<AtmosphereLUTs>
  loadWeather(context: Context, baseUrl: string): Promise<WeatherTextures>
  loadMoon(
    context: Context,
    urls: { surface: string; displacement: string }
  ): Promise<{ texture: Texture; albedoMean: number } | undefined>
  createAtmosphere(
    scene: Scene,
    luts: AtmosphereLUTs,
    options: AtmosphereStageOptions
  ): AtmosphereStageHandle
  createClouds(
    scene: Scene,
    luts: AtmosphereLUTs,
    weather: WeatherTextures,
    options: CloudsStageOptions
  ): CloudsStageHandle | undefined
}

/** 纹理由 install 拥有并销毁（spec §8.5）。 */
interface TextureLike {
  destroy(): void
}

const WARN_PREFIX = '[cesium-geospatial]'

/**
 * `Cesium.VERSION`（运行时存在，但 1.143 的 d.ts 未声明，故经命名空间取值 + 结构化断言）。
 */
const CESIUM_VERSION: string =
  (CesiumRuntime as unknown as { VERSION?: string }).VERSION ?? '未知版本'

function warn(message: string, detail?: unknown): void {
  if (detail === undefined) {
    console.warn(`${WARN_PREFIX} ${message}`)
  } else {
    console.warn(`${WARN_PREFIX} ${message}`, detail)
  }
}

/** Viewer/CesiumWidget 有 `.scene`；Scene 自身没有，直接返回。 */
function resolveScene(target: AtmosphereCloudsTarget): Scene {
  const wrapper = target as { scene?: Scene }
  return wrapper.scene ?? (target as Scene)
}

/**
 * 既有后处理 stage 的拒绝消息：给出可执行的迁移步骤，并写明关键语义——
 * 经 handle 插入的 stage 拿到的是 atmosphere 之后的**线性 HDR** 输入（spec §7.6）。
 */
function existingStagesError(count: number): Error {
  return new Error(
    [
      `${WARN_PREFIX} 场景已有 ${count} 个后处理 stage，无法保证渲染链顺序（本库要求自己的 stage` +
        `紧邻链尾 tonemap，宿主 stage 默认排在其前）。`,
      '迁移步骤：',
      '  1. 安装前移除既有 stage：scene.postProcessStages.remove(stage)；',
      '  2. 需要保留的自定义后处理，在安装后用 handle.insertStageBeforeLensFlare(stage) 重新插入',
      '     （插入顺序即执行顺序，均位于 atmosphere 之后、lensflare/tonemap 之前）；',
      '  3. 注意：经 handle 插入的 stage 拿到的是 atmosphere 之后的线性 HDR 输入，不是原始 globe 颜色',
      '     （tonemap 与 gamma 在链尾统一收尾），shader 必须按线性域处理。',
      '逃生门：安装选项 { allowExistingStages: true }（链顺序由调用方自负，不推荐）。'
    ].join('\n')
  )
}

/** AO / bloom / FXAA 开着不阻断安装，但画面会与 demo 验收档不同（spec §7.6）。 */
function warnEnabledSceneEffects(scene: Scene): void {
  const stages = scene.postProcessStages
  if (stages.ambientOcclusion.enabled) {
    warn(
      'ambientOcclusion 已启用：它作用在本库 stage 之前，会与大气/云合成叠加，建议关闭' +
        '（scene.postProcessStages.ambientOcclusion.enabled = false）'
    )
  }
  if (stages.bloom.enabled) {
    warn(
      'bloom 已启用：它作用在本库 stage 之前，会把线性 HDR 之外的光晕叠进输入，建议关闭' +
        '（scene.postProcessStages.bloom.enabled = false）'
    )
  }
  if (stages.fxaa.enabled) {
    warn(
      'fxaa 已启用：Cesium 恒把 FXAA 排在链尾 tonemap 之后，本库输出会与 demo 验收档不同，建议关闭' +
        '（scene.postProcessStages.fxaa.enabled = false）'
    )
  }
}

/** 生产实现（installAtmosphereClouds 使用）。 */
const defaultDeps: InstallDeps = {
  runCompat(scene) {
    const context = (scene as unknown as {
      context?: {
        webgl2?: boolean
        fragmentDepth?: boolean
        depthTexture?: boolean
      }
    }).context
    return checkCompat({
      version: CESIUM_VERSION,
      hasTexture3D: typeof Texture3D === 'function',
      webgl2: context?.webgl2 === true,
      fragmentDepth: context?.fragmentDepth === true,
      depthTexture: context?.depthTexture === true,
      hasGlobe: (scene as unknown as { globe?: unknown }).globe != null,
      mode: scene.mode,
      scene3dMode: SceneMode.SCENE3D
    })
  },
  loadLuts: (context, baseUrl, options) =>
    loadAtmosphereLUTs(context, baseUrl, {
      higherOrderScattering: options.higherOrderScattering
    }),
  loadWeather: (context, baseUrl) => loadWeatherTextures(context, baseUrl),
  loadMoon: (context, urls) => loadMoonTextures(context, urls),
  createAtmosphere: (scene, luts, options) => createAtmosphereStage(scene, luts, options),
  createClouds: (scene, luts, weather, options) =>
    createCloudsStage(scene, luts, weather, options)
}

/**
 * 一行安装大气 + 体积云（spec §8）。
 *
 * @throws 自检失败、既有 stage 拒绝、log-depth 读回失败、资产失败、大气创建失败、
 *   overlay 插入失败（均按 §8.2 完成对应回滚）；云创建失败不抛错，改由 handle.cloudsError 报告。
 */
export function installAtmosphereClouds(
  target: AtmosphereCloudsTarget,
  options?: InstallOptions
): Promise<AtmosphereCloudsHandle> {
  return installWithDeps(target, options, defaultDeps)
}

/**
 * `installAtmosphereClouds` 的可注入依赖版本（测试/生命周期扩展用）。
 *
 * 编排顺序严格按 spec §8.1：自检 → 前置拒绝 → 快照接管+log-depth 读回 → LUT → 月面 →
 * 大气 → 天气/云 → overlay → handle。
 */
export async function installWithDeps(
  target: AtmosphereCloudsTarget,
  options: InstallOptions | undefined,
  deps: InstallDeps
): Promise<AtmosphereCloudsHandle> {
  const opts = options ?? {}
  const scene = resolveScene(target)

  // ── 自检 + 安装前置检查（此刻零改动，spec §8.2 第一行） ──
  const compat = deps.runCompat(scene)
  for (const warning of compat.warnings) warn(warning)
  if (!compat.ok) {
    throw new Error(`${WARN_PREFIX} 安装自检失败：\n${compat.errors.join('\n')}`)
  }
  const existingStageCount = scene.postProcessStages.length
  if (existingStageCount > 0 && opts.allowExistingStages !== true) {
    throw existingStagesError(existingStageCount)
  }
  warnEnabledSceneEffects(scene)

  // autoDestroy 在本任务只记录（Task 10 接入 viewer/widget destroy 包装与取消语义）。
  const autoDestroy = opts.autoDestroy !== false
  void autoDestroy

  const context = (scene as unknown as { context: Context }).context

  // ── 场景快照 + 接管，随后读回校验对数深度（spec §8.1 步骤 3） ──
  const state = captureSceneState(scene)
  const takeover = applySceneTakeover(scene, state, { enabled: opts.takeOverScene !== false })
  if (scene.logarithmicDepthBuffer !== true) {
    takeover.restore()
    throw new Error(
      `${WARN_PREFIX} scene.logarithmicDepthBuffer 读回不是 true：本库 shader 无条件反演对数深度，` +
        `必须开启对数深度缓冲（默认接管会设置它；takeOverScene: false 时请自行设置 ` +
        `scene.logarithmicDepthBuffer = true）。已还原场景设置。`
    )
  }

  // ── 资源记账（§8.5：install 拥有并销毁） ──
  // 分三组保证释放顺序稳定：4 LUT → 4 weather → 月面合成。
  const lutTextures: TextureLike[] = []
  const weatherTextures: TextureLike[] = []
  const moonTextures: TextureLike[] = []

  const quietly = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      console.error(`${WARN_PREFIX} 释放${label}失败`, error)
    }
  }
  const releaseTextures = (): void => {
    for (const group of [lutTextures, weatherTextures, moonTextures]) {
      for (const texture of group.splice(0)) quietly('纹理', () => texture.destroy())
    }
  }

  let atmosphere: AtmosphereStageHandle | undefined
  let cloudsHandle: CloudsStageHandle | undefined
  /** 全量回滚（§8.2）：云 → 大气 → 纹理 → 场景。各步独立兜底，保证后续步骤执行。 */
  const rollback = (): void => {
    if (cloudsHandle != null) {
      const handle = cloudsHandle
      cloudsHandle = undefined
      quietly('云 stage', () => handle.destroy())
    }
    if (atmosphere != null) {
      const handle = atmosphere
      atmosphere = undefined
      quietly('大气 stage', () => handle.destroy())
    }
    releaseTextures()
    quietly('场景还原', () => takeover.restore())
  }

  let cloudsError: unknown
  let hasCloudsError = false

  try {
    // ── 步骤 4：资产解析 + LUT 加载（clouds:false 跳过 8MB higher_order，spec §7.5） ──
    const urls = resolveAssetUrls(opts.assetsBaseUrl, opts.assets)
    const withClouds = opts.clouds !== false

    const luts = await deps.loadLuts(context, urls.luts, { higherOrderScattering: withClouds })
    lutTextures.push(luts.transmittance, luts.scattering, luts.irradiance)
    if (luts.higherOrderScattering != null) {
      lutTextures.push(luts.higherOrderScattering)
    }

    // 月面纹理是可选增强：失败（抛错或 loader 内部 warn 后返回 undefined）不阻断安装。
    let moon: { texture: Texture; albedoMean: number } | undefined
    try {
      moon = await deps.loadMoon(context, {
        surface: urls.moonSurface,
        displacement: urls.moonDisplacement
      })
    } catch (error) {
      warn('月面纹理加载失败，回退均匀月面（库内白 dummy）', error)
      moon = undefined
    }
    if (moon != null) {
      moonTextures.push(moon.texture)
    }

    // ── 步骤 5：大气 stage（云桥闭包惰性求值，云创建后自动指向真实 handle） ──
    // 注：月面均值补偿（moonRadianceScale = moonRadianceBase / albedoMean）只在 demo 的
    // ?moonAngularRadius 路径使用；默认路径与 demo 一致不补偿，保证产品/demo 同画质。
    const atmosphereOptions: AtmosphereStageOptions = {
      // demo 验收档单一来源（spec §8.4）
      ...DEMO_PROFILE.atmosphere,
      ...opts.atmosphere,
      ...(moon != null ? { moonSurfaceTexture: moon.texture } : {}),
      // §7.5：装云就加载高阶散射；clouds:false 时 LUT 与 shader 同步关闭。
      higherOrderScattering: withClouds,
      // §8 契约：clouds:false 时不传三个云桥（与 ?clouds=0 的零回归路径一致）。
      // 显式写 undefined（而不是省略键）同时挡掉运行时绕过类型传入的桥。
      ...(withClouds
        ? {
            cloudsShadowLengthBridge: () => cloudsHandle?.cloudsPass.getShadowLengthBridge(),
            cloudsOcclusionBridge: () => cloudsHandle?.cloudsPass.getColorBridge(),
            cloudsShadowBridge: () => cloudsHandle?.getGroundShadowBridgeData()
          }
        : {
            cloudsShadowLengthBridge: undefined,
            cloudsOcclusionBridge: undefined,
            cloudsShadowBridge: undefined
          })
    }
    atmosphere = deps.createAtmosphere(scene, luts, atmosphereOptions)

    // ── 步骤 6：天气 + 云 stage ──
    if (withClouds) {
      try {
        const weather = await deps.loadWeather(context, urls.weather)
        const loadedWeatherTextures: TextureLike[] = [
          weather.shape,
          weather.shapeDetail,
          weather.stbn,
          weather.localWeather
        ]
        let created: CloudsStageHandle | undefined
        try {
          created = deps.createClouds(scene, luts, weather, {
            ...DEMO_PROFILE.clouds,
            ...(opts.clouds === false ? {} : (opts.clouds ?? {})),
            clouds: true
          })
          // createCloudsStage 仅在 clouds!==true 时返回 undefined；这里传了 true，
          // 出现 undefined 即视为创建失败（spec §8.2 天气/云创建失败行）。
          if (created == null) {
            throw new Error(`${WARN_PREFIX} createCloudsStage 返回 undefined：体积云创建失败`)
          }
          // spec §8 契约：quality 只能从顶层传；undefined 不调用（防 applyQualityPreset 崩）。
          if (opts.quality != null) {
            created.setQuality(opts.quality)
          }
          cloudsHandle = created
          weatherTextures.push(...loadedWeatherTextures)
        } catch (error) {
          // 云未建成（含 setQuality 抛错后的半死 handle）：天气纹理无消费者，立即释放。
          if (created != null) {
            const halfBuilt = created
            quietly('云 stage', () => halfBuilt.destroy())
          }
          for (const texture of loadedWeatherTextures) {
            quietly('天气纹理', () => texture.destroy())
          }
          throw error
        }
      } catch (error) {
        // 天气/云失败：大气保留，降级为仅大气 handle（cloudsError 可查）。
        hasCloudsError = true
        cloudsError = error
        warn('体积云创建失败，已降级为仅大气（handle.cloudsError 可查）', error)
      }
    }

    // ── 步骤 7：云 overlay 插入 atmosphere 与 lensflare 之间（受保护项，§7.7） ──
    // 失败会抛到下方 catch → 全量回滚（§8.2 overlay 插入失败行）。
    if (cloudsHandle != null) {
      atmosphere.insertStageBeforeLensFlare(cloudsHandle.overlayStage, { protectedStage: true })
    }

    // ── 步骤 8：组装 handle ──
    const atmosphereHandle = atmosphere
    const hostStages = new Set<PostProcessStage | PostProcessStageComposite>()
    let destroyed = false

    return {
      atmosphere: atmosphereHandle,
      ...(cloudsHandle != null ? { clouds: cloudsHandle } : {}),
      ...(hasCloudsError ? { cloudsError } : {}),

      insertStageBeforeLensFlare(stage, stageOpts) {
        if (destroyed) {
          warn('handle 已销毁：insertStageBeforeLensFlare no-op')
          return
        }
        atmosphereHandle.insertStageBeforeLensFlare(stage, stageOpts)
        hostStages.add(stage) // 成功插入才记账（失败时 atmosphere 内部已尽力回滚）
      },

      removeInsertedStage(stage) {
        if (destroyed) {
          warn('handle 已销毁：removeInsertedStage no-op')
          return
        }
        hostStages.delete(stage)
        atmosphereHandle.removeInsertedStage(stage)
      },

      setQuality(quality) {
        if (destroyed) {
          warn('handle 已销毁：setQuality no-op')
          return
        }
        if (quality == null) {
          warn('setQuality(undefined)：no-op（用安装选项 quality 指定初始档位）')
          return
        }
        if (cloudsHandle == null) {
          warn('无体积云（clouds:false 或云创建失败）：setQuality no-op')
          return
        }
        cloudsHandle.setQuality(quality)
      },

      destroy() {
        if (destroyed) return
        destroyed = true
        // spec §8.5：stage → primitive → 纹理（clouds.destroy 内含 overlay 摘除与 primitive 销毁）。
        if (cloudsHandle != null) {
          const handle = cloudsHandle
          quietly('云 stage', () => handle.destroy())
        }
        // 宿主 stage 所有权已转移给库：逐个移除并销毁（atmosphere.destroy 也会兜底清链）。
        for (const stage of hostStages) {
          quietly('宿主 stage', () => atmosphereHandle.removeInsertedStage(stage))
        }
        hostStages.clear()
        quietly('大气 stage', () => atmosphereHandle.destroy())
        releaseTextures()
        // spec §7.6 / 反目标：destroy 后场景设置必须与安装前一致（无条件按快照还原）。
        quietly('场景还原', () => takeover.restore())
      }
    }
  } catch (error) {
    // 资产 / 大气创建 / overlay 插入失败：全量回滚后抛原始异常（§8.2）。
    rollback()
    throw error
  }
}
