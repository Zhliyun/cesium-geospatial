import { describe, expect, it } from 'vitest'
import { buildThresholdFragmentShader, buildStandaloneShaderForValidation, THRESHOLD_UNIFORM_NAMES } from './threshold.frag'

describe('buildThresholdFragmentShader', () => {
  it('含 learnopengl 13-tap 加权（非均匀平均）', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('0.125')
    expect(s).toContain('0.0625')
    expect(s).toContain('0.03125')
  })
  it('含 luminance smoothstep 软阈值 + NaN 守护', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('smoothstep')
    expect(s).toContain('isnan')
  })
  it('声明 colorTexture（series input）+ threshold uniforms', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
    expect(s).toContain('uniform vec2 u_texelSize')
    expect(s).toContain('uniform float u_thresholdLevel')
  })
  it('不含均匀平均 /13.0', () => {
    const s = buildThresholdFragmentShader()
    expect(s).not.toContain('/ 13.0')
    expect(s).not.toContain('/13.0')
  })
})
describe('THRESHOLD_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单）', () => {
    const s = buildThresholdFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(THRESHOLD_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + out_FragColor + luminance/saturate define', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
    expect(s).toContain('luminance')
  })
})
