// cloudsResolve.compile.test.ts
//
// M4 T2：cloudsResolve.frag surgery 组装验证 + glslang 真编译。
// 对齐 shadowMain.compile.test.ts 范式（compileFragment helper + 防哑过用例）。

import { describe, expect, it } from 'vitest'

import {
  buildCloudsResolveFragmentShader,
  buildStandaloneCloudsResolveShaderForValidation,
  type CloudsResolveOptions
} from './CloudsResolveMaterial'
import { compileFragment } from './glslangUtil'

const OPTS: CloudsResolveOptions = {}

// 共用：glslang 编译失败时打印前 60 行辅助定位（同 shadowMain.compile.test.ts）
function compileOrFail(src: string, label: string): void {
  const { ok, output } = compileFragment(src)
  if (!ok) {
    throw new Error(
      `glslangValidator 编译失败（${label}）:\n${output}\n` +
        `---- shader 前 60 行（1-based）----\n${src
          .split('\n')
          .slice(0, 60)
          .map((l, i) => `${i + 1}: ${l}`)
          .join('\n')}`
    )
  }
  expect(ok).toBe(true)
}

describe('M4 T2 cloudsResolve.frag surgery 断言', () => {
  it('vUv → v_textureCoordinates 桥接（Cesium ViewportQuadVS）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).toContain('in vec2 v_textureCoordinates;')
    expect(src).toContain('#define vUv v_textureCoordinates')
    expect(src).not.toMatch(/in vec2 vUv;/)
  })

  it('删 jitterOffset（frag 声明未消费——组装层清掉，免绑空 uniform）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).not.toContain('jitterOffset')
  })

  it('defines：TEMPORAL_UPSCALE 开；SHADOW_LENGTH 关（M5 接 god rays 时再开）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).toContain('#define TEMPORAL_UPSCALE')
    expect(src).not.toContain('#define SHADOW_LENGTH')
    // SHADOW_LENGTH 关 → loc1 out 与相关 include 处在 #ifdef 内（编译期裁掉；
    // 文本级断言：块由 #ifdef SHADOW_LENGTH 包裹存在、我们未 define 它）
    expect(src).toContain('#ifdef SHADOW_LENGTH')
    expect(src).toContain('#if !defined(SHADOW_LENGTH)') // 局部 float outputShadowLength 兜底声明
  })

  it('temporalUpscale=false：走 temporalAntialiasing 分支（无 TEMPORAL_UPSCALE define）', () => {
    const src = buildCloudsResolveFragmentShader({ temporalUpscale: false })
    expect(src).not.toContain('#define TEMPORAL_UPSCALE')
  })

  it('防哑过：删掉 v_textureCoordinates 声明后 glslang 必须报错（证明编译器真在跑）', () => {
    const broken = buildStandaloneCloudsResolveShaderForValidation(OPTS).replace(
      'in vec2 v_textureCoordinates;',
      ''
    )
    const { ok } = compileFragment(broken)
    expect(ok).toBe(false)
  })

  it('glslang 真编译：runtime 双分支均过（含 include 展开 + unrollLoops）', () => {
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: true }),
      'temporalUpscale=true'
    )
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: false }),
      'temporalUpscale=false'
    )
  })

  it('upscaleDivisor=2（涂抹修复 T1）：注入 #define UPSCALE_DIVISOR 2 + 2×2 Bayer 直通分支在场 + glslang 过', () => {
    const src = buildCloudsResolveFragmentShader({ temporalUpscale: true, upscaleDivisor: 2 })
    expect(src).toContain('#define UPSCALE_DIVISOR 2')
    expect(src).toContain('bayerIndices2') // N=2 直通映射表
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: true, upscaleDivisor: 2 }),
      'upscaleDivisor=2'
    )
  })

  it('upscaleDivisor 缺省=1（2026-09-02 定稿）：TAA 运行时组合（temporalUpscale=false）注入 #define UPSCALE_DIVISOR 1', () => {
    // 运行时 N=1 恒走 temporalUpscale=false（CloudsResolvePass.ts：temporalUpscale: upscaleDivisor > 1）
    const src = buildCloudsResolveFragmentShader({ ...OPTS, temporalUpscale: false })
    expect(src).toContain('#define UPSCALE_DIVISOR 1')
    expect(src).toContain('temporalAntialiasing(coord')
    expect(src).not.toContain('#define TEMPORAL_UPSCALE')
  })
})
