import { describe, it, expect, vi } from 'vitest'
import { ASSET_BYTES, resolveAssetUrls, fetchAsset } from './assets'

describe('assets', () => {
  it('默认目录相对 document.baseURI 解析', () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' })
    const urls = resolveAssetUrls()
    expect(urls.luts).toBe('https://example.test/app/cesium-geospatial-assets/luts/')
    expect(urls.weather).toBe('https://example.test/app/cesium-geospatial-assets/clouds/')
    expect(urls.moonSurface).toBe('https://example.test/app/cesium-geospatial-assets/moon/moon-surface.webp')
    vi.unstubAllGlobals()
  })

  it('Node（无 document）回退根相对目录', () => {
    expect(resolveAssetUrls().luts).toBe('/luts/')
    expect(resolveAssetUrls().weather).toBe('/clouds/')
  })

  it('baseUrl 与 overrides 逐项覆盖（目录末尾保留 /）', () => {
    const urls = resolveAssetUrls('https://cdn.test/base', {
      luts: 'https://cdn.test/custom-luts/'
    })
    expect(urls.luts).toBe('https://cdn.test/custom-luts/')
    expect(urls.weather).toBe('https://cdn.test/base/clouds/')
    expect(urls.moonDisplacement).toBe('https://cdn.test/base/moon/moon-displacement.webp')
  })

  it('长度不符时抛错并带 URL 与期望/实际字节', async () => {
    const html = '<!doctype html><html></html>'
    const fake = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(fetchAsset('/x/transmittance.bin', ASSET_BYTES.transmittance, fake as unknown as typeof fetch))
      .rejects.toThrow(/transmittance\.bin/)
    await expect(fetchAsset('/x/transmittance.bin', ASSET_BYTES.transmittance, fake as unknown as typeof fetch))
      .rejects.toThrow(/131072/)
  })

  it('长度不符的错误消息带 content-type 与实收字节', async () => {
    const html = '<!doctype html><html></html>'
    const fake = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
    const err = await fetchAsset('/x/transmittance.bin', ASSET_BYTES.transmittance, fake as unknown as typeof fetch)
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('text/html')
    expect((err as Error).message).toContain(String(new TextEncoder().encode(html).byteLength))
  })

  it('r.ok 为 false 时抛错', async () => {
    const fake = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(fetchAsset('/x/shape.bin', ASSET_BYTES.shape, fake as unknown as typeof fetch)).rejects.toThrow(/404/)
  })

  it('长度正确时返回 ArrayBuffer', async () => {
    const fake = vi.fn(async () => new Response(new ArrayBuffer(ASSET_BYTES.irradiance)))
    const buf = await fetchAsset('/x/irradiance.bin', ASSET_BYTES.irradiance, fake as unknown as typeof fetch)
    expect(buf.byteLength).toBe(ASSET_BYTES.irradiance)
  })

  it('ASSET_BYTES 七个 .bin 精确字节（spec §7.4）', () => {
    expect(ASSET_BYTES).toEqual({
      transmittance: 131072,
      scattering: 8388608,
      higher_order_scattering: 8388608,
      irradiance: 8192,
      shape: 2097152,
      shape_detail: 32768,
      stbn: 1048576
    })
  })
})
