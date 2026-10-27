import { describe, it, expect } from 'vitest'
import { DEMO_PROFILE } from './demoProfile'

// demo 验收档单一来源（spec §8.4）：demo 的 URL 参数在 profile 之上覆盖，
// 产品 install 缺省复用同一份值——本用例固化拍板值，防止两处手抄漂移。

describe('DEMO_PROFILE', () => {
  it('固化 demo 拍板值', () => {
    // 2026-09-30 用户拍板：地面云影 strength 0.7 试档后上调 0.8 定稿
    expect(DEMO_PROFILE.atmosphere.groundShadowStrength).toBe(0.8)
    // 月盘基准 1546=774×(0.014/0.0099)²，ω 拍板 0.014 时同式保显示亮度
    expect(DEMO_PROFILE.moonRadianceBase).toBe(1546)
  })

  it('云验收档与 demo 缺省一致（裸 URL 有云）', () => {
    expect(DEMO_PROFILE.clouds.clouds).toBe(true)
  })

  it('不含 undefined 值（展开进 options 时不会把字段覆盖成 undefined）', () => {
    for (const [group, entries] of Object.entries(DEMO_PROFILE)) {
      if (typeof entries !== 'object' || entries == null) continue
      const keys = Object.keys(entries)
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) {
        expect(
          (entries as Record<string, unknown>)[key],
          `${group}.${key} 不应为 undefined`
        ).not.toBeUndefined()
      }
    }
  })
})
