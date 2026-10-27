# 大气与体积云产品化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有大气与体积云封装成根包 `cesium-geospatial`，让团队项目通过 git submodule + `file:` 依赖，一行 `installAtmosphereClouds(viewer)` 接入。

**Architecture:** 根包是唯一产品包，构建期把 `packages/cesium-core` 与 `packages/cesium-clouds` 的源码 alias 进来打成自包含 ESM（Cesium external），通过 `install` 层统一处理资产、场景接管、stage 编排、失败回滚与生命周期。底层工厂通过 `./core` / `./clouds` 子路径保留为逃生门。

**Tech Stack:** TypeScript、Vite 6 lib mode、`vite-plugin-dts`（`bundleTypes`）、Vitest、Cesium 1.143（peer）、Node ESM CLI。

**Spec:** `docs/superpowers/specs/2026-10-27-productization-design.md`（v3）

## Global Constraints

- 所有代码注释、文档、commit 信息用中文。
- Cesium 走 `peerDependencies`：`">=1.143.0 <2.0.0"`；根包 `dependencies` 必须为空。
- 只发 ESM；`dist` 中不得出现 `?raw` 导入；不得出现第二份 Cesium。
- 资产文件名固定、随包分发、字节数固定：`transmittance.bin` 131072、`scattering.bin` 8388608、`higher_order_scattering.bin` 8388608、`irradiance.bin` 8192、`shape.bin` 2097152、`shape_detail.bin` 32768、`stbn.bin` 1048576。
- 不改任何渲染行为/画质；不打包 Cesium；不发 npm；不提交 `dist`。
- `install` 失败必须回滚；`destroy` 必须幂等并还原场景与释放纹理。
- 每个任务结束提交一次，commit 信息用 `feat:` / `fix:` / `test:` / `docs:` 前缀。

## Review Focus

- 缺失资产返回 200 text/html（`r.ok` 为真）：加载器必须按字节长度失败，报 URL、期望/实际字节与 Content-Type。
- 安装过程中 target 被销毁：不得留下 stage/纹理/preRender 回调，必须回滚并 `reject(InstallCancelledError)`。
- 宿主在安装期间改场景设置：`destroy` 按快照还原（文档化行为），不得写入已替换的 `scene.globe` 对象。
- 并发/重复 install（HMR、React StrictMode）：返回同一 handle，不得出现双份 stage 或双份纹理。
- 未验证的 Cesium 版本：只 `warn`；缺少 `Texture3D` / `fragmentDepth` / `depthTexture` 才 `throw`。

---

### Task 1: 根包构建骨架

**Files:**
- Modify: `package.json`
- Create: `vite.config.ts`、`tsconfig.json`、`vitest.config.ts`、`src/index.ts`、`src/core.ts`、`src/clouds.ts`、`src/version.ts`、`bin/lib/hash.mjs`、`scripts/write-build-stamp.mjs`、`scripts/assert-dist.mjs`

**Interfaces:**
- Produces：`dist/index.js`、`dist/core.js`、`dist/clouds.js` + 同名 `.d.ts` + `dist/build-stamp.json`（`{ version: string; sourceHash: string; entries: string[]; builtAt: string }`）；`hashSources(rootDir: string): string`（`bin/lib/hash.mjs`）。

- [ ] **Step 1: 安装根包依赖**

Run:
```bash
pnpm add -D cesium@^1.143.0 typescript@^5.9.2 vite@^6.0.0 vitest@^4.1.0 vite-plugin-dts@^5.1.2 @microsoft/api-extractor @types/node@^20
```

- [ ] **Step 2: 写 `package.json` 产品字段**

在现有根 `package.json` 中加入（保留现有 devDependencies）：
```json
{
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./core": { "types": "./dist/core.d.ts", "import": "./dist/core.js" },
    "./clouds": { "types": "./dist/clouds.d.ts", "import": "./dist/clouds.js" }
  },
  "bin": { "cesium-geospatial": "./bin/cli.mjs" },
  "files": ["dist", "assets", "docs", "bin", "README.md"],
  "sideEffects": false,
  "scripts": {
    "dev": "pnpm --filter demo dev",
    "build": "vite build && node scripts/write-build-stamp.mjs",
    "prepare": "pnpm run build",
    "test": "vitest run && pnpm -r test",
    "verify": "tsc --noEmit && vitest run && pnpm run build && node scripts/assert-dist.mjs"
  },
  "peerDependencies": { "cesium": ">=1.143.0 <2.0.0" }
}
```

- [ ] **Step 3: 写 `tsconfig.json`、`vitest.config.ts`、`vite.config.ts`**

