// weatherTextures.ts — 体积云 weather 噪声纹理加载（M1 T9）
//
// 搬 three-geospatial clouds assets（spec §6 M1 T9）：
//   shape.bin        R8 Uint8 128³（云形状噪声，2MB = 128³×1 byte）
//   shape_detail.bin R8 Uint8 32³（细节噪声，32KB = 32³×1 byte）
//   local_weather.png 2D 512²（LocalWeather size=512；M2 实现 PNG decode + Texture 2D）
//
// format/dimensions 推算自 three 版 CLOUD_SHAPE_TEXTURE_SIZE + 文件大小，M2 云 shader 实际采样时
// 校准（PixelFormat.RED 单通道，WebGL2 sampler3D 采 .r）。three 版还有 procedural 版（CloudShape.ts
// GPU 运行时生成 perlin），本项目 M1 用预计算资产最简，procedural 留作后续优化。
import {
  Texture3D,
  PixelFormat,
  PixelDatatype,
  Sampler,
  TextureWrap,
  TextureMinificationFilter,
  TextureMagnificationFilter
} from 'cesium'
import type { Context } from 'cesium'

// 3D 噪声采样 wrap 必须 REPEAT：shapePosition = position×shapeRepeat 是大值循环采样（fract），
// Cesium Sampler 默认 CLAMP_TO_EDGE 会把采样钉在纹理边缘 → 云噪声退化为常数/条纹（实测 2026-08-14）。
// three 版 Data3DTexture 用 RepeatWrapping 等价。
const WEATHER_SAMPLER = new Sampler({
  wrapS: TextureWrap.REPEAT,
  wrapT: TextureWrap.REPEAT,
  wrapR: TextureWrap.REPEAT,
  minificationFilter: TextureMinificationFilter.LINEAR,
  magnificationFilter: TextureMagnificationFilter.LINEAR
})

export interface WeatherTextures {
  /** 云形状噪声 3D（R8 Uint8 128³）。 */
  shape: Texture3D
  /** 云细节噪声 3D（R8 Uint8 32³）。 */
  shapeDetail: Texture3D
  // localWeather: Texture  // M2：local_weather.png（2D 512²）PNG decode + Texture 2D
}

const SHAPE_SIZE = 128
const SHAPE_DETAIL_SIZE = 32

/**
 * 加载 weather 纹理（shape + shapeDetail 3D；local_weather 2D 待 M2 PNG decode）。
 *
 * @param context Cesium Context
 * @param baseUrl weather 资产目录（如 '/clouds'，含 shape.bin/shape_detail.bin/local_weather.png）
 */
export async function loadWeatherTextures(
  context: Context,
  baseUrl: string
): Promise<WeatherTextures> {
  const [shapeBuf, detailBuf] = await Promise.all([
    fetch(`${baseUrl}/shape.bin`).then((r) => r.arrayBuffer()),
    fetch(`${baseUrl}/shape_detail.bin`).then((r) => r.arrayBuffer())
  ])
  // shape/shape_detail: R8 Uint8 3D（推算 128³/32³；M2 云 shader 采样时校准）。
  // PixelFormat.RED 单通道（WebGL2），UNSIGNED_BYTE。
  const shape = new Texture3D({
    context,
    source: {
      width: SHAPE_SIZE,
      height: SHAPE_SIZE,
      depth: SHAPE_SIZE,
      arrayBufferView: new Uint8Array(shapeBuf)
    },
    pixelFormat: PixelFormat.RED,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    sampler: WEATHER_SAMPLER,
    flipY: false
  })
  const shapeDetail = new Texture3D({
    context,
    source: {
      width: SHAPE_DETAIL_SIZE,
      height: SHAPE_DETAIL_SIZE,
      depth: SHAPE_DETAIL_SIZE,
      arrayBufferView: new Uint8Array(detailBuf)
    },
    pixelFormat: PixelFormat.RED,
    pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
    sampler: WEATHER_SAMPLER,
    flipY: false
  })
  return { shape, shapeDetail }
}
