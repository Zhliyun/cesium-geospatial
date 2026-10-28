#!/usr/bin/env node
// 消费方冒烟矩阵（Task 13）：在 os.tmpdir() 里建独立 fixture，用 `file:<仓库根>` 安装
// 本包（pnpm 会按 package.json 的 files 字段打一份真实副本，不是软链），再用
// Vite dev / Vite build / Webpack 5 / Rollup 各自构建一遍，断言「产品级」保证：
//
//   1. 产物无 `?raw`（GLSL 源码在库构建期就已解析）；
//   2. 单份 Cesium：从 fixture 入口与 node_modules/cesium-geospatial/dist/index.js
//      各解析一次 `cesium/package.json`，realpath 必须相同（不是数出现次数）；
//   3. `file:` 副本只含 files 列出的内容（无 src、无 .git、node_modules 里只有 .bin）；
//   4. 资产走运行时 `document.baseURI` 解析，不被打包器当模块资源打进产物；
//   5. 消费方 `tsc --noEmit`（strict + skipLibCheck:false）能命名并构造公共类型；
//   6. Vite dev 下 `/`、`/src/main.js`、`/cesium-geospatial-assets/luts/transmittance.bin`
//      都返回 200，且 transmittance.bin 恰好 131072 字节。
//
// 局限（务必保留）：fixture 只验证构建与类型，**不执行真实渲染**（无 WebGL）。
// 真实渲染由 examples/basic 的手动验收覆盖。
//
// 与 brief 原始措辞的两处偏差（均已实测确认，非取巧）：
//   a. brief 写「dist 中无 `cesium-geospatial-assets` 的 `new URL`」——现行设计
//      （src/assets.ts）正是 `new URL('cesium-geospatial-assets/', document.baseURI)`，
//      该字面断言必然失败。真正要守的是「不做构建期相对解析」，因此改为断言：
//      产品 dist 的 JS 无 `import.meta`；消费方产物里资产目录只与 document.baseURI
//      同时出现；打包器没有 emit 任何 .bin 资产（若库用 new URL(..., import.meta.url)，
//      Vite 会把资产 emit 成文件）。
//   b. brief 写用 `<repo>/bin/cli.mjs` 跑 copy-assets；这里改用 fixture 内安装副本的
//      `node_modules/cesium-geospatial/bin/cli.mjs`——它同时验证 bin 与 assets 真的
//      进了 files 副本，是更强的消费方路径。
//
// 用法：
//   node scripts/smoke-consumers.mjs                  # 全部
//   node scripts/smoke-consumers.mjs vite webpack     # 只跑指定 fixture（调试用）
//   CG_SMOKE_KEEP=1 node scripts/smoke-consumers.mjs  # 失败/成功都保留临时目录
//
// 失败时：打印该 fixture 的完整日志与保留目录，最后以退出码 1 结束；成功即删目录。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const repoDist = join(repoRoot, 'dist')

// cesium 1.143.0 的 @cesium/engine 版本范围是 ^26.1.0，新版本删了它 re-export 的符号，
// 直接装最新会在 rollup 阶段报 "is not exported by"。examples/basic 用同样的 overrides 锁定。
const CESIUM_VERSION = '1.143.0'
const CESIUM_OVERRIDES = { '@cesium/engine': '26.1.0', '@cesium/widgets': '16.1.0' }

// fixture 的构建工具**钉精确版本**，取值与仓库根 pnpm-lock.yaml 解析出的版本逐位一致
// （vite 6.4.3 / webpack 5.112.2 / webpack-cli 7.2.3 / rollup 4.62.3 / 两个 rollup
// plugin / typescript 5.9.3）。fixture 没有 lockfile，写 ^x.y.z 会让 CI 冷缓存或元数据
// 刷新时解析出仓库从未测过的更高版本——门禁就跨机器、跨时间不可复现。升级根依赖后
// 必须同步改这里（这正是「与仓库根对齐」的字面含义，不是凑巧同版）。
const TOOL_VERSIONS = {
  vite: '6.4.3',
  webpack: '5.112.2',
  'webpack-cli': '7.2.3',
  rollup: '4.62.3',
  '@rollup/plugin-node-resolve': '16.0.3',
  '@rollup/plugin-commonjs': '29.0.3',
  typescript: '5.9.3'
}

