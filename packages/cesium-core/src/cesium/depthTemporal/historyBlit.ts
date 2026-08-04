// historyBlit.ts
// history Texture ping-pong 管理 + bridge（Cesium createUniform 兼容）+ adapter（私有 API 封装）。
//
// 两张 HALF_FLOAT RGBA NEAREST Texture 翻转：readIndex 指向当前 read（u_historyTexture 采样源），
// write = 1 - readIndex（EMA blit 目标）。swap 后 write 变 read。
//
// bridge：Cesium createUniform.js 读 _target / _texture 把 Cesium.Texture 包成 raw GL sampler
// 兼容对象（与 UniformSampler.set() 一致）。adapter：PostProcessStage.outputTexture 可返 undefined，
// 单独判空以触发 graceful degrade。
import {
  Texture,
  PixelFormat,
  PixelDatatype,
  Sampler,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  TextureWrap,
  defined,
} from 'cesium'

export interface HistoryState {
  textures: Texture[]
  readIndex: number // 当前 read（u_historyTexture 指向），write = 1 - readIndex
  width: number
  height: number
  pixelDatatype: PixelDatatype | number
}

// history 用 NEAREST（depth 像素对齐，不插值——不同于 CloudShadowPass 的 LINEAR）+ CLAMP_TO_EDGE。
// 模块级常量：两张 Texture 共享同一 Sampler 实例（Sampler 无状态）。
const HISTORY_SAMPLER = new Sampler({
  minificationFilter: TextureMinificationFilter.NEAREST,
  magnificationFilter: TextureMagnificationFilter.NEAREST,
  wrapS: TextureWrap.CLAMP_TO_EDGE,
  wrapT: TextureWrap.CLAMP_TO_EDGE,
})

export function createHistoryState(
  context: unknown,
  width: number,
  height: number,
  pixelDatatype: number,
): HistoryState {
  const t0 = new Texture({
    context,
    width,
    height,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype,
    sampler: HISTORY_SAMPLER,
  } as any)
  const t1 = new Texture({
    context,
    width,
    height,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype,
    sampler: HISTORY_SAMPLER,
  } as any)
  return { textures: [t0, t1], readIndex: 0, width, height, pixelDatatype }
}

export function swapHistory(state: HistoryState): void {
  state.readIndex = 1 - state.readIndex
}

// 当前 read Tex（u_historyTexture 指向）
export function getReadTexture(state: HistoryState): Texture {
  return state.textures[state.readIndex]
}

// 当前 write Tex（blit 目标，swap 后变 read）
export function getWriteTexture(state: HistoryState): Texture {
  return state.textures[1 - state.readIndex]
}

// bridge 对象（Cesium createUniform.js 读 _target/_texture，把 Cesium Texture 包成 raw GL sampler 兼容对象）
export function getHistoryBridge(state: HistoryState): { _texture: unknown; _target: number } {
  const tex = getReadTexture(state)
  return {
    _texture: (tex as unknown as { _texture: unknown })._texture,
    _target: (tex as unknown as { _target: number })._target,
  }
}

// adapter：outputTexture getter 判空（评审 minor，PostProcessStage.outputTexture 可返 undefined）
export function sanityCheckOutputTexture(tex: unknown): boolean {
  return defined(tex)
}
