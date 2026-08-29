// createLensFlareStage 接线层单测（spec §3 拓扑 + §5.9 集成 + §5.7 sampleMode）。
//
// 聚焦三条最高风险评审项（逐条覆盖）：
//   C2  — lf_bloom series composite 的 get0 必须是 lf_threshold（非 down0）：
//          down0 读 atmosphere 的阈值化结果，若 get0 错放 down0 则 down0 直接读原 atmosphere，
//          阈值化被跳过，bloom 链过亮。
//   I9  — up[i].uniforms.u_downLevel 必须是 uniform-name **string 字面量**（非 function）：
//          同 textureScale 的 down/up 共享 framebuffer，只有 uniform-name 引用才让 Cesium
//          依赖图把 down[对应] 排在 up[i] 前；若用 function 返回 texture 对象，依赖不建，
//          up 渲染冲刷 down 输出（白屏）。映射 up0→down3 ... up3→down0, up4→threshold。
//   I10 — features/composite 的 uniform-name texture 引用（u_preBlurTexture/u_occlusionTexture/
//          u_bloomTexture/u_featuresTexture）全 string 字面量：non-series 兄弟 stage 不在 series
//          链中，只有 uniform-name 显式引用才构建跨 stage 依赖（保证 lf_preBlur/lf_occlusion 先于
//          lf_features、lf_up4/lf_features 先于 lf_composite）。
//
// node 环境无 WebGL：PostProcessStage/Composite 构造仅赋值字段（不创建 GL 资源），可直接 new。
// mockScene 提供 resolvePostHdrDatatype 需要的 context caps + globe.ellipsoid。
// uniform 闭包（如 u_cameraPositionWC）不在构造期调用，故 mock 不必提供 camera。

import { describe, expect, it } from 'vitest'
import {
  PostProcessStageComposite,
  PostProcessStageSampleMode,
  PixelDatatype
} from 'cesium'
import { createLensFlareStage } from './createLensFlareStage'
import {
  THRESHOLD_LEVEL_DEFAULT,
  THRESHOLD_RANGE_DEFAULT,
  INTENSITY_DEFAULT,
  GHOST_AMOUNT_DEFAULT,
  HALO_AMOUNT_DEFAULT,
  CHROMATIC_ABERRATION,
  UPSAMPLE_RADIUS
} from './lensFlareConstants'
import { SUN_ANGULAR_RADIUS } from '../../math/atmosphereParameters'

function mockScene(postHdrDatatype: PixelDatatype = PixelDatatype.HALF_FLOAT) {
  return {
    context: {
      halfFloatingPointTexture: true,
      colorBufferHalfFloat: postHdrDatatype === PixelDatatype.HALF_FLOAT,
      floatingPointTexture: true,
      colorBufferFloat: postHdrDatatype === PixelDatatype.FLOAT,
      // u_texelSize 闭包读 drawingBufferWidth/Height 算源 RT 尺寸（spec §5.2）
      drawingBufferWidth: 1920,
      drawingBufferHeight: 1080
    },
    globe: { ellipsoid: { radiiSquared: [1, 1, 1] } },
    camera: { positionWC: [0, 0, 6400000] },
    postProcessStages: { add: () => {} }
  } as any
}
function mockState() {
  return { sunDirection: [0, 0, 1], altitudeCorrection: [0, 0, 0], exposure: 1.2 } as any
}

/** 展平 composite 内 stage 为数组（Cesium API：.length + .get(i)，无 .stages getter）。 */
function stagesOf(composite: PostProcessStageComposite): any[] {
  return Array.from({ length: composite.length }, (_, i) => composite.get(i))
}

