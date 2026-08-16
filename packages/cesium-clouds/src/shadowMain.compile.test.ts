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
import { buildCloudsMainFragmentShader } from './CloudsMaterial'
import { compileFragment } from './glslangUtil'

// M4 T3 后 temporalPass 默认 true——M3 基线断言需显式关（velocity 段加回属 M4 新用例，
// 见 shadowResolve.compile.test.ts 生成端 describe）
const OPTS: ShadowMainOptions = { temporalPass: false }

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
  it('densityProfile struct uniform → const 注入（Cesium uniformMap 无 struct；与主 march 同值保生成/消费密度一致）', () => {
    const src = buildCloudsShadowFragmentShader(OPTS)
    // getLayerDensity 消费 densityProfile（clouds.glsl L103-109）——留 uniform 则运行时
    // 无值全 0 → 云密度恒 0 → BSM 全 0 光深 → Beer=1（自阴影静默失效）。必须 const 注入，
    // 值与 CloudsMaterial.ts 的 CloudLayers.DEFAULT packDensityProfiles 逐字一致
    // （生成端/消费端密度不同分布会造成阴影与云形错位）。
    expect(src).not.toContain('uniform CloudDensityProfile densityProfile;')
    expect(src).toContain(
      'const CloudDensityProfile densityProfile = CloudDensityProfile(\n' +
        '  vec4(0.0), vec4(0.0), vec4(0.75), vec4(0.25));'
    )
  })
  it('运行时 shader 不带 #version；校验 shader 以 #version 300 es 开头', () => {
    expect(buildCloudsShadowFragmentShader(OPTS).startsWith('#version')).toBe(false)
    expect(buildStandaloneCloudsShadowShaderForValidation(OPTS).startsWith('#version 300 es')).toBe(true)
  })
})

describe('M3 终审：BSM 与主 march 编译分支一致性（SHAPE_DETAIL/TURBULENCE）', () => {
  // 不变量（ShadowMaterial.ts 文件头「BSM 生成端与主 march 消费端的云密度同分布」）：
  // 相同 options 下两个组装器的 SHAPE_DETAIL/TURBULENCE define 有无必须一致——单端关分支
  // 会造成 BSM 光深用不同密度场，阴影与云形细节错位。此处直接对比两组装器输出源文本
  // （define 仅由组装器 buildDefines/buildM2Defines 注入，glsl 源内无其他 #define 命中，
  // 无前缀撞名——已核实）。编排层透传错位（createCloudsStage shaderOptions undefined 覆盖）
  // 由 createCloudsStage.test.ts 默认路径用例守。
  const DENSITY_BRANCH_DEFINES = ['SHAPE_DETAIL', 'TURBULENCE'] as const

  it('默认 options：两端都 define（默认全开）', () => {
    const main = buildCloudsMainFragmentShader()
    const shadow = buildCloudsShadowFragmentShader()
    for (const d of DENSITY_BRANCH_DEFINES) {
      expect(main).toContain(`#define ${d}`)
      expect(shadow).toContain(`#define ${d}`)
    }
  })

  it('显式全关：两端都不 define', () => {
    const main = buildCloudsMainFragmentShader({ shapeDetail: false, turbulence: false })
    const shadow = buildCloudsShadowFragmentShader({ shapeDetail: false, turbulence: false })
    for (const d of DENSITY_BRANCH_DEFINES) {
      expect(main).not.toContain(`#define ${d}`)
      expect(shadow).not.toContain(`#define ${d}`)
    }
  })

  it('单关单开：两端 define 有无逐项一致', () => {
    const main = buildCloudsMainFragmentShader({ shapeDetail: false, turbulence: true })
    const shadow = buildCloudsShadowFragmentShader({ shapeDetail: false, turbulence: true })
    for (const d of DENSITY_BRANCH_DEFINES) {
      expect(main.includes(`#define ${d}`)).toBe(shadow.includes(`#define ${d}`))
    }
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
