// 性能优化 Phase 0：headless 截图 + 视觉数值门禁（评审 M5，spec §0.5）。
//
// 作用：
//   1) 截图：Playwright 起 demo 固定 camera 视角，等 scene.globe.tilesLoaded + 静置后截全屏 PNG。
//   2) 门禁：--check 模式与 scripts/perf/ref/<场景>.png 逐像素对比，输出 SSIM + maxΔ，超阈值 exit 1。
//   3) 采集：--profile 追加 ?profile=1，收集 console `[profile]` 逐 stage GPU ms JSON，输出中位数。
//
// 用法（在仓库根，先 `pnpm dev` 起 demo，默认 http://localhost:5173）：
//   # 采集参考截图（写入 scripts/perf/ref/，作为 main 基线）
//   pnpm exec tsx scripts/perf/capture.ts --save-ref
//   # 优化后截图到 out/ 并过门禁（与 ref/ 对比，超阈值 exit 1）
//   pnpm exec tsx scripts/perf/capture.ts --check
//   # 只跑部分场景 / 同时采 GPU ms
//   pnpm exec tsx scripts/perf/capture.ts --only camera-low,bug4-nadir-mountain --profile
//
// 注意（视觉门禁可比性前提）：ref 与 out 必须同一渲染后端采集（同 headless 或同真实 GPU）。
// headless Chromium 默认 SwiftShader 软件渲染，数值与真实 GPU 不可比；跨后端对比无意义。
// 性能基线（GPU ms）只能在真实 GPU 浏览器采集；headless 仅用于跑通流程 + 自洽门禁。
import { chromium, type Browser, type Page } from 'playwright'
import { PNG } from 'pngjs'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 场景清单（与 scripts/perf/baseline.md 对齐；camera URL 见该表「Bug4/5/6 camera URL 说明」）----
// 公共：mode=atmosphere + inscatterScale=25（用户验收主路径）+ fps=0（关 FPS 角标，避免污染门禁像素）。
interface Scenario {
  name: string
  query: string // 不含 base 的 query 串（? 开头）
}
// 注：time+play=0 成对钉死（关键：412182e 起时间默认流动，单 time= 只钉初值仍流动——不钉死则
//     太阳方向随 wall-clock/页面加载耗时漂移，ref/out 跨会话永不匹配；2026-08-04T01:00:00Z 在
//     139E/34N（日本）为上午日景，避免夜间过暗门禁无判别力）。clouds=0：本门禁目标是
//     atmosphere stage，headless SwiftShader 云渲染崩坏不可信（memory clouds-resolve-motion-
//     artifacts），云不进门禁（云回归由 verify-clouds-distribution.mjs / bake-readback.mjs 守）。
// 2026-09-04 基线重录（ref 原录于 2026-08-06，与渲染现状差一个月演化固定差）：去钉
// inscatterScale=25（2026-09-02 定稿默认 8，旧钉测的是已废弃路径）与
// groundLighting=0&groundDim=0.5（2026-09-01 乘子上线时的过渡桥——定稿主路径=乘子默认开+
// groundDim 0.43 缺省）。基线测当前默认主路径；缺省再变时按同工序重录即可。
const COMMON = 'mode=atmosphere&fps=0&time=2026-08-04T01:00:00Z&play=0&clouds=0'
const SCENARIOS: Scenario[] = [
  // 4 个复现/混合视角（spec §0.3/§0.5）
  { name: 'camera-low', query: `${COMMON}&camera=139.2399,34.8752,5000,8.7,-21.1` },
  { name: 'camera-high-graze', query: `${COMMON}&camera=139.2399,34.8752,64309,8.7,-21.1` },
  // Bug4/5/6 门禁视角（派生自相邻复现机位，见 baseline.md）
  { name: 'bug4-nadir-mountain', query: `${COMMON}&camera=95.7229,31.5070,11645,295.8,-90` },
  { name: 'bug5-circle', query: `${COMMON}&camera=93.4055,32.7362,1002025,0.0,-89` },
  { name: 'bug6-horizon', query: `${COMMON}&camera=95.7229,31.5070,11645,295.8,-4.3` },
  // 2 极端分离变量（spec §0.3，性能基线用；视觉门禁可跑可不跑）
  { name: 'sky-only', query: `${COMMON}&camera=139.2399,34.8752,64309,8.7,60` },
  { name: 'nadir', query: `${COMMON}&camera=95.7229,31.5070,2000,295.8,-90` }
]

