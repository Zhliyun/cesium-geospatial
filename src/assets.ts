// 资产分发（spec §7.4）：URL 解析 + 逐资产字节校验。
//
// 背景：缺失资产在 Vite dev / 静态服务器上常返回 200 text/html（SPA fallback），
// 只看 `r.ok` 会把 HTML 当 .bin 吞下去 → 解析出 NaN LUT / 静默黑屏。故所有 .bin
// 都必须按精确字节数校验（错误消息带 URL、期望/实际字节、content-type）。
//
// 本文件是根包（产品分发层）的资产表；两个子包因禁止反向依赖各自持有同值表：
//   packages/cesium-core/src/cesium/lutLoader.ts   （LUT 4 项）
//   packages/cesium-clouds/src/weatherTextures.ts  （weather 3 项）
// 修改下表时必须同步（spec §7.4 表格为唯一真源）。

/** 七个 .bin 资产的精确字节数（spec §7.4）。PNG/webp 走「非空 + 可解码」校验，不在此表。 */
export const ASSET_BYTES: Readonly<Record<string, number>> = Object.freeze({
  transmittance: 131072, // 256×64 half-float RGBA
  scattering: 8388608, // 256×128×32 half-float RGBA
  higher_order_scattering: 8388608, // 同 scattering 维度
  irradiance: 8192, // 64×16 half-float RGBA
  shape: 2097152, // 128³ R8
  shape_detail: 32768, // 32³ R8
  stbn: 1048576 // 128×128×64 R8
})

export interface AssetUrls {
  /** 大气 LUT 目录（末尾带 `/`，内含 transmittance/scattering/irradiance/higher_order_scattering.bin）。 */
  luts: string
  /** 云 weather 目录（末尾带 `/`，内含 shape/shape_detail/stbn.bin + local_weather.png）。 */
  weather: string
  /** 月面颜色纹理（webp）。 */
  moonSurface: string
  /** 月面位移纹理（webp）。 */
  moonDisplacement: string
}

/** 逐项覆盖解析结果（传完整 URL，不再拼默认目录）。 */
export type AssetOverrides = Partial<AssetUrls>

const DEFAULT_ASSET_DIR = 'cesium-geospatial-assets/'

/**
 * 默认资产根目录：相对 `document.baseURI` 解析（兼容 Vite `base: '/app/'` 与子路径部署），
 * 而不是根绝对路径。Node（无 document）回退 `'/'`，供 SSR/测试/自定义 fetch 注入场景。
 */
function defaultBaseUrl(): string {
  if (typeof document === 'undefined') return '/'
  return new URL(DEFAULT_ASSET_DIR, document.baseURI).href
}

function withTrailingSlash(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`
}

/**
 * 解析四类资产 URL。目录项（luts/weather）末尾恒带 `/`；`overrides` 逐项覆盖。
 */
export function resolveAssetUrls(
  baseUrl?: string,
  overrides?: AssetOverrides
): AssetUrls {
  const base = withTrailingSlash(baseUrl ?? defaultBaseUrl())
  return {
    luts: overrides?.luts ?? `${base}luts/`,
    weather: overrides?.weather ?? `${base}clouds/`,
    moonSurface: overrides?.moonSurface ?? `${base}moon/moon-surface.webp`,
    moonDisplacement:
      overrides?.moonDisplacement ?? `${base}moon/moon-displacement.webp`
  }
}

function contentTypeOf(res: Response): string {
  return res.headers?.get?.('content-type') ?? '未知'
}

/**
 * 取回资产并校验字节数。
 *
 * @param url 完整资产 URL
 * @param expectedBytes 期望字节数（不传=不校验长度，仅拦 HTTP 错误）
 * @param fetchImpl 仅测试注入用；生产走全局 fetch
 * @throws HTTP 失败（含 status）或字节数不符（含 URL/期望/实际/content-type）
 */
export async function fetchAsset(
  url: string,
  expectedBytes?: number,
  fetchImpl: typeof fetch = fetch
): Promise<ArrayBuffer> {
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new Error(`资产请求失败：${url}（HTTP ${res.status}）`)
  }
  const buffer = await res.arrayBuffer()
  if (expectedBytes != null && buffer.byteLength !== expectedBytes) {
    throw new Error(
      `资产长度不符：${url}（期望 ${expectedBytes} 字节，实际 ${buffer.byteLength} 字节，` +
        `content-type: ${contentTypeOf(res)}）——缺失资产常以 200 text/html 返回，请检查资产是否已 copy-assets`
    )
  }
  return buffer
}