describe('createLensFlareStage', () => {
  it('C2: lf_bloom series composite get0=threshold（非 down0）', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const stages = stagesOf(bloomComposite)
    expect(stages[0].name).toBe('lf_threshold') // get0 = threshold
    expect(stages[1].name).toBe('lf_down0') // down0 是 get1，series 前驱=threshold
  })

  it('lf_bloom 含 5 down + 5 up（NUM_BLOOM_LEVELS=6：threshold+down0-4）', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const stages = stagesOf(bloomComposite)
    const downs = stages.filter((s: any) => /^lf_down\d+$/.test(s.name))
    const ups = stages.filter((s: any) => /^lf_up\d+$/.test(s.name))
    expect(downs).toHaveLength(5) // down0-4
    expect(ups).toHaveLength(5) // up0-4
    expect(stages).toHaveLength(11) // 1 threshold + 5 down + 5 up
  })

  it('I9: up[i] u_downLevel = string 字面量（非 function）+ 映射 up0→down3...up4→threshold', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const stages = stagesOf(bloomComposite)
    const up0 = stages.find((s: any) => s.name === 'lf_up0')!
    // string 字面量非 function：避同 scale framebuffer 共享（I9 + I10 一致约束）
    expect(typeof up0.uniforms.u_downLevel).toBe('string')
    expect(up0.uniforms.u_downLevel).toBe('lf_down3') // up0 → down3（同 scale 0.0625）
    const up1 = stages.find((s: any) => s.name === 'lf_up1')!
    expect(up1.uniforms.u_downLevel).toBe('lf_down2')
    const up2 = stages.find((s: any) => s.name === 'lf_up2')!
    expect(up2.uniforms.u_downLevel).toBe('lf_down1')
    const up3 = stages.find((s: any) => s.name === 'lf_up3')!
    expect(up3.uniforms.u_downLevel).toBe('lf_down0')
    const up4 = stages.find((s: any) => s.name === 'lf_up4')!
    expect(up4.uniforms.u_downLevel).toBe('lf_threshold') // up4 → threshold（同 scale 1.0）
  })

  it('I10: features uniform-name texture 引用全 string 字面量', () => {
    const { featuresStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(typeof featuresStage.uniforms.u_preBlurTexture).toBe('string')
    expect(featuresStage.uniforms.u_preBlurTexture).toBe('lf_preBlur')
    expect(typeof featuresStage.uniforms.u_occlusionTexture).toBe('string')
    expect(featuresStage.uniforms.u_occlusionTexture).toBe('lf_occlusion')
  })

  it('I10: composite uniform-name texture 引用全 string 字面量（lf_up4 / lf_features）', () => {
    const { compositeStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(typeof compositeStage.uniforms.u_bloomTexture).toBe('string')
    expect(compositeStage.uniforms.u_bloomTexture).toBe('lf_up4') // lf_bloom 最后一级
    expect(typeof compositeStage.uniforms.u_featuresTexture).toBe('string')
    expect(compositeStage.uniforms.u_featuresTexture).toBe('lf_features')
  })

  it('preBlur u_thresholdTexture = string 字面量（uniform-name 引用 lf_threshold）', () => {
    const { preBlurStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(typeof preBlurStage.uniforms.u_thresholdTexture).toBe('string')
    expect(preBlurStage.uniforms.u_thresholdTexture).toBe('lf_threshold')
  })

  it('occlusion textureScale=0.0625（标量降分，36 点网格成本低）', () => {
    const { occlusionStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(occlusionStage.textureScale).toBe(0.0625)
  })

  it('composite sampleMode=NEAREST（dithering 硬约束：input dithering 经 RT 中转逐像素直通）', () => {
    const { compositeStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(compositeStage.sampleMode).toBe(PostProcessStageSampleMode.NEAREST)
  })

  it('§5.7 sampleMode 分配：threshold NEAREST（读 atmosphere）/ down+up LINEAR（series 链传播）', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const stages = stagesOf(bloomComposite)
    const threshold = stages[0]
    expect(threshold.sampleMode).toBe(PostProcessStageSampleMode.NEAREST)
    const down0 = stages[1]
    expect(down0.sampleMode).toBe(PostProcessStageSampleMode.LINEAR)
    const up0 = stages.find((s: any) => s.name === 'lf_up0')!
    expect(up0.sampleMode).toBe(PostProcessStageSampleMode.LINEAR)
  })

  it('§5.7 sampleMode 分配：preBlur/occlusion/features NEAREST（非 series 兄弟读 non-series input）', () => {
    const { preBlurStage, occlusionStage, featuresStage } = createLensFlareStage(
      mockScene(),
      mockState(),
      {}
    )
    expect(preBlurStage.sampleMode).toBe(PostProcessStageSampleMode.NEAREST)
    expect(occlusionStage.sampleMode).toBe(PostProcessStageSampleMode.NEAREST)
    expect(featuresStage.sampleMode).toBe(PostProcessStageSampleMode.NEAREST)
  })

  it('全 stage pixelDatatype=postHdrDatatype（HalfFloat 线性链）', () => {
    const handle = createLensFlareStage(mockScene(PixelDatatype.HALF_FLOAT), mockState(), {})
    // lf_bloom series 内所有 stage
    for (const s of stagesOf(handle.bloomComposite)) {
      expect(s.pixelDatatype).toBe(PixelDatatype.HALF_FLOAT)
    }
    // non-series 兄弟 stage
    expect(handle.preBlurStage.pixelDatatype).toBe(PixelDatatype.HALF_FLOAT)
    expect(handle.occlusionStage.pixelDatatype).toBe(PixelDatatype.HALF_FLOAT)
    expect(handle.featuresStage.pixelDatatype).toBe(PixelDatatype.HALF_FLOAT)
    expect(handle.compositeStage.pixelDatatype).toBe(PixelDatatype.HALF_FLOAT)
  })

  it('textureScale 分配：threshold 1.0 / down0-4 0.5→0.03125 / up0-4 0.0625→1.0', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const stages = stagesOf(bloomComposite)
    expect(stages[0].textureScale).toBe(1.0) // threshold
    const expectedDown = [0.5, 0.25, 0.125, 0.0625, 0.03125]
    for (let i = 0; i < 5; i++) {
      expect(stages[1 + i].textureScale).toBe(expectedDown[i]) // down0-4
    }
    const expectedUp = [0.0625, 0.125, 0.25, 0.5, 1.0]
    for (let i = 0; i < 5; i++) {
      const up = stages.find((s: any) => s.name === `lf_up${i}`)!
      expect(up.textureScale).toBe(expectedUp[i]) // up0-4
    }
  })

  it('外层 non-series lensflare composite（inputPreviousStageTexture=false）', () => {
    const { lensflareComposite } = createLensFlareStage(mockScene(), mockState(), {})
    expect(lensflareComposite.inputPreviousStageTexture).toBe(false)
    expect(lensflareComposite.name).toBe('lensflare')
    const names = stagesOf(lensflareComposite).map((s: any) => s.name)
    expect(names).toEqual(['lf_bloom', 'lf_preBlur', 'lf_occlusion', 'lf_features', 'lf_composite'])
  })

  it('lf_bloom 内层 series composite（inputPreviousStageTexture=true）', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    expect(bloomComposite.inputPreviousStageTexture).toBe(true)
    expect(bloomComposite.name).toBe('lf_bloom')
  })

  it('options 默认值透传（intensity/thresholdLevel/ghostAmount 等用常量默认）', () => {
    const { compositeStage, featuresStage } = createLensFlareStage(
      mockScene(),
      mockState(),
      { intensity: 0.02, ghostAmount: 0.1, haloAmount: 0.08 }
    )
    expect(compositeStage.uniforms.u_intensity).toBe(0.02)
    expect(featuresStage.uniforms.u_ghostAmount).toBe(0.1)
    expect(featuresStage.uniforms.u_haloAmount).toBe(0.08)
  })

  it('默认值：不传 options 时 threshold/composite/features 落到 DEFAULT 常量', () => {
    // 不传 options（第三个参数缺省）→ 全部走 lensFlareConstants 默认
    const handle = createLensFlareStage(mockScene(), mockState())
    const threshold = stagesOf(handle.bloomComposite)[0]
    expect(threshold.uniforms.u_thresholdLevel).toBe(THRESHOLD_LEVEL_DEFAULT)
    expect(threshold.uniforms.u_thresholdRange).toBe(THRESHOLD_RANGE_DEFAULT)
    expect(handle.compositeStage.uniforms.u_intensity).toBe(INTENSITY_DEFAULT)
    expect(handle.featuresStage.uniforms.u_ghostAmount).toBe(GHOST_AMOUNT_DEFAULT)
    expect(handle.featuresStage.uniforms.u_haloAmount).toBe(HALO_AMOUNT_DEFAULT)
  })

  it('occlusion 动态 uniform 是 function 闭包（每帧读 state/scene）', () => {
    const { occlusionStage } = createLensFlareStage(mockScene(), mockState())
    expect(typeof occlusionStage.uniforms.u_sunDirectionWC).toBe('function')
    expect(typeof occlusionStage.uniforms.u_cameraPositionWC).toBe('function')
    expect(typeof occlusionStage.uniforms.u_ellipsoidRadiiSquared).toBe('function')
  })

  it('常量 uniform 值：chromaticAberration/upsampleRadius/sunAngularRadius 用常量', () => {
    const { bloomComposite, featuresStage, occlusionStage } = createLensFlareStage(
      mockScene(),
      mockState()
    )
    expect(featuresStage.uniforms.u_chromaticAberration).toBe(CHROMATIC_ABERRATION)
    const up0 = stagesOf(bloomComposite).find((s: any) => s.name === 'lf_up0')!
    expect(up0.uniforms.u_upsampleRadius).toBe(UPSAMPLE_RADIUS)
    expect(occlusionStage.uniforms.u_sunAngularRadius).toBe(SUN_ANGULAR_RADIUS)
  })

  it('I-1: u_texelSize 按源 RT textureScale 算（up0 源 = down4@0.03125 → 1/(1920×0.03125)）', () => {
    // spec §5.2：u_texelSize 是源 texture 的 1/w,1/h（源非目标）。
    // up0 的 series 前驱 = down4（textureScale 0.03125），源 RT 尺寸 = 1920×0.03125 = 60。
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState())
    const up0 = stagesOf(bloomComposite).find((s: any) => s.name === 'lf_up0')!
    expect(typeof up0.uniforms.u_texelSize).toBe('function')
    const texelSize = up0.uniforms.u_texelSize()
    // x = 1/(1920×0.03125) = 1/60，y = 1/(1080×0.03125) = 1/33.75
    expect(texelSize.x).toBeCloseTo(1.0 / (1920 * 0.03125), 10)
    expect(texelSize.y).toBeCloseTo(1.0 / (1080 * 0.03125), 10)
  })

  it('I-1: u_texelSize 按 stage 源 scale 分级（threshold 1.0 / down0 源 1.0 / down4 源 0.0625）', () => {
    // 各 stage 的 u_texelSize 反映其源 RT 尺寸，不是全分 1/1920 占位。
    const { bloomComposite, preBlurStage, featuresStage } = createLensFlareStage(
      mockScene(),
      mockState()
    )
    const stages = stagesOf(bloomComposite)
    const threshold = stages[0]
    const down0 = stages[1] // 源 = threshold@1.0
    const down4 = stages.find((s: any) => s.name === 'lf_down4')! // 源 = down3@0.0625

    // threshold 源 = atmosphere@1.0 → 1/1920
    expect(threshold.uniforms.u_texelSize().x).toBeCloseTo(1.0 / 1920, 10)
    // down0 源 = threshold@1.0 → 1/1920
    expect(down0.uniforms.u_texelSize().x).toBeCloseTo(1.0 / 1920, 10)
    // down4 源 = down3@0.0625 → 1/(1920×0.0625) = 1/120（远大于全分 1/1920）
    expect(down4.uniforms.u_texelSize().x).toBeCloseTo(1.0 / (1920 * 0.0625), 10)
    expect(down4.uniforms.u_texelSize().x).toBeGreaterThan(1.0 / 1920) // 防 placeholder 回归

    // non-series 兄弟：preBlur/features 源 = 全分 threshold/up4 → 1/1920
    expect(preBlurStage.uniforms.u_texelSize().x).toBeCloseTo(1.0 / 1920, 10)
    expect(featuresStage.uniforms.u_texelSize().x).toBeCloseTo(1.0 / 1920, 10)
  })
})

