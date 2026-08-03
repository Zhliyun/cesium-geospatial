import { describe, it, expect } from 'vitest'
import { Cartesian3, Ellipsoid } from 'cesium'
import {
  buildAerialPerspectiveFragmentShader,
  AERIAL_PERSPECTIVE_UNIFORM_NAMES
} from './aerialPerspective.frag'
import {
  validateAtmosphereOptions,
  buildAtmosphereUniforms,
  getEffectiveAtmosphereExposure,
  type AtmosphereFrameState
} from './AtmosphereStage'
import { SUN_ANGULAR_RADIUS } from '../math/atmosphereParameters'
import type { AtmosphereLUTs } from './lutLoader'

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
  it('默认值（B 路径全量 + 动态曝光）', () => {
    expect(validateAtmosphereOptions({})).toEqual({
      sun: true,
      sky: true,
      exposureFollowTimeline: true,
      exposureDay: 1.5,
      exposureNight: 0.1,
      exposureTwilightAngleDegrees: 6,
      exposure: 1.5,
      debugMode: 0
    })
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