const ASSET_DIR_NAME = 'cesium-geospatial-assets'
const TRANSMITTANCE_BYTES = 131072 // 256×64×RGBA×half-float(2B)
const ASSET_FILE_COUNT = 10 // luts 4 + clouds 4 + moon 2

const KEEP = process.env.CG_SMOKE_KEEP === '1'
const only = process.argv.slice(2)

// 各 fixture 共用的源码：只引用、不运行（无 WebGL）。
// 赋值到 globalThis 是必要的副作用——包的 sideEffects 为 false，若只写
// `export const x = typeof ...`，打包器会把整包摇掉，后面的断言就变成了对着空产物跑。
const MAIN_JS = `import { installAtmosphereClouds } from 'cesium-geospatial'

globalThis.__cgSmoke = typeof installAtmosphereClouds
`

// 消费方类型断言：全部用公开可命名的类型，并真的构造一个 InstallOptions
const CHECK_TS = `import {
  installAtmosphereClouds,
  type AtmosphereStageOptions,
  type CloudsQualityPreset,
  type CloudsStageOptions,
  type InstallOptions
} from 'cesium-geospatial'

const quality: CloudsQualityPreset = 'high'
const atmosphere: AtmosphereStageOptions = {}
const clouds: CloudsStageOptions = {}
const options: InstallOptions = { atmosphere, clouds, quality, assetsBaseUrl: '/custom-assets/' }

void installAtmosphereClouds
void options
`

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    // false 才能让 dist/*.d.ts 里的 Cesium 私有类型（Context/Texture3D…）真被解析，
    // 而不是靠跳过声明检查掩盖 TS2305
    skipLibCheck: false,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: []
  },
  include: ['src/check.ts']
}

/** 本任务累计的失败 fixture（跑完所有再统一退出，方便一次看全） */
const failures = []

/** 毫秒 → "1.2s" */
function fmtMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 写一组相对路径文件（自动建父目录） */
function writeFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content)
  }
}

/**
 * 执行命令并记录到 fixture 日志；失败时把 stdout/stderr 一并写进日志再抛出。
 * @param {string} command 可执行文件
 * @param {string[]} args 参数
 * @param {{ dir: string, log: string[] }} ctx fixture 上下文
 * @returns {string} stdout
 */
function run(command, args, ctx) {
  const display = [command, ...args].join(' ')
  ctx.log.push(`$ ${display}`)
  try {
    const stdout = execFileSync(command, args, {
      cwd: ctx.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    if (stdout.trim() !== '') ctx.log.push(stdout.trimEnd())
    return stdout
  } catch (error) {
    if (error.stdout) ctx.log.push(String(error.stdout).trimEnd())
    if (error.stderr) ctx.log.push(String(error.stderr).trimEnd())
    throw new Error(`命令失败（退出码 ${error.status ?? '?'}）：${display}`)
  }
}

/** 递归列出目录下所有文件（相对路径，posix 分隔）；目录不存在返回空数组 */
function listFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absPath = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absPath))
    else files.push(absPath)
  }
  return files
}

/** 等待 check() 返回真值；超时或 check 抛错即失败 */
async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** 取一个空闲端口（listen 0 再关掉；dev server 用 --strictPort 钉死） */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 产品 dist 的前置断言：已构建、且库内没有任何构建期相对解析。
 * 后者是 copy-assets 方案的核心——库若写 new URL(x, import.meta.url)，打包器会把它
 * 当成模块资源处理（Vite 直接 emit 文件、Webpack 生成 require 上下文），资产路径就
 * 与消费方的 public 布局脱钩了。
 */
