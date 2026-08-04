// Task 5 测试：preBlur.frag（Kawase 8 邻域软化 threshold，spec §5.4 / C1 修复）。
// 关键纪律：preBlur 是 lensflare non-series 兄弟 stage，主 colorTexture = atmosphere
// （non-series input），但 preBlur 不采样它——声明仅为满足 Cesium stage 必声明要求。
// 实际软化输入是 u_thresholdTexture（uniform-name string 引用 lf_threshold stage），
// Kawase-like 8 邻域 box 近似 KawaseBlurPass SMALL 单 pass，软化 ghost/halo 输入。
import { describe, expect, it } from 'vitest'
import { buildPreBlurFragmentShader, buildStandaloneShaderForValidation, PREBLUR_UNIFORM_NAMES } from './preBlur.frag'

describe('buildPreBlurFragmentShader', () => {
  it('含 Kawase 8 邻域软化（u_texelSize 偏移采样）', () => {
    const s = buildPreBlurFragmentShader()
    expect(s).toContain('u_texelSize')
    expect(s).toContain('texture(u_thresholdTexture')  // 多次采样 u_thresholdTexture
    const refs = (s.match(/texture\(u_thresholdTexture/g) ?? []).length
    expect(refs).toBeGreaterThanOrEqual(8)  // 8 邻域
  })
  it('声明 u_thresholdTexture（uniform-name 引用 lf_threshold）+ u_texelSize', () => {
    const s = buildPreBlurFragmentShader()
    expect(s).toContain('uniform sampler2D u_thresholdTexture')
    expect(s).toContain('uniform vec2 u_texelSize')
  })
  it('声明 colorTexture（non-series input=atmosphere，preBlur 不采样但 Cesium 要求声明）', () => {
    const s = buildPreBlurFragmentShader()
    expect(s).toContain('uniform sampler2D colorTexture')
  })
})
describe('PREBLUR_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单；u_thresholdTexture uniform-name 引用须列入）', () => {
    const s = buildPreBlurFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(PREBLUR_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + out_FragColor + u_thresholdTexture 桩', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
    expect(s).toContain('uniform sampler2D u_thresholdTexture')
  })
})
