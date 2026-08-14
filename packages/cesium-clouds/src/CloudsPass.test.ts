// CloudsPass.test.ts
//
// M2 T2：createCloudsPass 单测。参照 VolumetricPrimitive.test.ts 的 vi.mock('cesium') 范式
// + AtmosphereStage.test mock scene/camera 模式。
//
// node 无 WebGL：验装配/接口/生命周期——primitive add 到 scene.primitives + MRT 3 texture 创建
// + dummy texture 创建 + uniformMap 全 business uniform 注入（关键 uniform 闭包取值正确）
// + globeDepthTexture 闭包（M6 hook）+ getColorBridge（att0 bridge）+ destroy 幂等。
//
// 关键断言：
//   - uniformMap 含 clouds.frag + parameters.glsl 全部 business uniform（不含 ATMOSPHERE/densityProfile
//     ——已 const 注入；不含 viewMatrix/cameraNear/cameraFar——已 #define 重定向）
//   - dummy texture 决策（shadowBuffer=bridge/depthBuffer/localWeather/turbulence/stbn）
//   - shape/shapeDetail 真 weather 注入；atmosphere LUT 真 luts 注入
//   - 每帧闭包（sun/altitude/cameraHeight/resolution）读 state/scene

import { describe, it, expect, vi } from 'vitest'

// vi.mock('cesium')：仅 mock WebGL-touching 类（Texture/Texture3D/Sampler——node 无 WebGL）。
// 用 importOriginal 保留真实 math 类（Cartesian2/3/4/Matrix4 等）——core altitudeCorrection.ts 经
// index 链 import Cartesian3，需真实实现（否则 magnitude 等方法缺失）。
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const mkTexCtor = () =>
    function (this: any, opts: any) {
      this.width = opts.width
      this.height = opts.height
      this.pixelFormat = opts.pixelFormat
      this.pixelDatatype = opts.pixelDatatype
      this.source = opts.source
      this.sampler = opts.sampler
      this._texture = { id: Math.random() }
      this._target = 0x0de1 // GL_TEXTURE_2D
      this.destroy = vi.fn()
    }
  return {
    ...actual,
    Texture: mkTexCtor(),
    Texture3D: mkTexCtor(),
    Sampler: function (this: any, opts: any) {
      Object.assign(this, opts)
    }
  }
})

// vi.mock('@cesium-geospatial/core')：CloudsPass import createVolumetricPrimitive/createArrayTextureBridge/
// resolvePostHdrDatatype；但 CloudsMaterial（经 glslIndex）import 真实 GLSL 资产（core.glslIndex.core）。
// 故用 importOriginal 部分mock：保留真实 GLSL/ATMOSPHERE_DEFAULT_GLSL 导出，仅 mock 3 个运行时函数。
vi.mock('@cesium-geospatial/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createVolumetricPrimitive: vi.fn((opts: any) => ({
      update: vi.fn(),
      isDestroyed: () => false,
      destroy: vi.fn()
    })),
    createArrayTextureBridge: vi.fn(() => ({ _texture: { id: 'arr' }, _target: 0x871a })),
    resolvePostHdrDatatype: vi.fn(() => 36193) // HALF_FLOAT
  }
})

// mock scene/context：drawingBufferWidth/Height + camera.positionWC + primitives.add/remove + _view.globeDepth
function createMockScene(): any {
  return {
    context: {
      drawingBufferWidth: 1920,
      drawingBufferHeight: 1080,
      // HDR caps（resolveCloudsHdrDatatype 读 → HALF_FLOAT 优先）
      halfFloatingPointTexture: true,
      colorBufferHalfFloat: true,
      floatingPointTexture: true,
      colorBufferFloat: false
    },
    camera: {
      positionWC: new Cartesian3(6378137, 0, 0), // 地表相机（ECEF 米）
      // positionCartographic.height = 测地高度（米）——clouds.frag 云层上下判定用（cameraHeight 闭包）
      positionCartographic: { height: 500.0 }
    },
    primitives: {
      add: vi.fn(),
      remove: vi.fn(() => true)
    },
    _view: {
      globeDepth: {
        depthStencilTexture: { _texture: { id: 'gdepth' }, _target: 0x84f4 }
      }
    }
  }
}

function createMockLuts(): any {
  return {
    transmittance: { id: 'trans' },
    scattering: { id: 'scat' },
    irradiance: { id: 'irr' },
    higherOrderScattering: { id: 'ho' }
  }
}

function createMockWeather(): any {
  return {
    shape: { id: 'shape', _texture: { id: 'shape' }, _target: 0x806f },
    shapeDetail: { id: 'detail', _texture: { id: 'detail' }, _target: 0x806f }
  }
}

