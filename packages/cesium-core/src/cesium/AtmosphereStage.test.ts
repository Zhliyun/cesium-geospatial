import { describe, it, expect } from 'vitest'
import { Cartesian3, Ellipsoid, type Scene } from 'cesium'
import {
  buildAerialPerspectiveFragmentShader,
  AERIAL_PERSPECTIVE_UNIFORM_NAMES
} from './aerialPerspective.frag'
import {
  validateAtmosphereOptions,
  resolveGeometricErrorCorrectionAmount,
  buildAtmosphereUniforms,
  type AtmosphereFrameState
} from './AtmosphereStage'
import { computeGeometricErrorCorrectionAmount } from './geometricErrorCorrection'
import { SUN_ANGULAR_RADIUS } from '../math/atmosphereParameters'
import type { AtmosphereLUTs } from './lutLoader'

// —— 测试桩：node 环境无 WebGL，PostProcessStage 不实例化，只测纯函数 ——

// 最小 Scene 桩：buildAtmosphereUniforms 只读 globe.ellipsoid 与 camera.frustum
function makeStubScene() {
  return {
    globe: { ellipsoid: Ellipsoid.WGS84 },
    camera: { frustum: { near: 1, far: 1e9 } }
  } as unknown as Scene
}

const stubLuts = {
  transmittance: { tag: 'transmittance' },
  scattering: { tag: 'scattering' },
  irradiance: { tag: 'irradiance' }
} as unknown as AtmosphereLUTs

function makeState(): AtmosphereFrameState {
  return {
    sunDirection: new Cartesian3(0, 0, 1),
    altitudeCorrection: new Cartesian3(),
    geometricErrorCorrectionAmount: 0
  }
}

// uniforms 值既可能是闭包也可能是静态值，统一解包
function unwrap(uniforms: Record<string, unknown>, name: string): unknown {
  const v = uniforms[name]
  return typeof v === 'function' ? (v as () => unknown)() : v
}

// 标准透视投影矩阵（列主序，与 T4 测试同一构造）
function makePerspectiveMatrix(
  fovYRad: number,
  aspect: number,
  near: number,
  far: number
): number[] {
  const f = 1 / Math.tan(fovYRad / 2)
  const m = new Array(16).fill(0)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) / (near - far)
  m[11] = -1
  m[14] = (2 * far * near) / (near - far)
  return m
}
const PROJ_FOV60 = makePerspectiveMatrix((60 * Math.PI) / 180, 1, 1, 1e9)

describe('uniform 接线一致性', () => {
  it('shader 声明的 uniform 都被 uniforms 清单覆盖（除 czm_*/colorTexture/depthTexture）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sunLight: true, skyLight: true })
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture', 'depthTexture'])
    const missing = declared.filter(
      n => !n.startsWith('czm_') && !whitelist.has(n) && !AERIAL_PERSPECTIVE_UNIFORM_NAMES.includes(n)
    )
    expect(missing).toEqual([])
  })

  it('buildAtmosphereUniforms 的键集合与 AERIAL_PERSPECTIVE_UNIFORM_NAMES 完全一致', () => {
    const uniforms = buildAtmosphereUniforms(makeStubScene(), stubLuts, {}, makeState())
    const keys = Object.keys(uniforms).sort()
    expect(keys).toEqual([...AERIAL_PERSPECTIVE_UNIFORM_NAMES].sort())
  })
})

