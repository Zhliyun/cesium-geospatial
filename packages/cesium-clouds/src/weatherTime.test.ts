// packages/cesium-clouds/src/weatherTime.test.ts
import { describe, expect, it } from 'vitest'
import { Cartesian2, Cartesian3 } from 'cesium'
import {
  WEATHER_BAKE_SEED,
  WEATHER_EVOLUTION_PERIOD_S,
  WEATHER_WIND_SPEED_MPS,
  computeDayOfYear,
  computeEvolutionTNorm,
  computeItczCenterLatDeg,
  computeShapeWindOffsets,
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
    expect(o.x).toBeCloseTo(0, 12) // 恰好 8 tiles，mod 1 → 0
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
    expect(computeDayOfYear(8, 15)).toBe(227) // 累加表用例（锚点语义见 doy=215/33 用例）
    expect(computeDayOfYear(2, 16)).toBe(47) // 累加表用例（锚点语义见 doy=215/33 用例）
    expect(computeDayOfYear(12, 31)).toBe(365)
  })

  it('ITCZ 中心：doy=215 峰点 ≈12.5°N、doy=33 谷点邻域 ≈−2.5°（spec §5.4 公式）', () => {
    expect(computeItczCenterLatDeg(215)).toBeCloseTo(12.5, 3) // cos(0)=1 峰点
    expect(computeItczCenterLatDeg(33)).toBeCloseTo(-2.5, 2) // 谷点邻域
    // 年均 ~5°N（峰谷对称中点，中心偏北，非 0）
    expect((computeItczCenterLatDeg(215) + computeItczCenterLatDeg(215 + 182)) / 2).toBeCloseTo(5, 2)
  })
})

describe('computeShapeWindOffsets（P1：shape/detail 云内纹理风平流，纹理域 mod 1）', () => {
  const SHAPE_REPEAT = new Cartesian3(0.0003, 0.0003, 0.0003)
  const DETAIL_REPEAT = new Cartesian3(0.006, 0.006, 0.006)

  it('纹理域位移 = 米距 × repeat（mod 1）——与 coverage 平流同速（speedMps 同源）', () => {
    // 小 tSec 使 x 分量（方向系数最大）不跨 mod 1 跳点：800m × 3e-4 = 0.24 < 1
    const o = computeShapeWindOffsets(100, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    // x 分量方向系数最大 → 位移 ≤ 0.24 且非零；具体系数不锁死（未来参数化方向不破测试）
    expect(o.shape.x).toBeGreaterThan(0)
    expect(o.shape.x).toBeLessThanOrEqual(0.24 + 1e-12)
  })

  it('同物理速度下 detail 纹理域速度 = shape 的 repeat 比值倍（0.006/3e-4 = 20×）', () => {
    // 取相邻 t（差 1s）的 wrap 安全段：x 分量 t=100 处位移 <1，Δ=8×3e-4=0.0024 无跳点
    const o0 = computeShapeWindOffsets(100, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    const o1 = computeShapeWindOffsets(101, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    const dShape = o1.shape.x - o0.shape.x
    const dDetail = o1.detail.x - o0.detail.x
    expect(dDetail).toBeCloseTo(dShape * 20, 9)
  })

  it('三分量方向系数 x 最大（对角风向，非轴向退化）', () => {
    // 方向序须在「1 秒增量」上断言：detail 频率高（t=100s 已跨 3+ 周期），mod 1
    // 余数被 wrap 跳点破坏单调性，绝对值不可比；增量 ~0.02-0.04 不跨跳点（可验算）
    const o0 = computeShapeWindOffsets(100, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    const o1 = computeShapeWindOffsets(101, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    const dShape = {
      x: o1.shape.x - o0.shape.x,
      y: o1.shape.y - o0.shape.y,
      z: o1.shape.z - o0.shape.z
    }
    expect(dShape.x).toBeGreaterThan(dShape.y)
    expect(dShape.y).toBeGreaterThan(dShape.z)
    const dDetail = {
      x: o1.detail.x - o0.detail.x,
      y: o1.detail.y - o0.detail.y,
      z: o1.detail.z - o0.detail.z
    }
    expect(dDetail.x).toBeGreaterThan(dDetail.y)
    expect(dDetail.y).toBeGreaterThan(dDetail.z)
  })

  it('域约束 [0,1)：大 tSec（JulianDate 量级）与负 tSec（时间回退）均安全', () => {
    const big = computeShapeWindOffsets(8.4e8, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    const neg = computeShapeWindOffsets(-1e9, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    for (const o of [big, neg]) {
      for (const v of [o.shape.x, o.shape.y, o.shape.z, o.detail.x, o.detail.y, o.detail.z]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(1)
      }
    }
  })

  it('确定性：同输入两次调用逐分量相等（同机多 Viewer 铁律延伸）且返回独立实例', () => {
    const a = computeShapeWindOffsets(12345, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    const b = computeShapeWindOffsets(12345, 8, SHAPE_REPEAT, DETAIL_REPEAT)
    expect(a.shape).not.toBe(b.shape)
    expect(a.detail).not.toBe(b.detail)
    expect(a.shape.x).toBe(b.shape.x)
    expect(a.shape.y).toBe(b.shape.y)
    expect(a.shape.z).toBe(b.shape.z)
    expect(a.detail.x).toBe(b.detail.x)
    expect(a.detail.y).toBe(b.detail.y)
    expect(a.detail.z).toBe(b.detail.z)
  })

  it('speedMps=0（?cloudsWind=0）→ 恒零偏移（关平流不炸）', () => {
    const o = computeShapeWindOffsets(8.4e8, 0, SHAPE_REPEAT, DETAIL_REPEAT)
    expect(o.shape.x + o.shape.y + o.shape.z).toBe(0)
    expect(o.detail.x + o.detail.y + o.detail.z).toBe(0)
  })
})
