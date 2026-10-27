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
// 生命周期（spec §8.2）：模块级 pending/installed 注册表做并发去重；Viewer/CesiumWidget 的
// `destroy` 在第一个 await 之前包装（autoDestroy !== false），安装中销毁 → 取消 + 回滚 +
// reject(InstallCancelledError)；handle.destroy 幂等并恢复原方法。3D morph 守卫（Task 10A）
// 尚未接入。

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
import { applySceneTakeover, captureSceneState, type SceneTakeover } from './sceneTakeover'

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
   * 关闭后 target 销毁不会联动 handle.destroy、安装也不会被自动取消；Scene 目标无此钩子。
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
  /**
   * 幂等释放：云 → 宿主 stage → 大气 → 纹理（4 LUT + 4 weather + 月面合成），
   * 并摘除安装注册表、恢复被包装的 `viewer.destroy`／`widget.destroy`。
   */
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

// ────────────────────────── 生命周期（spec §8.2 并发与幂等） ──────────────────────────

/**
 * 安装被取消：安装过程中 target（Viewer/CesiumWidget）被销毁，或 `disposeAllForHmr()`
 * 取消了进行中的安装。此时已回滚，调用方应把它与普通安装失败区分开（spec §8.2）。
 */
export class InstallCancelledError extends Error {
  constructor(message = '安装已取消：目标在安装过程中被销毁', options?: ErrorOptions) {
    super(`${WARN_PREFIX} ${message}`, options)
    this.name = 'InstallCancelledError'
  }
}

/** 挂在 target 上的生命周期记录键（Symbol 避免与其他库的 destroy 包装冲突）。 */
const DESTROY_RECORD_KEY = Symbol('cesium-geospatial.install.destroyRecord')

/**
 * 每个 Scene 的生命周期记录。
 *
 * Viewer/CesiumWidget 目标会额外包装 `destroy`：`original` 保存包装前的方法**引用本身**
 * （恢复时原样写回，保证 `viewer.destroy === original`），`invokeOriginal` 是 bind 后的
 * 调用副本；Scene 目标没有宿主 destroy 钩子，只保留取消标记。
 */
interface LifecycleRecord {
  /** 取消标记：由包装后的 destroy / disposeAllForHmr 同步置位（每步 await 后检查）。 */
  cancelled: boolean
  /** 安装完成后的 handle（安装中/销毁后为 undefined），供包装的 destroy 联动销毁。 */
  currentHandle?: AtmosphereCloudsHandle
  /** 被包装的宿主（仅 Viewer/CesiumWidget）；Scene 目标为 undefined。 */
  host?: { destroy: (...args: unknown[]) => void }
  /** 包装前的方法引用；恢复时写回同一引用（引用相等可断言）。 */
  original?: (...args: unknown[]) => void
  /** 以正确 this 调用原方法（bind 副本，不参与引用比较）。 */
  invokeOriginal?: () => void
  /** 包装是否已恢复（幂等）。 */
  restored: boolean
  cancel(): void
  /** 恢复原 destroy、摘除宿主 Symbol 与模块记录（幂等；Scene 目标只清模块记录）。 */
  restoreWrapper(): void
}

/** 进行中的安装（并发去重：第二次调用返回同一 Promise）。 */
const pending = new Map<Scene, Promise<AtmosphereCloudsHandle>>()
/** 已安装完成（isInstalled / 重复 install / HMR 清理）。 */
const installed = new Map<Scene, AtmosphereCloudsHandle>()
/** 活跃安装的生命周期记录（取消进行中的安装；成功后在 handle.destroy 时摘除）。 */
const lifecycleRecords = new Map<Scene, LifecycleRecord>()

/**
 * 创建生命周期记录，并在**第一个 await 之前**包装宿主 `destroy`（spec §8.1 步骤 1）。
 *
 * 包装语义：先同步置取消（安装中 → install 在下一个检查点回滚），再销毁已安装 handle；
 * `handle.destroy()` 即使抛错，finally 也必须恢复原方法并调用原 destroy（资源释放不可跳过）。
 */
