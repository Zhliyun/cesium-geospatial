// M2 T1：buildCloudsMainFragmentShader（three clouds.frag → Cesium 桥接）glslang 编译验证。
//
// clouds.frag 是完整 three.js fragment（three varying + uniform + 完整 main 含 marchClouds +
// shadow/haze/aerial/temporal 交织）。M1 VolumetricPrimitive 用 createViewportQuadCommand
// （Cesium ViewportQuadVS 只输出 v_textureCoordinates）。T1 = 在编排层（CloudsMaterial.ts）
// 文本手术 + 桥接 prefix，让 clouds.frag 在 Cesium viewport quad 下跑：
//   - 剥离 3 个 three uniform（viewMatrix/cameraNear/cameraFar）→ #define 重定向到 czm_*
//   - 剥离 7 个 in varying（clouds.vert 算）→ fragment 从 czm_* 重建（不动 M1 基建）
//   - 重命名 main → cloudsMainBody，wrapper main 先重建 varying 再调用
//   - M3/M4/M5 dummy：不 define SHADOW_LENGTH/HAZE；ACCURATE_SUN_SKY_LIGHT 绕过 irradiance varying；
//     shadowBuffer 全 0 = Beer 1；reprojectionMatrix identity = velocity 未消费（M4 接通）
//
// 本测试对齐 clouds.compile.test.ts 范式（glslangValidator 真编译），断言桥接 shader 合法。

import { describe, expect, it } from 'vitest'

import {
  buildCloudsMainFragmentShader,
  buildStandaloneCloudsShaderForValidation,
  type CloudsMainOptions
} from './CloudsMaterial'
import { compileFragment } from './glslangUtil'

const M2_OPTIONS: CloudsMainOptions = {}

// 共用：glslang 编译失败时打印前 80 行辅助定位
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

