import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  Cartesian3,
  Ellipsoid,
  Matrix4,
  Matrix3,
  JulianDate,
  PixelDatatype,
  PostProcessStage,
  PostProcessStageComposite,
  Simon1994PlanetaryPositions,
  Transforms
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
// （stage 创建/add 顺序/handle 字段/UNSIGNED_BYTE 兜底）+ Task 8 lifecycle（blit/swap/resize），故隔离
// Texture 构造。Task 8 lifecycle 用 vi.hoisted 暴露 spy（buildBlitCommand/buildHistoryFBO/swapHistory/
// createHistoryState），跨测试 mockClear 验证调用次数/参数。
const dtSpies = vi.hoisted(() => ({
  createHistoryState: vi.fn(),
  buildBlitCommand: vi.fn(),
  buildHistoryFBO: vi.fn(),
  swapHistory: vi.fn(),
}))

vi.mock('./depthTemporal/historyBlit', () => {
  // createHistoryState 默认实现：返回 ping-pong 两张 mock Texture（含 destroy spy，供 resize 销毁验证）
  dtSpies.createHistoryState.mockImplementation(
    (_ctx: unknown, w: number, h: number, dt: number) => ({
      textures: [
        { _texture: { id: 1 }, _target: 0x0de1, destroy: vi.fn() },
        { _texture: { id: 2 }, _target: 0x0de1, destroy: vi.fn() }
      ],
      readIndex: 0,
      width: w,
      height: h,
      pixelDatatype: dt
    })
  )
  // buildBlitCommand 默认返回含 execute spy 的 mock cmd（lifecycle 调 cmd.execute 不崩）
  dtSpies.buildBlitCommand.mockReturnValue({ execute: vi.fn(), framebuffer: undefined })
  // swapHistory 默认翻转 readIndex（与真实实现一致，便于状态断言）
  dtSpies.swapHistory.mockImplementation((state: { readIndex: number }) => {
    state.readIndex = 1 - state.readIndex
  })
  return {
    createHistoryState: dtSpies.createHistoryState,
    getHistoryBridge: (state: {
      textures: Array<{ _texture: unknown; _target: number }>
      readIndex: number
    }) => {
      const tex = state.textures[state.readIndex]
      return { _texture: tex._texture, _target: tex._target }
    },
    sanityCheckOutputTexture: (t: unknown) => t != null,
    getWriteTexture: (state: { textures: unknown[]; readIndex: number }) =>
      state.textures[1 - state.readIndex],
    swapHistory: dtSpies.swapHistory,
    buildBlitCommand: dtSpies.buildBlitCommand,
    buildHistoryFBO: dtSpies.buildHistoryFBO
  }
})

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

