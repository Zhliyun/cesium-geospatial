import { describe, it, expect } from 'vitest'
import {
  CLOUDS_DEFAULT_QUALITY,
  CLOUDS_LAYER_ALTITUDES_M
} from './cloudsConstants'

describe('cloudsConstants', () => {
  it('默认 high 档（lightShafts on，对标 three 版默认）', () => {
    expect(CLOUDS_DEFAULT_QUALITY).toBe('high')
  })

  it('三层云高度（2026-09-04 重定 1500/2000/7500m，温带积云典型云底）', () => {
    expect(CLOUDS_LAYER_ALTITUDES_M).toEqual([1500, 2000, 7500])
  })
})
