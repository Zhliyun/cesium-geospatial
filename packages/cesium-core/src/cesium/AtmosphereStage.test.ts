import { describe, it, expect, vi } from 'vitest'
import {
  Cartesian3,
  Ellipsoid,
  PixelDatatype,
  PostProcessStageComposite
} from 'cesium'
import {
  buildAerialPerspectiveFragmentShader,
  AERIAL_PERSPECTIVE_UNIFORM_NAMES
} from './aerialPerspective.frag'
import {
  createAtmosphereStage,
  validateAtmosphereOptions,
  buildAtmosphereUniforms,
  getEffectiveAtmosphereExposure,
  resolvePostHdrDatatype,
  type AtmosphereFrameState
} from './AtmosphereStage'
import { SUN_ANGULAR_RADIUS } from '../math/atmosphereParameters'
import type { AtmosphereLUTs } from './lutLoader'
import {
  INTENSITY_DEFAULT,
  THRESHOLD_LEVEL_DEFAULT,
  GHOST_AMOUNT_DEFAULT,
  HALO_AMOUNT_DEFAULT
} from './lensFlare/lensFlareConstants'

// depthTemporal historyBlit 隔离 mock：node 环境无 WebGL，真实 Texture 构造会失败。
// historyBlit.test.ts 已独立覆盖 ping-pong/bridge/sanityCheck 逻辑，本文件只测 AtmosphereStage 装配
// （stage 创建/add 顺序/handle 字段/UNSIGNED_BYTE 兜底），故隔离 Texture 构造。
vi.mock('./depthTemporal/historyBlit', () => ({
  createHistoryState: (_ctx: unknown, w: number, h: number, dt: number) => ({
    textures: [
      { _texture: { id: 1 }, _target: 0x0de1, destroy: () => {} },
      { _texture: { id: 2 }, _target: 0x0de1, destroy: () => {} }
    ],
    readIndex: 0,
    width: w,
    height: h,
    pixelDatatype: dt
  }),
  getHistoryBridge: (state: {
    textures: Array<{ _texture: unknown; _target: number }>
    readIndex: number
  }) => {
    const tex = state.textures[state.readIndex]
    return { _texture: tex._texture, _target: tex._target }
  },
  sanityCheckOutputTexture: (t: unknown) => t != null
}))

// —— 测试桩：node 环境无 WebGL，PostProcessStage 不实例化，只测纯函数 ——

const stubLuts = {
  transmittance: { tag: 'transmittance' },
  scattering: { tag: 'scattering' },
  irradiance: { tag: 'irradiance' }
} as unknown as AtmosphereLUTs

function makeState(): AtmosphereFrameState {
  return {
    sunDirection: new Cartesian3(0, 0, 1),
    altitudeCorrection: new Cartesian3(),
    exposure: 1.5
  }
}

// uniforms 值既可能是闭包也可能是静态值，统一解包
function unwrap(uniforms: Record<string, unknown>, name: string): unknown {
  const v = uniforms[name]
  return typeof v === 'function' ? (v as () => unknown)() : v
}

describe('uniform 接线一致性', () => {
  it('shader 声明的 uniform 都被 uniforms 清单覆盖（除 czm_*/colorTexture/depthTexture）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture', 'depthTexture'])
    const missing = declared.filter(
      n =>
        !n.startsWith('czm_') &&
        !whitelist.has(n) &&
        !AERIAL_PERSPECTIVE_UNIFORM_NAMES.includes(n)
    )
    expect(missing).toEqual([])
  })

  it('buildAtmosphereUniforms 键集合 = AERIAL_PERSPECTIVE_UNIFORM_NAMES', () => {
    const uniforms = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), makeState())
    const keys = Object.keys(uniforms).sort()
    expect(keys).toEqual([...AERIAL_PERSPECTIVE_UNIFORM_NAMES].sort())
  })
})

