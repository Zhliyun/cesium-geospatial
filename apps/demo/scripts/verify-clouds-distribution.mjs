// 云分布重设计（spec 2026-09-03）Task 8 验收脚本。
//
// 两类能力（模式参照 scripts/perf/capture.ts 的 playwright+pngjs 惯例）：
//   1) smoke —— headless 冒烟：打开 clouds=1，收集 console（GL 报错零容忍 / mip 降级 warn /
//      atlas 降级 warn），等 tilesLoaded 后截图做天空区像素统计（非全黑非全白 + 有云内容）。
//      SwiftShader 画面不可信铁律：本步只做「GL 跑通 + 数值非退化」判定，画面美学不判。
//   2) headed 截图/帧率 + 量化子命令 —— headed（真实 GPU）每组新开浏览器实例（成对对照
//      同批原则），像素量化由 diff/rows/coverage/suncheck 子命令离线分析。
//
//      ※ 原计划用 agent-browser CLI 做 headed 组；实测其 page targeting 分裂（open 确认
//      标题/URL 正确，wait --fn/tab list/screenshot 却指向 about:blank，全命令统一 --headed
//      亦复现）——改用 playwright headed（本仓库 capture.ts 既有惯例，同为真实 GPU），
//      每组 launch→shot→close 满足「每组 close 重开」约束。
//
// 用法（仓库根，dev server 需已在 :5173）：
//   node apps/demo/scripts/verify-clouds-distribution.mjs smoke [--out DIR] [--url QUERY]
//   node apps/demo/scripts/verify-clouds-distribution.mjs shot <name> "<query>" [--headless] [--settle-ms N]
//   node apps/demo/scripts/verify-clouds-distribution.mjs triple <prefix> "<query>"   # 同实例 3 帧（确定性）
//   node apps/demo/scripts/verify-clouds-distribution.mjs evolve                      # B1 演化三连拍
//   node apps/demo/scripts/verify-clouds-distribution.mjs fps "<query>"               # 10s rAF 采样
//   node apps/demo/scripts/verify-clouds-distribution.mjs diff a.png b.png [--rows] [--tol N]
//   node apps/demo/scripts/verify-clouds-distribution.mjs rows shot.png
//   node apps/demo/scripts/verify-clouds-distribution.mjs coverage shot.png [--sky-ratio 0.35] [--band y0,y1]
//   node apps/demo/scripts/verify-clouds-distribution.mjs suncheck a.png b.png
//   node apps/demo/scripts/verify-clouds-distribution.mjs side a.png b.png out.png   # 并排合成
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_BASE = 'http://localhost:5173'
const DEFAULT_OUT = join(HERE, '..', 'verify-artifacts')
const W = 1280
const H = 720

// ---- 公共 URL 段（README 惯例：mode=atmosphere 是 clouds=1 前提；time 钉死太阳；
//      fps=0 关 FPS 角标防污染像素 diff——帧率用例单独用 fps=1）----
// camera=90E,50N：2026-09-03T06:00Z 时 local noon；lat50=中纬多云带。纬度扫描诊断实证
// 气候带分布正确生效：lat28 副热带谷近无云、lat0 ITCZ 密云、lat50 最饱和——主对照选多云带
//（初版选 lat32 副热带谷内，画面近无云，曾误判「云不渲染」）。
export const COMMON =
  'mode=atmosphere&fps=0&time=2026-09-03T06%3A00%3A00Z&clouds=1&camera=90%2C50%2C8000%2C0%2C-8'
// 冒烟默认：lat0 ITCZ + 俯角 -30（云甲充满画面、蓝隙可辨——阈值法 coverage 有意义。
// 平掠视角地平线亮霾带会被亮度阈值误判为云：首跑 lat32 平掠图 cloudFrac 0.27 系霾带假阳性）
export const SMOKE_QUERY =
  'mode=atmosphere&fps=0&time=2026-09-03T06%3A00%3A00Z&clouds=1&camera=90%2C0%2C8000%2C0%2C-30'