// ---- 门禁阈值（spec §0.5 / 验收 §视觉）----
const SSIM_THRESHOLD = 0.999
const MAXDELTA_THRESHOLD = 2 // 单位 /255，逐通道最大绝对差

// ---- CLI 解析 ----
interface CliOptions {
  base: string
  refDir: string
  outDir: string
  check: boolean
  saveRef: boolean
  profile: boolean
  only: string[] | null
  width: number
  height: number
  dpr: number
  settleMs: number
  timeoutMs: number
  ssimThreshold: number
  maxDeltaThreshold: number
}

function parseArgs(argv: string[]): CliOptions {
  const here = dirname(fileURLToPath(import.meta.url))
  const opts: CliOptions = {
    base: 'http://localhost:5173',
    refDir: join(here, 'ref'),
    outDir: join(here, 'out'),
    check: false,
    saveRef: false,
    profile: false,
    only: null,
    width: 1280,
    height: 720,
    dpr: 1,
    settleMs: 2000,
    timeoutMs: 120000,
    ssimThreshold: SSIM_THRESHOLD,
    maxDeltaThreshold: MAXDELTA_THRESHOLD
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v == null) throw new Error(`参数 ${a} 缺值`)
      return v
    }
    switch (a) {
      case '--base': opts.base = next(); break
      case '--ref-dir': opts.refDir = next(); break
      case '--out-dir': opts.outDir = next(); break
      case '--check': opts.check = true; break
      case '--save-ref': opts.saveRef = true; break
      case '--profile': opts.profile = true; break
      case '--only': opts.only = next().split(',').map(s => s.trim()).filter(Boolean); break
      case '--width': opts.width = Number(next()); break
      case '--height': opts.height = Number(next()); break
      case '--dpr': opts.dpr = Number(next()); break
      case '--settle-ms': opts.settleMs = Number(next()); break
      case '--timeout-ms': opts.timeoutMs = Number(next()); break
      case '--ssim-threshold': opts.ssimThreshold = Number(next()); break
      case '--maxdelta-threshold': opts.maxDeltaThreshold = Number(next()); break
      default: throw new Error(`未知参数 ${a}`)
    }
  }
  return opts
}

// ---- 图像对比：逐通道 maxΔ + 简化窗口 SSIM ----
interface CompareResult {
  ssim: number
  maxDelta: number
}

// 简化 SSIM：灰度 + 8×8 均值窗（步长 4），mean-SSIM。C1/C2 用标准 K1=0.01/K2=0.03。
// 非高斯加权、非全滑动窗，是「简化版」；对门禁（阈值 0.999 极高）足够敏感。
function computeSSIM(a: PNG, b: PNG): number {
  const w = a.width
  const h = a.height
  const gray = (img: PNG): Float64Array => {
    const g = new Float64Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      // Rec.601 亮度
      g[i] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
    }
    return g
  }
  const ga = gray(a)
  const gb = gray(b)
  const K1 = 0.01
  const K2 = 0.03
  const L = 255
  const C1 = (K1 * L) ** 2
  const C2 = (K2 * L) ** 2
  const WIN = 8
  const STRIDE = 4
  let sum = 0
  let count = 0
  for (let y = 0; y + WIN <= h; y += STRIDE) {
    for (let x = 0; x + WIN <= w; x += STRIDE) {
      let meanA = 0
      let meanB = 0
      const n = WIN * WIN
      for (let wy = 0; wy < WIN; wy++) {
        for (let wx = 0; wx < WIN; wx++) {
          const idx = (y + wy) * w + (x + wx)
          meanA += ga[idx]
          meanB += gb[idx]
        }
      }
      meanA /= n
      meanB /= n
      let varA = 0
      let varB = 0
      let cov = 0
      for (let wy = 0; wy < WIN; wy++) {
        for (let wx = 0; wx < WIN; wx++) {
          const idx = (y + wy) * w + (x + wx)
          const da = ga[idx] - meanA
          const db = gb[idx] - meanB
          varA += da * da
          varB += db * db
          cov += da * db
        }
      }
      varA /= n
      varB /= n
      cov /= n
      const num = (2 * meanA * meanB + C1) * (2 * cov + C2)
      const den = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2)
      sum += num / den
      count++
    }
  }
  return count === 0 ? 1 : sum / count
}