function createLifecycleRecord(
  target: AtmosphereCloudsTarget,
  scene: Scene,
  wrapDestroy: boolean
): LifecycleRecord {
  const record: LifecycleRecord = {
    cancelled: false,
    currentHandle: undefined,
    host: undefined,
    original: undefined,
    invokeOriginal: undefined,
    restored: false,
    cancel() {
      record.cancelled = true
    },
    restoreWrapper() {
      if (record.restored) return
      record.restored = true
      const host = record.host
      if (host != null && record.original != null) {
        host.destroy = record.original
        delete (host as { [DESTROY_RECORD_KEY]?: LifecycleRecord })[DESTROY_RECORD_KEY]
      }
      // 只摘除自己的记录，避免误删后来者的条目。
      if (lifecycleRecords.get(scene) === record) {
        lifecycleRecords.delete(scene)
      }
    }
  }

  const host = target as {
    scene?: Scene
    destroy?: (...args: unknown[]) => void
  } & { [DESTROY_RECORD_KEY]?: LifecycleRecord }
  // Scene 目标没有 destroy 钩子（Scene 自身虽有 destroy，但不是宿主生命周期入口）。
  if (!wrapDestroy || host.scene == null || typeof host.destroy !== 'function') {
    return record
  }

  // 防叠加：极端情况下残留的旧记录先恢复，再从恢复后的原方法重新包装。
  const stale = host[DESTROY_RECORD_KEY]
  if (stale != null) {
    stale.restoreWrapper()
  }

  const original = host.destroy
  record.host = host as { destroy: (...args: unknown[]) => void }
  record.original = original
  record.invokeOriginal = original.bind(host)
  host.destroy = function wrappedDestroy() {
    // handle.destroy 抛错也要在这里摘注册表，否则 isInstalled 会永远为 true。
    const finishing = record.currentHandle
    record.cancel()
    try {
      // 安装中 currentHandle 为 undefined：只置取消，回滚由 install 的检查点执行。
      finishing?.destroy()
    } finally {
      if (finishing != null && installed.get(scene) === finishing) {
        installed.delete(scene)
      }
      record.currentHandle = undefined
      record.restoreWrapper()
      record.invokeOriginal?.()
    }
  }
  host[DESTROY_RECORD_KEY] = record
  return record
}

/**
 * 是否已**安装完成**（spec §8 契约）：安装中（pending）返回 false；
 * `handle.destroy()`、target 销毁或安装失败后返回 false。
 */
export function isInstalled(target: AtmosphereCloudsTarget): boolean {
  return installed.has(resolveScene(target))
}

/**
 * HMR 清理钩子（spec §8.2）：销毁全部已安装 handle、取消进行中的安装、恢复所有
 * destroy 包装并清空两个注册表。宿主场景本身不被销毁。
 */
