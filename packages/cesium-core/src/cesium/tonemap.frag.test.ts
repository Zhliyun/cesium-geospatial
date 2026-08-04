import { describe, expect, it } from 'vitest'
import {
  buildTonemapFragmentShader,
  buildStandaloneShaderForValidation,
  TONEMAP_UNIFORM_NAMES
} from './tonemap.frag'

describe('buildTonemapFragmentShader（链尾 ToneMapping stage）', () => {
  it('含 ACES + gamma 1/2.2 + display dithering（与 phase1 tonemapDisplay 等价）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('ACESFilmic(')
    expect(s).toContain('pow(t, vec3(1.0 / 2.2))')
    expect(s).toContain('interleavedGradientNoise')
    expect(s).toContain('1.5 / 255.0')
  })

  it('display dithering 系数 × u_ditherScale（与 atmosphere input dithering 同源强度倍率）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('uniform float u_ditherScale')
    expect(s).toContain('dither * 1.5 / 255.0 * u_ditherScale')
  })

  it('debug=1..6 透传（atmosphere 已输出 display ready 可视化值）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('u_debugMode > 0.5')
    expect(s).toMatch(/u_debugMode > 0\.5[^6]*return/)
  })

  it('debug=7 线性归一化 false-color（证明 HalfFloat 承载 >1，评审 C2 可证伪方案）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('u_debugMode > 6.5')
    expect(s).toContain('clamp(c.rgb / 5.0, 0.0, 1.0)')
  })

  it('不含 input dithering（input dithering 留 atmosphere stage）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).not.toContain('inDither')
    expect(s).not.toContain('originalColor')
  })

  it('无 exposure uniform（exposure 在 atmosphere 线性段乘过）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).not.toMatch(/uniform\s+float\s+exposure/)
  })

  it('声明 colorTexture（Cesium 内建，shader 须显式声明）+ u_debugMode', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
    expect(s).toContain('uniform float u_debugMode')
  })

  it('ACES 常数 + dithering 系数钉死（与 phase1 tonemapDisplay 一字不差）', () => {
    const s = buildTonemapFragmentShader()
    expect(s).toContain('const float a = 2.51;')
    expect(s).toContain('const float b = 0.03;')
    expect(s).toContain('const float c = 2.43;')
    expect(s).toContain('const float d = 0.59;')
    expect(s).toContain('const float e = 0.14;')
    expect(s).toContain('52.9829189') // interleavedGradientNoise 系数
    expect(s).toContain('vec2(0.06711056, 0.00583715)') // IGN 系数
    expect(s).toContain('vec2(7.11, 5.17)') // display dithering offset
  })
})

describe('TONEMAP_UNIFORM_NAMES', () => {
  it('u_debugMode + u_ditherScale（colorTexture 是 Cesium 内建白名单）', () => {
    expect(TONEMAP_UNIFORM_NAMES).toEqual(['u_debugMode', 'u_ditherScale'])
  })

  it('TONEMAP_UNIFORM_NAMES 与 shader 声明的 uniform 一致（colorTexture 白名单）', () => {
    const s = buildTonemapFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture']) // Cesium 内建
    const expected = declared.filter(n => !whitelist.has(n))
    expect(TONEMAP_UNIFORM_NAMES).toEqual(expected)
  })
})

describe('buildStandaloneShaderForValidation（glslang 用）', () => {
  it('以 #version 300 es 开头 + out_FragColor 桩', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
  })
})
