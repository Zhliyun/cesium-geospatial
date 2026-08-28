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
let fboSeq = 0 // M4：生成端 fbo0 / resolve 端 fbo1 可区分（beforeEach 重置）
// 绑定状态机（回归用：execute 重置绑定为 null 时 attach 前必须已重绑——2026-08-18 滚轮缩放
// 用户验收实测 bug：FullscreenPass.execute 在部分帧把 FRAMEBUFFER 绑定重置 null，i>=1 的
// framebufferTextureLayer 报 "no framebuffer bound" 且该层 BSM draw 落空）。
let currentBinding: unknown = null
const attachBindings: unknown[] = []
const gl = {
  createFramebuffer: vi.fn(() => ({ tag: 'fbo' + fboSeq++ })),
  deleteFramebuffer: vi.fn(),
  bindFramebuffer: vi.fn((_t: number, fbo: unknown) => {
    currentBinding = fbo
    glCalls.push(`bind:${(fbo as { tag: string } | null)?.tag ?? 'null'}`)
  }),
  framebufferTextureLayer: vi.fn(
    (_t: number, _a: number, tex: unknown, _l: number, layer: number) => {
      attachBindings.push(currentBinding)
      glCalls.push(`attach:${layer}`)
      attachments.push({ layer, tex })
    }
  ),
  checkFramebufferStatus: vi.fn(() => 36053), // GL_FRAMEBUFFER_COMPLETE = 0x8cd5
  getParameter: vi.fn(() => ({ tag: 'prevFbo' })),
  viewport: vi.fn(),
  drawBuffers: vi.fn() // M4 T5：temporal 生成段双 draw buffer（gl mock 补）
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
    static allOptions: unknown[] = [] // M4 T5：temporal 下多张 Texture3D（bsm 2N + resolve A/B）——需按序断言
    static instances: Texture3DMock[] = []
    _texture = { tag: 'tex3d' }
    _target = 32879 // GL_TEXTURE_3D = 0x806F
    destroyed = false
    constructor(opts: unknown) {
      Texture3DMock.lastOptions = opts
      Texture3DMock.allOptions.push(opts)
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
    currentBinding = null
    attachBindings.length = 0
    ;(Texture3D as unknown as { instances: unknown[] }).instances = []
    ;(Texture3D as unknown as { allOptions: unknown[] }).allOptions = []
    fboSeq = 0
  })

  it('装配：Texture3D mapSize²×cascadeCount RGBA + 缺省 HALF_FLOAT Uint16Array 预置全 0 + flipY false + FBO 创建', () => {
    const context = createMockContext()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 512,
      uniformMap: { frame: () => 0 },
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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
    expect(gl.createFramebuffer).toHaveBeenCalledTimes(1) // 非 temporal 单 FBO（fbo0）
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
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
      createDrawPass: () => ({ execute: () => {}, destroy: () => {} })
    })
    pass.render()
    // 「保存」= getParameter(GL_FRAMEBUFFER_BINDING) 读外部绑定（非 bind 调用，不进 glCalls）
    expect(gl.getParameter).toHaveBeenCalledWith(0x8ca6) // GL_FRAMEBUFFER_BINDING
    // bind 序列：进入 fbo → … → 恢复 prevFbo（首尾）
    expect(glCalls[0]).toMatch(/^bind:fbo/)
    expect(glCalls[glCalls.length - 1]).toBe('bind:prevFbo')
    // finally 恢复 viewport 到 drawingBuffer（RenderState.viewport=mapSize 在 execute 内 apply）
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 1920, 1080)
    pass.destroy()
  })

  // 回归（2026-08-18 用户验收滚轮缩放报 "framebufferTextureLayer: no framebuffer bound"）：
  // FullscreenPass.execute 在部分帧（multi-frustum 分段渲染）把 FRAMEBUFFER 绑定重置为 null，
  // 旧实现循环外只 bind 一次 → i>=1 的 attach 落在 null 上（报错 + 该层 BSM draw 落空）。
  // 修复：每次 attach 前防御性重绑 fbo。本用例用「execute 即重置绑定为 null」的 stub 模拟。
  it('render() 防御重绑：execute 重置 FRAMEBUFFER 为 null 时，每层 attach 前绑定仍是 fbo', () => {
    const context = createMockContext()
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      temporalPass: false,
      // stub execute：模拟 Cesium 把绑定重置为 null（用户验收实测行为）
      createDrawPass: () => ({
        execute: () => {
          currentBinding = null
        },
        destroy: () => {}
      })
    })
    pass.render()
    // 3 层 attach 全部发生在「绑定 = ShadowPass 内部创建的 fbo」上——
    // 没有防御重绑时 i=1,2 会落在 null（execute 重置后）
    expect(attachments.map(a => a.layer)).toEqual([0, 1, 2])
    expect(attachBindings).toHaveLength(3)
    for (const b of attachBindings) {
      expect(b).not.toBeNull()
      expect((b as { tag: string }).tag).toMatch(/^fbo\d+$/)
    }
    pass.destroy()
  })

  // 回归（2026-08-28 云影运动错位根因——比 3b5d7b8 更深一层）：Cesium Context 的 FBO 绑定是
  // JS 侧状态机（Context.js bindFramebuffer：framebuffer !== _currentFramebuffer 才动 GL，
  // 目标 undefined 时【主动 gl.bindFramebuffer(null)】）。本 pass 裸 gl.bindFramebuffer 绕过它，
  // 但 drawPass.execute → Context.draw → beginDraw(undefined) 会走它——当 _currentFramebuffer
  // 被外部污染（≠undefined：上一帧 postRender 的 depthTemporal history blit 在 endFrame 后执行，
  // 留下 _currentFramebuffer = historyFBO 跨帧存活）时，首个 execute 主动绑 null → cascade 0 的
  // draw 画到画布（随后被场景渲染覆盖，无声）→ BSM 层 0 停更而 inverseShadowMatrices 已更新 →
  // 相机运动时近端云影错位、静止后自洽恢复（用户实测症状）。
  // 修复：每次 execute 前显式 _currentFramebuffer = undefined（对齐状态机，语义同 endFrame）。
  it('render() 对齐 Cesium FBO 状态机：_currentFramebuffer 被外部污染时，每层 draw 仍落在 BSM fbo', () => {
    const context = createMockContext()
    const drawBindings: unknown[] = [] // 每次 draw 时刻的 GL 绑定（落点）
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      temporalPass: false,
      // stub execute：忠实模拟 Context.draw → beginDraw(cmd._framebuffer ?? passState.framebuffer
      // = undefined) → bindFramebuffer(ctx, undefined) 的状态机语义——JS 侧 _currentFramebuffer
      // ≠ undefined 时主动 gl.bindFramebuffer(null)（draw 被重定向到画布）。
      createDrawPass: () => ({
        execute: (ctx: unknown) => {
          const c = ctx as { _currentFramebuffer?: unknown }
          if (c._currentFramebuffer !== undefined) {
            c._currentFramebuffer = undefined
            gl.bindFramebuffer(0x8d40, null) // 主动重定向（真 Cesium 行为）
          }
          drawBindings.push(currentBinding) // draw 落点 = 此刻 GL 绑定
        },
        destroy: () => {}
      })
    })
    // 污染：模拟上一帧 postRender blit 留下的跨帧 _currentFramebuffer（historyFBO）
    ;(context as { _currentFramebuffer?: unknown })._currentFramebuffer = { tag: 'historyFbo' }
    pass.render()
    // 3 层 draw 全部落在 ShadowPass 内部 fbo 上——未对齐状态机时 i=0 落 null（BSM 层 0 停更）
    expect(drawBindings).toHaveLength(3)
    for (const b of drawBindings) {
      expect((b as { tag: string } | null)?.tag).toMatch(/^fbo\d+$/)
    }
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
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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
    gl.checkFramebufferStatus.mockReturnValueOnce(36061) // GL_FRAMEBUFFER_UNSUPPORTED = 0x8cdd（Once——不泄漏到后续用例）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pass = createShadowPass({
      context,
      cascadeCount: 3,
      mapSize: 8,
      uniformMap: { frame: () => 0 },
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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
      temporalPass: false,  // M3 基线（M4 temporal 用例见下方独立 describe）
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