describe('buildAtmosphereUniforms', () => {
  it('ellipsoidRadii = WGS84 radii * 0.001（米 → km）', () => {
    const uniforms = buildAtmosphereUniforms(makeStubScene(), stubLuts, {}, makeState())
    const radii = unwrap(uniforms, 'ellipsoidRadii') as Cartesian3
    expect(radii.x).toBeCloseTo(Ellipsoid.WGS84.radii.x * 0.001, 9)
    expect(radii.y).toBeCloseTo(Ellipsoid.WGS84.radii.y * 0.001, 9)
    expect(radii.z).toBeCloseTo(Ellipsoid.WGS84.radii.z * 0.001, 9)
  })

  it('cosSunAngularRadius = cos(SUN_ANGULAR_RADIUS)', () => {
    const uniforms = buildAtmosphereUniforms(makeStubScene(), stubLuts, {}, makeState())
    expect(unwrap(uniforms, 'cosSunAngularRadius')).toBeCloseTo(
      Math.cos(SUN_ANGULAR_RADIUS),
      12
    )
  })

  it('数值 options 默认值：albedoScale=1、exposure=3.0、u_debugMode=0', () => {
    const uniforms = buildAtmosphereUniforms(makeStubScene(), stubLuts, {}, makeState())
    expect(unwrap(uniforms, 'albedoScale')).toBe(1)
    expect(unwrap(uniforms, 'exposure')).toBe(3.0)
    expect(unwrap(uniforms, 'u_debugMode')).toBe(0)
  })

  it('数值 options 可覆盖', () => {
    const uniforms = buildAtmosphereUniforms(
      makeStubScene(),
      stubLuts,
      { albedoScale: 0.5, exposure: 2.0, debugMode: 1 },
      makeState()
    )
    expect(unwrap(uniforms, 'albedoScale')).toBe(0.5)
    expect(unwrap(uniforms, 'exposure')).toBe(2.0)
    expect(unwrap(uniforms, 'u_debugMode')).toBe(1)
  })

  it('LUT 纹理接线：transmittance/scattering/irradiance 来自 luts，single_mie 传 scattering 同值', () => {
    const uniforms = buildAtmosphereUniforms(makeStubScene(), stubLuts, {}, makeState())
    expect(unwrap(uniforms, 'transmittance_texture')).toBe(stubLuts.transmittance)
    expect(unwrap(uniforms, 'scattering_texture')).toBe(stubLuts.scattering)
    expect(unwrap(uniforms, 'single_mie_scattering_texture')).toBe(stubLuts.scattering)
    expect(unwrap(uniforms, 'irradiance_texture')).toBe(stubLuts.irradiance)
  })

  it('cameraNear/cameraFar 闭包每帧读 scene.camera.frustum（反射后续变更）', () => {
    const scene = makeStubScene()
    const uniforms = buildAtmosphereUniforms(scene, stubLuts, {}, makeState())
    expect(unwrap(uniforms, 'cameraNear')).toBe(1)
    expect(unwrap(uniforms, 'cameraFar')).toBe(1e9)
    scene.camera.frustum.near = 10
    scene.camera.frustum.far = 2e9
    expect(unwrap(uniforms, 'cameraNear')).toBe(10)
    expect(unwrap(uniforms, 'cameraFar')).toBe(2e9)
  })

  it('每帧闭包反射 state：sunDirection/altitudeCorrection/geometricErrorCorrectionAmount', () => {
    const state = makeState()
    const uniforms = buildAtmosphereUniforms(makeStubScene(), stubLuts, {}, state)
    expect(unwrap(uniforms, 'geometricErrorCorrectionAmount')).toBe(0)
    state.geometricErrorCorrectionAmount = 0.7
    expect(unwrap(uniforms, 'geometricErrorCorrectionAmount')).toBe(0.7)
    // Cartesian3 传引用：preRender 原地更新，闭包拿到同一对象
    expect(unwrap(uniforms, 'sunDirection')).toBe(state.sunDirection)
    expect(unwrap(uniforms, 'altitudeCorrection')).toBe(state.altitudeCorrection)
  })
})

describe('validateAtmosphereOptions', () => {
  it('默认全 true + 数值默认（A 路径全量大气）', () => {
    const o = validateAtmosphereOptions({})
    expect(o).toEqual({
      sunLight: true,
      skyLight: true,
      transmittance: true,
      inscatter: true,
      sun: true,
      ground: true,
      correctGeometricError: true,
      sky: true,
      albedoScale: 1,
      exposure: 3.0,
      debugMode: 0
    })
  })

  it('非法组合：sun:true 但 sky:false → throw（日盘在天空分支内）', () => {
    expect(() => validateAtmosphereOptions({ sun: true, sky: false })).toThrow(/sun/i)
  })

  it('合法组合不报错：B 路径 / 仅透射 / 仅内散射 / sky:false + sun:false', () => {
    // B 路径：无 SUN_LIGHT/SKY_LIGHT
    expect(() =>
      validateAtmosphereOptions({ sunLight: false, skyLight: false })
    ).not.toThrow()
    // 调试：仅透射（无天空分支，须同时关 sun）
    expect(() =>
      validateAtmosphereOptions({
        sunLight: false,
        skyLight: false,
        inscatter: false,
        sun: false,
        sky: false
      })
    ).not.toThrow()
    // 调试：仅内散射
    expect(() =>
      validateAtmosphereOptions({
        sunLight: false,
        skyLight: false,
        transmittance: false,
        sun: false,
        sky: false
      })
    ).not.toThrow()
    // sky:false 且显式 sun:false（远平面直通）
    expect(() => validateAtmosphereOptions({ sun: false, sky: false })).not.toThrow()
  })

  it('部分字段覆盖，其余保持默认', () => {
    const o = validateAtmosphereOptions({ skyLight: false, exposure: 1.5 })
    expect(o.skyLight).toBe(false)
    expect(o.sunLight).toBe(true)
    expect(o.exposure).toBe(1.5)
    expect(o.albedoScale).toBe(1)
  })
})

describe('resolveGeometricErrorCorrectionAmount（T5 移交契约）', () => {
  it('correctGeometricError === false 时强制 0（shader 中 (1-0)=1 退化为源行为）', () => {
    // 近地/太空两种极端都必须是 0
    expect(
      resolveGeometricErrorCorrectionAmount(false, 1, PROJ_FOV60, 6378137)
    ).toBe(0)
    expect(
      resolveGeometricErrorCorrectionAmount(false, 1e8, PROJ_FOV60, 6378137)
    ).toBe(0)
  })

  it('correctGeometricError === true 时透传 T4 计算结果', () => {
    const h = 4e5
    expect(resolveGeometricErrorCorrectionAmount(true, h, PROJ_FOV60, 6378137)).toBe(
      computeGeometricErrorCorrectionAmount(h, PROJ_FOV60, 6378137)
    )
  })
})
