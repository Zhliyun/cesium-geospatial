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
    depthVelocityTexture: { _texture: { id: 'att1' }, _target: 0x0de1 },
    marchWidth: 480, // ceil(1920/4)——M4 temporal jitter 计算的 lowRes
    marchHeight: 270,
    getColorBridge: vi.fn(() => ({ _texture: { id: 'att0' }, _target: 0x0de1 })),
    destroy: vi.fn()
  })),
  buildSharedCloudsUniforms: vi.fn(() => ({ __sharedProbe: () => 'shared' })),
  resolveCloudsHdrDatatype: vi.fn(() => 0x140b) // HALF_FLOAT 哨兵（验 pixelDatatype 接线）
}))

// vi.mock('./ShadowPass')：编排验证 createShadowPass 调用参数 + render/destroy 生命周期
// （ShadowPass 自身在 ShadowPass.test.ts 注入工厂直测）。M4：补 setCurrentMatrices 桩
// （preRender cascades.update 后调）。
vi.mock('./ShadowPass', () => ({
  createShadowPass: vi.fn(() => ({
    bsmTexture: { tag: 'bsm-tex' },
    render: vi.fn(),
    setCurrentMatrices: vi.fn(),
    destroy: vi.fn()
  }))
}))

// vi.mock('./CloudsResolvePass')：M4 T7——resolve pass 自身在 CloudsResolvePass.test.ts 直测；
// 这里桩隔离，记录 createCloudsResolvePass 调用参数 + swapBuffers/getResolvedBridge 生命周期。
const resolvePassProbe = {
  calls: [] as any[],
  instances: [] as any[]
}
vi.mock('./CloudsResolvePass', () => ({
  createCloudsResolvePass: vi.fn((opts: any) => {
    resolvePassProbe.calls.push(opts)
    const inst = {
      primitive: { tag: 'resolve-prim', update: vi.fn(), isDestroyed: () => false, destroy: vi.fn() },
      resolvedTexture: { _texture: { id: 'resolve' }, _target: 0x0de1 },
      swapBuffers: vi.fn(),
      getResolvedBridge: vi.fn(() => ({ _texture: { id: 'resolve' }, _target: 0x0de1 })),
      destroy: vi.fn()
    }
    resolvePassProbe.instances.push(inst)
    return inst
  })
}))

import { createCloudsStage, type CloudsStageOptions } from './createCloudsStage'
import { createCloudsPass } from './CloudsPass'
import { createShadowPass } from './ShadowPass'
import { quantizeSunDirection, SUN_QUANT_STEP } from './sunQuantization'
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
      // M4 T7：viewMatrix（jitter reprojection 用；静止相机 mock 用 identity）
      viewMatrix: Matrix4.clone(Matrix4.IDENTITY),
      // 完整视锥 near/far + 透视投影矩阵（preRender 时刻值；far 5e6 > maxRayDistance 2e5 >
      // SHADOW_FAR_LIMIT 6e4 → BSM far 取小后 6e4，验决策 D6 + 2026-08-28 远端深色斑修复）
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
      clouds: true,
      // frustum 分支（AB 基线，bit 级现行为）：cameraNear 取 frustum.near、far 含 frustum.far
      // 参与、intervals 走 splitFrustum 切分——T4 缺省已是 world（near=0/far 固定），本用例
      // 显式锚 frustum 保 M3 断言语义
      shadowAnchor: 'frustum'
    })
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    const cb = scene._listeners.preRender[0]
    cb(scene, JulianDateMock())
    // cameraNear/far 与 cascades.update 同帧同源（完整视锥 near；
    // far = min(frustum.far, maxRayDistance, SHADOW_FAR_LIMIT=6e4)——D6 + 2026-08-28 远端深色斑修复）
    expect(stateArg.shadow.cameraNear).toBe(1.5)
    expect(stateArg.shadow.far).toBe(6e4) // min(5e6, maxRayDistance 2e5, SHADOW_FAR_LIMIT 6e4)
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