describe('M2 T1 buildCloudsMainFragmentShader —— three clouds.frag → Cesium 桥接装配', () => {
  it('运行时 shader 不带 #version（Cesium ShaderProgram 自动注入）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src.startsWith('#version')).toBe(false)
    // clouds.frag 全文（含 marchClouds + main）+ 桥接 prefix，必然 > 5KB
    expect(src.length).toBeGreaterThan(5000)
  })

  it('校验 shader 以 #version 300 es 开头（喂 glslangValidator）', () => {
    const src = buildStandaloneCloudsShaderForValidation(M2_OPTIONS)
    expect(src.startsWith('#version 300 es')).toBe(true)
  })

  it('桥接代码引用 czm_viewerPositionWC / czm_inverseView / czm_view / czm_currentFrustum', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('czm_viewerPositionWC')
    expect(src).toContain('czm_inverseView')
    expect(src).toContain('czm_view')
    expect(src).toContain('czm_currentFrustum')
    // 桥接视线重建用 czm_windowToEyeCoordinates（仿 core reconstructRay）
    expect(src).toContain('czm_windowToEyeCoordinates')
  })

  it('桥接 #define 重定向 viewMatrix / cameraNear / cameraFar → czm_*', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('#define viewMatrix czm_view')
    expect(src).toContain('#define cameraNear czm_currentFrustum.x')
    expect(src).toContain('#define cameraFar czm_currentFrustum.y')
    // 原 three uniform 声明应被剥离（防与 #define 双重声明冲突）
    expect(src).not.toMatch(/uniform mat4 viewMatrix;/)
    expect(src).not.toMatch(/uniform float cameraNear;/)
    expect(src).not.toMatch(/uniform float cameraFar;/)
  })

  it('ATMOSPHERE 剥离 uniform 声明 → const 构造注入（Cesium uniformMap 不支持嵌套 struct 数组）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    // 原 uniform 声明剥离（同 core cesiumCore.ts 处理方式）
    expect(src).not.toMatch(/uniform AtmosphereParameters ATMOSPHERE;/)
    // 替换为 const ATMOSPHERE = AtmosphereParameters(...) 构造（ATMOSPHERE_DEFAULT_GLSL）
    expect(src).toContain('const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(')
    // const 注入点位于 #include "atmosphere/bruneton/definitions" 之后（struct 已定义）
    const defIdx = src.indexOf('AtmosphereParameters ATMOSPHERE = AtmosphereParameters(')
    expect(defIdx).toBeGreaterThan(src.indexOf('struct AtmosphereParameters'))
  })

  it('桥接重建函数 + cloudsMainBody（原 main 改名）+ wrapper main', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('void cloudsBridge_reconstructVaryings()')
    expect(src).toContain('void cloudsMainBody()')
    // wrapper main：重建 varying 后调用 cloudsMainBody
    expect(src).toMatch(/void main\(\)\s*\{\s*cloudsBridge_reconstructVaryings\(\)/)
  })

  it('原 7 个 in varying 声明被剥离（不再以 `in` 关键字声明）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    // clouds.vert 本应输出的 7 个 varying，由桥接重建（不再是 in 声明）
    expect(src).not.toMatch(/in vec2 vUv;/)
    expect(src).not.toMatch(/in vec3 vCameraPosition;/)
    expect(src).not.toMatch(/in vec3 vRayDirection;/)
    expect(src).not.toMatch(/in GroundIrradiance vGroundIrradiance;/)
    // Cesium viewport quad 的 v_textureCoordinates 作为 in 声明（桥接注入）
    expect(src).toMatch(/in vec2 v_textureCoordinates;/)
  })

  it('M2 不 define SHADOW_LENGTH / HAZE（M5/M6 hook 点预留）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    // SHADOW_LENGTH 不 define → marchShadowLength / outputShadowLength(loc2) 不编译
    expect(src).not.toMatch(/#define SHADOW_LENGTH/)
    // HAZE 不 define → approximateHaze / getHazeRayNearFar 不编译
    expect(src).not.toMatch(/#define HAZE/)
    expect(src).not.toMatch(/#define GROUND_BOUNCE/)
  })

  it('M2 define PERSPECTIVE_CAMERA / ACCURATE_SUN_SKY_LIGHT / SHAPE_DETAIL / TURBULENCE', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('#define PERSPECTIVE_CAMERA')
    expect(src).toContain('#define ACCURATE_SUN_SKY_LIGHT')
    expect(src).toContain('#define SHAPE_DETAIL')
    expect(src).toContain('#define TURBULENCE')
    // Bruneton LUT 尺寸 + 多阶散射（applyAerialPerspective 走 HAS_HIGHER_ORDER 分支）
    expect(src).toContain('#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE')
    expect(src).toContain('#define COMBINED_SCATTERING_TEXTURES')
  })

  it('MRT layout location 0/1（outputColor/outputDepthVelocity）；SHADOW_LENGTH 未 define 故无 loc 2', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('layout(location = 0) out vec4 outputColor')
    expect(src).toContain('layout(location = 1) out vec3 outputDepthVelocity')
    // #ifdef SHADOW_LENGTH 内的 loc 2 声明仍在源中（条件编译分支），但 SHADOW_LENGTH 未 define
    // → glslang 编译时该分支不激活（下面 glslang 编译用例验证）
  })

  it('getRayDistanceToScene 换 czm log-depth 反演（three reverseLogDepth 版不适用 Cesium）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    // core LOG_DEPTH_GLSL 注入反演函数定义（非 Cesium 内置——缺定义运行时编译错
    // 'czm_reverseLogDepthDist: no matching overloaded function found'，实测 2026-08-14）
    expect(src).toContain('float czm_reverseLogDepthDist(const float logDepth, const float near, const float far)')
    expect(src).toContain('czm_reverseLogDepthDist(logDepth, czm_currentFrustum.x, czm_currentFrustum.y)')
    // three 版三件套调用不应再出现在 getRayDistanceToScene（readDepthValue/reverseLogDepth/getViewZ
    // 的定义仍在 three packing 库里，但本函数不再消费——断言函数体内无这三者）
    const fnBody = src.slice(src.indexOf('float getRayDistanceToScene'), src.indexOf('void cloudsMainBody'))
    expect(fnBody).not.toContain('readDepthValue')
    expect(fnBody).not.toContain('reverseLogDepth(depth, cameraNear, cameraFar)')
    expect(fnBody).not.toContain('getViewZ')
  })

  it('选项可关闭 SHAPE_DETAIL / TURBULENCE / ACCURATE_SUN_SKY_LIGHT', () => {
    const off: CloudsMainOptions = {
      shapeDetail: false,
      turbulence: false,
      accurateSunSkyLight: false
    }
    const src = buildCloudsMainFragmentShader(off)
    expect(src).not.toMatch(/#define SHAPE_DETAIL/)
    expect(src).not.toMatch(/#define TURBULENCE/)
    expect(src).not.toMatch(/#define ACCURATE_SUN_SKY_LIGHT/)
  })
})

describe('M2 T1 glslangValidator 真编译（clouds.frag 完整桥接 shader）', () => {
  it('默认 M2 options 编译通过', () => {
    const src = buildStandaloneCloudsShaderForValidation(M2_OPTIONS)
    expect(src.startsWith('#version 300 es')).toBe(true)
    compileOrFail(src, 'M2 默认 options')
  })

  it('关闭 SHAPE_DETAIL / TURBULENCE / ACCURATE_SUN_SKY_LIGHT 也编译通过', () => {
    const src = buildStandaloneCloudsShaderForValidation({
      shapeDetail: false,
      turbulence: false,
      accurateSunSkyLight: false
    })
    compileOrFail(src, '全关 options')
  })

  it('glslangValidator 真的会抓桥接 shader 编译错误（防测试哑过）', () => {
    // 故意破坏：移除 czm_viewerPositionWC 桩，桥接代码应未声明标识符失败
    const src =
      buildStandaloneCloudsShaderForValidation(M2_OPTIONS).replace(
        /uniform vec3 czm_viewerPositionWC;\n/,
        ''
      )
    const { ok, output } = compileFragment(src)
    expect(ok).toBe(false)
    expect(output).toContain('ERROR')
  })
})
