// Task 4 测试：bloomUpsample.frag（9-tap + mix radius=0.85）。
// 关键纪律：9-tap 权重 center 0.25 / 边 0.125 / 角 0.0625（和=1.0），
// mix(support, c, u_upsampleRadius) 控制 bloom 软硬（85% 模糊 + 15% 锐）。
// u_downLevel 是 uniform-name string 引用对应 down 级（强制依赖，避同 scale
// framebuffer 共享冲刷，spec §5.3 / 评审 I9），须列入 uniform-name 白名单。
import { describe, expect, it } from 'vitest'
import { buildBloomUpsampleFragmentShader, buildStandaloneShaderForValidation, BLOOM_UPSAMPLE_UNIFORM_NAMES } from './bloomUpsample.frag'
import { UPSAMPLE_WEIGHTS } from './lensFlareConstants'

describe('buildBloomUpsampleFragmentShader', () => {
  it('含 9-tap 权重 0.0625/0.125/0.25', () => {
    const s = buildBloomUpsampleFragmentShader()
    expect(s).toContain('0.0625')
    expect(s).toContain('0.125')
    expect(s).toContain('0.25')
  })
  it('I-3: GLSL 权重字面量与 UPSAMPLE_WEIGHTS 常量对象一致', () => {
    // 交叉断言：GLSL 内硬编码的权重数值必须等于 lensFlareConstants 的对象值
    // （单源真理，防 GLSL 字面量与常量对象漂移）。
    const s = buildBloomUpsampleFragmentShader()
    expect(s).toContain(String(UPSAMPLE_WEIGHTS.center))  // 0.25
    expect(s).toContain(String(UPSAMPLE_WEIGHTS.edge))    // 0.125
    expect(s).toContain(String(UPSAMPLE_WEIGHTS.corner))  // 0.0625
  })
  it('含 mix( + u_upsampleRadius', () => {
    const s = buildBloomUpsampleFragmentShader()
    expect(s).toContain('mix(')
    expect(s).toContain('u_upsampleRadius')
  })
  it('声明 colorTexture（series 前驱）+ u_downLevel（uniform-name 引用 down 级）+ u_upsampleRadius + u_texelSize', () => {
    const s = buildBloomUpsampleFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
    expect(s).toContain('uniform sampler2D u_downLevel')
    expect(s).toContain('uniform float u_upsampleRadius')
    expect(s).toContain('uniform vec2 u_texelSize')
  })
})
describe('BLOOM_UPSAMPLE_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单；u_downLevel 是 uniform-name 引用须列入）', () => {
    const s = buildBloomUpsampleFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(BLOOM_UPSAMPLE_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + out_FragColor + u_downLevel 桩 sampler2D', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
    expect(s).toContain('uniform sampler2D u_downLevel')
  })
})