function assertProductDist() {
  if (!existsSync(join(repoDist, 'index.js')) || !existsSync(join(repoDist, 'index.d.ts'))) {
    throw new Error(`缺少 dist 产物：请先执行 pnpm run build（${repoDist}）`)
  }
  const chunks = readdirSync(repoDist).filter((name) => name.endsWith('.js'))
  const withImportMeta = chunks.filter((name) =>
    readFileSync(join(repoDist, name), 'utf8').includes('import.meta')
  )
  assert.deepEqual(withImportMeta, [], '产品 dist 的 JS 里出现 import.meta（构建期相对解析会破坏打包）')
  console.log(`[smoke] 前置检查通过：dist ${chunks.length} 个 chunk 均无 import.meta`)
}

/**
 * 自检：TOOL_VERSIONS 必须与仓库根「已安装版本」（= 根 lockfile 的解析结果）逐位一致。
 * 这样升级根 devDeps 却忘了同步 fixture 钉版时，冒烟会直接报错，而不是悄悄测出另一套版本。
 * 根 node_modules 里没有的工具（rollup 是 vite 的传递依赖、未被提升）跳过。
 */
function assertToolVersionsAligned() {
  const mismatches = []
  for (const [name, pinned] of Object.entries(TOOL_VERSIONS)) {
    const manifestPath = join(repoRoot, 'node_modules', name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const actual = JSON.parse(readFileSync(manifestPath, 'utf8')).version
    if (actual !== pinned) mismatches.push(`${name}: 根=${actual} / TOOL_VERSIONS=${pinned}`)
  }
  assert.deepEqual(
    mismatches,
    [],
    `构建工具版本与仓库根不一致（先 pnpm install，或同步 TOOL_VERSIONS）：\n${mismatches.join('\n')}`
  )
  console.log(`[smoke] 构建工具钉版与仓库根一致：${Object.keys(TOOL_VERSIONS).length} 项已核对`)
}

/** fixture 的 package.json：file:<仓库根> + 固定 Cesium + 各自构建依赖 */
function fixtureManifest(name, devDependencies) {
  return {
    name: `cg-smoke-${name}`,
    private: true,
    type: 'module',
    dependencies: {
      cesium: CESIUM_VERSION,
      'cesium-geospatial': `file:${repoRoot}`
    },
    devDependencies,
    pnpm: { overrides: CESIUM_OVERRIDES }
  }
}

/** 写 fixture 公共文件（package.json / 入口 / 类型断言 / tsconfig） */
function writeFixtureBase(ctx, name, devDependencies, extraFiles = {}) {
  writeFiles(ctx.dir, {
    'package.json': `${JSON.stringify(fixtureManifest(name, devDependencies), null, 2)}\n`,
    'src/main.js': MAIN_JS,
    'src/check.ts': CHECK_TS,
    'tsconfig.json': `${JSON.stringify(TSCONFIG, null, 2)}\n`,
    ...extraFiles
  })
}

/** pnpm install：--prefer-offline 复用 store 硬链接（--offline 会因无 lockfile 报 ERR_PNPM_NO_OFFLINE_META） */
function install(ctx) {
  const started = Date.now()
  run('pnpm', ['install', '--prefer-offline'], ctx)
  ctx.timings.install = Date.now() - started
}

/** 断言 1：产物无 ?raw */
function assertNoRaw(ctx, outText, label) {
  assert.ok(!outText.includes('?raw'), `${label}: 产物出现 ?raw（GLSL 源码未被库构建解析）`)
  ctx.checks.push('无?raw')
}

/** 断言 2：单份 Cesium（两份解析的 realpath 相同） */
function assertSingleCesium(ctx) {
  const fromFixture = createRequire(join(ctx.dir, 'package.json'))
  const fromPackage = createRequire(join(ctx.dir, 'node_modules/cesium-geospatial/dist/index.js'))
  const a = realpathSync(fromFixture.resolve('cesium/package.json'))
  const b = realpathSync(fromPackage.resolve('cesium/package.json'))
  assert.equal(a, b, `单份 Cesium 判据失败：fixture=${a} / 副本=${b}`)
  ctx.checks.push('单份Cesium')
}

/** 断言 3：file: 副本是真实拷贝，且只含 files 列出的内容 */
function assertFileCopy(ctx) {
  const pkgDir = join(ctx.dir, 'node_modules/cesium-geospatial')
  assert.ok(existsSync(pkgDir), 'node_modules/cesium-geospatial 不存在')

  // pnpm 的 file: 目录依赖会实体化（硬链接）成 .pnpm 下的真实目录；若是链回仓库本体的软链，
  // src/.git 会跟着露出来，files 白名单就等于没测
  const realPkg = realpathSync(pkgDir)
  assert.ok(
    !realPkg.startsWith(repoRoot + sep),
    `副本指向仓库本体（软链）而不是实体拷贝：${realPkg}`
  )

  const entries = readdirSync(pkgDir).sort()
  const allowed = new Set(['README.md', 'assets', 'bin', 'dist', 'dist-iife', 'docs', 'node_modules', 'package.json'])
  const unexpected = entries.filter((name) => !allowed.has(name))
  assert.deepEqual(unexpected, [], `副本含 files 之外的内容：${unexpected.join(', ')}`)
  assert.ok(!entries.includes('src'), '副本里出现了 src（files 白名单失效）')
  assert.ok(!entries.includes('.git'), '副本里出现了 .git（files 白名单失效）')
  assert.ok(entries.includes('dist'), '副本里没有 dist（消费方拿不到产物）')
  assert.ok(entries.includes('dist-iife'), '副本里没有 dist-iife（UMD 宿主拿不到 IIFE 产物）')

  // pnpm 会给带 bin 的包写一个 node_modules/.bin 转发脚本；除此之外不允许有依赖目录
  const nested = entries.includes('node_modules')
    ? readdirSync(join(pkgDir, 'node_modules')).filter((name) => name !== '.bin')
    : []
  assert.deepEqual(nested, [], `副本的 node_modules 下有依赖目录：${nested.join(', ')}`)

  ctx.checks.push(`副本${entries.length}项`)
}

/** 断言 4：资产在运行时按 document.baseURI 解析，不被打包器当模块资源打进去 */
function assertAssetsAtRuntime(ctx, outText, emittedDirs) {
  assert.ok(outText.includes(ASSET_DIR_NAME), '产物里找不到资产目录字符串（安装路径被摇掉了？）')
  assert.ok(outText.includes('document.baseURI'), '产物里资产未以 document.baseURI 为运行时基准')

  // brief 的字面要求「无 cesium-geospatial-assets 的 new URL」与现行设计（new URL(dir,
  // document.baseURI)）冲突，这里落到真正要守的判据上：资产目录附近不得出现
  // import.meta.url——那才是会被打包器当成构建期资源、把资产 emit 进产物的写法。
  for (let i = outText.indexOf(ASSET_DIR_NAME); i !== -1; i = outText.indexOf(ASSET_DIR_NAME, i + 1)) {
    const nearby = outText.slice(Math.max(0, i - 200), i + ASSET_DIR_NAME.length + 200)
    assert.ok(!nearby.includes('import.meta.url'), '资产目录紧邻 import.meta.url：会被打包器当成构建期资源')
  }

  // 兜底判据：打包器若真的按 new URL / ?url 处理过资产，就会 emit 出 .bin 文件
  const emittedBins = emittedDirs.flatMap((dir) => listFiles(dir)).filter((file) => file.endsWith('.bin'))
  assert.deepEqual(emittedBins, [], `打包器把资产文件打进了产物：${emittedBins.join(', ')}`)
  ctx.checks.push('资产运行时解析')
}

/** 断言 5：消费方 tsc --noEmit（strict + skipLibCheck:false）零错误 */
function assertConsumerTypes(ctx) {
  run(
    process.execPath,
    [
      join(ctx.dir, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '-p',
      join(ctx.dir, 'tsconfig.json')
    ],
    ctx
  )
  ctx.checks.push('tsc零错')
}

/** 跑完所有共享断言 */
function assertShared(ctx, { outputDir, outText, emittedDirs }) {
  const label = ctx.name
  assertNoRaw(ctx, outText, label)
  assertSingleCesium(ctx)
  assertFileCopy(ctx)
  assertAssetsAtRuntime(ctx, outText, emittedDirs)
  assertConsumerTypes(ctx)
  assert.ok(existsSync(outputDir), `${label}: 缺少构建产物目录 ${outputDir}`)
}

/**
 * 跑一个 fixture：成功删除临时目录，失败保留并把日志挂到 failures。
 * @param {string} name fixture 名
 * @param {(ctx: object) => Promise<void>} body fixture 主体
 */
async function runFixture(name, body) {
  const dir = mkdtempSync(join(tmpdir(), `cg-smoke-${name}-`))
  const ctx = { name, dir, log: [], checks: [], timings: {} }
  const started = Date.now()
  console.log(`\n[smoke:${name}] 开始（临时目录 ${dir}）`)
  try {
    await body(ctx)
    ctx.timings.total = Date.now() - started
    if (!KEEP) rmSync(dir, { recursive: true, force: true })
    else console.log(`[smoke:${name}] CG_SMOKE_KEEP=1，保留 ${dir}`)
    const detail = Object.entries(ctx.timings)
      .map(([key, ms]) => `${key}=${fmtMs(ms)}`)
      .join(' ')
    console.log(`[smoke:${name}] 通过：${ctx.checks.join(' / ')}（${detail}）`)
  } catch (error) {
    ctx.timings.total = Date.now() - started
    console.error(`[smoke:${name}] 失败：${error instanceof Error ? error.message : String(error)}`)
    failures.push(ctx)
  }
}

/** Vite fixture：copy-assets → dev server（curl 三个 URL）→ build → 共享断言 */
async function viteFixture(ctx) {
  writeFixtureBase(
    ctx,
    'vite',
    { vite: TOOL_VERSIONS.vite, typescript: TOOL_VERSIONS.typescript },
    {
      'index.html': `<!doctype html>
<html>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`
    }
  )
  install(ctx)

  // copy-assets 走「安装副本」里的 CLI：同时验证 bin 与 assets 真进了 files 副本
  const started = Date.now()
  run(
    process.execPath,
    [
      join(ctx.dir, 'node_modules/cesium-geospatial/bin/cli.mjs'),
      'copy-assets',
      '--out',
      `public/${ASSET_DIR_NAME}`
    ],
    ctx
  )
  ctx.timings['copy-assets'] = Date.now() - started
  assertCopiedAssets(ctx)
  ctx.checks.push(`copy-assets${ASSET_FILE_COUNT}文件`)

  const devStarted = Date.now()
  await checkViteDev(ctx)
  ctx.timings['vite-dev'] = Date.now() - devStarted
  ctx.checks.push('dev三URL')

  const buildStarted = Date.now()
  run(process.execPath, [join(ctx.dir, 'node_modules/vite/bin/vite.js'), 'build'], ctx)
  ctx.timings['vite-build'] = Date.now() - buildStarted

  const assetsDir = join(ctx.dir, 'dist', 'assets')
  const jsFiles = listFiles(assetsDir).filter((file) => file.endsWith('.js'))
  assert.ok(jsFiles.length > 0, 'vite build 没有产出 JS chunk')
  const outText = jsFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  // 只把 dist/assets 当「打包器 emit 目录」：public/ 的资产被原样拷进 dist/ 是预期行为
  assertShared(ctx, { outputDir: join(ctx.dir, 'dist'), outText, emittedDirs: [assetsDir] })
}

/** 断言 copy-assets 的产物：三个目录、10 个文件、transmittance 恰好 131072 字节 */
function assertCopiedAssets(ctx) {
  const root = join(ctx.dir, 'public', ASSET_DIR_NAME)
  assert.ok(existsSync(root), `copy-assets 未产出 ${root}`)
  const kinds = readdirSync(root).sort()
  assert.deepEqual(kinds, ['clouds', 'luts', 'moon'], `资产目录不符：${kinds.join(', ')}`)
  const count = kinds.reduce((sum, kind) => sum + readdirSync(join(root, kind)).length, 0)
  assert.equal(count, ASSET_FILE_COUNT, `资产文件数应为 ${ASSET_FILE_COUNT}，实际 ${count}`)
  const transmittance = join(root, 'luts', 'transmittance.bin')
  assert.equal(statSync(transmittance).size, TRANSMITTANCE_BYTES, 'transmittance.bin 尺寸不符')
}

/** 起 Vite dev，断言 `/`、`/src/main.js`、资产 200 且字节数正确 */
async function checkViteDev(ctx) {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    [
      join(ctx.dir, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort'
    ],
    { cwd: ctx.dir, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let exited = false
  child.on('exit', (code, signal) => {
    exited = true
    ctx.log.push(`[vite dev] 退出 code=${code} signal=${signal}`)
  })
  child.stdout.on('data', (data) => ctx.log.push(`[vite dev] ${String(data).trimEnd()}`))
  child.stderr.on('data', (data) => ctx.log.push(`[vite dev] ${String(data).trimEnd()}`))

  try {
    await waitUntil(
      async () => {
        if (exited) throw new Error('vite dev 提前退出（见日志）')
        try {
          const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) })
          return response.status === 200
        } catch {
          return false
        }
      },
      60000,
      'vite dev 就绪'
    )

    const index = await fetch(`${url}/`)
    assert.equal(index.status, 200, `GET / 返回 ${index.status}`)

    // 取模块本身会触发依赖预打包（cesium / cesium-geospatial），失败会在这里 500
    const main = await fetch(`${url}/src/main.js`)
    assert.equal(main.status, 200, `GET /src/main.js 返回 ${main.status}`)
    assert.ok(!(await main.text()).includes('?raw'), 'dev 下 /src/main.js 含 ?raw')

    const asset = await fetch(`${url}/${ASSET_DIR_NAME}/luts/transmittance.bin`)
    assert.equal(asset.status, 200, `GET 资产返回 ${asset.status}（public 未生效？）`)
    const bytes = Buffer.from(await asset.arrayBuffer())
    assert.equal(bytes.length, TRANSMITTANCE_BYTES, `transmittance.bin 实际 ${bytes.length} 字节`)
  } finally {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 5000))])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