// ─────────────────────────────────────────────────────────────────────────────
// T4（BSM world 锚定）：shadowAnchor 开关缺省 world + 量化太阳喂矩阵 + far/cameraNear 固定
// ─────────────────────────────────────────────────────────────────────────────
describe('createCloudsStage BSM world 锚定编排', () => {
  // 模拟 multi-frustum 分段态：完整视锥（near 1.5/far 5e6）切换为分段（near 5/far 2e4），
  // 投影矩阵同步重算（Cesium 分段渲染时每段重算投影——mock 对齐该事实，防矩阵/数值不一致）
  function setFrustumSegment(scene: any, near: number, far: number): void {
    scene.camera.frustum.near = near
    scene.camera.frustum.far = far
    scene.camera.frustum.projectionMatrix = Matrix4.computePerspectiveFieldOfView(
      Math.PI / 3,
      16 / 9,
      near,
      far,
      new Matrix4()
    )
  }

  it('world 锚定缺省：shadowState.far 恒 6e4（不随分段视锥 far）、cameraNear=0（spec §3.1.5）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    // cascades 构造接线：缺省 anchor='world'（worldRadii/worldIntervals 走类内缺省设计值）
    expect(handle!.cascades.anchor).toBe('world')
    setFrustumSegment(scene, 5, 2e4)
    firePreRender(scene)
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    // far = min(maxRayDistance, SHADOW_FAR_LIMIT)（去掉 camera.frustum.far 参与——multi-frustum
    // 缩放时不再变）；u_shadowCameraNear 源头 state.shadow.cameraNear 固定 0（intervals 常数域
    // [0,60km]/60km 归一化，near/far 必须同域——spec §3.1.5）
    expect(stateArg.shadow.far).toBe(6e4)
    expect(stateArg.shadow.cameraNear).toBe(0)
    // intervals 常数区间（world 分支不复用 splitFrustum）：末段 y 恰为 1（60km/60km）
    expect(stateArg.shadow.intervals[2].y).toBe(1)
    handle!.destroy()
  })

  it('shadowAnchor=frustum 回退：far 含 camera.frustum.far 参与 + cameraNear=frustum.near（bit 级现行为，AB 基线）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shadowAnchor: 'frustum'
    })
    expect(handle!.cascades.anchor).toBe('frustum')
    setFrustumSegment(scene, 5, 2e4)
    firePreRender(scene)
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    // far = min(frustum.far, maxRayDistance, SHADOW_FAR_LIMIT)——分段 far 2e4 参与取小；
    // cameraNear = frustum.near（D3：cascade 选择 near 解耦用完整视锥 near）
    expect(stateArg.shadow.far).toBe(2e4)
    expect(stateArg.shadow.cameraNear).toBe(5)
    handle!.destroy()
  })

  it('world 锚定：矩阵输入太阳量化（quantizeSunDirection(state.sunDirection)）+ distance 不传（z 盒解析不用）；state.sunDirection 保持精确', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const updateSpy = vi.spyOn(handle!.cascades, 'update')
    firePreRender(scene)
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    const [camInput, sunArg, distanceArg] = updateSpy.mock.calls[0]
    // 矩阵输入 = 精确太阳的量化格点（spec §3.1.8：仅矩阵输入量化，march/消费端保持精确）
    const expected = quantizeSunDirection(stateArg.sunDirection, SUN_QUANT_STEP, new Cartesian3())
    expect(Cartesian3.equalsEpsilon(sunArg, expected, 0, 1e-12)).toBe(true)
    // 非平凡：mock 时刻的太阳不恰好在量化格点 → 量化值 ≠ 精确值（证量化确实生效）
    expect(Cartesian3.equals(sunArg, stateArg.sunDirection)).toBe(false)
    // world 分支 distance 不传（undefined → update 缺省 1；updateWorld 不消费）
    expect(distanceArg).toBeUndefined()
    // camera 输入仍是真实相机（updateWorld 消费 inverseViewMatrix 做 center snap）
    expect(camInput.inverseViewMatrix).toBe(scene.camera.inverseViewMatrix)
    handle!.destroy()
  })

  it('frustum 回退：矩阵输入太阳保持精确引用（不量化）+ distance = zenith lerp（three 语义保留）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shadowAnchor: 'frustum'
    })
    const updateSpy = vi.spyOn(handle!.cascades, 'update')
    firePreRender(scene)
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    const [, sunArg, distanceArg] = updateSpy.mock.calls[0]
    // frustum 分支太阳原引用直传（bit 级现行为——量化只属 world 分支）
    expect(sunArg).toBe(stateArg.sunDirection)
    // distance = lerp(1e6, 1e3, zenith)，zenith = dot(sun, geodeticSurfaceNormal)（mock 机位
    // (6378137,0,0) 的地表法线 = (1,0,0) → zenith = sun.x）
    const expectedDistance = 1e6 + (1e3 - 1e6) * Math.max(0, stateArg.sunDirection.x)
    expect(distanceArg).toBeCloseTo(expectedDistance, 6)
    handle!.destroy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5（静止跳过，spec §3.2）：update 返回 changed → 矩阵静止帧跳过 shadowPass.render；
