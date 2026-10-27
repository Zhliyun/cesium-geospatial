import { describe, it, expect, vi, afterEach } from 'vitest'

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

// 与 weatherTextures.ts 内部资产表同值的测试夹具（spec §7.4）。
const WEATHER_BYTES: Record<string, number> = {
  'shape.bin': 2097152,
  'shape_detail.bin': 32768,
  'stbn.bin': 1048576
}

const origFetch = global.fetch
afterEach(() => {
  global.fetch = origFetch
})

function okBin(name: string): Response {
  return new Response(new ArrayBuffer(WEATHER_BYTES[name] ?? 0), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' }
  })
}

function okPng(): Response {
  // 非空即可（decode 由 createImageBitmap stub/缺失决定）
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  })
}

/** 安装 fetch mock：默认返回各资产正确长度；override 可对指定 URL 返回自定义响应。 */
function installFetchMock(
  override?: (url: string) => Response | undefined
): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async (url: string) => {
    const custom = override?.(url)
    if (custom != null) return custom
    if (url.endsWith('.png')) return okPng()
    return okBin(url.split('/').pop() ?? '')
  })
  global.fetch = fake as unknown as typeof fetch
  return fake
}

describe('loadWeatherTextures', () => {
  it('fetch shape/shape_detail/stbn bin + local_weather.png（decode 失败 fallback 1×1 全白）', async () => {
    const fetchMock = installFetchMock()
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
    installFetchMock()
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
      vi.unstubAllGlobals()
    }
  })

  it('shape.bin 长度不符（200 text/html）时 reject，消息含 URL 与期望字节', async () => {
    installFetchMock(url =>
      url.endsWith('/shape.bin')
        ? new Response('<!doctype html><html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })
        : undefined
    )
    await expect(loadWeatherTextures({} as never, '/clouds')).rejects.toThrow(/shape\.bin/)
    await expect(loadWeatherTextures({} as never, '/clouds')).rejects.toThrow(/2097152/)
  })

  it('stbn.bin 404 时 reject 且消息含 404', async () => {
    installFetchMock(url =>
      url.endsWith('/stbn.bin') ? new Response('nope', { status: 404 }) : undefined
    )
    await expect(loadWeatherTextures({} as never, '/clouds')).rejects.toThrow(/404/)
  })

  it('local_weather.png 404 时降级 1×1 全白 dummy 而非整体失败（M2 既有降级语义）', async () => {
    installFetchMock(url =>
      url.endsWith('.png') ? new Response('nope', { status: 404 }) : undefined
    )
    const w = await loadWeatherTextures({} as never, '/clouds')
    expect(w.localWeather).toBeDefined()
    // 没有可 decode 的源 → atlasDisabled escape 无 fallback 源
    expect(w.localWeatherRaw).toBeUndefined()
  })

  it('baseUrl 末尾带 / 时不产生双斜杠（与根包 resolveAssetUrls 的目录约定兼容）', async () => {
    const fetchMock = installFetchMock()
    await loadWeatherTextures({} as never, '/clouds/')
    expect(fetchMock).toHaveBeenCalledWith('/clouds/shape.bin')
    expect(fetchMock).not.toHaveBeenCalledWith('/clouds//shape.bin')
  })
})
