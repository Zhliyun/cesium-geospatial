// shadowResolve.compile.test.ts
//
// M4 T3：ShadowMaterial TEMPORAL_PASS 加回（单 cascade 化）+ shadowResolve.frag sampler3D
// 手术验证 + glslang 真编译。

import { describe, expect, it } from 'vitest'

import {
  buildCloudsShadowFragmentShader,
  buildStandaloneCloudsShadowShaderForValidation
} from './ShadowMaterial'
import {
  buildShadowResolveFragmentShader,
  buildStandaloneShadowResolveShaderForValidation
} from './ShadowResolveMaterial'
import { compileFragment } from './glslangUtil'

function compileOrFail(src: string, label: string): void {
  const { ok, output } = compileFragment(src)
  if (!ok) {
    throw new Error(
      `glslangValidator 编译失败（${label}）:\n${output}\n` +
        `---- shader 前 60 行（1-based）----\n${src
          .split('\n')
          .slice(0, 60)
          .map((l, i) => `${i + 1}: ${l}`)
          .join('\n')}`
    )
  }
  expect(ok).toBe(true)
}

describe('M4 T3 ShadowMaterial TEMPORAL_PASS 加回', () => {
  it('temporalPass=true：velocity 单 out + reprojectionMatrices uniform + velocity 段（原文保留）', () => {
    const src = buildCloudsShadowFragmentShader({ temporalPass: true })
    expect(src).toContain('layout(location = 1) out vec3 outputDepthVelocity;')
    expect(src).toContain('uniform mat4 reprojectionMatrices[CASCADE_COUNT];')
    // velocity 段原文（cascadeIndex 参数在单 cascade draw 时 = u_cascadeIndex，保留原引用）
    expect(src).toContain('reprojectionMatrices[cascadeIndex]')
    expect(src).toContain('#define TEMPORAL_PASS')
    expect(src).toContain('(vUv - prevUv) * resolution')
    // main 调用带 velocity 出参
    expect(src).toMatch(
      /cascade\(u_cascadeIndex, mipLevels\[u_cascadeIndex\], outputColor, outputDepthVelocity\)/
    )
  })

  it('temporalPass=false：与 M3 完全一致（零回归基线）', () => {
    const src = buildCloudsShadowFragmentShader({ temporalPass: false })
    expect(src).not.toContain('outputDepthVelocity')
    expect(src).not.toContain('reprojectionMatrices')
    expect(src).not.toContain('TEMPORAL_PASS')
    expect(src).toMatch(
      /cascade\(u_cascadeIndex, mipLevels\[u_cascadeIndex\], outputColor\)/
    )
  })

  it('glslang：生成端双档真编译', () => {
    compileOrFail(
      buildStandaloneCloudsShadowShaderForValidation({ temporalPass: true }),
      '生成端 temporalPass=true'
    )
    compileOrFail(
      buildStandaloneCloudsShadowShaderForValidation({ temporalPass: false }),
      '生成端 temporalPass=false'
    )
  })
})

describe('M4 T3 ShadowResolveMaterial sampler3D 手术', () => {
  it('vUv 桥接 + sampler2DArray → sampler3D + varianceClipping 宏后处理', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).toContain('in vec2 v_textureCoordinates;')
    expect(src).toContain('#define vUv v_textureCoordinates')
    expect(src).toContain('uniform sampler3D inputBuffer;')
    expect(src).toContain('uniform sampler3D historyBuffer;')
    // 无 sampler2DArray 的 uniform 使用（precision 声明行无害保留）
    expect(src).not.toMatch(/uniform sampler2DArray/)
    // 宏后处理（include 展开后）：ARRAY 分支的 sampler2DArray → sampler3D；
    // 原文 `#define VARIANCE_SAMPLER_ARRAY 1` 保留（coord 分支 ivec3 原文已对）
    expect(src).toContain('#define VARIANCE_SAMPLER sampler3D')
    expect(src).not.toContain('#define VARIANCE_SAMPLER sampler2DArray')
    expect(src).toContain('#define VARIANCE_SAMPLER_COORD ivec3')
  })

  it('history 采样 z 归一化（sampler3D z∈[0,1] 层中心，非 layer 索引）', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).toMatch(
      /texture\(historyBuffer, vec3\(prevUv, \(float\(cascadeIndex\) \+ 0\.5\) \/ float\(CASCADE_COUNT\)\)\)/
    )
  })

  it('MRT out 数组 → 单 out + cascade 签名保留 + main 单 cascade（u_cascadeIndex 实参）', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).toContain('layout(location = 0) out vec4 outputColor;')
    expect(src).not.toMatch(/out vec4 outputColor\[CASCADE_COUNT\]/)
    // 签名保留（最小手术——main 传 u_cascadeIndex 实参）
    expect(src).toContain('void cascade(const int cascadeIndex, out vec4 outputColor) {')
    expect(src).toContain('uniform int u_cascadeIndex;')
    expect(src).toMatch(/void main\(\)\s*\{\s*cascade\(u_cascadeIndex, outputColor\)/)
  })

  it('texelFetchOffset → texelFetch 显式 offset（ES 3.0 无 sampler3D 的 texelFetchOffset 重载）', () => {
    const src = buildShadowResolveFragmentShader()
    expect(src).not.toContain('texelFetchOffset')
    // 换算形态：getClosestFragment（velocity 层寻址）与 varianceClipping（邻域）各一处起
    expect(src).toContain('texelFetch(inputBuffer, coord + ivec3(0, 0, CASCADE_COUNT) + ivec3(neighborOffsets[0], 0), 0)')
    expect(src).toMatch(/texelFetch\(inputBuffer, coord \+ ivec3\(varianceOffsets\[0\], 0\), 0\)/)
  })

  it('防哑过 + glslang 真编译', () => {
    const broken = buildStandaloneShadowResolveShaderForValidation().replace(
      'uniform sampler3D inputBuffer;',
      ''
    )
    const { ok } = compileFragment(broken)
    expect(ok).toBe(false)
    compileOrFail(buildStandaloneShadowResolveShaderForValidation(), 'shadowResolve')
  })
})
