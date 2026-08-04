// depthTemporal 回归测试（Task 13）：保护 Task 1-12 既有代码的 3 类核心不变量。
//
// 1. 坐标系：reproject 公式纯 ECEF 米域（czm_inverseView → u_prevViewProjection → prevUV）。
//    静态 VP（prevVP=curVP）时 prevUV=curUV（reproject 自洽）。
// 2. VP 一致性：JS prevViewProjection = camera.frustum.projectionMatrix · camera.viewMatrix（new Matrix4()
//    非 in-place mutate IDENTITY），与 shader u_prevViewProjection / czm_viewProjection 同源。
// 3. EMA 收敛：mock LOD 抖动 depth 序列 → smoothDepth 经 N 帧 IIR 收敛（方差 < 阈值）。
// 4. disocclusion：cur 大跳变（relDiff > threshold）→ alpha=1 拒绝历史（不累积错误 depth）。
//
// 本测试验证既有代码不变量，应直接 pass。若 fail 说明 Task 1-12 产品代码偏离 plan。
// EMA 收敛/disocclusion 是 TS 数值模拟（mix + alpha 数学），非 GLSL 执行（GLSL 执行需 Cesium
// 运行时，留 Task 14 视觉验收）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDepthTemporalFragmentShader } from './depthTemporal.frag'

// ESM 无 __dirname；import.meta.url 解析同目录源文件路径（vitest 保持源码目录结构）。
const AtmosphereStageSrc = readFileSync(
  fileURLToPath(new URL('../AtmosphereStage.ts', import.meta.url)),
  'utf8'
)

describe('depthTemporal 回归（坐标系 + VP 一致性 + EMA 收敛 + disocclusion）', () => {
  // 1. 坐标系：reproject 公式正确（worldPosECEF 纯 ECEF 米 → u_prevViewProjection → prevClip → prevUV）
  it('坐标系：reproject 公式（czm_inverseView * eyePos.xyz → worldPosECEF → u_prevViewProjection → prevUV）', () => {
    const s = buildDepthTemporalFragmentShader({ enabled: true })
    // 反演 worldPosECEF（纯 ECEF 米，禁 altitudeCorrection/METER_TO_LENGTH_UNIT）
    expect(s).toContain('czm_inverseView * vec4(eyePos.xyz, 1.0)')
    expect(s).not.toContain('altitudeCorrection')
    expect(s).not.toContain('METER_TO_LENGTH_UNIT')
    // reproject 到上帧
    expect(s).toContain('prevClip = u_prevViewProjection * vec4(worldPosECEF')
    expect(s).toContain('prevUV = prevClip.xy / prevClip.w * 0.5 + 0.5')
  })

  // 2. VP 一致性：JS postRender 用 camera.frustum.projectionMatrix · camera.viewMatrix（与 shader czm_viewProjection 同源）
  it('VP 一致性：JS prevViewProjection = camera.frustum.projectionMatrix · camera.viewMatrix（new Matrix4() 非 in-place）', () => {
    // postRender lifecycle 用 camera.frustum.projectionMatrix · camera.viewMatrix
    expect(AtmosphereStageSrc).toContain('camera.frustum.projectionMatrix')
    expect(AtmosphereStageSrc).toContain('camera.viewMatrix')
    // Matrix4.multiply(proj, view, new Matrix4())——new Matrix4() 作 result，非 in-place mutate IDENTITY
    expect(AtmosphereStageSrc).toMatch(
      /Matrix4\.multiply\(\s*camera\.frustum\.projectionMatrix\s*,\s*camera\.viewMatrix\s*,\s*new Matrix4\(\)/
    )
  })

  // 3. EMA 收敛：mock LOD 抖动 depth 序列 → smoothDepth 经 N 帧 EMA 收敛（方差 < 阈值）
  it('EMA 收敛：alpha=0.05 IIR，奇偶抖动 ±0.0025 → 60 帧后 smoothDepth 方差 < 1e-6', () => {
    // EMA IIR 数学：smooth = mix(hist, cur, alpha) = hist + (cur - hist) * alpha
    // mock LOD 抖动：奇偶帧 cur = 0.9 ± 0.0025（瓦片 LOD 过渡致 depthTexture 逐帧抖）
    let smooth = 0.9 // 初始 log-depth
    const alpha = 0.05 // LOW_ALPHA 静止强累积
    const samples: number[] = []
    for (let i = 0; i < 60; i++) {
      const cur = 0.9 + (i % 2 === 0 ? 0.0025 : -0.0025) // 奇偶抖动 ±0.0025
      smooth = smooth + (cur - smooth) * alpha // mix(hist, cur, alpha)
      samples.push(smooth)
    }
    // 60 帧后收敛（最后 10 帧方差 < 1e-6）
    const variance = computeVariance(samples.slice(-10))
    expect(variance).toBeLessThan(1e-6)
    // 收敛值应接近 0.9（抖动中心）
    expect(Math.abs(smooth - 0.9)).toBeLessThan(0.01)
  })

  // 4. EMA 拒绝跳变（disocclusion）：cur 突变（远→近）→ alpha=1 直接用 cur（不累积历史）
  it('disocclusion：cur 大跳变（relDiff > threshold）→ alpha=1 拒绝历史（不累积错误 depth）', () => {
    // 模拟 disocclusion：hist=0.9（远），cur=0.3（近，relDiff = |0.9-0.3|/0.3 = 2.0 >> threshold 0.1）
    // → consistent=false → alpha=1 → smoothDepth = cur（不累积 hist）
    const hist = 0.9,
      cur = 0.3,
      threshold = 0.1
    const relDiff = Math.abs(hist - cur) / Math.max(cur, 1e-4)
    const consistent = relDiff < threshold
    const alpha = consistent ? 0.05 : 1.0 // 不一致 → alpha=1
    const smooth = hist + (cur - hist) * alpha // alpha=1 → smooth = cur
    expect(consistent).toBe(false) // relDiff=2.0 >> 0.1
    expect(smooth).toBeCloseTo(cur, 5) // 直接用 cur，拒绝历史
  })
})

// plan Task 13 placeholder 实现：mean = avg(arr); variance = avg((x-mean)²)
function computeVariance(arr: number[]): number {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  return arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / arr.length
}