/** Webpack 5 fixture：external cesium，构建成单文件 bundle */
async function webpackFixture(ctx) {
  writeFixtureBase(
    ctx,
    'webpack',
    {
      webpack: TOOL_VERSIONS.webpack,
      'webpack-cli': TOOL_VERSIONS['webpack-cli'],
      typescript: TOOL_VERSIONS.typescript
    },
    {
      // fixture 是 type: module，webpack 配置走 .cjs
      'webpack.config.cjs': `const path = require('node:path')

module.exports = {
  mode: 'production',
  entry: './src/main.js',
  devtool: false,
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js' },
  // Cesium 外置：否则测的是把整个 Cesium 打进 bundle，而不是库本身
  externals: { cesium: 'cesium' },
  // 不压缩：断言读字符串，压缩会让失败排查变难
  optimization: { minimize: false }
}
`
    }
  )
  install(ctx)

  const started = Date.now()
  run(
    process.execPath,
    [
      join(ctx.dir, 'node_modules/webpack-cli/bin/cli.js'),
      '--config',
      join(ctx.dir, 'webpack.config.cjs')
    ],
    ctx
  )
  ctx.timings['webpack-build'] = Date.now() - started

  const outFile = join(ctx.dir, 'dist', 'bundle.js')
  assert.ok(existsSync(outFile), 'webpack 未产出 dist/bundle.js')
  const outText = readFileSync(outFile, 'utf8')
  // 外置是否真的生效：bundle 里不该出现 Cesium 的实现
  assert.ok(!outText.includes('buildModuleUrl'), 'webpack 产物包含 Cesium 实现（externals 未生效）')
  ctx.checks.push('cesium外置')
  assertShared(ctx, { outputDir: join(ctx.dir, 'dist'), outText, emittedDirs: [join(ctx.dir, 'dist')] })
}

