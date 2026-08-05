# 大气渲染性能优化 Phase 0+1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立性能量化基建（timer query 逐 stage GPU 计时 + 数值化视觉门禁 + 结构化基线），并落地 Phase 1 低成本优化（tapC 早退、depthTemporal 条件禁用、5-tap 视角自适应、lensflare 子 stage 压缩），每项以 GPU ms 与视觉门禁验证收益。

**Architecture:** 基于 spec v2（`docs/superpowers/specs/2026-08-05-performance-optimization-design.md`）。Phase 0 先建测量手段（`EXT_disjoint_timer_query_webgl2` 包 `stage.execute` + ring buffer 跨帧异步读 + disjoint 丢弃 + `?profile=1`），量化各 stage GPU ms；Phase 1 按「零风险优先」落地四项优化。范围仅 Phase 0+1——Phase 2/3（LUT 降采样/合并/float32）按 spec 需 Phase 0 数据 go/no-go，不预排。

**Tech Stack:** TypeScript + Cesium PostProcessStage + WebGL2（`EXT_disjoint_timer_query_webgl2`）+ vitest + glslang（GLSL 编译验证）。

**硬约束（每项必须保持）：** test 226/226 + tsc 0 + glslang 全过；视觉门禁 4 Bug 视角 SSIM≥0.999 且 maxΔ≤2/255；`inscatterScale=25` 乘性交互——精度类改动回归被 ×25 放大。

---

## 背景（执行者必读）

- **代码库**：`packages/cesium-core`（核心库 `@cesium-geospatial/core`），`apps/demo`（验收 demo）。
- **测试**：`pnpm --filter @cesium-geospatial/core test`；单文件 `pnpm --filter @cesium-geospatial/core exec vitest run <file>`；tsc `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`。demo tsc `pnpm --filter demo exec tsc --noEmit`。
- **GLSL 编译**：`pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`（依赖 glslangValidator，改 atmosphere shader 必跑）。
- **PostProcessStage 链**（默认 lensflare 开，8 个全分辨率 pass）：`depthTemporal[0] → atmosphere[1] → lensflare[threshold/preBlur/features/up4/composite] → tonemap`。
- **atmosphere 不消费 depthTemporal**（Bug3 回退，`hdrDepthTemporal:false`）；唯一消费者是 lensflare occlusion（1/16 分辨率，`useSmoothDepth=false` 回退 scene globe depth 已存在）。
- **Bug4 修复证据**：5-tap 修的是**垂直俯视**波纹（空间高频抖可空间平滑消）；已知限制「空间 5-tap 对掠射无效（depth 时序跳非空间高频）」。

---

## Task 1: timer query 逐 stage GPU 计时基建（Phase 0.1/0.2，评审 C2/C3）

**Files:**
- Create: `packages/cesium-core/src/cesium/profile/stageGpuTimer.ts`
- Test: `packages/cesium-core/src/cesium/profile/stageGpuTimer.test.ts`
- Modify: `packages/cesium-core/src/index.ts`（导出新模块）

封装 `EXT_disjoint_timer_query_webgl2`：包装 `PostProcessStage.prototype.execute` 包 query，ring buffer 跨 ≥2 帧异步读结果，disjoint 整帧丢弃，扩展缺失时 `supported=false`（fallback 由上层 toggle-diff）。纯类封装，可在 node 用假 gl 单测（不依赖 Cesium）。

- [ ] **Step 1: 写失败测试**

`stageGpuTimer.test.ts`：

```ts
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
      // endQuery 后跨帧才 available；测试用 resolveQuery 手动置位
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
  // 测试辅助：把最近一个 query 标记为 available + 结果
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
    // 未 available → null（不读 QUERY_RESULT，防 stall）
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/profile/stageGpuTimer.test.ts`
Expected: FAIL（`StageGpuTimer is not defined` / 模块不存在）

- [ ] **Step 3: 实现 StageGpuTimer**

`stageGpuTimer.ts`：

