import { describe, it, expect, vi } from 'vitest'

// mock cesium 的 Texture3D/Texture/Sampler 构造 + PixelFormat/PixelDatatype/TextureWrap（避免 WebGL context 依赖）
vi.mock('cesium', () => ({
  Texture3D: class {
    constructor(_opts: unknown) {}
  },
  Texture: class {
    constructor(_opts: unknown) {}
    generateMipmap() {}
  },
  Sampler: class {
    constructor(_opts?: unknown) {}
  },
  PixelFormat: { RED: 0x1903, RGBA: 0x1908 },
  PixelDatatype: { UNSIGNED_BYTE: 0x1401 },
  TextureWrap: { REPEAT: 10497, CLAMP_TO_EDGE: 33071, MIRRORED_REPEAT: 33648 },
  TextureMinificationFilter: { LINEAR: 9729, NEAREST: 9728 },
  TextureMagnificationFilter: { LINEAR: 9729, NEAREST: 9728 }
}))

import { loadWeatherTextures } from './weatherTextures'

describe('loadWeatherTextures', () => {
  it('fetch shape/shape_detail/stbn bin + local_weather.png（decode 失败 fallback 1×1 全白）', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('.png')
          ? { blob: () => Promise.resolve(new Blob()) }
          : { arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) }
      )
    )
    const origFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      const w = await loadWeatherTextures({} as never, '/clouds')
      expect(w.shape).toBeDefined()
      expect(w.shapeDetail).toBeDefined()
      expect(w.stbn).toBeDefined()
      expect(w.localWeather).toBeDefined() // createImageBitmap 缺失 → decode 抛 → 全白 fallback
      // T6：decode 失败 → 无原始数据（atlasDisabled escape 无 fallback 源 → warn+跳过创建）
      expect(w.localWeatherRaw).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledWith('/clouds/shape.bin')
      expect(fetchMock).toHaveBeenCalledWith('/clouds/shape_detail.bin')
      expect(fetchMock).toHaveBeenCalledWith('/clouds/stbn.bin')
      expect(fetchMock).toHaveBeenCalledWith('/clouds/local_weather.png')
    } finally {
      global.fetch = origFetch
    }
  })

  it('local_weather PNG decode 成功路径（stub createImageBitmap/OffscreenCanvas → RGBA Texture）', async () => {
    const bitmap = { width: 2, height: 2, close: vi.fn() }
    const createImageBitmapMock = vi.fn(() => Promise.resolve(bitmap))
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number
        height: number
        constructor(width: number, height: number) {
          this.width = width
          this.height = height
        }
        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              width: w,
              height: h,
              data: new Uint8ClampedArray(w * h * 4)
            })
          }
        }
      }
    )
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('.png')
          ? { blob: () => Promise.resolve(new Blob()) }
          : { arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) }
      )
    )
    const origFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      const w = await loadWeatherTextures({} as never, '/clouds')
      expect(w.localWeather).toBeDefined()
      // T6：decode 成功带原始 RGBA（atlasDisabled escape 的 WeatherAtlas pngFallback 包装源；
      // 2D Texture 字段保留零改动——shadow 等其他消费端不受影响）
      expect(w.localWeatherRaw).toBeDefined()
      expect(w.localWeatherRaw!.width).toBe(2)
      expect(w.localWeatherRaw!.height).toBe(2)
      expect(w.localWeatherRaw!.data).toHaveLength(2 * 2 * 4)
      expect(createImageBitmapMock).toHaveBeenCalled()
      expect(bitmap.close).toHaveBeenCalled()
    } finally {
      global.fetch = origFetch
      vi.unstubAllGlobals()
    }
  })
})
