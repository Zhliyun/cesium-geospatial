import { describe, it, expect, vi } from 'vitest'
import type {
  Context,
  PostProcessStage,
  PostProcessStageComposite,
  Scene,
  Texture
} from 'cesium'
import type {
  AtmosphereLUTs,
  AtmosphereStageHandle,
  AtmosphereStageOptions,
  CloudsShadowBridgeData
} from '@cesium-geospatial/core'
import type {
  CloudsStageHandle,
  CloudsStageOptions,
  WeatherTextures
} from '@cesium-geospatial/clouds'
import {
  disposeAllForHmr,
  installWithDeps,
  InstallCancelledError,
  isInstalled,
  type AtmosphereCloudsTarget,
  type InstallDeps,
  type InstallOptions
} from './install'
import type { CompatResult } from './compat'

// 全部用例用结构化假 scene + 假 deps，不构造任何真实 Cesium 对象、不触 GL。
// 断言的是 install 的**真实调用与顺序**（依赖方法的入参 / invocationCallOrder / 释放顺序），
// 不 mock 被测模块内部实现。

// ────────────────────────────── 假 scene ──────────────────────────────

type FakeColor = { red: number; green: number; blue: number; alpha: number }
interface FakeGlobe {
  depthTestAgainstTerrain: boolean
  showGroundAtmosphere: boolean
  enableLighting: boolean
}
interface FakePostProcessStages {
  length: number
  ambientOcclusion: { enabled: boolean }
  bloom: { enabled: boolean }
  fxaa: { enabled: boolean }
}
/** Cesium Event 最小结构：addEventListener 返回移除函数，removeEventListener 按引用摘除。 */
interface FakeEvent {
  listeners: Set<() => void>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function makeFakeEvent(): FakeEvent {
  const listeners = new Set<() => void>()
  return {
    listeners,
    addEventListener: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    removeEventListener: vi.fn((listener: () => void) => {
      listeners.delete(listener)
    })
  }
}

interface FakeScene {
  globe: FakeGlobe
  skyAtmosphere: { show: boolean }
  skyBox: { show: boolean }
  sun: { show: boolean }
  moon: { show: boolean }
  fog: { enabled: boolean }
  backgroundColor: FakeColor
  logarithmicDepthBuffer: boolean
  highDynamicRange: boolean
  requestRenderMode: boolean
  requestRender: ReturnType<typeof vi.fn>
  /** 生命周期用例用它模拟 Cesium `viewer.destroy()` 后的 scene 状态。 */
  destroyed: boolean
  isDestroyed: () => boolean
  postProcessStages: FakePostProcessStages
  context: { webgl2: boolean }
  mode: number
  /** 3D 模式守卫（spec §7.6 / Task 10A）：morph 事件的结构化假对象。 */
  morphStart: FakeEvent
  morphComplete: FakeEvent
}

const ORIGINAL_BACKGROUND: FakeColor = { red: 0.1, green: 0.2, blue: 0.3, alpha: 1 }

function makeScene(): FakeScene {
  const scene: FakeScene = {
    globe: { depthTestAgainstTerrain: false, showGroundAtmosphere: true, enableLighting: true },
    skyAtmosphere: { show: true },
    skyBox: { show: true },
    sun: { show: true },
    moon: { show: true },
    fog: { enabled: true },
    backgroundColor: { ...ORIGINAL_BACKGROUND },
    logarithmicDepthBuffer: false,
    highDynamicRange: true,
    requestRenderMode: true,
    requestRender: vi.fn(),
    destroyed: false,
    isDestroyed: () => scene.destroyed,
    postProcessStages: {
      length: 0,
      ambientOcclusion: { enabled: false },
      bloom: { enabled: false },
      fxaa: { enabled: false }
    },
    context: { webgl2: true },
    mode: 3,
    morphStart: makeFakeEvent(),
    morphComplete: makeFakeEvent()
  }
  return scene
}

const asScene = (fake: FakeScene): Scene => fake as unknown as Scene

interface FakeViewer {
  readonly scene: Scene | undefined
  isDestroyed: () => boolean
  destroy: () => void
}

/**
 * 假 Viewer：`destroy` 写进 order 并把 scene 标记为已销毁——与 Cesium 的
 * `viewer.destroy()` 真实后果一致（GL 资源随 scene 释放）。
 *
 * 真实 Cesium 在 `Viewer.destroy()` 末尾把 `_cesiumWidget` 置空，此后 `viewer.scene`
 * getter 要么返回 undefined、要么解引用空对象抛 TypeError。`throwSceneGetterAfterDestroy`
 * 用来覆盖后一种（更严苛）行为。
 */
function makeViewer(
  fakeScene: FakeScene,
  order: string[],
  opts: { throwSceneGetterAfterDestroy?: boolean } = {}
) {
  let destroyed = false
  const original = vi.fn(() => {
    order.push('viewer.destroy.original')
    fakeScene.destroyed = true
    destroyed = true
  })
  const viewer: FakeViewer = {
    get scene(): Scene | undefined {
      if (destroyed && opts.throwSceneGetterAfterDestroy === true) {
        throw new TypeError("Cannot read properties of undefined (reading 'scene')")
      }
      return destroyed ? undefined : asScene(fakeScene)
    },
    isDestroyed: () => destroyed,
    destroy: original
  }
  return { viewer, original }
}

const asTarget = (viewer: FakeViewer): AtmosphereCloudsTarget =>
  viewer as unknown as AtmosphereCloudsTarget

// ────────────────────────────── 假纹理 / 假 handle ──────────────────────────────

interface FakeTexture {
  name: string
  destroy: ReturnType<typeof vi.fn>
}

/** 所有释放动作写进同一条 order 数组，用于断言全局销毁顺序。 */
function makeTexture(name: string, order: string[]): FakeTexture {
  return { name, destroy: vi.fn(() => order.push(`texture:${name}`)) }
}

describe('install 编排（spec §8.1/§8.2/§8.5）', () => {
  function makeTextureSet(order: string[]) {
    const lut = {
      transmittance: makeTexture('lut.transmittance', order),
      scattering: makeTexture('lut.scattering', order),
      irradiance: makeTexture('lut.irradiance', order),
      higherOrderScattering: makeTexture('lut.higherOrderScattering', order)
    }
    const weather = {
      shape: makeTexture('weather.shape', order),
      shapeDetail: makeTexture('weather.shapeDetail', order),
      stbn: makeTexture('weather.stbn', order),
      localWeather: makeTexture('weather.localWeather', order)
    }
    const moon = makeTexture('moon', order)
    return { lut, weather, moon, all: [...Object.values(lut), ...Object.values(weather), moon] }
  }

  function makeAtmosphere(order: string[]) {
    const inserted: PostProcessStage[] = []
    // 3D 守卫（Task 10A）会按快照切换这四个 stage 的 enabled——假 stage 需要真实可写的
    // enabled 字段（depthTemporal 透传模式恒 false 的快照恢复用例用它）。
    const atmosphereStage = { enabled: true } as unknown as PostProcessStage
    const tonemapStage = { enabled: true } as unknown as PostProcessStage
    const lensFlareStage = { enabled: true } as unknown as PostProcessStageComposite
    const depthTemporalStage = { enabled: true } as unknown as PostProcessStage
    const handle = {
      atmosphereStage,
      tonemapStage,
      lensFlareStage,
      depthTemporalStage,
      insertStageBeforeLensFlare: vi.fn(
        (stage: PostProcessStage | PostProcessStageComposite, _opts?: { protectedStage?: boolean }) => {
          inserted.push(stage as PostProcessStage)
        }
      ),
      removeInsertedStage: vi.fn((stage: PostProcessStage | PostProcessStageComposite) => {
        const index = inserted.indexOf(stage as PostProcessStage)
        if (index >= 0) inserted.splice(index, 1)
      }),
      destroy: vi.fn(() => {
        order.push('atmosphere.destroy')
      })
    }
    return { handle: handle as unknown as AtmosphereStageHandle, inserted, mock: handle }
  }

  function makeClouds(order: string[]) {
    const overlayStage = { name: 'clouds_overlay' } as unknown as PostProcessStage
    const shadowLengthBridge = { _texture: 'shadowLength', _target: 1 }
    const colorBridge = { _texture: 'color', _target: 1 }
    const groundShadowBridge = { cascades: [] } as unknown as CloudsShadowBridgeData
    const cloudsPass = {
      getShadowLengthBridge: vi.fn(() => shadowLengthBridge),
      getColorBridge: vi.fn(() => colorBridge)
    }
    const handle = {
      cloudsPass,
      overlayStage,
      setQuality: vi.fn(),
      setEnabled: vi.fn(),
      getGroundShadowBridgeData: vi.fn(() => groundShadowBridge),
      destroy: vi.fn(() => {
        order.push('clouds.destroy')
      })
    }
    return {
      handle: handle as unknown as CloudsStageHandle,
      mock: handle,
      overlayStage,
      shadowLengthBridge,
      colorBridge,
      groundShadowBridge
    }
  }

  // 不标注 InstallDeps 返回类型：保留 vi.fn 的 Mock 类型（.mock.calls / mockReturnValue 等
  // 是断言对象；mock 签名本身已满足 InstallDeps 契约）。
  function makeDeps(
    order: string[],
    atmosphere: ReturnType<typeof makeAtmosphere>,
    clouds: ReturnType<typeof makeClouds>,
    textures: ReturnType<typeof makeTextureSet>
  ) {
    const lutsWithHigherOrder = {
      transmittance: textures.lut.transmittance,
      scattering: textures.lut.scattering,
      irradiance: textures.lut.irradiance,
      higherOrderScattering: textures.lut.higherOrderScattering
    } as unknown as AtmosphereLUTs
    const lutsWithoutHigherOrder = {
      transmittance: textures.lut.transmittance,
      scattering: textures.lut.scattering,
      irradiance: textures.lut.irradiance
    } as unknown as AtmosphereLUTs
    const weatherTextures = {
      shape: textures.weather.shape,
      shapeDetail: textures.weather.shapeDetail,
      stbn: textures.weather.stbn,
      localWeather: textures.weather.localWeather
    } as unknown as WeatherTextures

    return {
      runCompat: vi.fn((_scene: Scene): CompatResult => ({ ok: true, warnings: [], errors: [] })),
      loadLuts: vi.fn(
        async (
          _context: Context,
          _baseUrl: string,
          options: { higherOrderScattering: boolean }
        ): Promise<AtmosphereLUTs> =>
          options.higherOrderScattering ? lutsWithHigherOrder : lutsWithoutHigherOrder
      ),
      loadWeather: vi.fn(
        async (_context: Context, _baseUrl: string): Promise<WeatherTextures> => weatherTextures
      ),
      loadMoon: vi.fn(
        async (
          _context: Context,
          _urls: { surface: string; displacement: string }
        ): Promise<{ texture: Texture; albedoMean: number } | undefined> => ({
          texture: textures.moon as unknown as Texture,
          albedoMean: 0.5
        })
      ),
      createAtmosphere: vi.fn(
        (
          _scene: Scene,
          _luts: AtmosphereLUTs,
          _options: AtmosphereStageOptions
        ): AtmosphereStageHandle => atmosphere.handle
      ),
      createClouds: vi.fn(
        (
          _scene: Scene,
          _luts: AtmosphereLUTs,
          _weather: WeatherTextures,
          _options: CloudsStageOptions
        ): CloudsStageHandle | undefined => clouds.handle
      )
    }
  }

  function setup() {
    const order: string[] = []
    const scene = makeScene()
    const atmosphere = makeAtmosphere(order)
    const clouds = makeClouds(order)
    const textures = makeTextureSet(order)
    const deps = makeDeps(order, atmosphere, clouds, textures)
    return { order, scene, atmosphere, clouds, textures, deps }
  }

  type Fixture = ReturnType<typeof setup>

  /** 供「可控 deferred」用例在卡点解除时喂回合法 LUT 集合（含高阶散射）。 */
  function lutsOf(textures: ReturnType<typeof makeTextureSet>): AtmosphereLUTs {
    return {
      transmittance: textures.lut.transmittance,
      scattering: textures.lut.scattering,
      irradiance: textures.lut.irradiance,
      higherOrderScattering: textures.lut.higherOrderScattering
    } as unknown as AtmosphereLUTs
  }

  async function install(fixture: Fixture, options?: InstallOptions) {
    return installWithDeps(asScene(fixture.scene), options, fixture.deps)
  }

  const callOrder = (mock: { mock: { invocationCallOrder: readonly number[] } }): number =>
    mock.mock.invocationCallOrder[0]

  /** 触发 Cesium Event 假对象的全部监听（morph 事件用例用）。 */
  const fire = (event: FakeEvent): void => {
    for (const listener of [...event.listeners]) listener()
  }

  // ── happy path ──

  it('默认装大气+云，按 LUT→月面→大气→天气→云→overlay 顺序编排', async () => {
    const f = setup()
    const handle = await install(f)

    expect(f.deps.loadLuts).toHaveBeenCalledTimes(1)
    expect(f.deps.loadMoon).toHaveBeenCalledTimes(1)
    expect(f.deps.createAtmosphere).toHaveBeenCalledTimes(1)
    expect(f.deps.loadWeather).toHaveBeenCalledTimes(1)
    expect(f.deps.createClouds).toHaveBeenCalledTimes(1)

    // LUT → 大气 → 天气 → 云 → overlay 插入（spec §8.1 步骤 4-7）
    expect(callOrder(f.deps.loadLuts)).toBeLessThan(callOrder(f.deps.loadMoon))
    expect(callOrder(f.deps.loadMoon)).toBeLessThan(callOrder(f.deps.createAtmosphere))
    expect(callOrder(f.deps.createAtmosphere)).toBeLessThan(callOrder(f.deps.loadWeather))
    expect(callOrder(f.deps.loadWeather)).toBeLessThan(callOrder(f.deps.createClouds))
    expect(callOrder(f.deps.createClouds)).toBeLessThan(
      callOrder(f.atmosphere.mock.insertStageBeforeLensFlare)
    )

    // 云 overlay 以受保护项插入（§7.7 归属规则）
    expect(f.atmosphere.mock.insertStageBeforeLensFlare).toHaveBeenCalledTimes(1)
    expect(f.atmosphere.mock.insertStageBeforeLensFlare).toHaveBeenCalledWith(f.clouds.overlayStage, {
      protectedStage: true
    })
    expect(f.atmosphere.inserted).toEqual([f.clouds.overlayStage])

    expect(handle.atmosphere).toBe(f.atmosphere.handle)
    expect(handle.clouds).toBe(f.clouds.handle)
    expect(handle.cloudsError).toBeUndefined()
  })

  it('clouds:false 不加载天气、不传三个云桥，higherOrderScattering 传 false', async () => {
    const f = setup()
    const handle = await install(f, { clouds: false })

    expect(f.deps.loadWeather).not.toHaveBeenCalled()
    expect(f.deps.createClouds).not.toHaveBeenCalled()
    expect(f.deps.loadLuts.mock.calls[0][2]).toEqual({ higherOrderScattering: false })

    const options = f.deps.createAtmosphere.mock.calls[0][2]
    expect(options.higherOrderScattering).toBe(false)
    expect(options.cloudsShadowLengthBridge).toBeUndefined()
    expect(options.cloudsOcclusionBridge).toBeUndefined()
    expect(options.cloudsShadowBridge).toBeUndefined()

    expect(handle.clouds).toBeUndefined()
    expect(handle.cloudsError).toBeUndefined()
    expect(f.atmosphere.mock.insertStageBeforeLensFlare).not.toHaveBeenCalled()

    // 未加载 higher_order：destroy 只释放 3 LUT + 月面
    handle.destroy()
    expect(f.textures.lut.higherOrderScattering.destroy).not.toHaveBeenCalled()
    for (const texture of [
      f.textures.lut.transmittance,
      f.textures.lut.scattering,
      f.textures.lut.irradiance,
      f.textures.moon
    ]) {
      expect(texture.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it('三个云桥闭包在云创建后指向真实 clouds handle', async () => {
    const f = setup()
    await install(f, {})

    const options = f.deps.createAtmosphere.mock.calls[0][2]
    expect(options.higherOrderScattering).toBe(true)
    expect(options.cloudsShadowLengthBridge!()).toBe(f.clouds.shadowLengthBridge)
    expect(options.cloudsOcclusionBridge!()).toBe(f.clouds.colorBridge)
    expect(options.cloudsShadowBridge!()).toBe(f.clouds.groundShadowBridge)
    // demo 验收档单一来源（spec §8.4）
    expect(options.groundShadowStrength).toBe(0.8)
  })

  it('quality 未传时不调用 setQuality；传入时按顶层 quality 转发', async () => {
    const none = setup()
    await install(none)
    expect(none.clouds.mock.setQuality).not.toHaveBeenCalled()

    const low = setup()
    await install(low, { quality: 'low' })
    expect(low.clouds.mock.setQuality).toHaveBeenCalledTimes(1)
    expect(low.clouds.mock.setQuality).toHaveBeenCalledWith('low')
  })

  // ── 前置拒绝 / 告警 ──

  it('既有 postProcessStages 非空时拒绝安装（消息含迁移步骤与线性 HDR）；allowExistingStages 放行', async () => {
    const f = setup()
    f.scene.postProcessStages.length = 2
    await expect(install(f)).rejects.toThrow(/allowExistingStages/)
    await expect(install(f)).rejects.toThrow(/线性 HDR/)

    // 零改动：没有任何资产/stage 动作，场景设置未动
    expect(f.deps.loadLuts).not.toHaveBeenCalled()
    expect(f.deps.createAtmosphere).not.toHaveBeenCalled()
    expect(f.scene.logarithmicDepthBuffer).toBe(false)
    expect(f.scene.highDynamicRange).toBe(true)

    const allowed = setup()
    allowed.scene.postProcessStages.length = 2
    await expect(install(allowed, { allowExistingStages: true })).resolves.toBeDefined()
    expect(allowed.deps.createAtmosphere).toHaveBeenCalledTimes(1)
  })

  it('AO/BLOOM/FXAA 开启时逐个 warn 但继续安装', async () => {
    const f = setup()
    f.scene.postProcessStages.ambientOcclusion.enabled = true
    f.scene.postProcessStages.bloom.enabled = true
    f.scene.postProcessStages.fxaa.enabled = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(install(f)).resolves.toBeDefined()
      const text = warn.mock.calls.map((call) => String(call[0])).join('\n')
      expect(text).toMatch(/ambientOcclusion/)
      expect(text).toMatch(/bloom/)
      expect(text).toMatch(/fxaa/)
    } finally {
      warn.mockRestore()
    }
  })

  // ── 失败语义（spec §8.2 逐行） ──

  it('runCompat 失败时零改动并抛错（全部 errors 进消息）', async () => {
    const f = setup()
    f.deps.runCompat.mockReturnValue({
      ok: false,
      warnings: [],
      errors: ['缺少 Texture3D 构造器', '运行环境不是 WebGL2']
    })
    await expect(install(f)).rejects.toThrow(/缺少 Texture3D 构造器[\s\S]*运行环境不是 WebGL2/)

    expect(f.deps.loadLuts).not.toHaveBeenCalled()
    expect(f.deps.loadMoon).not.toHaveBeenCalled()
    expect(f.deps.createAtmosphere).not.toHaveBeenCalled()
    expect(f.textures.all.every((t) => t.destroy.mock.calls.length === 0)).toBe(true)
    expect(f.scene.logarithmicDepthBuffer).toBe(false)
    expect(f.scene.highDynamicRange).toBe(true)
  })

  it('log-depth 读回失败时还原场景并抛错', async () => {
    const f = setup()
    // 模拟 Cesium 拒绝写入：setter 无效、getter 恒 false
    Object.defineProperty(f.scene, 'logarithmicDepthBuffer', {
      configurable: true,
      get: () => false,
      set: () => {}
    })
    await expect(install(f)).rejects.toThrow(/对数深度/)

    expect(f.scene.highDynamicRange).toBe(true) // 接管值 false 已还原
    expect(f.scene.requestRenderMode).toBe(true)
    expect(f.scene.requestRender).toHaveBeenCalled() // 还原 requestRenderMode 后补帧
    expect(f.deps.loadLuts).not.toHaveBeenCalled()
  })

  it('createAtmosphere 抛错时还原场景、释放 LUT 与月面纹理', async () => {
    const f = setup()
    const boom = new Error('atmosphere boom')
    f.deps.createAtmosphere.mockImplementation(() => {
      throw boom
    })
    await expect(install(f)).rejects.toBe(boom)

    expect(f.scene.highDynamicRange).toBe(true)
    expect(f.scene.globe.showGroundAtmosphere).toBe(true)
    expect(f.deps.loadWeather).not.toHaveBeenCalled()
    for (const texture of Object.values(f.textures.lut)) {
      expect(texture.destroy).toHaveBeenCalledTimes(1)
    }
    expect(f.textures.moon.destroy).toHaveBeenCalledTimes(1)
    expect(f.clouds.mock.destroy).not.toHaveBeenCalled()
  })

  it('loadMoon 返回 undefined 时继续，不传 moonSurfaceTexture 且不登记月面纹理', async () => {
    const f = setup()
    f.deps.loadMoon.mockResolvedValue(undefined)
    const handle = await install(f)

    expect(f.deps.createAtmosphere.mock.calls[0][2].moonSurfaceTexture).toBeUndefined()
    expect(handle.clouds).toBe(f.clouds.handle)

    handle.destroy()
    expect(f.textures.moon.destroy).not.toHaveBeenCalled()
    // 4 LUT + 4 weather 仍全额释放
    for (const texture of [...Object.values(f.textures.lut), ...Object.values(f.textures.weather)]) {
      expect(texture.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it('createClouds 返回 undefined 视为失败：返回带 cloudsError 的 handle，大气保留', async () => {
    const f = setup()
    f.deps.createClouds.mockReturnValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await install(f)

      expect(handle.clouds).toBeUndefined()
      expect(handle.cloudsError).toBeInstanceOf(Error)
      expect(f.atmosphere.mock.destroy).not.toHaveBeenCalled()
      expect(f.atmosphere.mock.insertStageBeforeLensFlare).not.toHaveBeenCalled()
      // 天气纹理无消费者：立即释放，不进入 handle 所有权
      for (const texture of Object.values(f.textures.weather)) {
        expect(texture.destroy).toHaveBeenCalledTimes(1)
      }

      // 大气与 LUT/月面仍归 handle 所有
      handle.destroy()
      expect(f.atmosphere.mock.destroy).toHaveBeenCalledTimes(1)
      for (const texture of [...Object.values(f.textures.lut), f.textures.moon]) {
        expect(texture.destroy).toHaveBeenCalledTimes(1)
      }
      // 天气纹理不被二次释放
      for (const texture of Object.values(f.textures.weather)) {
        expect(texture.destroy).toHaveBeenCalledTimes(1)
      }

      // 无云：setQuality 为 no-op + warn
      const warnCallsBefore = warn.mock.calls.length
      handle.setQuality('ultra')
      expect(warn.mock.calls.length).toBeGreaterThan(warnCallsBefore)
      expect(f.clouds.mock.setQuality).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('loadMoon 抛错时 warn 后继续（白 dummy 路径，不阻断安装）', async () => {
    const f = setup()
    f.deps.loadMoon.mockRejectedValue(new Error('moon decode'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await install(f)
      expect(f.deps.createAtmosphere.mock.calls[0][2].moonSurfaceTexture).toBeUndefined()
      expect(handle.clouds).toBe(f.clouds.handle)
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/月面纹理/)
    } finally {
      warn.mockRestore()
    }
  })

  it('loadWeather 抛错时返回带 cloudsError 的 handle（大气保留，无天气纹理可释放）', async () => {
    const f = setup()
    const boom = new Error('weather 404')
    f.deps.loadWeather.mockRejectedValue(boom)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await install(f)
      expect(handle.clouds).toBeUndefined()
      expect(handle.cloudsError).toBe(boom)
      expect(f.deps.createClouds).not.toHaveBeenCalled()
      expect(f.atmosphere.mock.insertStageBeforeLensFlare).not.toHaveBeenCalled()
      // 天气纹理从未创建：destroy 只释放 LUT + 月面
      handle.destroy()
      for (const texture of [...Object.values(f.textures.lut), f.textures.moon]) {
        expect(texture.destroy).toHaveBeenCalledTimes(1)
      }
      for (const texture of Object.values(f.textures.weather)) {
        expect(texture.destroy).not.toHaveBeenCalled()
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('云创建抛错时返回带 cloudsError 的 handle（大气保留、错误原样带出）', async () => {
    const f = setup()
    const boom = new Error('clouds boom')
    f.deps.createClouds.mockImplementation(() => {
      throw boom
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const handle = await install(f)

      expect(handle.clouds).toBeUndefined()
      expect(handle.cloudsError).toBe(boom)
      expect(handle.atmosphere).toBe(f.atmosphere.handle)
      expect(f.atmosphere.mock.insertStageBeforeLensFlare).not.toHaveBeenCalled()
      expect(f.clouds.mock.destroy).not.toHaveBeenCalled()
      expect(f.textures.weather.shape.destroy).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('overlay 插入失败时全量回滚：destroy 云、释放全部纹理、destroy 大气、还原场景', async () => {
    const f = setup()
    const boom = new Error('insert boom')
    f.atmosphere.mock.insertStageBeforeLensFlare.mockImplementation((stage) => {
      if (stage === f.clouds.overlayStage) throw boom
    })
    await expect(install(f)).rejects.toBe(boom)

    expect(f.clouds.mock.destroy).toHaveBeenCalledTimes(1)
    expect(f.atmosphere.mock.destroy).toHaveBeenCalledTimes(1)
    // 先 stage 后纹理（spec §8.5）
    expect(callOrder(f.clouds.mock.destroy)).toBeLessThan(
      callOrder(f.atmosphere.mock.destroy)
    )
    expect(callOrder(f.atmosphere.mock.destroy)).toBeLessThan(
      callOrder(f.textures.lut.transmittance.destroy)
    )
    for (const texture of f.textures.all) {
      expect(texture.destroy).toHaveBeenCalledTimes(1)
    }
    // 场景还原
    expect(f.scene.highDynamicRange).toBe(true)
    expect(f.scene.globe.enableLighting).toBe(true)
  })

  it('资产加载失败时还原场景并抛错（不创建 stage、不加载月面/天气）', async () => {
    const f = setup()
    const boom = new Error('lut 404')
    f.deps.loadLuts.mockRejectedValue(boom)
    await expect(install(f)).rejects.toBe(boom)

    expect(f.deps.loadMoon).not.toHaveBeenCalled()
    expect(f.deps.loadWeather).not.toHaveBeenCalled()
    expect(f.deps.createAtmosphere).not.toHaveBeenCalled()
    expect(f.scene.highDynamicRange).toBe(true)
    expect(f.scene.requestRender).toHaveBeenCalled()
  })

  // ── 资源归属 / 销毁（spec §8.5） ──

  it('destroy 按 stage→纹理顺序释放 4 LUT + 4 weather + 月面纹理，且幂等', async () => {
    const f = setup()
    const handle = await install(f)
    handle.destroy()

    expect(f.order).toEqual([
      'clouds.destroy',
      'atmosphere.destroy',
      'texture:lut.transmittance',
      'texture:lut.scattering',
      'texture:lut.irradiance',
      'texture:lut.higherOrderScattering',
      'texture:weather.shape',
      'texture:weather.shapeDetail',
      'texture:weather.stbn',
      'texture:weather.localWeather',
      'texture:moon'
    ])

    handle.destroy() // 幂等：不重复释放
    expect(f.order).toHaveLength(11)
  })

  it('宿主 stage：insert/remove 转发到 atmosphere 并记账，destroy 时先移除再销毁大气', async () => {
    const f = setup()
    const handle = await install(f)
    const hostStage = { name: 'host' } as unknown as PostProcessStage
    const otherStage = { name: 'host2' } as unknown as PostProcessStage

    handle.insertStageBeforeLensFlare(hostStage, { protectedStage: false })
    expect(f.atmosphere.mock.insertStageBeforeLensFlare).toHaveBeenLastCalledWith(hostStage, {
      protectedStage: false
    })

    handle.removeInsertedStage(hostStage)
    expect(f.atmosphere.mock.removeInsertedStage).toHaveBeenCalledWith(hostStage)

    handle.insertStageBeforeLensFlare(otherStage)
    expect(f.atmosphere.mock.removeInsertedStage).not.toHaveBeenCalledWith(otherStage)

    handle.destroy()
    expect(f.atmosphere.mock.removeInsertedStage).toHaveBeenCalledWith(otherStage)
    const removeOrder =
      f.atmosphere.mock.removeInsertedStage.mock.invocationCallOrder[
        f.atmosphere.mock.removeInsertedStage.mock.invocationCallOrder.length - 1
      ]
    const atmosphereDestroyOrder = callOrder(f.atmosphere.mock.destroy)
    expect(removeOrder).toBeLessThan(atmosphereDestroyOrder)
  })

  it('destroy 后 handle 方法安全（no-op + warn），不触碰已销毁 stage', async () => {
    const f = setup()
    const handle = await install(f)
    handle.destroy()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const lateStage = { name: 'late' } as unknown as PostProcessStage
      expect(() => handle.insertStageBeforeLensFlare(lateStage)).not.toThrow()
      expect(() => handle.removeInsertedStage(lateStage)).not.toThrow()
      expect(() => handle.setQuality('ultra')).not.toThrow()
      expect(() => handle.destroy()).not.toThrow()

      expect(f.atmosphere.mock.insertStageBeforeLensFlare).toHaveBeenCalledTimes(1) // 仅 overlay
      expect(f.atmosphere.mock.removeInsertedStage).not.toHaveBeenCalled()
      expect(f.clouds.mock.setQuality).not.toHaveBeenCalled()
      expect(f.order).toHaveLength(11)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // ── 资产 URL 解析 ──

  it('assetsBaseUrl 与 assets 逐项覆盖透传给加载器', async () => {
    const f = setup()
    await install(f, {
      assetsBaseUrl: 'https://cdn.example.com/assets/',
      assets: { luts: 'https://cdn.example.com/luts/' }
    })

    expect(f.deps.loadLuts.mock.calls[0][1]).toBe('https://cdn.example.com/luts/')
    expect(f.deps.loadWeather.mock.calls[0][1]).toBe('https://cdn.example.com/assets/clouds/')
    expect(f.deps.loadMoon.mock.calls[0][1]).toEqual({
      surface: 'https://cdn.example.com/assets/moon/moon-surface.webp',
      displacement: 'https://cdn.example.com/assets/moon/moon-displacement.webp'
    })
  })

  // ── 场景接管开关（spec §7.6 与 install 的衔接） ──

  it('takeOverScene:false 不改宿主其余设置，但仍快照/还原 depthTestAgainstTerrain', async () => {
    const f = setup()
    // 关闭接管时 install 不会替宿主打开对数深度：宿主须已自行开启（shader 无条件反演）
    f.scene.logarithmicDepthBuffer = true
    const handle = await install(f, { takeOverScene: false })

    // 未接管：其余设置原样
    expect(f.scene.highDynamicRange).toBe(true)
    expect(f.scene.skyAtmosphere.show).toBe(true)
    expect(f.scene.sun.show).toBe(true)
    expect(f.scene.fog.enabled).toBe(true)
    expect(f.scene.backgroundColor).toEqual(ORIGINAL_BACKGROUND)
    // 底层无条件设置 depthTestAgainstTerrain（快照/还原仍生效）
    expect(f.scene.globe.depthTestAgainstTerrain).toBe(true)

    handle.destroy()
    expect(f.scene.globe.depthTestAgainstTerrain).toBe(false)
  })

  // ── 生命周期：并发 / 取消 / autoDestroy / HMR（spec §8.2 并发与幂等） ──

  it('并发 install 返回同一 Promise 与 handle，createAtmosphere 只调用一次且第二次 options 未生效', async () => {
    const f = setup()
    const target = asScene(f.scene)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = installWithDeps(target, {}, f.deps)
      const second = installWithDeps(target, { quality: 'ultra' }, f.deps)
      expect(second).toBe(first)

      const [h1, h2] = await Promise.all([first, second])
      expect(h1).toBe(h2)
      expect(f.deps.loadLuts).toHaveBeenCalledTimes(1)
      expect(f.deps.createAtmosphere).toHaveBeenCalledTimes(1)
      expect(f.clouds.mock.setQuality).not.toHaveBeenCalled()

      const text = warn.mock.calls.map((call) => String(call[0])).join('\n')
      expect(text).toMatch(/正在安装/)
      expect(text).toMatch(/options/)

      h1.destroy()
    } finally {
      warn.mockRestore()
    }
  })

  it('已安装后重复 install 返回既有 handle 并 warn「options 未生效」', async () => {
    const f = setup()
    const target = asScene(f.scene)
    const handle = await installWithDeps(target, {}, f.deps)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const again = await installWithDeps(target, { quality: 'low' }, f.deps)
      expect(again).toBe(handle)
      expect(f.deps.createAtmosphere).toHaveBeenCalledTimes(1)
      expect(f.clouds.mock.setQuality).not.toHaveBeenCalled()

      const text = warn.mock.calls.map((call) => String(call[0])).join('\n')
      expect(text).toMatch(/已安装/)
      expect(text).toMatch(/options 未生效/)
    } finally {
      warn.mockRestore()
      handle.destroy()
    }
  })

  it('安装中 target 被销毁 → reject InstallCancelledError，跳过 GL 销毁并恢复原 destroy', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)
    let resolveLuts!: (luts: AtmosphereLUTs) => void
    f.deps.loadLuts.mockImplementation(
      () =>
        new Promise<AtmosphereLUTs>((resolve) => {
          resolveLuts = resolve
        })
    )

    const promise = installWithDeps(target, {}, f.deps)
    // 包装在第一个 await 之前完成；pending 期间 isInstalled 为 false
    expect(viewer.destroy).not.toBe(original)
    expect(isInstalled(target)).toBe(false)

    // 安装中销毁：包装同步取消，再走原 destroy（scene 标记为已销毁）
    viewer.destroy()
    expect(f.order).toEqual(['viewer.destroy.original'])
    expect(viewer.destroy).toBe(original)

    resolveLuts(lutsOf(f.textures))
    await expect(promise).rejects.toBeInstanceOf(InstallCancelledError)
    await expect(promise).rejects.toThrow(/取消/)

    // 已销毁 target：GL 已随 Cesium 释放，stage/纹理的 destroy 一次都不该调用
    expect(f.deps.loadMoon).not.toHaveBeenCalled()
    expect(f.deps.loadWeather).not.toHaveBeenCalled()
    expect(f.deps.createAtmosphere).not.toHaveBeenCalled()
    expect(f.atmosphere.mock.destroy).not.toHaveBeenCalled()
    expect(f.clouds.mock.destroy).not.toHaveBeenCalled()
    for (const texture of f.textures.all) {
      expect(texture.destroy).not.toHaveBeenCalled()
    }
    expect(isInstalled(target)).toBe(false)

    // 无残留：对已销毁 target 再装 → 明确报错（不是 TypeError，也不产生任何资源）
    await expect(installWithDeps(target, {}, f.deps)).rejects.toThrow(/已销毁/)
    expect(f.deps.createAtmosphere).not.toHaveBeenCalled()
  })

  it('handle.destroy 清理注册表并恢复原 destroy；同一 target 可重新安装（全新实例）', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)

    const first = await installWithDeps(target, {}, f.deps)
    expect(isInstalled(target)).toBe(true)
    expect(viewer.destroy).not.toBe(original)

    first.destroy()

    expect(isInstalled(target)).toBe(false)
    expect(viewer.destroy).toBe(original)

    const second = await installWithDeps(target, {}, f.deps)
    expect(second).not.toBe(first)
    expect(f.deps.createAtmosphere).toHaveBeenCalledTimes(2)
    expect(viewer.destroy).not.toBe(original)

    second.destroy()
    expect(isInstalled(target)).toBe(false)
    expect(viewer.destroy).toBe(original)
  })

  it('isInstalled：pending=false，完成后=true（不同 target 形态命中同一 scene），destroy 后=false', async () => {
    const f = setup()
    const { viewer } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)
    let resolveLuts!: (luts: AtmosphereLUTs) => void
    f.deps.loadLuts.mockImplementation(
      () =>
        new Promise<AtmosphereLUTs>((resolve) => {
          resolveLuts = resolve
        })
    )

    const promise = installWithDeps(target, {}, f.deps)
    expect(isInstalled(target)).toBe(false)
    expect(isInstalled(asScene(f.scene))).toBe(false)

    resolveLuts(lutsOf(f.textures))
    const handle = await promise
    expect(isInstalled(target)).toBe(true)
    // 以 scene 为键：Viewer 与其 scene 指向同一次安装
    expect(isInstalled(asScene(f.scene))).toBe(true)

    handle.destroy()
    expect(isInstalled(target)).toBe(false)
    expect(isInstalled(asScene(f.scene))).toBe(false)
  })

  it('autoDestroy：先 handle.destroy 再原 destroy；handle.destroy 抛错时原 destroy 仍执行', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)
    const handle = await installWithDeps(target, {}, f.deps)

    const steps: string[] = []
    handle.destroy = vi.fn(() => {
      steps.push('handle.destroy')
      throw new Error('handle destroy boom')
    })

    expect(() => viewer.destroy()).toThrow(/handle destroy boom/)
    // 顺序：handle.destroy → 原 destroy；抛错不阻断 finally 里的恢复与原 destroy
    expect(steps).toEqual(['handle.destroy'])
    expect(f.order).toEqual(['viewer.destroy.original'])
    expect(viewer.destroy).toBe(original)
    // 即使 handle.destroy 抛错，包装也必须摘掉注册表条目
    expect(isInstalled(target)).toBe(false)
  })

  it('destroy 后恢复原 viewer.destroy；重新安装再销毁不叠加包装', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)

    const first = await installWithDeps(target, {}, f.deps)
    expect(viewer.destroy).not.toBe(original)
    first.destroy()
    expect(viewer.destroy).toBe(original)

    const second = await installWithDeps(target, {}, f.deps)
    expect(second).not.toBe(first)
    expect(viewer.destroy).not.toBe(original)

    viewer.destroy()
    expect(viewer.destroy).toBe(original)
    expect(isInstalled(target)).toBe(false)
    // 包装只跑一次原 destroy，不因重复安装而叠加
    expect(f.order.filter((entry) => entry === 'viewer.destroy.original')).toHaveLength(1)
  })

  it('安装失败（自检）也恢复 viewer.destroy 并清空 pending，可立即重试', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)
    f.deps.runCompat.mockReturnValue({
      ok: false,
      warnings: [],
      errors: ['缺少 Texture3D 构造器']
    })

    await expect(installWithDeps(target, {}, f.deps)).rejects.toThrow(/缺少 Texture3D 构造器/)
    expect(viewer.destroy).toBe(original)
    expect(isInstalled(target)).toBe(false)

    // pending 已清理：同 scene 立即重试不会被去重逻辑拦成已失败的 Promise
    f.deps.runCompat.mockReturnValue({ ok: true, warnings: [], errors: [] })
    const handle = await installWithDeps(target, {}, f.deps)
    expect(f.deps.createAtmosphere).toHaveBeenCalledTimes(1)
    handle.destroy()
  })

  it('autoDestroy:false 不包装 viewer.destroy，handle.destroy 与注册表清理照常', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)

    const handle = await installWithDeps(target, { autoDestroy: false }, f.deps)
    expect(viewer.destroy).toBe(original)
    expect(isInstalled(target)).toBe(true)

    handle.destroy()
    expect(isInstalled(target)).toBe(false)
    expect(viewer.destroy).toBe(original)
  })

  it('disposeAllForHmr 销毁全部已安装 handle、恢复包装并清空注册表（可重装）', async () => {
    const a = setup()
    const b = setup()
    const va = makeViewer(a.scene, a.order)
    const vb = makeViewer(b.scene, b.order)
    const targetA = asTarget(va.viewer)
    const targetB = asTarget(vb.viewer)

    await installWithDeps(targetA, {}, a.deps)
    await installWithDeps(targetB, {}, b.deps)
    expect(isInstalled(targetA)).toBe(true)
    expect(isInstalled(targetB)).toBe(true)
    expect(va.viewer.destroy).not.toBe(va.original)

    disposeAllForHmr()

    expect(isInstalled(targetA)).toBe(false)
    expect(isInstalled(targetB)).toBe(false)
    expect(va.viewer.destroy).toBe(va.original)
    expect(vb.viewer.destroy).toBe(vb.original)
    expect(a.order).toContain('clouds.destroy')
    expect(a.order).toContain('atmosphere.destroy')
    expect(b.order).toContain('atmosphere.destroy')

    // 注册表已清空：可重新安装
    const again = await installWithDeps(targetA, {}, a.deps)
    expect(a.deps.createAtmosphere).toHaveBeenCalledTimes(2)
    again.destroy()
  })

  it('disposeAllForHmr 取消进行中的安装：未销毁 target 走正常回滚（释放已载纹理、还原场景）', async () => {
    const f = setup()
    const { viewer, original } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)
    let resolveLuts!: (luts: AtmosphereLUTs) => void
    f.deps.loadLuts.mockImplementation(
      () =>
        new Promise<AtmosphereLUTs>((resolve) => {
          resolveLuts = resolve
        })
    )

    const promise = installWithDeps(target, {}, f.deps)
    expect(viewer.destroy).not.toBe(original)

    disposeAllForHmr()

    // 包装立即恢复、注册表清空（pending 已置取消，promise 尚未 settle）
    expect(viewer.destroy).toBe(original)
    expect(isInstalled(target)).toBe(false)

    resolveLuts(lutsOf(f.textures))
    await expect(promise).rejects.toBeInstanceOf(InstallCancelledError)

    // target 未销毁：已加载的 LUT 走正常回滚（销毁一次 + 场景还原）
    for (const texture of Object.values(f.textures.lut)) {
      expect(texture.destroy).toHaveBeenCalledTimes(1)
    }
    expect(f.scene.highDynamicRange).toBe(true)
    expect(f.deps.createAtmosphere).not.toHaveBeenCalled()
  })

  it('HMR 取消后立即重装：旧安装回滚不推翻新安装的接管（等旧 settle + 代次守卫）', async () => {
    const f = setup()
    const scene = f.scene
    const { viewer, original } = makeViewer(scene, f.order)
    const target = asTarget(viewer)

    // #1 卡在 loadLuts
    let resolveLuts1!: (luts: AtmosphereLUTs) => void
    f.deps.loadLuts.mockImplementationOnce(
      () =>
        new Promise<AtmosphereLUTs>((resolve) => {
          resolveLuts1 = resolve
        })
    )

    const first = installWithDeps(target, {}, f.deps)
    expect(scene.highDynamicRange).toBe(false) // #1 已接管（快照 S0）
    expect(viewer.destroy).not.toBe(original)

    disposeAllForHmr() // 取消 #1（pending 保留到 settle），恢复包装
    expect(viewer.destroy).toBe(original)

    // #2 开始：必须等 #1 回滚完，不能捕获「已接管的 S1」
    const second = installWithDeps(target, {}, f.deps)
    expect(scene.highDynamicRange).toBe(false) // #2 尚未接管

    // #1 解除卡点 → 取消回滚（还原 S0）→ #2 才捕获 S0 并重新接管
    resolveLuts1(lutsOf(f.textures))
    await expect(first).rejects.toBeInstanceOf(InstallCancelledError)

    const handle2 = await second
    expect(scene.highDynamicRange).toBe(false)
    expect(scene.logarithmicDepthBuffer).toBe(true)
    expect(scene.skyAtmosphere.show).toBe(false)
    expect(scene.globe.enableLighting).toBe(false)

    // #2 destroy → 场景回到安装前的 S0（若旧回滚推翻了 #2，这里会停在接管态）
    handle2.destroy()
    expect(scene.highDynamicRange).toBe(true)
    expect(scene.logarithmicDepthBuffer).toBe(false)
    expect(scene.skyAtmosphere.show).toBe(true)
    expect(scene.globe.enableLighting).toBe(true)
    expect(f.deps.loadLuts).toHaveBeenCalledTimes(2)
  })

  it('target 已销毁（viewer.scene 返回 undefined）：isInstalled=false，install 抛明确错误而非 TypeError', async () => {
    const f = setup()
    const { viewer } = makeViewer(f.scene, f.order)
    const target = asTarget(viewer)
    const handle = await installWithDeps(target, {}, f.deps)
    expect(isInstalled(target)).toBe(true)

    viewer.destroy() // 已安装路径：联动 handle.destroy + 场景销毁

    expect(isInstalled(target)).toBe(false)
    const error: unknown = await installWithDeps(target, {}, f.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('Error')
    expect((error as Error).message).toMatch(/已销毁/)
    expect((error as Error).message).not.toMatch(/Cannot read properties/)
    // 已被 viewer.destroy 联动销毁的 handle 仍幂等
    expect(() => handle.destroy()).not.toThrow()
  })

  it('target 已销毁（viewer.scene getter 抛 TypeError）：同样降级为 false / 明确错误', async () => {
    const f = setup()
    const { viewer } = makeViewer(f.scene, f.order, { throwSceneGetterAfterDestroy: true })
    const target = asTarget(viewer)
    await installWithDeps(target, {}, f.deps)

    viewer.destroy()

    expect(isInstalled(target)).toBe(false)
    const error: unknown = await installWithDeps(target, {}, f.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('Error')
    expect((error as Error).message).toMatch(/已销毁/)
  })

  // ── 3D 模式守卫（spec §7.6 / Task 10A） ──

  it('morphStart 停用全部自有 stage 与云；morphComplete 回 SCENE3D 按快照恢复', async () => {
    const f = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // depthTemporal 透传模式（temporalEma=false）时 enabled 恒 false——恢复不得强制改 true，
    // 否则改变 3D 渲染行为。
    f.atmosphere.mock.depthTemporalStage.enabled = false
    const handle = await install(f)

    // 注册在安装末尾：两个 morph 事件各一个监听
    expect(f.scene.morphStart.addEventListener).toHaveBeenCalledTimes(1)
    expect(f.scene.morphComplete.addEventListener).toHaveBeenCalledTimes(1)

    // 进入 morph：全部自有 stage 停用 + 云 setEnabled(false) + 警告一次
    f.scene.mode = 1 // SceneMode.MORPHING
    fire(f.scene.morphStart)
    expect(f.atmosphere.mock.depthTemporalStage.enabled).toBe(false)
    expect(f.atmosphere.mock.atmosphereStage.enabled).toBe(false)
    expect(f.atmosphere.mock.lensFlareStage.enabled).toBe(false)
    expect(f.atmosphere.mock.tonemapStage.enabled).toBe(false)
    expect(f.clouds.mock.setEnabled).toHaveBeenLastCalledWith(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/非 3D/)

    // 回到 3D：恢复快照（depthTemporal 维持 false）；云重新启用
    f.scene.mode = 3 // SceneMode.SCENE3D
    fire(f.scene.morphComplete)
    expect(f.atmosphere.mock.atmosphereStage.enabled).toBe(true)
    expect(f.atmosphere.mock.lensFlareStage.enabled).toBe(true)
    expect(f.atmosphere.mock.tonemapStage.enabled).toBe(true)
    expect(f.atmosphere.mock.depthTemporalStage.enabled).toBe(false)
    expect(f.clouds.mock.setEnabled).toHaveBeenLastCalledWith(true)

    // 第二个 morph 周期：无需再警告（per install 只一次）
    f.scene.mode = 1
    fire(f.scene.morphStart)
    expect(warn).toHaveBeenCalledTimes(1)

    handle.destroy()
    warn.mockRestore()
  })

  it('morphComplete 到 2D/Columbus 保持停用，之后回 3D 再恢复', async () => {
    const f = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await install(f)

    f.scene.mode = 1
    fire(f.scene.morphStart)
    const disableCalls = f.clouds.mock.setEnabled.mock.calls.length

    // 落到 2D：保持停用，不重新启用
    f.scene.mode = 2 // SceneMode.SCENE2D
    fire(f.scene.morphComplete)
    expect(f.atmosphere.mock.atmosphereStage.enabled).toBe(false)
    expect(f.atmosphere.mock.tonemapStage.enabled).toBe(false)
    expect(f.clouds.mock.setEnabled).toHaveBeenLastCalledWith(false)
    expect(f.clouds.mock.setEnabled.mock.calls.length).toBe(disableCalls) // 无新调用

    // 再回 3D：恢复
    f.scene.mode = 3
    fire(f.scene.morphComplete)
    expect(f.atmosphere.mock.atmosphereStage.enabled).toBe(true)
    expect(f.clouds.mock.setEnabled).toHaveBeenLastCalledWith(true)

    handle.destroy()
    warn.mockRestore()
  })

  it('无云（clouds:false）时 morphStart 不抛错且不触云开关', async () => {
    const f = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = await install(f, { clouds: false })
    expect(f.clouds.mock.setEnabled).not.toHaveBeenCalled()

    f.scene.mode = 1
    expect(() => fire(f.scene.morphStart)).not.toThrow()
    expect(f.atmosphere.mock.atmosphereStage.enabled).toBe(false)
    expect(f.clouds.mock.setEnabled).not.toHaveBeenCalled()

    f.scene.mode = 3
    fire(f.scene.morphComplete)
    expect(f.atmosphere.mock.atmosphereStage.enabled).toBe(true)

    handle.destroy()
    warn.mockRestore()
  })

  it('destroy 摘除 morph 监听（计数归零），之后事件不再改 stage', async () => {
    const f = setup()
    const handle = await install(f)
    expect(f.scene.morphStart.listeners.size).toBe(1)
    expect(f.scene.morphComplete.listeners.size).toBe(1)

    handle.destroy()
    expect(f.scene.morphStart.listeners.size).toBe(0)
    expect(f.scene.morphComplete.listeners.size).toBe(0)
    expect(f.scene.morphStart.removeEventListener).toHaveBeenCalledTimes(1)
    expect(f.scene.morphComplete.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('scene 已销毁时 destroy 跳过监听摘除（不访问已释放事件）', async () => {
    const f = setup()
    const handle = await install(f)
    // 模拟场景先于 handle.destroy 被外部销毁（Viewer.destroy 联动时 scene 仍存活，
    // 走正常摘除路径；此用例覆盖「已销毁」分支）。
    f.scene.destroyed = true
    expect(() => handle.destroy()).not.toThrow()
    expect(f.scene.morphStart.removeEventListener).not.toHaveBeenCalled()
    expect(f.scene.morphComplete.removeEventListener).not.toHaveBeenCalled()
  })
})
