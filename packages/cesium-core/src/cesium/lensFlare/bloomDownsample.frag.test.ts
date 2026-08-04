// Task 3 测试：bloomDownsample.frag（CoD:AW 13-tap downsample）。
// 关键纪律：权重必须是 CoD:AW 的 0.125/0.05556，绝不能混入 learnopengl 的
// 0.0625/0.03125（后者用于 threshold.frag，核几何同但权重不同，spec §5.2 / 评审 I4）。
import { describe, expect, it } from 'vitest'
import { buildBloomDownsampleFragmentShader, buildStandaloneShaderForValidation, BLOOM_DOWNSAMPLE_UNIFORM_NAMES } from './bloomDownsample.frag'
import { CODAW_DOWNSAMPLE_WEIGHTS } from './lensFlareConstants'

describe('buildBloomDownsampleFragmentShader', () => {
  it('含 CoD:AW 权重 0.125 + 0.05556', () => {
    const s = buildBloomDownsampleFragmentShader()
    expect(s).toContain('0.125')
    expect(s).toContain('0.05556')
  })
  it('I-3: GLSL 权重字面量与 CODAW_DOWNSAMPLE_WEIGHTS 常量对象一致', () => {
    // 交叉断言：GLSL 内硬编码的权重数值必须等于 lensFlareConstants 的对象值。
    // 注意 outer=0.05556 是 1/18 的截断近似，GLSL 字面量与常量都用同截断值。
    const s = buildBloomDownsampleFragmentShader()
    expect(s).toContain(String(CODAW_DOWNSAMPLE_WEIGHTS.inner)) // 0.125
    expect(s).toContain(String(CODAW_DOWNSAMPLE_WEIGHTS.outer)) // 0.05556
  })
  it('不含 learnopengl 权重 0.0625/0.03125（防混核，评审 I4）', () => {
    const s = buildBloomDownsampleFragmentShader()
    expect(s).not.toContain('0.0625')
    expect(s).not.toContain('0.03125')
  })
  it('声明 colorTexture（series 前驱）+ u_texelSize', () => {
    const s = buildBloomDownsampleFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
    expect(s).toContain('uniform vec2 u_texelSize')
  })
})

describe('BLOOM_DOWNSAMPLE_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单）', () => {
    const s = buildBloomDownsampleFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(BLOOM_DOWNSAMPLE_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})

describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + out_FragColor', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
  })
})