function computeMaxDelta(a: PNG, b: PNG): number {
  let max = 0
  const n = Math.min(a.data.length, b.data.length)
  // RGBA 四通道都计入（alpha 差也算视觉差异）
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.data[i] - b.data[i])
    if (d > max) max = d
  }
  return max
}

function compareImages(refPath: string, newPath: string): CompareResult {
  const ref = PNG.sync.read(readFileSync(refPath))
  const cur = PNG.sync.read(readFileSync(newPath))
  if (ref.width !== cur.width || ref.height !== cur.height) {
    throw new Error(
      `尺寸不一致 ref=${ref.width}x${ref.height} vs cur=${cur.width}x${cur.height}（${newPath}）`
    )
  }
  return { ssim: computeSSIM(ref, cur), maxDelta: computeMaxDelta(ref, cur) }
}

// ---- 截图：等 tilesLoaded + 静置，page.screenshot 走合成器（WebGL canvas 无需 preserveDrawingBuffer）----
async function waitTilesLoaded(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const v = (window as unknown as {
        __viewer?: { scene?: { globe?: { tilesLoaded?: boolean } } }
      }).__viewer
      return v?.scene?.globe?.tilesLoaded === true
    },
    undefined,
    { timeout: timeoutMs }
  )
}

// 容错版：tilesLoaded 超时（如纯天空视角 globe 不在视锥内、长时间不 settle）不致命——
// 截图继续（天空静态画面本就无需瓦片），仅 warn。返回是否等到 tilesLoaded。
//
// 2026-09-04 重录发现：tilesLoaded **首次为 true 不够**——refinement 波次间隙会瞬时 true
// （下一批子瓦片入队前后），截图恰好落在波次中段=瓦片马赛克帧（实测 high-graze/bug5 间歇
// maxΔ 44/53、真帧自洽逐位 0 差）。改为「连续保持 HOLD_MS 为 true」才认为瓦片终态：
// refinement 完毕无新请求，远视场场景自洽逐位通过。
const TILES_LOADED_HOLD_MS = 5000

async function waitTilesLoadedTolerant(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await waitTilesLoaded(page, timeoutMs)
  } catch {
    console.warn(`[capture] tilesLoaded 等待超时（${timeoutMs}ms），仍截图（天空/无瓦片场景可接受）`)
    return false
  }
  const deadline = Date.now() + timeoutMs
  let lastFalse = Date.now() // 最近一次观测到 false 的时刻（初始=首达 true 时刻）
  while (Date.now() < deadline) {
    await page.waitForTimeout(250)
    const ok = await page.evaluate(() => {
      const v = (window as unknown as {
        __viewer?: { scene?: { globe?: { tilesLoaded?: boolean } } }
      }).__viewer
      return v?.scene?.globe?.tilesLoaded === true
    })
    if (!ok) {
      lastFalse = Date.now()
    } else if (Date.now() - lastFalse >= TILES_LOADED_HOLD_MS) {
      return true
    }
  }
  console.warn(`[capture] tilesLoaded 连续保持检查超时（${timeoutMs}ms），按当前状态截图`)
  return true
}