describe('buildAtmosphereUniforms', () => {
  it('cosSunAngularRadius = cos(SUN_ANGULAR_RADIUS)', () => {
    const uniforms = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), makeState())
    expect(unwrap(uniforms, 'cosSunAngularRadius')).toBeCloseTo(Math.cos(SUN_ANGULAR_RADIUS), 12)
  })

  it('exposure 走闭包读 state（动态，preRender 每帧更新）', () => {
    const state = makeState()
    const uniforms = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), state)
    expect(unwrap(uniforms, 'exposure')).toBe(1.5)
    state.exposure = 0.1
    expect(unwrap(uniforms, 'exposure')).toBe(0.1)
  })

  it('u_debugMode 默认 0，可覆盖', () => {
    const u1 = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), makeState())
    expect(unwrap(u1, 'u_debugMode')).toBe(0)
    const u2 = buildAtmosphereUniforms(
      stubLuts,
      validateAtmosphereOptions({ debugMode: 2 }),
      makeState()
    )
    expect(unwrap(u2, 'u_debugMode')).toBe(2)
  })

  it('LUT 接线：transmittance/scattering/irradiance 来自 luts，single_mie 传 scattering 占位', () => {
    const uniforms = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), makeState())
    expect(unwrap(uniforms, 'transmittance_texture')).toBe(stubLuts.transmittance)
    expect(unwrap(uniforms, 'scattering_texture')).toBe(stubLuts.scattering)
    expect(unwrap(uniforms, 'single_mie_scattering_texture')).toBe(stubLuts.scattering)
    expect(unwrap(uniforms, 'irradiance_texture')).toBe(stubLuts.irradiance)
  })

  it('每帧闭包反射 state：sunDirection/altitudeCorrection（Cartesian3 传引用）', () => {
    const state = makeState()
    const uniforms = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), state)
    expect(unwrap(uniforms, 'sunDirection')).toBe(state.sunDirection)
    expect(unwrap(uniforms, 'altitudeCorrection')).toBe(state.altitudeCorrection)
  })
})

describe('validateAtmosphereOptions', () => {
  it('默认值（B 路径全量 + 动态曝光 + lensflare 默认）', () => {
    expect(validateAtmosphereOptions({})).toEqual({
      sun: true,
      sky: true,
      exposureFollowTimeline: true,
      exposureDay: 1.2,
      exposureNight: 0.1,
      exposureTwilightAngleDegrees: 6,
      exposure: 1.5,
      groundDim: 0.5,
      debugMode: 0,
      distanceScale: 1.0,
      inscatterScale: 25.0,
      ditherScale: 1.0,
      lensFlare: true,
      lensFlareIntensity: INTENSITY_DEFAULT,
      lensFlareThreshold: THRESHOLD_LEVEL_DEFAULT,
      lensFlareGhost: GHOST_AMOUNT_DEFAULT,
      lensFlareHalo: HALO_AMOUNT_DEFAULT
    })
  })

  it('lensflare 默认透传 lensFlareConstants（intensity/threshold/ghost/halo）', () => {
    const r = validateAtmosphereOptions({})
    expect(r.lensFlare).toBe(true)
    expect(r.lensFlareIntensity).toBe(INTENSITY_DEFAULT) // 0.01
    expect(r.lensFlareThreshold).toBe(THRESHOLD_LEVEL_DEFAULT) // 3.0
    expect(r.lensFlareGhost).toBe(GHOST_AMOUNT_DEFAULT) // 0.05
    expect(r.lensFlareHalo).toBe(HALO_AMOUNT_DEFAULT) // 0.05
  })

  it('lensflare options 可覆盖默认', () => {
    const r = validateAtmosphereOptions({
      lensFlare: false,
      lensFlareIntensity: 0.02,
      lensFlareThreshold: 4.0,
      lensFlareGhost: 0.1,
      lensFlareHalo: 0.08
    })
    expect(r.lensFlare).toBe(false)
    expect(r.lensFlareIntensity).toBe(0.02)
    expect(r.lensFlareThreshold).toBe(4.0)
    expect(r.lensFlareGhost).toBe(0.1)
    expect(r.lensFlareHalo).toBe(0.08)
  })

  it('部分覆盖，其余默认', () => {
    const o = validateAtmosphereOptions({ sky: false, exposureDay: 2.0 })
    expect(o.sky).toBe(false)
    expect(o.sun).toBe(true)
    expect(o.exposureDay).toBe(2.0)
    expect(o.exposureNight).toBe(0.1)
  })
})

