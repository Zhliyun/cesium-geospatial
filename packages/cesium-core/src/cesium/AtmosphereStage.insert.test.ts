// insertStageBeforeLensFlare 全语义测试（v2.1 spec §5.1/§8.1）。
// 独立文件原因：本文件 vi.mock createLensFlareStage（rebuild 参数断言需可区分实例），
// 而主测试文件断言真实 composite 结构（inputPreviousStageTexture 等）——mock 化会破坏。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Cartesian3, Ellipsoid, type PostProcessStage } from 'cesium'

// vi.hoisted：vi.mock 工厂被提升到文件顶部，工厂内引用的变量须用 vi.hoisted 创建。
// composite mock 带 name:'lensflare'（时间线断言用）与 enabled（继承断言用）；
// 另补 isDestroyed/destroy——removeAndDestroy v2 防御对 lf composite 调 isDestroyed()
// （真实 PostProcessStageComposite 有此成员，brief 原稿 mock 缺，对齐最小接口）。
const lensFlareMock = vi.hoisted(() =>
  vi.fn(() => ({
    lensflareComposite: {
      name: 'lensflare',
      enabled: true,
      isDestroyed: () => false,
      destroy: () => {}
    }
  }))
)

vi.mock('./lensFlare/createLensFlareStage', () => ({
  createLensFlareStage: lensFlareMock
}))

// depthTemporal historyBlit 隔离 mock（brief 缺口补丁）：node 无 WebGL，真实 Texture 构造炸
// （maximumTextureSize=0，§8.1.9 depthTemporal:true 用例必经）。主测试文件同款隔离先例；本文件
// 不测 lifecycle 细节（主文件已覆盖），最小 stub 让 createHistoryState 等不触 GL 即可。
vi.mock('./depthTemporal/historyBlit', () => ({
  createHistoryState: (_ctx: unknown, w: number, h: number, dt: number) => ({
    textures: [
      { _texture: { id: 1 }, _target: 0x0de1, destroy: vi.fn() },
      { _texture: { id: 2 }, _target: 0x0de1, destroy: vi.fn() }
    ],
    readIndex: 0,
    width: w,
    height: h,
    pixelDatatype: dt
  }),
  getHistoryBridge: (state: {
    textures: Array<{ _texture: unknown; _target: number }>
    readIndex: number
  }) => {
    const tex = state.textures[state.readIndex]
    return { _texture: tex._texture, _target: tex._target }
  },
  sanityCheckOutputTexture: (t: unknown) => t != null,
  getWriteTexture: (state: { textures: unknown[]; readIndex: number }) =>
    state.textures[1 - state.readIndex],
  swapHistory: (state: { readIndex: number }) => {
    state.readIndex = 1 - state.readIndex
  },
  buildBlitCommand: () => ({ execute: vi.fn(), framebuffer: undefined }),
  buildHistoryFBO: () => ({})
}))

import { createAtmosphereStage } from './AtmosphereStage'

// —— mock 基建（对齐主测试文件 mockSceneWithAddSpy，另有状态 remove + contains + 时间线）——
function makeScene() {
  const timeline: string[] = []
  const inCollection = new Set<unknown>()
  const addSpy = vi.fn((s: { name?: string }) => {
    timeline.push(`add:${String(s?.name ?? 'unnamed')}`)
    inCollection.add(s)
  })
  const removeSpy = vi.fn((s: { name?: string }) => {
    timeline.push(`remove:${String(s?.name ?? 'unnamed')}`)
    if (inCollection.has(s)) {
      inCollection.delete(s)
      return true
    }
    return false
  })
  const containsSpy = vi.fn((s: unknown) => inCollection.has(s))
  const scene = {
    context: {
      halfFloatingPointTexture: true,
      colorBufferHalfFloat: true,
      floatingPointTexture: false,
      colorBufferFloat: false
    },
    globe: { depthTestAgainstTerrain: false, ellipsoid: Ellipsoid.WGS84 },
    camera: { positionWC: new Cartesian3(6378137, 0, 0) },
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    preRender: { addEventListener: () => () => {} },
    postRender: { addEventListener: () => () => {} },
    postProcessStages: { add: addSpy, remove: removeSpy, contains: containsSpy }
  } as unknown as import('cesium').Scene
  return { scene, timeline: () => [...timeline], addSpy, removeSpy, containsSpy }
}

