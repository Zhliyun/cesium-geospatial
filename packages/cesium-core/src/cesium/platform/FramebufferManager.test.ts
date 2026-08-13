// FramebufferManager.test.ts
//
// MRT / TEXTURE_2D_ARRAY / ping-pong 工厂单测。参照 historyBlit.test.ts 的 vi.mock('cesium') 范式
// （mock Texture/Sampler/Framebuffer/PixelFormat 等）。createArrayTextureBridge 需 raw WebGL，
// mock context._gl（createTexture/bindTexture/texImage3D spy）。
import { describe, it, expect, vi } from 'vitest'

// vi.mock('cesium')：Texture/Framebuffer/Sampler 等运行时 import，需 mock。
// Texture mock：记 _texture/_target（bridge 测试用）+ width/height + destroy spy。
// Framebuffer mock：记 colorTextures + destroyAttachments + destroy spy。
vi.mock('cesium', () => {
  let texId = 0
  function Texture(this: any, opts: any) {
    this._texture = { id: ++texId } // 模拟 WebGLTexture handle（递增，便于区分 ping-pong 两张）
    this._target = 0x0de1 // TEXTURE_2D
    this.width = opts.width
    this.height = opts.height
    this.pixelDatatype = opts.pixelDatatype
    this.destroy = vi.fn()
    return this
  }
  function Framebuffer(this: any, opts: any) {
    this.colorTextures = opts.colorTextures
    this.destroyAttachments = opts.destroyAttachments
    this.destroy = vi.fn()
  }
  return {
    Texture,
    Framebuffer,
    Sampler: function (this: any, opts: any) {
      this.opts = opts
      return this
    },
    PixelFormat: { RGBA: 6408 },
    PixelDatatype: { HALF_FLOAT: 36193, FLOAT: 5126, UNSIGNED_BYTE: 5121 },
    TextureMinificationFilter: { NEAREST: 9728, LINEAR: 9729 },
    TextureMagnificationFilter: { NEAREST: 9728, LINEAR: 9729 },
    TextureWrap: { CLAMP_TO_EDGE: 33071, REPEAT: 10497, MIRRORED_REPEAT: 33648 },
  }
})

// mock Context：createPingPong/createMRTFramebuffer 只需 context 透传到 Texture/Framebuffer 构造
// （Texture 构造接收 context opts）。createArrayTextureBridge 需 _gl（raw WebGL2 调用）。
function createMockContext(): any {
  return {
    // _gl：raw WebGL2 模拟（createArrayTextureBridge 用）。spy 便于断言调用参数。
    _gl: {
      createTexture: vi.fn(() => ({ id: 'webgl-tex' })),
      bindTexture: vi.fn(),
      texImage3D: vi.fn(),
      texParameteri: vi.fn(),
    },
  }
}

import {
  createMRTFramebuffer,
  createPingPong,
  createArrayTextureBridge,
} from './FramebufferManager'