`tsconfig.json`：
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@cesium-geospatial/core": ["packages/cesium-core/src/index.ts"],
      "@cesium-geospatial/clouds": ["packages/cesium-clouds/src/index.ts"]
    }
  },
  "include": ["src", "packages/*/src/**/*.d.ts"]
}
```

`vitest.config.ts`：`environment: 'node'`、`globals: true`、`include: ['src/**/*.test.ts']`（不设 include 会扫到 `packages/**` 的全量用例，缺 clouds 的 assetsInclude 且重复），alias 两条与上面相同。

`vite.config.ts`：
```ts
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'node:path'

const alias = {
  '@cesium-geospatial/core': resolve(__dirname, 'packages/cesium-core/src/index.ts'),
  '@cesium-geospatial/clouds': resolve(__dirname, 'packages/cesium-clouds/src/index.ts')
}

export default defineConfig({
  resolve: { alias },
  plugins: [
    dts({ bundleTypes: true, tsconfigPath: './tsconfig.json', entryRoot: 'src' })
  ],
  build: {
    lib: { entry: { index: 'src/index.ts', core: 'src/core.ts', clouds: 'src/clouds.ts' }, formats: ['es'] },
    rollupOptions: { external: ['cesium'], output: { entryFileNames: '[name].js' } }
  }
})
```
**d.ts 策略（先 spike，再定型）**：先用 `bundleTypes: true` 构建一次，`grep VERSION dist/index.d.ts`。实测跨私有包 alias 时 api-extractor 不跟随 `.ts` 路径，可能产出 `export {}`。若为空，按下面回退：

1. 两个内部包各自产出声明：`pnpm --dir packages/cesium-core exec tsc -p tsconfig.json --emitDeclarationOnly`（clouds 同），得到 `packages/*/dist/index.d.ts`；
2. 新建 `tsconfig.dts.json`：extends 根 tsconfig，但 `paths` 指向 `packages/*/dist/index.d.ts`；`vite-plugin-dts` 的 `tsconfigPath` 指向它（构建期 JS 的 alias 仍指源码，不受影响）；
3. 重新构建并断言 `dist/index.d.ts` 含 `VERSION`。

若当前 `vite-plugin-dts` 版本不认 `bundleTypes`（v5 之前叫 `rollupTypes`），用该版本对应选项名并在 `docs/api.md` 记录。

- [ ] **Step 4: 写入入口与哈希/盖章脚本**

`src/version.ts`：`export const VERSION = '0.1.0'`
`src/index.ts`：`export { VERSION } from './version'`
`src/core.ts`：`export * from '@cesium-geospatial/core'`
`src/clouds.ts`：`export * from '@cesium-geospatial/clouds'`

`bin/lib/hash.mjs`：导出 `hashSources(rootDir)`——遍历 `src/**` 与 `packages/*/src/**`，跳过 `*.test.ts`/`*.test.tsx`/`__snapshots__`，按相对路径排序后对 `路径\0内容` 求 `sha256`。

`scripts/write-build-stamp.mjs`：校验六个产物存在 → 计算 `sourceHash` → 写 `dist/build-stamp.json.tmp` 再 `rename` 为最终文件（原子写）。

`scripts/assert-dist.mjs`：断言六个产物存在、`dist/index.d.ts` **含 `VERSION` 字符串**（不能只查 `export`——空声明 `export {}` 也会通过）、`build-stamp.json` 可解析且 `entries` 长度 6。

- [ ] **Step 5: 构建并验证**

Run:
```bash
pnpm run build
node scripts/assert-dist.mjs
grep -c "?raw" dist/index.js dist/core.js dist/clouds.js || true
grep -q "VERSION" dist/index.d.ts && echo dts-ok
```
Expected: 构建成功；`assert-dist` 退出 0；三个 `?raw` 计数均为 `0`；输出 `dts-ok`。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml vite.config.ts tsconfig.json vitest.config.ts src bin/lib scripts
git commit -m "feat: 根包构建骨架（lib mode + d.ts + build-stamp）"
```

---

### Task 2: 资产迁移、copy-assets CLI 与 demo 静态服务

**Files:**
- Move: `apps/demo/public/luts` → `assets/luts`；`apps/demo/public/clouds` → `assets/clouds`；`apps/demo/public/atmosphere/moon-*.webp` → `assets/moon/`
- Modify: `apps/demo/vite.config.ts`
- Create: `bin/cli.mjs`
- Test: `src/cli.test.ts`

**Interfaces:**
- Produces：`node bin/cli.mjs copy-assets --out <dir>`（复制 `luts/`、`clouds/`、`moon/`）；`node bin/cli.mjs check --root <dir> [--copy <dir>]`（Task 1 的 stamp 校验）。

- [ ] **Step 1: 用 git mv 迁移资产**

```bash
mkdir -p assets
git mv apps/demo/public/luts assets/luts
git mv apps/demo/public/clouds assets/clouds
mkdir -p assets/moon
git mv apps/demo/public/atmosphere/moon-surface.webp assets/moon/moon-surface.webp
git mv apps/demo/public/atmosphere/moon-displacement.webp assets/moon/moon-displacement.webp
rmdir apps/demo/public/atmosphere 2>/dev/null || true
```

- [ ] **Step 2: 写失败测试 `src/cli.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
let out: string
beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'cg-assets-')) })
afterEach(() => rmSync(out, { recursive: true, force: true }))

describe('cli copy-assets', () => {
  it('复制三类资产并保持固定文件名与字节数', () => {
    execFileSync(process.execPath, [join(root, 'bin/cli.mjs'), 'copy-assets', '--out', out])
    expect(statSync(join(out, 'luts/transmittance.bin')).size).toBe(131072)
    expect(statSync(join(out, 'luts/scattering.bin')).size).toBe(8388608)
    expect(existsSync(join(out, 'clouds/shape.bin'))).toBe(true)
    expect(existsSync(join(out, 'moon/moon-surface.webp'))).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run src/cli.test.ts`
Expected: FAIL（`bin/cli.mjs` 不存在）。

- [ ] **Step 4: 实现 `bin/cli.mjs`**

纯 Node ESM，不 import `dist`。子命令：
- `copy-assets --out <dir>`：`fs.cpSync(<pkg>/assets/<kind>, join(out, kind), { recursive: true })`，三类逐个复制；缺少 `--out` 时退出码 1 并打印用法。
- `check --root <dir> [--copy <dir>]`：读 `<root>/dist/build-stamp.json`，用 `hashSources(<root>)` 重算并比较；`--copy` 时再比较 `<copy>/dist/build-stamp.json` 的 `sourceHash` 与 `<root>` 的一致；不一致退出码 1。
- 包根用 `fileURLToPath(import.meta.url)` 向上两级解析，保证在 submodule 内也能定位。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/cli.test.ts`
Expected: PASS。

- [ ] **Step 6: 更新 demo 的资产服务**

在 `apps/demo/vite.config.ts` 顶部加 `import { fileURLToPath } from 'node:url'`，取 `const assetsDir = fileURLToPath(new URL('../../assets/', import.meta.url))`，然后在 `viteStaticCopy` targets 末尾追加（保持 demo 现有 URL `/luts`、`/clouds`、`/atmosphere` 不变）：
```ts
{ src: `${assetsDir}luts`, dest: '.' },
{ src: `${assetsDir}clouds`, dest: '.' },
{ src: `${assetsDir}moon/*.webp`, dest: 'atmosphere' }
```
（必须用绝对路径：相对路径会让 viteStaticCopy 以 `apps/demo` 为 cwd 做 glob，实测返回空并抛 “No file was found to copy”。moon 用 `*.webp` 且 dest 为 `atmosphere`，否则会生成 `/atmosphere/moon/...` 与 demo 的 `/atmosphere/moon-surface.webp` 不符。）

- [ ] **Step 7: 冒烟 demo 仍能加载资产**

Run: `pnpm dev` 后访问 `?time=2026-09-26T17:00:00Z&play=0&fps=1`，确认控制台无 404、云与大气正常。
Expected: 无资产 404。

- [ ] **Step 8: 提交**

```bash
git add assets apps/demo/vite.config.ts bin/cli.mjs src/cli.test.ts
git commit -m "feat: 资产迁入根包并新增 copy-assets/check CLI"
```

---

### Task 3: 资产解析与加载器加固

**Files:**
- Create: `src/assets.ts`、`src/assets.test.ts`
- Modify: `packages/cesium-core/src/cesium/lutLoader.ts`、`packages/cesium-core/src/cesium/lutLoader.test.ts`
- Modify: `packages/cesium-core/src/cesium/cesiumCore.ts`（`buildAtmospherePrefix` 条件 define）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`（`higherOrderScattering` 选项与条件 binding）
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`（define 断言）
- Modify: `packages/cesium-clouds/src/weatherTextures.ts`；Create: `packages/cesium-clouds/src/weatherTextures.test.ts`

**Interfaces:**
- `ASSET_BYTES: Readonly<Record<string, number>>`
- `resolveAssetUrls(baseUrl?: string, overrides?: AssetOverrides): AssetUrls`，`AssetUrls = { luts: string; weather: string; moonSurface: string; moonDisplacement: string }`
- `fetchAsset(url: string, expectedBytes?: number, fetchImpl?: typeof fetch): Promise<ArrayBuffer>`
- `loadAtmosphereLUTs(context: Context, baseUrl: string, options?: { higherOrderScattering?: boolean }): Promise<AtmosphereLUTs>`（`AtmosphereLUTs.higherOrderScattering` 变为可选 `Texture3D`）
- `AtmosphereStageOptions.higherOrderScattering?: boolean`（默认 true）；`buildAtmospherePrefix(options?: { higherOrderScattering?: boolean })`
- `loadWeatherTextures(context: Context, baseUrl: string): Promise<WeatherTextures>`（签名不变，内部改用长度校验）

- [ ] **Step 1: 写失败测试 `src/assets.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { ASSET_BYTES, resolveAssetUrls, fetchAsset } from './assets'

describe('assets', () => {
  it('默认目录相对 document.baseURI 解析', () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/app/' })
    const urls = resolveAssetUrls()
    expect(urls.luts).toBe('https://example.test/app/cesium-geospatial-assets/luts/')
    expect(urls.weather).toBe('https://example.test/app/cesium-geospatial-assets/clouds/')
    expect(urls.moonSurface).toBe('https://example.test/app/cesium-geospatial-assets/moon/moon-surface.webp')
    vi.unstubAllGlobals()
  })

  it('长度不符时抛错并带 URL 与期望/实际字节', async () => {
    const html = '<!doctype html><html></html>'
    const fake = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(fetchAsset('/x/transmittance.bin', ASSET_BYTES.transmittance, fake as unknown as typeof fetch))
      .rejects.toThrow(/transmittance\.bin/)
    await expect(fetchAsset('/x/transmittance.bin', ASSET_BYTES.transmittance, fake as unknown as typeof fetch))
      .rejects.toThrow(/131072/)
  })

  it('r.ok 为 false 时抛错', async () => {
    const fake = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(fetchAsset('/x/shape.bin', ASSET_BYTES.shape, fake as unknown as typeof fetch)).rejects.toThrow(/404/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/assets.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/assets.ts`**

- `ASSET_BYTES` 按 Global Constraints 的七个数字写死；`local_weather.png` 与月面 webp 不列入字节表（用“非空 + 可解码”校验）。
- `resolveAssetUrls`：默认 base 为 `new URL('cesium-geospatial-assets/', document.baseURI).href`；Node 环境（`typeof document === 'undefined'`）回退到 `'/'`；`overrides` 逐项覆盖；每个目录末尾保留 `/`。
- `fetchAsset`：先 `fetch`，`!r.ok` 抛错（带 status）；拿 `arrayBuffer()`；`expectedBytes != null && byteLength !== expectedBytes` 抛错（消息含 URL、期望、实际、`content-type`）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/assets.test.ts`
Expected: PASS。

- [ ] **Step 5: 扩展 `lutLoader`（先写失败测试）**

在 `lutLoader.test.ts` 追加两个用例：
```ts
it('缺资产返回 HTML 时按字节数失败', async () => { /* mock fetch 返回短 HTML；expect reject /transmittance/ */ })
it('higherOrderScattering=false 时不请求 higher_order_scattering.bin', async () => {
  // mock fetch 记录 URL；loadAtmosphereLUTs(ctx, base, { higherOrderScattering: false })
  // expect(mockedUrls).not.toContain('higher_order_scattering.bin')
})
```
Run: `pnpm --dir packages/cesium-core exec vitest run src/cesium/lutLoader.test.ts` → FAIL。

- [ ] **Step 6: 实现 lutLoader 改动（含条件 define）**

- 用 `ASSET_BYTES`（从根包导入会形成 core→root 反向依赖，**不要**：在 `lutLoader.ts` 内本地定义同样的字节表，并在注释说明与根包一致）。
- 四个 fetch 改为 `fetchAsset`-等价逻辑（`!r.ok` + 字节校验）。
- `higherOrderScattering === false` 时**不请求**该文件，返回类型改为 `higherOrderScattering?: Texture3D`。
- **不要用 1×1 dummy 代替**：shader 会把它当真实高阶散射采样，改变大气亮度。正确做法是条件 binding：
  - `buildAtmospherePrefix()` 增加选项 `{ higherOrderScattering?: boolean }`（默认 true），仅 true 时输出 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE`。
  - `AtmosphereStageOptions` 增加 `higherOrderScattering?: boolean`（默认 true），`buildAtmosphereUniforms` 仅 true 时绑定真实 uniform `higher_order_scattering_texture`（`AtmosphereStage.ts:446`）。
