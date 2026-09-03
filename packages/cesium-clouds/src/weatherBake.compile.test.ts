// Task 3：weatherBake.frag.glsl（WeatherAtlas 烘焙 shader，spec §5）编译验证。
//
// 组装走 buildStandaloneWeatherBakeShader（weatherBakeAssembler.ts）——本测试与
// Task 5 WeatherAtlas 烘焙 pass 共用同一条组装路径（防两处 include/版本头组装漂移）。
// 对照范式：cloudsMain.compile.test.ts（glslangValidator 真编译）。

import { describe, expect, it } from 'vitest'

import { compileFragment } from './glslangUtil'
import { glslIndex } from './glslIndex'
import { buildStandaloneWeatherBakeShader } from './weatherBakeAssembler'

describe('weatherBake.frag 编译（spec §5.1/§5.2）', () => {
  it('glslangValidator 编译通过', () => {
    const src = buildStandaloneWeatherBakeShader(glslIndex)
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(
        `烘焙 shader 编译失败:\n${output}\n` +
          `---- shader 全文（1-based）----\n${src
            .split('\n')
            .map((l, i) => `${i + 1}: ${l}`)
            .join('\n')}`
      )
    }
    expect(ok).toBe(true)
  })

  it('含周期化铁律要素：u_slice 时间维、圆环演化、extra 通道旧图语义', () => {
    const src = glslIndex.weatherBakeFrag
    expect(src).toContain('u_slice')
    expect(src).toContain('Z_CYCLES')
    expect(src).toContain('W_CYCLES')
    // 第 4 通道 = extra（对齐旧图 localWeather.frag extra 语义）。spec §4.6「a 恒 1」
    // 已被 T8 证伪（旧 PNG 资产 A 有真实分布 mean 0.415；旧 shader 尾部 a=1.0 覆盖系后加、
    // 与资产失同步）——断言随 spec 修订同步（§4.6 勘误待 T9）。
    expect(src).toContain('outputColor = vec4(low, mid, high, extra)')
    // 复合顺序钉死（spec §5.2）：演化偏移在 warp 之后（pw 已含 p）
    expect(src).toContain('vec3 bakePoint = vec3(pw + ringOffset')
  })

  it('评审修复钉死（fix round 1）：worleyFeatureOffset 返回 vec3 分量独立 + precision 无重复', () => {
    const src = glslIndex.weatherBakeFrag
    // 评审 Critical：返回标量和会把三路独立 hash 广播回 (s,s,s)——特征点仍钉 cell 对角线
    // （spec §1 根因 4 修正失效），且 s∈[0,3) 超 cell 边界破坏 ±1 邻域完备性。钉死 vec3 签名
    // 与直接返回 o 的函数体。
    expect(src).toContain('vec3 worleyFeatureOffset(')
    expect(src).toContain('  return o;')
    // 评审 Minor 2：组装产物 precision highp float 恰好 1 处（shader 本体自带；
    // assembler 只补 #version 头）——重复声明合法但属噪音，防回归再现。
    const assembled = buildStandaloneWeatherBakeShader(glslIndex)
    expect(assembled.split('precision highp float;').length - 1).toBe(1)
  })

  it('评审修复钉死（fix round 2）：low/mid 挖除语义（低中互斥，对齐采样端 Skybolt 标定）', () => {
    const src = glslIndex.weatherBakeFrag
    // T8 真浏览器实证：「独立通道+max」与采样端 Skybolt 调制链（coverage=0.3/
    // coverageFilterWidths=0.6，按旧图挖除语义设计）失配 → 调制压不住 → 饱和白雾、
    // 单体结构丢失。烘焙端恢复旧图挖除：low = saturate(low - mid)，低中互斥。
    expect(src).toContain('low = clamp(low - mid, 0.0, 1.0)')
    // 「独立+max」组合不得回归（max 一旦回归，联合覆盖重新撑爆调制链）
    expect(src).not.toContain('mid = max(mid, low)')
  })

  it('评审修复钉死（fix round 3）：B 去双重放大 + A 恢复旧图 extra 语义', () => {
    const src = glslIndex.weatherBakeFrag
    // T8 实证 B 通道双重放大：perlin.glsl 末行已含内部 2.2×（return 2.2 * n_xyzw），
    // 外层再乘 → 40.7% 像素 >0.9（旧图 2.1%）→ 饱和白雾主源。对齐旧图直采（无外层系数）。
    expect(src).toContain('high = smoothstep(-0.5, 0.5, high)')
    expect(src).not.toContain('high * 2.2')
    // A 通道对齐旧图 extra 逐字（freq 32 / 4 octaves / 相位 (-19.1,33.4,47.2)，
    // tileableNoise.glsl:86 重载）——「a 恒 1」前提被资产实测推翻（见上用例注释）。
    expect(src).toContain('getPerlinNoise(bakePoint + vec3(-19.1, 33.4, 47.2), 32.0, 4)')
    expect(src).not.toContain('outputColor.a = 1.0')
  })
})