const stubLuts = {
  transmittance: {} as never,
  scattering: {} as never,
  irradiance: {} as never,
  higherOrderScattering: {} as never // M5 必需字段（brief 原稿三字段漏，主测试文件同款四字段）
}

/** 造一个假插入物 stage（带 isDestroyed/destroy/name）。 */
function makeInsertStage(name = 'clouds_overlay') {
  let destroyed = false
  const s = {
    name,
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true
    })
  }
  return s as unknown as PostProcessStage
}

describe('insertStageBeforeLensFlare（v2.1 全语义）', () => {
  beforeEach(() => {
    lensFlareMock.mockClear()
  })

  it('§8.1.1 顺序：[remove lf, remove tm, add clouds, add lf, add tm]', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    handle.insertStageBeforeLensFlare(stage)
    const t = m.timeline().slice(-5)
    expect(t[0]).toBe('remove:lensflare') // mock composite 带 name:'lensflare'
    expect(t[1]).toBe('remove:tonemap')
    expect(t[2]).toBe('add:clouds_overlay')
    expect(t[3]).toBe('add:lensflare')
    expect(t[4]).toBe('add:tonemap')
    handle.destroy()
  })

  it('§8.1.1b lensFlare=false：只重排 tonemap', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, { lensFlare: false })
    const stage = makeInsertStage()
    handle.insertStageBeforeLensFlare(stage)
    const t = m.timeline().slice(-3)
    expect(t).toEqual(['remove:tonemap', 'add:clouds_overlay', 'add:tonemap'])
    handle.destroy()
  })

  it('§8.1.2 rebuild 后 lensFlareStage 是新引用（≠ 旧）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const oldLf = handle.lensFlareStage
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(handle.lensFlareStage).toBeDefined()
    expect(handle.lensFlareStage).not.toBe(oldLf)
    handle.destroy()
  })

  it('§8.1.3 rebuild 参数一致（resolved 五参 + depthSource）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {
      lensFlareIntensity: 0.002, lensFlareThreshold: 3.5, lensFlareGhost: 0.7,
      lensFlareHalo: 0.9, lensFlarePreBlur: 1.5
    })
    lensFlareMock.mockClear()
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(lensFlareMock).toHaveBeenCalledTimes(1)
    const opts = (lensFlareMock.mock.calls[0] as unknown[])[2] as Record<string, number>
    expect(opts.intensity).toBe(0.002)
    expect(opts.thresholdLevel).toBe(3.5)
    expect(opts.ghostAmount).toBe(0.7)
    expect(opts.haloAmount).toBe(0.9)
    expect(opts.preBlurRadius).toBe(1.5)
    expect((lensFlareMock.mock.calls[0] as unknown[])[3]).toBeUndefined() // 非 temporalEma → depthSource undefined
    handle.destroy()
  })

  it('§8.1.4 tonemapStage rebuild 新实例（getter 反映）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const oldTm = handle.tonemapStage
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(handle.tonemapStage).not.toBe(oldTm)
    handle.destroy()
  })

  it('§8.1.5 同实例幂等：第二次 insert(同 stage) 集合零操作', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    handle.insertStageBeforeLensFlare(stage)
    const lenAfterFirst = m.timeline().length
    handle.insertStageBeforeLensFlare(stage) // 同实例 no-op
    expect(m.timeline().length).toBe(lenAfterFirst)
    handle.destroy()
  })

  it('§8.1.6 contains 前置：已 add 的 stage → 抛错且集合零变更', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    m.addSpy(stage) // 模拟消费者已自行 add
    const lenBefore = m.timeline().length
    expect(() => handle.insertStageBeforeLensFlare(stage)).toThrow()
    expect(m.timeline().length).toBe(lenBefore) // 零变更
    handle.destroy()
  })

  it('§8.1.7 destroyed guard：destroy 后 insert no-op+warn；destroy 幂等', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    handle.destroy()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lenBefore = m.timeline().length
    expect(() => handle.insertStageBeforeLensFlare(makeInsertStage())).not.toThrow()
    expect(m.timeline().length).toBe(lenBefore)
    expect(warnSpy).toHaveBeenCalled()
    expect(() => handle.destroy()).not.toThrow() // 幂等
    warnSpy.mockRestore()
  })

  it('§8.1.8 enabled 继承：旧 lf.enabled=false → rebuild 后仍 false', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    handle.lensFlareStage!.enabled = false // 模拟 M1 运行时关
    handle.insertStageBeforeLensFlare(makeInsertStage())
    expect(handle.lensFlareStage!.enabled).toBe(false)
    handle.destroy()
  })

  it('§8.1.9 depthTemporal 共存：dt 不动 + rebuild depthSource 指名', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, { depthTemporal: true, temporalEma: true })
    expect(handle.depthTemporalStage).toBeDefined()
    lensFlareMock.mockClear()
    handle.insertStageBeforeLensFlare(makeInsertStage())
    // dt 从未被 remove
    const t = m.timeline()
    expect(t.filter((x) => x === 'remove:czm_depth_temporal')).toHaveLength(0)
    // rebuild lf 的 depthSource 指名 dt
    expect((lensFlareMock.mock.calls[0] as unknown[])[3]).toBe('czm_depth_temporal')
    handle.destroy()
  })

  it('§8.1.10 isDestroyed 防御分支：外部摘旧后再 insert(B) 替换成功不抛', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('clouds_overlay')
    handle.insertStageBeforeLensFlare(a)
    m.removeSpy(a) // 模拟 clouds handle.destroy 摘除（a 已销毁语义由测试 destroy() 模拟——此处仅摘集合）
    ;(a as unknown as { destroy: () => void }).destroy() // 外部 destroy（真实链路 remove 即 destroy）
    const b = makeInsertStage('clouds_overlay_new')
    expect(() => handle.insertStageBeforeLensFlare(b)).not.toThrow() // 走 isDestroyed 跳过分支
    const t = m.timeline().slice(-5)
    expect(t).toContain('add:clouds_overlay_new')
    handle.destroy()
  })

  it('§8.1.10b insert(已销毁 stage) → 抛清晰错误且集合零变更', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage()
    stage.destroy()
    const lenBefore = m.timeline().length
    expect(() => handle.insertStageBeforeLensFlare(stage)).toThrow(/已销毁/)
    expect(m.timeline().length).toBe(lenBefore)
    handle.destroy()
  })

  it('§8.1.11 原子回滚：add(插入物) 抛错 → 链恢复 + insertedStage 不变 + rethrow 原始异常', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('clouds_overlay')
    handle.insertStageBeforeLensFlare(a) // 先插一个（成功）
    // 第二次 insert(b)：mock add(b) 抛错（重名场景模拟）
    const b = makeInsertStage('clouds_overlay_b')
    const origAdd = m.addSpy.getMockImplementation()
    m.addSpy.mockImplementation((s: { name?: string }) => {
      if (s === b) throw new Error('mock add 失败')
      origAdd?.(s)
    })
    expect(() => handle.insertStageBeforeLensFlare(b)).toThrow('mock add 失败') // 原始异常（非回滚异常）
    // getMockImplementation 可返 undefined，窄化后还原（brief 原稿直传 TS2345）
    if (origAdd) m.addSpy.mockImplementation(origAdd)
    // 回滚：b 被撤 + lf/tm 重建 re-add（时间线尾部：remove b … add lensflare/tonemap）
    const t = m.timeline()
    expect(t.filter((x) => x === 'remove:clouds_overlay_b').length).toBeGreaterThan(0)
    const tail = t.slice(-2)
    expect(tail).toEqual(['add:lensflare', 'add:tonemap'])
    // insertedStage 记忆不变：同实例 a 再 insert → no-op（零集合操作）
    const lenNow = m.timeline().length
    handle.insertStageBeforeLensFlare(a)
    expect(m.timeline().length).toBe(lenNow)
    handle.destroy()
  })
})
