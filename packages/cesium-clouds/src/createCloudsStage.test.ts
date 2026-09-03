// createCloudsStage.test.ts
//
// M2 T3：createCloudsStage 单测。参照 CloudsPass.test.ts 的 vi.mock 范式（cesium importOriginal
// 仅 mock WebGL 类；core importOriginal 保留真实 GLSL/math）+ createLensFlareStage.test mock scene 模式。
//
// node 无 WebGL：验装配/接口/生命周期/零回归：
//   - clouds:false → undefined（零回归）
//   - clouds:true → CloudsPass + overlay stage（v2 §6.3：不自动 add，add 时机移交消费者）
//   - overlay stage uniform u_cloudsBuffer = bridge（getColorBridge 返回值）
//   - preRender listener 注册（sunDirection/altitudeCorrection 更新；mock Simon1994/Transforms）
//   - destroy：摘 listener + impl 销毁 + 顶层 overlay 摘除（已 add 走 remove / 未 add 直调；幂等）
//   - M3 T5 BSM 编排：ShadowPass 创建参数/uniformMap 组装/preRender cascades 更新 + render/
//     shadowPass=false 诊断基线/destroy 顺序（CascadedShadowMaps 真实现纯 TS 可 node 跑）

import { describe, it, expect, vi } from 'vitest'

// Texture 实例探针（终审 Finding 1）：buildImpl 内部的 shadowTurbulenceDummy 经 new Texture
// 创建、不经 handle 暴露——同 resolvePassProbe 范式在 mock 工厂闭包外持实例引用，供换档×
// temporal 完整销毁清单断言（destroy 为逐实例 vi.fn）。mock 链路下每次 buildImpl（shadow 开）
// 恰建 1 个 Texture（全链路唯一 new Texture 点）。
const textureProbe = { instances: [] as any[] }

// Texture3D 实例探针（T8 顺手修）：buildImpl 内 atlasFallbackDummy（atlasDisabled 无 raw 降级
// 路径）经 new Texture3D 创建——外圈 catch 防泄漏用例断言其 destroy 被调。与 textureProbe
//（Texture，turbulence dummy）分表：后者有「恰 1 个」数量断言，混入会破坏不变量。
const texture3dProbe = { instances: [] as any[] }

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
      this.isDestroyed = () => false // v2.1 spec §8.0.4：clouds 侧摘除带 isDestroyed 防御
      this.destroy = vi.fn()
    },
    Sampler: function (this: any, opts: any) {
      Object.assign(this, opts)
    },
    // Texture mock（M3 T5）：真构造走 ContextLimits.maximumTextureSize（node 无 GL 为 0）——
    // 同 CloudsPass.test.ts 范式仅 mock WebGL-touching 类（shadow turbulence dummy 用）。
    // T6：Texture3D 同款 mock——atlasDisabled 无 raw 的降级 dummy 在 buildImpl 内 new Texture3D
    //（真实构造走 context._gl，node 无 GL 会炸）。
    Texture: function (this: any, opts: any) {
      this.width = opts.width
      this.height = opts.height
      this.pixelFormat = opts.pixelFormat
      this.pixelDatatype = opts.pixelDatatype
      this.source = opts.source
      this.destroy = vi.fn()
      textureProbe.instances.push(this)
    },
    Texture3D: function (this: any, opts: any) {
      this.width = opts.width
      this.height = opts.height
      this.depth = opts.depth
      this.pixelFormat = opts.pixelFormat
      this.pixelDatatype = opts.pixelDatatype
      this.source = opts.source
      this.destroy = vi.fn()
      texture3dProbe.instances.push(this)
    }
  }
})

