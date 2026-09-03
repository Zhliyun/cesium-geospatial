// WeatherAtlas 单测（T5）——纯逻辑部分。
// GL 路径（无 source Texture3D 构造/裸 FBO 逐层烘焙/mip 链）不可 node 单测，
// 留 T8 playwright 冒烟覆盖（不写假 GL mock）。
import { describe, expect, it } from 'vitest'
import {
  ATLAS_SIZE,
  ATLAS_SLICES,
  bakeSeedToOffset,
  resolveWeatherAtlasPlan,
  tilePngLayers
} from './WeatherAtlas'

describe('WeatherAtlas 计划解析（spec §4/§6.2）', () => {
  it('尺寸常量：256²×64', () => {
    expect(ATLAS_SIZE).toBe(256)
    expect(ATLAS_SLICES).toBe(64)
  })

  it('默认计划：5.3h/8mps/seed1337/repeat100/非 fallback', () => {
    const plan = resolveWeatherAtlasPlan({})
    expect(plan.evolutionPeriodS).toBeCloseTo(5.3 * 3600, 0)
    expect(plan.windMps).toBe(8)
    expect(plan.seed).toBe(1337)
    expect(plan.weatherRepeat).toBe(100)
    expect(plan.usePngFallback).toBe(false)
  })

  it('pngFallback 提供时 usePngFallback=true', () => {
    const plan = resolveWeatherAtlasPlan({
      pngFallback: { width: 1, height: 1, data: new Uint8Array(4) }
    })
    expect(plan.usePngFallback).toBe(true)
  })

  it('tileKm = CUBE_FACE_WIDTH_KM / repeat', () => {
    expect(resolveWeatherAtlasPlan({ weatherRepeat: 100 }).tileKm).toBeCloseTo(
      40075.017 / 4 / 100,
      3
    )
  })

  it('显式覆盖：evolutionHours/windMps/seed/weatherRepeat 透传', () => {
    const plan = resolveWeatherAtlasPlan({
      evolutionHours: 2,
      windMps: 3,
      seed: 42,
      weatherRepeat: 50
    })
    expect(plan.evolutionPeriodS).toBe(2 * 3600)
    expect(plan.windMps).toBe(3)
    expect(plan.seed).toBe(42)
    expect(plan.weatherRepeat).toBe(50)
    expect(plan.tileKm).toBeCloseTo(40075.017 / 4 / 50, 3)
  })
})

describe('bakeSeedToOffset（u_seedOffset 确定性，spec §4.5）', () => {
  it('确定性：同 seed 同偏移、[0,1) 域', () => {
    const a = bakeSeedToOffset(1337)
    const b = bakeSeedToOffset(1337)
    expect(a.x).toBe(b.x)
    expect(a.y).toBe(b.y)
    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.x).toBeLessThan(1)
    expect(a.y).toBeGreaterThanOrEqual(0)
    expect(a.y).toBeLessThan(1)
    expect(bakeSeedToOffset(1338).x).not.toBe(a.x) // 不同 seed 不同图
  })

  it('默认 seed 1337 避开频率网格点与整数平移（评审交接注记）', () => {
    const o = bakeSeedToOffset(1337)
    // 烘焙域 Worley 整频 freq∈{8,16,32,64,128}：x*freq∈ℤ ⇒ x*16∈ℤ（高频网格点
    // 是 1/16 的倍数）——断言 x*16∉ℤ 即覆盖全部整频网格点。偏移落在网格点上会使
    // p+seedOffset 与未偏移域逐位对齐（偏移失效、种子不可分辨）。
    expect((o.x * 16) % 1).not.toBe(0)
    expect((o.y * 16) % 1).not.toBe(0)
    // 非整数：排除 bakePoint.z 的整数平移（z 向整数平移对整频域不可见）
    expect(o.x % 1).not.toBe(0)
    expect(o.y % 1).not.toBe(0)
  })

  it('多 seed 抽查均避开网格点（覆盖用户可传任意 seed 的鲁棒性）', () => {
    for (const seed of [1338, 1, 42, 99991]) {
      const o = bakeSeedToOffset(seed)
      expect((o.x * 16) % 1).not.toBe(0)
      expect((o.y * 16) % 1).not.toBe(0)
    }
  })
})

describe('tilePngLayers（PNG fallback 平铺纯逻辑）', () => {
  it('slices 层 z-major 连续，每层逐字节等于源图', () => {
    const data = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
    ]) // 2×2 RGBA
    const out = tilePngLayers({ width: 2, height: 2, data }, 3)
    expect(out).toHaveLength(2 * 2 * 3 * 4)
    const layerBytes = 2 * 2 * 4
    for (let i = 0; i < 3; i++) {
      expect(Array.from(out.slice(i * layerBytes, (i + 1) * layerBytes))).toEqual(
        Array.from(data)
      )
    }
  })

  it('64 层产出独立缓冲，不改源 data（texImage3D 源安全）', () => {
    const data = new Uint8Array([7, 7, 7, 255])
    const out = tilePngLayers({ width: 1, height: 1, data }, 64)
    expect(out).toHaveLength(64 * 4)
    expect(out[63 * 4]).toBe(7)
    expect(Array.from(data)).toEqual([7, 7, 7, 255])
  })

  it('data 长度与 width×height×4 不符时抛错（防御坏 PNG）', () => {
    expect(() =>
      tilePngLayers({ width: 2, height: 2, data: new Uint8Array(3) }, 64)
    ).toThrow()
  })
})
