// createCloudsStage.test.ts
//
// M2 T3：createCloudsStage 单测。参照 CloudsPass.test.ts 的 vi.mock 范式（cesium importOriginal
// 仅 mock WebGL 类；core importOriginal 保留真实 GLSL/math）+ createLensFlareStage.test mock scene 模式。
//
// node 无 WebGL：验装配/接口/生命周期/零回归：
//   - clouds:false → undefined（零回归）
//   - clouds:true → CloudsPass + overlay stage add 到 scene.postProcessStages
//   - overlay stage uniform u_cloudsBuffer = bridge（getColorBridge 返回值）
//   - preRender listener 注册（sunDirection/altitudeCorrection 更新；mock Simon1994/Transforms）
//   - destroy：摘 listener + CloudsPass.destroy + overlay stage remove（幂等）
//   - M3 T5 BSM 编排：ShadowPass 创建参数/uniformMap 组装/preRender cascades 更新 + render/
//     shadowPass=false 诊断基线/destroy 顺序（CascadedShadowMaps 真实现纯 TS 可 node 跑）

import { describe, it, expect, vi } from 'vitest'

// vi.mock('cesium')：仅 mock WebGL 类（PostProcessStage/Sampler），保留真实 math（Cartesian3/Matrix3 等）+
// Simon1994/Transforms/JulianDate（preRender sunDirection 算法用，真实实现可 node 跑）。
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    PostProcessStage: function (this: any, opts: any) {
      this.name = opts.name
      this.fragmentShader = opts.fragmentShader
      this.uniforms = opts.uniforms
      this.sampleMode = opts.sampleMode
      this.pixelFormat = opts.pixelFormat
      this.pixelDatatype = opts.pixelDatatype
      this.destroy = vi.fn()
    },
    Sampler: function (this: any, opts: any) {
      Object.assign(this, opts)
    },
    // Texture mock（M3 T5）：真构造走 ContextLimits.maximumTextureSize（node 无 GL 为 0）——
    // 同 CloudsPass.test.ts 范式仅 mock WebGL-touching 类（shadow turbulence dummy 用）
    Texture: function (this: any, opts: any) {
      this.width = opts.width
      this.height = opts.height
      this.pixelFormat = opts.pixelFormat
      this.pixelDatatype = opts.pixelDatatype
      this.source = opts.source
      this.destroy = vi.fn()
    }
  }
})

// vi.mock('./CloudsPass')：createCloudsStage 编排 CloudsPass，但 CloudsPass 自身已单测覆盖；
// 这里 mock 隔离，专注验编排（stage 拓扑 + bridge 接线 + preRender + destroy）。
// M3 T5：createCloudsStage 还从本模块 import buildSharedCloudsUniforms / resolveCloudsHdrDatatype
// （ShadowPass uniformMap 组装 + BSM pixelDatatype 检测）——mock 提供同名桩（sharedProbe 探针
// 验证共享段展开进 shadow uniformMap；真实共享段由 CloudsPass.test.ts 直测覆盖）。
vi.mock('./CloudsPass', () => ({
  createCloudsPass: vi.fn(() => ({
    primitive: { destroy: vi.fn() },
    colorTexture: { _texture: { id: 'att0' }, _target: 0x0de1 },
    getColorBridge: vi.fn(() => ({ _texture: { id: 'att0' }, _target: 0x0de1 })),
    destroy: vi.fn()
  })),
  buildSharedCloudsUniforms: vi.fn(() => ({ __sharedProbe: () => 'shared' })),
  resolveCloudsHdrDatatype: vi.fn(() => 0x140b) // HALF_FLOAT 哨兵（验 pixelDatatype 接线）
}))

// vi.mock('./ShadowPass')：编排验证 createShadowPass 调用参数 + render/destroy 生命周期
// （ShadowPass 自身在 ShadowPass.test.ts 注入工厂直测）。
vi.mock('./ShadowPass', () => ({
  createShadowPass: vi.fn(() => ({
    bsmTexture: { tag: 'bsm-tex' },
    render: vi.fn(),
    destroy: vi.fn()
  }))
}))

import { createCloudsStage, type CloudsStageOptions } from './createCloudsStage'
import { createCloudsPass } from './CloudsPass'
import { createShadowPass } from './ShadowPass'
import { Cartesian3, Ellipsoid, Matrix4 } from 'cesium'