- 在 `aerialPerspective.frag.test.ts` 增加一条断言：`higherOrderScattering:false` 时组装出的 shader 不含该 `#define`；默认含。

- [ ] **Step 7: 运行 core 测试确认通过**

Run: `pnpm --dir packages/cesium-core exec vitest run src/cesium/lutLoader.test.ts src/cesium/aerialPerspective.frag.test.ts`
Expected: PASS。

- [ ] **Step 8: 加固 `weatherTextures`（先写失败测试）**

Create `packages/cesium-clouds/src/weatherTextures.test.ts`：
```ts
it('shape.bin 长度不符（200 HTML）时 reject', async () => { /* mock fetch: shape 返回短 HTML，其余正常长度 */ })
it('stbn.bin 404 时 reject 且消息含 404', async () => { /* ... */ })
```
Run: `pnpm --dir packages/cesium-clouds exec vitest run src/weatherTextures.test.ts` → FAIL。

- [ ] **Step 9: 实现 weatherTextures 校验**

在 `weatherTextures.ts` 本地定义字节表（shape 2097152、shape_detail 32768、stbn 1048576），四个请求加 `!r.ok` 与字节校验；`local_weather.png` 校验非空。

- [ ] **Step 10: 跑两包测试并提交**

Run: `pnpm --dir packages/cesium-core test && pnpm --dir packages/cesium-clouds test`
Expected: 全绿。（**不要**用 `pnpm --filter ... test`——本仓库记录过该形式的假绿坑。）

```bash
git add src/assets.ts src/assets.test.ts \
  packages/cesium-core/src/cesium/lutLoader.ts packages/cesium-core/src/cesium/lutLoader.test.ts \
  packages/cesium-core/src/cesium/cesiumCore.ts packages/cesium-core/src/cesium/AtmosphereStage.ts \
  packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts \
  packages/cesium-clouds/src/weatherTextures.ts packages/cesium-clouds/src/weatherTextures.test.ts
git commit -m "feat: 资产长度校验与 higher_order 可选加载"
```

---

### Task 4: Cesium 兼容自检

**Files:**
- Create: `src/compat.ts`、`src/compat.test.ts`

**Interfaces:**
- `interface CompatInput { version: string; hasTexture3D: boolean; webgl2: boolean; fragmentDepth: boolean; depthTexture: boolean; hasGlobe: boolean; mode: number; scene3dMode: number }`
- `interface CompatResult { ok: boolean; warnings: string[]; errors: string[] }`
- `checkCompat(input: CompatInput, testedVersions?: readonly string[]): CompatResult`

- [ ] **Step 1: 写失败测试**

