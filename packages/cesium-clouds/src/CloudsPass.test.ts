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
    shapeDetail: { id: 'detail', _texture: { id: 'detail' }, _target: 0x806f },
    stbn: { id: 'stbn', _texture: { id: 'stbn' }, _target: 0x806f },
    localWeather: { id: 'localWeather' }
  }
}

import { createCloudsPass, type CloudsFrameState } from './CloudsPass'
import { createVolumetricPrimitive } from '@cesium-geospatial/core'
import { Cartesian2, Cartesian3, Matrix4 } from 'cesium'

describe('createCloudsPass', () => {
  const state: CloudsFrameState = {
    sunDirection: { x: 1, y: 0, z: 0 } as any,
    moonDirection: { x: 1, y: 0, z: 0 } as any,
    moonIlluminatedFraction: 0.5,
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

  it('MRT：lightShafts 显式关时 2 texture（drawBuffers 数须=shader out 数；M5 默认开为 3——见 M5 T2 用例）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const pass = createCloudsPass(
      scene,
      createMockLuts(),
      createMockWeather(),
      state,
      { lightShafts: false }
    )
    const callOpts = (createVolumetricPrimitive as any).mock.calls[0][0]
    // lightShafts=false → shader 只 location 0/1 两个 out（SHADOW_LENGTH 不 define）→ FBO 必须
    // 2 attachment（M2 坑：attachment 数 ≠ out 数触发 GL_INVALID_OPERATION）。
    expect(callOpts.mrtColorTextures).toHaveLength(2)
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

  it('uniformMap 注入 weather shape/shapeDetail/stbn/localWeather（真 weather 对象）', () => {
    vi.clearAllMocks()
    const weather = createMockWeather()
    const pass = createCloudsPass(scene2(), createMockLuts(), weather, state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.shapeTexture()).toBe(weather.shape)
    expect(um.shapeDetailTexture()).toBe(weather.shapeDetail)
    // stbnTexture = weather.stbn 真 3D 蓝噪声资产（非 dummy——白噪声 dummy 显形全屏雪花纹）
    expect(um.stbnTexture()).toBe(weather.stbn)
    // localWeatherTexture = weather.localWeather 真 2D 资产（满 coverage dummy 显形连续云墙+地平线白线）
    expect(um.localWeatherTexture()).toBe(weather.localWeather)
    pass.destroy()
  })

  it('uniformMap dummy texture（turbulence/depthBuffer 非 weather/luts）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    // turbulenceTexture dummy
    expect(um.turbulenceTexture()).toBeDefined()
    // depthBuffer fallback dummy（scene2 无 _view.globeDepth → 远截断降级）
    expect(um.depthBuffer()).toBeDefined()
    pass.destroy()
  })

  it('depthBuffer 优先 globeDepth.depthStencilTexture（M6 提前接通：云被地形截断/遮挡）', () => {
    vi.clearAllMocks()
    const scene = createMockScene() // mock 带 _view.globeDepth.depthStencilTexture
    const pass = createCloudsPass(scene, createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.depthBuffer()).toBe(scene._view.globeDepth.depthStencilTexture)
    pass.destroy()
  })

  it('uniformMap shadowBuffer = Texture3D（sampler3D；Cesium createUniform 不认 sampler2DArray type 36289）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const sb = um.shadowBuffer()
    // shadowBuffer 是 Texture3D（sampler3D dummy 全 0，depth=SHADOW_CASCADE_COUNT=3 cascade 维度）。
    // 非 bridge——Cesium createUniform 不认 sampler2DArray(type 36289)，CloudsMaterial surgery 把
    // uniform sampler2DArray → sampler3D，dummy 用 Texture3D（createUniform 认 SAMPLER_3D）。
    // M3 T4：state.shadow 未就绪时 fallback 此 dummy → Beer=1（无自阴影降级）。
    expect(sb).toBeDefined()
    expect(typeof sb).toBe('object')
    expect(sb).not.toEqual({ _texture: expect.any(Object), _target: expect.any(Number) }) // 非 2D_ARRAY bridge
    // depth 与 shader #define SHADOW_CASCADE_COUNT 3 对齐（sampler3D z 归一化 (i+0.5)/3 层中心）
    expect(sb.source.depth).toBe(3)
    expect(sb.source.arrayBufferView).toHaveLength(3 * 4)
    pass.destroy()
  })

  it('M3 BSM：state.shadow 有值时 uniformMap 返回 state 值（真 BSM 接通）', () => {
    vi.clearAllMocks()
    const bsm = { id: 'bsm', _texture: { id: 'bsm-tex' }, _target: 0x806f } // Texture3D mock
    const matrices = [Matrix4.IDENTITY, Matrix4.clone(Matrix4.IDENTITY), Matrix4.clone(Matrix4.IDENTITY)]
    const intervals = [
      new Cartesian2(0, 0.3),
      new Cartesian2(0.3, 0.7),
      new Cartesian2(0.7, 1)
    ]
    const texelSize = new Cartesian2(1 / 512, 1 / 512)
    const st: CloudsFrameState = {
      sunDirection: { x: 1, y: 0, z: 0 } as any,
      moonDirection: { x: 1, y: 0, z: 0 } as any,
      moonIlluminatedFraction: 0.5,
      altitudeCorrection: { x: 0, y: 0, z: 0 } as any,
      shadow: {
        matrices,
        intervals,
        cameraNear: 1.5, // 完整视锥 near（≠ czm_currentFrustum.x 分段值）
        far: 5e6,
        texelSize,
        bsm
      }
    }
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), st)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.shadowBuffer()).toBe(bsm) // ShadowPass.bsmTexture 直传
    expect(um.shadowMatrices()).toBe(matrices)
    expect(um.shadowIntervals()).toBe(intervals)
    expect(um.shadowFar()).toBe(5e6)
    expect(um.shadowTexelSize()).toBe(texelSize)
    expect(um.u_shadowCameraNear()).toBe(1.5)
    pass.destroy()
  })

  it('M3 BSM fallback：state.shadow 未就绪（无 shadow 字段或 bsm undefined）时降级 dummy', () => {
    vi.clearAllMocks()
    // 分支 1：无 shadow 字段 → u_shadowCameraNear=0 + dummy shadowBuffer
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.u_shadowCameraNear()).toBe(0)
    const dummy1 = um.shadowBuffer()
    expect(dummy1).toBeDefined()
    expect(dummy1.source.depth).toBe(3) // fallback dummy（Beer=1 降级）
    pass.destroy()

    // 分支 2：shadow 存在但 bsm undefined（首帧前 ShadowPass 未 render）→ shadowBuffer 仍 dummy
    vi.clearAllMocks()
    const st: CloudsFrameState = {
      sunDirection: { x: 1, y: 0, z: 0 } as any,
      moonDirection: { x: 1, y: 0, z: 0 } as any,
      moonIlluminatedFraction: 0.5,
      altitudeCorrection: { x: 0, y: 0, z: 0 } as any,
      shadow: {
        matrices: [Matrix4.IDENTITY, Matrix4.IDENTITY, Matrix4.IDENTITY],
        intervals: [new Cartesian2(0, 1), new Cartesian2(0, 1), new Cartesian2(0, 1)],
        cameraNear: 1.0,
        far: 1e6,
        texelSize: new Cartesian2(1 / 512, 1 / 512),
        bsm: undefined
      }
    }
    const pass2 = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), st)
    const um2 = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const dummy2 = um2.shadowBuffer()
    expect(dummy2).toBeDefined()
    expect(dummy2.source.depth).toBe(3)
    expect(dummy2).not.toBe(st.shadow?.bsm) // bsm undefined → 非 undefined 的 dummy
    // 其余 shadow 值仍取 state（matrices/intervals 已就绪，仅纹理未生成）
    expect(um2.shadowFar()).toBe(1e6)
    expect(um2.u_shadowCameraNear()).toBe(1.0)
    pass2.destroy()
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
      moonDirection: { x: 1, y: 0, z: 0 } as any,
      moonIlluminatedFraction: 0.5,
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
      'shadowMatrices', 'shadowFar', 'maxShadowFilterRadius', 'u_shadowCameraNear',
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
      'shadowBottomHeight', 'shadowLayerMask', 'cameraHeight', 'nightAmbient',
      'u_nightTint', 'u_twilightSkyBoost'
    ]
    for (const name of expected) {
      expect(um[name], `uniform ${name} 应注入`).toBeDefined()
    }
    pass.destroy()
  })

  it('夜间环境底光 nightAmbient：默认 0.03；parameters 覆盖生效（夜间云照明地板，方向 B）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.nightAmbient(), '默认 0.03（2026-09-02 过亮修复重标：原 0.12 标定漏算 ACES+gamma 暗部放大——线性值×255≈18/255 误当 display，实际显示 ~86/255 且实测夜空底光仅 ~5/255；headed 扫描定标 0.03：无月夜云带 avg 61/>120 清零，见 clouds.frag 注释）').toBe(0.03)
    pass.destroy()

    vi.clearAllMocks()
    const params = defaultCloudsParameters()
    params.nightAmbient = 0.2
    const pass2 = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state, {
      parameters: params
    })
    const um2 = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um2.nightAmbient(), '用户覆盖走 parameters 字段级合并').toBe(0.2)
    pass2.destroy()
  })

  it('夜间云色调 u_nightTint：默认 (0.88,1,1)；parameters 覆盖生效（乘底光+月光，2026-09-01 uniform 化）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.u_nightTint()).toEqual(new Cartesian3(0.88, 1.0, 1.0))
    pass.destroy()

    vi.clearAllMocks()
    const params = defaultCloudsParameters()
    params.nightTint = new Cartesian3(0.85, 1.0, 1.0)
    const pass2 = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state, {
      parameters: params
    })
    const um2 = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um2.u_nightTint()).toEqual(new Cartesian3(0.85, 1.0, 1.0))
    pass2.destroy()
  })

  it('暮光天光补偿 u_twilightSkyBoost：默认 6（用户拍板物理档）；parameters 覆盖生效（2026-09-01 黄昏云过黑拍板 A 案）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    // 默认 6：实测云/天空显示比 80%（物理目标 85-90%；档位 3 温和=51%/6 物理=80%）
    expect(um.u_twilightSkyBoost()).toBe(6.0)
    pass.destroy()

    vi.clearAllMocks()
    const params = defaultCloudsParameters()
    params.twilightSkyBoost = 1.5
    const pass2 = createCloudsPass(scene2(), createMockLuts(), createMockWeather(), state, {
      parameters: params
    })
    const um2 = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um2.u_twilightSkyBoost()).toBe(1.5)
    pass2.destroy()
  })
})