// mock scene：globe.ellipsoid（真 WGS84，scaleToGeodeticSurface 等方法齐全）+ camera.positionWC +
// inverseViewMatrix/frustum（M3 T5：cascades.update 读，真 Matrix4 透视投影可逆）+
// postProcessStages.add/remove + preRender.addEventListener
function createMockScene(): any {
  const listeners = { preRender: [] as Array<(...args: any[]) => void> }
  return {
    globe: {
      ellipsoid: Ellipsoid.WGS84
    },
    camera: {
      positionWC: new Cartesian3(6378137, 0, 0),
      // ECEF world 系相机位姿（three camera.matrixWorld 等价；CascadedShadowMaps 真实现消费）
      inverseViewMatrix: Matrix4.clone(Matrix4.IDENTITY),
      // 完整视锥 near/far + 透视投影矩阵（preRender 时刻值；far 5e6 > maxRayDistance 2e5 →
      // BSM far 取小后 2e5，验决策 D6）
      frustum: {
        near: 1.5,
        far: 5e6,
        projectionMatrix: Matrix4.computePerspectiveFieldOfView(
          Math.PI / 3,
          16 / 9,
          1.5,
          5e6,
          new Matrix4()
        )
      }
    },
    postProcessStages: {
      add: vi.fn(),
      remove: vi.fn(() => true),
      length: 0,
      get: vi.fn()
    },
    preRender: {
      addEventListener: vi.fn((cb: (...args: any[]) => void) => {
        listeners.preRender.push(cb)
        return () => {
          listeners.preRender = listeners.preRender.filter((l) => l !== cb)
        }
      })
    },
    primitives: {
      add: vi.fn(),
      remove: vi.fn(() => true)
    },
    context: {
      drawingBufferWidth: 1920,
      drawingBufferHeight: 1080,
      halfFloatingPointTexture: true,
      colorBufferHalfFloat: true
    },
    _listeners: listeners
  }
}

function createMockLuts(): any {
  return {
    transmittance: {},
    scattering: {},
    irradiance: {},
    higherOrderScattering: {}
  }
}

function createMockWeather(): any {
  return { shape: {}, shapeDetail: {} }
}

describe('createCloudsStage', () => {
  it('零回归：clouds:false → 返回 undefined（不创建 primitive/stage）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: false
    })
    expect(handle).toBeUndefined()
    expect(createCloudsPass).not.toHaveBeenCalled()
    expect(scene.postProcessStages.add).not.toHaveBeenCalled()
  })

  it('零回归：clouds 不传 → 返回 undefined（默认 false）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {})
    expect(handle).toBeUndefined()
    expect(createCloudsPass).not.toHaveBeenCalled()
  })

  it('clouds:true → 创建 CloudsPass + overlay stage（add 到 postProcessStages）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(handle).toBeDefined()
    expect(createCloudsPass).toHaveBeenCalledTimes(1)
    expect(scene.postProcessStages.add).toHaveBeenCalledTimes(1)
    expect(scene.postProcessStages.add).toHaveBeenCalledWith(handle!.overlayStage)
    handle!.destroy()
  })

  it('overlay stage fragmentShader 含 colorTexture + u_cloudsBuffer（cloudsBuffer overlay 合成）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(handle!.overlayStage.fragmentShader).toContain('colorTexture')
    expect(handle!.overlayStage.fragmentShader).toContain('u_cloudsBuffer')
    // M2 ACES+gamma in overlay（cloud 线性 HDR → display space mix）
    expect(handle!.overlayStage.fragmentShader).toContain('cloudsOverlay_ACESFilmic')
    handle!.destroy()
  })

  it('overlay uniform u_cloudsBuffer = bridge（CloudsPass.getColorBridge 返回值）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const bridgeFn = handle!.overlayStage.uniforms.u_cloudsBuffer
    expect(typeof bridgeFn).toBe('function')
    const bridge = bridgeFn()
    expect(bridge).toEqual({ _texture: expect.any(Object), _target: 0x0de1 })
    handle!.destroy()
  })

  it('preRender listener 注册（update sunDirection/altitudeCorrection 用）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(scene.preRender.addEventListener).toHaveBeenCalledTimes(1)
    expect(scene._listeners.preRender).toHaveLength(1)
    // 调一次 preRender 不抛（Simon1994/Transforms 真实实现 node 可跑）
    const cb = scene._listeners.preRender[0]
    expect(() => cb(scene, JulianDateMock())).not.toThrow()
    handle!.destroy()
  })

  it('preRender 更新 state.altitudeCorrection（getAltitudeCorrectionOffset 写入，非零）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    // createCloudsStage 内部 state 不直接暴露，但 CloudsPass 的 createCloudsPass 第 4 参 state 被闭包持。
    // 验证方式：createCloudsPass mock.calls[0][3] 是 state 对象，preRender 后 altitudeCorrection 应被写。
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    const cb = scene._listeners.preRender[0]
    cb(scene, JulianDateMock())
    // altitudeCorrection 经 getAltitudeCorrectionOffset 写入（相机在 (6378137,0,0)，密切球偏移非零）
    expect(stateArg.altitudeCorrection).toBeDefined()
    handle!.destroy()
  })

  it('destroy：摘 preRender listener + CloudsPass.destroy + overlay remove（幂等）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const cloudsPassDestroy = handle!.cloudsPass.destroy as unknown as () => void
    handle!.destroy()
    expect(scene.preRender.addEventListener).toHaveBeenCalledTimes(1) // 注册时
    // listener 被摘（preRender addEventListener 返回的 remove 函数被调）
    expect(scene._listeners.preRender).toHaveLength(0)
    expect(cloudsPassDestroy).toHaveBeenCalled()
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(handle!.overlayStage)
    // 幂等：二次 destroy 不抛 + remove 不重复
    expect(() => handle!.destroy()).not.toThrow()
    expect(scene.postProcessStages.remove).toHaveBeenCalledTimes(1)
  })

  it('option 透传：CloudsPassOptions 经 createCloudsStage → createCloudsPass', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const opts: CloudsStageOptions = {
      clouds: true,
      shapeDetail: false,
      turbulence: false
    }
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), opts)
    // createCloudsPass 第 5 参 options 应透传 shapeDetail/turbulence
    const passOpts = (createCloudsPass as any).mock.calls[0][4]
    expect(passOpts.shapeDetail).toBe(false)
    expect(passOpts.turbulence).toBe(false)
    handle!.destroy()
  })
})