```ts
import { checkCompat } from './compat'

const base = { version: '1.143.0', hasTexture3D: true, webgl2: true, fragmentDepth: true, depthTexture: true, hasGlobe: true, mode: 3, scene3dMode: 3 }

it('未验证版本只 warn', () => {
  const r = checkCompat({ ...base, version: '1.144.2' }, ['1.143.0'])
  expect(r.ok).toBe(true)
  expect(r.warnings.join()).toMatch(/1\.144\.2/)
})
it('缺 Texture3D 时 error', () => {
  const r = checkCompat({ ...base, hasTexture3D: false }, ['1.143.0'])
  expect(r.ok).toBe(false)
  expect(r.errors.join()).toMatch(/Texture3D/)
})
it('非 WebGL2 或缺 fragmentDepth 时 error', () => {
  expect(checkCompat({ ...base, webgl2: false }, ['1.143.0']).ok).toBe(false)
  expect(checkCompat({ ...base, fragmentDepth: false }, ['1.143.0']).ok).toBe(false)
})
it('非 SCENE3D 时 error', () => {
  expect(checkCompat({ ...base, mode: 2 }, ['1.143.0']).ok).toBe(false)
})
```

- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run src/compat.test.ts` → FAIL。

- [ ] **Step 3: 实现 `checkCompat`**：纯函数；错误信息含当前版本与 `testedVersions.join(', ')`。

- [ ] **Step 4: 运行确认通过** — PASS。

- [ ] **Step 5: 提交**

```bash
git add src/compat.ts src/compat.test.ts
git commit -m "feat: Cesium 版本与能力自检"
```

---

### Task 5: 场景快照、接管与还原

**Files:**
- Create: `src/sceneTakeover.ts`、`src/sceneTakeover.test.ts`

**Interfaces:**
- `captureSceneState(scene: Scene): SceneState`
- `applySceneTakeover(scene: Scene, state: SceneState, opts: { enabled: boolean }): SceneTakeover`
- `interface SceneTakeover { restore(): void; readonly applied: boolean }`

**规则（必须写进注释）：** 无条件按快照还原；`scene.globe` 的属性记在捕获时的 globe 对象上；`takeOverScene:false` 时仍快照并还原 `depthTestAgainstTerrain`；还原 `requestRenderMode` 后调用 `scene.requestRender()`，但必须先 `scene.isDestroyed()` 守卫（Cesium 销毁后会把 `requestRender` 换成抛错版本）。

- [ ] **Step 1: 写失败测试**

用一个普通对象模拟 scene（`globe`、`skyAtmosphere`、`skyBox`、`sun`、`moon`、`fog`、`backgroundColor`、`requestRenderMode`、`requestRender: vi.fn()`），断言：
```ts
it('接管后所有字段为新值，restore 后逐项回到原值', () => { ... })
it('takeOverScene=false 时只快照 depthTestAgainstTerrain 并可还原', () => { ... })
it('宿主替换 globe 后不向新 globe 写旧值', () => {
  const scene = makeScene()
  const t = applySceneTakeover(scene, captureSceneState(scene), { enabled: true })
  scene.globe = makeGlobe() // 宿主替换
  t.restore()
  expect(scene.globe).not.toBe(originalGlobe) // 新对象保持自己的值
})
it('restore 后 requestRenderMode 恢复 true 时调用 requestRender', () => { ... })
it('scene 已销毁时 restore 不抛（requestRender 已被 Cesium 换成抛错版本）', () => {
  const scene = makeScene()
  const t = applySceneTakeover(scene, captureSceneState(scene), { enabled: true })
  scene.isDestroyed = () => true
  scene.requestRender = () => { throw new Error('requestRender called on destroyed scene') }
  expect(() => t.restore()).not.toThrow()
})
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 实现接管表**（12 项，见 spec §7.6；`moon` 不存在时跳过）。

- [ ] **Step 4: 运行确认通过** — PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sceneTakeover.ts src/sceneTakeover.test.ts
git commit -m "feat: 场景接管与无条件还原"
```

---

### Task 6: 月面纹理加载与合成

**Files:**
- Create: `src/moonTexture.ts`、`src/moonTexture.test.ts`
- Modify: `apps/demo/src/main.ts:296-369`（改为调用共享实现）

**Interfaces:**
- `modulateMoonPixels(base: Uint8ClampedArray, displacement: Uint8ClampedArray, scale: number, K?: number): { mean: number }`（原地修改 `base`，返回均值）
- `loadMoonTextures(context: Context, urls: { surface: string; displacement: string }, opts?: { displacementScale?: number }): Promise<{ texture: Texture; albedoMean: number } | undefined>`

- [ ] **Step 1: 写失败测试（纯函数部分）**

```ts
import { modulateMoonPixels } from './moonTexture'

it('以位移亮度均值为中心调制，均值处不变', () => {
  const base = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255])
  const disp = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255])
  modulateMoonPixels(base, disp, 1, 4)
  expect(base[0]).toBe(100)
})
it('正偏差变亮、负偏差变暗，且钳制在 [0.05,2]', () => {
  // disp 全白（正偏差）→ base 变亮；全黑（负偏差）→ 变暗
})
it('返回合成后均值（0-1）', () => { ... })
```
Run: `pnpm exec vitest run src/moonTexture.test.ts` → FAIL。

- [ ] **Step 2: 实现 `modulateMoonPixels`**（照搬 `main.ts:329-341` 的算法：两遍扫描、`K=4`、`clamp(0.05, 2)`）。

- [ ] **Step 3: 实现 `loadMoonTextures`**

用 `Resource.fetchImage` 加载两张 webp（`crossOrigin` 由调用方 URL 决定）；canvas 合成（照搬 `main.ts:316-353`）；`flipY: true`、`CLAMP_TO_EDGE`；降采样 256×128 算 `albedoMean`；任何失败 `console.warn` 并返回 `undefined`。

- [ ] **Step 4: 运行确认通过** — PASS。

- [ ] **Step 5: demo 改为调用共享实现**

`main.ts` 删除内联合成，改为：
```ts
const moon = await loadMoonTextures(context, {
  surface: '/atmosphere/moon-surface.webp',
  displacement: '/atmosphere/moon-displacement.webp'
}, { displacementScale: getNumber('moonDispScale') ?? 1 })
const moonSurfaceTexture = moon?.texture
const moonRadianceDefault = moon != null ? 1546 / moon.albedoMean : 1546
```
Run: `pnpm dev`，确认月面与原先一致（同机位截图对比）。

- [ ] **Step 6: 提交**

```bash
git add src/moonTexture.ts src/moonTexture.test.ts apps/demo/src/main.ts
git commit -m "feat: 月面纹理加载与合成共享实现，demo 改为复用"
```

---

### Task 7: demo 验收档单一来源

**Files:**
- Create: `src/demoProfile.ts`、`src/demoProfile.test.ts`
- Modify: `apps/demo/src/main.ts`（默认值改为从 profile 展开）

**Interfaces:**
- `DEMO_PROFILE: { atmosphere: Partial<AtmosphereStageOptions>; clouds: Partial<CloudsStageOptions>; moonRadianceBase: number }`

- [ ] **Step 1: 写失败测试**

```ts
import { DEMO_PROFILE } from './demoProfile'
it('固化 demo 拍板值', () => {
  expect(DEMO_PROFILE.atmosphere.groundShadowStrength).toBe(0.8)
  expect(DEMO_PROFILE.moonRadianceBase).toBe(1546)
})
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 实现 profile**