describe('createPingPong', () => {
  it('默认 count=2：两张 Texture + readIndex=0 + width/height 透传', () => {
    const ctx = createMockContext()
    const pp = createPingPong(ctx, { width: 1920, height: 1080 })
    expect(pp.textures).toHaveLength(2)
    expect(pp.readIndex).toBe(0)
    expect(pp.width).toBe(1920)
    expect(pp.height).toBe(1080)
    expect(pp.textures[0].width).toBe(1920)
    expect(pp.textures[1].height).toBe(1080)
  })

  it('swap：readIndex 0→1→0 翻转', () => {
    const ctx = createMockContext()
    const pp = createPingPong(ctx, { width: 100, height: 100 })
    expect(pp.readIndex).toBe(0)
    pp.swap()
    expect(pp.readIndex).toBe(1)
    pp.swap()
    expect(pp.readIndex).toBe(0)
  })

  it('getRead/getWrite：swap 前后翻转（read= textures[readIndex], write=textures[1-readIndex]）', () => {
    const ctx = createMockContext()
    const pp = createPingPong(ctx, { width: 100, height: 100 })
    expect(pp.getRead()).toBe(pp.textures[0])
    expect(pp.getWrite()).toBe(pp.textures[1])
    pp.swap()
    expect(pp.getRead()).toBe(pp.textures[1])
    expect(pp.getWrite()).toBe(pp.textures[0])
  })

  it('getBridge：返回当前 read Tex 的 {_texture, _target: TEXTURE_2D}（Cesium createUniform 兼容）', () => {
    const ctx = createMockContext()
    const pp = createPingPong(ctx, { width: 100, height: 100 })
    const bridge = pp.getBridge()
    expect(bridge._texture).toBe((pp.textures[0] as any)._texture)
    expect(bridge._target).toBe(0x0de1) // TEXTURE_2D
    pp.swap()
    const bridge2 = pp.getBridge()
    expect(bridge2._texture).toBe((pp.textures[1] as any)._texture)
  })

  it('pixelDatatype 透传到 Texture 构造（默认 HALF_FLOAT）', () => {
    const ctx = createMockContext()
    const pp = createPingPong(ctx, { width: 10, height: 10 })
    // pixelDatatype 是 Cesium Texture 内部字段（augment 未声明），as any 读（test-only）
    expect((pp.textures[0] as any).pixelDatatype).toBe(36193) // HALF_FLOAT 默认
    const pp2 = createPingPong(ctx, { width: 10, height: 10, pixelDatatype: 5121 })
    expect((pp2.textures[0] as any).pixelDatatype).toBe(5121) // UNSIGNED_BYTE 覆盖
  })

  it('count 可配（>2 多 buffer ping-pong，如 triple-buffer）', () => {
    const ctx = createMockContext()
    const pp = createPingPong(ctx, { width: 10, height: 10, count: 3 })
    expect(pp.textures).toHaveLength(3)
    expect(pp.readIndex).toBe(0)
    // swap 在 count=3 下 readIndex (readIndex+1)%count 循环
    pp.swap()
    expect(pp.readIndex).toBe(1)
    pp.swap()
    expect(pp.readIndex).toBe(2)
    pp.swap()
    expect(pp.readIndex).toBe(0)
    // getWrite = textures[(readIndex+1)%count]
    expect(pp.getWrite()).toBe(pp.textures[1])
  })
})

describe('createArrayTextureBridge', () => {
  it('返回 _target=TEXTURE_2D_ARRAY(0x871A) + _texture=gl.createTexture() 句柄', () => {
    const ctx = createMockContext()
    const bridge = createArrayTextureBridge(ctx, { width: 1024, height: 1024, layers: 4 })
    expect(bridge._target).toBe(0x871A) // TEXTURE_2D_ARRAY
    expect(bridge._texture).toEqual({ id: 'webgl-tex' }) // gl.createTexture() 返回值
  })

  it('调 gl.texImage3D（TEXTURE_2D_ARRAY, width×height×layers, RGBA8/UNSIGNED_BYTE 默认）', () => {
    const ctx = createMockContext()
    createArrayTextureBridge(ctx, { width: 512, height: 512, layers: 3 })
    const gl = ctx._gl
    expect(gl.createTexture).toHaveBeenCalledTimes(1)
    expect(gl.bindTexture).toHaveBeenCalledWith(0x871A, expect.anything())
    expect(gl.texImage3D).toHaveBeenCalledTimes(1)
    // texImage3D(target, level, internalFormat, width, height, depth, border, format, type, pixels)
    const args = gl.texImage3D.mock.calls[0]
    expect(args[0]).toBe(0x871A) // target
    expect(args[3]).toBe(512) // width
    expect(args[4]).toBe(512) // height
    expect(args[5]).toBe(3) // layers/depth
  })
})

describe('createMRTFramebuffer', () => {
  it('多 attachment FBO（colorTextures=入参, destroyAttachments=false）', () => {
    const ctx = createMockContext()
    const t0 = { id: 1 } as any
    const t1 = { id: 2 } as any
    const t2 = { id: 3 } as any
    const fbo = createMRTFramebuffer(ctx, [t0, t1, t2]) as any
    expect(fbo.colorTextures).toEqual([t0, t1, t2])
    expect(fbo.destroyAttachments).toBe(false) // texture 调用方管理
  })
})
