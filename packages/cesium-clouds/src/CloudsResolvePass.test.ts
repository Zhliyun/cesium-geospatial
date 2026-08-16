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
})