逐项核对 `apps/demo/src/main.ts` 中**无条件**传给 `createAtmosphereStage` / `createCloudsStage` 的值；只把与库缺省不同的项写进 profile。至少包含 `groundShadowStrength: 0.8` 与 `moonRadianceBase: 1546`。

- [ ] **Step 4: demo 改为展开 profile**

`const options: AtmosphereStageOptions = { ...DEMO_PROFILE.atmosphere, /* URL 参数覆盖 */ }`；云的 options 同理。跑 `pnpm dev` 确认默认画面未变。

- [ ] **Step 5: 运行测试并提交**

```bash
pnpm exec vitest run src/demoProfile.test.ts
git add src/demoProfile.ts src/demoProfile.test.ts apps/demo/src/main.ts
git commit -m "feat: demo 验收档单一来源"
```

---

### Task 8: core 多槽插入与 dummy 纹理销毁

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts:873-960`（插入逻辑）、`:624-671`（dummy）、`:1089-1104`（destroy）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.insert.test.ts`
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`
- Create: `packages/cesium-core/src/cesium/dummyTextures.ts`、`packages/cesium-core/src/cesium/dummyTextures.test.ts`

**Interfaces:**
- `insertStageBeforeLensFlare(stage, opts?: { protectedStage?: boolean })`：**追加**到有序列表，不销毁已有插入项；同一实例幂等。
- `removeInsertedStage(stage)`：按 identity 移除并销毁；`protectedStage`（install 自有的云 overlay）→ 抛错；未插入 → no-op。
- `dummyTextures.ts` 导出 `createCloudsShadowDummy(context)`、`createGroundShadowDummy(context)`、`createMoonSurfaceDummy(context)`，每个返回 `{ texture: Texture | Texture3D; destroy(): void }`，便于本地模块 mock 与销毁。

- [ ] **Step 1: 改写既有单槽测试并新增多槽测试**

`AtmosphereStage.insert.test.ts` 里两条用例依赖单槽语义，必须改写：
- “插入第二个 stage 替换第一个”（约 :239）→ 改为“两个都保留，顺序为插入顺序”；
- 回滚用例（约 :264）→ 改为多槽下的回滚（失败时恢复原链）。

再追加：
```ts
it('连续插入两个 stage 都保留，顺序与插入顺序一致', () => { ... })
it('removeInsertedStage 只销毁目标，另一个仍在链中', () => { ... })
it('移除未插入的 stage 为 no-op', () => { ... })
it('受保护的 stage 不能被 removeInsertedStage 移除', () => { ... })
```
Run: `pnpm --dir packages/cesium-core exec vitest run src/cesium/AtmosphereStage.insert.test.ts` → FAIL。

- [ ] **Step 2: 实现多槽**

把 `let insertedStage` 改为 `const insertedStages: Array<{ stage: PostProcessStage | PostProcessStageComposite; protectedStage: boolean }>`；插入去重、追加、重建链；`removeInsertedStage` 按 identity 查找（protected 抛错）后移除并销毁。回滚逻辑保持“失败时重建 lf/tm”。

- [ ] **Step 3: 运行确认通过** — PASS。

- [ ] **Step 4: dummy 抽模块 + 销毁测试**

把 `AtmosphereStage.ts:624-671` 的三段惰性构造抽到 `dummyTextures.ts`。测试用**本地模块 mock**（仓库既有范式：`vi.mock('./dummyTextures')`），不要 `vi.mock('cesium')`——Node 下真实 `new Texture/Texture3D` 会因 `maximumTextureSize=0` 爆掉（`AtmosphereStage.insert.test.ts:31` 已注明）。断言：调用 uniforms 闭包触发构造后 `handle.destroy()`，三个 `destroy()` 各被调用一次；`setMode` 重建时旧 dummy 先销毁再重建。

Run → FAIL。

- [ ] **Step 5: 实现 dummy 销毁**：`AtmosphereStage` 持有三个 `dummy` 句柄，`destroy()` 与 `setMode` 重建路径逐个销毁。

- [ ] **Step 6: 跑 core 全量测试并提交**

```bash
pnpm --dir packages/cesium-core exec vitest run
git add packages/cesium-core/src/cesium/AtmosphereStage.ts \
  packages/cesium-core/src/cesium/AtmosphereStage.insert.test.ts \
  packages/cesium-core/src/cesium/AtmosphereStage.test.ts \
  packages/cesium-core/src/cesium/dummyTextures.ts \
  packages/cesium-core/src/cesium/dummyTextures.test.ts
git commit -m "feat(core): 多槽插入与惰性 dummy 纹理销毁"
```

---

### Task 9: install 编排与失败回滚

**Files:**
- Create: `src/install.ts`、`src/install.test.ts`

**Interfaces:**
```ts
export interface InstallDeps {
  runCompat(scene: Scene): CompatResult          // 内部组装 CompatInput 后调用 Task 4 的纯函数 checkCompat
  loadLuts(context: Context, baseUrl: string, opts: { higherOrderScattering: boolean }): Promise<AtmosphereLUTs>
  loadWeather(context: Context, baseUrl: string): Promise<WeatherTextures>
  loadMoon(context: Context, urls: { surface: string; displacement: string }): Promise<{ texture: Texture; albedoMean: number } | undefined>
  createAtmosphere(scene: Scene, luts: AtmosphereLUTs, options: AtmosphereStageOptions): AtmosphereStageHandle
  createClouds(scene: Scene, luts: AtmosphereLUTs, weather: WeatherTextures, options: CloudsStageOptions): CloudsStageHandle | undefined
}
export async function installAtmosphereClouds(
  target: AtmosphereCloudsTarget,
  options?: InstallOptions
): Promise<AtmosphereCloudsHandle>            // = installWithDeps(target, options, defaultDeps)
export async function installWithDeps(
  target: AtmosphereCloudsTarget,
  options: InstallOptions | undefined,
  deps: InstallDeps
): Promise<AtmosphereCloudsHandle>
```
`AtmosphereCloudsTarget` / `InstallOptions` / `AtmosphereCloudsHandle` 的字段严格按 spec §8 实现（本任务实现这些类型，Task 11 只负责从 `index.ts` 导出）。`InstallDeps.runCompat` 与 Task 4 的纯函数 `checkCompat(input)` 不同名，避免调用点混淆。

- [ ] **Step 1: 写失败测试（happy path + 失败回滚 + quality 守卫）**

用 fake scene/deps（全部 `vi.fn`），断言：
```ts
it('默认装大气+云，并按顺序插入 overlay', async () => { /* createAtmosphere/createClouds 被调用；insertStageBeforeLensFlare 收到 overlay */ })
it('clouds:false 不加载天气、不传三个桥，并让 loadLuts/createAtmosphere 收到 higherOrderScattering:false', async () => {
  await installWithDeps(scene, { clouds: false }, deps)
  expect(deps.loadWeather).not.toHaveBeenCalled()
  expect(deps.loadLuts.mock.calls[0][2]).toEqual({ higherOrderScattering: false })
  expect(deps.createAtmosphere.mock.calls[0][2].higherOrderScattering).toBe(false)
  expect(deps.createAtmosphere.mock.calls[0][2].cloudsShadowLengthBridge).toBeUndefined()
})
it('桥闭包在云创建后指向真实 clouds handle', async () => {
  await installWithDeps(scene, {}, deps)
  const options = deps.createAtmosphere.mock.calls[0][2]
  expect(options.cloudsShadowLengthBridge!()).toBe(shadowLengthBridge)
  expect(options.cloudsOcclusionBridge!()).toBe(colorBridge)
  expect(options.cloudsShadowBridge!()).toBe(groundShadowBridge)
})
it('quality 未传时不调用 setQuality（不会因 undefined 崩）', async () => { ... })
it('既有 postProcessStages 非空时拒绝安装；allowExistingStages 放行', async () => { ... })
it('AO/BLOOM/FXAA 开启时 warn 但继续', async () => { ... })
it('runCompat 失败时零改动并抛错', async () => { ... })
it('log-depth 读回失败时还原场景并抛错', async () => { ... })
it('createAtmosphere 抛错时还原场景并抛错', async () => { ... })
it('loadMoon 返回 undefined 时继续，用白 dummy', async () => { ... })
it('createClouds 返回 undefined 视为失败，返回带 cloudsError 的 handle', async () => { ... })
it('云创建抛错时返回带 cloudsError 的 handle（大气保留）', async () => { ... })
it('overlay 插入失败时全量回滚：destroy clouds、释放全部纹理、destroy atmosphere、restore scene', async () => { ... })
it('资产加载失败时还原场景并抛错（不创建任何 stage）', async () => { ... })
it('destroy 按 stage→纹理顺序释放 4 LUT + 4 weather + 月面纹理', async () => { ... })
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 实现 `installWithDeps`**