import { createCloudsPass, type CloudsFrameState } from './CloudsPass'
import { createVolumetricPrimitive } from '@cesium-geospatial/core'
import { Cartesian3 } from 'cesium'

describe('createCloudsPass', () => {
  const state: CloudsFrameState = {
    sunDirection: { x: 1, y: 0, z: 0 } as any,
    altitudeCorrection: { x: 0, y: 0, z: 0 } as any
  }

  it('装配：primitive add 到 scene.primitives + createVolumetricPrimitive 调用', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const pass = createCloudsPass(
      scene,
      createMockLuts(),
      createMockWeather(),
      state
    )
    expect(scene.primitives.add).toHaveBeenCalledTimes(1)
    expect(scene.primitives.add).toHaveBeenCalledWith(pass.primitive)
    expect(createVolumetricPrimitive).toHaveBeenCalledTimes(1)
    pass.destroy()
  })

  it('MRT：3 texture（color/depthVelocity/shadowLength）传入 createVolumetricPrimitive.mrtColorTextures', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const pass = createCloudsPass(
      scene,
      createMockLuts(),
      createMockWeather(),
      state
    )
    const callOpts = (createVolumetricPrimitive as any).mock.calls[0][0]
    expect(callOpts.mrtColorTextures).toHaveLength(3)
    pass.destroy()
  })

  it('uniformMap 注入 atmosphere LUT（transmittance/scattering/irradiance/single_mie=scatter/higher_order）', () => {
    vi.clearAllMocks()
    const luts = createMockLuts()
    const pass = createCloudsPass(scene2(), luts, createMockWeather(), state)
    const callOpts = (createVolumetricPrimitive as any).mock.calls[0][0]
    const um = callOpts.uniformMap
    expect(um.transmittance_texture()).toBe(luts.transmittance)
    expect(um.scattering_texture()).toBe(luts.scattering)
    expect(um.irradiance_texture()).toBe(luts.irradiance)
    // single_mie_scattering_texture = scattering（COMBINED 模式占位）
    expect(um.single_mie_scattering_texture()).toBe(luts.scattering)
    expect(um.higher_order_scattering_texture()).toBe(luts.higherOrderScattering)
    pass.destroy()
  })

  it('uniformMap 注入 weather shape/shapeDetail（真 weather 对象）', () => {
    vi.clearAllMocks()
    const weather = createMockWeather()
    const pass = createCloudsPass(scene2(), createMockLuts(), weather, state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.shapeTexture()).toBe(weather.shape)
    expect(um.shapeDetailTexture()).toBe(weather.shapeDetail)
    pass.destroy()
  })

  it('uniformMap dummy texture（localWeather/turbulence/depthBuffer/stbn 非 weather/luts）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    // localWeatherTexture 是 dummy（M2 PNG decode 未做），不等于 weather 对象
    const lw = um.localWeatherTexture()
    expect(lw).toBeDefined()
    expect(lw).not.toBe(createMockWeather().shape)
    // turbulenceTexture dummy
    expect(um.turbulenceTexture()).toBeDefined()
    // depthBuffer dummy（M6 globe depth 接通前）
    expect(um.depthBuffer()).toBeDefined()
    // stbnTexture dummy（Texture3D 1×1×1）
    expect(um.stbnTexture()).toBeDefined()
    pass.destroy()
  })

  it('uniformMap shadowBuffer = bridge（sampler2DArray 1×1×4 全 0，M3 BSM dummy）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const sb = um.shadowBuffer()
    // bridge 形状 {_texture, _target=0x871a(TEXTURE_2D_ARRAY)}
    expect(sb).toEqual({ _texture: expect.any(Object), _target: 0x871a })
    pass.destroy()
  })

  it('uniformMap 不含 ATMOSPHERE / densityProfile / viewMatrix / cameraNear / cameraFar（已 const/#define 注入）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.ATMOSPHERE).toBeUndefined()
    expect(um.densityProfile).toBeUndefined()
    expect(um.viewMatrix).toBeUndefined()
    expect(um.cameraNear).toBeUndefined()
    expect(um.cameraFar).toBeUndefined()
    pass.destroy()
  })

  it('每帧闭包：sunDirection/altitudeCorrection 读 state（更新 state 即反映）', () => {
    vi.clearAllMocks()
    const st: CloudsFrameState = {
      sunDirection: { x: 1, y: 0, z: 0 } as any,
      altitudeCorrection: { x: 10, y: 20, z: 30 } as any
    }
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), st)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.sunDirection()).toBe(st.sunDirection)
    expect(um.altitudeCorrection()).toBe(st.altitudeCorrection)
    // 更新 state → 闭包自动反映（同引用）
    st.sunDirection = { x: 0, y: 1, z: 0 } as any
    expect(um.sunDirection()).toBe(st.sunDirection)
    pass.destroy()
  })

  it('每帧闭包：cameraHeight = 测地高度（camera.positionCartographic.height，云层判定用）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const h = um.cameraHeight() as number
    // mock scene 相机 positionCartographic.height = 500（米，低空飞行）——非地心距 6.378e6
    expect(h).toBe(500.0)
    pass.destroy()
  })

  it('globeDepthTexture 闭包：读 scene._view.globeDepth.depthStencilTexture（M6 hook）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const pass = createCloudsPass(scene, createMockLuts(), createMockWeather(), state)
    const callOpts = (createVolumetricPrimitive as any).mock.calls[0][0]
    expect(typeof callOpts.globeDepthTexture).toBe('function')
    const tex = callOpts.globeDepthTexture()
    expect(tex).toBe(scene._view.globeDepth.depthStencilTexture)
    pass.destroy()
  })

  it('getColorBridge：返 att0 colorTex 的 {_texture, _target}（注入 overlay uniform）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const bridge = pass.getColorBridge()
    expect(bridge).toEqual({ _texture: expect.any(Object), _target: 0x0de1 })
    pass.destroy()
  })

  it('bottomRadius 默认 6360000（米——clouds.frag L369 height=length(position)-bottomRadius 为 meter 单位）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    // 非 6360（km）——clouds bottomRadius uniform 是 three-atmosphere TS 侧米值，
    // 与 Bruneton GLSL const ATMOSPHERE.bottom_radius（km）单位不同
    expect(um.bottomRadius()).toBe(6360000)
    // 云层高度也是米（minHeight=750 低积云）
    expect(um.minHeight()).toBe(750)
    pass.destroy()
  })

  it('destroy：摘 primitive + primitive.destroy 调用 + 幂等', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const pass = createCloudsPass(scene, createMockLuts(), createMockWeather(), state)
    const primDestroy = pass.primitive.destroy as unknown as () => void
    pass.destroy()
    expect(scene.primitives.remove).toHaveBeenCalledWith(pass.primitive)
    expect(primDestroy).toHaveBeenCalled()
    // 幂等：二次 destroy 不抛 + remove 不重复
    expect(() => pass.destroy()).not.toThrow()
    expect(scene.primitives.remove).toHaveBeenCalledTimes(1)
  })

  it('clouds business uniform 全覆盖（clouds.frag + parameters.glsl 声明，减 ATMOSPHERE/densityProfile/viewMatrix/cameraNear/cameraFar）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    // 关键 business uniform 抽查（全列表见 clouds.frag:19-99 + parameters.glsl）
    const expected = [
      'transmittance_texture', 'scattering_texture', 'irradiance_texture',
      'single_mie_scattering_texture', 'higher_order_scattering_texture',
      'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE', 'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE',
      'depthBuffer', 'reprojectionMatrix', 'viewReprojectionMatrix', 'temporalJitter',
      'targetUvScale', 'mipLevelScale', 'skyLightScale', 'groundBounceScale',
      'powderScale', 'powderExponent', 'maxIterationCount', 'minStepSize',
      'maxStepSize', 'maxRayDistance', 'perspectiveStepScale',
      'maxIterationCountToSun', 'maxIterationCountToGround', 'minSecondaryStepSize',
      'secondaryStepScale', 'shadowBuffer', 'shadowTexelSize', 'shadowIntervals',
      'shadowMatrices', 'shadowFar', 'maxShadowFilterRadius',
      'resolution', 'frame', 'stbnTexture', 'bottomRadius', 'worldToECEFMatrix',
      'ecefToWorldMatrix', 'altitudeCorrection', 'sunDirection',
      'scatteringCoefficient', 'absorptionCoefficient', 'minDensity',
      'minExtinction', 'minTransmittance', 'localWeatherTexture',
      'localWeatherRepeat', 'localWeatherOffset', 'coverage', 'shapeTexture',
      'shapeRepeat', 'shapeOffset', 'shapeDetailTexture', 'shapeDetailRepeat',
      'shapeDetailOffset', 'turbulenceTexture', 'turbulenceRepeat',
      'turbulenceDisplacement', 'minLayerHeights', 'maxLayerHeights',
      'minIntervalHeights', 'maxIntervalHeights', 'densityScales', 'shapeAmounts',
      'shapeDetailAmounts', 'weatherExponents', 'shapeAlteringBiases',
      'coverageFilterWidths', 'minHeight', 'maxHeight', 'shadowTopHeight',
      'shadowBottomHeight', 'shadowLayerMask', 'cameraHeight'
    ]
    for (const name of expected) {
      expect(um[name], `uniform ${name} 应注入`).toBeDefined()
    }
    pass.destroy()
  })
})

// scene 工厂（多个 it 共用；每 it clearAllMocks 后新场景避免交叉污染）
function scene2(): any {
  return createMockScene()
}
