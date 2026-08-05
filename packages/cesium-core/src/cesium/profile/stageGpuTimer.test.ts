import { describe, it, expect, vi } from 'vitest'
import { StageGpuTimer } from './stageGpuTimer'

// 假 WebGL2 + EXT_disjoint_timer_query_webgl2，可控 query 结果/可用位/disjoint
function makeGl(opts: { available?: boolean; disjoint?: boolean; elapsed?: number } = {}) {
  const queries: Array<{ id: number }> = []
  let nextId = 1
  const store = new Map<number, { available: boolean; result: number }>()
  const ext = {
    TIME_ELAPSED_EXT: 0x88bf,
    GPU_DISJOINT_EXT: 0x8fbb,
    createQuery: vi.fn(() => {
      const q = { id: nextId++ }
      queries.push(q)
      store.set(q.id, { available: false, result: 0 })
      return q
    }),
    deleteQuery: vi.fn(),
    beginQuery: vi.fn(),
    endQuery: vi.fn((_target: number, q: { id: number }) => {
      store.get(q.id)!.available = false
    }),
    getQueryParameter: vi.fn((q: { id: number }, pname: number) => {
      const s = store.get(q.id)!
      return pname === 0x8867 /* QUERY_RESULT_AVAILABLE_EXT */ ? s.available : s.result
    })
  }
  const gl = {
    getExtension: vi.fn((name: string) =>
      name === 'EXT_disjoint_timer_query_webgl2' ? ext : null
    ),
    getParameter: vi.fn(() => opts.disjoint ?? false)
  }
  const resolveLast = (elapsed: number) => {
    const q = queries[queries.length - 1]
    store.get(q.id)!.available = true
    store.get(q.id)!.result = elapsed
  }
  return { gl, ext, resolveLast, queries }
}

describe('StageGpuTimer', () => {
  it('扩展缺失 → supported=false，begin/end no-op，read 返回 null', () => {
    const gl = { getExtension: () => null, getParameter: () => false }
    const t = new StageGpuTimer(gl as unknown as WebGL2RenderingContext)
    expect(t.supported).toBe(false)
    expect(() => { t.begin('atmosphere'); t.end('atmosphere') }).not.toThrow()
    expect(t.read('atmosphere')).toBeNull()
  })

  it('endQuery 跨 ≥2 帧后轮询 available 才返回 ms（立即读 null，不 stall）', () => {
    const { gl, resolveLast } = makeGl()
    const t = new StageGpuTimer(gl as unknown as WebGL2RenderingContext)
    t.begin('atmosphere'); t.end('atmosphere')
    expect(t.read('atmosphere')).toBeNull()
    resolveLast(3_500_000) // 3.5ms（ns）
    expect(t.read('atmosphere')).toBeCloseTo(3.5, 3)
  })

  it('GPU_DISJOINT 置位 → 整帧丢弃（read null）', () => {
    const { gl, resolveLast } = makeGl({ disjoint: true })
    const t = new StageGpuTimer(gl as unknown as WebGL2RenderingContext)
    t.begin('atmosphere'); t.end('atmosphere')
    resolveLast(3_500_000)
    expect(t.read('atmosphere')).toBeNull()
  })

  it('多 stage 独立计时 + wrap execute', () => {
    const { gl, resolveLast } = makeGl()
    const t = new StageGpuTimer(gl as unknown as WebGL2RenderingContext)
    const exec = vi.fn()
    const wrapped = t.wrap('atmosphere', exec)
    wrapped()
    expect(exec).toHaveBeenCalledTimes(1)
    resolveLast(2_000_000)
    expect(t.read('atmosphere')).toBeCloseTo(2.0, 3)
  })
})
