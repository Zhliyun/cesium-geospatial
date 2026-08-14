// M3 T2：shadow.frag（BSM sun-POV march）→ Cesium 单 cascade 生成 shader 的 surgery 组装验证。
//
// shadow.frag 是 three.js 生成端 fragment（MRT out 数组 + unroll 循环逐 cascade 输出 +
// TEMPORAL_PASS velocity 出参）。T2 = 在编排层（ShadowMaterial.ts）文本手术，让 shadow.frag
// 在 Cesium 单 draw 单 cascade（u_cascadeIndex uniform 选 cascade）模式下跑：
//   - in vUv → in v_textureCoordinates + #define 桥接（Cesium ViewportQuadVS）
//   - MRT out 数组 → 单 out vec4 outputColor
//   - 删 outputDepthVelocity / reprojectionMatrices / TEMPORAL_PASS 段（M4 temporal 接通加回）
//   - main unroll 循环 → cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor)
//
// 本测试对齐 cloudsMain.compile.test.ts 范式（glslangValidator 真编译 + 防哑过）。

import { describe, expect, it } from 'vitest'

import {
  buildCloudsShadowFragmentShader,
  buildStandaloneCloudsShadowShaderForValidation,
  type ShadowMainOptions
} from './ShadowMaterial'
import { compileFragment } from './glslangUtil'

const OPTS: ShadowMainOptions = {}

// 共用：glslang 编译失败时打印前 80 行辅助定位（同 cloudsMain.compile.test.ts）
function compileOrFail(src: string, label: string): void {
  const { ok, output } = compileFragment(src)
  if (!ok) {
    throw new Error(
      `glslangValidator 编译失败（${label}）:\n${output}\n` +
        `---- shader 前 80 行（1-based）----\n${src
          .split('\n')
          .slice(0, 80)
          .map((l, i) => `${i + 1}: ${l}`)
          .join('\n')}`
    )
  }
  expect(ok).toBe(true)
}

describe('M3 T2 shadow.frag surgery 断言', () => {
  it('单输出：无 outputColor[CASCADE_COUNT] 数组 / 无 outputDepthVelocity / 无 reprojectionMatrices', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('layout(location = 0) out vec4 outputColor;')
    expect(src).not.toMatch(/out vec4 outputColor\[CASCADE_COUNT\]/)
    expect(src).not.toContain('outputDepthVelocity')
    expect(src).not.toContain('reprojectionMatrices')
  })
  it('u_cascadeIndex uniform + main 单 cascade 调用 + vUv→v_textureCoordinates 桥接', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('uniform int u_cascadeIndex;')
    expect(src).toMatch(/void main\(\)\s*\{\s*cascade\(u_cascadeIndex, mipLevels\[u_cascadeIndex\], outputColor\)/)
    expect(src).toContain('in vec2 v_textureCoordinates;')
    expect(src).toContain('#define vUv v_textureCoordinates')
    expect(src).not.toMatch(/in vec2 vUv;/)
  })
  it('defines：SHADOW / CASCADE_COUNT 3 / TEMPORAL_JITTER / SHAPE_DETAIL / TURBULENCE', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('#define SHADOW')
    expect(src).toContain('#define CASCADE_COUNT 3')
    expect(src).toContain('#define TEMPORAL_JITTER')
    expect(src).toContain('#define SHAPE_DETAIL')
    expect(src).toContain('#define TURBULENCE')
    // 不 define TEMPORAL_PASS（M4 temporal 接通）
    expect(src).not.toMatch(/#define TEMPORAL_PASS/)
  })
  it('inverseShadowMatrices[CASCADE_COUNT] 数组保留（动态索引采样）', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    expect(src).toContain('uniform mat4 inverseShadowMatrices[CASCADE_COUNT];')
  })
  it('运行时 shader 不带 #version；校验 shader 以 #version 300 es 开头', () => {
    expect(buildCloudsShadowFragmentShader(OPTS).startsWith('#version')).toBe(false)
    expect(buildStandaloneCloudsShadowShaderForValidation(OPTS).startsWith('#version 300 es')).toBe(true)
  })
})

describe('M3 T2 glslangValidator 真编译', () => {
  it('默认 options 编译通过', () => {
    const src = buildStandaloneCloudsShadowShaderForValidation(OPTS)
    compileOrFail(src, 'M3 T2 默认 options')
  })
  it('关闭 SHAPE_DETAIL / TURBULENCE 也编译通过', () => {
    const src = buildStandaloneCloudsShadowShaderForValidation({ shapeDetail: false, turbulence: false })
    compileOrFail(src, 'M3 T2 全关 options')
  })
  it('glslang 真的会抓错（防哑过：删掉 in 声明应编译失败）', () => {
    const src = buildStandaloneCloudsShadowShaderForValidation(OPTS)
      .replace(/in vec2 v_textureCoordinates;\n/, '')
    const { ok, output } = compileFragment(src)
    expect(ok).toBe(false)
    expect(output).toContain('ERROR')
  })
})