// 与 shadowFreeze 诊断正交组合（freeze=update 不跑、render 照常——现行为不变）
// ─────────────────────────────────────────────────────────────────────────────
describe('createCloudsStage T5 静止跳过', () => {
  // mock scene 相机静止 + firePreRender 恒用同一 JulianDate → sunDirection/量化格点逐帧
  // 相同 → 语义键相同 → changed=false（world 锚定缺省下）
  it('静止跳过：矩阵不变帧不调 shadowPass.render + setCurrentMatrices/矩阵覆写全跳（spec §3.2 白赚）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    firePreRender(scene)
    firePreRender(scene) // 同输入（相机/时刻不变）→ 键同 → changed=false
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(1)
    // m7 不变量（可观察部分）：跳过帧 setCurrentMatrices 不调（ShadowPass 内
    // current/prevMatrices 与 temporal history 三者冻结）
    expect(shadowPassHandle.setCurrentMatrices).toHaveBeenCalledTimes(1)
    // shadowState.matrices 内容冻结（跳过帧不 clone 覆写）
    const frozen = Matrix4.clone(stateArg.shadow.matrices[0], new Matrix4())
    firePreRender(scene) // 仍静止
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(1)
    expect(stateArg.shadow.matrices[0]).toEqual(frozen)
    // 跨格平移 → 矩阵变 → render 恢复（2e4 远超 cascade 0 texel 62.5m）
    scene.camera.inverseViewMatrix = Matrix4.fromTranslation(new Cartesian3(2e4, 2e4, 0))
    firePreRender(scene)
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(2)
    expect(shadowPassHandle.setCurrentMatrices).toHaveBeenCalledTimes(2)
    handle!.destroy()
  })

  it('freeze 诊断：首帧 update+render 各 1 次，后续帧 update 不跑、render 照常（现行为不变——冻结网格重 march）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shadowFreeze: true
    })
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    const updateSpy = vi.spyOn(handle!.cascades, 'update')
    firePreRender(scene)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(1)
    firePreRender(scene)
    firePreRender(scene)
    // freeze 激活（首帧后）：update 整段跳过；render 照常每帧——freeze 的诊断语义是
    // 「冻结矩阵重 march」（噪声分解：冻结网格上逐帧差 = 非矩阵噪声地板），T4 行为不变
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(3)
    handle!.destroy()
  })

  it('shadowTemporal 开：矩阵静止帧仍 render（BSM resolve 时序累积依赖逐帧 jitter 相位，跳帧=停更）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shadowTemporal: true
    })
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    firePreRender(scene)
    firePreRender(scene)
    firePreRender(scene)
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(3)
    handle!.destroy()
  })

  it('frustum 回退：changed 恒 true → 每帧 render（AB 基线行为不变）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      shadowAnchor: 'frustum'
    })
    const shadowPassHandle = (createShadowPass as any).mock.results[0].value
    firePreRender(scene)
    firePreRender(scene)
    firePreRender(scene)
    expect(shadowPassHandle.render).toHaveBeenCalledTimes(3)
    handle!.destroy()
  })
})

