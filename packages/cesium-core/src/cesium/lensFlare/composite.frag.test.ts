// Task 9 测试：composite.frag（atmosphere + (bloom+features)*intensity 加法叠加，spec §5.6）。
// 关键纪律：
//   - 主 colorTexture = atmosphere，input dithering 在此，**NEAREST 保 phase1 水波纹修复**
//     （spec §5.7：dithering 真正保护点 = 仅 lf_composite 主 colorTexture 必须 NEAREST）。
//   - 线性域加法叠加 atmosphere + (bloom + features) * u_intensity，链尾 tonomap ACES 收尾
//     （composite 不做 tonemap，仅线性累加）。
//   - u_bloomTexture（lf_up4）/ u_featuresTexture（lf_features）是 uniform-name string 引用
//     （non-series 兄弟 stage，须显式字面量绑定强制依赖），列入 COMPOSITE_UNIFORM_NAMES。
//   - colorTexture 是 Cesium 内建白名单（不列入）。
import { describe, expect, it } from 'vitest'
import {
  buildCompositeFragmentShader,
  buildStandaloneShaderForValidation,
  COMPOSITE_UNIFORM_NAMES
} from './composite.frag'

describe('buildCompositeFragmentShader', () => {
  it('读 atmosphere（主 colorTexture）+ bloom + features 加法叠加 * intensity', () => {
    const s = buildCompositeFragmentShader()
    expect(s).toContain('texture(colorTexture,') // 主 atmosphere
    expect(s).toContain('(bloom + features)') // 或 bloom + features
    expect(s).toContain('u_intensity')
    expect(s).toContain('atmosphere') // 变量名体现 atmosphere 原色
  })
  it('声明 u_bloomTexture + u_featuresTexture + u_intensity（uniform-name 引用）', () => {
    const s = buildCompositeFragmentShader()
    expect(s).toContain('uniform sampler2D u_bloomTexture')
    expect(s).toContain('uniform sampler2D u_featuresTexture')
    expect(s).toContain('uniform float u_intensity')
  })
})
describe('COMPOSITE_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture 白名单；u_bloomTexture/u_featuresTexture uniform-name 引用须列入）', () => {
    const s = buildCompositeFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1])
    const whitelist = new Set(['colorTexture'])
    expect(COMPOSITE_UNIFORM_NAMES).toEqual(declared.filter((n) => !whitelist.has(n)))
  })
})
describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + out_FragColor + u_bloomTexture/u_featuresTexture 桩', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
    expect(s).toContain('uniform sampler2D u_bloomTexture')
    expect(s).toContain('uniform sampler2D u_featuresTexture')
  })
})
