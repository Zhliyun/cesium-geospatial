// bake-readback：WeatherAtlas 烘焙产物独立读回直方图 + 回归锚断言（T9 自 T8 会话 tmp
// 脚本转正入库，补 a 通道统计与 seedOffset 生产语义）。
//
// 方法：playwright 打开 dev server 页面（复用真实组装管线 buildStandaloneWeatherBakeShader，
// 含 resolveCloudsIncludes/unrollLoops/compat 完整变换——手拼文本替换会因 WebGL1 风格循环
// 编译失败）→ 页面裸 WebGL2 独立渲染烘焙 shader → readPixels 逐通道直方图。绕开 Cesium
// render loop，直驱烘焙 shader——验收读数不受渲染链死帧/雾底伪像污染（T8 沿革）。
//
// 回归锚（断言，失败 exit 1）：
//   1. g 通道（mid，B 通道）每采样层 hiFrac(>0.9) < 0.05——0b335ab 去双重放大修复锚
//      （修复前 perlin 内 2.2× 外层再乘 → 40.7% 像素 >0.9 白雾主源；旧 PNG 目标分布 ~2%）
//   2. a 通道（第 4 通道，extra perlin）全层 mean ∈ [0.3, 0.6]——a 通道真实内容锚
//      （旧 PNG 资产 a mean 0.415；恒 1.0 覆盖/全零回归即超界，spec §4.6 执行期修订）
//
// 用法（仓库根，dev server 需已在 :5173）：
//   node apps/demo/scripts/bake-readback.mjs [--slices 0,8,16,24,32,40,48,56,63]
//   断言阈值可用 --hi-frac-max / --a-mean-min / --a-mean-max 覆盖（默认见 ASSERT）。
import { chromium } from 'playwright'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// vite /@fs 前缀 + clouds 包源码绝对路径（相对本脚本解析——worktree/main 通用）
const REPO = '/@fs' + resolve(HERE, '..', '..', '..', 'packages', 'cesium-clouds', 'src')
const DEV_BASE = 'http://localhost:5173'

function parseArgs(argv) {
  const opts = {
    slices: [0, 8, 16, 24, 32, 40, 48, 56, 63],
    hiFracMax: 0.05,
    aMeanMin: 0.3,
    aMeanMax: 0.6
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--slices') opts.slices = argv[++i].split(',').map(Number)
    else if (a === '--hi-frac-max') opts.hiFracMax = Number(argv[++i])
    else if (a === '--a-mean-min') opts.aMeanMin = Number(argv[++i])
    else if (a === '--a-mean-max') opts.aMeanMax = Number(argv[++i])
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 300)))

await page.goto(DEV_BASE + '/', { waitUntil: 'load', timeout: 60000 })

// 真实组装管线产 frag；seedOffset 走生产 bakeSeedToOffset（WeatherAtlas 同源，勿手抄公式）
const { fragSrc, vertSrc, seedOffset } = await page.evaluate(async (repo) => {
  const assembler = await import(`${repo}/weatherBakeAssembler.ts`)
  const atlas = await import(`${repo}/WeatherAtlas.ts`)
  return {
    fragSrc: assembler.buildStandaloneWeatherBakeShader(),
    vertSrc: `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); // 0,0 2,0 0,2 大三角
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,
    seedOffset: (() => {
      const o = atlas.bakeSeedToOffset(1337)
      return [o.x, o.y]
    })()
  }
}, REPO)

const result = await page.evaluate(async ({ fragSrc, vertSrc, seedOffset, slices }) => {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (gl == null) return { error: 'no webgl2' }
  const compile = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertSrc))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: 'link: ' + gl.getProgramInfoLog(prog) }
  gl.useProgram(prog)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 256, 256, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  const layers = {}
  for (const s of slices) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, s)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { layers[s] = 'fbo bad'; continue }
    gl.viewport(0, 0, 256, 256)
    gl.uniform1f(gl.getUniformLocation(prog, 'u_slice'), s / 64)
    gl.uniform2f(gl.getUniformLocation(prog, 'u_seedOffset'), seedOffset[0], seedOffset[1])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const buf = new Uint8Array(256 * 256 * 4)
    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    // 通道直方图：均值 + >0.9 占比 + <0.1 占比（亚采样 1/4 像素足够；RGBA 四通道全统计）
    const stats = { r: {}, g: {}, b: {}, a: {} }
    const acc = { r: { sum: 0, hi: 0, lo: 0 }, g: { sum: 0, hi: 0, lo: 0 }, b: { sum: 0, hi: 0, lo: 0 }, a: { sum: 0, hi: 0, lo: 0 } }
    const n = 128 * 128
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const o = ((y * 256) + x * 2) * 4
      for (const [k, ch] of [['r', 0], ['g', 1], ['b', 2], ['a', 3]]) {
        const v = buf[o + ch] / 255
        acc[k].sum += v
        if (v > 0.9) acc[k].hi++
        if (v < 0.1) acc[k].lo++
      }
    }
    for (const k of ['r', 'g', 'b', 'a']) {
      stats[k] = {
        mean: +(acc[k].sum / n).toFixed(3),
        hiFrac: +(acc[k].hi / n).toFixed(4),
        loFrac: +(acc[k].lo / n).toFixed(4)
      }
    }
    layers[s] = stats
  }
  return { seedOffset, layers }
}, { fragSrc, vertSrc, seedOffset, slices: opts.slices })

await browser.close()

if (result.error != null) {
  console.error('[bake-readback] FAIL:', result.error)
  process.exit(1)
}

// ---- 回归锚断言 ----
const layerKeys = Object.keys(result.layers)
const aMeanAll = layerKeys.map((k) => result.layers[k].a.mean)
const aMeanAvg = +(aMeanAll.reduce((s, v) => s + v, 0) / layerKeys.length).toFixed(3)
const gHiFracs = layerKeys.map((k) => result.layers[k].g.hiFrac)
const gHiFracMax = Math.max(...gHiFracs)
const failures = []
if (gHiFracMax >= opts.hiFracMax) {
  failures.push(`g.hiFrac 最大 ${gHiFracMax} ≥ ${opts.hiFracMax}（B 通道去双重放大锚破——白雾回归）`)
}
if (aMeanAvg < opts.aMeanMin || aMeanAvg > opts.aMeanMax) {
  failures.push(`a.mean 全层均值 ${aMeanAvg} ∉ [${opts.aMeanMin}, ${opts.aMeanMax}]（extra perlin 内容锚破——恒 1 覆盖或全零回归）`)
}

console.log(JSON.stringify({
  seedOffset: result.seedOffset,
  slices: layerKeys.map(Number),
  perLayer: result.layers,
  anchors: {
    gHiFracMax,
    gHiFracLimit: opts.hiFracMax,
    aMeanAvg,
    aMeanRange: [opts.aMeanMin, opts.aMeanMax]
  },
  failures,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL'
}, null, 1))

if (failures.length > 0) process.exit(1)