// ---- CLI ----
function parseArgs(argv) {
  const opts = {
    _: [],
    out: DEFAULT_OUT,
    base: DEFAULT_BASE,
    rows: false,
    tol: 8,
    skyRatio: 0.35,
    band: null,
    headless: false,
    settleMs: 6000,
    width: W,
    height: H
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--base') opts.base = argv[++i]
    else if (a === '--url') opts.urlQuery = argv[++i]
    else if (a === '--rows') opts.rows = true
    else if (a === '--tol') opts.tol = Number(argv[++i])
    else if (a === '--sky-ratio') opts.skyRatio = Number(argv[++i])
    else if (a === '--band') opts.band = argv[++i].split(',').map(Number)
    else if (a === '--headless') opts.headless = true
    else if (a === '--settle-ms') opts.settleMs = Number(argv[++i])
    else opts._.push(a)
  }
  return opts
}

// ---- 像素统计 ----
function grayOf(png) {
  const { width, height, data } = png
  const g = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    g[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
  }
  return g
}

// 云像素启发式（白昼正午光照标定）：云 = 高亮度 + 非蓝（蓝天 B>>R，云 RGB 近等）。
// 只用于同光照下相对比较（预设单调性/气候带对照），非绝对覆盖率。
function isCloudPixel(data, o, g) {
  const r = data[o]
  const gg = data[o + 1]
  const b = data[o + 2]
  const blueness = b - r
  return g > 170 && blueness < 25
}

// coverage：天空区 = 上 skyRatio 高度带，或 --band y0,y1（行比例）指定水平带
function coverageStats(png, skyRatio, band) {
  const { width, height, data } = png
  const g = grayOf(png)
  const y0 = band ? Math.floor(height * band[0]) : 0
  const y1 = band ? Math.floor(height * band[1]) : Math.floor(height * skyRatio)
  let cloud = 0
  let total = 0
  let minL = 255
  let maxL = 0
  let sumL = 0
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const lum = g[idx]
      minL = Math.min(minL, lum)
      maxL = Math.max(maxL, lum)
      sumL += lum
      if (isCloudPixel(data, idx * 4, lum)) cloud++
      total++
    }
  }
  return {
    region: { y0, y1, height, width },
    cloudFrac: total ? cloud / total : 0,
    nonCloudFrac: total ? 1 - cloud / total : 1,
    minLum: minL,
    maxLum: maxL,
    meanLum: total ? sumL / total : 0
  }
}

