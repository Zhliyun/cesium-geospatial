import { describe, expect, it } from 'vitest'
import {
  Cartesian3,
  JulianDate,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  Math as CesiumMath
} from 'cesium'

import {
  computeMoonDirectionECEF,
  computeMoonFixedToECEFMatrix,
  computeMoonIlluminatedFraction,
  computeMoonIlluminatedFractionFromDirections
} from './celestialDirections'

describe('celestialDirections 月方向与月相', () => {
  it('朔：dot(sun,moon) 极大（合相）时 f < 0.02；望：极小时 f > 0.98（60 天 6h 粗扫+邻域细化）', () => {
    // 60 天窗口 6h 粗扫找极值索引，±6h 邻域 30min 细化（spec §4.4——粗扫+细化，不搞三分）
    const start = JulianDate.fromIso8601('2026-09-01T00:00:00Z')
    const COARSE_H = 6, DAYS = 60
    const n = (DAYS * 24) / COARSE_H
    let dots: { t: JulianDate; d: number }[] = []
    for (let i = 0; i <= n; i++) {
      const t = JulianDate.addSeconds(start, i * COARSE_H * 3600, new JulianDate())
      const sun = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, new Cartesian3())!
      const moon = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t, new Cartesian3())!
      dots.push({ t, d: Cartesian3.dot(Cartesian3.normalize(sun, sun), Cartesian3.normalize(moon, moon)) })
    }
    let maxIdx = 0, minIdx = 0
    dots.forEach((x, i) => { if (x.d > dots[maxIdx].d) maxIdx = i; if (x.d < dots[minIdx].d) minIdx = i })
    const refine = (center: JulianDate) => {
      let best = { t: center, d: -2 }
      for (let s = -6 * 3600; s <= 6 * 3600; s += 1800) {
        const t = JulianDate.addSeconds(center, s, new JulianDate())
        const sun = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, new Cartesian3())!
        const moon = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t, new Cartesian3())!
        const d = Cartesian3.dot(Cartesian3.normalize(sun, sun), Cartesian3.normalize(moon, moon))
        if (d > best.d) best = { t, d }
      }
      return best
    }
    // 朔 = dot 极大（ε→0）；在极大邻域细化后取 ε 最小点断言 f
    const newMoon = refine(dots[maxIdx].t)
    expect(computeMoonIlluminatedFraction(newMoon.t)).toBeLessThan(0.02)
    const fullMoon = refine(dots[minIdx].t) // 望 = dot 极小（ε→180°）——细化取 dot 最小
    expect(computeMoonIlluminatedFraction(fullMoon.t)).toBeGreaterThan(0.98)
  })

  it('中秋锚（独立于扫描）：2026-09-25 当天 24h 内 max f > 0.95', () => {
    const day = JulianDate.fromIso8601('2026-09-25T00:00:00Z')
    let maxF = -1
    for (let s = 0; s < 86400; s += 3600) {
      maxF = Math.max(maxF, computeMoonIlluminatedFraction(JulianDate.addSeconds(day, s, new JulianDate())))
    }
    expect(maxF).toBeGreaterThan(0.95)
  })

  it('视差修正：地面观察者 vs 地心月方向角差 24h 扫描最大值 ∈ (10′, 65′]', () => {
    const icrf = new Matrix3()
    const ground = new Cartesian3(6371000, 0, 0) // 赤道点，米
    const start = JulianDate.fromIso8601('2026-09-15T00:00:00Z')
    let maxAngle = 0
    const geocentric = new Cartesian3(), topocentric = new Cartesian3()
    for (let s = 0; s < 86400; s += 3600) {
      const t = JulianDate.addSeconds(start, s, new JulianDate())
      const fixed = Transforms.computeIcrfToCentralBodyFixedMatrix(t, icrf)
      expect(fixed).toBeDefined() // GMST fallback 恒有值（ICRF 竞态修复版）
      computeMoonDirectionECEF(t, fixed!, new Cartesian3(0, 0, 0), geocentric)
      computeMoonDirectionECEF(t, fixed!, ground, topocentric)
      const angle = Math.acos(CesiumMath.clamp(Cartesian3.dot(geocentric, topocentric), -1, 1))
      maxAngle = Math.max(maxAngle, angle)
    }
    // 上界 65′（近地点水平视差 61.5′ 余量）；下界 10′（origin 单位错 1000 倍时视差≈0 静默失效——必须双向）
    expect(maxAngle).toBeGreaterThan(CesiumMath.toRadians(10 / 60))
    expect(maxAngle).toBeLessThanOrEqual(CesiumMath.toRadians(65 / 60))
  })

  it('连续性：+1s 方向与 f 均无跳变', () => {
    const t0 = JulianDate.fromIso8601('2026-09-20T12:00:00Z')
    const t1 = JulianDate.addSeconds(t0, 1, new JulianDate())
    const fixed0 = Transforms.computeIcrfToCentralBodyFixedMatrix(t0, new Matrix3())!
    const fixed1 = Transforms.computeIcrfToCentralBodyFixedMatrix(t1, new Matrix3())!
    const d0 = computeMoonDirectionECEF(t0, fixed0, new Cartesian3(0, 0, 0), new Cartesian3())
    const d1 = computeMoonDirectionECEF(t1, fixed1, new Cartesian3(0, 0, 0), new Cartesian3())
    // 1s ECEF 月方向变化实测 6.3e-5 rad = 地球自转 6.5e-5（主导）+ 月球惯性运动 2.4e-6；
    // brief 原阈值 cos(1e-6) 连月球真实运动都容不下（断言量级错误），1e-3 rad 上界防跳变
    // （竞态/矩阵错为 O(0.01)+ rad，判别力充足）——探针分解见 task-1-report.md
    expect(Cartesian3.dot(d0, d1)).toBeGreaterThan(Math.cos(1e-3))
    // f 1s 变化物理上限：df/dε 在 ε=90°（弦月）处最大 0.5 × Δε≈2.47e-6 rad/s ≈ 1.24e-6，
    // 该日期近弦月实测 1.26e-6——brief 原 1e-6 阈值低于物理上限必然失败，放宽至 2e-6（真跳变 0.1+）
    expect(Math.abs(computeMoonIlluminatedFraction(t1) - computeMoonIlluminatedFraction(t0))).toBeLessThan(2e-6)
  })

  it('FromDirections 版与独立版同刻一致（弦月参考：ε=90° → f=(1−0)/π… 验证曲线锚点）', () => {
    // 构造已知 ε：sunDirection=(0,0,1)、moonDirection=(1,0,0) → ε=90° → f=(sin90−90°·cos90)/π=(1−0)/π≈0.318
    const f = computeMoonIlluminatedFractionFromDirections(new Cartesian3(0, 0, 1), new Cartesian3(1, 0, 0))
    expect(f).toBeCloseTo(1 / Math.PI, 3)
  })
})

