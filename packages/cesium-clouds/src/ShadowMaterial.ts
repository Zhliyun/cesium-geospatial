// ShadowMaterial.ts
//
// M3 T2：three shadow.frag（BSM sun-POV march）→ Cesium 生成端 shader 桥接组装器。
//
// shadow.frag 是 three.js 生成端 fragment：MRT out 数组（outputColor[CASCADE_COUNT] +
// outputDepthVelocity[CASCADE_COUNT]）+ main unroll 循环逐 cascade 输出 + TEMPORAL_PASS
// velocity 出参。M3 Cesium 侧改为「单 draw 单 cascade」——每个 cascade 一次 viewport draw
// （u_cascadeIndex uniform 选 cascade，同 shader 复用 ShaderProgram 缓存），MRT/temporal
// 全部裁掉。本组装器在编排层做文本手术（不动 shadow.frag 原文，保持 three 版形态便于上游
// diff），surgery 决策（plan 决策 D5）：
//   1. `in vec2 vUv;` → `in vec2 v_textureCoordinates;` + `#define vUv v_textureCoordinates`
//      （Cesium ViewportQuadVS 只输出 v_textureCoordinates，声明需 shader 自带——同
//      CloudsMaterial.ts 桥接）
//   2. MRT out 数组 → 单 out vec4 outputColor（每 draw 一个 cascade，u_cascadeIndex uniform）
//   3. 删 outputDepthVelocity 声明块 + cascade() velocity 参数与 TEMPORAL_PASS 段 +
//      reprojectionMatrices uniform（M4 temporal 接通时按 three 原文加回）
//   4. main 的 unroll 循环 → 单 cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor)
// shadow.frag 不引用任何 czm_*（无需 CZM_STUBS）。
//
// 双入口（仿 core aerialPerspective.frag.ts / CloudsMaterial.ts）：
//   - buildCloudsShadowFragmentShader()：Cesium 运行时（无 #version；由 ShaderProgram 注入）
//   - buildStandaloneCloudsShadowShaderForValidation()：glslang 校验（补 #version 300 es +
//     precision；v_textureCoordinates 的 in 声明已由 surgery 1 注入）

import { glslIndex } from './glslIndex'
import { resolveCloudsIncludes } from './resolveCloudsIncludes'

// M3 T2 桥接选项（同 CloudsMaterial.ts 的编译分支开关；默认全开）。
export interface ShadowMainOptions {
  /**
   * SHAPE_DETAIL 分支开关（sampleMedia 走 shapeDetailTexture 细节修饰）。默认 true。
   */
  shapeDetail?: boolean
  /**
   * TURBULENCE 分支开关（sampleMedia 走 turbulenceTexture 卷曲位移）。默认 true。
   */
  turbulence?: boolean
}

// shadow 生成管线固定 define（不含 options 分支）。SHADOW 让 sampleWeather 走
// shadowLayerMask 乘法（clouds.glsl L87——BSM 只算 shadow=true 的层，与主 march 共享语义）；
// CASCADE_COUNT 决定 inverseShadowMatrices 数组长（决策 D4：与主 march SHADOW_CASCADE_COUNT
// 命名区分、值独立为 3）；TEMPORAL_JITTER 开 STBN 起点抖动（frame=0 静态 jitter，M4 递增）；
// LOCAL_WEATHER_CHANNELS 对齐主 march 的 sampleWeather swizzle 宏。
const SHADOW_DEFINES_BASE = [
  '#define SHADOW',                 // sampleWeather 走 shadowLayerMask（BSM 只算 shadow=true 的层）
  '#define CASCADE_COUNT 3',        // 决策 D4（与主 march SHADOW_CASCADE_COUNT 一致）
  '#define TEMPORAL_JITTER',        // STBN 静态 jitter（frame=0；M4 递增）
  '#define LOCAL_WEATHER_CHANNELS rgba'
]

// 调试/断言用 define 清单（T3 ShadowPass 可对照核对 uniform/分支期望）。
export const SHADOW_PIPELINE_DEFINES: readonly string[] = SHADOW_DEFINES_BASE

type ResolvedShadowMainOptions = Required<ShadowMainOptions>

const DEFAULTS: ResolvedShadowMainOptions = {
  shapeDetail: true,
  turbulence: true
}

// 构造 M3 运行期 define 集（基础管线 define + options 编译分支开关）。
function buildDefines(o: ResolvedShadowMainOptions): string {
  return [
    ...SHADOW_DEFINES_BASE,
    o.shapeDetail ? '#define SHAPE_DETAIL' : '',
    o.turbulence ? '#define TURBULENCE' : ''
  ].filter((s) => s.length > 0).join('\n')
}

