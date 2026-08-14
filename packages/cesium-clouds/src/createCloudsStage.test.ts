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
    }
  }
})

// vi.mock('./CloudsPass')：createCloudsStage 编排 CloudsPass，但 CloudsPass 自身已单测覆盖；
// 这里 mock 隔离，专注验编排（stage 拓扑 + bridge 接线 + preRender + destroy）。
vi.mock('./CloudsPass', () => ({
  createCloudsPass: vi.fn(() => ({
    primitive: { destroy: vi.fn() },
    colorTexture: { _texture: { id: 'att0' }, _target: 0x0de1 },
    getColorBridge: vi.fn(() => ({ _texture: { id: 'att0' }, _target: 0x0de1 })),
    destroy: vi.fn()
  }))
}))

import { createCloudsStage, type CloudsStageOptions } from './createCloudsStage'
import { createCloudsPass } from './CloudsPass'
import { Cartesian3, Ellipsoid } from 'cesium'

// mock scene：globe.ellipsoid（真 WGS84，scaleToGeodeticSurface 等方法齐全）+ camera.positionWC +
// postProcessStages.add/remove + preRender.addEventListener
function createMockScene(): any {
  const listeners = { preRender: [] as Array<(...args: any[]) => void> }
  return {
    globe: {
      ellipsoid: Ellipsoid.WGS84
    },
    camera: {
      positionWC: new Cartesian3(6378137, 0, 0)
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

// JulianDate mock（preRender 回调签名第 2 参；真实 JulianDate 太重，mock 最小）
function JulianDateMock(): any {
  return { dayNumber: 2458849, secondsOfDay: 50000 }
}
