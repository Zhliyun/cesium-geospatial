// M1 T7：clouds GLSL 真编译验证（评审 critical，对齐 core/aerialPerspective.compile.test.ts 范式）。
//
// 仅做 include 解析 + define 注入的字符串展开抓不到编译期错误（未声明标识符、类型不匹配、
// precision、括号、宏组合残留调用点、MRT layout、uniform 数组尺寸等）。本文件把 clouds 包
// 全部 13 个 entry shader（含 main()）经 buildStandaloneCloudsShader 组装成 `#version 300 es`
// 自洽 shader，喂真实 glslangValidator（ESSL 3.20）编译，断言退出码 0。
//
// 9 个 library shader（catmullRomSampling / clouds.glsl / parameters / perlin / tileableNoise /
// structuredSampling / varianceClipping / types / cloudsEffect.frag 除外已包成 entry）无 main()，
// 不能 -S frag/vert 独立编译——它们经 entry shader 的 #include 链被传递覆盖（与 core 不独立
// 编译 bruneton/common.glsl 同理）。
//
// glslang 调用细节（Rosetta / chmod / 包内二进制路径）见 ./glslangUtil.ts。

import { describe, expect, it } from 'vitest'

import { buildStandaloneCloudsShader } from './cloudsShaderAssembler'
import { glslIndex } from './glslIndex'
import { compileShader } from './glslangUtil'

// Bruneton 大气 LUT 纹理尺寸 + 单位换算 + 多阶散射开关——clouds.frag / clouds.vert 经
// #include "atmosphere/bruneton/runtime" 引用这些。值逐字取自 core/cesium/cesiumCore.ts
// buildAtmospherePrefix（T8 运行时 assembler 会复用同一组）。
const BRUNETON_DEFINES = {
  TRANSMITTANCE_TEXTURE_WIDTH: 256,
  TRANSMITTANCE_TEXTURE_HEIGHT: 64,
  SCATTERING_TEXTURE_R_SIZE: 32,
  SCATTERING_TEXTURE_MU_SIZE: 128,
  SCATTERING_TEXTURE_MU_S_SIZE: 32,
  SCATTERING_TEXTURE_NU_SIZE: 8,
  IRRADIANCE_TEXTURE_WIDTH: 64,
  IRRADIANCE_TEXTURE_HEIGHT: 16,
  METER_TO_LENGTH_UNIT: 0.001,
  COMBINED_SCATTERING_TEXTURES: true,
  HAS_HIGHER_ORDER_SCATTERING_TEXTURE: true
}

// clouds.frag 主 pipeline 的额外 define（three-geospatial 原由 THREE.ShaderMaterial.defines 注入）。
const CLOUDS_FRAG_DEFINES = {
  ...BRUNETON_DEFINES,
  // 散射相函数各向异性（henyeyGreenstein 双项混合）
  SCATTER_ANISOTROPY_1: 0.5,
  SCATTER_ANISOTROPY_2: -0.5,
  SCATTER_ANISOTROPY_MIX: 0.35,
  // 级联 shadow map（BSM）——uniform 数组尺寸 + unroll 循环上界
  SHADOW_CASCADE_COUNT: 4,
  SHADOW_SAMPLE_COUNT: 16,
  // 多阶散射 octaves（approximateMultipleScattering unroll 上界）
  MULTI_SCATTERING_OCTAVES: 6,
  // localWeather texture 通道 swizzle 宏（.LOCAL_WEATHER_CHANNELS → .rgba）
  LOCAL_WEATHER_CHANNELS: 'rgba',
  // core/depth.glsl readDepthValue 在 #ifdef DEPTH_PACKING 内；=0 走 texture().r 分支
  DEPTH_PACKING: 0
}

// shadow pipeline 的级联数（shadow.frag / shadowResolve.frag 的 uniform 数组 + unroll 上界）。
// LOCAL_WEATHER_CHANNELS：clouds.glsl sampleWeather 经 #include "clouds" 被引用的 swizzle 宏，
// shadow.frag marchClouds 调 sampleWeather 故同样需要定义（否则 .LOCAL_WEATHER_CHANNELS 不展开）。
const SHADOW_DEFINES = { CASCADE_COUNT: 4, LOCAL_WEATHER_CHANNELS: 'rgba' }

