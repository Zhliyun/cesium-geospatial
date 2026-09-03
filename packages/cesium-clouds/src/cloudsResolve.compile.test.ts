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

// 【2026-09-03 穿云黑块修复】TAA 分支补 disocclusion rejection——312573d 只加在
// temporalUpscale 分支（N=4 时代默认档），1ce0d93 默认档切 N=1 走 temporalAntialiasing
// 后补丁丢失：穿云 velocity 错位 → history 采到无效 texel → γ=2 宽 AABB 剪不住 →
// mix 90% 黑 history 固化扩散（用户傍晚穿云黑块 A/B 实证）。
describe('穿云黑块修复：temporalAntialiasing 补 disocclusion rejection', () => {
  it('TAA 分支含 |Δa| rejection（与 temporalUpscale 同款）', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    const taa = src.slice(src.indexOf('void temporalAntialiasing'))
    expect(taa).toContain('abs(currentColor.a - historyColor.a)')
    expect(taa).toContain('Disocclusion rejection')
  })

  it('glslang：TAA 组合（temporalUpscale=false）真编译', () => {
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: false }),
      'TAA rejection'
    )
  })
})

// 【2026-09-03 夜间云内移动黑块修复】getClosestFragment 远平面守卫——云甲内视角下
// depthVelocity.r 在「有云 texel（云距）/无云 texel（cameraFar≈1e10）」间逐像素跳变，
// 3×3 全局最近深度让无云 texel 借到别处云的 velocity → history 重投影错位 → 云 a/rgb
// 拖尾成层叠鬼影（暗色块，移动时持续、刷新才清；夜晚 761m 复现组 n-move-05 实证）。
// 修=中心 texel 自身 depth 为远平面级（无云）时不借邻居、退回自身 velocity（自身即
// no-hit 分支的 view-space 自洽重投影）。
describe('夜间云内移动黑块修复：getClosestFragment 远平面守卫', () => {
  it('守卫在场：无云（远平面 depth）texel 退回自身 velocity，不跨层借邻居', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).toContain('getClosestFragmentNoCloudGuard')
    expect(src).toContain('vec4 centerDepthVelocity = texelFetch(depthVelocityBuffer, coord, 0);')
  })

  it('glslang：守卫在场真编译', () => {
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: false }),
      'no-cloud guard'
    )
  })
})

// 【2026-09-03 coverage=1 云甲内盐粒崩坏修复：getClosestFragment 深度同质性守卫】
// 甲内水平视角（camera=...,1770,...,-6.1 + coverage=1 稳定复现）下 depthVelocity.r 在
// 「近云数米 ↔ 甲顶球远端数百 km」间逐像素跳变（合法几何值，非远平面哨兵）——9b523d2
// 的 1e8 守卫不覆盖。3×3 全局最近深度让远端 texel 借到近云 texel 的 velocity（反向错借
// 同样存在）→ history 大距离错位重投影；coverage=1 全屏皆云 a≈1 → |Δa| rejection 永不
// 触发 → γ=2 AABB 拦不住 rgb 域错位 → mix 90% 错位 history = 满屏盐粒（temporal=0 直通
// 同一 march buffer 平滑、upscale=4 分支正常——层锁定 TAA 分支；静止后 0.9^n 慢冲刷=
// 用户体感「无法恢复」）。
// 修=邻居 depth 与中心 depth 比值超 2× 不参与 min 竞争（深度同质才可借）；无同质邻居
// 退回自身 velocity。泛化 1e8 守卫到「合法但悬殊」域，closest 边缘语义保留。
describe('coverage=1 云甲内盐粒修复：getClosestFragment 深度同质性守卫', () => {
  it('同质守卫在场：邻居/中心深度比 >2 跳过，无同质邻居退自身', () => {
    const src = buildCloudsResolveFragmentShader(OPTS)
    expect(src).toContain('getClosestFragmentDepthHomogeneityGuard')
    expect(src).toContain('neighbor.r <= centerDepth * 2.0 && centerDepth * 2.0 <= neighbor.r')
  })

  it('glslang：同质守卫在场真编译（TAA 分支）', () => {
    compileOrFail(
      buildStandaloneCloudsResolveShaderForValidation({ temporalUpscale: false }),
      'depth homogeneity guard'
    )
  })
})