describe('computeMoonFixedToECEFMatrix 月固系（月面纹理用）', () => {
  const T0 = JulianDate.fromIso8601('2026-09-25T16:00:00Z')

  function build(t: JulianDate): Matrix3 {
    const icrfToFixed = Transforms.computeIcrfToCentralBodyFixedMatrix(t, new Matrix3())!
    return computeMoonFixedToECEFMatrix(t, icrfToFixed, new Matrix3())
  }

  it('正交性：M 的三列单位正交（M×Mᵀ=I）', () => {
    const m = build(T0)
    // Cesium Matrix3 列主序：列 k = (m[k], m[k+3], m[k+6])
    const c1 = new Cartesian3(m[0], m[1], m[2])
    const c2 = new Cartesian3(m[3], m[4], m[5])
    const c3 = new Cartesian3(m[6], m[7], m[8])
    expect(Math.abs(Cartesian3.magnitude(c1) - 1)).toBeLessThan(1e-9)
    expect(Math.abs(Cartesian3.magnitude(c2) - 1)).toBeLessThan(1e-9)
    expect(Math.abs(Cartesian3.magnitude(c3) - 1)).toBeLessThan(1e-9)
    expect(Math.abs(Cartesian3.dot(c1, c2))).toBeLessThan(1e-9)
    expect(Math.abs(Cartesian3.dot(c1, c3))).toBeLessThan(1e-9)
    expect(Math.abs(Cartesian3.dot(c2, c3))).toBeLessThan(1e-9)
  })

  it('第三列 = IAU 月球北极（α0=266.857°, δ0=66.991°，ICRF 域经 ICRF→ECEF）', () => {
    const t = T0
    const icrfToFixed = Transforms.computeIcrfToCentralBodyFixedMatrix(t, new Matrix3())!
    // IAU 2009：N_ICRF = dir(α0, δ0)
    const a0 = CesiumMath.toRadians(266.857), d0 = CesiumMath.toRadians(66.991)
    const nIcrf = new Cartesian3(Math.cos(d0) * Math.cos(a0), Math.cos(d0) * Math.sin(a0), Math.sin(d0))
    const nEcef = Cartesian3.normalize(Matrix3.multiplyByVector(icrfToFixed, nIcrf, new Cartesian3()), new Cartesian3())
    const mm = m2(build(t))
    const c3 = Cartesian3.normalize(new Cartesian3(mm[6], mm[7], mm[8]), new Cartesian3())
    expect(Cartesian3.dot(c3, nEcef)).toBeGreaterThan(1 - 1e-9)
  })

  it('潮汐锁定（金标准）：月固 x 轴（正面中心）指向地球——dot(x̂_MF, -moonDir) > cos(10°)（容天平动±7°+视差）', () => {
    // 多时刻采样（一个朔望月跨度）验证潮汐锁定持续成立
    for (const day of [0, 5, 10, 15, 20, 25]) {
      const t = JulianDate.addDays(T0, day, new JulianDate())
      const m = build(t)
      const xMf = Cartesian3.normalize(new Cartesian3(m[0], m[1], m[2]), new Cartesian3())
      const icrfToFixed = Transforms.computeIcrfToCentralBodyFixedMatrix(t, new Matrix3())!
      const moonDir = computeMoonDirectionECEF(t, icrfToFixed, new Cartesian3(0, 0, 0), new Cartesian3())
      const toEarth = Cartesian3.negate(moonDir, new Cartesian3())
      const d = Cartesian3.dot(xMf, toEarth)
      expect(d).toBeGreaterThan(Math.cos(CesiumMath.toRadians(10)))
    }
  })

  it('连续性：+1s 矩阵三列各自 dot > cos(1e-3)（物理变化 ~7.5e-5 rad/s=地球自转 7.3e-5+W 2.7e-6；1e-3 阈值容其 13 倍，真 bug 转置/漏旋转为 O(0.01)+）', () => {
    const m0 = build(T0)
    const m1 = build(JulianDate.addSeconds(T0, 1, new JulianDate()))
    for (const col of [0, 1, 2]) {
      const v0 = new Cartesian3(m0[col], m0[col + 3], m0[col + 6])
      const v1 = new Cartesian3(m1[col], m1[col + 3], m1[col + 6])
      expect(Cartesian3.dot(v0, v1)).toBeGreaterThan(Math.cos(1e-3))
    }
  })
})

// 取 Matrix3 分量的 helper（测试内直取行主序下标）
function m2(m: Matrix3): number[] {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]]
}