严格按 spec §8.1 的 8 步；`defaultDeps` 用真实实现（`runCompat` 组 `CompatInput` 调 `checkCompat`、`loadAtmosphereLUTs`、`loadWeatherTextures`、`loadMoonTextures`、`createAtmosphereStage`、`createCloudsStage`）。要点：

- `clouds: false` 时把 `higherOrderScattering: false` 同时传给 `loadLuts` 与 `createAtmosphere`，且不传三个桥。
- `options.quality != null` 才调用 `setQuality`。
- handle 内部维护 `textures: Array<{ destroy(): void }>`（4 LUT + 4 weather + 月面合成）与 `hostStages: Set`：
  - 装云时用 `insertStageBeforeLensFlare(clouds.overlayStage, { protectedStage: true })`；
  - 宿主调 handle 的 `insertStageBeforeLensFlare(stage, opts)` 时转发到 atmosphere 并记入 `hostStages`；
  - `removeInsertedStage(stage)` 从集合移除并转发；
  - `destroy()` 先销毁 clouds、再移除/销毁 `hostStages`、再 destroy atmosphere、最后按 stage→纹理顺序逐个销毁 textures。
- 前置拒绝：`scene.postProcessStages.length > 0` 且 `!allowExistingStages` → 抛错（消息给迁移步骤）；AO/bloom/fxaa enabled → `console.warn`。
- `createClouds` 返回 `undefined` 视为失败（与抛错同样走 `cloudsError` 分支）。
- `autoDestroy` 在此任务只记录，Task 10 接生命周期。

- [ ] **Step 4: 运行确认通过** — PASS。

- [ ] **Step 5: 提交**

```bash
git add src/install.ts src/install.test.ts
git commit -m "feat: install 编排与失败回滚"
```

---

### Task 10: 生命周期（并发、取消、autoDestroy、HMR）

**Files:**
- Modify: `src/install.ts`、`src/install.test.ts`

**Interfaces:**
- `export function isInstalled(target: AtmosphereCloudsTarget): boolean` —— 只对**已安装完成**的 target 返回 true；安装中（pending）返回 false。
- `export class InstallCancelledError extends Error`
- `export function disposeAllForHmr(): void` —— 清空 pending/installed 两个 Map 并销毁所有已安装 handle。
- 模块级 `pending: Map<Scene, Promise<Handle>>` + `installed: Map<Scene, Handle>`（两个 Map，不用 Promise/Handle 混存）。
- 每个 target 上以 `Symbol` 存 `{ currentHandle, original }`，用于包装 `destroy` 与卸载。

- [ ] **Step 1: 写失败测试**

```ts
it('并发 install 返回同一 handle，createAtmosphere 只调用一次', async () => { ... })
it('安装中 target 被销毁 → reject InstallCancelledError 且无残留', async () => {
  // 用可控 deferred 卡住 loadLuts；在 pending 期间调用 viewer.destroy()
  // wrapper 同步置 cancel 并调用原 destroy；resolve deferred 后 install 应 reject
  // 断言：destroy 各 stage 调用次数为 0（GL 已释放不做 GL 销毁），restore 被调用，pending/installed 均无条目
})
it('销毁后两个 Map 均清理，可重新安装', async () => { ... })
it('重复 install 返回旧 handle 并 warn 第二次 options 未生效', async () => { ... })
it('isInstalled 在 pending 期间为 false，完成后为 true，destroy 后为 false', async () => { ... })
it('autoDestroy：先 handle.destroy，再原 destroy；handle.destroy 抛错时原 destroy 仍执行', async () => {
  // try { handle.destroy() } finally { original() } —— 用 vi.fn 记录顺序
})
it('destroy 后恢复原 viewer.destroy；重新安装再 destroy 不叠加包装', async () => {
  // destroy → 断言 viewer.destroy === original；reinstall → destroy → 仍 === original
})
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 实现生命周期**

- 包装 `destroy`：`original = target.destroy.bind(target)`；`target.destroy = () => { record.cancel?.(); try { record.currentHandle?.destroy() } finally { target.destroy = original; delete record; original() } }`（用 Symbol 记录，恢复原方法）。
- install 开始时创建 `{ cancel: undefined, currentHandle: undefined, original }` 记录；每步 `await` 后检查 `record.cancelled === true` 或 `scene.isDestroyed()`。
- 取消回滚：若 target 已销毁，**跳过** stage/纹理的 GL 销毁（Cesium 销毁后调用其 destroy 会抛），只清监听、pending/installed 条目；否则走正常回滚。
- 成功后：`pending.delete(scene)`、`installed.set(scene, handle)`；失败/取消：两者都删。
- handle.destroy：从 `installed` 删除；若 record.currentHandle 是自己，恢复原 `destroy` 并删记录。

- [ ] **Step 4: 运行确认通过** — PASS。

- [ ] **Step 5: 提交**

```bash
git add src/install.ts src/install.test.ts
git commit -m "feat: install 并发/取消/自动销毁"
```

---

### Task 10A: 3D 模式守卫与云停用

**Files:**
- Modify: `packages/cesium-core/src/cesium/platform/VolumetricPrimitive.ts`、`VolumetricPrimitive.test.ts`
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`、`createCloudsStage.test.ts`
- Modify: `src/install.ts`、`src/install.test.ts`

