// packages/cesium-clouds/src/cloudLayersPacking.test.ts
import { describe, expect, it } from 'vitest'
import { Cartesian3, Cartesian4 } from 'cesium'
import { applyAltitudeOffset, DEFAULT_CLOUD_LAYERS, packLayerUniforms } from './cloudLayersPacking'
import { defaultCloudsParameters } from './cloudsDefaultParameters'

describe('cloudLayersPacking（spec §6.3——three pack 派生移植）', () => {
  it('默认层输入 → packed 输出逐项等于写死默认值表（最强回归锚）', () => {
    const p = packLayerUniforms(DEFAULT_CLOUD_LAYERS)
    const d = defaultCloudsParameters()
    // 双源守卫：defaultCloudsParameters 必须与 packing 派生逐项一致（2026-09-04 起前者
    // 由后者派生；此断言防止未来有人把手抄值加回来静默脱钩）
    expect(p.minLayerHeights).toEqual(d.minLayerHeights)
    expect(p.maxLayerHeights).toEqual(d.maxLayerHeights)
    expect(p.minIntervalHeights).toEqual(d.minIntervalHeights)
    expect(p.maxIntervalHeights).toEqual(d.maxIntervalHeights)
    expect(p.minHeight).toBe(d.minHeight)
    expect(p.maxHeight).toBe(d.maxHeight)
    expect(p.shadowTopHeight).toBe(d.shadowTopHeight)
    expect(p.shadowBottomHeight).toBe(d.shadowBottomHeight)
    // 独立写死值锚（2026-09-04 高度重定：L0 1500+650 / L1 2000+1200）
    expect(p.minLayerHeights).toEqual(new Cartesian4(1500, 2000, 7500, 0))
    expect(p.maxLayerHeights).toEqual(new Cartesian4(2150, 3200, 8000, 0))
    expect(p.minIntervalHeights).toEqual(new Cartesian3(0, 3200, 0))
    expect(p.maxIntervalHeights).toEqual(new Cartesian3(1500, 7500, 0))
    expect(p.densityScales).toEqual(new Cartesian4(0.2, 0.2, 0.003, 0.2))
    expect(p.shapeAmounts).toEqual(new Cartesian4(1, 1, 0.4, 1))
    expect(p.shapeDetailAmounts).toEqual(new Cartesian4(1, 1, 0, 1))
    expect(p.weatherExponents).toEqual(new Cartesian4(1, 1, 1, 1))
    expect(p.shapeAlteringBiases).toEqual(new Cartesian4(0.35, 0.35, 0.35, 0.35))
    expect(p.coverageFilterWidths).toEqual(new Cartesian4(0.6, 0.6, 0.5, 0.6))
    expect(p.minHeight).toBe(1500)
    expect(p.maxHeight).toBe(8000)
    expect(p.shadowTopHeight).toBe(3200)
    expect(p.shadowBottomHeight).toBe(1500)
    expect(p.shadowLayerMask).toEqual(new Cartesian4(1, 1, 0, 0))
  })

  it('applyAltitudeOffset(+500)：仅 L0/L1 抬升，packed 全项联动（spec §6.3 清单）', () => {
    const p = packLayerUniforms(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, 500))
    expect(p.minLayerHeights).toEqual(new Cartesian4(2000, 2500, 7500, 0))
    expect(p.maxLayerHeights).toEqual(new Cartesian4(2650, 3700, 8000, 0))
    expect(p.minHeight).toBe(2000) // march 入射壳消费（clouds.frag:835）
    expect(p.maxHeight).toBe(8000)
    expect(p.shadowBottomHeight).toBe(2000)
    expect(p.shadowTopHeight).toBe(3700)
  })

  it('applyAltitudeOffset 负偏移：minHeight 同步下移（红队 BLOCKER-4 回归项）', () => {
    const p = packLayerUniforms(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, -500))
    expect(p.minHeight).toBe(1000)
    expect(p.shadowBottomHeight).toBe(1000)
  })

  it('applyAltitudeOffset clamp [-500,+3000]（spec §6.1）', () => {
    expect(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, 9999)[0].altitude).toBe(1500 + 3000)
    expect(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, -9999)[0].altitude).toBe(1500 - 500)
  })

  it('applyAltitudeOffset 不改 L2/L3（高卷云不动，spec §6.1 低云带语义）', () => {
    const layers = applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, 3000)
    expect(layers[2].altitude).toBe(7500)
  })
})