```ts
// 逐 stage GPU 计时（EXT_disjoint_timer_query_webgl2）。
// 评审 C2：包 stage.execute 包 begin/endQuery(TIME_ELAPSED_EXT)；ring buffer 跨 ≥2 帧异步读
// （立即 getQueryParameter 会 stall pipeline）；每帧先查 GPU_DISJOINT_EXT 置位则整帧丢弃；
// 扩展缺失 supported=false（fallback 由上层 toggle-diff）。
// 评审 C3：timer query 直读 ms 不受 vsync 影响（主手段），FPS 差值仅解锁后交叉验证。

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
  createQuery(): unknown
  deleteQuery(q: unknown): void
  beginQuery(target: number, q: unknown): void
  endQuery(target: number, q: unknown): void
  getQueryParameter(q: unknown, pname: number): unknown
}

const QUERY_RESULT_EXT = 0x8866
const QUERY_RESULT_AVAILABLE_EXT = 0x8867

interface PendingQuery {
  query: unknown
  framesAgo: number
}

export class StageGpuTimer {
  readonly supported: boolean
  private ext: TimerQueryExt | null
  private gl: WebGL2RenderingContext
  // 每 stage 名 → 待读 query 队列（ring buffer，跨帧异步）
  private pending = new Map<string, PendingQuery[]>()
  private results = new Map<string, number>()

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.ext = (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null) ?? null
    this.supported = this.ext != null
  }

  /** 每帧开始调用：所有 pending 的 framesAgo+1（跨帧计数）。 */
  tickFrame(): void {
    if (!this.ext) return
    for (const list of this.pending.values()) {
      for (const p of list) p.framesAgo++
    }
  }

  begin(name: string): void {
    if (!this.ext) return
    // TIME_ELAPSED 不可嵌套：同名已有未 end 的 query 时跳过（防嵌套）
    const list = this.pending.get(name) ?? []
    const q = this.ext.createQuery()
    list.push({ query: q, framesAgo: 0 })
    this.pending.set(name, list)
    this.ext.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
  }

  end(name: string): void {
    if (!this.ext) return
    this.ext.endQuery(this.ext.TIME_ELAPSED_EXT, null)
  }

  /** 包装一个可执行函数为 begin→fn→end。 */
  wrap<T extends unknown[]>(name: string, fn: (...args: T) => void): (...args: T) => void {
    return (...args: T) => {
      this.begin(name)
      fn(...args)
      this.end(name)
    }
  }

  /**
   * 跨 ≥2 帧后轮询 available，读出 ms（ns→ms）；disjoint 置位或未就绪返回 null。
   * 只读 available 位后再读 result（不 stall pipeline）。
   */
  read(name: string): number | null {
    if (!this.ext) return null
    if (this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      // disjoint 整帧丢弃：清空该 stage pending
      const list = this.pending.get(name)
      if (list) {
        for (const p of list) this.ext.deleteQuery(p.query)
        this.pending.delete(name)
      }
      return null
    }
    const list = this.pending.get(name)
    if (!list) return this.results.get(name) ?? null
    // 跨 ≥2 帧的 query 才轮询
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]
      if (p.framesAgo < 2) continue
      if (this.ext.getQueryParameter(p.query, QUERY_RESULT_AVAILABLE_EXT)) {
        const ns = this.ext.getQueryParameter(p.query, QUERY_RESULT_EXT) as number
        this.results.set(name, ns / 1e6)
        this.ext.deleteQuery(p.query)
        list.splice(i, 1)
      }
    }
    if (list.length === 0) this.pending.delete(name)
    return this.results.get(name) ?? null
  }

  /** 所有已读出 stage 的 ms 快照。 */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.results)
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 导出**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/profile/stageGpuTimer.test.ts`
Expected: PASS（4/4）

`src/index.ts` 加导出：

```ts
export { StageGpuTimer } from './cesium/profile/stageGpuTimer'
```

- [ ] **Step 5: tsc + 全量测试**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter @cesium-geospatial/core test`
Expected: tsc 0；test 全过（226+4）

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/profile/stageGpuTimer.ts packages/cesium-core/src/cesium/profile/stageGpuTimer.test.ts packages/cesium-core/src/index.ts
git commit -m "feat(core): StageGpuTimer——EXT_disjoint_timer_query 逐 stage GPU 计时（Phase 0 基建）

- 包 stage.execute 包 query + ring buffer 跨≥2帧异步读 + disjoint 整帧丢弃
- 扩展缺失 supported=false（fallback toggle-diff）；评审 C2/C3"
```

---

## Task 2: demo `?profile=1` 接线 + blit 计时（Phase 0.1，评审 M2/M7）

**Files:**
- Modify: `apps/demo/src/main.ts`（profile 模式，包各 stage execute + blit）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`（handle 暴露 postRender blit 包装点）

demo 侧用 `StageGpuTimer` 包装 activeStages 的 execute + depthTemporal postRender blit，`?profile=1` 时每 60 帧 console 输出逐 stage ms JSON。评审 M2：lensflare 取外层 composite（TIME_ELAPSED 不可嵌套，同帧一层粒度）；评审 M7：blit 单独包 query 归入 depthTemporal。

**说明**：接线是 demo 侧运行时胶水，无可单测纯逻辑（依赖真实 GL 渲染循环），验收靠 demo `?profile=1` console 输出 + tsc。StageGpuTimer 核心已在 Task 1 单测覆盖。

- [ ] **Step 1: AtmosphereStage handle 暴露 blit 包装钩子**

`AtmosphereStage.ts` 在 depthTemporal postRender listener 内，blit 执行处包一层可被外部注入的计时回调。读 `AtmosphereStage.ts` 当前 postRender blit 段（L482-492 附近），把 `blitCmd.execute(...)` 改为经一个可选 hook：

```ts
// AtmosphereStage 内部（state 或闭包）：
let blitTimerHook: ((fn: () => void) => void) | undefined
// postRender blit 处：
const doBlit = () => blitCmd.execute(context)  // 原调用
if (blitTimerHook) blitTimerHook(doBlit) else doBlit()
```

handle 暴露 setter：

```ts
// AtmosphereStageHandle 增加：
setBlitTimerHook(hook: ((fn: () => void) => void) | undefined): void
```

- [ ] **Step 2: demo `?profile=1` 接线**

`apps/demo/src/main.ts`，在 `createAtmosphereStage` 返回 handle 后：

```ts
import { StageGpuTimer } from '@cesium-geospatial/core'

