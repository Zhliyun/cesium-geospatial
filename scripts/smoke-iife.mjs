#!/usr/bin/env node
// IIFE/UMD 产物冒烟：
// 1) 结构断言：单文件、无 ESM import/export、external cesium 走全局 `Cesium`、导出挂在 `CesiumGeospatial`
// 2) 真浏览器：页面只加载 Cesium UMD（window.Cesium）+ 本 IIFE，创建 Viewer 并 install（clouds:false），
//    断言安装成功、无 console error / pageerror。
// 用法：先 `pnpm run build`（含 build:iife），再 `node scripts/smoke-iife.mjs`。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const IIFE = resolve(ROOT, 'dist-iife/cesium-geospatial.iife.js')
const CESIUM_DIR = resolve(ROOT, 'node_modules/cesium/Build/Cesium')
const ASSETS_DIR = resolve(ROOT, 'assets')

assert.ok(existsSync(IIFE), `缺少 IIFE 产物：${IIFE}（先跑 pnpm run build）`)
assert.ok(existsSync(join(CESIUM_DIR, 'Cesium.js')), `缺少 Cesium UMD：${CESIUM_DIR}`)

// ── 1. 结构断言 ────────────────────────────────────────────────────────────
const code = readFileSync(IIFE, 'utf8')
assert.ok(!/^\s*import\s/m.test(code), 'IIFE 里出现静态 import（应为 external → 全局 Cesium）')
assert.ok(!/^\s*export\s/m.test(code), 'IIFE 里出现 export（应为全局变量导出）')
assert.ok(!code.includes('import('), 'IIFE 里出现动态 import（IIFE 不支持代码分割）')
assert.ok(code.includes('CesiumGeospatial'), '未找到全局名 CesiumGeospatial')
// 导出名在压缩后仍以属性字符串保留（真正的可调用性由浏览器段验证）
for (const name of ['installAtmosphereClouds', 'isInstalled', 'InstallCancelledError']) {
  assert.ok(code.includes(name), `IIFE 导出对象缺少 ${name}`)
}
console.log('[smoke-iife] 结构断言通过：无 ESM、全局名与导出名存在')

// ── 2. 真浏览器 ────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.xml': 'application/xml'
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script>window.CESIUM_BASE_URL = '/cesium/';</script>
<script src="/cesium/Cesium.js"></script>
<script src="/cesium-geospatial.iife.js"></script>
</head>
<body style="margin:0">
<div id="c" style="width:800px;height:600px"></div>
<script>
(async () => {
  try {
    if (!window.Cesium) throw new Error('window.Cesium 缺失（UMD 未加载）')
    if (!window.CesiumGeospatial) throw new Error('window.CesiumGeospatial 缺失（IIFE 未加载）')
    const viewer = new Cesium.Viewer('c', {
      baseLayer: false, baseLayerPicker: false, geocoder: false,
      animation: false, timeline: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false, infoBox: false,
      selectionIndicator: false, requestRenderMode: false
    })
    const handle = await window.CesiumGeospatial.installAtmosphereClouds(viewer, {
      clouds: false,
      atmosphere: { lensFlare: false, depthTemporal: false },
      assetsBaseUrl: '/cesium-geospatial-assets/'
    })
    window.__result = { ok: true, hasDestroy: typeof handle.destroy === 'function' }
    window.__handle = handle
  } catch (e) {
    window.__result = { ok: false, error: String((e && e.stack) || e) }
  }
})()
</script></body></html>`

function safeJoin(rootDir, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return undefined // 非法百分号编码 → 404，而不是未捕获异常崩掉整个冒烟
  }
  const p = normalize(join(rootDir, decoded))
  const rel = relative(rootDir, p)
  // 用路径关系而不是字符串前缀判包含：`/a/bc` 不会被误判为在 `/a/b` 内
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined
  }
  return p
}

const server = createServer((req, res) => {
  try {
    const url = req.url || '/'
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(PAGE)
      return
    }
    let file
    if (url.startsWith('/cesium/')) file = safeJoin(CESIUM_DIR, url.slice('/cesium/'.length))
    else if (url.startsWith('/cesium-geospatial-assets/')) file = safeJoin(ASSETS_DIR, url.slice('/cesium-geospatial-assets/'.length))
    else if (url === '/cesium-geospatial.iife.js') file = IIFE
    if (!file) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    try {
      const body = readFileSync(file)
      // 同源测试页不需要 CORS：不回 ACAO，避免把 loopback 文件服务器暴露给任意站点
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream'
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('internal error')
    } else {
      res.destroy()
    }
  }
})

server.on('clientError', (_err, socket) => socket.destroy())

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/`
const consoleErrors = []
const pageErrors = []
let browser
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']
  })
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(base, { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction('window.__result !== undefined', null, { timeout: 60000 })
  const result = await page.evaluate(() => window.__result)
  assert.equal(result.ok, true, `浏览器安装失败：${result.error}`)
  assert.equal(result.hasDestroy, true)
  assert.deepEqual(pageErrors, [], `pageerror：${pageErrors.join('\n')}`)
  assert.deepEqual(consoleErrors, [], `console.error：${consoleErrors.join('\n')}`)
  console.log('[smoke-iife] 浏览器通过：window.Cesium + IIFE，install(clouds:false) 成功，0 console/pageerror')
} finally {
  if (browser) await browser.close()
  await new Promise((r) => server.close(r))
}