// 水下相机防护（2026-08-15 bug：里海视角 camera=54.2518,37.3749,-12,... 天空黑、云正常）：
// Bruneton 参数化定义域 r >= bottom_radius（GetScatteringTextureUvwzFromRMuMuSNu assert，
// release GLSL 静默越界 → rho/transmittance 采样非法 → 天空黑）。Cesium 允许相机入水
// （里海水面 WGS84 椭球高约 -28m，拖动可到水下），须在进入大气计算前把相机沿径向
// clamp 到地表——水下深度不含大气（光路从水面起算），物理等价。
// 太阳方向 ICRF 竞态（2026-08-16 修复）：computeIcrfToFixedMatrix 依赖 IAU2006 XYS 数据文件
// 懒加载（页面加载头 ~1s 返回 undefined → sunDirection 暂留初始 (0,0,1)；下载失败则永远错）。
// Cesium 内部 globe 昼夜用 computeIcrfToCentralBodyFixedMatrix：XYS 就绪时同 IAU2006，未就绪时
// TEME→pseudo-fixed（纯 GMST 数值）fallback 恒有值——零网络依赖零竞态。
describe('太阳方向 ICRF 竞态防护', () => {
  it('node 环境（XYS 恒未加载）computeIcrfToCentralBodyFixedMatrix 仍有 GMST fallback 而旧函数 undefined', () => {
    const time = JulianDate.fromIso8601('2026-08-15T13:41:00Z')
    const m = Transforms.computeIcrfToCentralBodyFixedMatrix(time, new Matrix3())
    expect(m).toBeDefined()
    // 旧函数在无 XYS 数据时 undefined（竞态实证——修复的动机）
    expect(Transforms.computeIcrfToFixedMatrix(time, new Matrix3())).toBeUndefined()
  })

  it('GMST fallback 太阳方向与 XYS 就绪版差 <0.5°（fallback 精度足够）', async () => {
    const time = JulianDate.fromIso8601('2026-08-15T13:41:00Z')
    const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time, new Cartesian3()
    )!
    const gmst = Transforms.computeTemeToPseudoFixedMatrix(time, new Matrix3())!
    const a = Cartesian3.normalize(Matrix3.multiplyByVector(gmst, sunInertial, new Cartesian3()), new Cartesian3())
    // 用 centralBodyFixed（= fixed，若 XYS 不可用则 = GMST）——node 下两者同源；
    // 对照旧路径的 inertial 直投（错误做法）必须显著不同，证明旋转是必要的
    const b = Cartesian3.normalize(
      Matrix3.multiplyByVector(
        Transforms.computeIcrfToCentralBodyFixedMatrix(time, new Matrix3())!,
        sunInertial,
        new Cartesian3()
      ),
      new Cartesian3()
    )
    expect(Math.acos(Math.max(-1, Math.min(1, Cartesian3.dot(a, b))))).toBeLessThan(
      0.5 * Math.PI / 180
    )
  })

  it('两处调用点已切换到 computeIcrfToCentralBodyFixedMatrix（源码防回归）', async () => {
    const { readFile } = await import('node:fs/promises')
    const core = await readFile('src/cesium/AtmosphereStage.ts', 'utf-8')
    const clouds = await readFile(
      '../../packages/cesium-clouds/src/createCloudsStage.ts', 'utf-8'
    )
    expect(core).toContain('computeIcrfToCentralBodyFixedMatrix')
    expect(clouds).toContain('computeIcrfToCentralBodyFixedMatrix')
    expect(core).not.toContain('computeIcrfToFixedMatrix(')
    expect(clouds).not.toContain('computeIcrfToFixedMatrix(')
  })
})

