// Task 6 测试：features.frag（9 ghosts + halo + 色散，采 preBlur，spec §5.4 / C1 忠实移植）。
// 关键纪律（C1）：
//   - ghost 与 halo 都采 u_preBlurTexture（非 v1 的 ghost 采 threshold / halo 采 bloom）——
//     preBlur 是统一软化核，避免 ghost/halo 各自重复软化。
//   - occlusion 仅乘 ghosts/halo（bloom 不衰减——image-based threshold 天然处理被挡太阳）。
//   - 9 ghost 的 offset/tint 从 lensFlareConstants.ts 注入（单一来源，非硬编码重复）。
//   - vec2 aspect（非 vec3 笔误）。
import { describe, expect, it } from 'vitest'
import { buildFeaturesFragmentShader, buildStandaloneShaderForValidation, FEATURES_UNIFORM_NAMES } from './features.frag'

describe('buildFeaturesFragmentShader', () => {
  it('9 ghosts（offset/tint 从 constants 注入）+ clamp(d,0,1) + pow(1-d,3)', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('pow(1.0 - d, 3.0)')
    expect(s).toContain('clamp(length(0.5 - suv)')  // clamp 防负色
    expect(s.match(/for\s*\(\s*int\s+i/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })
  it('ghost + halo 都采 u_preBlurTexture（C1 忠实移植，非采 threshold/bloom）', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('uniform sampler2D u_preBlurTexture')
    const preBlurRefs = (s.match(/u_preBlurTexture/g) ?? []).length
    expect(preBlurRefs).toBeGreaterThanOrEqual(3) // 声明 + ghost + halo ≥3
    expect(s).not.toContain('u_bloomTexture') // features 不采 bloom（bloom 进 composite）
  })
  it('halo cubicRingMask + 色散 R/G/B 偏移', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('cubicRingMask')
    expect(s).toContain('vec3(-1.0, 0.0, 1.0)')
  })
  it('occlusion 仅乘 ghosts/halo（不乘 bloom）', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('u_occlusionTexture')
    expect(s).toMatch(/\*\s*occ/)
  })
  it('vec2 aspect（非 vec3 笔误）', () => {
    const s = buildFeaturesFragmentShader()
    expect(s).toContain('vec2 aspect')
    expect(s).not.toContain('vec3 aspect')
  })
})
describe('FEATURES_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单；u_preBlurTexture/u_occlusionTexture uniform-name 引用须列入）', () => {
    const s = buildFeaturesFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(FEATURES_UNIFORM_NAMES).toEqual(declared.filter(n => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + 桩（u_preBlurTexture/u_occlusionTexture sampler2D）', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('uniform sampler2D u_preBlurTexture')
    expect(s).toContain('uniform sampler2D u_occlusionTexture')
  })
})
