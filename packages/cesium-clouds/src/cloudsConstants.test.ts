import { describe, it, expect } from 'vitest'
import {
  CLOUDS_DEFAULT_QUALITY,
  CLOUDS_LAYER_ALTITUDES_M
} from './cloudsConstants'

describe('cloudsConstants', () => {
  it('默认 high 档（lightShafts on，对标 three 版默认）', () => {
    expect(CLOUDS_DEFAULT_QUALITY).toBe('high')
  })

  it('三层云高度搬 three 版 CloudLayers（750/1000/7500m）', () => {
    expect(CLOUDS_LAYER_ALTITUDES_M).toEqual([750, 1000, 7500])
  })
})
