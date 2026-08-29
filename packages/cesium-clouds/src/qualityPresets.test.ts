// qualityPresets.test.ts
// 档位表快照（spec §9①：期望值硬编码 + 注释钉死参考源文件行号——参考库在另一 repo
// 不可 import，「逐字对齐」由 spec §3 表背书，本测试守「实现 = spec 表」）
// 参考源：three-geospatial/packages/clouds/src/qualityPresets.ts:59-121（low/medium/high/ultra）
//        其 defaults（=high）:8-52
import { describe, it, expect, vi } from 'vitest'
import { Cartesian2, Matrix4 } from 'cesium'
import {
  cloudsQualityPresets, applyQualityPreset,
  type CloudsQualityPreset
} from './qualityPresets'
import { defaultCloudsParameters } from './cloudsDefaultParameters'

describe('cloudsQualityPresets 档位表（spec §3 逐字对齐）', () => {
  it('low：编译开关全关 + march/BSM 降档值', () => {
    const p = cloudsQualityPresets.low
    expect(p.main).toEqual({ lightShafts: false, shapeDetail: false, turbulence: false, accurateSunSkyLight: false })
    expect(p.params).toMatchObject({
      maxIterationCount: 200, minStepSize: 100, maxRayDistance: 1e5,
      minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-1,
      maxIterationCountToSun: 1, maxIterationCountToGround: 0, shadowCascadeCount: 2
    })
    expect(p.shadow).toEqual({
      cascadeCount: 2, mapSize: 256,
      march: { maxIterationCount: 25, minStepSize: 100, maxStepSize: 1000,
               minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-2, opticalDepthTailScale: 2 }
    })
  })
  it('medium：shapeDetail 开、lightShafts/turbulence/accurate 关 + 阈值放宽', () => {
    const p = cloudsQualityPresets.medium
    expect(p.main).toEqual({ lightShafts: false, shapeDetail: true, turbulence: false, accurateSunSkyLight: false })
    expect(p.params).toMatchObject({ minDensity: 1e-4, minExtinction: 1e-4, maxIterationCountToGround: 1, shadowCascadeCount: 3 })
    expect(p.shadow).toEqual({
      cascadeCount: 3, mapSize: 256,
      march: { maxIterationCount: 50, minStepSize: 100, maxStepSize: 1000,
               minDensity: 1e-4, minExtinction: 1e-4, minTransmittance: 1e-4, opticalDepthTailScale: 2 }
    })
  })
  it('high：params/shadow.march 与 defaultCloudsParameters 对应字段全等（零回归机器证明，spec §9②）', () => {
    const d = defaultCloudsParameters()
    const p = cloudsQualityPresets.high
    expect(p.main).toEqual({ lightShafts: true, shapeDetail: true, turbulence: true, accurateSunSkyLight: true })
    // 显式键全等（未列键 = 继承 defaults，合并后自然全等——见 applyQualityPreset high 全量对拍用例）
    for (const [k, v] of Object.entries(p.params)) {
      expect(v).toBe((d as unknown as Record<string, number>)[k])
    }
    expect(p.shadow).toEqual({
      cascadeCount: d.shadowCascadeCount, mapSize: 512,
      march: { ...d.shadowMarch }
    })
  })
  it('ultra：仅 minStepSize 50→10 + mapSize 1024（其余 = high）', () => {
    const p = cloudsQualityPresets.ultra
    expect(p.params).toMatchObject({ minStepSize: 10, shadowCascadeCount: 3 })
    expect(p.shadow).toEqual({ ...cloudsQualityPresets.high.shadow, mapSize: 1024 })
    expect(p.main).toEqual(cloudsQualityPresets.high.main)
  })
})

describe('applyQualityPreset 合并语义（spec §5）', () => {
  it('high + 无用户输入：params 与 defaultCloudsParameters() 逐字段全等（含 shadowMarch 深比较）', () => {
    const d = defaultCloudsParameters()
    const r = applyQualityPreset('high', {})
    expect(r.params.shadowMarch).toEqual(d.shadowMarch)
    expect(r.params.maxIterationCount).toBe(d.maxIterationCount)
    expect(r.params.minStepSize).toBe(d.minStepSize)
    expect(r.params.maxRayDistance).toBe(d.maxRayDistance)
    expect(r.params.minTransmittance).toBe(d.minTransmittance)
    expect(r.params.maxIterationCountToSun).toBe(d.maxIterationCountToSun)
    expect(r.params.maxIterationCountToGround).toBe(d.maxIterationCountToGround)
    expect(r.params.shadowCascadeCount).toBe(3)
    expect(r.shadow).toEqual({ cascadeCount: 3, mapSize: 512 })
  })
  it('low：params 生效 + dummy 数组按 cascadeCount 截断（spec §4）', () => {
    const r = applyQualityPreset('low', {})
    expect(r.params.maxIterationCount).toBe(200)
    expect(r.params.shadowCascadeCount).toBe(2)
    expect(r.params.shadowIntervals).toHaveLength(2)
    expect(r.params.shadowMatrices).toHaveLength(2)
    // dummy 元素为可变 identity（勿用冻结 Matrix4.IDENTITY——spec/现状注释同款坑）
    expect(r.params.shadowMatrices[0]).not.toBe(Matrix4.IDENTITY)
  })
  it('用户显式 parameters 字段级覆盖档位；未传字段保持档位值', () => {
    const r = applyQualityPreset('low', { parameters: { maxIterationCount: 150 } })
    expect(r.params.maxIterationCount).toBe(150)   // 用户显式
    expect(r.params.minStepSize).toBe(100)          // 档位值保留
    expect(r.params.shadowCascadeCount).toBe(2)     // 单一来源：用户不可覆盖（下一条）
  })
  it('quality 在场：用户显式 shadowCascadeCount 忽略 + warn（spec §5 v3 裁决）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = applyQualityPreset('low', { parameters: { shadowCascadeCount: 4 } })
    expect(r.params.shadowCascadeCount).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('shadowMarch 仅整对象覆盖（用户须供 7 字段全量）', () => {
    const march = { maxIterationCount: 30, minStepSize: 100, maxStepSize: 1000, minDensity: 1e-5, minExtinction: 1e-5, minTransmittance: 1e-4, opticalDepthTailScale: 2 }
    const r = applyQualityPreset('high', { parameters: { shadowMarch: march } })
    expect(r.params.shadowMarch).toEqual(march)
  })
  it('clone：产物与用户传入的 Cesium 数学对象不共享引用（spec §5）', () => {
    const userJitter = new Cartesian2(0.5, 0.5)
    const r = applyQualityPreset('high', { parameters: { temporalJitter: userJitter } })
    expect(r.params.temporalJitter).not.toBe(userJitter)
    expect(r.params.temporalJitter.x).toBe(0.5)
  })
  it('main 合并：档位值 + 用户显式覆盖（shadowCascadeCount 恒档位源）', () => {
    const r = applyQualityPreset('medium', { turbulence: true, shapeDetail: false })
    expect(r.main).toEqual({ lightShafts: false, shapeDetail: false, turbulence: true, accurateSunSkyLight: false, shadowCascadeCount: 3 })
  })
})
