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

  it('moon=true：月光天空散射（月晕）——朝月向二次 GetSkyRadiance 走 moonDisc 通道（绕 skySunVisibility）', () => {
    const src = build()
    expect(src).toContain('uniform float u_moonSkyScale;')
    expect(src).toContain('uniform float u_moonIlluminatedFraction;')
    // 物理源：朝月方向二次采样天空散射（Mie 前向峰 → 月盘邻近更亮自动涌现）
    expect(src).toContain('GetSkyRadiance(cameraPosition, rayDirection, 0.0, moonDirection')
    // 走 moonDisc out 通道（+= 语义：月盘+背后月晕叠加），不进 radiance/inscatter——
    // main 末端 inscatter *= skySunVisibility（六轮修复：太阳可见度门）会把深夜月光散射
    // 一并消零，通道绕开且天然继承 hasScene 前景雾遮月 + limbFade
    expect(src).toContain('moonDisc += moonGlow')
    // 夜间门（与 clouds.frag 月光 §6.1 同体系逐字对齐，锚=相机天顶）：nightFactor 白天=0
    // （白天像素级零回归——月光项 +6% 被门归零）、moonFactor=月相×月升落；
    // aureole=解析前向峰恢复 LUT nu 维（32 texel）丢失的月晕角聚集形（像素差分实证：
    // 纯 LUT 项全局均匀微亮、紧邻环≈远处天空，无月晕形）
    expect(src).toContain('u_moonSkyScale * 2.5e-6 * moonNightFactor * moonFactor * moonAureole')
    expect(src).toContain('1.0 + 15.0 * exp(-moonTheta / 0.06)')
    // out 参数函数内读前显式归零（out 语义不保证入口值；月盘段因此从 = 改 +=）
    expect(src).toContain('moonDisc = vec3(0.0);')
    const srcOff = buildOff()
    expect(srcOff).not.toContain('u_moonSkyScale')
    expect(srcOff).not.toContain('moonGlow')
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

  it('窗口常量 sin(-12°)=-0.2079 / sin(-6°)=-0.1045 + inscatter 乘太阳可见度（六轮方向修复）', () => {
    const src = build()
    // 六轮（2026-08-31 天空黑回归）：首版 skyNightFade=1-smoothstep 用作乘数方向反——白天 mu>0
    // →fade=0→inscatter 全消→天空黑/地形无雾（用户实测全屏黑；中间验收图因 vite 缓存假绿未揭穿）。
    // 正确=直接乘 smoothstep（太阳可见度：白天=1 保留/深夜=0 消）；云侧 clouds.frag 的
    // inscatter *= 1.0 - skyNightFade 嵌套双重否定恰好同义，不动。
    expect(src).toContain('float skySunVisibility = smoothstep(-0.2079, -0.1045, muSunSky);')
    expect(src).toContain('inscatter *= skySunVisibility;')
    expect(src).not.toContain('inscatter *= 1.0 - smoothstep')
  })

  it('muSunSky 锚点=视线代表点（地面=椭球交点/天空=大气顶层入口）——太空晨昏线+朝天 NaN 双修', () => {
    const src = build()
    // 首版相机锚：太空夜侧上空 muSunSky≈-1→fade=0 整屏 inscatter 全灭（晨昏线消失被驳回）
    expect(src).not.toContain('dot(normalize(cameraPosition), sunDirection)')
    // 地面视线锚=椭球面交点（cameraPosition + rayDirection * tHitG）
    expect(src).toContain('vec3 fadeAnchor = (lookingAtGround && discG > 0.0)')
    expect(src).toContain('? cameraPosition + rayDirection * tHitG')
    // 天空视线锚=大气顶层 topR 入口点（三轮的脚点锚在天顶视线塌到地心 normalize=NaN 整屏黑、
    // 朝天 t*<0 脚点在相机背后——五轮改射线-球前向交点，相机在大气内朝天必存在）
    expect(src).toContain('float tTop = -rmuTop + sqrt(max(rmuTop * rmuTop - rCam * rCam + topR * topR, 0.0));')
    expect(src).toContain(': cameraPosition + rayDirection * tTop;')
    expect(src).toContain('float muSunSky = dot(normalize(fadeAnchor), sunDirection);')
  })

  it('glslang：含 skyNightFade 的完整 shader 真编译', () => {
    const src = buildStandaloneShaderForValidation({})
    const { ok, output } = compileFragment(src)
    if (!ok) throw new Error(`编译失败:\n${output}`)
    expect(ok).toBe(true)
  })
})

