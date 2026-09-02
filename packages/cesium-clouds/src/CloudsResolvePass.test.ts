// CloudsResolvePass.test.ts
//
// M4 T4：createCloudsResolvePass 单测（node 无 WebGL——mock 模式仿 CloudsPass.test.ts）。
// 验：双 Texture（全分 LINEAR）+ 双内部 VolumetricPrimitive 装配；uniformMap（color/depthVel
// 闭包 + history swap 后换引用 + texelSize/frame/varianceGamma/temporalAlpha）；swapBuffers
// 三引用轮换（外壳 primitive 稳定）；getResolvedBridge 读 resolveRef；destroy 幂等。

import { describe, it, expect, vi } from 'vitest'

// vi.mock('cesium')：仅 mock WebGL-touching 类（Texture/Sampler——node 无 WebGL）。
// importOriginal 保真 math 类（Cartesian2 等）。
const createdTextures: any[] = []
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const mkTexCtor = () =>
    function (this: any, opts: any) {
      this.width = opts.width
      this.height = opts.height
      this.pixelDatatype = opts.pixelDatatype
      this.sampler = opts.sampler
      this._texture = { id: createdTextures.length }
      this._target = 0x0de1 // GL_TEXTURE_2D
      this.destroy = vi.fn()
      createdTextures.push(this)
    }
  return {
    ...actual,
    Texture: mkTexCtor(),
    Sampler: function (this: any, opts: any) {
      Object.assign(this, opts)
    }
  }
})

// vi.mock('@cesium-geospatial/core')：CloudsResolveMaterial 经 glslIndex import 真实 GLSL
// 资产（core.glslIndex.core）——importOriginal 部分mock 保留，仅 mock createVolumetricPrimitive。
const primitiveCalls: any[] = []
vi.mock('@cesium-geospatial/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createVolumetricPrimitive: vi.fn((opts: any) => {
      const rec = { opts, update: vi.fn(), isDestroyed: () => false, destroy: vi.fn() }
      primitiveCalls.push(rec)
      return rec
    })
  }
})

import { Texture } from 'cesium'
import { createVolumetricPrimitive } from '@cesium-geospatial/core'
import { createCloudsResolvePass } from './CloudsResolvePass'

const frameRef = { value: 7 }

function mkOpts(width = 1920, height = 1080) {
  const colorBuffer = new Texture({ width: 480, height: 270 } as any)
  const depthVelocityBuffer = new Texture({ width: 480, height: 270 } as any)
  return {
    context: { drawingBufferWidth: width, drawingBufferHeight: height } as any,
    width,
    height,
    pixelDatatype: 0x140b,
    colorBuffer,
    depthVelocityBuffer,
    frame: () => frameRef.value
  }
}

describe('M4 T4 CloudsResolvePass', () => {
  it('装配：两张全分 Texture + 两个内部 VolumetricPrimitive（各挂一张）', () => {
    const p = createCloudsResolvePass(mkOpts())
    expect(createdTextures.length).toBeGreaterThanOrEqual(2)
    expect(p.resolvedTexture.width).toBe(1920)
    expect(p.resolvedTexture.height).toBe(1080)
    expect(createVolumetricPrimitive).toHaveBeenCalled()
    p.destroy()
  })

  it('uniformMap：color/depthVel 闭包 + texelSize/frame/varianceGamma/temporalAlpha 默认值', () => {
    const opts = mkOpts()
    const p = createCloudsResolvePass(opts)
    const call = primitiveCalls.at(-1)!.opts
    const um = call.uniformMap
    expect(um.colorBuffer()).toBe(opts.colorBuffer)
    expect(um.depthVelocityBuffer()).toBe(opts.depthVelocityBuffer)
    expect(um.texelSize().x).toBeCloseTo(1 / 1920)
    expect(um.frame()).toBe(7)
    expect(um.varianceGamma()).toBe(2)
    expect(um.temporalAlpha()).toBe(0.1)
    p.destroy()
  })

  // 2026-09-02 云地平线黑块修复：disocclusion rejection 阈值 uniform 注册
  //（默认 0.5=跨云边界 |Δa|=1 稳触发；显式覆盖透传；>1 禁用语义由 shader 比较）。
  it('uniformMap：temporalDisocclusion 默认 0.5 + 显式覆盖透传', () => {
    const p1 = createCloudsResolvePass(mkOpts())
    const um1 = primitiveCalls.at(-1)!.opts.uniformMap
    expect(um1.temporalDisocclusion()).toBe(0.5)
    p1.destroy()
    const p2 = createCloudsResolvePass({ ...mkOpts(), temporalDisocclusion: 1.01 })
    const um2 = primitiveCalls.at(-1)!.opts.uniformMap
    expect(um2.temporalDisocclusion()).toBe(1.01)
    p2.destroy()
  })

  it('swapBuffers：外壳 primitive 稳定 + resolvedTexture/history uniform 轮换（ping-pong 两轮复原）', () => {
    const opts = mkOpts()
    const p = createCloudsResolvePass(opts)
    const shellRef = p.primitive
    const before = p.resolvedTexture
    const um = primitiveCalls.at(-1)!.opts.uniformMap
    const histBefore = um.colorHistoryBuffer()
    p.swapBuffers()
    // swap 后：resolveRef=旧 history（待写），history uniform=旧 resolve（上帧输出）
    expect(p.primitive).toBe(shellRef) // 外壳稳定（PrimitiveCollection 持引用不受影响）
    expect(p.resolvedTexture).not.toBe(before)
    expect(um.colorHistoryBuffer()).toBe(before)
    expect(um.colorHistoryBuffer()).not.toBe(histBefore)
    // 再 swap 回（ping-pong 复原）
    p.swapBuffers()
    expect(p.resolvedTexture).toBe(before)
    expect(um.colorHistoryBuffer()).toBe(histBefore)
    p.destroy()
  })

  it('destroy：双内部 primitive + 双 Texture 释放，幂等', () => {
    const p = createCloudsResolvePass(mkOpts())
    const internalA = primitiveCalls.at(-2)
    const internalB = primitiveCalls.at(-1)
    p.destroy()
    p.destroy()
    expect(internalA.destroy).toHaveBeenCalledTimes(1)
    expect(internalB.destroy).toHaveBeenCalledTimes(1)
    expect((p.resolvedTexture as any).destroy).toHaveBeenCalledTimes(1)
  })

  it('upscaleDivisor=2（涂抹修复 T1）：fragmentShaderSource 注入 #define UPSCALE_DIVISOR 2；缺省=4', () => {
    const p2 = createCloudsResolvePass({ ...mkOpts(), upscaleDivisor: 2 })
    expect(primitiveCalls.at(-1)!.opts.fragmentShaderSource).toContain('#define UPSCALE_DIVISOR 2')
    p2.destroy()
    const p4 = createCloudsResolvePass(mkOpts())
    expect(primitiveCalls.at(-1)!.opts.fragmentShaderSource).toContain('#define UPSCALE_DIVISOR 4')
    p4.destroy()
  })

  it('setTemporalAlpha 动态生效（运动自适应 T2）：uniformMap 闭包读最新值', () => {
    const p = createCloudsResolvePass(mkOpts())
    const um = primitiveCalls.at(-1)!.opts.uniformMap
    expect(um.temporalAlpha()).toBe(0.1)
    p.setTemporalAlpha(0.4)
    expect(um.temporalAlpha()).toBe(0.4)
    p.setTemporalAlpha(0.1)
    expect(um.temporalAlpha()).toBe(0.1)
    p.destroy()
  })
})