describe('getEffectiveAtmosphereExposure（动态曝光，按相机当地太阳高度角）', () => {
  // 赤道 x 轴上空（WGS84 表面点），测地法向 up ≈ (1,0,0)
  const pos = new Cartesian3(6378137, 0, 0)
  const ell = Ellipsoid.WGS84

  it('正午（sun=up，elev=+90°）→ exposureDay', () => {
    const sun = new Cartesian3(1, 0, 0)
    expect(getEffectiveAtmosphereExposure(pos, ell, sun, 1.5, 0.1, 6)).toBeCloseTo(1.5, 5)
  })

  it('午夜（sun=-up，elev=-90°）→ exposureNight', () => {
    const sun = new Cartesian3(-1, 0, 0)
    expect(getEffectiveAtmosphereExposure(pos, ell, sun, 1.5, 0.1, 6)).toBeCloseTo(0.1, 5)
  })

  it('晨昏（sun 水平，elev=0°）→ day/night 中点（twilight±6°，t=0.5 → 0.8）', () => {
    const sun = new Cartesian3(0, 1, 0)
    expect(getEffectiveAtmosphereExposure(pos, ell, sun, 1.5, 0.1, 6)).toBeCloseTo(0.8, 5)
  })

  it('晨昏带内线性：elev=+6°（带上界）→ day', () => {
    // elev=6° = twilight 上界 → t=1 → day
    const up = new Cartesian3(1, 0, 0)
    const elev = (6 * Math.PI) / 180
    const sun = new Cartesian3(Math.cos(elev), Math.sin(elev), 0) // 与 up 夹角 90-6=84°，dot=sin(6°)
    // dot(up,sun)=cos(84°)=sin(6°)，elev=asin(sin6°)=6°
    expect(getEffectiveAtmosphereExposure(pos, ell, sun, 1.5, 0.1, 6)).toBeCloseTo(1.5, 4)
    void up
  })
})

describe('resolvePostHdrDatatype（PostProcessStage HDR 像素数据类型检测）', () => {
  function makeCtx(half: boolean, halfCb: boolean, full: boolean, fullCb: boolean): unknown {
    return {
      halfFloatingPointTexture: half,
      colorBufferHalfFloat: halfCb,
      floatingPointTexture: full,
      colorBufferFloat: fullCb
    }
  }
  function makeScene(ctx: unknown): import('cesium').Scene {
    return { context: ctx } as unknown as import('cesium').Scene
  }

  it('HalfFloat 采样+渲染都支持 → HALF_FLOAT', () => {
    const ctx = makeCtx(true, true, false, false)
    expect(resolvePostHdrDatatype(makeScene(ctx))).toBe(PixelDatatype.HALF_FLOAT)
  })

  it('仅 float 支持 → FLOAT', () => {
    const ctx = makeCtx(false, false, true, true)
    expect(resolvePostHdrDatatype(makeScene(ctx))).toBe(PixelDatatype.FLOAT)
  })

  it('都不支持 → UNSIGNED_BYTE 兜底', () => {
    const ctx = makeCtx(false, false, false, false)
    expect(resolvePostHdrDatatype(makeScene(ctx))).toBe(PixelDatatype.UNSIGNED_BYTE)
  })

  it('HalfFloat 采样支持但 render target 不支持 → 回退 FLOAT（halfCb 缺失拒 HALF_FLOAT）', () => {
    // 半精度纹理可采样但不可作 color buffer attach → 不能作 RT，跳过 HALF_FLOAT。
    const ctx = makeCtx(true, false, true, true)
    expect(resolvePostHdrDatatype(makeScene(ctx))).toBe(PixelDatatype.FLOAT)
  })
})