// ── 地面光色乘子 groundLightColor（2026-09-01 影像×大气颜色同步，三专家评审后定稿）──
// 根因：地面合成式 originalColor·transmittance·groundDim+inscatter 无照明项——影像=正午白光
// 快照，日落近景不染色、夜间均匀压暗成「暗淡的正午图」。修法=变体 1 光色乘子：
// (sunIrr+skyIrr)/ATMOSPHERE.solar_irradiance（影像=白光快照的比值语义，π 同侧抵消；
// half-float LUT 比值消费无 A 路径灾消）+ vec3 夜间地板 max()（乘法保地物纹理）。
// 评审结论：normal 必须向外 +normalize（简报笔误向内会让直射/天光恒 0 白天全黑）；
// 天空像素 groundLightColor=1.0 零 LUT 采样；开关 u_groundLighting 用 mix 门控（无新编译组合）。
describe('地面光色乘子 groundLightColor', () => {
  const build = () => buildAerialPerspectiveFragmentShader({})

  it('乘子计算：内联 GetTransmittanceToSun+GetIrradiance + 向外 normal + solar_irradiance 归一（评审 G1/物理 A 节）', () => {
    const src = build()
    // LUT 调用（bruneton/common 现成函数）+ 归一锚=GLSL const ATMOSPHERE.solar_irradiance。
    // 注意不能直接调 GetSunAndSkyIrradiance：runtime.glsl:460 #define 把它重定向到 Luminance 域
    // 4 参 Illuminance 版（编译错）——必须按其内部实现内联（云侧 include 顺序不同无此坑）。
    // not.toContain 不能用裸名/(\n 形态——runtime.glsl 的 #define 行与函数定义本身含之。
    // 「不得直接调 GetSunAndSkyIrradiance」由下方 glslang 真编译守门（7 参调用会撞 Illuminance
    // 重定向编译错），此处不断言。
    expect(src).toContain('GetTransmittanceToSun(ATMOSPHERE, transmittance_texture, length(scenePosKm), groundMuS)')
    expect(src).toContain('GetIrradiance(')
    expect(src).toContain('/ ATMOSPHERE.solar_irradiance')
    // normal 向外（评审 Critical：向内则直射 max(dot(n,sun),0) 恒 0、天光因子恒 0 → 地面全黑）
    expect(src).toContain('vec3 groundNormal = normalize(scenePosKm);')
    expect(src).not.toContain('-normalize(scenePosKm)')
    // 乘子只在地表锚点算（天空像素走 1.0 初始化零采样）
    expect(src).toContain('vec3 groundLightColor = vec3(1.0);')
  })

  it('夜间地板：vec3 uniform + max() 乘法语义（保地物纹理，非云侧加法自发光）', () => {
    const src = build()
    expect(src).toContain('uniform vec3 u_groundNightAmbient;')
    expect(src).toContain('max(\n      (groundSunIrr + groundSkyIrr) / ATMOSPHERE.solar_irradiance,\n      u_groundNightAmbient\n    )')
  })

  it('开关：u_groundLighting mix 门控（1=启用默认，0=A/B 对照兼 CI 逃生门）', () => {
    const src = build()
    expect(src).toContain('uniform float u_groundLighting;')
    expect(src).toContain('mix(vec3(1.0), groundLightColor, u_groundLighting)')
  })

  it('finalColor 合成：originalColor 乘 groundLightColor（乘 transmittance 之前）', () => {
    const src = build()
    expect(src).toContain(
      'originalColor.rgb * groundLightColor * transmittance * u_groundDim + inscatter * u_inscatterScale'
    )
  })

  it('glslang：含乘子的完整 shader 真编译', () => {
    const src = buildStandaloneShaderForValidation({})
    const { ok, output } = compileFragment(src)
    if (!ok) throw new Error(`编译失败:\n${output}`)
    expect(ok).toBe(true)
  })
})
