import { describe, it, expect, vi } from 'vitest'
import { parseHalfFloatBin, loadAtmosphereLUTs } from './lutLoader'

// mock cesiumTextures（避免 WebGL context 依赖），loadAtmosphereLUTs 测试用。
vi.mock('./cesiumTextures', () => ({
  createLUT2D: vi.fn(() => ({ __mockLUT: '2d' })),
  createLUT3D: vi.fn(() => ({ __mockLUT: '3d' }))
}))

describe('parseHalfFloatBin', () => {
  it('half=0x3C00 (1.0) → 1.0', () => {
    const buf = new Uint16Array([0x3c00]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(1.0, 3)
  })
  it('half=0xBC00 (-1.0) → -1.0', () => {
    const buf = new Uint16Array([0xbc00]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(-1.0, 3)
  })
  it('half=0x4000 (2.0) → 2.0', () => {
    const buf = new Uint16Array([0x4000]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBeCloseTo(2.0, 3)
  })
  it('half=0x0000 → 0.0', () => {
    const buf = new Uint16Array([0x0000]).buffer
    expect(parseHalfFloatBin(buf)[0]).toBe(0)
  })
})

describe('loadAtmosphereLUTs', () => {
  it('加载 4 张 LUT 含 higher_order_scattering（C9）+ fetch 正确 URL', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16))
      })
    )
    const origFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      const luts = await loadAtmosphereLUTs({} as never, '/luts')
      // 4 张 LUT 字段齐（含 C9 higherOrderScattering）
      expect(luts.transmittance).toBeDefined()
      expect(luts.scattering).toBeDefined()
      expect(luts.irradiance).toBeDefined()
      expect(luts.higherOrderScattering).toBeDefined()
      // fetch 正确 URL（含 higher_order_scattering.bin）
      expect(fetchMock).toHaveBeenCalledWith('/luts/transmittance.bin')
      expect(fetchMock).toHaveBeenCalledWith('/luts/scattering.bin')
      expect(fetchMock).toHaveBeenCalledWith('/luts/irradiance.bin')
      expect(fetchMock).toHaveBeenCalledWith('/luts/higher_order_scattering.bin')
    } finally {
      global.fetch = origFetch
    }
  })
})
