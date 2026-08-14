// ShadowPass.test.ts
//
// M3 T3：ShadowPass 生成端单测——gl mock 断言 FBO 创建/逐层 attach/draw 循环/状态 save-restore。
//
// node 无 WebGL：验装配（Texture3D 参数 + FBO 创建）+ render() 调用序列（FRAMEBUFFER_BINDING
// 保存恢复 + 逐 cascade attach layer + 每 draw 前切 u_cascadeIndex）+ shader wiring（注入工厂
// 收到 T2 组装器输出）+ FBO 不完整降级（warn + 跳过 draw）+ destroy 释放三资源幂等。
//
// 可测性设计（brief 注入工厂方案）：FullscreenPass 依赖真 context.createViewportQuadCommand
// （Cesium Context 深路径，mock 成本高），ShadowPassOptions.createDrawPass 注入 stub 工厂记录
// execute 调用；缺省工厂（FullscreenPass + RenderState viewport）不在本测试覆盖（T5 集成跑）。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── gl mock：记录所有与 FBO 相关的调用（WebGL2RenderingContext 子集）──
const glCalls: string[] = []
const attachments: { layer: number; tex: unknown }[] = []
const gl = {
  createFramebuffer: vi.fn(() => ({ tag: 'fbo' })),
  deleteFramebuffer: vi.fn(),
  bindFramebuffer: vi.fn((_t: number, fbo: unknown) =>
    glCalls.push(`bind:${(fbo as { tag: string } | null)?.tag ?? 'null'}`)
  ),
  framebufferTextureLayer: vi.fn(
    (_t: number, _a: number, tex: unknown, _l: number, layer: number) => {
      glCalls.push(`attach:${layer}`)
      attachments.push({ layer, tex })
    }
  ),
  checkFramebufferStatus: vi.fn(() => 36053), // GL_FRAMEBUFFER_COMPLETE = 0x8cd5
  getParameter: vi.fn(() => ({ tag: 'prevFbo' })),
  viewport: vi.fn()
}

// vi.mock('cesium')：部分 mock（importOriginal 保真 math 类——core index 经 altitudeCorrection.ts
// 顶层 new Cartesian3，全 mock 会炸，同 CloudsPass.test.ts 注释）。仅 mock WebGL-touching 类
// （Texture3D 记录构造参数供断言）与常量对象（值与真 enum 一致）。FullscreenPass 从 core 导入——
// cesium 保真 math 后 core index 可正常加载，类定义无副作用，无需 mock core（注入 stub 工厂
// 不走默认工厂；真 FullscreenPass 由 T5 集成覆盖）。
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  class Texture3DMock {
    static lastOptions: unknown
    static instances: Texture3DMock[] = []
    _texture = { tag: 'tex3d' }
    _target = 32879 // GL_TEXTURE_3D = 0x806F
    destroyed = false
    constructor(opts: unknown) {
      Texture3DMock.lastOptions = opts
      Texture3DMock.instances.push(this)
    }
    destroy() {
      this.destroyed = true
    }
  }
  class SamplerMock {
    static lastOptions: unknown
    constructor(opts?: unknown) {
      ;(SamplerMock as unknown as { lastOptions: unknown }).lastOptions = opts
    }
  }
  return {
    ...actual,
    Texture3D: Texture3DMock,
    Sampler: SamplerMock,
    RenderState: { fromCache: vi.fn(() => ({ id: 1 })) },
    BoundingRectangle: class {},
    PixelFormat: { RGBA: 0x1908 },
    PixelDatatype: { HALF_FLOAT: 0x140b, FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401 },
    TextureMinificationFilter: { LINEAR: 9729, NEAREST: 9728 },
    TextureMagnificationFilter: { LINEAR: 9729, NEAREST: 9728 },
    TextureWrap: { REPEAT: 10497, CLAMP_TO_EDGE: 33071 }
  }
})

import { Texture3D, Sampler } from 'cesium'
import { createShadowPass, type ShadowDrawPass } from './ShadowPass'

// mock context：_gl 裸句柄（ShadowPass 经 context._gl 取）+ drawingBuffer 尺寸（viewport 恢复）
function createMockContext(): { _gl: typeof gl; drawingBufferWidth: number; drawingBufferHeight: number } {
  return { _gl: gl, drawingBufferWidth: 1920, drawingBufferHeight: 1080 }
}