// Task 10：occlusion stage depthTexture uniform 指向 depthTemporal（同源 smoothDepth，方案 A uniform-name string）。
// temporalEmaEnabled=true（HDR）：occlusion.depthTexture = 'czm_depth_temporal'（uniform-name string 跨 stage
// 引用，Cesium textureCache 解析为 depthTemporal.outputTexture），shader 读 texture().a（smoothDepth）。
// UNSIGNED_BYTE 兜底（无 depthTemporal）：不传 depthTemporalStageName → 不覆盖 depthTexture（Cesium 内建
// scene globe depth），shader 用 legacy czm_readDepth。
describe('createLensFlareStage Task 10：occlusion 同源 depthTemporal', () => {
  it('传 depthTemporalStageName 时 occlusion.depthTexture = 该 name（uniform-name string 跨 stage 引用）', () => {
    const { occlusionStage } = createLensFlareStage(
      mockScene(),
      mockState(),
      {},
      'czm_depth_temporal' // temporalEmaEnabled=true 路径
    )
    // uniform-name string（非 function）：Cesium textureCache.updateUniformTextures 解析为
    // depthTemporal.outputTexture（getOutputTexture(name)），combine 优先 user uniform 覆盖内建 scene depth。
    expect(typeof occlusionStage.uniforms.depthTexture).toBe('string')
    expect(occlusionStage.uniforms.depthTexture).toBe('czm_depth_temporal')
  })

  it('传 depthTemporalStageName 时 shader 用 smoothDepth（texture().a + 1e-4，禁 czm_readDepth）', () => {
    const { occlusionStage } = createLensFlareStage(
      mockScene(),
      mockState(),
      {},
      'czm_depth_temporal'
    )
    expect(occlusionStage.fragmentShader).toMatch(/texture\(depthTexture,\s*sampleUV\)\.a/)
    expect(occlusionStage.fragmentShader).not.toContain('czm_readDepth')
    expect(occlusionStage.fragmentShader).toMatch(/1\.0\s*-\s*1e-4/)
  })

  it('不传 depthTemporalStageName（UNSIGNED_BYTE）时 occlusion 不覆盖 depthTexture（Cesium 内建 scene depth）', () => {
    const { occlusionStage } = createLensFlareStage(mockScene(), mockState(), {})
    // 无 depthTexture uniform 覆盖 → Cesium 内建 scene globe depth（stage._depthTexture）
    expect(occlusionStage.uniforms.depthTexture).toBeUndefined()
    // shader 用 legacy czm_readDepth（scene globe depth log-depth 解码）
    expect(occlusionStage.fragmentShader).toContain('czm_readDepth')
    expect(occlusionStage.fragmentShader).toContain('1.0 - DEPTH_EPSILON')
  })

  it('occlusion 其余 uniform 不受 depthTemporalStageName 影响（sun/camera/ellipsoid 闭包不变）', () => {
    const { occlusionStage } = createLensFlareStage(
      mockScene(),
      mockState(),
      {},
      'czm_depth_temporal'
    )
    expect(typeof occlusionStage.uniforms.u_sunDirectionWC).toBe('function')
    expect(typeof occlusionStage.uniforms.u_cameraPositionWC).toBe('function')
    expect(typeof occlusionStage.uniforms.u_ellipsoidRadiiSquared).toBe('function')
    expect(occlusionStage.uniforms.u_sunAngularRadius).toBe(SUN_ANGULAR_RADIUS)
  })
})

