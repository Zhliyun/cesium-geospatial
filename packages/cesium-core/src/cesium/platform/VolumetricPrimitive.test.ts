// VolumetricPrimitive.test.ts
//
// custom Primitive（云主 march 入口）单测。参照 spike CloudsSpikeMRT.ts 的 primitive 段
// + historyBlit.test.ts 的 vi.mock('cesium') 范式（mock Texture/Framebuffer/RenderState）。
//
// node 无 WebGL：验装配/接口/生命周期——primitive 三件套（update 推 command / isDestroyed / destroy 幂等）
// + MRT FBO 构造（destroyAttachments:false）+ renderState fromCache（spike 坑#2）+ pass=VOXELS 默认。
import { describe, it, expect, vi } from 'vitest'

// vi.mock('cesium')：VolumetricPrimitive 运行时 import Framebuffer + RenderState，需 mock。
// Framebuffer mock：记 destroyAttachments + colorTextures 引用（断言 MRT 装配）+ destroy spy。
// RenderState.fromCache mock：返回带 id 的缓存实例（断言 spike 坑#2 renderState.id 存在）。
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual, // M4：BoundingSphere/Cartesian3 保真（排序护甲球用真实现）
    Framebuffer: function (this: any, opts: any) {
      this.colorTextures = opts.colorTextures
      this.destroyAttachments = opts.destroyAttachments
      this.destroy = vi.fn()
    },
    RenderState: {
      fromCache: (opts: any) => ({ id: 1, opts }), // 带 id（spike 坑#2：DerivedCommand 读 renderState.id）
    },
  }
})

// mock Context：createViewportQuadCommand 透传 overrides（pass/framebuffer/renderState）便于断言。
function createMockContext(): any {
  return {
    createViewportQuadCommand: (fragmentShaderSource: string, overrides: any) => ({
      fragmentShaderSource,
      uniformMap: overrides?.uniformMap,
      framebuffer: overrides?.framebuffer,
      renderState: overrides?.renderState,
      pass: overrides?.pass,
    }),
  }
}

// mock MRT color textures（3 attachment：color/depthVelocity/shadowLength）。
function createMockTextures(): any[] {
  return [
    { _texture: { id: 1 }, _target: 0x0de1, destroy: vi.fn() },
    { _texture: { id: 2 }, _target: 0x0de1, destroy: vi.fn() },
    { _texture: { id: 3 }, _target: 0x0de1, destroy: vi.fn() },
  ]
}

import { createVolumetricPrimitive } from './VolumetricPrimitive'

describe('createVolumetricPrimitive', () => {
  it('构造：MRT FBO（colorTextures=入参 3 attachment, destroyAttachments=false）', () => {
    const ctx = createMockContext()
    const mrt = createMockTextures()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'layout(location=0) out vec4 c0; void main(){}',
      uniformMap: {},
      mrtColorTextures: mrt,
    })
    // 读 update 推的 command 的 framebuffer（MRT FBO），验 3 attachment 透传 + destroyAttachments=false
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    const cmd = frameState.commandList[0]
    const fbo = cmd.framebuffer
    expect(fbo.colorTextures).toBe(mrt)
    expect(fbo.destroyAttachments).toBe(false)
  })

  it('update：推 command 到 frameState.commandList（PrimitiveCollection.update 同模式）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: { u_foo: () => 1 },
      mrtColorTextures: createMockTextures(),
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    expect(frameState.commandList).toHaveLength(1)
    const cmd = frameState.commandList[0]
    expect(cmd.fragmentShaderSource).toBe('void main(){}')
    expect(cmd.uniformMap.u_foo()).toBe(1)
  })

  it('默认 pass=VOXELS(10)（globe 后 PostProcess 前执行）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    expect((frameState.commandList[0] as any).pass).toBe(10) // PASS_VOXELS
  })

  it('pass 可覆盖（非 VOXELS 场景）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
      pass: 8, // OPAQUE
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    expect((frameState.commandList[0] as any).pass).toBe(8)
  })

  it('renderState 带 id（spike 坑#2：DerivedCommand getDepthOnlyRenderState 访问 renderState.id）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    const rs = (frameState.commandList[0] as any).renderState
    expect(rs).toBeDefined()
    expect(typeof rs.id).toBe('number') // 缓存 id（spike 坑#2 防 reading 'id' 炸）
  })

  it('isDestroyed：Cesium Destroyable 接口（spike 坑#1：PrimitiveCollection.add 调 isDestroyed）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    expect(typeof prim.isDestroyed).toBe('function')
    expect(prim.isDestroyed()).toBe(false)
  })

  it('destroy：释放 MRT FBO（不连带 destroy texture，destroyAttachments=false）+ 幂等', () => {
    const ctx = createMockContext()
    const mrt = createMockTextures()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: mrt,
    })
    // 先 update 一次拿到 FBO 引用（destroy 验证用）
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    const fbo = frameState.commandList[0].framebuffer
    prim.destroy()
    // FBO.destroy 调一次（GL framebuffer handle 释放）
    expect(fbo.destroy).toHaveBeenCalledTimes(1)
    // texture 不被 FBO 连带 destroy（destroyAttachments=false，texture 由调用方管理）
    mrt.forEach((t) => expect(t.destroy).not.toHaveBeenCalled())
    expect(prim.isDestroyed()).toBe(true)
    // 幂等：二次 destroy 不抛 + FBO.destroy 不重复调
    expect(() => prim.destroy()).not.toThrow()
    expect(fbo.destroy).toHaveBeenCalledTimes(1)
  })

  it('update 在 destroy 后 no-op（不再推 command）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    prim.destroy()
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    expect(frameState.commandList).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M4 T6：viewport 选项（低分 FBO 必须显式——GL viewport 默认保持 drawingBuffer）
// ─────────────────────────────────────────────────────────────────────────────
describe('M4 viewport 选项', () => {
  it('viewport 透传 RenderState.fromCache（低分 march FBO 用）', () => {
    const ctx = createMockContext()
    const viewport = { x: 0, y: 0, width: 480, height: 270 }
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
      viewport: viewport as any,
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    const rs = (frameState.commandList[0] as any).renderState as { opts: any }
    expect(rs.opts.viewport).toEqual(viewport)
  })

  it('缺省不设 viewport（全分 FBO 的 M2 行为：undefined 透传 fromCache）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    const rs = (frameState.commandList[0] as any).renderState as { opts: any }
    expect(rs.opts.viewport).toBeUndefined()
  })
})

// M4 T8：backToFront 排序护甲——voxels pass 多 command（march+resolve）时 mergeSort 读
// command.boundingVolume（undefined 炸，实测）；共享等距球 → 稳定排序保 push 顺序。
describe('M4 boundingVolume 排序护甲', () => {
  it('command.boundingVolume 存在（等距共享球，backToFront 不炸 + mergeSort 稳定）', () => {
    const ctx = createMockContext()
    const prim = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    const frameState = { commandList: [] as any[] }
    prim.update(frameState)
    const bv = (frameState.commandList[0] as any).boundingVolume
    expect(bv).toBeDefined()
    expect(typeof bv.distanceSquaredTo).toBe('function') // backToFront 消费接口
    // 两实例共享同一球（等距 → mergeSort 比较恒 0 → 稳定保序）
    const prim2 = createVolumetricPrimitive({
      context: ctx,
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      mrtColorTextures: createMockTextures(),
    })
    prim2.update(frameState)
    expect((frameState.commandList[1] as any).boundingVolume).toBe(bv)
  })
})