// 在 createAtmosphereStage(scene, luts, options) 之后：
if (getString('profile') === '1') {
  const gl = (scene as unknown as { context: { _gl: WebGL2RenderingContext } }).context._gl
  const timer = new StageGpuTimer(gl)
  if (!timer.supported) {
    console.warn('[profile] EXT_disjoint_timer_query_webgl2 不可用，fallback toggle-diff（需 --disable-gpu-vsync）')
  }
  // 包 activeStages 各 execute（lensflare 取外层 composite；TIME_ELAPSED 不可嵌套，同帧一层粒度）
  const stages = scene.postProcessStages
  const origExecute = new Map<unknown, unknown>()
  for (let i = 0; i < stages.length; i++) {
    const st = stages.get(i) as unknown as { name?: string; execute: (...a: unknown[]) => void }
    const name = st.name ?? `stage${i}`
    const orig = st.execute.bind(st)
    origExecute.set(st, orig)
    st.execute = timer.wrap(name, orig as (...a: unknown[]) => void) as typeof st.execute
  }
  // blit 计时归入 depthTemporal（评审 M7：blit 在 stage.execute 之外）
  atmosphereHandle.setBlitTimerHook(fn => { timer.begin('depthTemporal_blit'); fn(); timer.end('depthTemporal_blit') })
  // 每帧 tick + 每 60 帧输出 JSON
  scene.preRender.addEventListener(() => timer.tickFrame())
  let frame = 0
  scene.postRender.addEventListener(() => {
    frame++
    if (frame % 60 === 0) {
      const snap: Record<string, number | null> = {}
      for (const st of origExecute.keys()) {
        const name = (st as { name?: string }).name ?? 'stage'
        snap[name] = timer.read(name)
      }
      snap['depthTemporal_blit'] = timer.read('depthTemporal_blit')
      console.log('[profile]', JSON.stringify(snap))
    }
  })
}
```

注意：`createAtmosphereStage` 返回值需赋给变量 `atmosphereHandle`（main.ts 当前未接住返回值，改 `const atmosphereHandle = createAtmosphereStage(...)`）。

- [ ] **Step 3: tsc（core + demo）**

Run: `pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter demo exec tsc --noEmit`
Expected: 0 error

- [ ] **Step 4: demo 验收（人工）**

`pnpm dev` 起 demo，URL `?mode=atmosphere&profile=1`，打开 console：每 60 帧打印 `[profile] {"czm_depth_temporal":.., "stage1"/atmosphere:.., "lensflare":.., "depthTemporal_blit":..}`。等 `tilesLoaded` 后静置 2s，记录各 stage ms 中位数。**若 timer.supported=false，用 `--disable-gpu-vsync --disable-frame-rate-limit` 解锁 + `?lensflare=0`/`?atmo=0` toggle-diff 交叉验证**。

- [ ] **Step 5: Commit**

```bash
git add apps/demo/src/main.ts packages/cesium-core/src/cesium/AtmosphereStage.ts
git commit -m "feat(demo): ?profile=1 逐 stage GPU 计时接线 + depthTemporal blit 计时（Phase 0.1）"
```

---

## Task 3: 结构化基线表 + 视觉数值门禁脚本（Phase 0.4/0.5，评审 M5）

**Files:**
- Create: `scripts/perf/baseline.md`（结构化基线表模板）
- Create: `scripts/perf/capture.ts`（headless 截图 + SSIM/maxΔ 对比，Playwright）
- Modify: `docs/superpowers/specs/2026-08-05-performance-optimization-design.md`（基线节回填数据）

评审 M5：4 Bug 视角固定 camera URL 截图 + PSNR/SSIM + maxΔ 阈值门禁。评审 0.4：结构化基线表（分辨率/DPR/GPU/浏览器/工具/vsync）。

- [ ] **Step 1: 写 4 Bug 视角清单 + 基线表模板**

`scripts/perf/baseline.md`：

```markdown
# 性能优化基线（Phase 0）

> 测量前提：demo 连续渲染（未开 requestRenderMode）；等 scene.globe.tilesLoaded===true 后静置 ≥2s 预热；
> 每场景每配置 ≥5 次取中位数；about:gpu 固定 GPU；记录 GPU 型号 + Chrome/ANGLE 版本 + 分辨率/DPR + 是否解锁 vsync。