// ─────────────────────────────────────────────────────────────────────────────
// M4 T5：temporal 扩展——velocity 层双 attach + resolve 逐 cascade + ping-pong + prevMatrices
// ─────────────────────────────────────────────────────────────────────────────
import { Matrix4, Cartesian3 } from 'cesium'
import type { ShadowDrawPassFactory } from './ShadowPass'

describe('M4 T5 ShadowPass temporal', () => {
  const N = 3

  beforeEach(() => {
    vi.clearAllMocks()
    glCalls.length = 0
    attachments.length = 0
    ;(Texture3D as unknown as { instances: unknown[] }).instances = []
    ;(Texture3D as unknown as { allOptions: unknown[] }).allOptions = []
    fboSeq = 0
  })

  function mkTemporalOpts() {
    const genCalls: string[] = []
    const resCalls: string[] = []
    const genRecord = mkRecord()
    const resRecord = mkRecord()
    // draw 时采样 reprojectionMatrices 快照（render 结束后 prevMatrices 已被覆写——
    // 「draw 用了什么」才是断言对象）
    const repSamples: Matrix4[][] = []
    return {
      opts: {
        context: createMockContext(),
        cascadeCount: N,
        mapSize: 512,
        pixelDatatype: 0x140b,
        uniformMap: {},
        temporalPass: true,
        createDrawPass: (_c: unknown, fs: string, um: any, vp: number) => {
          genRecord.fragmentShaderSource = fs
          genRecord.uniformMap = um
          genRecord.viewportSize = vp
          return {
            execute: () => {
              genCalls.push('gen')
              repSamples.push((um.reprojectionMatrices() as Matrix4[]).map((m) => Matrix4.clone(m)))
            },
            destroy: genRecord.destroy
          }
        },
        createResolveDrawPass: (_c: unknown, fs: string, um: any, vp: number) => {
          resRecord.fragmentShaderSource = fs
          resRecord.uniformMap = um
          resRecord.viewportSize = vp
          return { execute: () => resCalls.push('res'), destroy: resRecord.destroy }
        }
      } as any,
      genCalls,
      resCalls,
      genRecord,
      resRecord,
      repSamples
    }
  }

  it('temporalPass：bsmTexture 生成端 depth=2N（velocity 层）+ resolve A/B 各 depth=N + 生成 N 次 + resolve N 次 + velocity 层 attach', () => {
    const { opts, genCalls, resCalls } = mkTemporalOpts()
    const pass = createShadowPass(opts)
    const all = (Texture3D as any).allOptions
    expect(all[0].source.depth).toBe(2 * N) // bsmTexture（生成端，velocity 层在后半）
    expect(all[1].source.depth).toBe(N) // resolve A
    expect(all[2].source.depth).toBe(N) // resolve B（history）
    pass.render()
    expect(genCalls.length).toBe(N)
    expect(resCalls.length).toBe(N)
    // velocity 层 attach（att1 层 N+i）：attachments 记录里出现 layer 3/4/5
    const layers = (gl.framebufferTextureLayer as any).mock.calls.map((c: any[]) => c[4])
    expect(layers).toContain(N)
    expect(layers).toContain(N + 1)
    expect(layers).toContain(N + 2)
    pass.destroy()
  })

  it('setCurrentMatrices → render：draw 用上帧矩阵（首帧 identity 降级，render 后 prev ← 本帧）', () => {
    const { opts, repSamples } = mkTemporalOpts()
    const pass = createShadowPass(opts)
    const m1 = [
      Matrix4.fromTranslation(new Cartesian3(1, 0, 0)),
      Matrix4.fromTranslation(new Cartesian3(2, 0, 0)),
      Matrix4.fromTranslation(new Cartesian3(3, 0, 0))
    ]
    pass.setCurrentMatrices(m1)
    // 首帧 render：draw 时 reprojectionMatrices = identity（prevMatrices 初始值 → prevClip
    // 巨值 → resolve 端 prevUv 越界 rejection，安全降级）
    pass.render()
    expect(repSamples.length).toBe(N) // 3 cascade 各采样一次
    expect(Matrix4.equals(repSamples[0][0], Matrix4.IDENTITY)).toBe(true)
    // 第二帧 render：draw 时读到 m1（首帧 render 末尾 prev ← 本帧）
    pass.render()
    expect(repSamples.length).toBe(2 * N)
    expect(Matrix4.equals(repSamples[N][0], m1[0])).toBe(true)
    pass.destroy()
  })

  it('resolution uniform = (mapSize, mapSize)（velocity texel 单位换算）+ resolve shader 组装注入', () => {
    const { opts, genRecord, resRecord } = mkTemporalOpts()
    const pass = createShadowPass(opts)
    const res = genRecord.uniformMap.resolution() as { x: number; y: number }
    expect(res.x).toBe(512)
    expect(res.y).toBe(512)
    // resolve 端 shader 含 u_cascadeIndex 单 cascade 桥 + sampler3D
    expect(resRecord.fragmentShaderSource).toContain('uniform int u_cascadeIndex;')
    expect(resRecord.fragmentShaderSource).toContain('uniform sampler3D inputBuffer;')
    expect(resRecord.uniformMap.temporalAlpha()).toBe(0.01)
    expect(resRecord.uniformMap.varianceGamma()).toBe(1)
    pass.destroy()
  })

  it('temporalPass=false：M3 行为——depth=N + 无 resolve draw（零回归）', () => {
    const genCalls: string[] = []
    const resCalls: string[] = []
    const opts = {
      context: createMockContext(),
      cascadeCount: N,
      mapSize: 512,
      uniformMap: {},
      temporalPass: false,
      createDrawPass: (() => ({ execute: () => genCalls.push('gen'), destroy: () => {} })) as any,
      createResolveDrawPass: (() => ({ execute: () => resCalls.push('res'), destroy: () => {} })) as any
    } as any
    const pass = createShadowPass(opts)
    expect((Texture3D as any).lastOptions.source.depth).toBe(N)
    pass.render()
    expect(genCalls).toEqual(['gen', 'gen', 'gen'])
    expect(resCalls).toEqual([])
    pass.destroy()
  })
})