describe('水下相机防护（Bruneton 定义域 r>=bottom_radius）', () => {
  const CLAMP_ANCHOR = 'cameraMinR / cameraRadius'

  it.each([
    ['atmosphere（B 路径全分支）', {}],
    ['sky-only', { sky: true }]
  ])('%s 的 main 包含相机径向 clamp', (_name, opts) => {
    const s = buildAerialPerspectiveFragmentShader(opts)
    expect(s).toContain(CLAMP_ANCHOR)
  })

  it('clamp 位于 reconstructRay 之后（视线方向仍由原始相机位置差分构造，clamp 平移不影响）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    const rayIdx = s.indexOf('reconstructRay(cameraPosition, rayDirection);')
    const clampIdx = s.indexOf(CLAMP_ANCHOR)
    expect(rayIdx).toBeGreaterThan(0)
    expect(clampIdx).toBeGreaterThan(rayIdx)
  })

  // 第二根因：c = dot(o,o)-R² 是 4e7 量级 float32 减法，ULP 噪声 ±4km²（±16m 深度）——
  // 贴地/水下相机的 hitBottom/tHitG 判定被舍入支配（-12m 实测落"球内"→GROUND 分支→黑）。
  // 修复 = 因式分解 (r-R)(r+R) + max 钉非负（相机语义不在球内）。
  // 第三根因（-31m 黑白雪花）：c=0 时 sqrt(b²) 舍入可比 b 大 1 ULP（b~2462km 时 0.00024km），
  // -b+s > 1e-6 旧阈值假阳性 → ~69% 像素 hitBottom 伪随机翻转。阈值 1e-6→1e-3（1m，物理无意义尺度）。
  it('球求交判别式用稳定因式分解（rayForwardHitsSphere 与 main cG 双处）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    const stableForm = 'max((rO - R) * (rO + R), 0.0)'
    const stableFormG = 'max((rCamG - bottomR) * (rCamG + bottomR), 0.0)'
    expect(s).toContain(stableForm)
    expect(s).toContain(stableFormG)
    // 原始 dot 形式不得残留在这两处（防回归）
    expect(s).not.toContain('float c = dot(o, o) - R * R;')
    expect(s).not.toContain('float cG = dot(cameraPosition, cameraPosition) - bottomR * bottomR;')
  })

  it('前向交点阈值 1e-3（1m，排除 sqrt 舍入 ULP 假阳性）+ tHitG 钉非负', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('(-b - s > 1e-3) || (-b + s > 1e-3)')
    expect(s).not.toContain('(-b - s > 1e-6) || (-b + s > 1e-6)')
    expect(s).toContain('tHitG = max(tHitG, 0.0);')
  })

  it('clamp 下限 = 面上 10m（防地平线散射塌 0：h=0 时 cG=0 → tHitG 全塌 0 → 地平线无散射）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('CAMERA_MIN_ALT_KM = 0.01')
    expect(s).toContain('float cameraMinR = ATMOSPHERE.bottom_radius + CAMERA_MIN_ALT_KM;')
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

  it('M5 u_cloudsGodRaysGain 默认 1（物理精确），可覆盖', () => {
    const u1 = buildAtmosphereUniforms(stubLuts, validateAtmosphereOptions({}), makeState())
    expect(unwrap(u1, 'u_cloudsGodRaysGain')).toBe(1)
    const u2 = buildAtmosphereUniforms(
      stubLuts,
      validateAtmosphereOptions({ cloudsGodRaysGain: 20 }),
      makeState()
    )
    expect(unwrap(u2, 'u_cloudsGodRaysGain')).toBe(20)
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
  it('默认值（B 路径全量 + 动态曝光 + lensflare 默认 + depthTemporal temporal*）', () => {
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
      // limb outer glow（太空视角大气边缘扩散辉光）：默认 intensity 1.0（线性域独立加 finalColor）/ decay 30km
      limbGlowIntensity: 1.0,
      limbGlowDecayKm: 30.0,
      // M5 云 god rays 光柱增益默认 1（物理精确 subtle 对齐 three）
      cloudsGodRaysGain: 1.0,
      lensFlare: true,
      lensFlareIntensity: INTENSITY_DEFAULT,
      lensFlareThreshold: THRESHOLD_LEVEL_DEFAULT,
      lensFlareGhost: GHOST_AMOUNT_DEFAULT,
      lensFlareHalo: HALO_AMOUNT_DEFAULT,
      lensFlarePreBlur: 3.0, // preBlur 软化核偏移倍数（ghost/halo 模糊半径），默认 3.0（用户验收加大模糊）
      // depthTemporal temporal*（Task 12）：默认 EMA 开 + LOW/HIGH_ALPHA/DEPTH_THRESHOLD_DEFAULT
      temporalEma: true,
      temporalLowAlpha: 0.05, // LOW_ALPHA
      temporalHighAlpha: 0.5, // HIGH_ALPHA
      temporalDepthThreshold: 0.1, // DEPTH_THRESHOLD_DEFAULT
      // depthTemporal stage 创建开关（Phase 1.1 升级）：默认 false（不创建 stage 省 pass+blit+3 HF RT）
      depthTemporal: false
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
    postRender: { addEventListener: () => () => {} }, // Task 8 lifecycle 注册 postRender listener（assembly 测试不 trigger，仅需属性存在）
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
  it('HDR 设备（HALF_FLOAT）+ depthTemporal:true → depthTemporal 装配为 activeStages[0]（atmosphere 前）', () => {
    const { scene, addSpy } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
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

  it('默认（不传 depthTemporal）HDR 设备 → 不创建 stage（Phase 1.1 升级：默认 false，occlusion 回退 scene globe depth）', () => {
    const { scene, addSpy } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false })
    expect(handle.depthTemporalStage).toBeUndefined()
    expect(handle.temporalEmaEnabled).toBe(false)
    const added = addSpy.mock.calls.map((c: unknown[]) => c[0])
    expect(added.some((s) => (s as { name?: string })?.name?.match?.(/depth_temporal/i))).toBe(false)
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
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
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

  it('depthTemporal=false → 不创建 stage + 不注册 blit listener（Phase 1.1，?depthTemporal=0）', () => {
    const { scene, addSpy } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: false })
    expect(handle.depthTemporalStage).toBeUndefined()
    expect(handle.temporalEmaEnabled).toBe(false)
    const added = addSpy.mock.calls.map((c: unknown[]) => c[0])
    expect(added.some((s) => (s as { name?: string })?.name?.match?.(/depth_temporal/i))).toBe(false)
  })
})

// —— depthTemporal lifecycle（Task 8）：preRender resize + postRender blit/swap/prevVP/alpha ——
// 模块级 listener 存储（mockSceneWithDepthTemporal 每次调用清空，triggerPreRender/PostRender 触发）
const preRenderListeners: Array<(s?: unknown, t?: unknown) => void> = []
const postRenderListeners: Array<(s?: unknown, t?: unknown) => void> = []

// 扩展 mockScene：preRender/postRender event listener 存储（lifecycle 注册后可 trigger）+ camera mock
// （positionWC/directionWC/viewMatrix/frustum.projectionMatrix，postRender 更新 prevVP/alpha 读）。
function mockSceneWithDepthTemporal(opts: {
  halfFloat?: boolean
  drawingBufferWidth?: number
  drawingBufferHeight?: number
} = {}): { scene: import('cesium').Scene; addSpy: ReturnType<typeof vi.fn> } {
  preRenderListeners.length = 0
  postRenderListeners.length = 0
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
    camera: {
      positionWC: new Cartesian3(6378137, 0, 0),
      directionWC: new Cartesian3(0, 0, 1),
      viewMatrix: Matrix4.clone(Matrix4.IDENTITY),
      frustum: { projectionMatrix: Matrix4.clone(Matrix4.IDENTITY) }
    },
    drawingBufferWidth: opts.drawingBufferWidth ?? 1920,
    drawingBufferHeight: opts.drawingBufferHeight ?? 1080,
    preRender: {
      addEventListener: (cb: (s?: unknown, t?: unknown) => void) => {
        preRenderListeners.push(cb)
        return () => {
          const idx = preRenderListeners.indexOf(cb)
          if (idx >= 0) preRenderListeners.splice(idx, 1)
        }
      }
    },
    postRender: {
      addEventListener: (cb: (s?: unknown, t?: unknown) => void) => {
        postRenderListeners.push(cb)
        return () => {
          const idx = postRenderListeners.indexOf(cb)
          if (idx >= 0) postRenderListeners.splice(idx, 1)
        }
      }
    },
    postProcessStages: { add: addSpy, remove: () => false }
  } as unknown as import('cesium').Scene
  return { scene, addSpy }
}

// 触发 preRender listeners（lifecycle resize 检测 + 既有 sunDirection/exposure 更新）
function triggerPreRender(scene: import('cesium').Scene, time = new JulianDate()): void {
  preRenderListeners.forEach((cb) => cb(scene, time))
}

// 触发 postRender listeners（lifecycle blit/swap/prevVP/alpha）
function triggerPostRender(scene: import('cesium').Scene): void {
  postRenderListeners.forEach((cb) => cb(scene))
}

// 覆写 depthTemporal stage 的 outputTexture getter（node 无 _textureCache，原型 getter 返 undefined；
// 实例级 defineProperty 影子原型 getter，模拟 stage 就绪/未就绪两种态）。
function setDtOutputTexture(stage: PostProcessStage, value: unknown): void {
  Object.defineProperty(stage, 'outputTexture', {
    get: () => value,
    configurable: true
  })
}

describe('depthTemporal lifecycle', () => {
  beforeEach(() => {
    // 清 spy 调用记录（mockClear 不清 mockImplementation/mockReturnValue，factory 设的默认实现保留）
    dtSpies.createHistoryState.mockClear()
    dtSpies.buildBlitCommand.mockClear()
    dtSpies.buildHistoryFBO.mockClear()
    dtSpies.swapHistory.mockClear()
  })

  it('postRender：blit depthTemporal.outputTexture → write history + swap（lifecycle 全链）', () => {
    const { scene } = mockSceneWithDepthTemporal()
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    setDtOutputTexture(handle.depthTemporalStage!, { _texture: 'mock', _target: 0x0de1 })
    triggerPostRender(scene)
    // blit command 构造（src=outputTexture）+ history FBO 构造（write Tex）+ swap 翻转
    expect(dtSpies.buildBlitCommand).toHaveBeenCalledTimes(1)
    expect(dtSpies.buildHistoryFBO).toHaveBeenCalledTimes(1)
    expect(dtSpies.swapHistory).toHaveBeenCalledTimes(1)
  })

  it('postRender：outputTexture undefined → 跳过 blit（保持上帧 history，不 swap）', () => {
    const { scene } = mockSceneWithDepthTemporal()
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    setDtOutputTexture(handle.depthTemporalStage!, undefined)
    triggerPostRender(scene)
    expect(dtSpies.buildBlitCommand).not.toHaveBeenCalled()
    expect(dtSpies.buildHistoryFBO).not.toHaveBeenCalled()
    expect(dtSpies.swapHistory).not.toHaveBeenCalled()
  })

  it('resize：preRender 检测 drawingBufferWidth 变化 → 重建 history 到新尺寸', () => {
    const { scene } = mockSceneWithDepthTemporal({ drawingBufferWidth: 1920 })
    createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    // 构造期 createHistoryState 调一次（1920）
    expect(dtSpies.createHistoryState).toHaveBeenCalledTimes(1)
    expect(dtSpies.createHistoryState).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      1920,
      1080,
      expect.anything()
    )
    // resize：drawingBufferWidth 1920 → 3840
    ;(scene as unknown as { drawingBufferWidth: number }).drawingBufferWidth = 3840
    triggerPreRender(scene)
    // resize 触发 createHistoryState 二次调用（新尺寸 3840）
    expect(dtSpies.createHistoryState).toHaveBeenCalledTimes(2)
    expect(dtSpies.createHistoryState).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      3840,
      1080,
      expect.anything()
    )
  })

  it('首帧：postRender blit 当前 output 作 history 基线（非跳过/非 loadNull）', () => {
    const { scene } = mockSceneWithDepthTemporal()
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    setDtOutputTexture(handle.depthTemporalStage!, { _texture: 'mock', _target: 0x0de1 })
    // 首帧 postRender：outputTexture 就绪 → blit（作 history 基线，非跳过）
    triggerPostRender(scene)
    expect(dtSpies.buildBlitCommand).toHaveBeenCalledTimes(1)
  })

  it('postRender blit 后 prevViewProjection/temporalAlpha 更新（下帧 uniforms 自动反映）', () => {
    const { scene } = mockSceneWithDepthTemporal()
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    setDtOutputTexture(handle.depthTemporalStage!, { _texture: 'mock', _target: 0x0de1 })
    const dt = handle.depthTemporalStage!
    const uniforms = (dt as unknown as { uniforms: Record<string, unknown> }).uniforms
    // 构造期：temporalAlpha = HIGH_ALPHA（0.5，首帧偏 current）
    expect((uniforms.u_temporalAlpha as () => number)()).toBe(0.5)
    // 首帧 postRender：prevPos=ZERO → 巨大 positionDelta（6378137m）→ motion 高 → HIGH_ALPHA
    triggerPostRender(scene)
    expect((uniforms.u_temporalAlpha as () => number)()).toBeCloseTo(0.5, 5)
    // 次帧 postRender：首帧已更新 prevPos==camera.positionWC（静止）+ prevDir==directionWC
    // → positionDelta=0 + directionDelta=0 → motion=0 → smoothstep(0,1,0)=0 → LOW_ALPHA=0.05
    triggerPostRender(scene)
    expect((uniforms.u_temporalAlpha as () => number)()).toBeCloseTo(0.05, 5)
    // prevViewProjection 经 Matrix4.multiply(proj, view, new Matrix4()) 更新（新 Matrix4 实例，非 IDENTITY 引用）
    const prevVP = (uniforms.u_prevViewProjection as () => unknown)()
    expect(prevVP).not.toBe(Matrix4.IDENTITY)
  })

  it('destroy：清理 depthTemporal preRender/postRender listener（remove 后 trigger 不再调 blit）', () => {
    const { scene } = mockSceneWithDepthTemporal()
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    setDtOutputTexture(handle.depthTemporalStage!, { _texture: 'mock', _target: 0x0de1 })
    // 销毁前 listener 已注册
    expect(postRenderListeners.length).toBeGreaterThan(0)
    handle.destroy()
    // destroy 调 removeDtPreRender/removeDtPostRender → postRender lifecycle listener 从数组移除
    // （既有 sunDirection/exposure 等 preRender listener 也 remove，preRenderListeners 清空）
    expect(postRenderListeners.length).toBe(0)
    // destroy 后 trigger：blit 不再被调（listener 已 remove）
    const before = dtSpies.buildBlitCommand.mock.calls.length
    triggerPostRender(scene)
    expect(dtSpies.buildBlitCommand.mock.calls.length).toBe(before)
  })
})