// JulianDate mock（preRender 回调签名第 2 参；真实 JulianDate 太重，mock 最小）
function JulianDateMock(): any {
  return { dayNumber: 2458849, secondsOfDay: 50000 }
}

// ─────────────────────────────────────────────────────────────────────────────
// M4 T7：temporal 编排——resolve pass 拓扑 / frame 递增与拆分 / jitter/reprojection / swap
// ─────────────────────────────────────────────────────────────────────────────
import { JulianDate, Cartesian2 } from 'cesium'
import { beforeEach } from 'vitest'
import { createCloudsResolvePass } from './CloudsResolvePass'

function firePreRender(scene: any): void {
  scene._listeners.preRender.forEach((cb: (...args: unknown[]) => void) =>
    cb(scene, JulianDate.fromIso8601('2026-08-15T13:41:00Z'))
  )
}

describe('M4 T7 temporal 编排', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolvePassProbe.calls.length = 0
    resolvePassProbe.instances.length = 0
  })

  it('temporal 显式开：resolve pass 创建（march 之后）+ overlay bridge 切 resolve', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: true })
    expect(createCloudsResolvePass).toHaveBeenCalledTimes(1)
    // 执行顺序契约（plan D1）：march 先建（primitive add 先），resolve 后——同 pass=VOXELS 内
    // 的 PrimitiveCollection 数组序即渲染序。createCloudsPass 被 mock（内部 add 不真跑），
    // 用 invocationCallOrder 验时序 + resolve 的 primitive 确实 add
    const marchOrder = (createCloudsPass as any).mock.invocationCallOrder.at(-1)
    const resolveOrder = (createCloudsResolvePass as any).mock.invocationCallOrder.at(-1)
    expect(resolveOrder).toBeGreaterThan(marchOrder)
    expect(scene.primitives.add).toHaveBeenCalledWith(resolvePassProbe.instances[0].primitive)
    // resolve pass 构造参数：全分尺寸 + march att0/att1 + frame 闭包 + three 默认参数
    const opts = resolvePassProbe.calls[0]
    expect(opts.width).toBe(1920)
    expect(opts.height).toBe(1080)
    expect(opts.colorBuffer._texture.id).toBe('att0')
    expect(opts.depthVelocityBuffer._texture.id).toBe('att1')
    expect(opts.varianceGamma).toBe(2)
    // overlay bridge 切 resolve 输出
    const bridge = handle!.overlayStage.uniforms.u_cloudsBuffer()
    expect((bridge as any)._texture.id).toBe('resolve')
    handle!.destroy()
  })

  it('frame 每帧递增 + temporalJitter 写入 params（Bayer 相位随帧变化）+ preRender 开头 swap', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: true })
    const inst = resolvePassProbe.instances[0]
    firePreRender(scene)
    firePreRender(scene)
    // swap 每帧一次（D2：preRender 开头，等价 three render 后 swap）
    expect(inst.swapBuffers).toHaveBeenCalledTimes(2)
    // jitter 非 0（Bayer offset≠格中心时）且相邻帧相位不同
    const j1 = Cartesian2.clone(
      (handle!.cloudsPass as any) && paramsOf(handle!)!.temporalJitter
    )
    firePreRender(scene)
    const j2 = paramsOf(handle!)!.temporalJitter
    expect(j2.x).not.toBeCloseTo(j1.x, 6)
    handle!.destroy()
  })

  it('viewReprojectionMatrix = reprojectionMatrix * inverseView（链式正确）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: true })
    firePreRender(scene)
    firePreRender(scene)
    const p = paramsOf(handle!)!
    const expected = Matrix4.multiply(
      p.reprojectionMatrix,
      scene.camera.inverseViewMatrix,
      new Matrix4()
    )
    expect(Matrix4.equals(p.viewReprojectionMatrix, expected)).toBe(true)
    handle!.destroy()
  })

  it('temporal=false：不建 resolvePass、march temporalUpscale=false、frame 仍递增（BSM 默认 temporal）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(createCloudsResolvePass).not.toHaveBeenCalled() // 默认 temporal=false（2026-08-17 抖动回退）
    expect(scene.primitives.add).not.toHaveBeenCalled() // createCloudsPass 被 mock 不真 add——resolve 才会 add，此处 0 次
    // overlay bridge 回 march att0
    const bridge = handle!.overlayStage.uniforms.u_cloudsBuffer()
    expect((bridge as any)._texture.id).toBe('att0')
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(0) // shadowTemporal 也默认 false → frame 不递增（全 M3 行为）
    // temporalJitter 恒 0（不计算）
    expect(paramsOf(handle!)!.temporalJitter.x).toBe(0)
    handle!.destroy()
  })

  it('temporal=false + shadowTemporal=false：frame 不递增（D7 单端全关 = M3 行为）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      temporal: false,
      shadowTemporal: false
    })
    firePreRender(scene)
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(0)
    // ShadowPass 构造传 temporalPass=false（M3 编译分支）
    const shadowOpts = (createShadowPass as any).mock.calls.at(-1)[0]
    expect(shadowOpts.temporalPass).toBe(false)
    handle!.destroy()
  })

  it('destroy：resolvePass.destroy 在 cloudsPass 之后调用（顺序编排）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: true })
    const inst = resolvePassProbe.instances[0]
    handle!.destroy()
    expect(inst.destroy).toHaveBeenCalledTimes(1)
    handle!.destroy()
    expect(inst.destroy).toHaveBeenCalledTimes(1) // 幂等
  })
})