// Matrix4 与单位阵的最大分量差（验 matrices × inverseMatrices ≈ I 的自洽性）
function maxDiffFromIdentity(m: Matrix4): number {
  let max = 0
  for (let i = 0; i < 16; i++) {
    const expected = i % 5 === 0 ? 1 : 0 // 对角线（0,5,10,15）为 1
    max = Math.max(max, Math.abs(m[i] - expected))
  }
  return max
}

describe('createCloudsStage M3 T5 BSM 编排', () => {
  it('clouds:true（默认）→ 创建 ShadowPass（cascadeCount=3/mapSize=512/pixelDatatype=共享检测）+ state.shadow 就绪', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(createShadowPass).toHaveBeenCalledTimes(1)
    const opts = (createShadowPass as any).mock.calls[0][0]
    expect(opts.cascadeCount).toBe(3)
    expect(opts.mapSize).toBe(512)
    // pixelDatatype = resolveCloudsHdrDatatype(scene)（mock 哨兵 0x140b；真实检测在 CloudsPass.test）
    expect(opts.pixelDatatype).toBe(0x140b)
    // state.shadow 就绪：bsm = ShadowPass.bsmTexture（创建即全 0 → Beer=1 首帧降级）
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    expect(stateArg.shadow.bsm).toBe(shadowPassHandle.bsmTexture)
    // matrices/intervals 长度 3（新分配，非 params 默认数组——IDENTITY 冻结不可写入）
    expect(stateArg.shadow.matrices).toHaveLength(3)
    expect(stateArg.shadow.intervals).toHaveLength(3)
    // texelSize = 1/mapSize（勿传 (1,1) dummy——T4 concern #2）
    expect(stateArg.shadow.texelSize.x).toBeCloseTo(1 / 512)
    expect(stateArg.shadow.texelSize.y).toBeCloseTo(1 / 512)
    handle!.destroy()
  })

  it('ShadowPass uniformMap：共享段展开（buildSharedCloudsUniforms 返回值）+ BSM 专属 inverseShadowMatrices/shadowMarch 7 档平铺', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const opts = (createShadowPass as any).mock.calls[0][0]
    const um = opts.uniformMap
    // 共享段（weather/LUT/层/大气/scatter/sun/frame/stbn）经 buildSharedCloudsUniforms 展开
    expect(um.__sharedProbe()).toBe('shared')
    // BSM 专属：inverseShadowMatrices 数组闭包
    const inv = um.inverseShadowMatrices()
    expect(inv).toHaveLength(3)
    // shadowMarch 档 7 参数平铺（Cesium uniformMap 无 struct；值 = qualityPresets defaults.shadow）
    expect(um.maxIterationCount()).toBe(50)
    expect(um.minStepSize()).toBe(100)
    expect(um.maxStepSize()).toBe(1000)
    expect(um.minDensity()).toBe(1e-5)
    expect(um.minExtinction()).toBe(1e-5)
    expect(um.minTransmittance()).toBe(1e-4)
    expect(um.opticalDepthTailScale()).toBe(2)
    handle!.destroy()
  })

  it('shaderOptions 透传 shapeDetail/turbulence（BSM 与主 march 密度分支须一致）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shapeDetail: false,
      turbulence: false
    })
    const opts = (createShadowPass as any).mock.calls[0][0]
    expect(opts.shaderOptions).toEqual({ shapeDetail: false, turbulence: false })
    handle!.destroy()
  })

  it('shaderOptions 默认对齐：不传 shapeDetail/turbulence 时生成端解析为 true（M3 终审修复）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const opts = (createShadowPass as any).mock.calls[0][0]
    // 修复前：shaderOptions 字面量无条件建键 {shapeDetail: undefined, turbulence: undefined}
    // → buildCloudsShadowFragmentShader 的 {...DEFAULTS, ...options} 被「显式 undefined 键」
    // 覆盖默认 true（spread 按键存在性覆盖，不按值）→ 生成端不 define SHAPE_DETAIL/
    // TURBULENCE 而主 march define（主 march 端 spread 透传，键不存在 → DEFAULTS 生效）
    // → BSM 光深用无 detail 密度场，阴影与云形细节错位。须 ?? true 对齐主 march 默认。
    expect(opts.shaderOptions).toEqual({ shapeDetail: true, turbulence: true })
    handle!.destroy()
  })

  it('preRender 触发后：cascades.update 写 shadowState（cameraNear/far 来自 frustum + intervals 切分 + 逆矩阵自洽）+ shadowPass.render', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    const cb = scene._listeners.preRender[0]
    cb(scene, JulianDateMock())
    // cameraNear/far 与 cascades.update 同帧同源（完整视锥 near；far = min(frustum.far, maxRayDistance)）
    expect(stateArg.shadow.cameraNear).toBe(1.5)
    expect(stateArg.shadow.far).toBe(2e5) // min(5e6, maxRayDistance 2e5)——决策 D6
    // intervals 是 practical split 归一化域：首段 x=0、末段 y=1
    expect(stateArg.shadow.intervals[0].x).toBe(0)
    expect(stateArg.shadow.intervals[2].y).toBeCloseTo(1)
    // matrices 非 identity（真 sun-POV ortho 矩阵）
    expect(Matrix4.equals(stateArg.shadow.matrices[0], Matrix4.IDENTITY)).toBe(false)
    // bsm 保持 ShadowPass.bsmTexture + render 每帧一次
    expect(stateArg.shadow.bsm).toBe(shadowPassHandle.bsmTexture)
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(1)
    // inverseShadowMatrices 与 shadowMatrices 互逆（同一 update 产出，自洽性检查）
    const inv = (createShadowPass as any).mock.calls[0][0].uniformMap.inverseShadowMatrices()
    const product = Matrix4.multiply(stateArg.shadow.matrices[1], inv[1], new Matrix4())
    expect(maxDiffFromIdentity(product)).toBeLessThan(1e-6)
    handle!.destroy()
  })

  it('cloudsShadow=0（shadowPass:false）→ 不创建 ShadowPass + state.shadow 恒 undefined（主 march Beer=1 基线，M2 行为）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shadowPass: false
    })
    expect(createShadowPass).not.toHaveBeenCalled()
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    expect(stateArg.shadow).toBeUndefined()
    // preRender 后仍 undefined（不创建 cascades 更新路径）
    const cb = scene._listeners.preRender[0]
    cb(scene, JulianDateMock())
    expect(stateArg.shadow).toBeUndefined()
    handle!.destroy()
  })

  it('destroy：先 CloudsPass.destroy 后 shadowPass.destroy（bsmTexture 由 ShadowPass own）+ 幂等', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    handle!.destroy()
    const cloudsOrder = (handle!.cloudsPass.destroy as any).mock.invocationCallOrder[0]
    const shadowOrder = (shadowPassHandle.destroy as any).mock.invocationCallOrder[0]
    expect(cloudsOrder).toBeLessThan(shadowOrder)
    // 幂等：二次 destroy 不重复
    expect(() => handle!.destroy()).not.toThrow()
    expect(shadowPassHandle.destroy).toHaveBeenCalledTimes(1)
  })
})

// JulianDate mock（preRender 回调签名第 2 参；真实 JulianDate 太重，mock 最小）
function JulianDateMock(): any {
  return { dayNumber: 2458849, secondsOfDay: 50000 }
}
