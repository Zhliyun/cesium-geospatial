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

  it('M2 不 define SHADOW_LENGTH / HAZE（M5 默认开后此用例为显式关基线）', () => {
    const src = buildCloudsMainFragmentShader({ ...M2_OPTIONS, lightShafts: false })
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

describe('M3 T4 BSM 消费 surgery', () => {
  it('sampler3D z 归一化：texture(shadowBuffer, vec3(uv, (i+0.5)/SHADOW_CASCADE_COUNT))', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    // readShadowOpticalDepth 的采样点（clouds.frag L180 原文 texture(shadowBuffer, vec3(uv, float(cascadeIndex)))）
    expect(src).toContain('(float(cascadeIndex) + 0.5) / float(SHADOW_CASCADE_COUNT)')
    expect(src).not.toContain('texture(shadowBuffer, vec3(uv, float(cascadeIndex)))')
  })

  it('DEBUG_SHOW_SHADOW_MAP 4 处 layer 字面量同步 z 归一化（sampler3D z 非 layer 索引）', () => {
    const src = buildCloudsMainFragmentShader({ debugShow: 'shadowMap' })
    // clouds.frag L257-270 原文 0.0/1.0/2.0/3.0（sampler2DArray layer 索引）→ (i+0.5)/COUNT
    // 层中心采样；#if SHADOW_CASCADE_COUNT > N 分支结构保留（COUNT=3 时 i=3 分支裁掉）。
    expect(src).toContain('vec3(coord.xw, 0.5 / float(SHADOW_CASCADE_COUNT))')
    expect(src).toContain('vec3(coord.zw, 1.5 / float(SHADOW_CASCADE_COUNT))')
    expect(src).toContain('vec3(coord.xy, 2.5 / float(SHADOW_CASCADE_COUNT))')
    expect(src).toContain('vec3(coord.zy, 3.5 / float(SHADOW_CASCADE_COUNT))')
    expect(src).not.toContain('vec3(coord.xw, 0.0)')
  })

  it('cascade 选择解 multi-frustum 错位：cameraNear→u_shadowCameraNear（3 处调用点）', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('uniform float u_shadowCameraNear;')
    // getCascadeColor / getFadedCascadeColor / sampleShadowOpticalDepth 内共 3 处
    const count = src.split('u_shadowCameraNear,\n    shadowFar').length - 1
    expect(count).toBe(3)
    // DEBUG_SHOW_CASCADES 关闭时这些调用不编译，但源文本手术已替换（glslang 编译验证见下）
  })

  it('#define POWDER（powderScale=0.8>0，three 默认开）+ SHADOW_CASCADE_COUNT 3', () => {
    const src = buildCloudsMainFragmentShader(M2_OPTIONS)
    expect(src).toContain('#define POWDER')
    expect(src).toContain('#define SHADOW_CASCADE_COUNT 3')
    expect(src).not.toContain('#define SHADOW_CASCADE_COUNT 4')
  })

  it('glslang：M3 默认 options（含 POWDER）编译通过', () => {
    compileOrFail(buildStandaloneCloudsShaderForValidation(M2_OPTIONS), 'M3 默认')
  })

  it('glslang：debugShow=shadowMap（z 归一化 DEBUG 路径真编译）编译通过', () => {
    compileOrFail(
      buildStandaloneCloudsShaderForValidation({ debugShow: 'shadowMap' }),
      'M3 shadowMap debug'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M4 T6：ray 重建 jitter surgery 断言
// ─────────────────────────────────────────────────────────────────────────────
describe('M4 T6 jitter surgery', () => {
  it('ray 重建消费 temporalJitter + 低分域换算（gl_FragCoord / targetUvScale + jitter，一处 windowCoord 近/远共用）', () => {
    const src = buildCloudsMainFragmentShader({})
    // 2026-08-17 抖动修复：低分 march 的 gl_FragCoord 必须除以 targetUvScale 换算到全分窗口域
    expect(src).toContain('vec2 windowCoord = gl_FragCoord.xy / targetUvScale + temporalJitter * resolution;')
    expect(src).toContain('czm_windowToEyeCoordinates(vec4(windowCoord, 0.0, 1.0))')
    expect(src).toContain('czm_windowToEyeCoordinates(vec4(windowCoord, 1.0, 1.0))')
  })

  it('vViewPosition 保持 normalize（与 three 未归一化版共线——投影 w 除法抵消标量差）', () => {
    const src = buildCloudsMainFragmentShader({})
    expect(src).toContain('vViewPosition = normalize(dirEC)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 质量档位 T2：shadowCascadeCount 参数化 + accurate=false 桥接接线（spec §6/§11.1）
// ─────────────────────────────────────────────────────────────────────────────
describe('质量档位：shadowCascadeCount 参数化 + accurate=false 桥接接线（spec §6/§11.1）', () => {
  it('默认 SHADOW_CASCADE_COUNT 3；传 2 时 define 变 2', () => {
    const src3 = buildCloudsMainFragmentShader()
    expect(src3).toContain('#define SHADOW_CASCADE_COUNT 3')
    const src2 = buildCloudsMainFragmentShader({ shadowCascadeCount: 2 })
    expect(src2).toContain('#define SHADOW_CASCADE_COUNT 2')
    expect(src2).not.toContain('#define SHADOW_CASCADE_COUNT 3')
  })

  it('accurate 关：桥接含 min/max 云高 irradiance 真计算（vert sampleSunSkyIrradiance 云段移植）', () => {
    const src = buildCloudsMainFragmentShader({ accurateSunSkyLight: false })
    expect(src).toContain('#ifndef ACCURATE_SUN_SKY_LIGHT')
    // 2 次调用：surfaceNormal * radii.x / .y（spec v3 计数：ground 段不移植）
    expect(src.match(/GetSunAndSkyScalarIrradiance/g)?.length).toBeGreaterThanOrEqual(2)
    expect(src).toContain('bridgeCloudsRadii')
  })

  it('accurate 开：桥接保持零填充（现有行为），bridge 真计算段被预处理裁掉', () => {
    const src = buildCloudsMainFragmentShader({ accurateSunSkyLight: true })
    // BRIDGE_VARYINGS_GLSL 为模块级常量，irradiance 段以 #ifndef/#else 双分支无条件拼接
    // （GLSL 预处理——defines 拼接在前）。accurate 开 → ACCURATE_SUN_SKY_LIGHT 已 define →
    // #ifndef 段（bridge 真计算）编译期整段裁掉，生效的只有 #else 零填充（现有行为）。
    expect(src).toContain('#define ACCURATE_SUN_SKY_LIGHT')
    const ifndefIdx = src.indexOf('#ifndef ACCURATE_SUN_SKY_LIGHT')
    expect(ifndefIdx).toBeGreaterThanOrEqual(0)
    const elseIdx = src.indexOf('#else', ifndefIdx)
    // bridge 真计算标识符只出现在 #ifndef...#else 死分支文本内（不进编译产物）
    const bridgeIdx = src.indexOf('bridgeCloudsRadii')
    expect(bridgeIdx).toBeGreaterThan(ifndefIdx)
    expect(bridgeIdx).toBeLessThan(elseIdx)
  })

  it('glslang 编译：SHADOW_CASCADE_COUNT 2 + 四编译开关全关（low 档实际组合）', () => {
    const src = buildStandaloneCloudsShaderForValidation({
      shadowCascadeCount: 2,
      accurateSunSkyLight: false,
      shapeDetail: false,
      turbulence: false,
      lightShafts: false
    })
    compileOrFail(src, 'low 档（cascade 2 + 四编译开关全关）')
  })

  it('glslang 编译：accurate 关（新接线路径）默认 cascade 3', () => {
    const src = buildStandaloneCloudsShaderForValidation({ accurateSunSkyLight: false })
    compileOrFail(src, 'accurate 关默认 cascade 3')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5 T1：SHADOW_LENGTH（lightShafts）编译分支——云 god rays
// ─────────────────────────────────────────────────────────────────────────────
describe('M5 T1 SHADOW_LENGTH（lightShafts）编译分支', () => {
  it('默认开：#define SHADOW_LENGTH + loc2 out + marchShadowLength + 三 uniform 声明', () => {
    const src = buildCloudsMainFragmentShader({})
    expect(src).toContain('#define SHADOW_LENGTH')
    expect(src).toContain('layout(location = 2) out float outputShadowLength;')
    expect(src).toContain('float marchShadowLength(')
    expect(src).toContain('uniform int maxShadowLengthIterationCount;')
    expect(src).toContain('uniform float minShadowLengthStepSize;')
    expect(src).toContain('uniform float maxShadowLengthRayDistance;')
    // applyAerialPerspective 消费 shadowLength（GetSkyRadianceToPoint 3 参——higher-order 分支）
    expect(src).toContain('applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);')
  })

  it('lightShafts=false：无 #define SHADOW_LENGTH（M4 后行为零回归；原文 ifdef 块文本恒在——编译期裁剪由 glslang 用例兜底）', () => {
    const src = buildCloudsMainFragmentShader({ lightShafts: false })
    expect(src).not.toContain('#define SHADOW_LENGTH')
    const { ok } = compileFragment(buildStandaloneCloudsShaderForValidation({ lightShafts: false }))
    expect(ok).toBe(true)
  })

  it('glslang：lightShafts 开真编译（out 3 + marchShadowLength + shadow_length 分支）', () => {
    const src = buildStandaloneCloudsShaderForValidation({ lightShafts: true })
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(
        `glslang 编译失败:\n${output}\n` +
          src.split('\n').slice(0, 60).map((l, i) => `${i + 1}: ${l}`).join('\n')
      )
    }
    expect(ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 夜间环境底光（2026-08-29 方向 B）：夜间云照明地板——irradiance LUT 在太阳沉没 ~5° 后
// 精确归零，云自体辐射 0 → 厚云海 overlay 混成纯黑黑洞（吞星空底光，不符合物理）。
// 修复 = skyIrradiance 抬 nightAmbient 地板，当地太阳仰角 -5°→-12° 淡入（白天 0 零回归）。
// ─────────────────────────────────────────────────────────────────────────────
describe('夜间环境底光 nightAmbient（方向 B）', () => {
  it('uniform 声明 + 光照循环抬地板：skyIrradiance += vec3(nightAmbient) * nightFactor', () => {
    const src = buildCloudsMainFragmentShader({})
    expect(src).toContain('uniform float nightAmbient;')
    // 淡入区间 sin(-12°)=-0.2079 / sin(-5°)=-0.0872（LUT -5° 归零线 → 天文夜满值）
    expect(src).toContain('1.0 - smoothstep(-0.2079, -0.0872, muSunLocal)')
    // 抬在 skyIrradiance 上（经 skyGradient × scattering × 能量积分传播 → 云保有形体梯度）
    expect(src).toContain('skyIrradiance += vec3(nightAmbient) * nightFactor;')
  })

  it('glslang：含 nightAmbient 的完整 shader 真编译', () => {
    const src = buildStandaloneCloudsShaderForValidation({})
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(
        `glslang 编译失败:\n${output}\n` +
          src.split('\n').slice(0, 60).map((l, i) => `${i + 1}: ${l}`).join('\n')
      )
    }
    expect(ok).toBe(true)
  })
})