// diff：逐通道 abs diff 统计 + 可选十段 rows 分布
function diffStats(a, b, tol) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`尺寸不一致 ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const n = a.width * a.height
  let changed = 0
  let sumAbs = 0
  let maxDelta = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2])
    )
    sumAbs +=
      (Math.abs(a.data[o] - b.data[o]) +
        Math.abs(a.data[o + 1] - b.data[o + 1]) +
        Math.abs(a.data[o + 2] - b.data[o + 2])) /
      3
    if (d > tol) changed++
    if (d > maxDelta) maxDelta = d
  }
  return { meanAbs: sumAbs / n, fracChanged: changed / n, maxDelta }
}

// 十段 rows：逐段「竖向相邻行平均亮度差」（粗糙度）。旧平铺壁纸=大块平滑重复结构 vs
// 新 atlas 高频细节 → 分布形态不同；同一相机新旧图各测一次，数值留档比对。
function rowsProfile(png) {
  const { width, height } = png
  const g = grayOf(png)
  const bands = 10
  const out = []
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor((height * b) / bands)
    const y1 = Math.floor((height * (b + 1)) / bands)
    let sum = 0
    let count = 0
    for (let y = y0; y < y1 - 1; y++) {
      for (let x = 0; x < width; x++) {
        sum += Math.abs(g[y * width + x] - g[(y + 1) * width + x])
        count++
      }
    }
    out.push(count ? +(sum / count).toFixed(3) : 0)
  }
  return { bands, profile: out, mean: +(out.reduce((s, v) => s + v, 0) / bands).toFixed(3) }
}

// suncheck：天顶区（rows 15%-35%、cols 40%-60%）平均亮度（演化归因：phase 不动太阳）
function zenithStats(png) {
  const { width, height } = png
  const g = grayOf(png)
  const y0 = Math.floor(height * 0.15)
  const y1 = Math.floor(height * 0.35)
  const x0 = Math.floor(width * 0.4)
  const x1 = Math.floor(width * 0.6)
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += g[y * width + x]
      count++
    }
  }
  return count ? sum / count : 0
}

function loadPng(path) {
  return PNG.sync.read(readFileSync(path))
}

// ---- 浏览器生命周期（headed 每组新实例）----
async function withPage(opts, query, fn) {
  const browser = await chromium.launch({ headless: opts.headless })
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height }
  })
  const page = await context.newPage()
  const consoleLines = []
  page.on('console', (msg) => consoleLines.push({ type: msg.type(), text: msg.text() }))
  page.on('pageerror', (err) => consoleLines.push({ type: 'pageerror', text: String(err) }))
  const url = `${opts.base}/?${query}`
  await page.goto(url, { waitUntil: 'load', timeout: 120000 })
  let tilesLoaded = false
  try {
    await page.waitForFunction(
      () => window.__viewer?.scene?.globe?.tilesLoaded === true,
      undefined,
      { timeout: 120000 }
    )
    tilesLoaded = true
  } catch {
    console.warn(`[shot] tilesLoaded 超时（${url}）`)
  }
  await page.waitForTimeout(opts.settleMs)
  // 第四轮铁律（5b7a382 前死帧伪像）：rAF 必须在推进——SkyStage 编译炸曾致 render loop
  // 停摆，截图沦为准静态死帧（相同参数逐位同图=死画布而非确定性）。无效样本显式标记。
  let renderAlive = false
  try {
    renderAlive = await page.evaluate(async () => {
      const t0 = await new Promise((r) => requestAnimationFrame((t) => r(t)))
      await new Promise((r) => setTimeout(r, 200))
      const t1 = await new Promise((r) => requestAnimationFrame((t) => r(t)))
      return t1 > t0
    })
  } catch {
    renderAlive = false
  }
  if (!renderAlive) console.warn(`[alive] 渲染循环未推进（死帧伪像风险）: ${url}`)
  const errors = consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror')
  try {
    await fn(page)
  } finally {
    await browser.close()
  }
  return { url, tilesLoaded, errors, renderAlive }
}

// shot：<name> 单实例单帧
async function cmdShot(opts, name, query) {
  let shotDone = false
  const meta = await withPage(opts, query, async (page) => {
    const path = join(opts.out, `${name}.png`)
    await page.screenshot({ path })
    shotDone = true
    console.log(`[shot] ${path}`)
  })
  console.log(JSON.stringify({ name, shotDone, tilesLoaded: meta.tilesLoaded, renderAlive: meta.renderAlive, consoleErrors: meta.errors }))
}

// triple：同实例 3 帧（间隔 2s）——确定性对照组
async function cmdTriple(opts, prefix, query) {
  const paths = []
  const meta = await withPage(opts, query, async (page) => {
    for (let i = 1; i <= 3; i++) {
      const path = join(opts.out, `${prefix}-${i}.png`)
      await page.screenshot({ path })
      paths.push(path)
      if (i < 3) await page.waitForTimeout(2000)
    }
  })
  console.log(JSON.stringify({ prefix, paths, tilesLoaded: meta.tilesLoaded, consoleErrors: meta.errors }))
}

// evolve：B1 默认态演化——play=1 speed=60（1 wall-s = 1 sim-min），Δ0/+5/+30 sim-min 三连拍
async function cmdEvolve(opts) {
  const query = `${COMMON}&play=1&speed=60`
  const paths = []
  const meta = await withPage(opts, query, async (page) => {
    for (const [tag, waitMs] of [['t0', 0], ['t5m', 5000], ['t30m', 25000]]) {
      if (waitMs > 0) await page.waitForTimeout(waitMs)
      const path = join(opts.out, `b1-evo-${tag}.png`)
      await page.screenshot({ path })
      paths.push(path)
      console.log(`[shot] ${path}`)
    }
  })
  console.log(JSON.stringify({ paths, tilesLoaded: meta.tilesLoaded, consoleErrors: meta.errors }))
}

// fps：headed 10s rAF 采样（Cesium 自身 rAF 驱动渲染，回调节奏=渲染节奏）
async function cmdFps(opts, query) {
  const meta = await withPage(opts, query, async (page) => {
    const r = await page.evaluate(async () => {
      await new Promise((r2) => setTimeout(r2, 1000))
      const seconds = 10
      let frames = 0
      const t0 = performance.now()
      await new Promise((resolve) => {
        const loop = () => {
          frames++
          if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(loop)
          else resolve()
        }
        requestAnimationFrame(loop)
      })
      return { avgFps: +(frames / ((performance.now() - t0) / 1000)).toFixed(2), frames }
    })
    console.log(JSON.stringify(r))
  })
  console.log(JSON.stringify({ tilesLoaded: meta.tilesLoaded, consoleErrors: meta.errors }))
}

// side：两图并排合成（存档对照）
function cmdSide(aPath, bPath, outPath) {
  const a = loadPng(aPath)
  const b = loadPng(bPath)
  const out = new PNG({ width: a.width + b.width, height: Math.max(a.height, b.height) })
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0)
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width, 0)
  writeFileSync(outPath, PNG.sync.write(out))
  console.log(`[side] ${outPath}`)
}

// ---- smoke：headless playwright ----
async function runSmoke(opts) {
  const query = opts.urlQuery ?? SMOKE_QUERY
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: W, height: H } })
  const page = await context.newPage()
  const consoleLines = []
  page.on('console', (msg) => consoleLines.push({ type: msg.type(), text: msg.text() }))
  page.on('pageerror', (err) => consoleLines.push({ type: 'pageerror', text: String(err) }))
  const url = `${opts.base}/?${query}`
  console.log(`[smoke] ${url}`)
  await page.goto(url, { waitUntil: 'load', timeout: 120000 })
  let tilesLoaded = false
  try {
    await page.waitForFunction(
      () => window.__viewer?.scene?.globe?.tilesLoaded === true,
      undefined,
      { timeout: 90000 }
    )
    tilesLoaded = true
  } catch {
    console.warn('[smoke] tilesLoaded 超时，继续（天空视角可接受）')
  }
  await page.waitForTimeout(6000)
  mkdirSync(opts.out, { recursive: true })
  const shotPath = join(opts.out, 'smoke-headless.png')
  await page.screenshot({ path: shotPath })

  const wired = consoleLines.some((l) => l.text.includes('[phase3-clouds] 体积云已接线'))
  // dbdcea8 后 warn 文案不含「WeatherAtlas」字样（兜底=「天气图烘焙失败…」、escape 无材料=
  // 「usePngFallback 但无…」）——按 [clouds] 前缀收集（排除 [phase3-clouds] 接线 info 需精确
  // 前缀：'[clouds]' 不匹配 '[phase3-clouds]'（无 '[c' 相邻序列））。
  const atlasWarns = consoleLines.filter(
    (l) => l.type !== 'pageerror' && l.text.startsWith('[clouds]')
  )
  const errors = consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror')
  const png = loadPng(shotPath)
  const stats = coverageStats(png, 0.35, null)
  // atlas mode：无直接运行时探针（handle 未暴露 atlas）。且 T8 实证：分派 bug
  // （WeatherAtlas.createWeatherAtlas「pngFallback 提供即 fallback」× createCloudsStage
  // 正常路径无条件传兜底源）使烘焙路径不可达且全程无 warn——console 推断不可靠，
  // 仅报告 warn 原文，判定留给 T8 报告（证据：default vs cloudsAtlas=0 两 URL 渲染逐位相同）。
  const atlasWarnTexts = atlasWarns.map((l) => l.text)

  // atlas mode 推断（dbdcea8 修复后）：baked 成功路径全程静默（bakeAtlas 无成功日志），
  // 降级/失败才有 warn——无 warn 即 baked（与 B5 渲染差异对照互证：baked vs escape 两源
  // 内容不同）。handle 未暴露 atlas.mode（运行时探针缺位如实记录，T8 报告遗留项）。
  // 注意 escape（cloudsAtlas=0）包装路径同样全程静默——console 只能排除「降级发生」，
  // 不能区分 baked/escape；escape 由 URL 参数标注（B5 渲染差异为内容级判据）。
  const isEscape = /cloudsAtlas=0/.test(query)
  let atlasMode = isEscape
    ? 'pngFallback（URL 显式 escape 标注；console 静默一致）'
    : 'baked（console 静默推断；与 B5 渲染差异互证）'
  if (consoleLines.some((l) => l.text.includes('usePngFallback 但无 pngFallback 数据'))) {
    atlasMode = 'pngFallback（escape 无材料回退烘焙 warn）'
  } else if (consoleLines.some((l) => l.text.includes('烘焙失败，降级静态 PNG fallback'))) {
    atlasMode = 'pngFallback（烘焙失败降级 warn）'
  } else if (consoleLines.some((l) => l.text.includes('FBO 不完整'))) {
    atlasMode = 'baked-but-empty（FBO 不完整 warn，atlas 全 0 无云）'
  } else if (consoleLines.some((l) => l.text.includes('generateMipmap 失败'))) {
    atlasMode = 'baked（mip 降级 LINEAR warn——lod0 可用）'
  }

  const result = {
    url,
    tilesLoaded,
    wired,
    errors,
    atlasWarns: atlasWarnTexts,
    atlasMode,
    mipWarn: consoleLines.some((l) => l.text.includes('generateMipmap 失败')),
    sky: stats,
    shotPath
  }
  result.verdict = {
    noGlError: errors.length === 0,
    notAllBlack: stats.meanLum > 10,
    notAllWhite: stats.meanLum < 245,
    hasCloudContent: stats.cloudFrac > 0.01
  }
  console.log(JSON.stringify(result, null, 2))
  await browser.close()
  return result
}

// ---- main ----
const opts = parseArgs(process.argv.slice(2))
const cmd = opts._[0]
const out = (obj) => console.log(JSON.stringify(obj, null, 2))

// bake：headed 烘焙耗时观察（SwiftShader 耗时无意义，故 headed 真测）。
// 方法：init script 16ms 轮询 window.__cloudsStage 赋值时刻（main.ts stage 创建完成同步赋值，
// 含 loadWeatherTextures fetch 链）；同法测默认（烘焙）与 ?cloudsAtlas=0（PNG 包装，同资产同
// 上传、只差 64 层烘焙 pass+mip）——两者就绪时刻差 ≈ 烘焙增量成本。粒度受轮询间隔限制（±16ms）。
async function cmdBake(opts) {
  const stages = [
    ['baked', COMMON],
    ['pngWrap', COMMON.replace('clouds=1', 'clouds=1&cloudsAtlas=0')]
  ]
  const results = []
  for (const [name, query] of stages) {
    const browser = await chromium.launch({ headless: false })
    const context = await browser.newContext({ viewport: { width: W, height: H } })
    await context.addInitScript(() => {
      window.__stageAt = 0
      const timer = setInterval(() => {
        if (window.__cloudsStage != null && window.__stageAt === 0) {
          window.__stageAt = performance.now()
          clearInterval(timer)
        }
      }, 16)
    })
    const page = await context.newPage()
    const consoleLines = []
    page.on('console', (msg) => consoleLines.push({ type: msg.type(), text: msg.text() }))
    page.on('pageerror', (err) => consoleLines.push({ type: 'pageerror', text: String(err) }))
    const url = `${opts.base}/?${query}`
    const t0 = Date.now()
    await page.goto(url, { waitUntil: 'load', timeout: 120000 })
    let stageAt = 0
    try {
      await page.waitForFunction(() => window.__stageAt > 0, undefined, { timeout: 120000 })
      stageAt = await page.evaluate(() => window.__stageAt)
    } catch {
      console.warn(`[bake] ${name}: __cloudsStage 120s 未就绪（stage 创建失败或 clouds 未接线）`)
    }
    const warns = consoleLines.filter((l) => l.text.includes('[clouds]')).map((l) => l.text)
    results.push({
      name,
      readyFromNavStartMs: +stageAt.toFixed(0),
      wallGotoMs: Date.now() - t0,
      tilesLoaded: await page
        .waitForFunction(() => window.__viewer?.scene?.globe?.tilesLoaded === true, undefined, { timeout: 30000 })
        .then(() => true)
        .catch(() => false),
      cloudsWarns: warns
    })
    console.log(`[bake] ${name}: stage 就绪 @${stageAt.toFixed(0)}ms（navStart 起）`)
    await browser.close()
  }
  const [baked, wrap] = results
  out({
    stages: results,
    bakeDeltaMs:
      baked && wrap && baked.readyFromNavStartMs && wrap.readyFromNavStartMs
        ? baked.readyFromNavStartMs - wrap.readyFromNavStartMs
        : null,
    note: 'bakeDeltaMs = 烘焙路径就绪时刻 − 包装路径就绪时刻（同资产同链，差≈64 层烘焙 pass+mip 生成；含 ±16ms 轮询粒度与帧调度抖动，读数量级参考）'
  })
}

if (cmd === 'smoke') {
  await runSmoke(opts)
} else if (cmd === 'bake') {
  await cmdBake(opts)
} else if (cmd === 'shot') {
  mkdirSync(opts.out, { recursive: true })
  await cmdShot(opts, opts._[1], opts._[2])
} else if (cmd === 'triple') {
  mkdirSync(opts.out, { recursive: true })
  await cmdTriple(opts, opts._[1], opts._[2])
} else if (cmd === 'evolve') {
  mkdirSync(opts.out, { recursive: true })
  await cmdEvolve(opts)
} else if (cmd === 'fps') {
  await cmdFps(opts, opts._[1])
} else if (cmd === 'diff') {
  const a = loadPng(opts._[1])
  const b = loadPng(opts._[2])
  const stats = diffStats(a, b, opts.tol)
  if (opts.rows) stats.rowsProfile = { a: rowsProfile(a), b: rowsProfile(b) }
  out(stats)
} else if (cmd === 'rows') {
  out(rowsProfile(loadPng(opts._[1])))
} else if (cmd === 'coverage') {
  out(coverageStats(loadPng(opts._[1]), opts.skyRatio, opts.band))
} else if (cmd === 'suncheck') {
  const la = zenithStats(loadPng(opts._[1]))
  const lb = zenithStats(loadPng(opts._[2]))
  out({ zenithLumA: la, zenithLumB: lb, relDiffPct: (Math.abs(la - lb) / ((la + lb) / 2)) * 100 })
} else if (cmd === 'side') {
  cmdSide(opts._[1], opts._[2], opts._[3])
} else {
  console.error(
    '用法: smoke | bake | shot <name> <query> | triple <prefix> <query> | evolve | fps <query> | diff a b [--rows] [--tol N] | rows shot | coverage shot [--sky-ratio 0.35] [--band y0,y1] | suncheck a b | side a b out'
  )
  process.exitCode = 1
}
