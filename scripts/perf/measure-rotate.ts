// 旋转卡顿量化（spec 2026-09-04 §6.6 协议）：t≈0 起采样，5s 静止窗后 CDP 级鼠标拖拽 5 轮
// 来回（25 步×24px、步间 40ms），分窗统计帧间隔（pre/rotate/post）。
// 协议钉死：拖拽参数如上；>1000ms 帧单列（瓦片突发流送）不混入 long100。
// 用法：pnpm exec tsx scripts/perf/measure-rotate.ts "<url>" [out.json]
// 注意：必须 headed 真 Chrome（真 GPU）——SwiftShader 无头数值无效（spec 测量纪律）。
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const url = process.argv[2]
const out = process.argv[3] ?? 'scripts/perf/out/measure-rotate.json'
if (!url) throw new Error('用法: measure-rotate.ts <url> [out.json]')

async function main() {
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(url, { waitUntil: 'load', timeout: 120000 })
await page
  .waitForFunction(() => {
    const v = (window as unknown as { __viewer?: { scene?: { globe?: { tilesLoaded?: boolean } } } }).__viewer
    return !!v?.scene?.globe?.tilesLoaded
  }, undefined, { timeout: 120000 })
  .catch(() => console.warn('tilesLoaded 超时，继续'))
await page.waitForTimeout(5000)

await page.evaluate(() => {
  const w = window as unknown as { __samples?: number[] }
  w.__samples = []
  const loop = () => { w.__samples!.push(performance.now()); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
})
await page.evaluate(() => { (window as unknown as { __t0?: number }).__t0 = performance.now() })
const cx = 640, cy = 360
const dragStartWall = Date.now()
for (let round = 0; round < 5; round++) {
  const dir = round % 2 === 0 ? 1 : -1
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 25; i++) {
    await page.mouse.move(cx + dir * i * 24, cy)
    await page.waitForTimeout(40)
  }
  await page.mouse.up()
}
const dragEndWall = Date.now()
await page.waitForTimeout(5000)
const samples = (await page.evaluate(() => (window as unknown as { __samples: number[] }).__samples)) as number[]
const t0 = (await page.evaluate(() => (window as unknown as { __t0: number }).__t0)) as number
await browser.close()

const stats = (arr: number[]) => {
  if (arr.length < 2) return null
  const gaps = arr.slice(1).map((t, i) => t - arr[i]).sort((a, b) => a - b)
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return {
    n: gaps.length,
    fps: +(1000 / avg).toFixed(1),
    p50: +gaps[Math.floor(gaps.length * 0.5)].toFixed(1),
    p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
    maxGap: +gaps[gaps.length - 1].toFixed(1),
    long100: gaps.filter(g => g > 100 && g <= 1000).length,
    tileStall: gaps.filter(g => g > 1000).length
  }
}
const rel = samples.map(t => t - t0)
const dragStartRel = rel.length > 0 ? rel[0] + (dragStartWall - (dragStartWall - 5000)) : 0
// 分窗：采样注入后 5s 内=静止（pre），拖拽历时=旋转（rotate），其后=恢复（post）
const rotateStart = 5000
const rotateEnd = 5000 + (dragEndWall - dragStartWall)
const result = {
  url,
  pre: stats(rel.filter(t => t < rotateStart)),
  rotate: stats(rel.filter(t => t >= rotateStart && t <= rotateEnd)),
  post: stats(rel.filter(t => t > rotateEnd)),
  dragDurMs: dragEndWall - dragStartWall,
  dragStartRelNote: `dragStartRel≈${dragStartRel}(近似)`
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
