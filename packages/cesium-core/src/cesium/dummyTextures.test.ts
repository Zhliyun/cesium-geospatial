// dummy 纹理归属与销毁的时间线测试（产品化设计 2026-10-27 §8.5 资源归属）。
//
// 为什么「dummyTextures.test.ts」里测的是 AtmosphereStage：vi.mock 是文件级的，只有独占文件才能
// 用带 spy 的假工厂替换真实构造。Node 无 WebGL，真实 new Texture/Texture3D 会因
// maximumTextureSize=0 爆掉（同 AtmosphereStage.insert.test.ts:31 注释）——**绝不 vi.mock('cesium')**，
// 否则整条 Cesium 运行时都被替换，测的就不是真实链了。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Cartesian3, Ellipsoid } from 'cesium'

// vi.hoisted：vi.mock 工厂被提升到文件顶部，工厂内引用的变量须在 hoisted 块创建。
const factories = vi.hoisted(() => {
  const make = (kind: string) =>
    vi.fn(() => ({ texture: { __dummy: kind }, destroy: vi.fn() }))
  return { clouds: make('clouds'), ground: make('ground'), moon: make('moon') }
})

vi.mock('./dummyTextures', () => ({
  createCloudsShadowDummy: factories.clouds,
  createGroundShadowDummy: factories.ground,
  createMoonSurfaceDummy: factories.moon
}))

import { createAtmosphereStage, type AtmosphereStageHandle } from './AtmosphereStage'

type FakeHandle = { texture: unknown; destroy: ReturnType<typeof vi.fn> }

function makeScene() {
  return {
    context: {
      halfFloatingPointTexture: true,
      colorBufferHalfFloat: true,
      floatingPointTexture: false,
      colorBufferFloat: false
    },
    globe: { depthTestAgainstTerrain: false, ellipsoid: Ellipsoid.WGS84 },
    camera: { positionWC: new Cartesian3(6378137, 0, 0) },
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    preRender: { addEventListener: () => () => {} },
    postRender: { addEventListener: () => () => {} },
    postProcessStages: {
      add: vi.fn(),
      remove: vi.fn(() => true),
      contains: vi.fn(() => false)
    }
  } as unknown as import('cesium').Scene
}

const stubLuts = {
  transmittance: {} as never,
  scattering: {} as never,
  irradiance: {} as never,
  higherOrderScattering: {} as never
}

/** 三个 dummy 全部走惰性路径：两个桥存在（undefined 数据 → 落 dummy），月面纹理未传。 */
function createWithAllDummies(): AtmosphereStageHandle {
  return createAtmosphereStage(makeScene(), stubLuts, {
    cloudsShadowLengthBridge: () => undefined,
    cloudsShadowBridge: () => undefined
  })
}

/** 真机里 uniform 闭包每帧被 Cesium 求值；测试手动触发同一入口。 */
function triggerDummyUniforms(handle: AtmosphereStageHandle): void {
  const u = handle.atmosphereStage.uniforms as Record<string, () => unknown>
  u.u_cloudsShadowLength()
  u.u_shadowBuffer()
  u.u_moonSurface()
}

/** 取第 n 次工厂调用返回的句柄（mock.results 保留返回值）。 */
function handleAt(fn: (typeof factories)['clouds'], n: number): FakeHandle {
  return fn.mock.results[n].value as FakeHandle
}

describe('AtmosphereStage 惰性 dummy 纹理归属（§8.5）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('惰性：uniform 闭包未求值前三个工厂都不调用', () => {
    const handle = createWithAllDummies()
    expect(factories.clouds).not.toHaveBeenCalled()
    expect(factories.ground).not.toHaveBeenCalled()
    expect(factories.moon).not.toHaveBeenCalled()
    handle.destroy()
  })

  it('destroy() 时三个 dummy 各销毁一次，且同一句柄重复求值不重建', () => {
    const handle = createWithAllDummies()
    triggerDummyUniforms(handle)
    triggerDummyUniforms(handle) // 每帧求值：缓存命中，不重复构造
    expect(factories.clouds).toHaveBeenCalledTimes(1)
    expect(factories.ground).toHaveBeenCalledTimes(1)
    expect(factories.moon).toHaveBeenCalledTimes(1)

    handle.destroy()
    expect(handleAt(factories.clouds, 0).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.ground, 0).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.moon, 0).destroy).toHaveBeenCalledTimes(1)

    // destroy 幂等：再调一次不重复销毁
    handle.destroy()
    expect(handleAt(factories.clouds, 0).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.ground, 0).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.moon, 0).destroy).toHaveBeenCalledTimes(1)
  })

  it('setMode 重建：旧 dummy 先销毁，新闭包再次惰性构造', () => {
    const handle = createWithAllDummies()
    triggerDummyUniforms(handle)
    const oldClouds = handleAt(factories.clouds, 0)
    const oldGround = handleAt(factories.ground, 0)
    const oldMoon = handleAt(factories.moon, 0)

    handle.setMode({})
    expect(oldClouds.destroy).toHaveBeenCalledTimes(1) // 旧句柄在重建时释放
    expect(oldGround.destroy).toHaveBeenCalledTimes(1)
    expect(oldMoon.destroy).toHaveBeenCalledTimes(1)
    // 新 stage 的闭包尚未求值 → 不提前构造
    expect(factories.clouds).toHaveBeenCalledTimes(1)

    triggerDummyUniforms(handle) // 求值的是新闭包
    expect(factories.clouds).toHaveBeenCalledTimes(2)

    handle.destroy() // 只销毁当前句柄（旧的已在 setMode 时销毁）
    expect(handleAt(factories.clouds, 1).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.ground, 1).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.moon, 1).destroy).toHaveBeenCalledTimes(1)
    expect(oldClouds.destroy).toHaveBeenCalledTimes(1)
    expect(oldGround.destroy).toHaveBeenCalledTimes(1)
    expect(oldMoon.destroy).toHaveBeenCalledTimes(1)
  })

  it('未传 cloudsShadowLengthBridge 时不创建云影 shadowLength dummy', () => {
    const handle = createAtmosphereStage(makeScene(), stubLuts, {
      cloudsShadowBridge: () => undefined
    })
    const u = handle.atmosphereStage.uniforms as Record<string, () => unknown>
    expect(u.u_cloudsShadowLength).toBeUndefined() // 桥未传 → uniform 键不存在
    u.u_shadowBuffer()
    u.u_moonSurface()
    expect(factories.clouds).not.toHaveBeenCalled()
    expect(factories.ground).toHaveBeenCalledTimes(1)
    expect(factories.moon).toHaveBeenCalledTimes(1)
    handle.destroy()
    expect(handleAt(factories.ground, 0).destroy).toHaveBeenCalledTimes(1)
    expect(handleAt(factories.moon, 0).destroy).toHaveBeenCalledTimes(1)
  })

  it('传了 moonSurfaceTexture 时不创建月面白 dummy', () => {
    const handle = createAtmosphereStage(makeScene(), stubLuts, {
      cloudsShadowLengthBridge: () => undefined,
      moonSurfaceTexture: { fake: 'texture' } as never
    })
    const u = handle.atmosphereStage.uniforms as Record<string, () => unknown>
    u.u_cloudsShadowLength()
    expect(factories.moon).not.toHaveBeenCalled() // 走真实纹理路径
    expect(factories.clouds).toHaveBeenCalledTimes(1)
    handle.destroy()
    expect(handleAt(factories.clouds, 0).destroy).toHaveBeenCalledTimes(1)
  })
})
