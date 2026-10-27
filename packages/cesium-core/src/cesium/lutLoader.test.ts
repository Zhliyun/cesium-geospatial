import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseHalfFloatBin, loadAtmosphereLUTs } from './lutLoader'

// mock cesiumTextures（避免 WebGL context 依赖），loadAtmosphereLUTs 测试用。
vi.mock('./cesiumTextures', () => ({
  createLUT2D: vi.fn(() => ({ __mockLUT: '2d' })),
  createLUT3D: vi.fn(() => ({ __mockLUT: '3d' }))
}))

// 与 lutLoader.ts 内部资产表同值的测试夹具（spec §7.4）。
const LUT_BYTES: Record<string, number> = {
  'transmittance.bin': 131072,
  'scattering.bin': 8388608,
  'irradiance.bin': 8192,
  'higher_order_scattering.bin': 8388608
}

const origFetch = global.fetch
afterEach(() => {
  global.fetch = origFetch
})

/** 安装 fetch mock：记录请求 URL，默认返回对应资产的正确长度二进制。 */
function installFetchMock(
  override?: (url: string) => Response | undefined
): { fake: ReturnType<typeof vi.fn>; urls: string[] } {
  const urls: string[] = []
  const fake = vi.fn(async (url: string) => {
    urls.push(url)
    const custom = override?.(url)
    if (custom != null) return custom
    const name = url.split('/').pop() ?? ''
    return new Response(new ArrayBuffer(LUT_BYTES[name] ?? 0), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' }
    })
  })
  global.fetch = fake as unknown as typeof fetch
  return { fake, urls }
}

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
    const { fake } = installFetchMock()
    const luts = await loadAtmosphereLUTs({} as never, '/luts')
    // 4 张 LUT 字段齐（含 C9 higherOrderScattering）
    expect(luts.transmittance).toBeDefined()
    expect(luts.scattering).toBeDefined()
    expect(luts.irradiance).toBeDefined()
    expect(luts.higherOrderScattering).toBeDefined()
    // fetch 正确 URL（含 higher_order_scattering.bin）
    expect(fake).toHaveBeenCalledWith('/luts/transmittance.bin')
    expect(fake).toHaveBeenCalledWith('/luts/scattering.bin')
    expect(fake).toHaveBeenCalledWith('/luts/irradiance.bin')
    expect(fake).toHaveBeenCalledWith('/luts/higher_order_scattering.bin')
  })

  it('缺资产返回 HTML 时按字节数失败（r.ok 挡不住 200 text/html）', async () => {
    installFetchMock(url =>
      url.endsWith('/transmittance.bin')
        ? new Response('<!doctype html><html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })
        : undefined
    )
    await expect(loadAtmosphereLUTs({} as never, '/luts')).rejects.toThrow(
      /transmittance\.bin/
    )
    await expect(loadAtmosphereLUTs({} as never, '/luts')).rejects.toThrow(/131072/)
  })

  it('HTTP 非 2xx 时失败（消息含 status）', async () => {
    installFetchMock(url =>
      url.endsWith('/irradiance.bin')
        ? new Response('nope', { status: 404 })
        : undefined
    )
    await expect(loadAtmosphereLUTs({} as never, '/luts')).rejects.toThrow(/404/)
  })

  it('higherOrderScattering=false 时不请求 higher_order_scattering.bin，字段为 undefined', async () => {
    const { urls } = installFetchMock()
    const luts = await loadAtmosphereLUTs({} as never, '/luts', {
      higherOrderScattering: false
    })
    expect(urls.some(u => u.includes('higher_order_scattering.bin'))).toBe(false)
    expect(luts.higherOrderScattering).toBeUndefined()
    // 其余三张照常
    expect(luts.transmittance).toBeDefined()
    expect(luts.scattering).toBeDefined()
    expect(luts.irradiance).toBeDefined()
  })

  it('baseUrl 末尾带 / 时不产生双斜杠（与根包 resolveAssetUrls 的目录约定兼容）', async () => {
    const { fake } = installFetchMock()
    await loadAtmosphereLUTs({} as never, '/luts/')
    expect(fake).toHaveBeenCalledWith('/luts/transmittance.bin')
    expect(fake).not.toHaveBeenCalledWith('/luts//transmittance.bin')
  })
})