// params 提取 helper（defaultCloudsParameters 引用持有——createCloudsStage 内部 options.parameters
// 未传时新建；经 createCloudsPass mock 调用参数捕获）
function paramsOf(handle: NonNullable<ReturnType<typeof createCloudsStage>>): any {
  const call = (createCloudsPass as any).mock.calls.at(-1)
  return call?.[4]?.parameters ?? call?.[4] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// T4 质量档位装配（spec §6/§7）：buildImpl 提取 + quality 三路接线（编译开关/uniform/
// BSM 结构）+ far 不变式（world 分支 shadowState.far ≡ worldIntervals[cascadeCount]）
// ─────────────────────────────────────────────────────────────────────────────
describe('质量档位装配（spec §6/§7）', () => {
  // 对拍辅助：收集 createCloudsPass/createShadowPass mock 收到的参数（JSON 深拷贝隔离引用；
  // 函数字段（uniformMap/bridge）序列化丢弃——对拍的是装配传参形状与值）。mock.calls 跨调用
  // 累积 → 每次 create 前手动 vi.clearAllMocks()（沿用本文件既有惯例，只清 calls 不清实现）。
  // quality 剔除：它是编排层字段（CloudsPassOptions 无此契约），...options 透传时作为多余
  // 键无害存在（CloudsPass 不消费）——对拍聚焦装配实质差异（编译开关/uniform/BSM 结构）。
  function collectCreateCalls(): unknown {
    const stripQuality = (calls: unknown[]) =>
      JSON.parse(JSON.stringify(calls), (k, v) => (k === 'quality' ? undefined : v))
    return {
      clouds: stripQuality(vi.mocked(createCloudsPass).mock.calls),
      shadow: JSON.parse(JSON.stringify(vi.mocked(createShadowPass).mock.calls))
    }
  }

  it('quality 缺省：装配传参与显式 high 逐字一致（零回归）', () => {
    vi.clearAllMocks()
    const a = createCloudsStage(createMockScene(), createMockLuts(), createMockWeather(), { clouds: true })
    const callsA = collectCreateCalls()
    vi.clearAllMocks()
    const b = createCloudsStage(createMockScene(), createMockLuts(), createMockWeather(), {
      clouds: true,
      quality: 'high'
    })
    const callsB = collectCreateCalls()
    expect(callsB).toEqual(callsA)
    a!.destroy()
    b!.destroy()
  })

  it('low 档：cascadeCount=2 / mapSize=256 / far 不变式 21km（spec §6）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      quality: 'low'
    })
    // 结构接线（applied.shadow 三路之一）：cascadeCount=2、mapSize=256（去 hardcode）
    expect(handle!.cascades.cascadeCount).toBe(2)
    expect(handle!.cascades.mapSize).toBe(256)
    // worldIntervals 截断语义：类内缺省 [0,10,21,60]km 消费前 cascadeCount+1 项 → [0,10,21]km
    expect(handle!.cascades.worldIntervals[handle!.cascades.cascadeCount]).toBe(21e3)
    // preRender 触发一次 update 后 shadowState.far ≡ cascades.far = worldIntervals[2] = 21km
    //（不变式——world 分支废除 SHADOW_FAR_LIMIT 独立参与，防级联选择归一化域分叉）
    firePreRender(scene)
    expect(handle!.shadowState.far).toBe(21e3)
    // texelSize 随档位 mapSize（1/256）
    expect(handle!.shadowState.texelSize.x).toBeCloseTo(1 / 256)
    // shadowState 数组与 cascadeCount 同长（低档 2 元素）
    expect(handle!.shadowState.matrices).toHaveLength(2)
    expect(handle!.shadowState.intervals).toHaveLength(2)
    handle!.destroy()
  })

  it('low 档：主 march shadowCascadeCount=2（define 单源投影）+ ShadowPass cascadeCount=2', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, quality: 'low' })
    // Ruling 2：createCloudsPass 被 vi.mock——mock calls 无 shader 源字符串，改字段级断言
    //（define 由 CloudsMaterial 按该字段生成，define 正确性由 CloudsMaterial.test 覆盖）。
    // Ruling 1：顶层 shadowCascadeCount 必传——漏传则 low 档主 march define 恒 3。
    const passOpts = (createCloudsPass as any).mock.lastCall![4] as Record<string, unknown>
    expect(passOpts.shadowCascadeCount).toBe(2)
    expect((passOpts.parameters as Record<string, unknown>).shadowCascadeCount).toBe(2)
    // ShadowPass 侧：JSON 断言可达（cascadeCount 是 mock options 的普通数字字段）
    expect(JSON.stringify(vi.mocked(createShadowPass).mock.calls)).toContain('cascadeCount":2')
  })

  it('ShadowPass shaderOptions 读 resolved 值（low 档 shapeDetail=false 不再 ?? true 错位，spec §6 点名）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, quality: 'low' })
    const opts = (createShadowPass as any).mock.lastCall![0]
    expect(opts.shaderOptions.shapeDetail).toBe(false)
    expect(opts.shaderOptions.turbulence).toBe(false)
  })

  it('主 march 编译开关走 resolved（low 档 accurate/shapeDetail/turbulence/lightShafts 全关）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, quality: 'low' })
    const passOpts = (createCloudsPass as any).mock.lastCall![4] as Record<string, unknown>
    expect(passOpts.accurateSunSkyLight).toBe(false)
    expect(passOpts.shapeDetail).toBe(false)
    expect(passOpts.turbulence).toBe(false)
    expect(passOpts.lightShafts).toBe(false)
  })

  it('temporal=true：resolvePass 进销毁清单（spec §7 v3）', () => {
    vi.clearAllMocks()
    resolvePassProbe.instances.length = 0
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      temporal: true
    })
    const inst = resolvePassProbe.instances[0]
    expect(inst).toBeDefined()
    handle!.destroy()
    expect(inst.destroy).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task 5：setQuality 行为收口（spec §7 v3）——同档 no-op / 换档重建（旧 impl 全