## 环境

| 项 | 值 |
|---|---|
| GPU 型号 | （填，about:gpu） |
| Chrome/ANGLE 版本 | （填） |
| 窗口分辨率 + DPR | （填） |
| 计时工具 | timer query / toggle-diff |
| 是否解锁 vsync | （是/否） |

## 场景（4 个复现视角 + 2 极端分离变量）

| 场景 | camera URL | 目的 |
|---|---|---|
| camera 低近地 | ?mode=atmosphere&camera=139.2399,34.8752,5000,8.7,-21.1 | fore inscatter 密集 |
| camera 高掠射 | ?mode=atmosphere&camera=139.2399,34.8752,64309,8.7,-21.1 | LUT 采样多 + 天空占比 |
| 纯天空 | 同机位 pitch 朝天 | sky 基线 + 无效 5-tap |
| 纯 nadir | 低空垂直俯视 | 全屏 5-tap + fore mask=1 |
| Bug4 垂直俯视山体 | （Bug4 复现视角 camera URL） | 波纹门禁 |
| Bug5 圆圈阶梯 | （Bug5 复现视角） | 圆圈门禁 |
| Bug6 地平线描边 | （Bug6 复现视角） | 描边门禁 |

## GPU 时间基线（timer query，各 stage ms，≥5 次中位数）

| 场景 | depthTemporal | depthTemporal_blit | atmosphere | lensflare(外层) | tonemap | 总帧 ms | FPS |
|---|---|---|---|---|---|---|---|
| camera 低 | | | | | | | |
| camera 高掠射 | | | | | | | |
| 纯天空 | | | | | | | |
| 纯 nadir | | | | | | | |

## 视觉基线（参考截图 + 门禁阈值）

- 参考截图：main 基线 4 Bug 视角（存 scripts/perf/ref/）。
- 门禁：SSIM≥0.999 且 maxΔ≤2/255，超过即回退。
```

- [ ] **Step 2: 写 headless 截图 + SSIM/maxΔ 对比脚本**

`scripts/perf/capture.ts`（用 Playwright 截 demo 固定视角，与 ref 对比）。含 `compareImages(refPath, newPath)`：逐像素算 maxΔ + 简化 SSIM。先写可运行骨架（Playwright `page.goto(url)` 等 tilesLoaded 后 `page.screenshot`），SSIM 用现成库或简化实现。**安装依赖**：`pnpm add -D -w playwright pngjs`（根 package.json）。

```ts
// capture.ts 核心（完整实现含 CLI 参数：--url 列表 --ref-dir --out-dir --check）
// 1. goto demo URL（?mode=atmosphere&camera=...&fps=0），waitFor tilesLoaded + 2s
// 2. screenshot → out-dir/<name>.png
// 3. --check 模式：与 ref-dir/<name>.png 对比，输出 SSIM + maxΔ，超阈值 exit 1
```

- [ ] **Step 3: 跑基线采集 + 回填 spec 基线节**

`pnpm dev` 起 demo + 跑 `?profile=1` 采集各场景 stage ms（≥5 次中位数），截图存 `scripts/perf/ref/`，数据回填 `baseline.md` 与 spec 基线节。**记录：depthTemporal pass+blit ms（证成/证伪 M1）、lensflare 外层 ms（证成 M2）、纯天空 atmosphere ms（证成 tapC 早退收益）**。

- [ ] **Step 4: Commit**

```bash
git add scripts/perf/ docs/superpowers/specs/2026-08-05-performance-optimization-design.md
git commit -m "feat(perf): 结构化基线表 + 4 Bug 视角视觉门禁脚本（Phase 0.4/0.5）

