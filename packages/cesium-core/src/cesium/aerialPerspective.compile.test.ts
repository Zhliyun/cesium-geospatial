// Task 8：GLSL 真编译验证（评审 critical）。
//
// 单测只做字符串展开抓不到编译期错误（未声明标识符、类型不匹配、precision、
// 括号不匹配、宏组合残留调用点等）。本文件对 spec §4.2 全部合法宏组合调
// buildStandaloneShaderForValidation 生成完整 GLSL，喂给真实 glslangValidator
// （ESSL 3.20，等价 WebGL2 的 GLSL ES 3.00 编译器）做编译，断言退出码 0。
//
// glslangValidator 的调用/选型/平台注意（Rosetta 2 / 包内二进制路径 / 权限位修复）
// 见 ./glslangUtil.ts——lensFlare.compile.test.ts 共享同一份实现。

import { describe, expect, it } from 'vitest'

import {
  buildAerialPerspectiveFragmentShader,
  buildStandaloneShaderForValidation,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'
import { buildStandaloneShaderForValidation as buildTonemapStandalone } from './tonemap.frag'
// glslang 调用 helper（getGlslangValidatorPath/whichSystem/PLATFORM_SUFFIX/compileFragment）
// 已抽到 ./glslangUtil，与本仓 lensFlare.compile.test.ts 共享同一份实现。
import { compileFragment } from './glslangUtil'

// spec §4.2 合法宏组合枚举——A 路径 / B 路径 / 仅透射 / 仅内散射。
// options 形状与 brief 一致（未列字段走 buildAerialPerspectiveFragmentShader
// 的默认 true，覆盖宏裁剪与 uniform 接线的真实组合空间）。
const COMBOS: Array<[string, AerialPerspectiveFragOptions]> = [
  ['默认（SKY+SUN 全开）', {}],
  ['无日盘（SUN 关，SKY 开）', { sun: false }],
  ['无天空分支（SKY+SUN 关，远平面直通）', { sun: false, sky: false }]
]

describe('GLSL 编译验证（glslangValidator，全合法宏组合）', () => {
  // 用 it.each 而非手写循环，保证失败时 vite 报告单个 combo 名。
  for (const [name, opts] of COMBOS) {
    it(`编译通过：${name}`, () => {
      const src = buildStandaloneShaderForValidation(opts)
      // 前置断言：输入确实是 #version 300 es 独立 shader（防 T5 回归）。
      expect(src.startsWith('#version 300 es')).toBe(true)

      const { ok, output } = compileFragment(src)
      if (!ok) {
        // 失败时把 glslang 全部 stderr 落到断言消息，便于定位行号。
        throw new Error(
          `glslangValidator 编译失败（${name}）:\n${output}\n` +
            `---- shader 前 40 行（行号 1-based）----\n${src
              .split('\n')
              .slice(0, 40)
              .map((l, i) => `${i + 1}: ${l}`)
              .join('\n')}`
        )
      }
      expect(ok).toBe(true)
    })
  }

  it('编译通过：HDR 变体（hdrDepthTemporal=true，DEPTH_TEMPORAL_EMA 读 depthTemporal .a 消水波纹，Bug3）', () => {
    const src = buildStandaloneShaderForValidation({ hdrDepthTemporal: true })
    expect(src.startsWith('#version 300 es')).toBe(true)
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(
        `glslangValidator 编译失败（HDR 变体）:\n${output}\n` +
          `---- shader 前 40 行 ----\n${src
            .split('\n')
            .slice(0, 40)
            .map((l, i) => `${i + 1}: ${l}`)
            .join('\n')}`
      )
    }
    expect(ok).toBe(true)
  })

  it('glslangValidator 真的会抓编译错误（防回归：测试本身不能哑过）', () => {
    // 注入未声明标识符，验证 glslang 非哑过——若这个测试失败说明编译器没在干活。
    const broken = `#version 300 es
precision highp float;
out vec4 out_FragColor;
void main() { out_FragColor = vec4(thisIdentifierDoesNotExist); }`
    const { ok, output } = compileFragment(broken)
    expect(ok).toBe(false)
    expect(output).toContain('ERROR')
  })

  it('编译通过：tonemap stage（链尾 ToneMapping）', () => {
    const src = buildTonemapStandalone()
    expect(src.startsWith('#version 300 es')).toBe(true)
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(`glslangValidator 编译失败（tonemap）:\n${output}`)
    }
    expect(ok).toBe(true)
  })
})

// M5 atmosphere 路径：CLOUDS_SHADOW_LENGTH 开的编译组合（sky 分支采样 u_cloudsShadowLength）
describe('M5 CLOUDS_SHADOW_LENGTH 编译', () => {
  it('glslang：cloudsShadowLength 开编译通过（sampler2D 声明 + 天空分支采样）', () => {
    const src = buildStandaloneShaderForValidation({ cloudsShadowLength: true })
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(`glslang 编译失败（cloudsShadowLength=true）:\n${output}\n` + src.split('\n').slice(0, 40).map((l, i) => `${i + 1}: ${l}`).join('\n'))
    }
    expect(ok).toBe(true)
  })
})

