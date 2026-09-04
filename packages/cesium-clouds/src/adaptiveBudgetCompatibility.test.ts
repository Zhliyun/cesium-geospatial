// adaptiveBudgetCompatibility.test.ts —— spec docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md §6.5
// 消费域枚举守卫（r2 改——原 CI 枚举是空保护：CI 门禁 clouds=0 不渲染云）。
// 场景集=真机验收场景+云专项工具场景；太阳仰角 hardcode 自 createCloudsStage 同源
// 实算（Simon1994 + ICRF→CentralBodyFixed，2026-09-05 校准），单测断言 hardcode 与
// localSunElevationDeg 实算一致防漂移。
import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import { ADAPTIVE_BUDGET_CONSTANTS, localSunElevationDeg, shadowBudgetMultiplier } from './shadowBudgetAdaptation'

const C = ADAPTIVE_BUDGET_CONSTANTS

/**
 * ECEF 太阳方向构造器：站心 ENU 完整三轴换算，正南方位（北半球日间最常见形态；
 * 方位与真值的差对实读影响 <0.2°，远小于 1.5° 容差）。
 * Task 6 几何修正：brief 原稿 up 用球面经度近似且缺 north 轴，纬度 30°+ 下实读偏差
 * 达数十度（断言失真）；本构造 north=−sinφcosλ,−sinφsinλ,cosφ 与 up 正交，仰角语义精确。
 */
function sunDirAt(lonDeg: number, latDeg: number, elevDeg: number): Cartesian3 {
  const lon = (lonDeg * Math.PI) / 180
  const lat = (latDeg * Math.PI) / 180
  const e = (elevDeg * Math.PI) / 180
  const north = new Cartesian3(
    -Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)
  )
  const up = new Cartesian3(
    Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)
  )
  const se = Math.sin(e)
  const ce = Math.cos(e) // 正南 = −north 方向水平分量
  return Cartesian3.normalize(
    new Cartesian3(
      up.x * se - north.x * ce,
      up.y * se - north.y * ce,
      up.z * se - north.z * ce
    ),
    new Cartesian3()
  )
}

// 相机位置：WGS84 椭球（Cartesian3.fromDegrees）——与真机 positionWC 同源。
// 椭球径向 ≠ 法线（垂线偏差 ~0.2°@34°N），实算与构造仰角的差落在该量级=非恒真断言。
function camAt(lonDeg: number, latDeg: number, heightM: number): Cartesian3 {
  return Cartesian3.fromDegrees(lonDeg, latDeg, heightM)
}

// 场景表（elevDeg=真实天文实算 hardcode，见文件头；漏填新场景时此表是唯一需要同步的点）
const SCENES = [
  {
    name: '目标机位 108（钉 2026-09-04T10:00:00Z）',
    lon: 108.2465, lat: 34.3312, heightM: 490,
    elevDeg: 13.288, // 实算 13.288°（brief 草稿 11.3 为手算粗记，超 ±1.5° 容差已按实算修正）
    inTargetDomain: true
  },
  {
    name: '日本 500m 云海（钉 2026-09-04T03:00:00Z≈当地正午）',
    lon: 139.2399, lat: 34.8752, heightM: 500,
    elevDeg: 62.298, // 实算（brief 草稿 68 为粗记；当地正午上限 90−|φ−δ|≈61.7°，68° 不可达）
    inTargetDomain: false
  }
]

describe('自适应预算消费域守卫（spec §6.5）', () => {
  it('hardcode 仰角与 localSunElevationDeg 实算一致（±1.5°——红队手算精度口径）', () => {
    // 本断言守卫「几何链路不漂移」（localSunElevationDeg 实现+构造器数学），不验证
    // hardcode 值的天文正确性（后者 NOAA 独立公式+同源实算交叉验证）
    for (const s of SCENES) {
      const elev = localSunElevationDeg(sunDirAt(s.lon, s.lat, s.elevDeg), camAt(s.lon, s.lat, s.heightM))
      expect(Math.abs(elev - s.elevDeg)).toBeLessThan(1.5)
    }
  })
  it('目标域场景乘数 <1 且 ≥FLOOR（A 生效）；非目标场景乘数 =1（零回归域）', () => {
    for (const s of SCENES) {
      const m = shadowBudgetMultiplier(s.elevDeg, C.SUN_ELEV_FULL_DEG, C.SUN_ELEV_FLOOR_DEG, C.BUDGET_FLOOR)
      if (s.inTargetDomain) {
        expect(m).toBeLessThan(1)
        expect(m).toBeGreaterThanOrEqual(C.BUDGET_FLOOR)
      } else {
        expect(m).toBe(1)
      }
    }
  })
})
