import { Float16Array } from '@petamoriken/float16'
import { createLUT2D, createLUT3D } from './cesiumTextures'
import type { Context, Texture, Texture3D } from 'cesium'

export interface AtmosphereLUTs {
  transmittance: Texture
  scattering: Texture3D
  irradiance: Texture
  // higher-order scattering LUT（C9，spec 附录 E2/E3 + r2 F1）：云 god rays 需 shadow_length>0，
  // 走 bruneton/runtime.glsl HAS_HIGHER_ORDER_SCATTERING_TEXTURE 分支（只遮 single Rayleigh 保留多阶，
  // 防过暗黑）。8388608 字节 = 256×128×32 half-float RGBA（与 scattering 同格式同维度）。
  // 【产品化 spec §7.5】`higherOrderScattering: false` 时不加载（省 8MB）→ undefined；
  // 此时 shader 必须同步不 define HAS_HIGHER_ORDER_SCATTERING_TEXTURE（否则采样未绑定的
  // sampler3D）。用条件 binding 而不是 1×1 dummy：dummy 会被当真实高阶散射采样，改变大气亮度。
  higherOrderScattering?: Texture3D
}

export interface LoadAtmosphereLUTsOptions {
  /**
   * 是否加载 8MB 的 higher_order_scattering.bin（默认 true）。
   * 只在 `clouds: false` 时传 false（spec §7.5：装云就必须加载——lightShafts 是质量档
   * 编译开关，setQuality 随时跨档）。须与 buildAtmospherePrefix 的同名选项保持一致。
   */
  higherOrderScattering?: boolean
}

// 资产字节表（spec §7.4）：必须与根包 src/assets.ts 的 ASSET_BYTES 保持一致。
// 为什么不从根包导入：@cesium-geospatial/core 是被根包聚合的子包，反向依赖会形成环。
const LUT_BYTES = {
  transmittance: 131072, // 256×64 half-float RGBA
  scattering: 8388608, // 256×128×32 half-float RGBA
  irradiance: 8192, // 64×16 half-float RGBA
  higher_order_scattering: 8388608 // 同 scattering 维度
} as const

// .bin 文件是 half-float (Uint16Array) RGBA，逐像素 4 通道。
// 文件大小 = width*height*depth * 4 * 2 字节。
// @petamoriken/float16 的 Float16Array 把 buffer 当 half 视图，Float32Array.from 转 float。
export function parseHalfFloatBin(buffer: ArrayBuffer): Float32Array {
  const f16 = new Float16Array(buffer)
  return Float32Array.from(f16)
}

const TRANSMITTANCE_W = 256,
  TRANSMITTANCE_H = 64
const SCATTERING_W = 256,
  SCATTERING_H = 128,
  SCATTERING_D = 32
const IRRADIANCE_W = 64,
  IRRADIANCE_H = 16

function joinUrl(dir: string, file: string): string {
  // resolveAssetUrls 返回的目录末尾带 `/`；这里统一去掉再拼，避免 `luts//x.bin`
  // （部分静态服务器不折叠双斜杠）。demo 的 'luts' 形态产物 URL 逐字节不变。
  return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${file}`
}

function contentTypeOf(res: Response): string {
  return res.headers?.get?.('content-type') ?? '未知'
}

/**
 * 取回 LUT 资产并校验精确字节数（spec §7.4）。
 * `r.ok` 挡不住 Vite dev / SPA fallback 的 200 text/html——必须看长度。
 */
async function fetchLut(url: string, expectedBytes: number): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`资产请求失败：${url}（HTTP ${res.status}）`)
  }
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `资产长度不符：${url}（期望 ${expectedBytes} 字节，实际 ${buffer.byteLength} 字节，` +
        `content-type: ${contentTypeOf(res)}）——缺失资产常以 200 text/html 返回`
    )
  }
  return buffer
}

export async function loadAtmosphereLUTs(
  context: Context,
  baseUrl: string,
  options: LoadAtmosphereLUTsOptions = {}
): Promise<AtmosphereLUTs> {
  const loadHigherOrderScattering = options.higherOrderScattering !== false
  const [tBuf, sBuf, iBuf, hBuf] = await Promise.all([
    fetchLut(joinUrl(baseUrl, 'transmittance.bin'), LUT_BYTES.transmittance),
    fetchLut(joinUrl(baseUrl, 'scattering.bin'), LUT_BYTES.scattering),
    fetchLut(joinUrl(baseUrl, 'irradiance.bin'), LUT_BYTES.irradiance),
    // 不加载时不发起请求（省 8MB 下载 + 显存）
    loadHigherOrderScattering
      ? fetchLut(
          joinUrl(baseUrl, 'higher_order_scattering.bin'),
          LUT_BYTES.higher_order_scattering
        )
      : Promise.resolve(undefined)
  ])
  return {
    transmittance: createLUT2D(
      context,
      parseHalfFloatBin(tBuf),
      TRANSMITTANCE_W,
      TRANSMITTANCE_H
    ),
    scattering: createLUT3D(
      context,
      parseHalfFloatBin(sBuf),
      SCATTERING_W,
      SCATTERING_H,
      SCATTERING_D
    ),
    irradiance: createLUT2D(
      context,
      parseHalfFloatBin(iBuf),
      IRRADIANCE_W,
      IRRADIANCE_H
    ),
    higherOrderScattering:
      hBuf === undefined
        ? undefined
        : createLUT3D(
            context,
            parseHalfFloatBin(hBuf),
            SCATTERING_W,
            SCATTERING_H,
            SCATTERING_D
          )
  }
}