// lf×云交互（2026-08-30）：#1 occlusion 云感知桥 + #2 threshold 源钉 atmosphere/接 occlusion。
describe('lf×云交互（#1 occlusion 云桥 / #2 threshold 源与调制）', () => {
  it('#2: threshold uniforms 覆盖 colorTexture="atmosphere"（uniform-name string，排云）+ u_occlusionTexture="lf_occlusion"', () => {
    const { bloomComposite } = createLensFlareStage(mockScene(), mockState(), {})
    const threshold = stagesOf(bloomComposite)[0] as unknown as {
      uniforms: Record<string, unknown>
    }
    expect(threshold.uniforms.colorTexture).toBe('atmosphere')
    expect(threshold.uniforms.u_occlusionTexture).toBe('lf_occlusion')
  })

  it('#1: 不传 cloudsOcclusionBridge → occlusion 无 u_cloudsTexture uniform + shader 无云采样（零回归）', () => {
    const { occlusionStage } = createLensFlareStage(mockScene(), mockState(), {})
    expect(occlusionStage.uniforms.u_cloudsTexture).toBeUndefined()
    expect(occlusionStage.fragmentShader).not.toContain('u_cloudsTexture')
  })

  it('#1: 传 cloudsOcclusionBridge → u_cloudsTexture 闭包（就绪返回 bridge 对象）+ shader 编译云采样', () => {
    const fakeBridge = { _texture: { dummy: true }, _target: 1 }
    const { occlusionStage } = createLensFlareStage(mockScene(), mockState(), {
      cloudsOcclusionBridge: () => fakeBridge
    })
    expect(typeof occlusionStage.uniforms.u_cloudsTexture).toBe('function')
    expect((occlusionStage.uniforms.u_cloudsTexture as () => unknown)()).toBe(fakeBridge)
    expect(occlusionStage.fragmentShader).toContain('u_cloudsTexture')
    expect(occlusionStage.fragmentShader).toContain('max(')
  })
})
