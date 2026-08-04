// Task 10：lensFlare 全 shader GLSL 真编译验证（spec §6.2）。
//
// 与 aerialPerspective.compile.test.ts 同思路：单测只做字符串展开抓不到编译期
// 错误，本文件对 lensFlare 7 个 fragment（threshold / bloomDownsample /
// bloomUpsample / preBlur / features / occlusion / composite）调各自的
// buildStandaloneShaderForValidation 生成完整 GLSL（#version 300 es + czm_* 桩），
// 喂给真实 glslangValidator（ESSL 3.20）做编译，断言退出码 0。
//
// glslang 调用 helper（getGlslangValidatorPath/whichSystem/PLATFORM_SUFFIX/
// compileFragment）抽在 ../glslangUtil.ts，与 aerialPerspective.compile.test.ts
// 共享同一份实现。

import { describe, expect, it } from 'vitest'
import { compileFragment } from '../glslangUtil'
import { buildStandaloneShaderForValidation as threshold } from './threshold.frag'
import { buildStandaloneShaderForValidation as down } from './bloomDownsample.frag'
import { buildStandaloneShaderForValidation as up } from './bloomUpsample.frag'
import { buildStandaloneShaderForValidation as preBlur } from './preBlur.frag'
import { buildStandaloneShaderForValidation as features } from './features.frag'
import { buildStandaloneShaderForValidation as occlusion } from './occlusion.frag'
import { buildStandaloneShaderForValidation as composite } from './composite.frag'

// 7 个 lensFlare fragment shader；顺序与 stage 链路（threshold→bloom→features→
// occlusion→composite）大致一致，便于失败时人工对照。
const SHADERS: Array<[string, () => string]> = [
  ['threshold', threshold],
  ['bloomDown', down],
  ['bloomUp', up],
  ['preBlur', preBlur],
  ['features', features],
  ['occlusion', occlusion],
  ['composite', composite]
]

describe('GLSL 编译验证（lensFlare 全 shader）', () => {
  for (const [name, build] of SHADERS) {
    it(`编译通过：${name}`, () => {
      const src = build()
      // 前置断言：输入确实是 #version 300 es 独立 shader（防 build 函数退化）。
      expect(src.startsWith('#version 300 es')).toBe(true)
      const { ok, output } = compileFragment(src)
      if (!ok) {
        // 失败时把 glslang 全部输出落到断言消息，并附 shader 前 40 行便于定位行号。
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

  it('glslang 真抓错误（防哑过）', () => {
    // 注入未声明标识符，验证 glslang 非哑过——若这个测试失败说明编译器没在干活。
    const { ok } = compileFragment(
      '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){o=vec4(noSuchThing);}'
    )
    expect(ok).toBe(false)
  })
})