**Interfaces:**
- `VolumetricPrimitive.setEnabled(enabled: boolean): void`（切换底层 Cesium primitive 的 `show`；接口原本只有 update/isDestroyed/destroy）。
- `CloudsStageHandle.setEnabled(enabled: boolean): void`（同时设置 overlay stage 的 `enabled` 与 clouds pass 的 primitive）。
- install 注册 `scene.morphStart` / `scene.morphComplete`：`morphStart` 时把 atmosphere / tonemap / lensflare / depthTemporal 的 `enabled=false`，`clouds.setEnabled(false)`，并 warn 一次；`morphComplete` 且 `scene.mode === SCENE3D` 时恢复；destroy 移除监听。

- [ ] **Step 1: 写失败测试**

- `VolumetricPrimitive.test.ts`：`setEnabled(false)` 后底层 primitive 的 `show` 为 false；`setEnabled(true)` 恢复。
- `createCloudsStage.test.ts`：`handle.setEnabled(false)` 后 overlay `enabled=false` 且 primitive `setEnabled` 收到 false。
- `src/install.test.ts`：fake scene 的 `morphStart`/`morphComplete` 是 `addEventListener/removeEventListener` 记录器；触发 `morphStart` 断言各 stage 的 enabled 与 `setEnabled` 调用；`morphComplete` 回到 3D 后恢复；`destroy` 后监听计数为 0。

Run: `pnpm --dir packages/cesium-core exec vitest run src/cesium/platform/VolumetricPrimitive.test.ts && pnpm --dir packages/cesium-clouds exec vitest run src/createCloudsStage.test.ts && pnpm exec vitest run src/install.test.ts` → FAIL。

- [ ] **Step 2: 实现两层 `setEnabled`**

- `VolumetricPrimitive.ts`：给返回对象加 `setEnabled`，内部 `this._primitive.show = enabled`（找到底层 primitive 字段）。
- `createCloudsStage.ts`：`CloudsStageHandle` 加 `setEnabled`，转发到 overlay 与 clouds pass（pass 内部再转发给 primitive）。

- [ ] **Step 3: 实现 install 的 morph 守卫**

在 Task 10 的 listener 记录结构里加 `morphStart`/`morphComplete` 两个 remove 函数；destroy 时移除；`scene.isDestroyed()` 时跳过恢复。

- [ ] **Step 4: 跑测试并提交**

```bash
pnpm --dir packages/cesium-core exec vitest run src/cesium/platform/VolumetricPrimitive.test.ts
pnpm --dir packages/cesium-clouds exec vitest run src/createCloudsStage.test.ts
pnpm exec vitest run src/install.test.ts
git add packages/cesium-core/src/cesium/platform/VolumetricPrimitive.ts \
  packages/cesium-core/src/cesium/platform/VolumetricPrimitive.test.ts \
  packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts \
  src/install.ts src/install.test.ts
git commit -m "feat: 3D 模式守卫与云停用"
```

---

### Task 11: 公共 API 面与子路径

**Files:**
- Modify: `src/index.ts`、`src/version.ts`、`src/install.ts`
- Test: `src/index.test.ts`

**Interfaces:**
- `src/index.ts` 导出：`installAtmosphereClouds`、`isInstalled`、`InstallCancelledError`、`VERSION`；类型 `InstallOptions` / `AtmosphereCloudsHandle` / `AtmosphereCloudsTarget`，并**再导出** `AtmosphereStageOptions` / `CloudsStageOptions` / `CloudsQualityPreset`（消费者需要命名嵌套选项类型，spec §8 已列）。
- `install.ts` 导出 `disposeAllForHmr()`。

- [ ] **Step 1: 写失败测试（运行时 + 类型）**

```ts
import * as api from './index'
import type { InstallOptions, AtmosphereStageOptions, CloudsStageOptions, CloudsQualityPreset } from './index'

it('导出主入口与错误类型', () => {
  expect(typeof api.installAtmosphereClouds).toBe('function')
  expect(typeof api.isInstalled).toBe('function')
  expect(typeof api.InstallCancelledError).toBe('function')
  expect(typeof api.VERSION).toBe('string')
})

it('类型可被命名（编译期）', () => {
  const o: InstallOptions = { quality: 'high' as CloudsQualityPreset, atmosphere: {} as AtmosphereStageOptions, clouds: {} as CloudsStageOptions }
  expect(o.quality).toBe('high')
})
```

- [ ] **Step 2: 运行确认失败** — `pnpm exec vitest run src/index.test.ts` → FAIL。

- [ ] **Step 3: 补全导出与 HMR dispose**

`src/index.ts`：
```ts
export { installAtmosphereClouds, isInstalled, InstallCancelledError, disposeAllForHmr } from './install'
export type { InstallOptions, AtmosphereCloudsHandle, AtmosphereCloudsTarget, AtmosphereStageOptions, CloudsStageOptions, CloudsQualityPreset } from './install'
export { VERSION } from './version'

// Vite/vitest 下 import.meta.hot 可能不存在，用可选链
if (import.meta.hot) import.meta.hot.dispose(() => disposeAllForHmr())
```
（`disposeAllForHmr` 在 `install.ts` 内实现：清 pending/installed Map、恢复所有包装的 destroy、销毁全部 handle。）

- [ ] **Step 4: 跑测试 + 类型检查 + 构建断言**

```bash
pnpm exec vitest run src/index.test.ts
pnpm exec tsc --noEmit
pnpm run build
grep -q "installAtmosphereClouds" dist/index.d.ts && echo dts-api-ok
```

- [ ] **Step 5: 提交**

```bash
git add src/index.ts src/version.ts src/install.ts src/index.test.ts
git commit -m "feat: 公共 API 面与 HMR 清理"
```

---

### Task 12: `examples/basic`

**Files:**
- Create: `examples/basic/package.json`、`examples/basic/vite.config.ts`、`examples/basic/index.html`、`examples/basic/src/main.ts`、`examples/basic/README.md`

**Interfaces:**
- 示例只调用 `installAtmosphereClouds`；必须用 `file:../..` 依赖。

- [ ] **Step 1: 写示例**

`package.json`：
```json
{
  "name": "cesium-geospatial-basic-example",
  "private": true,
  "type": "module",
  "scripts": {
    "predev": "node ../../bin/cli.mjs copy-assets --out public/cesium-geospatial-assets",
    "dev": "vite",
    "prebuild": "node ../../bin/cli.mjs copy-assets --out public/cesium-geospatial-assets",
    "build": "vite build"
  },
  "dependencies": {
    "cesium": "^1.143.0",
    "cesium-geospatial": "file:../.."
  },
  "devDependencies": { "typescript": "^5.9.2", "vite": "^6.0.0", "vite-plugin-static-copy": "^2.2.0" }
}
```
`src/main.ts`：
```ts
import { Viewer } from 'cesium'
import { installAtmosphereClouds } from 'cesium-geospatial'

const viewer = new Viewer('cesiumContainer')
const handle = await installAtmosphereClouds(viewer, { quality: 'high' })
window.addEventListener('beforeunload', () => handle.destroy())
```
`vite.config.ts` 复制 demo 的 Cesium 静态资源 targets（Workers/Assets/ThirdParty/Widgets → `/cesium/`）；`index.html` 设 `window.CESIUM_BASE_URL='/cesium/'`。