interface EntryCase {
  name: string
  source: string
  stage: 'frag' | 'vert'
  defines?: Record<string, string | number | boolean | null | undefined>
  suffix?: string
}

// 13 个 entry shader 编译用例。
const ENTRY_CASES: EntryCase[] = [
  {
    name: 'clouds.frag（主 pipeline：BSM + 多阶散射 + 大气透视 + MRT）',
    source: glslIndex.cloudsFrag,
    stage: 'frag',
    defines: CLOUDS_FRAG_DEFINES
  },
  {
    name: 'clouds.vert（全屏 quad 顶点 + bruneton Sun/Sky irradiance 预计算）',
    source: glslIndex.cloudsVert,
    stage: 'vert',
    defines: BRUNETON_DEFINES
  },
  {
    name: 'cloudsResolve.frag（时域上采样 / TAA + 方差裁剪）',
    source: glslIndex.cloudsResolveFrag,
    stage: 'frag'
  },
  { name: 'cloudsResolve.vert', source: glslIndex.cloudsResolveVert, stage: 'vert' },
  {
    name: 'shadow.frag（Beer shadow map march，CASCADE_COUNT 级联）',
    source: glslIndex.shadowFrag,
    stage: 'frag',
    defines: SHADOW_DEFINES
  },
  { name: 'shadow.vert', source: glslIndex.shadowVert, stage: 'vert' },
  {
    name: 'shadowResolve.frag（BSM 时域 resolve + 方差裁剪）',
    source: glslIndex.shadowResolveFrag,
    stage: 'frag',
    defines: SHADOW_DEFINES
  },
  { name: 'shadowResolve.vert', source: glslIndex.shadowResolveVert, stage: 'vert' },
  {
    name: 'cloudShape.frag（3D shape LUT 烘焙：perlin-worley）',
    source: glslIndex.cloudShapeFrag,
    stage: 'frag'
  },
  {
    name: 'cloudShapeDetail.frag（3D detail LUT 烘焙：worley fbm）',
    source: glslIndex.cloudShapeDetailFrag,
    stage: 'frag'
  },
  {
    name: 'localWeather.frag（2D weather LUT 烘焙：worley + perlin）',
    source: glslIndex.localWeatherFrag,
    stage: 'frag'
  },
  {
    name: 'turbulence.frag（3D curl noise 烘焙）',
    source: glslIndex.turbulenceFrag,
    stage: 'frag'
  },
  {
    // cloudsEffect.frag 是 Three 风格 mainImage(out) 库函数（无 main），补 wrapper 编译。
    name: 'cloudsEffect.frag（合成到主图：mainImage wrapper）',
    source: glslIndex.cloudsEffectFrag,
    stage: 'frag',
    suffix: [
      'void main() {',
      '  // wrapper：调用 mainImage 让 glslang 真正编译其函数体（Cesium 运行时由 assembler 包裹）',
      '  vec4 c;',
      '  mainImage(vec4(0.0), vec2(0.0), c);',
      '}'
    ].join('\n')
  }
]

describe('GLSL 编译验证（glslangValidator，clouds 全 entry shader）', () => {
  for (const tc of ENTRY_CASES) {
    it(`编译通过：${tc.name}`, () => {
      const src = buildStandaloneCloudsShader(tc.source, {
        stage: tc.stage,
        defines: tc.defines,
        suffix: tc.suffix
      })
      // 前置断言：输入确实是 #version 300 es 独立 shader（防 assembler 回归）
      expect(src.startsWith('#version 300 es')).toBe(true)

      const { ok, output } = compileShader(src, tc.stage)
      if (!ok) {
        throw new Error(
          `glslangValidator 编译失败（${tc.name}）:\n${output}\n` +
            `---- shader 前 60 行（行号 1-based）----\n${src
              .split('\n')
              .slice(0, 60)
              .map((l, i) => `${i + 1}: ${l}`)
              .join('\n')}`
        )
      }
      expect(ok).toBe(true)
    })
  }

  it('glslangValidator 真的会抓编译错误（防回归：测试本身不能哑过）', () => {
    const broken = `#version 300 es
precision highp float;
out vec4 out_FragColor;
void main() { out_FragColor = vec4(thisIdentifierDoesNotExist); }`
    const { ok, output } = compileShader(broken, 'frag')
    expect(ok).toBe(false)
    expect(output).toContain('ERROR')
  })
})