// vi.mock('./WeatherAtlas')：T6 编排验证——createWeatherAtlas 调用参数（烘焙输入/escape
// fallback 透传）+ plan 消费（preRender 时间轴）+ dispose 生命周期。WeatherAtlas 自身已在
// WeatherAtlas.test.ts 直测。importOriginal 保留 resolveWeatherAtlasPlan 纯函数（skip 路径
// 时间轴默认 plan 单源）。
const weatherAtlasProbe = { calls: [] as any[], instances: [] as any[] }
vi.mock('./WeatherAtlas', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createWeatherAtlas: vi.fn((opts: any) => {
      weatherAtlasProbe.calls.push(opts)
      const fallback = opts.pngFallback != null
      const inst = {
        // tag 恒定（不带计数）：JSON 装配对拍用例（「quality 缺省：装配传参与显式 high 逐字
        // 一致」）序列化 state.atlasTexture——实例身份由对象引用区分，无需唯一 tag
        atlasTexture: { tag: 'atlas' },
        mode: fallback ? 'pngFallback' : 'baked',
        plan: {
          evolutionPeriodS: (opts.evolutionHours ?? 5.3) * 3600,
          windMps: opts.windMps ?? 8,
          seed: opts.seed ?? 1337,
          weatherRepeat: opts.weatherRepeat ?? 100,
          tileKm: (40075.017 / 4) / (opts.weatherRepeat ?? 100),
          usePngFallback: fallback
        },
        dispose: vi.fn()
      }
      weatherAtlasProbe.instances.push(inst)
      return inst
    })
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
      // T2 运动自适应 α（2026-09-02）：onPreRender 每帧调——记录调用序列供断言
      setTemporalAlpha: vi.fn((v: number) => { inst.lastMotionAlpha = v }),
      lastMotionAlpha: undefined as number | undefined,
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
  const addedStages = new Set<unknown>()
  return {
    globe: {
      ellipsoid: Ellipsoid.WGS84
    },
    camera: {
      positionWC: new Cartesian3(6378137, 0, 0),
      // T2 运动自适应 α 消费 look 方向（真 camera 恒有；mock 给 +X 单位向量）
      directionWC: new Cartesian3(1, 0, 0),
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
      // v2.1 spec §8.0.4：有状态——add 过的 stage remove 才返 true（已 add/未 add 两分支用例）
      add: vi.fn((s: unknown) => {
        addedStages.add(s)
      }),
      remove: vi.fn((s: unknown) => addedStages.delete(s)),
      contains: vi.fn((s: unknown) => addedStages.has(s)),
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

  it('clouds:true → 创建 CloudsPass + overlay stage（v2 §6.3：不自动 add，add 时机移交消费者）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(handle).toBeDefined()
    expect(createCloudsPass).toHaveBeenCalledTimes(1)
    expect(scene.postProcessStages.add).not.toHaveBeenCalled() // 零 add
    handle!.destroy()
  })

  it('overlay fragmentShader 线性域 premultiplied over（v2 spec §4.1：删云单独 ACES，链尾 tonemap 统一）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(handle!.overlayStage.fragmentShader).toContain('colorTexture')
    expect(handle!.overlayStage.fragmentShader).toContain('u_cloudsBuffer')
    // 线性域式在场（spec §4.1）
    expect(handle!.overlayStage.fragmentShader).toContain('scene.rgb * (1.0 - cloud.a)')
    expect(handle!.overlayStage.fragmentShader).toContain('cloud.rgb * u_cloudsExposure')
    // display 域三件套不在场：ACESFilmic 函数 / unpremultiply / gamma
    expect(handle!.overlayStage.fragmentShader).not.toContain('cloudsOverlay_ACESFilmic')
    expect(handle!.overlayStage.fragmentShader).not.toContain('1.0 / 2.2')
    expect(handle!.overlayStage.fragmentShader).not.toContain('max(cloud.a')
    handle!.destroy()
  })

  it('overlay pixelDatatype = resolveCloudsHdrDatatype(scene)（线性 HDR RT，spec §4.2 D6）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    // mock resolveCloudsHdrDatatype 返 0x140b（HALF_FLOAT 哨兵，见 vi.mock('./CloudsPass') :71）
    expect(handle!.overlayStage.pixelDatatype).toBe(0x140b)
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

  it('v2 §8.2.4 handle.destroy：已 add 分支走 remove；未 add 分支 destroy 直调', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    // 分支 A：模拟消费者已 insert（手动 add 进有状态集合）→ destroy 走 remove 成功
    scene.postProcessStages.add(overlay)
    handle!.destroy()
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(overlay)
    expect(overlay.destroy).not.toHaveBeenCalled() // remove 成功 → 不走直调
    // listener 摘除：destroy 后 preRender 归零（removePreRender 被调——补 T3 concern #1 缺口）
    expect(scene._listeners.preRender).toHaveLength(0)
    // 分支 B：未 add 的句柄 → remove 返 false → overlay.destroy 直调
    const handle2 = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay2 = handle2!.overlayStage
    handle2!.destroy()
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(overlay2)
    expect(overlay2.destroy).toHaveBeenCalled()
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
    // 相机逐帧移动（Bayer 相位轮换需要 frame 递增——静止冻结是另一用例）
    const camera = scene.camera as { positionWC: Cartesian3 }
    const basePos = Cartesian3.clone(camera.positionWC)
    firePreRender(scene)
    Cartesian3.add(basePos, new Cartesian3(10, 0, 0), camera.positionWC)
    firePreRender(scene)
    Cartesian3.add(basePos, new Cartesian3(20, 0, 0), camera.positionWC)
    // swap 每帧一次（D2：preRender 开头，等价 three render 后 swap）
    expect(inst.swapBuffers).toHaveBeenCalledTimes(2)
    // jitter 非 0（Bayer offset≠格中心时）且相邻帧相位不同
    const j1 = Cartesian2.clone(
      (handle!.cloudsPass as any) && paramsOf(handle!)!.temporalJitter
    )
    Cartesian3.add(basePos, new Cartesian3(30, 0, 0), camera.positionWC)
    firePreRender(scene)
    const j2 = paramsOf(handle!)!.temporalJitter
    expect(j2.x).not.toBeCloseTo(j1.x, 6)
    handle!.destroy()
  })

  // 【静止冻结 2026-09-02】相机静止时 frame 不递增（Bayer/STBN 相位冻结 → resolve 收敛 →
  // 高对比云区显示层逐位稳定；运动恢复递增）。修复前 temporal 开静止持续抖 20-40% 像素/帧。
  it('相机静止：frame 冻结不递增；相机移动恢复递增', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: true })
    const camera = scene.camera as { positionWC: Cartesian3 }
    // 首帧：prevCameraPos=undefined → 视为运动 → frame=1
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(1)
    // 静止两帧：positionWC 不变 → frame 冻结
    firePreRender(scene)
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(1)
    // 移动相机（> 0.01m 阈值）→ 恢复递增
    Cartesian3.add(camera.positionWC, new Cartesian3(10, 0, 0), camera.positionWC)
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(2)
    // 再次静止 → 再冻结
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(2)
    handle!.destroy()
  })

  // 【T2 运动自适应 α 2026-09-02】静止 α=base（0.1 收敛）；运动超阈值（FULL=300m/帧）
  // α 单调升向 motionAlpha（0.4）——history 拖影/错位权重下降；停止后逐帧回落。
  it('T2 运动自适应 α：静止保持 base；运动升向 motionAlpha；停止回落', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: true })
    const inst = resolvePassProbe.instances.at(-1)!
    const camera = scene.camera as { positionWC: Cartesian3 }
    // 首帧 + 静止帧：motion=0 → α 目标 base，保持 0.1
    firePreRender(scene)
    firePreRender(scene)
    expect(inst.lastMotionAlpha).toBeCloseTo(0.1)
    // 快速移动 500m（>FULL）→ α 开始上升
    Cartesian3.add(camera.positionWC, new Cartesian3(500, 0, 0), camera.positionWC)
    firePreRender(scene)
    const a1 = inst.lastMotionAlpha!
    expect(a1).toBeGreaterThan(0.1)
    // 持续运动 → 继续逼近 0.4（单调）
    Cartesian3.add(camera.positionWC, new Cartesian3(500, 0, 0), camera.positionWC)
    firePreRender(scene)
    expect(inst.lastMotionAlpha!).toBeGreaterThan(a1)
    // 停止 → 逐帧回落（lerp 向 base）
    firePreRender(scene)
    const a3 = inst.lastMotionAlpha!
    firePreRender(scene)
    expect(inst.lastMotionAlpha!).toBeLessThan(a3)
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

  it('temporal 显式 false：不建 resolvePass、march temporalUpscale=false、frame 不递增（?cloudsTemporal=0 逃生门）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      temporal: false
    })
    expect(createCloudsResolvePass).not.toHaveBeenCalled() // 显式 false = M2/M3 全分行为（2026-09-02 默认已翻 true）
    expect(scene.primitives.add).not.toHaveBeenCalled() // createCloudsPass 被 mock 不真 add——resolve 才会 add，此处 0 次
    // overlay bridge 回 march att0
    const bridge = handle!.overlayStage.uniforms.u_cloudsBuffer()
    expect((bridge as any)._texture.id).toBe('att0')
    firePreRender(scene)
    expect(paramsOf(handle!)!.frame).toBe(0) // shadowTemporal 也默认 false → frame 不递增
    // temporalJitter 恒 0（不计算）
    expect(paramsOf(handle!)!.temporalJitter.x).toBe(0)
    handle!.destroy()
  })

  it('temporal 未传：默认开（2026-09-02 拍板对齐源库）——建 resolvePass、overlay bridge 切 resolve', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true
    })
    expect(createCloudsResolvePass).toHaveBeenCalledTimes(1)
    const bridge = handle!.overlayStage.uniforms.u_cloudsBuffer()
    expect((bridge as any)._texture.id).toBe('resolve')
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
    // 旧 impl 全销毁：cloudsPass/shadowPass destroy；overlay 不随 impl 摘（v2 §6.2 per-handle
    // 跨 impl 存活——换档只切 uniform 源，add 状态由消费者持有，§8.2.7）
    expect(oldPass.destroy as unknown as Mock).toHaveBeenCalled()
    expect(oldShadowDestroy).toHaveBeenCalled()
    expect(scene.postProcessStages.remove).not.toHaveBeenCalledWith(oldOverlay)
    // listener 驱动新 impl（非直捕旧 impl）：fire preRender 后新 shadowState.far =
    // low 档 far 不变式 21km——若 listener 仍驱动已销毁旧 impl，新 impl 的 far 停在初始 0
    firePreRender(scene)
    expect(handle.shadowState.far).toBe(21e3)
    // getter 反映新 impl（新 cloudsPass 实例）
    expect(handle.cloudsPass).not.toBe(oldPass)
  })

  it('换档×temporal：完整销毁清单含 resolvePass 与 shadowTurbulenceDummy（spec §9④ 字面覆盖补齐，终审 Finding 1）', () => {
    // 弥合既有两条用例的组合缺口：「换档」用例非 temporal（只断言三件），「temporal 销毁」
    // 用例走 handle.destroy 而非换档。本用例组合 setQuality 换档 × temporal=true，断言
    // buildImpl destroy 四件套全被调（cloudsPass + resolvePass + shadowPass +
    // shadowTurbulenceDummy——v2 §8.2.7 修订：overlay 移出 impl 清单，per-handle 由顶层摘）。
    textureProbe.instances.length = 0
    resolvePassProbe.instances.length = 0
    const { handle, scene } = createStage({ temporal: true, quality: 'high' })
    // 换档前捕获旧 impl 五件资源（getter 此刻读旧 impl；resolvePass/dummy 经探针取）
    const oldPass = handle.cloudsPass
    const oldShadowDestroy = handle.shadowPass!.destroy as unknown as Mock
    const oldOverlay = handle.overlayStage
    const oldResolve = resolvePassProbe.instances[0]
    // temporal=true 首建恰 1 个 Texture——即生成端 turbulence dummy（shadowPass 默认开；
    // mock 链路下全链路唯一 new Texture 点）
    expect(textureProbe.instances).toHaveLength(1)
    const oldDummyDestroy = textureProbe.instances[0].destroy as unknown as Mock
    handle.setQuality('low')
    // 完整销毁清单（spec §9④ + v2 §8.2.7）：四件 destroy 各恰 1 次；overlay 跨 impl 存活
    //（换档不摘——由顶层 handle.destroy/setQuality 失败分支摘）
    expect(oldPass.destroy as unknown as Mock).toHaveBeenCalledTimes(1)
    expect(oldResolve.destroy).toHaveBeenCalledTimes(1)
    expect(oldShadowDestroy).toHaveBeenCalledTimes(1)
    expect(oldDummyDestroy).toHaveBeenCalledTimes(1)
    expect(scene.postProcessStages.remove).not.toHaveBeenCalledWith(oldOverlay)
    // 重建新 impl：temporal/shadow 随用户 options + low 档保留 → 新 dummy/新 resolvePass
    // 已建且未销毁（销毁的恰是旧实例）
    expect(textureProbe.instances).toHaveLength(2)
    expect(textureProbe.instances[1].destroy).not.toHaveBeenCalled()
    expect(resolvePassProbe.instances[1].destroy).not.toHaveBeenCalled()
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

  it('v2 §8.2.3 overlay 跨 impl 存活：setQuality 换档后引用不变 + u_cloudsBuffer 切新 bridge', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    // 显式 temporal=false（非 temporal → getColorBridge 分支；默认 temporal=true 走 resolve bridge）
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true, temporal: false })
    const overlay = handle!.overlayStage
    const bridgeBefore = (overlay.uniforms.u_cloudsBuffer as () => unknown)()
    handle!.setQuality('low')
    expect(handle!.overlayStage).toBe(overlay) // 引用恒定
    const newCloudsPass = (createCloudsPass as any).mock.results.at(-1)!.value // 新 impl 的 pass（results 取返回值；calls 是参数数组）
    expect(handle!.cloudsPass).not.toBe(undefined)
    // u_cloudsBuffer 闭包切到新 impl 的 bridge（非 temporal → getColorBridge）。
    // 强断言：bridgeAfter 经新 pass 的 getColorBridge 产出——若闭包直捕旧 impl（错误形态），
    // 被调的是旧 pass 的函数、新 pass 的 getColorBridge 恒 0 次，此处即翻车
    const bridgeAfter = (overlay.uniforms.u_cloudsBuffer as () => unknown)()
    expect(newCloudsPass.getColorBridge).toHaveBeenCalled()
    expect(bridgeAfter).not.toBe(bridgeBefore) // 新 bridge 对象
    handle!.destroy()
  })

  it('v2 §8.2.6 setQuality 重建失败：顶层 overlay 被摘除（BLOCKER 用例）+ 句柄作废', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    scene.postProcessStages.add(overlay) // 模拟 demo 已 insert
    // mock createCloudsPass：下一次调用（换档 buildImpl）抛错（mockImplementationOnce 一次即耗，
    // 无需恢复基础实现）
    ;(createCloudsPass as any).mockImplementationOnce(() => {
      throw new Error('mock 换档重建失败')
    })
    expect(() => handle!.setQuality('low')).toThrow('mock 换档重建失败')
    expect(scene.postProcessStages.remove).toHaveBeenCalledWith(overlay) // overlay 已摘
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => handle!.setQuality('high')).not.toThrow() // 句柄作废 no-op+warn
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('v2 §8.2.4 impl.destroy 不摘 overlay（collection.remove 不触 overlay）', () => {
    vi.clearAllMocks()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const overlay = handle!.overlayStage
    handle!.setQuality('medium') // 换档触发 impl.destroy
    expect(scene.postProcessStages.remove).not.toHaveBeenCalledWith(overlay)
    handle!.destroy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 月光接线（spec 2026-08-30 r2 §6.5）：moonLightScale 参数默认 + FrameState 月字段 +
// buildSharedCloudsUniforms 三键 + onPreRender 每帧更新
// ─────────────────────────────────────────────────────────────────────────────
import { defaultCloudsParameters } from './cloudsDefaultParameters'
import { computeMoonIlluminatedFractionFromDirections } from '@cesium-geospatial/core'
import type { CloudsFrameState } from './CloudsPass'

describe('月光接线（spec r2 §6.5）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaultCloudsParameters.moonLightScale 默认 25000（2026-08-31 偏亮反馈拍板减半）', () => {
    expect(defaultCloudsParameters().moonLightScale).toBe(25000)
  })

  it('buildSharedCloudsUniforms 含月光三键（moonDirection/moonIlluminatedFraction 闭包直读 state，moonLightScale 读 params）', async () => {
    // 本文件把 ./CloudsPass mock 成编排骨桩（__sharedProbe）——importActual 取真实实现
    // 验月光三键（真实共享段已由 CloudsPass.test 覆盖，此处仅锁月光键接线）
    const actual = await vi.importActual<typeof import('./CloudsPass')>('./CloudsPass')
    const state: CloudsFrameState = {
      sunDirection: new Cartesian3(0, 0, 1),
      moonDirection: new Cartesian3(1, 0, 0),
      moonIlluminatedFraction: 0.5,
      altitudeCorrection: new Cartesian3()
    }
    const uniforms = actual.buildSharedCloudsUniforms(
      createMockScene(),
      createMockLuts(),
      createMockWeather(),
      state,
      defaultCloudsParameters(),
      {} as any // turbulence dummy：buildSharedCloudsUniforms 仅闭包透传，不消费
    )
    expect((uniforms.moonDirection as () => Cartesian3)()).toBe(state.moonDirection)
    expect((uniforms.moonIlluminatedFraction as () => number)()).toBe(0.5)
    expect((uniforms.moonLightScale as () => number)()).toBe(25000)
  })

  it('preRender 月光接线：state.moonDirection 更新为单位向量 + moonIlluminatedFraction = FromDirections(sun, moon)（同帧同源自洽）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    firePreRender(scene)
    // 初始 (0,0,1)/0 已被覆盖：moonDirection 为 ECEF 单位向量、月相因子 ∈ (0,1]
    expect(Cartesian3.magnitude(stateArg.moonDirection)).toBeCloseTo(1, 5)
    expect(stateArg.moonIlluminatedFraction).toBeGreaterThan(0)
    expect(stateArg.moonIlluminatedFraction).toBeLessThanOrEqual(1)
    // 与 core FromDirections 版自洽（preRender 用 state 两方向 dot 求 elongation）
    const expected = computeMoonIlluminatedFractionFromDirections(
      stateArg.sunDirection,
      stateArg.moonDirection
    )
    expect(stateArg.moonIlluminatedFraction).toBeCloseTo(expected, 12)
    handle!.destroy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T6 WeatherAtlas 集成（spec §4/§6）：Atlas 创建接线（烘焙/escape）/altitudeOffset 派生链
// （红队 BLOCKER-4）/preRender 时间轴（T1 纯函数 CPU float64 mod）/天气预设热切（spec §5.4
// band floor 组合语义）/evolutionPhaseS 调试钩子/生命周期（dispose + setQuality 重建重放）
// ─────────────────────────────────────────────────────────────────────────────
import {
  computeDayOfYear,
  computeEvolutionTNorm,
  computeItczCenterLatDeg,
  computeWindOffsetTiles
} from './weatherTime'
import { WEATHER_PRESETS, type CloudsWeatherPreset } from './createCloudsStage'

// firePreRender 时刻（与上方 firePreRender 同一固定值——断言可离线重算 T1 期望值）
const PRENDER_TIME = JulianDate.fromIso8601('2026-08-15T13:41:00Z')

// mock weather + 原始 PNG 数据（localWeatherRaw：atlasDisabled escape 的 fallback 包装源）
function createMockWeatherWithRaw(): any {
  return {
    shape: {},
    shapeDetail: {},
    localWeatherRaw: { width: 2, height: 2, data: new Uint8Array(2 * 2 * 4) }
  }
}

// 默认烘焙 plan 的期望时间轴值（与 WeatherAtlas mock 的 plan 语义一致：无 weatherBake 时缺省）
const DEFAULT_PLAN = {
  evolutionPeriodS: 5.3 * 3600,
  windMps: 8,
  tileKm: (40075.017 / 4) / 100
}

function preRenderTSec(): number {
  return JulianDate.secondsDifference(PRENDER_TIME, JulianDate.fromIso8601('2000-01-01T12:00:00Z'))
}

describe('T6 WeatherAtlas 集成（spec §6）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    weatherAtlasProbe.calls.length = 0
    weatherAtlasProbe.instances.length = 0
  })

  it('默认：烘焙路径 createWeatherAtlas（weatherBake 透传 + pngFallback 兜底源）+ state.atlasTexture 注入', () => {
    const weather = createMockWeatherWithRaw()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), weather, {
      clouds: true,
      weatherBake: { evolutionHours: 2, windMps: 5, seed: 42, weatherRepeat: 50 }
    })
    expect(weatherAtlasProbe.calls).toHaveLength(1)
    const opts = weatherAtlasProbe.calls[0]
    expect(opts.evolutionHours).toBe(2)
    expect(opts.windMps).toBe(5)
    expect(opts.seed).toBe(42)
    expect(opts.weatherRepeat).toBe(50)
    // 烘焙异常兜底源 = loadWeatherTextures 原始 decode 数据（brief Step 3）
    expect(opts.pngFallback).toBe(weather.localWeatherRaw)
    // state.atlasTexture = atlas 纹理（uniformMap 闭包读）
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    expect(stateArg.atlasTexture).toBe(weatherAtlasProbe.instances[0].atlasTexture)
    handle!.destroy()
  })

  it('altitudeOffsetM 经 packLayerUniforms 派生链应用到 params（红队 BLOCKER-4：15 项全链重算）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      altitudeOffsetM: 250
    })
    const params = paramsOf(handle!)
    // 仅低云带 L0/L1 加偏移：minLayerHeights = (750+250, 1000+250, 7500, 0)
    expect(params.minLayerHeights.x).toBe(1000)
    expect(params.minLayerHeights.y).toBe(1250)
    expect(params.minLayerHeights.z).toBe(7500) // L2 高卷云不动
    expect(params.maxLayerHeights.x).toBe(1650)
    expect(params.maxLayerHeights.y).toBe(2450)
    expect(params.maxLayerHeights.z).toBe(8000)
    // march 入射壳 + BSM 域随动（红队 BLOCKER-4 教训：packed 标量必须同链重算）
    expect(params.minHeight).toBe(1000) // 750+250
    expect(params.maxHeight).toBe(8000)
    expect(params.shadowTopHeight).toBe(2450)
    expect(params.shadowBottomHeight).toBe(1000)
    // 层间隙空域 [0,1000] [2450,7500]（packIntervalHeights 重扫）
    expect(params.minIntervalHeights.y).toBe(2450)
    expect(params.maxIntervalHeights.y).toBe(7500)
    // 层成员不随高度变
    expect(params.shadowLayerMask.x).toBe(1)
    expect(params.shadowLayerMask.y).toBe(1)
    expect(params.shadowLayerMask.z).toBe(0)
    expect(params.shadowLayerMask.w).toBe(0)
    handle!.destroy()
  })

  it('altitudeOffsetM clamp 到 [-500, 3000]（spec §6.1）', () => {
    const scene = createMockScene()
    const handleUp = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      altitudeOffsetM: 99999
    })
    expect(paramsOf(handleUp!)!.minHeight).toBe(3750) // 750+3000
    handleUp!.destroy()
    const handleDown = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      altitudeOffsetM: -99999
    })
    expect(paramsOf(handleDown!)!.minHeight).toBe(250) // 750-500
    handleDown!.destroy()
  })

  it('不传 altitudeOffsetM：params 层 uniforms 保持 defaults 写死值（零回归；写死值是 T2 单测锚）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    expect(paramsOf(handle!).minHeight).toBe(750)
    expect(paramsOf(handle!).coverage).toBe(0.3)
    handle!.destroy()
  })

  it('atlasDisabled=true：不烘焙、走 pngFallback 包装路径（?cloudsAtlas=0 escape，spec §6.1）', () => {
    const weather = createMockWeatherWithRaw()
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), weather, {
      clouds: true,
      atlasDisabled: true
    })
    expect(weatherAtlasProbe.calls).toHaveLength(1)
    expect(weatherAtlasProbe.calls[0].pngFallback).toBe(weather.localWeatherRaw)
    expect(weatherAtlasProbe.calls[0].evolutionHours).toBeUndefined() // 烘焙输入不参与 fallback 路径
    expect(weatherAtlasProbe.instances[0].mode).toBe('pngFallback')
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    expect(stateArg.atlasTexture).toBe(weatherAtlasProbe.instances[0].atlasTexture)
    handle!.destroy()
  })

  it('atlasDisabled=true 且无 raw PNG（decode 失败极端）：warn + 跳过创建，不炸（1×1×1 全白 dummy 降级）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      atlasDisabled: true
    })
    expect(weatherAtlasProbe.calls).toHaveLength(0) // 跳过创建
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    // 1×1×1 全白 dummy（满 coverage 连续云墙，同旧 localWeather decode 失败语义）
    expect(stateArg.atlasTexture).toBeDefined()
    expect(stateArg.atlasTexture.source.depth).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    handle!.destroy()
  })

  it('preRender 覆写 state.atlasT/windOffset/itczCenterSin（scene.time 驱动，T1 纯函数同源自洽）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    expect(stateArg.atlasT).toBe(0) // 首帧前缺省
    firePreRender(scene)
    const tSec = preRenderTSec()
    const atlasT = stateArg.atlasT as number
    expect(atlasT).toBeGreaterThanOrEqual(0)
    expect(atlasT).toBeLessThan(1)
    expect(atlasT).toBeCloseTo(computeEvolutionTNorm(tSec, DEFAULT_PLAN.evolutionPeriodS), 12)
    expect(stateArg.windOffset).toEqual(
      computeWindOffsetTiles(tSec, DEFAULT_PLAN.windMps, DEFAULT_PLAN.tileKm)
    )
    // ITCZ：doy 从 GregorianDate 取（2026-08-15 → doy 227 = 最北点附近 → sin > 0）
    const g = JulianDate.toGregorianDate(PRENDER_TIME)
    const doy = computeDayOfYear(g.month, g.day)
    expect(doy).toBe(227)
    expect(stateArg.itczCenterSin).toBeCloseTo(
      Math.sin((computeItczCenterLatDeg(doy) * Math.PI) / 180),
      12
    )
    handle!.destroy()
  })

  it('evolutionPhaseS 调试钩子：偏移演化/平流输入（不动太阳）', () => {
    // 无 phase 基线（同刻 firePreRender）：phase 只进 atlasT/windOffset——sunDirection
    // 应与基线逐位一致（T8 断言补强：原仅查单位向量长度，防不住相位调制太阳方向）
    const baseScene = createMockScene()
    const baseHandle = createCloudsStage(baseScene, createMockLuts(), createMockWeather(), { clouds: true })
    firePreRender(baseScene)
    const baseSun = Cartesian3.clone((createCloudsPass as any).mock.calls[0][3].sunDirection)
    baseHandle!.destroy()

    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      evolutionPhaseS: 3600
    })
    const stateArg = (createCloudsPass as any).mock.calls.at(-1)![3]
    firePreRender(scene)
    const tSec = preRenderTSec() + 3600
    expect(stateArg.atlasT).toBeCloseTo(
      computeEvolutionTNorm(tSec, DEFAULT_PLAN.evolutionPeriodS), 12
    )
    expect(stateArg.windOffset).toEqual(
      computeWindOffsetTiles(tSec, DEFAULT_PLAN.windMps, DEFAULT_PLAN.tileKm)
    )
    // 太阳段不受钩子影响：与无 phase 基线逐位一致
    expect(stateArg.sunDirection).toEqual(baseSun)
    handle!.destroy()
  })

  it('setWeatherPreset 映射（spec §6.1）：clear 0.08 / fair 0.2 / cloudy 0.45 / overcast 0.65+收窄', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const cases: Array<[CloudsWeatherPreset, number, number]> = [
      ['clear', 0.08, 0.6],
      ['fair', 0.2, 0.6],
      ['cloudy', 0.45, 0.6],
      ['overcast', 0.65, 0.36] // filterScale 0.6 收窄 coverageFilterWidths → 连片
    ]
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    for (const [preset, coverage, widthX] of cases) {
      handle!.setWeatherPreset(preset)
      const params = paramsOf(handle!)
      expect(params.coverage).toBe(coverage)
      expect(params.coverageFilterWidths.x).toBeCloseTo(widthX, 12)
      // band floor 组合语义（spec §5.4）：预设激活时下限 clamp ≥0.6
      expect(stateArg.climateBandsFloor).toBe(0.6)
    }
    // WEATHER_PRESETS 表单源（导出值=实现消费值）
    expect(WEATHER_PRESETS.overcast.coverage).toBe(0.65)
    expect(WEATHER_PRESETS.overcast.filterScale).toBe(0.6)
    handle!.destroy()
  })

  it('overcast×副热带不近晴空（spec §5.4 组合语义）：floor 0.6 与 shader clamp(band, floor, 1.3) 配对', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    handle!.setWeatherPreset('overcast')
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    // GPU 侧语义：shader 以 u_climateBandsFloor 钳 band 下限（compile test 锁定作用点）——
    // floor=0.6 ⇒ 副热带谷（band 最低 0.55→0.6+）不把阴天预设钳成近晴空；
    // CPU 侧职责=预设激活时把 floor 提到 0.6、清除后回缺省 0.2（原 shader 字面量）
    expect(stateArg.climateBandsFloor).toBe(0.6)
    expect(stateArg.climateBandsFloor).toBeGreaterThanOrEqual(0.6)
    handle!.setWeatherPreset(undefined)
    expect(stateArg.climateBandsFloor).toBe(0.2) // 恢复缺省=原 shader 字面量 0.2（零回归）
    handle!.destroy()
  })

  it('setWeatherPreset(undefined)：清除预设回创建基线（用户显式 parameters.coverage 保留）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      parameters: { coverage: 0.5 }
    })
    handle!.setWeatherPreset('cloudy')
    expect(paramsOf(handle!).coverage).toBe(0.45)
    handle!.setWeatherPreset(undefined)
    expect(paramsOf(handle!).coverage).toBe(0.5) // 用户显式值（非默认 0.3）
    expect(paramsOf(handle!).coverageFilterWidths.x).toBeCloseTo(0.6, 12) // 基线 widths
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    expect(stateArg.climateBandsFloor).toBe(0.2)
    handle!.destroy()
  })

  it('setQuality 换档：预设重放到新 impl（coverage/floor 跨 impl 保持）+ 旧 atlas dispose、新 atlas 创建', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    handle!.setWeatherPreset('overcast')
    const oldAtlas = weatherAtlasProbe.instances[0]
    handle!.setQuality('low')
    // 预设重放（activePreset 跨 impl）：
    expect(paramsOf(handle!).coverage).toBe(0.65)
    const stateArg = (createCloudsPass as any).mock.calls.at(-1)![3]
    expect(stateArg.climateBandsFloor).toBe(0.6)
    // Atlas 跟随 impl 生命周期：旧 dispose、新创建（v1 无跨 impl 缓存——烘焙输入不变时无谓重烘可接受）
    expect(oldAtlas.dispose).toHaveBeenCalledTimes(1)
    expect(weatherAtlasProbe.instances).toHaveLength(2)
    expect(stateArg.atlasTexture).toBe(weatherAtlasProbe.instances[1].atlasTexture)
    handle!.destroy()
    expect(weatherAtlasProbe.instances[1].dispose).toHaveBeenCalledTimes(1)
  })

  it('创建期 weatherPreset：options 预设即刻生效（等价创建后 setWeatherPreset）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true,
      weatherPreset: 'overcast'
    })
    expect(paramsOf(handle!)!.coverage).toBe(0.65)
    expect(paramsOf(handle!)!.coverageFilterWidths.x).toBeCloseTo(0.36, 12)
    const stateArg = (createCloudsPass as any).mock.calls[0][3]
    expect(stateArg.climateBandsFloor).toBe(0.6)
    handle!.destroy()
  })

  it('destroy：atlas dispose 恰 1 次（幂等）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    handle!.destroy()
    expect(weatherAtlasProbe.instances[0].dispose).toHaveBeenCalledTimes(1)
    expect(() => handle!.destroy()).not.toThrow()
    expect(weatherAtlasProbe.instances[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('buildImpl 中段抛错：外圈 catch 释放 atlas 再 rethrow（T8 顺手修，T6 评审遗留①）', () => {
    const scene = createMockScene()
    // once 桩落在本次 createCloudsStage 的唯一 createCloudsPass 调用上（atlas 创建已完成、
    // 主体装配中段抛错——烘焙内层防护管不到的窗口，正是本用例锁的外圈路径）
    ;(createCloudsPass as any).mockImplementationOnce(() => {
      throw new Error('GL 资源失败')
    })
    expect(() =>
      createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    ).toThrow('GL 资源失败')
    expect(weatherAtlasProbe.instances).toHaveLength(1)
    // 泄漏防护：异常路径上 atlas 仍被 dispose（正常路径由 destroy 清单覆盖）
    expect(weatherAtlasProbe.instances[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('buildImpl 中段抛错（atlasDisabled 无 raw → dummy 路径）：外圈 catch 销毁 atlasFallbackDummy', () => {
    texture3dProbe.instances.length = 0
    const scene = createMockScene()
    ;(createCloudsPass as any).mockImplementationOnce(() => {
      throw new Error('GL 资源失败')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      createCloudsStage(scene, createMockLuts(), createMockWeather(), {
        clouds: true,
        atlasDisabled: true
      })
    ).toThrow('GL 资源失败')
    warn.mockRestore()
    expect(weatherAtlasProbe.instances).toHaveLength(0) // 无 raw → 未建 atlas
    expect(texture3dProbe.instances).toHaveLength(1) // 1×1×1 全白 dummy 已建
    // 泄漏防护：异常路径上 dummy 仍被 destroy
    expect(texture3dProbe.instances[0].destroy).toHaveBeenCalledTimes(1)
  })
})