// —— createAtmosphereStage 集成（phase2b 三 stage：atmosphere → lensflare → tonomap）——
// node 无 WebGL：PostProcessStage/Composite 构造仅赋值字段（不建 GL 资源），可直接 new。
// mockScene 提供 resolvePostHdrDatatype 的 context caps + globe.ellipsoid（createLensFlareStage 读
// radiiSquared）+ preRender.addEventListener（返 no-op remover）+ postProcessStages.add spy（记顺序）。
// preRender 闭包内的 camera 访问不在构造期触发，故 camera mock 仅占位。
function mockSceneWithAddSpy(
  opts: { halfFloat?: boolean } = {}
): { scene: import('cesium').Scene; addSpy: ReturnType<typeof vi.fn> } {
  // halfFloat=true（默认）：context caps 让 resolvePostHdrDatatype 返回 HALF_FLOAT（与既有用例一致）。
  // halfFloat=false：全 false → 返回 UNSIGNED_BYTE（depthTemporal 兜底测试用）。
  const half = opts.halfFloat ?? true
  const addSpy = vi.fn()
  const scene = {
    context: {
      halfFloatingPointTexture: half,
      colorBufferHalfFloat: half,
      floatingPointTexture: !half,
      colorBufferFloat: false
    },
    globe: { depthTestAgainstTerrain: false, ellipsoid: Ellipsoid.WGS84 },
    camera: { positionWC: new Cartesian3(6378137, 0, 0) },
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    preRender: { addEventListener: () => () => {} },
    postProcessStages: { add: addSpy, remove: () => false }
  } as unknown as import('cesium').Scene
  return { scene, addSpy }
}

describe('createAtmosphereStage（phase2b 三 stage 集成）', () => {
  it('产三 stage（atmosphere + lensflare + tonomap），add 顺序正确', () => {
    const { scene, addSpy } = mockSceneWithAddSpy()
    const handle = createAtmosphereStage(scene, stubLuts, {})
    expect(handle.atmosphereStage).toBeDefined()
    expect(handle.lensFlareStage).toBeDefined() // phase2b 新增
    expect(handle.tonemapStage).toBeDefined()
    // add 顺序：atmosphere → lensflare → tonomap（spec §5.9）
    const added = addSpy.mock.calls.map((c: unknown[]) => c[0])
    const atmoIdx = added.findIndex(s => s === handle.atmosphereStage)
    const lensIdx = added.findIndex(s => s === handle.lensFlareStage)
    const tonoIdx = added.findIndex(s => s === handle.tonemapStage)
    expect(atmoIdx).toBeGreaterThanOrEqual(0)
    expect(lensIdx).toBeGreaterThan(atmoIdx) // atmosphere → lensflare
    expect(tonoIdx).toBeGreaterThan(lensIdx) // lensflare → tonomap
  })

  it('lensFlare=false 不创建 lensflare（phase2a 两 stage 行为，防回归）', () => {
    const { scene } = mockSceneWithAddSpy()
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false })
    expect(handle.lensFlareStage).toBeUndefined()
    expect(handle.atmosphereStage).toBeDefined()
    expect(handle.tonemapStage).toBeDefined()
  })

  it('handle.lensFlareStage 是外层 lensflare Composite（inputPreviousStageTexture=false）', () => {
    const { scene } = mockSceneWithAddSpy()
    const handle = createAtmosphereStage(scene, stubLuts, {})
    expect(handle.lensFlareStage).toBeDefined()
    const lf = handle.lensFlareStage as PostProcessStageComposite
    // 外层 non-series composite（spec §3）：各兄弟 stage 的 input = composite 输入（atmosphere），
    // 非 series 前驱；跨 stage 依赖靠 uniform-name string 引用（I10）。
    expect(lf.inputPreviousStageTexture).toBe(false)
    expect(lf.name).toBe('lensflare')
  })

  it('lensFlare=true 时 depthTestAgainstTerrain 被强制 true（B 路径硬前提不因 lensflare 改变）', () => {
    const { scene } = mockSceneWithAddSpy()
    createAtmosphereStage(scene, stubLuts, {})
    expect((scene as unknown as { globe: { depthTestAgainstTerrain: boolean } }).globe.depthTestAgainstTerrain).toBe(true)
  })

  it('tonomap stage uniforms 含 u_ditherScale（与 atmosphere input dithering 同源；默认 1.0=phase1）', () => {
    const { scene } = mockSceneWithAddSpy()
    const handle = createAtmosphereStage(scene, stubLuts, {})
    const tonoUniforms = (handle.tonemapStage as unknown as { uniforms: Record<string, unknown> }).uniforms
    expect(tonoUniforms.u_ditherScale).toBe(1.0)
    // options 覆盖 ditherScale 时 tonomap 跟随（setMode rebuild 同源）
    const handle2 = createAtmosphereStage(scene, stubLuts, { ditherScale: 3.0 })
    const tonoUniforms2 = (handle2.tonemapStage as unknown as { uniforms: Record<string, unknown> }).uniforms
    expect(tonoUniforms2.u_ditherScale).toBe(3.0)
  })
})