// scene 工厂（多个 it 共用；每 it clearAllMocks 后新场景避免交叉污染）
function scene2(): any {
  return createMockScene()
}

// ─────────────────────────────────────────────────────────────────────────────
// M4 T6：temporalUpscale 低分模式
// ─────────────────────────────────────────────────────────────────────────────
import { defaultCloudsParameters } from './cloudsDefaultParameters'

describe('M4 T6 temporalUpscale 低分模式', () => {
  const st = (): CloudsFrameState => ({
    sunDirection: new Cartesian3(0, 0, 1),
    moonDirection: new Cartesian3(1, 0, 0),
    moonIlluminatedFraction: 0.5,
    altitudeCorrection: new Cartesian3()
  })

  it('temporalUpscale=true：MRT 尺寸 ceil(w/4) + resolution=lowRes*4 + targetUvScale/mipLevelScale 切低分语义', () => {
    vi.clearAllMocks()
    const params = defaultCloudsParameters()
    params.frame = 5 // D7：temporal 开时 march frame 跟随 params.frame
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true,
      parameters: params
    })
    expect(pass.marchWidth).toBe(480) // ceil(1920/4)
    expect(pass.marchHeight).toBe(270) // ceil(1080/4)
    expect(pass.colorTexture.width).toBe(480)
    expect(pass.depthVelocityTexture.height).toBe(270)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const res = um.resolution() as Cartesian2
    expect(res.x).toBe(1920) // lowRes*4（恰整除 → = drawingBuffer）
    expect(res.y).toBe(1080)
    const tus = um.targetUvScale() as Cartesian2
    expect(tus.x).toBe(1)
    expect(tus.y).toBe(1)
    expect(um.mipLevelScale()).toBe(0.25)
    expect(um.frame()).toBe(5)
    pass.destroy()
  })

  it('temporalUpscale=true 且高不整除（1081）：resolution=lowRes*4=1084 + targetUvScale=1084/1081', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    scene.context.drawingBufferHeight = 1081
    const pass = createCloudsPass(scene, createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true
    })
    expect(pass.marchHeight).toBe(271) // ceil(1081/4)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect((um.resolution() as Cartesian2).y).toBe(1084)
    expect((um.targetUvScale() as Cartesian2).y).toBeCloseTo(1084 / 1081)
    pass.destroy()
  })

  it('upscaleDivisor=2：MRT ceil(w/2) + resolution=lowRes*2 + mipLevelScale=0.5（涂抹修复 T1）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true,
      upscaleDivisor: 2
    })
    expect(pass.marchWidth).toBe(960) // ceil(1920/2)
    expect(pass.marchHeight).toBe(540)
    expect(pass.colorTexture.width).toBe(960)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const res = um.resolution() as Cartesian2
    expect(res.x).toBe(1920) // lowRes*2 = drawingBuffer（恰整除）
    expect(res.y).toBe(1080)
    const tus = um.targetUvScale() as Cartesian2
    expect(tus.x).toBe(1)
    expect(um.mipLevelScale()).toBe(0.5) // 1/divisor
    pass.destroy()
  })

  it('upscaleDivisor=2 且高不整除（1081）：resolution=lowRes*2=1082 + targetUvScale 修正', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    scene.context.drawingBufferHeight = 1081
    const pass = createCloudsPass(scene, createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true,
      upscaleDivisor: 2
    })
    expect(pass.marchHeight).toBe(541) // ceil(1081/2)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect((um.resolution() as Cartesian2).y).toBe(1082)
    expect((um.targetUvScale() as Cartesian2).y).toBeCloseTo(1082 / 1081)
    pass.destroy()
  })

  it('upscaleDivisor=1（全分 march，2026-09-02 追加）：MRT 全分 + mipLevelScale=1 + frame 仍递增', () => {
    vi.clearAllMocks()
    const params = defaultCloudsParameters()
    params.frame = 5
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true,
      upscaleDivisor: 1,
      parameters: params
    })
    expect(pass.marchWidth).toBe(1920) // ceil(1920/1) = 全分
    expect(pass.marchHeight).toBe(1080)
    expect(pass.colorTexture.width).toBe(1920)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    const res = um.resolution() as Cartesian2
    expect(res.x).toBe(1920) // lowRes*1
    expect(res.y).toBe(1080)
    expect(um.mipLevelScale()).toBe(1.0) // 1/1
    expect(um.frame()).toBe(5) // temporalUpscale=true → frame 仍跟随（TAA 亚像素抖动需要相位）
    pass.destroy()
  })

  it('upscaleDivisor 缺省=4（零回归）+ 非法值（3/0/负数）回落 4', () => {
    vi.clearAllMocks()
    const p4 = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true
    })
    expect(p4.marchWidth).toBe(480)
    p4.destroy()
    vi.clearAllMocks()
    const pBad = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st(), {
      temporalUpscale: true,
      upscaleDivisor: 3 as 2 | 4
    })
    expect(pBad.marchWidth).toBe(480) // 非法 → 4
    pBad.destroy()
  })

  it('temporalUpscale 默认 false（M3 零回归）：MRT 全分 + resolution=drawingBuffer + mipLevelScale=1 + frame 恒 0', () => {
    vi.clearAllMocks()
    const params = defaultCloudsParameters()
    params.frame = 5 // params.frame 已递增——非 temporal 时 march uniform 应读 0（D7 拆分）
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st(), {
      parameters: params
    })
    expect(pass.marchWidth).toBe(1920)
    expect(pass.colorTexture.height).toBe(1080)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect((um.resolution() as Cartesian2).x).toBe(1920)
    expect(um.mipLevelScale()).toBe(1.0)
    expect(um.frame()).toBe(0)
    pass.destroy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5 T2：SHADOW_LENGTH MRT/参数（云 god rays）
// ─────────────────────────────────────────────────────────────────────────────
describe('M5 T2 SHADOW_LENGTH MRT/参数', () => {
  const st5 = (): CloudsFrameState => ({
    sunDirection: new Cartesian3(0, 0, 1),
    moonDirection: new Cartesian3(1, 0, 0),
    moonIlluminatedFraction: 0.5,
    altitudeCorrection: new Cartesian3()
  })

  it('lightShafts 默认开：MRT 3 attachment（含 shadowLengthTexture 全分）+ uniformMap 三参数（three defaults 逐字）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st5(), {
      parameters: defaultCloudsParameters()
    })
    expect(pass.shadowLengthTexture).toBeDefined()
    expect(pass.shadowLengthTexture!.width).toBe(1920) // 全分（temporal 默认关）
    expect(pass.shadowLengthTexture!.height).toBe(1080)
    const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
    expect(um.maxShadowLengthIterationCount()).toBe(500)
    expect(um.minShadowLengthStepSize()).toBe(50)
    expect(um.maxShadowLengthRayDistance()).toBe(2e5)
    pass.destroy()
  })

  it('lightShafts=false：MRT 2 attachment、shadowLengthTexture undefined（零回归）', () => {
    vi.clearAllMocks()
    const pass = createCloudsPass(createMockScene(), createMockLuts(), createMockWeather(), st5(), {
      lightShafts: false
    })
    expect(pass.shadowLengthTexture).toBeUndefined()
    // mrtColorTextures 只有 2 张（attachment 数 = out 数，M2 坑）
    const mrt = (createVolumetricPrimitive as any).mock.calls[0][0].mrtColorTextures
    expect(mrt.length).toBe(2)
    pass.destroy()
  })
})