// 文本手术：单 cascade 化 shadow.frag 源（不改原 .glsl 文件）。锚点唯一性已核实（grep 验证）：
// `in vec2 vUv;` / out 数组 / velocity 块 / reprojectionMatrices 各一处；cascade 签名与
// TEMPORAL_PASS 段、main unroll 循环各一段。正则不匹配时应打印手术前后源对照调试（改正则，
// 不改 .glsl）。
function surgeryShadowFrag(source: string): string {
  let src = source
  // 1) varying 桥接。注释放声明上一行——保证 `in vec2 v_textureCoordinates;\n` 逐字存在
  //    （shadowMain.compile.test.ts 防哑过用例以该精确串删声明验证 glslang 真抓错）。
  src = src.replace(
    /in vec2 vUv;\n/,
    '// Cesium ViewportQuadVS 注入 v_textureCoordinates\nin vec2 v_textureCoordinates;\n#define vUv v_textureCoordinates\n'
  )
  // 2) MRT out 数组 → 单 out
  src = src.replace(
    /layout\(location = 0\) out vec4 outputColor\[CASCADE_COUNT\];\n/,
    'layout(location = 0) out vec4 outputColor;\n'
  )
  // 3) 删 outputDepthVelocity 声明块（#if CASCADE_COUNT == 1..4 冗余段，含注释行）
  src = src.replace(/\n\/\/ Redundant notation for prettier\.\n#if CASCADE_COUNT == 1\n[\s\S]*?#endif \/\/ CASCADE_COUNT\n/, '\n')
  // 4) 删 reprojectionMatrices uniform（TEMPORAL_PASS 专用，M4 加回）
  src = src.replace(/uniform mat4 reprojectionMatrices\[CASCADE_COUNT\];\n/, '')
  // 5) cascade() 签名去掉 velocity 出参 + 体内 TEMPORAL_PASS 段删除
  src = src.replace(
    /  const float mipLevel,\n  out vec4 outputColor,\n  out vec3 outputDepthVelocity\n\) \{/,
    '  const float mipLevel,\n  out vec4 outputColor\n) {'
  )
  src = src.replace(/\n  #ifdef TEMPORAL_PASS\n[\s\S]*?#else \/\/ TEMPORAL_PASS\n  outputDepthVelocity = vec3\(0\.0\);\n  #endif \/\/ TEMPORAL_PASS\n/, '\n')
  // 6) main 单 cascade 调用（unroll 循环 → u_cascadeIndex）。main 内 `#pragma unroll_loop_*`
  //    随整段替换消失；marchClouds 内普通 for 循环不受 unrollLoops 影响。
  src = src.replace(
    /void main\(\) \{\n  #pragma unroll_loop_start\n[\s\S]*?#pragma unroll_loop_end\n\}/,
    'uniform int u_cascadeIndex;  // 每 draw 换值（同 shader 复用 ShaderProgram 缓存）\n' +
    'void main() {\n' +
    '  cascade(u_cascadeIndex, mipLevels[u_cascadeIndex], outputColor);\n' +
    '}'
  )
  return src
}

/**
 * 组装 Cesium 运行时 BSM 生成端 fragment shader（three shadow.frag → 单 cascade 桥接）。
 *
 * 结构：defines + surgery 后 shadow.frag 文本（#include 由 resolveCloudsIncludes 内联，
 * 含 Three <chunk> 兼容桩与 unrollLoops）。不写 #version / precision 兜底——shadow.frag
 * 原文 L1-2 已含 precision；#version 由 Cesium ShaderProgram 注入。
 */
export function buildCloudsShadowFragmentShader(options: ShadowMainOptions = {}): string {
  const o: ResolvedShadowMainOptions = { ...DEFAULTS, ...options }
  const merged = [buildDefines(o), surgeryShadowFrag(glslIndex.shadowFrag)].join('\n\n')
  return resolveCloudsIncludes(merged)
}

/**
 * glslang 校验入口：补 #version 300 es + precision。
 *
 * v_textureCoordinates 的 in 声明已由 surgery 1 注入，无需额外桩（shadow.frag 不引用
 * czm_*）。precision 覆盖 include 链全部 sampler 类型（sampler2D/sampler3D；shadow 生成
 * 端不消费 shadowBuffer，无 sampler2DArray）。
 */
export function buildStandaloneCloudsShadowShaderForValidation(
  options: ShadowMainOptions = {}
): string {
  const runtime = buildCloudsShadowFragmentShader(options)
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp sampler3D;',
    runtime
  ].join('\n')
}