async function captureScenario(
  browser: Browser,
  opts: CliOptions,
  scenario: Scenario
): Promise<{ pngPath: string; profileMedian: Record<string, number> | null }> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.dpr
  })
  const page = await context.newPage()

  // --profile：收集 console `[profile]` 逐 stage JSON，跨帧累计后取中位数
  const profileSamples: Record<string, number[]> = {}
  if (opts.profile) {
    page.on('console', msg => {
      const text = msg.text()
      if (!text.startsWith('[profile]')) return
      try {
        const obj = JSON.parse(text.slice('[profile]'.length).trim()) as Record<string, number | null>
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            ;(profileSamples[k] ??= []).push(v)
          }
        }
      } catch {
        // 忽略解析失败的行
      }
    })
  }

  let query = scenario.query
  if (opts.profile) query += '&profile=1'
  const url = `${opts.base}/${query.startsWith('?') ? '' : '?'}${query.replace(/^\?/, '')}`
  console.log(`[capture] ${scenario.name} -> ${url}`)
  await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs })
  await waitTilesLoadedTolerant(page, opts.timeoutMs)
  await page.waitForTimeout(opts.settleMs) // 预热静置（瓦片稳 + profile ring buffer 就绪）

  const dir = opts.saveRef ? opts.refDir : opts.outDir
  mkdirSync(dir, { recursive: true })
  const pngPath = join(dir, `${scenario.name}.png`)
  await page.screenshot({ path: pngPath })

  let profileMedian: Record<string, number> | null = null
  if (opts.profile) {
    profileMedian = {}
    for (const [k, arr] of Object.entries(profileSamples)) {
      const sorted = [...arr].sort((a, b) => a - b)
      profileMedian[k] = sorted[Math.floor(sorted.length / 2)] ?? 0
    }
  }

  await context.close()
  return { pngPath, profileMedian }
}

// ---- main ----
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const scenarios =
    opts.only == null
      ? SCENARIOS
      : SCENARIOS.filter(s => opts.only!.includes(s.name))
  if (scenarios.length === 0) {
    throw new Error(
      `--only 未匹配任何场景。可选：${SCENARIOS.map(s => s.name).join(', ')}`
    )
  }

  const browser = await chromium.launch()
  try {
    const results: Array<{
      name: string
      pngPath: string
      ssim?: number
      maxDelta?: number
      pass?: boolean
      profileMedian: Record<string, number> | null
    }> = []

    for (const scenario of scenarios) {
      // 单场景失败（截图/超时/比对抛错）不中断整批——记录失败继续，批末统一汇总。
      let shot: { pngPath: string; profileMedian: Record<string, number> | null }
      try {
        shot = await captureScenario(browser, opts, scenario)
      } catch (err) {
        console.error(`[capture] ${scenario.name} 截图失败：`, err)
        results.push({ name: scenario.name, pngPath: '', profileMedian: null, pass: false })
        continue
      }
      const { pngPath, profileMedian } = shot
      const entry: (typeof results)[number] = { name: scenario.name, pngPath, profileMedian }
      if (opts.check) {
        const refPath = join(opts.refDir, `${scenario.name}.png`)
        if (!existsSync(refPath)) {
          console.warn(`[check] ${scenario.name}: 缺 ref（${refPath}），先 --save-ref 采集`)
          entry.pass = false
        } else {
          try {
            const { ssim, maxDelta } = compareImages(refPath, pngPath)
            entry.ssim = ssim
            entry.maxDelta = maxDelta
            entry.pass =
              ssim >= opts.ssimThreshold && maxDelta <= opts.maxDeltaThreshold
            console.log(
              `[check] ${scenario.name}: SSIM=${ssim.toFixed(5)} maxΔ=${maxDelta}/255 ` +
                `阈值 SSIM≥${opts.ssimThreshold} maxΔ≤${opts.maxDeltaThreshold} -> ` +
                (entry.pass ? 'PASS' : 'FAIL')
            )
          } catch (err) {
            console.error(`[check] ${scenario.name} 比对失败：`, err)
            entry.pass = false
          }
        }
      }
      results.push(entry)
    }

    // profile 中位数汇总（性能基线回填用）
    if (opts.profile) {
      console.log('\n[profile] 各场景逐 stage GPU ms（中位数）：')
      for (const r of results) {
        if (r.profileMedian != null) {
          console.log(`  ${r.name}: ${JSON.stringify(r.profileMedian)}`)
        }
      }
    }

    if (opts.check) {
      const failed = results.filter(r => r.pass === false)
      if (failed.length > 0) {
        console.error(`\n[check] 门禁未过：${failed.map(r => r.name).join(', ')}`)
        process.exitCode = 1
      } else {
        console.log('\n[check] 全部门禁通过')
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error('[capture]', err)
  process.exitCode = 1
})
