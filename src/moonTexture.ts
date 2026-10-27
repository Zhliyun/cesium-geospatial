// 月面纹理加载与合成（spec §7.1）。demo 与产品共用，避免两处合成逻辑漂移。
//
// 上游 NASA Moon Kit color_large 2048×1024 equirect 颜色图 × displacement_large 高程图：
// 高程调制进颜色（环形山轮缘比照片图锐利得多；2026-08-30 用户拍板「要有明显的环形山」）。
// 合成在 JS canvas 一次完成，GLSL 侧仍是单 sampler。
//
// 两个入口：
// - `modulateMoonPixels`：纯像素函数（Node 可测）；
// - `loadMoonTextures`：Resource + canvas 加载器（依赖 DOM，Node 单测只覆盖纯函数部分）。
//
// 跨源说明：`Resource.fetchImage` 没有 crossOrigin 选项；Cesium 内部按资源 URL 是否跨源
// 自动设置（`Resource._fetchImage` → `isCrossOriginUrl` → `image.crossOrigin = ''`，
// 等价 `anonymous` 匿名 CORS 请求，见 @cesium/engine Resource.js）。因此跨源部署（CDN）
// 时服务器必须返回 `Access-Control-Allow-Origin`，否则图片解码失败——但 canvas 不会被
// 未授权跨源图片污染（不会抛 SecurityError）。

import { Resource, Sampler, Texture, TextureWrap, type Context } from 'cesium'

/** 对比度拉伸系数 K（demo 标定：s=1 默认摆幅约 ±0.2）。 */
const DISPLACEMENT_K = 4
/** 调制倍率下限：低高程区（坑底/月海）最多压暗到 5%，不会爆负发黑。 */
const MOD_MIN = 0.05
/** 调制倍率上限。 */
const MOD_MAX = 2

const WARN_PREFIX = '[moon-surface]'

/**
 * 以位移图亮度均值为中心调制颜色像素（原地修改 `base` 的 RGB，alpha 不动）。
 *
 * `mod = clamp(1 + (dispLum − dispMean)·scale·K, 0.05, 2)`：正偏差（山脊/环形山轮缘）亮、
 * 负偏差（坑底/月海）暗、均值处不变。对比度拉伸（而非旧版线性 `1−s+s·dl`）在 scale>1 时
 * 不会把低高程区压成负值（旧版 moonDispScale=3 实测月亮消失）。
 *
 * @param base 颜色图 RGBA 像素（原地修改）
 * @param displacement 位移图 RGBA 像素，只用 R 通道且长度须与 `base` 一致
 * @param scale 环形山强度：0=跳过调制（只返回 base 均值），1=默认，>1 增强
 * @param K 对比度拉伸系数，缺省 4
 * @returns 合成后 base 的 RGB 均值（0–1）
 * @throws RangeError 位移图与颜色图像素长度不一致（避免逐像素读取越界产生 NaN）
 */
export function modulateMoonPixels(
  base: Uint8ClampedArray,
  displacement: Uint8ClampedArray,
  scale: number,
  K: number = DISPLACEMENT_K
): { mean: number } {
  if (scale !== 0) {
    if (displacement.length !== base.length) {
      throw new RangeError(
        `位移图像素长度（${displacement.length}）与颜色图（${base.length}）不一致`
      )
    }
    // 第一遍：位移图亮度均值（只取 R 通道，与 demo 内联合成一致）
    let dsum = 0
    for (let i = 0; i < displacement.length; i += 4) dsum += displacement[i]
    const dmean = dsum / (displacement.length / 4) / 255
    // 第二遍：以均值为中心做对比度拉伸
    for (let i = 0; i < base.length; i += 4) {
      const mod = Math.min(
        MOD_MAX,
        Math.max(MOD_MIN, 1 + (displacement[i] / 255 - dmean) * scale * K)
      )
      base[i] = Math.min(255, base[i] * mod)
      base[i + 1] = Math.min(255, base[i + 1] * mod)
      base[i + 2] = Math.min(255, base[i + 2] * mod)
    }
  }
  // 合成后 RGB 均值（0–1，伽马域线性均值近似，与 demo 降采样口径同式）
  let sum = 0
  for (let i = 0; i < base.length; i += 4) {
    sum += (base[i] + base[i + 1] + base[i + 2]) / 3 / 255
  }
  return { mean: base.length === 0 ? 0 : sum / (base.length / 4) }
}

/** 月面纹理 URL（完整 URL，由调用方按资产目录解析）。 */
export interface MoonTextureUrls {
  /** 颜色图（equirect webp）。 */
  surface: string
  /** 位移图（等尺寸 webp，R 通道=高程）。 */
  displacement: string
}