// 注入 stub 工厂：记录 fragmentShader/viewportSize/uniformMap + execute 时采样 u_cascadeIndex
interface StubRecord {
  fragmentShaderSource: string
  viewportSize: number
  uniformMap: { [name: string]: () => unknown }
  cascadeSamples: number[]
  executeCount: number
  destroy: () => void
  /** destroy 的 mock 引用（断言调用次数用；与 destroy 同一函数）。 */
  destroyMock: ReturnType<typeof vi.fn>
}
function mkStubFactory(record: StubRecord) {
  return (
    _ctx: unknown,
    fragmentShaderSource: string,
    uniformMap: { [name: string]: () => unknown },
    viewportSize: number
  ): ShadowDrawPass => {
    record.fragmentShaderSource = fragmentShaderSource
    record.viewportSize = viewportSize
    record.uniformMap = uniformMap
    return {
      execute: () => {
        record.executeCount++
        record.cascadeSamples.push(uniformMap.u_cascadeIndex() as number)
      },
      destroy: record.destroy
    }
  }
}

// StubRecord 工厂（destroy 用统一 vi.fn；destroyMock 字段供断言调用次数）
function mkRecord(): StubRecord {
  const destroyMock = vi.fn()
  return {
    fragmentShaderSource: '',
    viewportSize: 0,
    uniformMap: {},
    cascadeSamples: [],
    executeCount: 0,
    destroy: destroyMock,
    destroyMock
  }
}

