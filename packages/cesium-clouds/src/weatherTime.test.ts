// packages/cesium-clouds/src/weatherTime.test.ts
import { describe, expect, it } from 'vitest'
import { Cartesian2 } from 'cesium'
import {
  WEATHER_BAKE_SEED,
  WEATHER_EVOLUTION_PERIOD_S,
  WEATHER_WIND_SPEED_MPS,
  computeDayOfYear,
  computeEvolutionTNorm,
  computeItczCenterLatDeg,
  computeWindOffsetTiles
} from './weatherTime'

describe('weatherTime 时间轴纯函数（spec §4.1/§5.4）', () => {
  it('种子/周期/风速常量符合 spec 定值', () => {
    expect(WEATHER_BAKE_SEED).toBe(1337)
    expect(WEATHER_EVOLUTION_PERIOD_S).toBeCloseTo(5.3 * 3600, 0)
    expect(WEATHER_WIND_SPEED_MPS).toBe(8)
  })

  it('tNorm：tSec=0 → 0；tSec=period/2 → 0.5；环回绕', () => {
    expect(computeEvolutionTNorm(0, 100)).toBe(0)
    expect(computeEvolutionTNorm(50, 100)).toBe(0.5)
    expect(computeEvolutionTNorm(100, 100)).toBe(0)
    expect(computeEvolutionTNorm(137.5, 100)).toBeCloseTo(0.375, 12)
  })

  it('tNorm：负时间安全（时间回退云图回退，spec §4.1）', () => {
    expect(computeEvolutionTNorm(-50, 100)).toBe(0.5)
    expect(computeEvolutionTNorm(-1e9, 19080)).toBeGreaterThanOrEqual(0)
    expect(computeEvolutionTNorm(-1e9, 19080)).toBeLessThan(1)
  })

  it('tNorm：大数精度——1e9 秒量级 mod 后无 float32 损耗（CPU float64 铁律）', () => {
    // JulianDate 2026 年 ~8.4e8 s；float32 ULP=64s，若在 float32 域 mod 会丢分钟级精度。
    // float64 下两次相邻秒采样结果差恒为 1/period。
    const t0 = computeEvolutionTNorm(8.4e8, 19080)
    const t1 = computeEvolutionTNorm(8.4e8 + 1, 19080)
    expect(Math.abs(t1 - t0)).toBeCloseTo(1 / 19080, 9)
  })

  it('windOffset：tile 单位、mod 1、方向对角', () => {
    // tileKm=100.075（repeat=100），speed=8 → 1s 位移 = 8/100075 tile
    const o = computeWindOffsetTiles(100075, 8, 100.075)
    expect(o.x).toBeCloseTo(0, 12) // 恰好 1 tile，mod 1 → 0
    // 负时间 mod 1 后仍在 [0,1)
    const o2 = computeWindOffsetTiles(-1000, 8, 100.075)
    expect(o2.x).toBeGreaterThanOrEqual(0)
    expect(o2.x).toBeLessThan(1)
    expect(o2.y).toBeGreaterThanOrEqual(0)
  })

  it('windOffset 返回 Cartesian2 且 x/y 分量相等（对角风向）', () => {
    const o = computeWindOffsetTiles(12345, 8, 100.075)
    expect(o).toBeInstanceOf(Cartesian2)
    expect(o.x).toBe(o.y)
  })

  it('computeDayOfYear：月日累加表（平年）', () => {
    expect(computeDayOfYear(1, 1)).toBe(1)
    expect(computeDayOfYear(2, 1)).toBe(32)
    expect(computeDayOfYear(8, 15)).toBe(227) // ITCZ 最北锚点
    expect(computeDayOfYear(2, 16)).toBe(47) // ITCZ 最南锚点
    expect(computeDayOfYear(12, 31)).toBe(365)
  })

  it('ITCZ 中心：doy=215 峰点 ≈12.5°N、doy=33 谷点邻域 ≈−2.5°（spec §5.4 公式）', () => {
    expect(computeItczCenterLatDeg(215)).toBeCloseTo(12.5, 3) // cos(0)=1 峰点
    expect(computeItczCenterLatDeg(33)).toBeCloseTo(-2.5, 2) // 谷点邻域
    // 年均 ~5°N（峰谷对称中点，中心偏北，非 0）
    expect((computeItczCenterLatDeg(215) + computeItczCenterLatDeg(215 + 182)) / 2).toBeCloseTo(5, 2)
  })
})