// ── 月盘 MOON（2026-08-30 夜间光照 spec r2 §5）：out 通道方案 + acos 判定 + Oren-Nayar 月相 ──
describe('月盘 MOON 段（spec r2 §5）', () => {
  const build = () => buildAerialPerspectiveFragmentShader({ moon: true })
  const buildOff = () => buildAerialPerspectiveFragmentShader({ moon: false })

  it('moon=true：三 uniform 声明 + getSkyRadiance out moonDisc 签名 + finalColor 加法项', () => {
    const src = build()
    expect(src).toContain('uniform vec3 moonDirection;')
    expect(src).toContain('uniform float moonAngularRadius;')
    expect(src).toContain('uniform float u_moonRadiance;')
    expect(src).toMatch(/out vec3 moonDisc/)
    // finalColor 行：+ moonDisc 独立加法（不吃 u_inscatterScale）
    expect(src).toContain('+ inscatter * u_inscatterScale + moonDisc;')
  })

  it('moon=true：acos 判定 + 边序恒升序守卫（禁 dot 直比/降序边）', () => {
    const src = build()
    expect(src).toContain('acos(clamp(dot(rayDirection, moonDirection), -1.0, 1.0))')
    expect(src).toContain('float moonAA = max(fragmentAngle, 1e-4);')
    expect(src).toContain('1.0 - smoothstep(moonAngularRadius - moonAA, moonAngularRadius, moonAngle)')
  })

  it('moon=true：Oren-Nayar MoonNode 版常量与实参序（禁 sky.glsl 旧版常量）', () => {
    const src = build()
    expect(src).toContain('0.2466') // A=(1/π)(1−0.5/1.33+0.17/1.13)
    expect(src).toContain('0.1314') // B=(1/π)(0.45/1.09)
    expect(src).toContain('smoothstep(0.0, 0.1, sOV)') // t 公式 edges-first 记法
    expect(src).not.toContain('0.62406') // sky.glsl 旧版
    // 实参序：V = -rayDirection
    expect(src).toContain('dot(moonNormal, -rayDirection)')
  })

  it('moon=true：limbFade 显式乘月盘 + hasScene 前景雾 mix 月盘到 0（山遮月）', () => {
    const src = build()
    expect(src).toContain('moonDisc *= limbFade;')
    expect(src).toContain('moonDisc = mix(moonDisc, vec3(0.0), mask);')
  })

  it('moon=true：亮度公式（2.5e-6 / πω² / SUN_SPECTRAL 换算）', () => {
    const src = build()
    expect(src).toContain('2.5e-6')
    expect(src).toMatch(/PI \* moonAngularRadius \* moonAngularRadius/)
    expect(src).toContain('SUN_SPECTRAL_RADIANCE_TO_LUMINANCE * u_moonRadiance')
  })

  it('moon=true：u_moonTint 色调乘子（冷色默认乘进 moonDiscRadiance；moon=false 无声明）', () => {
    const src = build()
    expect(src).toContain('uniform vec3 u_moonTint;')
    expect(src).toContain('* u_moonTint * onDiffuse * moonAlbedo')
    const srcOff = buildOff()
    expect(srcOff).not.toContain('u_moonTint')
  })

  it('moon=false golden：产物与现状（无 moon 代码）逐字符一致', () => {
    const srcOff = buildOff()
    expect(srcOff).not.toContain('moonDisc')
    expect(srcOff).not.toContain('moonDirection')
    expect(srcOff).not.toContain('u_moonRadiance')
    expect(srcOff).toContain('+ inscatter * u_inscatterScale;') // finalColor 回现状
    // golden：与 git 上一版（moon 未引入时）moon 无关组合产物比对——用 snapshot 守门
    //（首个 run 录基线；此后任何 moon=false 产物变化即 fail）
    expect(srcOff).toMatchSnapshot('moon-off-golden')
  })

  it('glslang：moon=true 与 moon=false 两态真编译通过', () => {
    for (const moon of [true, false]) {
      const src = buildStandaloneShaderForValidation({ moon })
      const { ok, output } = compileFragment(src) // 文件内既有 compile helper
      if (!ok) throw new Error(`moon=${moon} 编译失败:\n${output}`)
      expect(ok).toBe(true)
    }
  })
})

// ── 夜间天空 inscatter 淡出（2026-08-31 地平线泛红二轮修复）──
// 根因：Bruneton 散射 LUT 高阶项太阳深潜后不精确归零，地平线长路径残余 ×u_inscatterScale(25)
// 放大成可见橙红（实测真深夜太阳 -69° 云全关仍整圈红）；物理上 <-18°（天文暮光末）天空太阳
// 散射应为零。修法=inscatter 乘 skyNightFade（窗口 sin(-18°)→sin(-4°)，白天/民用暮光零回归）。
describe('夜间天空 inscatter 淡出 skyNightFade', () => {
  const build = () => buildAerialPerspectiveFragmentShader({})

  it('窗口常量 sin(-12°)=-0.2079 / sin(-6°)=-0.1045 + inscatter 乘 fade', () => {
    const src = build()
    expect(src).toContain('float skyNightFade = 1.0 - smoothstep(-0.2079, -0.1045, muSunSky);')
    expect(src).toContain('inscatter *= skyNightFade;')
  })

  it('muSunSky 用相机径向法线（与 clouds.frag nightFactor 同源几何）', () => {
    const src = build()
    expect(src).toContain('float muSunSky = dot(normalize(cameraPosition), sunDirection);')
  })

  it('glslang：含 skyNightFade 的完整 shader 真编译', () => {
    const src = buildStandaloneShaderForValidation({})
    const { ok, output } = compileFragment(src)
    if (!ok) throw new Error(`编译失败:\n${output}`)
    expect(ok).toBe(true)
  })
})
