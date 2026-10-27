// insertStageBeforeLensFlare 全语义测试（v2.1 spec §5.1/§8.1 + 2026-10-27 产品化 §7.7 多槽）。
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
  // 有序集合（多槽顺序断言用）；remove 成功即 destroy——真实 Cesium PostProcessStageCollection.remove
  // 语义如此，多槽「只销毁目标」的断言才有意义。
  const inCollection: Array<{ name?: string; destroy?: () => void }> = []
  const addSpy = vi.fn((s: { name?: string }) => {
    timeline.push(`add:${String(s?.name ?? 'unnamed')}`)
    inCollection.push(s)
  })
  const removeSpy = vi.fn((s: { name?: string; destroy?: () => void }) => {
    timeline.push(`remove:${String(s?.name ?? 'unnamed')}`)
    const i = inCollection.indexOf(s)
    if (i >= 0) {
      inCollection.splice(i, 1)
      s.destroy?.()
      return true
    }
    return false
  })
  const containsSpy = vi.fn((s: unknown) => inCollection.includes(s as never))
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
  return {
    scene,
    timeline: () => [...timeline],
    // 集合当前有序内容（链顺序断言：atmosphere → 插入项（按插入顺序）→ lensflare → tonemap）
    order: () => inCollection.map((s) => String(s.name ?? 'unnamed')),
    addSpy,
    removeSpy,
    containsSpy
  }
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

  // 【2026-10-27 多槽改写】原「insert(B) 替换 A」语义已废弃（§7.7）：外部摘除并销毁的旧项
  // 在 rebuild 时被剔除且不复活，新项照常追加。
  it('§8.1.10 isDestroyed 防御分支：外部摘旧并销毁后 insert(B) 追加成功且不复活 A', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('clouds_overlay')
    handle.insertStageBeforeLensFlare(a)
    m.removeSpy(a) // 模拟 clouds handle.destroy 摘除（mock remove 即 destroy，真实 Cesium 语义）
    const b = makeInsertStage('clouds_overlay_new')
    expect(() => handle.insertStageBeforeLensFlare(b)).not.toThrow() // 走 isDestroyed 剔除分支
    const t = m.timeline().slice(-5)
    expect(t).toEqual([
      'remove:lensflare',
      'remove:tonemap',
      'add:clouds_overlay_new',
      'add:lensflare',
      'add:tonemap'
    ])
    expect(m.containsSpy(a)).toBe(false) // 已销毁旧槽不复活
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

  // 【2026-10-27 多槽改写】回滚只撤失败的新项；已插入的 A 原位保留（不摘、不销毁、不重 add）。
  it('§8.1.11 原子回滚（多槽）：add(新插入物) 抛错 → 新项被撤 + A 原位保留 + rethrow 原始异常', () => {
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
    // A 原位保留：仍在集合中、未被销毁、位置在 lf 之前
    expect(m.containsSpy(a)).toBe(true)
    expect(a.isDestroyed()).toBe(false)
    expect(m.order()).toEqual(['atmosphere', 'clouds_overlay', 'lensflare', 'tonemap'])
    // 插入记忆不变：同实例 a 再 insert → no-op（零集合操作）
    const lenNow = m.timeline().length
    handle.insertStageBeforeLensFlare(a)
    expect(m.timeline().length).toBe(lenNow)
    handle.destroy()
  })

  it('§8.1.11b 回滚自身失败：rebuild 再抛错 → 仍抛原始异常 + console.error 记回滚异常', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const b = makeInsertStage('clouds_overlay_b')
    // 主路径：add(b) 抛原始异常（同 §8.1.11）
    const origAdd = m.addSpy.getMockImplementation()
    m.addSpy.mockImplementation((s: { name?: string }) => {
      if (s === b) throw new Error('mock add 失败')
      origAdd?.(s)
    })
    // 回滚路径：rebuildLensFlare 走 lensFlareMock——本用例内 mockClear 后首次调用即回滚
    // rebuild，替换实现使其再抛错（回滚异常），验证原始异常胜出。
    const origLf = lensFlareMock.getMockImplementation()
    lensFlareMock.mockImplementation(() => {
      throw new Error('mock rebuild 失败')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 抛出的是原始异常（非回滚异常 'mock rebuild 失败'）
      expect(() => handle.insertStageBeforeLensFlare(b)).toThrow('mock add 失败')
      // 回滚失败被 console.error 记录：消息含「回滚失败」+ 第二参为回滚异常本体
      expect(errSpy).toHaveBeenCalledTimes(1)
      const errArgs = errSpy.mock.calls[0] as unknown[]
      expect(String(errArgs[0])).toContain('回滚失败')
      expect((errArgs[1] as Error).message).toBe('mock rebuild 失败')
    } finally {
      errSpy.mockRestore()
      if (origLf) lensFlareMock.mockImplementation(origLf) // 恢复默认实现（防跨用例残留）
      if (origAdd) m.addSpy.mockImplementation(origAdd)
    }
    handle.destroy()
  })

  // ── 2026-10-27 产品化 §7.7：多槽有序追加 + removeInsertedStage + 归属规则 ──

  it('连续插入两个 stage 都保留，顺序与插入顺序一致', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('plugin_a')
    const b = makeInsertStage('plugin_b')
    handle.insertStageBeforeLensFlare(a)
    handle.insertStageBeforeLensFlare(b)
    // 链：atmosphere → a → b → lensflare → tonemap（第二次插入不移动 a）
    expect(m.order()).toEqual(['atmosphere', 'plugin_a', 'plugin_b', 'lensflare', 'tonemap'])
    expect(a.isDestroyed()).toBe(false)
    expect(b.isDestroyed()).toBe(false)
    // 第二次插入只追加 b（不重 add a）
    expect(m.timeline().filter((x) => x === 'add:plugin_a')).toHaveLength(1)
    handle.destroy()
  })

  it('removeInsertedStage 只销毁目标，另一个仍在链中', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const a = makeInsertStage('plugin_a')
    const b = makeInsertStage('plugin_b')
    handle.insertStageBeforeLensFlare(a)
    handle.insertStageBeforeLensFlare(b)
    handle.removeInsertedStage(b)
    expect(b.isDestroyed()).toBe(true) // 移除即销毁（Cesium remove 语义）
    expect(a.isDestroyed()).toBe(false)
    expect(m.order()).toEqual(['atmosphere', 'plugin_a', 'lensflare', 'tonemap'])
    // A 仍可用：再次插入是幂等 no-op，且不重复 add
    const lenNow = m.timeline().length
    handle.insertStageBeforeLensFlare(a)
    expect(m.timeline().length).toBe(lenNow)
    handle.destroy()
  })

  it('移除未插入的 stage 为 no-op（warn，集合与 stage 均不变）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stranger = makeInsertStage('not_inserted')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lenBefore = m.timeline().length
    expect(() => handle.removeInsertedStage(stranger)).not.toThrow()
    expect(m.timeline().length).toBe(lenBefore)
    expect(stranger.isDestroyed()).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    handle.destroy()
  })

  it('受保护的 stage 不能被 removeInsertedStage 移除', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const own = makeInsertStage('clouds_overlay')
    handle.insertStageBeforeLensFlare(own, { protectedStage: true })
    expect(() => handle.removeInsertedStage(own)).toThrow(/受保护/)
    // 拒绝时零变更：仍在链中且未销毁
    expect(own.isDestroyed()).toBe(false)
    expect(m.order()).toEqual(['atmosphere', 'clouds_overlay', 'lensflare', 'tonemap'])
    handle.destroy()
  })

  it('protectedStage 标志可在同实例重复插入时就地更新', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const stage = makeInsertStage('plugin_a')
    handle.insertStageBeforeLensFlare(stage)
    const lenAfterFirst = m.timeline().length
    handle.insertStageBeforeLensFlare(stage, { protectedStage: true }) // 幂等 + 更新标志
    expect(m.timeline().length).toBe(lenAfterFirst) // 无集合操作
    expect(m.order()).toEqual(['atmosphere', 'plugin_a', 'lensflare', 'tonemap']) // 不重复
    expect(() => handle.removeInsertedStage(stage)).toThrow(/受保护/)
    handle.destroy()
  })

  it('handle.destroy() 一并移除并销毁全部插入 stage（含受保护项）', () => {
    const m = makeScene()
    const handle = createAtmosphereStage(m.scene, stubLuts, {})
    const own = makeInsertStage('clouds_overlay')
    const other = makeInsertStage('plugin_b')
    handle.insertStageBeforeLensFlare(own, { protectedStage: true })
    handle.insertStageBeforeLensFlare(other)
    handle.destroy()
    expect(own.isDestroyed()).toBe(true)
    expect(other.isDestroyed()).toBe(true)
    expect(m.order()).toEqual([]) // 全部摘除
  })
})