// —— depthTemporal options 参数化（Task 12）：temporal* options 透传 + URL 验收 ——
// temporalEma option 控制 EMA on/off（非 stage 创建与否）：
// - HDR + temporalEma=true（默认）→ stage 创建 + enabled=true EMA 消抖
// - HDR + temporalEma=false（?temporalEma=0）→ stage 仍创建 + enabled=false 透传（atmosphere 读 .a=raw log-depth 仍有效）
// - UNSIGNED_BYTE → 不创建 stage（temporalEmaEnabled=false + depthTemporalStage undefined）
describe('depthTemporal options 参数化（Task 12）', () => {
  it('默认 temporal* options（temporalEma=true / low=0.05 / high=0.5 / threshold=0.1）', () => {
    const r = validateAtmosphereOptions({})
    expect(r.temporalEma).toBe(true)
    expect(r.temporalLowAlpha).toBe(0.05) // LOW_ALPHA
    expect(r.temporalHighAlpha).toBe(0.5) // HIGH_ALPHA
    expect(r.temporalDepthThreshold).toBe(0.1) // DEPTH_THRESHOLD_DEFAULT
  })

  it('temporalEma option 可覆盖（?temporalEma=0 → false；自定义 alpha/threshold 透传）', () => {
    const r = validateAtmosphereOptions({
      temporalEma: false,
      temporalLowAlpha: 0.1,
      temporalHighAlpha: 0.8,
      temporalDepthThreshold: 0.05
    })
    expect(r.temporalEma).toBe(false)
    expect(r.temporalLowAlpha).toBe(0.1)
    expect(r.temporalHighAlpha).toBe(0.8)
    expect(r.temporalDepthThreshold).toBe(0.05)
  })

  it('temporalEma=false（HDR）→ temporalEmaEnabled=false 但 depthTemporal stage 仍创建（enabled=false 透传）', () => {
    // 注意（spec 前置查证 #6）：temporalEma=false 不跳过 stage 创建（HDR 时仍创建），而是 depthTemporal
    // shader 走 enabled=false 透传路径 vec4(sceneColor, curLogDepth)，atmosphere 读 .a=raw log-depth 仍有效
    // （Task 9 已移除 czm_readDepth，依赖 depthTemporal 打包 .a 通道；若 stage 不创建则 atmosphere 读 scene
    // alpha 无意义）。仅 UNSIGNED_BYTE 才完全跳过 stage。temporalEmaEnabled=false 控制 lensFlare occlusion
    // depth 源回退 scene globe depth（passthrough .r=sceneColor 非 depth，不能用）。
    const { scene } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, temporalEma: false, depthTemporal: true })
    expect(handle.temporalEmaEnabled).toBe(false)
    expect(handle.depthTemporalStage).toBeDefined() // stage 仍创建（HDR，透传模式）
    // shader 走 enabled=false 透传路径：无 u_historyTexture/u_temporalAlpha（EMA 路径才声明），含 curLogDepth 透传
    const frag = (handle.depthTemporalStage as unknown as { fragmentShader: string }).fragmentShader
    expect(frag).not.toContain('u_historyTexture')
    expect(frag).not.toContain('u_temporalAlpha')
    expect(frag).toContain('curLogDepth') // 透传本帧 raw log-depth 到 .a
  })

  it('temporalEma=true（默认，HDR）→ temporalEmaEnabled=true + stage enabled=true EMA shader', () => {
    const { scene } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: true })
    expect(handle.temporalEmaEnabled).toBe(true)
    expect(handle.depthTemporalStage).toBeDefined()
    // EMA shader 声明 u_historyTexture/u_temporalAlpha
    const frag = (handle.depthTemporalStage as unknown as { fragmentShader: string }).fragmentShader
    expect(frag).toContain('u_historyTexture')
    expect(frag).toContain('u_temporalAlpha')
  })

  it('temporalDepthThreshold 透传到 depthTemporal u_depthThreshold uniform（非默认 0.1）', () => {
    const { scene } = mockSceneWithAddSpy({ halfFloat: true })
    const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, temporalDepthThreshold: 0.05, depthTemporal: true })
    const uniforms = (handle.depthTemporalStage as unknown as { uniforms: Record<string, unknown> }).uniforms
    expect(uniforms.u_depthThreshold).toBe(0.05) // 非 DEPTH_THRESHOLD_DEFAULT(0.1)
  })

  it('temporalLowAlpha/temporalHighAlpha 透传到 lifecycle computeTemporalAlpha（high preset）', () => {
    // 自定义 alpha（high preset 0.1/0.8）→ lifecycle postRender：首帧大 motion → highAlpha(0.8)；
    // 次帧静止 → motion=0 → lowAlpha(0.1)（非默认 0.05/0.5）
    const { scene } = mockSceneWithDepthTemporal()
    const handle = createAtmosphereStage(scene, stubLuts, {
      lensFlare: false,
      depthTemporal: true,
      temporalLowAlpha: 0.1, // high preset lowAlpha（默认 0.05）
      temporalHighAlpha: 0.8 // high preset highAlpha（默认 0.5）
    })
    setDtOutputTexture(handle.depthTemporalStage!, { _texture: 'mock', _target: 0x0de1 })
    const uniforms = (handle.depthTemporalStage as unknown as { uniforms: Record<string, unknown> }).uniforms
    // 首帧 postRender：prevPos=ZERO → 巨大 positionDelta → motion 高 → highAlpha=0.8（自定义）
    triggerPostRender(scene)
    expect((uniforms.u_temporalAlpha as () => number)()).toBeCloseTo(0.8, 5)
    // 次帧 postRender：首帧已更新 prevPos==camera.positionWC（静止）→ motion=0 → lowAlpha=0.1（自定义）
    triggerPostRender(scene)
    expect((uniforms.u_temporalAlpha as () => number)()).toBeCloseTo(0.1, 5)
  })
})