describe('createShadowPass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    glCalls.length = 0
    attachments.length = 0
    ;(Texture3D as unknown as { instances: unknown[] }).instances = []
  })

  it('装配：Texture3D mapSize²×cascadeCount RGBA + 缺省 HALF_FLOAT Uint16Array 预置全 0 + flipY false + FBO 创建', () => {
    const context = createMockContext()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 512,
      uniformMap: { frame: () => 0 },
      createDrawPass: () => ({ execute: () => {}, destroy: () => {} })
    })
    const opts = (Texture3D as unknown as { lastOptions: any }).lastOptions
    expect(opts.source.width).toBe(512)
    expect(opts.source.height).toBe(512)
    expect(opts.source.depth).toBe(3) // cascade 维 = 层数（sampler3D z 维）
    // HALF_FLOAT 无原生 TypedArray——Uint16Array 位承载（0x0000 = +0.0 half），消费端
    // 首帧前采样得 0 光深 → Beer=1（与 dummy shadowBuffer 同降级语义）
    expect(opts.source.arrayBufferView).toBeInstanceOf(Uint16Array)
    expect(opts.source.arrayBufferView.length).toBe(512 * 512 * 3 * 4)
    expect(opts.pixelFormat).toBe(0x1908) // RGBA
    expect(opts.pixelDatatype).toBe(0x140b) // HALF_FLOAT 缺省
    expect(opts.flipY).toBe(false) // flipY=true 时 Cesium Texture3D 会 warn 不支持
    // sampler：LINEAR + CLAMP_TO_EDGE（消费端 texture(sampler3D, vec3) 三线性）
    const samplerOpts = (Sampler as unknown as { lastOptions: any }).lastOptions
    expect(samplerOpts.minificationFilter).toBe(9729)
    expect(samplerOpts.magnificationFilter).toBe(9729)
    expect(samplerOpts.wrapS).toBe(33071)
    expect(samplerOpts.wrapT).toBe(33071)
    // 裸 FBO 创建
    expect(gl.createFramebuffer).toHaveBeenCalledTimes(1)
    // bsmTexture 直返 Texture3D 实例（T4 消费端 clouds.frag shadowBuffer uniform 直传）
    expect(pass.bsmTexture).toBeInstanceOf(Texture3D)
    pass.destroy()
  })

  it('装配：pixelDatatype 可覆盖（FLOAT → Float32Array 预置）', () => {
    const context = createMockContext()
    const pass = createShadowPass({
      context,
      cascadeCount: 2,
      mapSize: 8,
      pixelDatatype: 0x1406, // FLOAT
      uniformMap: { frame: () => 0 },
      createDrawPass: () => ({ execute: () => {}, destroy: () => {} })
    })
    const opts = (Texture3D as unknown as { lastOptions: any }).lastOptions
    expect(opts.pixelDatatype).toBe(0x1406)
    expect(opts.source.arrayBufferView).toBeInstanceOf(Float32Array)
    expect(opts.source.arrayBufferView.length).toBe(8 * 8 * 2 * 4)
    pass.destroy()
  })

  it('render() 前后 FRAMEBUFFER_BINDING 保存恢复 + viewport 恢复 drawingBuffer', () => {
    const context = createMockContext()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      createDrawPass: () => ({ execute: () => {}, destroy: () => {} })
    })
    pass.render()
    // 「保存」= getParameter(GL_FRAMEBUFFER_BINDING) 读外部绑定（非 bind 调用，不进 glCalls）
    expect(gl.getParameter).toHaveBeenCalledWith(0x8ca6) // GL_FRAMEBUFFER_BINDING
    // bind 序列：进入 fbo → … → 恢复 prevFbo（首尾）
    expect(glCalls[0]).toBe('bind:fbo')
    expect(glCalls[glCalls.length - 1]).toBe('bind:prevFbo')
    // finally 恢复 viewport 到 drawingBuffer（RenderState.viewport=mapSize 在 execute 内 apply）
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 1920, 1080)
    pass.destroy()
  })

  it('render() 对 cascadeCount=3 依次 attach layer 0,1,2 且每层 execute 一次 draw（attach 的 tex 是 bsmTexture raw handle）', () => {
    const context = createMockContext()
    const record = mkRecord()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      createDrawPass: mkStubFactory(record)
    })
    pass.render()
    // 逐层 attach（u_cascadeIndex ∈ [0,3)——mipLevels[4] 长于 CASCADE_COUNT 3 的越界防护）
    expect(attachments.map((a) => a.layer)).toEqual([0, 1, 2])
    // attach 的 texture 是 Texture3D 的 raw WebGLTexture handle
    const rawTex = (pass.bsmTexture as unknown as { _texture: unknown })._texture
    for (const a of attachments) {
      expect(a.tex).toBe(rawTex)
    }
    expect(record.executeCount).toBe(3)
    pass.destroy()
  })

  it('u_cascadeIndex 闭包随 attach 层切换（draw 时采样 0→1→2；render 后保持末值）', () => {
    const context = createMockContext()
    const record = mkRecord()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      createDrawPass: mkStubFactory(record)
    })
    pass.render()
    expect(record.cascadeSamples).toEqual([0, 1, 2])
    expect(record.uniformMap.u_cascadeIndex()).toBe(2)
    pass.destroy()
  })

  it('shader wiring：注入工厂收到 T2 组装器输出（SHADOW define + u_cascadeIndex）+ viewportSize=mapSize + 业务 uniform 透传', () => {
    const context = createMockContext()
    const record = mkRecord()
    const frameClosure = () => 0
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 64,
      uniformMap: { frame: frameClosure },
      createDrawPass: mkStubFactory(record)
    })
    expect(record.fragmentShaderSource).toContain('#define SHADOW')
    expect(record.fragmentShaderSource).toContain('uniform int u_cascadeIndex')
    expect(record.viewportSize).toBe(64)
    // 业务 uniform 透传（引用保持——调用方闭包表展开后原样可达）
    expect(record.uniformMap.frame).toBe(frameClosure)
    pass.destroy()
  })

  it('checkFramebufferStatus 非 COMPLETE：console.warn 且跳过 draw（降级——主 march fallback Beer=1）+ 仍恢复 prevFbo', () => {
    const context = createMockContext()
    const record = mkRecord()
    gl.checkFramebufferStatus.mockReturnValue(36061) // GL_FRAMEBUFFER_UNSUPPORTED = 0x8cdd
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      createDrawPass: mkStubFactory(record)
    })
    expect(() => pass.render()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('BSM')
    expect(record.executeCount).toBe(0) // 零 draw——不炸，降级语义
    // finally 仍恢复外部 FBO 绑定（return 也走）
    expect(glCalls[glCalls.length - 1]).toBe('bind:prevFbo')
    warnSpy.mockRestore()
    pass.destroy()
  })

  it('destroy()：释放 FBO + bsmTexture + drawPass（幂等）', () => {
    const context = createMockContext()
    const record = mkRecord()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      createDrawPass: mkStubFactory(record)
    })
    pass.destroy()
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1)
    expect(record.destroyMock).toHaveBeenCalledTimes(1)
    expect((pass.bsmTexture as unknown as { destroyed: boolean }).destroyed).toBe(true)
    // 幂等：二次 destroy 不重复释放
    expect(() => pass.destroy()).not.toThrow()
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1)
    expect(record.destroyMock).toHaveBeenCalledTimes(1)
  })
})