// —— depthTemporal 装配（Task 7）：activeStages[0] + UNSIGNED_BYTE 兜底 + sanity check ——
describe('createAtmosphereStage — depthTemporal 装配', () => {
  it('HDR 设备（HALF_FLOAT）→ depthTemporal 装配为 activeStages[0]（atmosphere 前）', () => {
    const { scene, addSpy } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false })
    expect(handle.temporalEmaEnabled).toBe(true)
    expect(handle.depthTemporalStage).toBeDefined()
    // add 顺序：depthTemporal[0] → atmosphere → tonomap（lensFlare=false 跳过 lensflare）
    const added = addSpy.mock.calls.map((c: unknown[]) => c[0])
    expect((added[0] as { name?: string }).name).toMatch(/depth_temporal/i)
    const dtIdx = added.findIndex((s) => s === handle.depthTemporalStage)
    const atmoIdx = added.findIndex((s) => s === handle.atmosphereStage)
    expect(dtIdx).toBe(0) // activeStages[0]
    expect(atmoIdx).toBeGreaterThan(dtIdx) // atmosphere 在 depthTemporal 后
  })

  it('UNSIGNED_BYTE 设备（无 HALF_FLOAT/FLOAT）→ temporalEmaEnabled=false，不装配 depthTemporal', () => {
    const { scene, addSpy } = mockSceneWithAddSpy({ halfFloat: false })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false })
    expect(handle.temporalEmaEnabled).toBe(false)
    expect(handle.depthTemporalStage).toBeUndefined()
    // 确认无 depth_temporal stage 被 add（兜底回退现状）
    const added = addSpy.mock.calls.map((c: unknown[]) => c[0])
    expect(
      added.some((s) => (s as { name?: string })?.name?.match?.(/depth_temporal/i))
    ).toBe(false)
  })

  it('depthTemporal stage uniforms 接线（函数形式：history/prevVP/alpha + 静态 threshold）', () => {
    const { scene } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false })
    const dt = handle.depthTemporalStage!
    const uniforms = (dt as unknown as { uniforms: Record<string, unknown> }).uniforms
    // u_depthThreshold 静态值（DEPTH_THRESHOLD_DEFAULT = 0.1）
    expect(uniforms.u_depthThreshold).toBe(0.1)
    // 函数形式 uniform（构造期不调用，调用取最新 bridge/prevVP/alpha）
    expect(typeof uniforms.u_historyTexture).toBe('function')
    expect(typeof uniforms.u_prevViewProjection).toBe('function')
    expect(typeof uniforms.u_temporalAlpha).toBe('function')
    // u_temporalAlpha 初始 = HIGH_ALPHA（0.5，首帧偏 current）
    expect((uniforms.u_temporalAlpha as () => number)()).toBe(0.5)
  })
})