/** Rollup fixture：node-resolve + commonjs，external cesium */
async function rollupFixture(ctx) {
  writeFixtureBase(
    ctx,
    'rollup',
    {
      rollup: TOOL_VERSIONS.rollup,
      '@rollup/plugin-node-resolve': TOOL_VERSIONS['@rollup/plugin-node-resolve'],
      '@rollup/plugin-commonjs': TOOL_VERSIONS['@rollup/plugin-commonjs'],
      typescript: TOOL_VERSIONS.typescript
    },
    {
      'rollup.config.mjs': `import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'

export default {
  input: 'src/main.js',
  external: ['cesium'],
  plugins: [nodeResolve(), commonjs()],
  output: { file: 'dist/bundle.js', format: 'es' }
}
`
    }
  )
  install(ctx)

  const started = Date.now()
  run(
    process.execPath,
    [join(ctx.dir, 'node_modules/rollup/dist/bin/rollup'), '-c', join(ctx.dir, 'rollup.config.mjs')],
    ctx
  )
  ctx.timings['rollup-build'] = Date.now() - started

  const outFile = join(ctx.dir, 'dist', 'bundle.js')
  assert.ok(existsSync(outFile), 'rollup 未产出 dist/bundle.js')
  const outText = readFileSync(outFile, 'utf8')
  assert.ok(!outText.includes('buildModuleUrl'), 'rollup 产物包含 Cesium 实现（external 未生效）')
  ctx.checks.push('cesium外置')
  assertShared(ctx, { outputDir: join(ctx.dir, 'dist'), outText, emittedDirs: [join(ctx.dir, 'dist')] })
}