describe('M4 feedback loop 修复（生成端/resolve 端分用 FBO）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    glCalls.length = 0
    attachments.length = 0
    ;(Texture3D as unknown as { instances: unknown[] }).instances = []
    ;(Texture3D as unknown as { allOptions: unknown[] }).allOptions = []
    fboSeq = 0
  })

  it('resolve draw 时 bind 的是独立 FBO（fbo1≠fbo0）——生成端 att1 的 bsmTexture 不残留成环', () => {
    vi.clearAllMocks()
    glCalls.length = 0
    attachments.length = 0
    ;(Texture3D as unknown as { instances: unknown[] }).instances = []
    ;(Texture3D as unknown as { allOptions: unknown[] }).allOptions = []
    const record = mkRecord()
    const resRecord = mkRecord()
    const genExec: number[] = []
    const resExec: number[] = []
    const pass = createShadowPass({
      context: createMockContext(),
      cascadeCount: 3,
      mapSize: 512,
      uniformMap: {},
      temporalPass: true,
      createDrawPass: (_c: unknown, fs: string, um: any, vp: number) => {
        record.uniformMap = um
        return { execute: () => genExec.push(1), destroy: record.destroy }
      },
      createResolveDrawPass: (_c: unknown, fs: string, um: any, vp: number) => {
        resRecord.uniformMap = um
        return { execute: () => resExec.push(1), destroy: resRecord.destroy }
      }
    } as any)
    pass.render()
    // 两个 FBO 创建
    expect(gl.createFramebuffer).toHaveBeenCalledTimes(2)
    // bind 序列：生成段 bind fbo0（attach att0+att1）→ resolve 段 bind fbo1（只 attach att0）
    const binds = glCalls.filter((c) => c.startsWith('bind:'))
    expect(binds).toContain('bind:fbo0')
    expect(binds).toContain('bind:fbo1')
    const iGen = binds.indexOf('bind:fbo0')
    const iRes = binds.indexOf('bind:fbo1')
    expect(iRes).toBeGreaterThan(iGen)
    // resolve 段（bind:fbo1 之后）没有 att1 的 framebufferTextureLayer 调用
    const allCalls = glCalls
    const after = allCalls.slice(allCalls.indexOf('bind:fbo1'))
    const attachAfter = attachments.length
    // att1 的 attach 参数（第 2 参 = 0x8ce1）在 resolve 段不出现
    const att1InResolve = (gl.framebufferTextureLayer as any).mock.calls.filter(
      (c: any[]) => c[1] === 0x8ce1 && genExec.length > 0
    )
    // att1 attach 次数 = 3（仅生成段），非 6（若 resolve 段误用生成 FBO 会重复/残留）
    expect(att1InResolve.length).toBe(3)
    pass.destroy()
  })
})
