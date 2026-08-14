import { describe, it, expect, vi } from 'vitest'

// mock cesium 的 Texture3D/Sampler 构造 + PixelFormat/PixelDatatype/TextureWrap（避免 WebGL context 依赖）
vi.mock('cesium', () => ({
  Texture3D: class {
    constructor(_opts: unknown) {}
  },
  Sampler: class {
    constructor(_opts?: unknown) {}
  },
  PixelFormat: { RED: 0x1903 },
  PixelDatatype: { UNSIGNED_BYTE: 0x1401 },
  TextureWrap: { REPEAT: 10497, CLAMP_TO_EDGE: 33071, MIRRORED_REPEAT: 33648 },
  TextureMinificationFilter: { LINEAR: 9729, NEAREST: 9728 },
  TextureMagnificationFilter: { LINEAR: 9729, NEAREST: 9728 }
}))

import { loadWeatherTextures } from './weatherTextures'

describe('loadWeatherTextures', () => {
  it('fetch shape.bin + shape_detail.bin（M1 T9，local_weather 2D 待 M2）', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16))
      })
    )
    const origFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      const w = await loadWeatherTextures({} as never, '/clouds')
      expect(w.shape).toBeDefined()
      expect(w.shapeDetail).toBeDefined()
      expect(fetchMock).toHaveBeenCalledWith('/clouds/shape.bin')
      expect(fetchMock).toHaveBeenCalledWith('/clouds/shape_detail.bin')
    } finally {
      global.fetch = origFetch
    }
  })
})
