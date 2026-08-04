// historyBlit.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  createHistoryState,
  getHistoryBridge,
  swapHistory,
  getWriteTexture,
  sanityCheckOutputTexture,
} from './historyBlit'

// mock Cesium Texture（最小，匹配实际 Texture 构造签名：接收 opts 含 context/width/height/pixelFormat/pixelDatatype/sampler）
vi.mock('cesium', () => {
  let id = 0
  function Texture(this: any, opts: any) {
    this._texture = { id: ++id } // 模拟 WebGLTexture handle（递增，便于 bridge 测试区分两张 Tex）
    this._target = 0x0de1 // TEXTURE_2D
    this.width = opts.width
    this.height = opts.height
    this.pixelDatatype = opts.pixelDatatype
    return this
  }
  return {
    Texture,
    Sampler: function (this: any, opts: any) {
      this.opts = opts
      return this
    },
    PixelFormat: { RGBA: 6408 },
    PixelDatatype: { HALF_FLOAT: 36193, FLOAT: 5126, UNSIGNED_BYTE: 5121 },
    // 真实 GL enum 值（与 Cesium 一致），供 HISTORY_SAMPLER 构造
    TextureMinificationFilter: { NEAREST: 9728, LINEAR: 9729 },
    TextureMagnificationFilter: { NEAREST: 9728, LINEAR: 9729 },
    TextureWrap: { CLAMP_TO_EDGE: 33071, REPEAT: 10497, MIRRORED_REPEAT: 33648 },
    defined: (v: any) => v != null,
  }
})

describe('historyBlit', () => {
  it('createHistoryState: 两张 ping-pong Texture（HALF_FLOAT RGBA NEAREST）+ readIndex=0', () => {
    const ctx = {} as any
    const state = createHistoryState(ctx, 1920, 1080, 36193 /* HALF_FLOAT */)
    expect(state.textures.length).toBe(2)
    expect(state.readIndex).toBe(0)
    expect(state.textures[0].width).toBe(1920)
    expect(state.textures[1].width).toBe(1920) // 宽高透传（修正 plan 原笔误）
    expect(state.textures[1].height).toBe(1080)
  })

  it('swapHistory: readIndex 0→1→0 翻转', () => {
    const state = createHistoryState({} as any, 100, 100, 36193)
    expect(state.readIndex).toBe(0)
    swapHistory(state)
    expect(state.readIndex).toBe(1)
    swapHistory(state)
    expect(state.readIndex).toBe(0)
  })

  it('getHistoryBridge: 返回当前 read Tex 的 {_texture, _target: TEXTURE_2D}', () => {
    const state = createHistoryState({} as any, 100, 100, 36193)
    const bridge = getHistoryBridge(state)
    // _texture 是内部 WebGLTexture handle（私有，类型未声明），运行时 mock 注入
    expect(bridge._texture).toBe((state.textures[0] as any)._texture)
    expect(bridge._target).toBe(0x0de1)
    swapHistory(state)
    const bridge2 = getHistoryBridge(state)
    expect(bridge2._texture).toBe((state.textures[1] as any)._texture)
  })

  it('getWriteTexture: 返回当前 write Tex（swap 后变 read）', () => {
    const state = createHistoryState({} as any, 100, 100, 36193)
    const write0 = getWriteTexture(state)
    expect(write0).toBe(state.textures[1]) // readIndex=0 → write=1
    swapHistory(state)
    const write1 = getWriteTexture(state)
    expect(write1).toBe(state.textures[0]) // readIndex=1 → write=0
  })

  it('sanityCheckOutputTexture: undefined → false（启动 graceful degrade 触发）', () => {
    expect(sanityCheckOutputTexture(undefined)).toBe(false)
    expect(sanityCheckOutputTexture({} as any)).toBe(true)
  })
})
