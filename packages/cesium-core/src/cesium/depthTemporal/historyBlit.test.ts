// historyBlit.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  createHistoryState,
  getHistoryBridge,
  swapHistory,
  getWriteTexture,
  sanityCheckOutputTexture,
  buildBlitCommand,
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

// mock Context：仅 createViewportQuadCommand（fragmentShaderSource, overrides）→ 假 DrawCommand。
// 不污染上面 vi.mock('cesium')（Task 3 的 Texture mock），单独内建最小 context 对象。
function createMockContext(): any {
  return {
    createViewportQuadCommand: (fragmentShaderSource: string, overrides: any) => ({
      // DrawCommand 形态：uniformMap 透传、shaderProgram.fragmentShaderSource 保留 shader 串。
      // 注意：DrawCommand 本体无 shaderSource 属性（有 shaderProgram），故测试不断言 cmd.shaderSource。
      uniformMap: overrides?.uniformMap,
      shaderProgram: { fragmentShaderSource },
      // 以下字段 Task 8 lifecycle 才设/用，本 task 只构造 cmd。
      framebuffer: undefined,
      execute: () => {},
    }),
  }
}

describe('buildBlitCommand', () => {
  it('构造 createViewportQuadCommand：uniformMap.colorTexture 返回 src bridge + cmd defined', () => {
    const ctx = createMockContext()
    const src = { _texture: { id: 99 }, _target: 0x0de1 } as any // bridge 对象（Cesium createUniform 兼容）
    const cmd = buildBlitCommand(ctx, src) as any
    expect(cmd).toBeDefined()
    // DrawCommand.uniformMap.colorTexture 是函数，调用返回 src bridge
    expect(typeof cmd.uniformMap.colorTexture).toBe('function')
    expect(cmd.uniformMap.colorTexture()).toBe(src)
  })

  it('两次调用 buildBlitCommand 各自捕获自己的 srcTexture（闭包隔离）', () => {
    // 防止「uniformMap 共享同一 src」回归——每个 cmd 必须绑定自己的 srcTexture。
    const ctx = createMockContext()
    const srcA = { _texture: { id: 1 }, _target: 0x0de1 } as any
    const srcB = { _texture: { id: 2 }, _target: 0x0de1 } as any
    const cmdA = buildBlitCommand(ctx, srcA) as any
    const cmdB = buildBlitCommand(ctx, srcB) as any
    expect(cmdA.uniformMap.colorTexture()).toBe(srcA)
    expect(cmdB.uniformMap.colorTexture()).toBe(srcB)
    expect(cmdA.uniformMap.colorTexture()).not.toBe(srcB)
  })
})