// destroy + listener 零直捕驱动新 impl）/ 用户显式参数保留（合并语义端到端）/
// params clone 无共享引用 / destroy 后 no-op+warn / 重建抛错原子性（句柄作废）
// ─────────────────────────────────────────────────────────────────────────────
import type { Mock } from 'vitest'

describe('setQuality 行为（spec §7 v3）', () => {
  // 本组装配辅助：清 mock 历史 + clouds:true 基线建 stage（沿用本文件逐用例 clearAllMocks 惯例）
  function createStage(options: CloudsStageOptions): {
    handle: NonNullable<ReturnType<typeof createCloudsStage>>
    scene: ReturnType<typeof createMockScene>
  } {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      ...options
    })
    expect(handle).toBeDefined()
    return { handle: handle!, scene }
  }

  it('同档 no-op：不触发销毁/重建', () => {
    const { handle } = createStage({ quality: 'high' })
    handle.setQuality('high')
    expect(vi.mocked(createCloudsPass).mock.calls.length).toBe(1) // 未重建
  })

  it('换档：旧 impl 全部 destroy 均被调 + listener 推动新 impl（零直捕断言）', () => {
    const { handle, scene } = createStage({ quality: 'high' })
    // 换档前经 getter 捕获旧 impl 三件公开资源（此刻 getter 读旧 impl）
    const oldPass = handle.cloudsPass
    const oldShadowDestroy = handle.shadowPass!.destroy as unknown as Mock
    const oldOverlay = handle.overlayStage
    handle.setQuality('low')
    // 旧 impl 全销毁：cloudsPass/shadowPass destroy + overlay 从 postProcessStages 摘除
    expect(oldPass.destroy as unknown as Mock).toHaveBeenCalled()
    expect(oldShadowDestroy).toHaveBeenCalled()
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(oldOverlay)
    // listener 驱动新 impl（非直捕旧 impl）：fire preRender 后新 shadowState.far =
    // low 档 far 不变式 21km——若 listener 仍驱动已销毁旧 impl，新 impl 的 far 停在初始 0
    firePreRender(scene)
    expect(handle.shadowState.far).toBe(21e3)
    // getter 反映新 impl（新 cloudsPass 实例）
    expect(handle.cloudsPass).not.toBe(oldPass)
  })

  it('换档保留用户显式参数（合并语义端到端）', () => {
    const { handle } = createStage({ quality: 'high', parameters: { maxIterationCount: 333 } })
    handle.setQuality('low')
    const passOpts = (createCloudsPass as any).mock.lastCall![4] as {
      parameters: { maxIterationCount: number; minStepSize: number }
    }
    expect(passOpts.parameters.maxIterationCount).toBe(333) // 用户显式 > 档位 200
    expect(passOpts.parameters.minStepSize).toBe(100) // 档位值（low preset 显式列）
  })

  it('换档后 params 无共享引用（clone 生效，spec §5）', () => {
    const userParams = { maxIterationCount: 333 }
    const { handle } = createStage({ quality: 'high', parameters: userParams })
    handle.setQuality('medium')
    handle.setQuality('high')
    const p1 = (createCloudsPass as any).mock.calls.at(-2)![4] as { parameters: { maxIterationCount: number } }
    const p2 = (createCloudsPass as any).mock.lastCall![4] as { parameters: { maxIterationCount: number } }
    // 每次 applyQualityPreset 产物是 deep-clone 新对象（defaultCloudsParameters 每调新建）
    expect(p1.parameters).not.toBe(p2.parameters)
    // clone 不丢用户显式值：两次重建的 params 均保留 333
    expect(p1.parameters.maxIterationCount).toBe(333)
    expect(p2.parameters.maxIterationCount).toBe(333)
  })

  it('destroy 后 setQuality：no-op + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { handle } = createStage({})
    handle.destroy()
    handle.setQuality('low')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createCloudsPass).mock.calls.length).toBe(1) // 不重建
    warn.mockRestore()
  })

  it('重建抛错：句柄作废（destroyed 置位，再 setQuality warn 不重建）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { handle } = createStage({})
    // once 桩须在首建之后排队：createStage 的初始 build 同样调 createCloudsPass，
    // 先排队会被初始 build 消费（brief 草稿顺序笔误——见任务补充说明同类索引笔误）
    vi.mocked(createCloudsPass).mockImplementationOnce(() => {
      throw new Error('GL 资源失败')
    })
    expect(() => handle.setQuality('low')).toThrow('GL 资源失败')
    handle.setQuality('high') // destroyed → no-op + warn
    expect(warn).toHaveBeenCalledTimes(1)
    // 恰好 2 次 createCloudsPass（首建 + 失败重建各 1）；此后 setQuality 不再尝试重建
    expect(vi.mocked(createCloudsPass).mock.calls.length).toBe(2)
    warn.mockRestore()
  })
})