- [ ] **Step 2: 构建根包后安装示例依赖**

```bash
pnpm run build
cd examples/basic && pnpm install --ignore-workspace && pnpm run build
```
Expected: 构建成功；`public/cesium-geospatial-assets` 下共有 **10 个**资产（luts 4 + clouds 4 + moon 2）。`--ignore-workspace` 必需：examples 不在 `pnpm-workspace.yaml` 内，直接 `pnpm install` 会按外层 workspace 作用域安装（实测“Scope: all N workspace projects”），示例自身没有 node_modules。

- [ ] **Step 3: 手动冒烟**

`cd examples/basic && pnpm dev`，打开页面：大气与云出现，控制台无 404、无 `?raw` 错误。

- [ ] **Step 4: 提交**

```bash
git add examples/basic
git commit -m "feat: examples/basic 接入示例"
```

---

### Task 13: 消费方冒烟矩阵

**Files:**
- Create: `scripts/smoke-consumers.mjs`
- Modify: `package.json`（`verify` 追加冒烟）

**Interfaces:**
- `node scripts/smoke-consumers.mjs`：在 `os.tmpdir()` 建三个 fixture，`pnpm install --offline`，构建，断言。

- [ ] **Step 0: 安装冒烟依赖**

```bash
pnpm add -D @rollup/plugin-node-resolve @rollup/plugin-commonjs webpack webpack-cli typescript
```
（webpack / typescript 不在仓库现有 devDeps 与本地 store 里，必须显式装。）

- [ ] **Step 1: 实现脚本**

对每个 fixture（vite / webpack / rollup）：
1. 写 `package.json`：`"cesium-geospatial": "file:<repo>"`、`"cesium": "1.143.0"`，外加该 fixture 自己的构建依赖（vite / webpack+webpack-cli / rollup+plugins / typescript）。
2. `pnpm install --prefer-offline`（`--offline` 会因 fixture 无 lockfile 报 `ERR_PNPM_NO_OFFLINE_META`）。
3. 写入口 `import { installAtmosphereClouds } from 'cesium-geospatial'`（只引用，不运行）。
4. 构建；Webpack/Rollup 配置 `external: ['cesium']`（否则测的是把 Cesium 打进 bundle，而不是库本身）。断言：
   - 产物不含 `?raw`；
   - **单份 Cesium 判据**：用 `createRequire` 从 fixture 入口与 `node_modules/cesium-geospatial/dist/index.js` 各解析一次 `cesium/package.json`，两者 realpath 相同；不是统计字符串出现次数。
   - `dist` 中无 `cesium-geospatial-assets` 的 `new URL`（copy-assets 方案下不应出现）。
5. `file:` 副本断言：`node_modules/cesium-geospatial` 下只有 `files` 列出的内容（无 `src`、无 `.git`、无 `node_modules`）。
6. 消费方 `tsc --noEmit`：fixture 写 `src/check.ts` 引用 `InstallOptions` 并构造一个对象，断言编译通过（验证 d.ts 非空、类型可命名）。

Vite dev 用例：fixture 先 `node <repo>/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets`，再 `vite dev` 起服务，`curl` `/` 与 `/cesium-geospatial-assets/luts/transmittance.bin`，断言 200 与 131072 字节。

**局限（写进脚本注释）**：fixture 只验证构建与类型，不执行真实渲染（无 WebGL）；真实渲染由 `examples/basic` 的手动验收覆盖。

- [ ] **Step 2: 运行**

Run: `pnpm run build && node scripts/smoke-consumers.mjs`
Expected: 三个 fixture 全绿；任一失败退出码非 0 并打印 fixture 日志。

- [ ] **Step 3: 接入 `verify`**

`"verify": "tsc --noEmit && vitest run && pnpm run build && node scripts/assert-dist.mjs && node scripts/smoke-consumers.mjs"`

- [ ] **Step 4: 提交**

```bash
git add scripts/smoke-consumers.mjs package.json
git commit -m "test: 消费方冒烟矩阵（Vite dev/build、Webpack、Rollup）"
```

---

### Task 14: 文档与最终验收

**Files:**
- Create: `docs/integration.md`、`docs/api.md`
- Modify: `README.md`（追加“作为库使用”一节，保留现有开发文档）

- [ ] **Step 1: 写 README 接入节**

四步：`git submodule add` → `pnpm --dir vendor/cesium-geospatial install`（构建）→ 首次 `node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets`（并给 `predev` 模板）→ 消费方 `"cesium-geospatial": "file:vendor/cesium-geospatial"`。附 10 行示例与已验证 Cesium 版本表（1.143.x）。

- [ ] **Step 2: 写 `docs/integration.md`**

选项表；场景接管全表（12 项）与“无条件还原”语义；既有 `postProcessStages` 迁移步骤（说明经 handle 插入拿到线性 HDR）；资产/CORS；销毁与并发；submodule 升级流程；已知影响（3D Tiles/labels 变暗、非 3D 模式禁用）。

- [ ] **Step 3: 写 `docs/api.md`**

`installAtmosphereClouds` / `isInstalled` / handle 方法 / 三个入口 / 类型索引；自建资产管线走 `./core`。

- [ ] **Step 4: 全量验证**

```bash
pnpm run verify
pnpm --dir packages/cesium-core exec vitest run
pnpm --dir packages/cesium-clouds exec vitest run
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
```
Expected: 全绿；core 354 + 新增用例、clouds 363 + 新增用例。

- [ ] **Step 5: 手动验收**

- `examples/basic`：`pnpm dev`，与 demo 同相机、同时间（`?time=2026-09-26T17:00:00Z&play=0`）截图对比，按仓库像素纪律判读（同构建两次取噪声地板）。
- 故意把资产目录改坏 → 报错含 URL/期望/实际/Content-Type。
- `node bin/cli.mjs check --root .` 在改动 `src` 后不重建 → 退出码 1。

- [ ] **Step 6: 提交**

```bash
git add README.md docs/integration.md docs/api.md
git commit -m "docs: 接入指南与 API 参考"
```

---

## Self-Review 记录

- **Spec 覆盖**：§5 约束 → Global Constraints；§7.1-7.3 → Task 1；§7.4 → Task 2/3；§7.5 → Task 3；§7.6 → Task 5/9/10A；§7.7 → Task 8；§8.1-8.3 → Task 9/10/11；§8.4 → Task 7；§8.5 → Task 8/9；§8.6 → Task 8；§9 → Task 14；§10 → Task 11/12/13/14；peer/版本表 → Task 1/4/14。
- **类型一致性**：`InstallDeps` 与 `installWithDeps` 在 Task 9 定义、Task 10 扩展；`SceneTakeover` 在 Task 5 定义、Task 9 消费；`AssetUrls` 在 Task 3 定义、Task 9 消费。
- **Review Focus 对应测试**：资产 200 HTML → Task 3；安装中销毁 → Task 10；宿主改设置 → Task 5；并发/重复 → Task 10；版本/能力 → Task 4。
