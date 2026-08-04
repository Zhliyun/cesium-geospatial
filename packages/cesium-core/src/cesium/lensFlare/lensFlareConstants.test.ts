import { describe, expect, it } from 'vitest'
import {
  NUM_BLOOM_LEVELS, GHOST_OFFSETS, GHOST_TINTS, HALO_RADIUS, HALO_THICKNESS,
  CHROMATIC_ABERRATION, UPSAMPLE_RADIUS, DEPTH_EPSILON,
  LEARNOGLY_DOWNSAMPLE_WEIGHTS, CODAW_DOWNSAMPLE_WEIGHTS, UPSAMPLE_WEIGHTS,
  THRESHOLD_LEVEL_DEFAULT, THRESHOLD_RANGE_DEFAULT,
  INTENSITY_DEFAULT, GHOST_AMOUNT_DEFAULT, HALO_AMOUNT_DEFAULT
} from './lensFlareConstants'

describe('lensFlareConstants', () => {
  it('NUM_BLOOM_LEVELS=6（threshold + down0-4 到 1/32，spec §3/§5.2）', () => {
    expect(NUM_BLOOM_LEVELS).toBe(6)
  })
  it('9 ghost offsets + tints（逐字 three-geospatial，spec §1.4 表）', () => {
    expect(GHOST_OFFSETS).toHaveLength(9)
    expect(GHOST_TINTS).toHaveLength(9)
    expect(GHOST_OFFSETS[0]).toBe(-5.0); expect(GHOST_TINTS[0]).toEqual([0.8, 0.8, 1.0])
    expect(GHOST_OFFSETS[8]).toBe(10.0); expect(GHOST_TINTS[8]).toEqual([0.5, 0.8, 1.0])
  })
  it('halo radius=0.45 thickness=0.25 + 色散 texel=10（逐字）', () => {
    expect(HALO_RADIUS).toBe(0.45); expect(HALO_THICKNESS).toBe(0.25)
    expect(CHROMATIC_ABERRATION).toBe(10.0)
  })
  it('upsample radius=0.85（CoD:AW bloom 软硬旋钮）', () => {
    expect(UPSAMPLE_RADIUS).toBe(0.85)
  })
  it('depth epsilon=1e-6（log 域，spec §5.5/R6）', () => {
    expect(DEPTH_EPSILON).toBe(1e-6)
  })
  it('kernel 权重归一化（learnopengl / CoD:AW / upsample 三组）', () => {
    const l = LEARNOGLY_DOWNSAMPLE_WEIGHTS
    expect(l.center + l.innerCorner * 4 + l.edgeMid * 4 + l.outerCorner * 4).toBeCloseTo(1.0)
    const c = CODAW_DOWNSAMPLE_WEIGHTS
    expect(c.inner).toBe(0.125); expect(c.outer).toBeCloseTo(0.05556)
    const u = UPSAMPLE_WEIGHTS
    expect(u.center + u.edge * 4 + u.corner * 4).toBeCloseTo(1.0)
  })
  it('默认参数起点（spec §5.8，实测非缩放）', () => {
    expect(THRESHOLD_LEVEL_DEFAULT).toBe(3.0)
    expect(THRESHOLD_RANGE_DEFAULT).toBe(1.0)
    expect(INTENSITY_DEFAULT).toBe(0.01)
    expect(GHOST_AMOUNT_DEFAULT).toBe(0.05)
    expect(HALO_AMOUNT_DEFAULT).toBe(0.05)
  })
})
