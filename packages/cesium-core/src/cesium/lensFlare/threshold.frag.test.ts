import { describe, expect, it } from 'vitest'
import { compileFragment } from '../glslangUtil'
import { buildThresholdFragmentShader, buildStandaloneShaderForValidation, THRESHOLD_UNIFORM_NAMES } from './threshold.frag'
import { LEARNOGLY_DOWNSAMPLE_WEIGHTS } from './lensFlareConstants'

describe('buildThresholdFragmentShader', () => {
  it('含 learnopengl 13-tap 加权（非均匀平均）', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('0.125')
    expect(s).toContain('0.0625')
    expect(s).toContain('0.03125')
  })
  it('I-3: GLSL 权重字面量与 LEARNOGLY_DOWNSAMPLE_WEIGHTS 常量对象一致', () => {
    // 交叉断言：GLSL 内硬编码的权重数值必须等于 lensFlareConstants 的对象值
    // （单源真理，防 GLSL 字面量与常量对象漂移）。
    const s = buildThresholdFragmentShader()
    expect(s).toContain(String(LEARNOGLY_DOWNSAMPLE_WEIGHTS.center))      // 0.125
    expect(s).toContain(String(LEARNOGLY_DOWNSAMPLE_WEIGHTS.edgeMid))     // 0.0625
    expect(s).toContain(String(LEARNOGLY_DOWNSAMPLE_WEIGHTS.outerCorner)) // 0.03125
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

// lf×云交互 #2（2026-08-30，用户拍板 A）：threshold 排除云 + 接 occlusion。
// ① 源钉 atmosphere（createLensFlareStage 覆盖 colorTexture uniform-name string——clouds overlay
//    在 atmo 与 lf 之间时 bloom 不再读含云画面，亮云不误触发光源）；
// ② 输出乘 occlusion visibility：太阳被云/地形挡时 bloom 随之衰减。occlusion 是空间常数标量
//    （全图同值），非太阳亮源同衰减——本产品语境近似正确（主要非太阳亮源=水面太阳 specular，
//    物理上确随太阳遮挡减弱）。
describe('lf×云交互 #2：occlusion 调制', () => {
  it('声明 u_occlusionTexture + 输出乘 visibility（.r）', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('uniform sampler2D u_occlusionTexture')
    expect(s).toMatch(/result\s*\*=\s*texture\(u_occlusionTexture[^)]*\)\.r/)
  })
  it('NaN 守护仍存在（乘法不破坏 isnan 归零）', () => {
    const s = buildThresholdFragmentShader()
    expect(s).toContain('isnan')
  })
  it('THRESHOLD_UNIFORM_NAMES 含 u_occlusionTexture（与声明一致性测试联动）', () => {
    expect(THRESHOLD_UNIFORM_NAMES).toContain('u_occlusionTexture')
  })
  it('glslang 编译通过（含 occlusion 调制）', () => {
    const standalone = buildStandaloneShaderForValidation()
    const result = compileFragment(standalone)
    if (!result.ok) {
      throw new Error(`glslangValidator 编译失败（threshold occlusion）:\n${result.output}`)
    }
    expect(result.ok).toBe(true)
  })
})
