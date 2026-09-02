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

  it('含周期化铁律要素：u_slice 时间维、圆环演化、a 通道恒 1', () => {
    const src = glslIndex.weatherBakeFrag
    expect(src).toContain('u_slice')
    expect(src).toContain('Z_CYCLES')
    expect(src).toContain('W_CYCLES')
    // 第 4 通道恒 1（spec §4.6 死值语义）——断言对齐 shader 实际形态（vec4 构造尾参 1.0，
    // 同 preflight 对 bakePoint 断言「按实际代码形态修」同一原则）
    expect(src).toContain('outputColor = vec4(low, mid, high, 1.0)')
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
})