- baseline.md 模板（环境/场景/GPU 时间表/视觉门禁）
- capture.ts headless 截图 + SSIM/maxΔ 对比
- 基线数据回填 spec"
```

---

## Task 4: 5-tap tapC 早退（Phase 1.0，评审遗漏 1，零视觉风险，排最前）

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts:344-357`
- Test: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`
- Compile: `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts`

5-tap 全屏无条件执行，`tapC>=1.0`（天空/未渲染像素）时 4 次邻域 fetch 对输出零影响（logDepth/sceneDist/mask 仅在 `hasSceneDepth<1.0` 内消费，hasSceneDepth 只由 tapC 反演）。`if (tapC<1.0)` 包住另 4 tap 即省天空区 80% depth 采样，**不动任何 ground 像素数值**。

- [ ] **Step 1: 写失败测试（shader 结构断言）**

`aerialPerspective.frag.test.ts` 加用例：非 EMA 分支（UNSIGNED_BYTE）下 4 邻域 tap 被 `tapC < 1.0` 包裹（早退）。

```ts
it('tapC 早退：tapC>=1.0 时跳过 4 邻域 depth fetch（天空区零开销，Phase 1.0）', () => {
  const src = buildAerialPerspectiveFragmentShader({ ...defaults, hdrDepthTemporal: false })
  // 4 邻域 tap 在 if (tapC < 1.0) 块内（早退）
  expect(src).toMatch(/if \(tapC < 1\.0\)[\s\S]*tapR[\s\S]*tapL[\s\S]*tapU[\s\S]*tapD/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts -t "tapC 早退"`
Expected: FAIL（当前 4 邻域 tap 在块外无条件执行）

- [ ] **Step 3: 实现 tapC 早退**

`aerialPerspective.frag.ts` L344-357 改为：

```glsl
  vec2 depthTexel = 1.0 / vec2(textureSize(depthTexture, 0));
  float tapC = texture(depthTexture, v_textureCoordinates).r;  // 中心 tap：hasScene 判定用（Bug6）
  float logDepth = 1.0;  // 默认 far-plane（tapC>=1.0 时跳过 4 邻域，省天空区 80% depth 采样，Phase 1.0）
  if (tapC < 1.0) {  // tapC 早退：仅地面像素才 5-tap 平均（天空/未渲染 4 邻域 fetch 对输出零影响）
    float tapR = texture(depthTexture, v_textureCoordinates + vec2(depthTexel.x, 0.0)).r;
    float tapL = texture(depthTexture, v_textureCoordinates - vec2(depthTexel.x, 0.0)).r;
    float tapU = texture(depthTexture, v_textureCoordinates + vec2(0.0, depthTexel.y)).r;
    float tapD = texture(depthTexture, v_textureCoordinates - vec2(0.0, depthTexel.y)).r;
    float tapSum = tapC;  // tapC<1.0 必计入
    float tapCount = 1.0;
    if (tapR < 1.0) { tapSum += tapR; tapCount += 1.0; }
    if (tapL < 1.0) { tapSum += tapL; tapCount += 1.0; }
    if (tapU < 1.0) { tapSum += tapU; tapCount += 1.0; }
    if (tapD < 1.0) { tapSum += tapD; tapCount += 1.0; }
    logDepth = tapSum / tapCount;
  }
```

注意：`#else` 分支内原 `float logDepth = tapCount > 0.5 ? ... : 1.0;` 删除（移入 if）；`tapC` 提到 if 外（hasScene 用，Bug6 不变）。

- [ ] **Step 4: 跑测试 + glslang 编译 + tsc**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts && pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts && pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: frag test 全过；compile 全宏组合过；tsc 0

- [ ] **Step 5: demo 视觉门禁 + 性能验证**

跑 Task 3 capture `--check` 对比 4 Bug 视角（SSIM≥0.999 且 maxΔ≤2/255）；`?profile=1` 纯天空场景 atmosphere ms 应降（天空区 4 邻域 fetch 省掉）。**视觉回归重点：Bug4 垂直俯视波纹不回归（tapC<1.0 地面像素 5-tap 平均不变）**。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/aerialPerspective.frag.ts packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts
git commit -m "perf(core): 5-tap tapC 早退——tapC>=1.0 跳过 4 邻域 depth fetch（Phase 1.0）

- 天空/未渲染像素省 80% depth 采样，ground 像素数值不变（Bug4 5-tap 仅 tapC<1.0 有意义）
- 评审遗漏 1：零视觉风险，排 Phase 1 最前"
```

---

## Task 5: depthTemporal 条件禁用（`?depthTemporal=0`）（Phase 1.1，评审 M7）

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts:373`（stageCreated 条件）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`（options + validate）
- Modify: `apps/demo/src/main.ts`（`?depthTemporal=0` URL 参数）
- Test: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts:378-419`（装配断言）

加 `depthTemporal` option（默认 true 保现状）。`?depthTemporal=0` → 不创建 stage + 不注册 postRender blit listener。atmosphere 不消费 `.a`（`hdrDepthTemporal:false`）、occlusion 回退路径已存在（`temporalEmaEnabled=false` → scene globe depth），跳过安全。**Phase 0 计时载体 + Phase 1.1 优化载体，一次改动两处用。**

- [ ] **Step 1: 写失败测试**

`AtmosphereStage.test.ts` 在「depthTemporal 装配」describe 加用例：

```ts
it('depthTemporal=false → 不创建 stage + 不注册 blit listener（Phase 1.1，?depthTemporal=0）', () => {
  const { scene, addSpy } = mockSceneWithAddSpy({ halfFloat: true })
  const handle = createAtmosphereStage(scene, stubLuts, { lensFlare: false, depthTemporal: false })
  expect(handle.depthTemporalStage).toBeUndefined()
  expect(handle.temporalEmaEnabled).toBe(false)
  const added = addSpy.mock.calls.map((c: unknown[]) => c[0])
  expect(added.some((s) => (s as { name?: string })?.name?.match?.(/depth_temporal/i))).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts -t "depthTemporal=false"`
Expected: FAIL（`depthTemporal` option 不存在 / TS error）

- [ ] **Step 3: 实现 depthTemporal option + 条件创建**

`AtmosphereStage.ts`：
1. `AtmosphereStageOptions` 加 `depthTemporal?: boolean`（默认 true）；`validateAtmosphereOptions` resolve 默认 true；`ResolvedAtmosphereStageOptions` 同步。
2. L373 `stageCreated` 改：

```ts
const stageCreated = postHdrDatatype !== PixelDatatype.UNSIGNED_BYTE && resolved.depthTemporal
```

3. `temporalEmaEnabled = stageCreated && resolved.temporalEma` 不变（从 stageCreated 派生，自动跟随）。`if (stageCreated)` 块内 stage 创建 + lifecycle listener 注册自然跳过。

`apps/demo/src/main.ts` options 加：

```ts
depthTemporal: getString('depthTemporal') !== '0',
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts && pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter demo exec tsc --noEmit`
Expected: 全过；tsc 0（core + demo）

- [ ] **Step 5: 更新默认值断言 + 验证默认值不变**

`validateAtmosphereOptions` 默认值测试（L167-192）断言对象加 `depthTemporal: true`（新默认值）。确认默认 `depthTemporal:true` 时行为与现状完全一致（stage 创建、temporalEmaEnabled 跟随 HDR）。

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts`
Expected: 全过（含更新的默认值断言）

- [ ] **Step 6: demo 验收（性能 + 视觉）**

`?mode=atmosphere&depthTemporal=0&profile=1`：depthTemporal stage + blit ms 消失（对照 Task 3 基线），省 1 全屏 pass + 1 全屏 copy + 3 张全分辨率 HF RT。视觉：lensflare occlusion 回退 scene globe depth（`?lensflare=1` 保持开）——对比 `?depthTemporal=1` occlusion 边缘是否闪烁（评审 M1 风险点），若无闪烁则 Phase 1.1 后续可考虑默认移除。

- [ ] **Step 7: Commit**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts apps/demo/src/main.ts
git commit -m "perf(core): depthTemporal 条件禁用（?depthTemporal=0，Phase 1.1）

- depthTemporal option（默认 true）；false 时不创建 stage + 不注册 blit listener
- atmosphere 不消费 .a + occlusion 回退 scene depth（已有），跳过安全
- Phase 0 计时载体 + Phase 1.1 优化载体（评审 M7）"
```

---

## Task 6: 5-tap 视角自适应（muLook 门控，垂直保留/掠射降）（Phase 1.2，评审 C1/M3）

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`（5-tap 段 + muLook 门控）
- Test: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`
- Compile: `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts`

**方向（评审 C1，旧 spec 写反）**：垂直/近垂直俯视（|muLook| 大）**保留** 5-tap，掠射（|muLook| 小）**降** tap（掠射 5-tap 已知无效，降 tap 无回归风险）。**门控用 muLook**（L400 已有平滑视线几何量，不读 depth、无循环依赖），smoothstep 连续过渡，禁 3-tap 十字（对称结构）。

**前置依赖**：本项改动 GLSL 控制流（按 muLook 分支 tap 数），需在 Task 4 tapC 早退之上叠加，且需 `muLook` 在 5-tap 段之前可用——当前 muLook 在 L400（5-tap 段 L344 之后）计算，需把 muLook/radialOut 计算前移。

- [ ] **Step 1: 写失败测试**

`aerialPerspective.frag.test.ts` 加用例：非 EMA 分支含 muLook 门控的 tap 数自适应（掠射降 tap）。

```ts
it('5-tap 视角自适应：muLook 门控，垂直保留 5-tap/掠射降 tap（Phase 1.2）', () => {
  const src = buildAerialPerspectiveFragmentShader({ ...defaults, hdrDepthTemporal: false })
  // muLook 门控（smoothstep 连续过渡，非 mask/sceneDist——无循环依赖）
  expect(src).toMatch(/smoothstep\([^)]*abs\(muLook\)/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts -t "视角自适应"`
Expected: FAIL（无 muLook 门控）

- [ ] **Step 3: 实现 muLook 门控自适应**

`aerialPerspective.frag.ts`：
1. **前移 muLook/radialOut 计算**到 5-tap 段之前（L344 前）：

```glsl
  // 视线几何量前移到 depth 采样前（Phase 1.2 muLook 门控需先知道视角）
  vec3 radialOut = normalize(cameraPosition);
  // rayDirection 由 reconstructRay 得（已在 depth 段前）
```

注意：`cameraPosition`/`rayDirection` 当前在 L365-367（depth 段后）计算，需一并前移到 5-tap 段之前；删除原 L365-367/L399-400 的重复计算。

2. 5-tap 段（Task 4 早退版之上）加 muLook 门控：掠射（|muLook| 小）退到中心 tap（不取 4 邻域），垂直（|muLook| 大）保留 5-tap：

```glsl
  float tapC = texture(depthTexture, v_textureCoordinates).r;
  float logDepth = 1.0;
  // Phase 1.2：垂直俯视（|muLook|→1）保留 5-tap（Bug4 有效场景）；掠射（|muLook|→0）降 tap
  // （5-tap 对掠射无效=depth 时序跳非空间高频，results:50）。muLook 门控（平滑、不读 depth、无循环依赖），
  // smoothstep 连续过渡避免 tap 数硬切换分界线；掠射退到中心 tap（对称，禁 3-tap 十字防方向性条纹 ×25）。
  float useSpatial = smoothstep(0.3, 0.6, abs(muLook));
  if (tapC < 1.0) {
    if (useSpatial > 0.5) {
      float tapR/tapL/tapU/tapD = ...4 邻域...;
      float tapSum = tapC; float tapCount = 1.0;
      if (tapR < 1.0) { tapSum += tapR; tapCount += 1.0; }
      ... tapL/tapU/tapD 同上 ...
      logDepth = tapSum / tapCount;
    } else {
      logDepth = tapC;  // 掠射：中心 tap（5-tap 无效，省 4 fetch）
    }
  }
```

`useSpatial` 也可连续加权（`logDepth = mix(tapC, spatialAvg, useSpatial)`），但 mix 仍算 4 邻域（不省 fetch）——用 `useSpatial>0.5` 硬分支省 fetch，smoothstep 过渡带内分支判定连续（|muLook| 空间平滑，相邻像素不会逐像素翻转）。**验证 debug=5 Bug4 视角无分界线**。

- [ ] **Step 4: 跑测试 + glslang + tsc**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts && pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts && pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: 全过；compile 全宏组合过；tsc 0

- [ ] **Step 5: demo 视觉门禁（重点 Bug4 不回归 + 掠射无分界线）**

1. **Bug4 垂直俯视**：`debug=5` Bug4 复现视角，波纹幅值对比 main 基线不回归（垂直 |muLook| 大仍 5-tap）。
2. **掠射**：高空掠射转动相机，无新分界线/条纹（muLook smoothstep 过渡连续）。
3. capture `--check` 4 Bug 视角 SSIM≥0.999 且 maxΔ≤2/255。
4. `?profile=1` 掠射/纯天空场景 atmosphere ms 降（掠射 + 天空区省 fetch）。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/aerialPerspective.frag.ts packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts
git commit -m "perf(core): 5-tap 视角自适应——muLook 门控垂直保留/掠射降 tap（Phase 1.2）

- 方向反转（评审 C1）：垂直才需 5-tap（Bug4 有效），掠射 5-tap 无效降 tap
- muLook 门控（评审 M3：无循环依赖）+ smoothstep 连续过渡 + 对称结构（禁 3-tap 十字）
- muLook/radialOut/cameraPosition/rayDirection 计算前移到 depth 采样前"
```

---

## Task 7: lensflare 子 stage 压缩（up4 并入 composite + threshold 降 0.5）（Phase 1.3，评审 M2，零物理风险）

**Files:**
- Modify: `packages/cesium-core/src/cesium/lensFlare/createLensFlareStage.ts:280-294`（composite 引用 up3 替代 up4）
- Modify: `packages/cesium-core/src/cesium/lensFlare/createLensFlareStage.ts:161-172`（threshold textureScale 1.0→0.5）
- Test: `packages/cesium-core/src/cesium/lensFlare/createLensFlareStage.test.ts`

评审 M2：lensflare 5 个全分辨率 pass 占默认链 62.5%，零物理风险压缩（不碰 LUT/depth/half-float）。
- **up4 并入 composite**：composite 改引 `lf_up3`@0.5 + LINEAR 采样，省 1 全屏 pass。
- **threshold 降 0.5**：唯一消费者 down0@0.5 与 preBlur，对 bloom 质量几乎无损，省半张全屏 HF 写。

**前置确认**：up4（`UPSAMPLE_SCALES=[0.0625,0.125,0.25,0.5,1.0]` 末级 1.0）是全分辨率上采样；composite 当前 `u_bloomTexture:'lf_up4'`。并入需 composite 直接采样 up3（0.5 分辨率）+ 采样改 LINEAR（上采样插值），并移除 up4 stage（或 textureScale 0.5 的 up 链末级即为最终 bloom）。

- [ ] **Step 1: 读 up/down 链结构确认并入方案**

读 `createLensFlareStage.ts` L95-214（up/down 链 + bloom composite）确认：up4 是否仅上采样无其他计算、composite 采样 up4 的 sampleMode、移除 up4 后 bloom 链输出指向。若 up4 有独立计算（非纯上采样），则降级为「threshold 降 0.5」单项，up4 并入标记 Phase 2 评估。

- [ ] **Step 2: 写失败测试**

`createLensFlareStage.test.ts` 加用例：

```ts
it('threshold textureScale 0.5（Phase 1.3 降带宽，唯一消费者 down0@0.5+preBlur 质量几乎无损）', () => {
  // threshold stage textureScale === 0.5
})
it('composite 采样 up3（up4 并入，省 1 全屏 pass）+ LINEAR', () => {
  // composite u_bloomTexture === 'lf_up3'，且 lf_up4 不在 stages
})
```

- [ ] **Step 3: 实现**

按 Step 1 确认结果改 createLensFlareStage.ts：
- `UPSAMPLE_SCALES` 末级移除 1.0（变 `[0.0625,0.125,0.25,0.5]`），up 链末级为 up3@0.5；composite `u_bloomTexture:'lf_up3'` + sampleMode LINEAR。
- threshold `textureScale: 1.0 → 0.5`。

- [ ] **Step 4: 跑测试 + glslang（lensflare compile）+ tsc**

Run: `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/lensFlare && pnpm --filter @cesium-geospatial/core exec tsc --noEmit`
Expected: 全过；tsc 0

- [ ] **Step 5: demo 视觉门禁（lensflare 质量）**

`?mode=atmosphere&lensflare=1` 对日盘视角：bloom/ghost/halo 视觉对比 main 基线（threshold 降 0.5 对 bloom 几乎无损；up4 并入 LINEAR 上采样质量）。capture `--check` SSIM/maxΔ 门禁。`?profile=1` lensflare 外层 ms 降（省 1 全屏 pass + threshold 半带宽）。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-core/src/cesium/lensFlare/createLensFlareStage.ts packages/cesium-core/src/cesium/lensFlare/createLensFlareStage.test.ts
git commit -m "perf(core): lensflare 子 stage 压缩——up4 并入 composite + threshold 降 0.5（Phase 1.3）

- composite 采样 up3@0.5 + LINEAR，省 1 全屏 HalfFloat pass
- threshold textureScale 0.5（消费者 down0@0.5+preBlur，bloom 质量几乎无损）
- 评审 M2：零物理风险（不碰 LUT/depth/half-float 精度）"
```

---

## Task 8: Phase 1 结果回填 + 验收（results 文档 + 基线对比）

**Files:**
- Create: `docs/superpowers/plans/2026-08-05-performance-optimization-results.md`
- Modify: `scripts/perf/baseline.md`（Phase 1 后对比行）

- [ ] **Step 1: 跑全量验证**

Run: `pnpm --filter @cesium-geospatial/core test && pnpm --filter @cesium-geospatial/core exec tsc --noEmit && pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`
Expected: 226+ test 全过；tsc 0；glslang 全过

- [ ] **Step 2: 性能对比（Phase 0 基线 vs Phase 1 后）**

`?profile=1` 4 场景（camera 低/高掠射/纯天空/纯 nadir）采集 Phase 1 后各 stage ms（≥5 次中位数），与 Task 3 基线对比，回填 `baseline.md` 对比行。**验证 atmosphere 链总 GPU 时间降 ≥20%（验收目标）**。

- [ ] **Step 3: 视觉门禁全量**

capture `--check` 4 Bug 视角（Phase 1 全量改动后）SSIM≥0.999 且 maxΔ≤2/255。

- [ ] **Step 4: 写 results 文档**

`2026-08-05-performance-optimization-results.md`：Phase 0 基线数据 + Phase 1 各项收益（GPU ms 对比）+ 视觉门禁结果 + Phase 2/3 go/no-go 决策（哪些项 Phase 0 数据支持，如 lensflare 占比、depthTemporal 占比、atmosphere 5-tap 占比）。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-05-performance-optimization-results.md scripts/perf/baseline.md
git commit -m "docs(perf): Phase 0+1 results——基线数据 + 收益对比 + Phase 2/3 go/no-go"
```

---

## Self-Review 结论

- **Spec 覆盖**：Phase 0（0.1 计时/Task1-2、0.2 vsync/Task2、0.3 场景/Task3+验收、0.4 基线表/Task3、0.5 视觉门禁/Task3）+ Phase 1（1.0 tapC/Task4、1.1 depthTemporal/Task5、1.2 自适应/Task6、1.3 lensflare/Task7）全覆盖。Phase 2/3 按 spec 需 Phase 0 数据 go/no-go，不在本 plan（Task 8 results 出决策）。
- **无占位符**：所有代码步骤含完整代码；Task 2 demo 接线、Task 3 capture 脚本为运行时胶水，标注验收方式（demo console/capture --check），核心逻辑（StageGpuTimer/shader 断言/option）均 TDD。
- **类型一致**：`StageGpuTimer`（Task1）→ demo `?profile=1`（Task2）一致；`depthTemporal` option（Task5）→ validate 默认值断言一致；`setBlitTimerHook`（Task2）→ handle 一致。
- **顺序**：Task1-3 基建（计时+门禁）→ Task4-7 优化（零风险 tapC 早退 → depthTemporal → 自适应 → lensflare），每项以基建验证收益。Task4 在 Task6 前（Task6 叠加在 Task4 早退版上）。