export interface LoadMoonTexturesOptions {
  /**
   * 环形山强度：0=纯颜色图，缺省 1，>1 增强（对应 demo 的 `?moonDispScale=`）。
   */
  displacementScale?: number
}

export interface MoonTextures {
  /** 合成后的月面纹理（`flipY: true` + `CLAMP_TO_EDGE`，v=1 对齐图像顶部=月北极）。 */
  texture: Texture
  /**
   * 合成图 256×128 降采样均值（0–1）。调用方折入月盘辐射基准：
   * `moonRadianceScale = 基准 / albedoMean`，只加图案不让盘整体变暗。
   */
  albedoMean: number
}

/**
 * 加载月面颜色图 + 位移图并在 canvas 合成，产出 Cesium `Texture` 与合成均值。
 *
 * 任何失败（请求/解码/canvas 上下文/合成）都 `console.warn` 后返回 `undefined`，
 * 调用方退回均匀月面（白 dummy）——月面纹理是可选增强，不得阻断安装。
 *
 * @param context Cesium `scene.context`（`Texture` 构造用）
 * @param urls 两张 webp 的完整 URL
 * @param opts `displacementScale` 缺省 1
 */
export async function loadMoonTextures(
  context: Context,
  urls: MoonTextureUrls,
  opts: LoadMoonTexturesOptions = {}
): Promise<MoonTextures | undefined> {
  const displacementScale = opts.displacementScale ?? 1
  let texture: Texture | undefined
  try {
    const [moonImg, moonDispImg] = await Promise.all([
      Resource.fetchImage({ url: urls.surface }),
      Resource.fetchImage({ url: urls.displacement })
    ])
    // fetchImage 在请求被调度器节流时返回 undefined；解码失败则 reject。
    if (moonImg == null || moonDispImg == null) {
      throw new Error('Resource.fetchImage 返回空（请求被调度器节流）')
    }

    // 合成（全分辨率 canvas）
    const mcvs = document.createElement('canvas')
    mcvs.width = (moonImg as HTMLImageElement).width || 2048
    mcvs.height = (moonImg as HTMLImageElement).height || 1024
    const mc2 = mcvs.getContext('2d')
    if (mc2 == null) throw new Error('2D canvas 上下文不可用')
    mc2.drawImage(moonImg as CanvasImageSource, 0, 0, mcvs.width, mcvs.height)
    if (displacementScale !== 0) {
      const base = mc2.getImageData(0, 0, mcvs.width, mcvs.height)
      const dcvs = document.createElement('canvas')
      dcvs.width = mcvs.width
      dcvs.height = mcvs.height
      const dc2 = dcvs.getContext('2d')
      if (dc2 == null) throw new Error('2D canvas 上下文不可用')
      dc2.drawImage(moonDispImg as CanvasImageSource, 0, 0, mcvs.width, mcvs.height)
      const disp = dc2.getImageData(0, 0, mcvs.width, mcvs.height)
      modulateMoonPixels(base.data, disp.data, displacementScale)
      mc2.putImageData(base, 0, 0)
    }

    texture = new Texture({
      context,
      // Cesium .d.ts 的 source 只声明 arrayBufferView 形态（运行时支持 canvas——
      // flipY 路径即为此设计），受控 cast（与 demo 原实现同口径）。
      source: mcvs as unknown as {
        width: number
        height: number
        arrayBufferView: ArrayBufferView
      },
      flipY: true, // equirect v 轴对齐：GL v=1=图像顶部=月北极（GLSL moonUv v 公式如此约定）
      sampler: new Sampler({
        wrapS: TextureWrap.CLAMP_TO_EDGE,
        wrapT: TextureWrap.CLAMP_TO_EDGE
      })
    })

    // 合成图均值（降采样 256×128 粗算足够；与 demo 内联合成同口径）
    const acvs = document.createElement('canvas')
    acvs.width = 256
    acvs.height = 128
    const ac2 = acvs.getContext('2d')
    if (ac2 == null) throw new Error('2D canvas 上下文不可用')
    ac2.drawImage(mcvs, 0, 0, 256, 128)
    const md = ac2.getImageData(0, 0, 256, 128).data
    let msum = 0
    for (let i = 0; i < md.length; i += 4) {
      msum += (md[i] + md[i + 1] + md[i + 2]) / 3 / 255
    }
    return { texture, albedoMean: msum / (md.length / 4) }
  } catch (e) {
    // 纹理已在 try 内创建（均值计算阶段才失败）时先释放，避免 GL 资源泄漏
    texture?.destroy()
    console.warn(`${WARN_PREFIX} 月面纹理加载失败，退回均匀月面`, e)
    return undefined
  }
}