export function disposeAllForHmr(): void {
  for (const handle of [...installed.values()]) {
    try {
      handle.destroy()
    } catch (error) {
      console.error(`${WARN_PREFIX} HMR 清理时销毁 handle 失败`, error)
    }
  }
  // 进行中的安装：置取消标记并立即恢复包装；其 Promise 在下一个检查点回滚并 reject。
  for (const record of [...lifecycleRecords.values()]) {
    record.cancel()
    record.restoreWrapper()
  }
  pending.clear()
  installed.clear()
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
 *   overlay 插入失败（均按 §8.2 完成对应回滚）；云创建失败不抛错，改由 handle.cloudsError 报告；
 *   安装期间 target 被销毁 / HMR 取消时 reject `InstallCancelledError`（已回滚）。
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
export function installWithDeps(
  target: AtmosphereCloudsTarget,
  options: InstallOptions | undefined,
  deps: InstallDeps
): Promise<AtmosphereCloudsHandle> {
  const scene = resolveScene(target)

  // ── 并发与幂等（spec §8.2）：按 scene 去重，第二次调用拿到同一 Promise/handle ──
  const inFlight = pending.get(scene)
  if (inFlight != null) {
    warn('该 Scene 正在安装中：本次调用的 options 未生效，返回进行中的安装 Promise')
    return inFlight
  }
  const existing = installed.get(scene)
  if (existing != null) {
    warn('该 Scene 已安装：options 未生效；如需重新安装请先调用 handle.destroy()')
    return Promise.resolve(existing)
  }

  const promise = runInstall(target, scene, options, deps)
  pending.set(scene, promise)
  // pending 清理挂在 promise 反应上，而不是 runInstall 内：自检/既有 stage 在第一个
  // await 之前就失败时也能清掉（否则同 scene 的后续调用永远拿到已失败的 Promise）。
  // 相等性守卫：避免异步清理误删后来者的 pending 条目。
  const settle = (): void => {
    if (pending.get(scene) === promise) {
      pending.delete(scene)
    }
  }
  void promise.then(settle, settle)
  return promise
}

/**
 * 真正的安装流程：spec §8.1 八步编排 + §8.2 生命周期（destroy 包装、取消、注册表）。
 * 由 `installWithDeps` 在去重之后调用；`pending` 条目由调用方清理。
 */
async function runInstall(
  target: AtmosphereCloudsTarget,
  scene: Scene,
  options: InstallOptions | undefined,
  deps: InstallDeps
): Promise<AtmosphereCloudsHandle> {
  const opts = options ?? {}

  // ── 步骤 1（spec §8.1）：生命周期记录 + destroy 包装，必须先于第一个 await ──
  const record = createLifecycleRecord(target, scene, opts.autoDestroy !== false)
  lifecycleRecords.set(scene, record)

  /** 每个 await 之后调用：取消由包装后的 destroy 同步置位（不是轮询）。 */
  const assertActive = (): void => {
    if (record.cancelled || scene.isDestroyed()) {
      throw new InstallCancelledError(
        record.cancelled
          ? '安装已取消：安装期间 target 被销毁（viewer/widget.destroy 或 disposeAllForHmr）'
          : '安装已取消：安装期间 Scene 已被销毁'
      )
    }
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
  /** 从所有权数组摘除（失败路径自行释放时用，防 double destroy）。 */
  const detachTextures = (group: TextureLike[], items: TextureLike[]): void => {
    for (const item of items) {
      const index = group.indexOf(item)
      if (index >= 0) group.splice(index, 1)
    }
  }

  let takeover: SceneTakeover | undefined
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
    if (takeover != null) {
      const sceneTakeover = takeover
      quietly('场景还原', () => sceneTakeover.restore())
    }
  }
  /**
   * 取消回滚（target/scene 已销毁）：Cesium `destroyObject` 已释放 GL 资源，再调用
   * stage/纹理的 destroy 会抛；只丢引用与注册表，不做 GL 销毁（spec §8.1）。
   */
  const discardDestroyedResources = (): void => {
    cloudsHandle = undefined
    atmosphere = undefined
    lutTextures.length = 0
    weatherTextures.length = 0
    moonTextures.length = 0
  }

  let cloudsError: unknown
  let hasCloudsError = false

  try {
    assertActive()

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

    const context = (scene as unknown as { context: Context }).context

    // ── 场景快照 + 接管，随后读回校验对数深度（spec §8.1 步骤 3） ──
    const state = captureSceneState(scene)
    takeover = applySceneTakeover(scene, state, { enabled: opts.takeOverScene !== false })
    if (scene.logarithmicDepthBuffer !== true) {
      takeover.restore()
      throw new Error(
        `${WARN_PREFIX} scene.logarithmicDepthBuffer 读回不是 true：本库 shader 无条件反演对数深度，` +
          `必须开启对数深度缓冲（默认接管会设置它；takeOverScene: false 时请自行设置 ` +
          `scene.logarithmicDepthBuffer = true）。已还原场景设置。`
      )
    }

    // ── 步骤 4：资产解析 + LUT 加载（clouds:false 跳过 8MB higher_order，spec §7.5） ──
    const urls = resolveAssetUrls(opts.assetsBaseUrl, opts.assets)
    const withClouds = opts.clouds !== false

    const luts = await deps.loadLuts(context, urls.luts, { higherOrderScattering: withClouds })
    lutTextures.push(luts.transmittance, luts.scattering, luts.irradiance)
    if (luts.higherOrderScattering != null) {
      lutTextures.push(luts.higherOrderScattering)
    }
    // 先登记所有权再查取消：未销毁 target 的取消由统一回滚释放这些纹理。
    assertActive()

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
    assertActive()

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
        // 先登记所有权再查取消：未销毁 target 的取消由统一回滚释放这些纹理。
        weatherTextures.push(...loadedWeatherTextures)
        assertActive()
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
        } catch (error) {
          // 取消不是「云创建失败」：原样上抛，交给外层统一取消回滚。
          if (error instanceof InstallCancelledError) throw error
          // 云未建成（含 setQuality 抛错后的半死 handle）：天气纹理无消费者，立即释放。
          detachTextures(weatherTextures, loadedWeatherTextures)
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
        // 取消/目标销毁不是「云创建失败」：原样上抛交给外层统一回滚（spec §8.1/§8.2）。
        if (error instanceof InstallCancelledError || record.cancelled || scene.isDestroyed()) {
          throw error
        }
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

    // 注册前最后一次检查：注册后 handle 即对外可见，不再接受取消。
    assertActive()

    // ── 步骤 8：组装 handle 并登记注册表（spec §8.1 步骤 8 / §8.2） ──
    const atmosphereHandle = atmosphere
    const hostStages = new Set<PostProcessStage | PostProcessStageComposite>()
    let destroyed = false

    const handle: AtmosphereCloudsHandle = {
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
        // 生命周期（§8.2）：先摘注册表并恢复 destroy 包装，再释放 GL 资源。
        // 由包装的 viewer.destroy 调用时 currentHandle 已被置空，restoreWrapper 幂等。
        if (installed.get(scene) === handle) {
          installed.delete(scene)
        }
        record.currentHandle = undefined
        record.restoreWrapper()
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
        if (takeover != null) {
          const sceneTakeover = takeover
          quietly('场景还原', () => sceneTakeover.restore())
        }
      }
    }

    installed.set(scene, handle)
    record.currentHandle = handle
    return handle
  } catch (error) {
    // ── 失败 / 取消统一回滚（spec §8.1/§8.2）：回滚 → 恢复包装 → 抛错 ──
    // 普通失败（资产 / 大气创建 / overlay 插入）：全量回滚后抛原始异常；
    // 取消：按「target 是否已销毁」选择跳过 GL 销毁。
    const cancelled = record.cancelled || scene.isDestroyed()
    if (cancelled && scene.isDestroyed()) {
      // target 已销毁：GL 已随 Cesium 释放，跳过 stage/纹理销毁与场景还原。
      discardDestroyedResources()
    } else {
      rollback()
    }
    record.currentHandle = undefined
    record.restoreWrapper()

    if (cancelled) {
      throw error instanceof InstallCancelledError
        ? error
        : new InstallCancelledError('安装已取消：目标在安装过程中被销毁', { cause: error })
    }
    throw error
  }
}