async function main() {
  assertProductDist()
  assertToolVersionsAligned()

  const started = Date.now()
  const fixtures = [
    ['vite', viteFixture],
    ['webpack', webpackFixture],
    ['rollup', rollupFixture]
  ]
  const selected = fixtures.filter(([name]) => only.length === 0 || only.includes(name))
  if (selected.length === 0) {
    throw new Error(`未知 fixture：${only.join(', ')}（可选：vite / webpack / rollup）`)
  }
  for (const [name, body] of selected) {
    await runFixture(name, body)
  }

  const elapsed = fmtMs(Date.now() - started)
  if (failures.length > 0) {
    for (const ctx of failures) {
      console.error(`\n===== fixture ${ctx.name} 失败日志（目录 ${ctx.dir}）=====`)
      console.error(ctx.log.join('\n'))
    }
    console.error(`\n[smoke] ${failures.length} 个 fixture 失败（总耗时 ${elapsed}），临时目录已保留`)
    process.exitCode = 1
    return
  }

  const labels = { vite: 'Vite dev + Vite build', webpack: 'Webpack 5', rollup: 'Rollup' }
  const names = selected.map(([name]) => labels[name]).join(' + ')
  console.log(`\n[smoke] 全部通过：${names}（总耗时 ${elapsed}）`)
}

main().catch((error) => {
  // 断言失败本身就是结论（前置检查的版本/产物不一致），栈没有信息量；其余异常打栈便于定位
  const isAssertion = error instanceof Error && error.name === 'AssertionError'
  const detail =
    error instanceof Error ? (isAssertion ? error.message : error.stack ?? error.message) : String(error)
  console.error(`[smoke] 致命错误：${detail}`)
  process.exitCode = 1
})
