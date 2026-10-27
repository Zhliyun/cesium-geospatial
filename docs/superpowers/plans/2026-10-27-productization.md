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
    "build": "vite build && node scripts/write-build-stamp.mjs",
    "prepare": "pnpm run build",
    "test": "vitest run",
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
  "include": ["src"]
}
```

`vitest.config.ts`：`environment: 'node'`、`globals: true`，alias 两条与上面相同。

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
注：若当前 `vite-plugin-dts` 版本报“未知选项 bundleTypes”，改用该版本对应选项名（≤4.x 为 `rollupTypes`），并在 `docs/api.md` 记录版本。

- [ ] **Step 4: 写入入口与哈希/盖章脚本**

`src/version.ts`：`export const VERSION = '0.1.0'`
`src/index.ts`：`export { VERSION } from './version'`
`src/core.ts`：`export * from '@cesium-geospatial/core'`
`src/clouds.ts`：`export * from '@cesium-geospatial/clouds'`

`bin/lib/hash.mjs`：导出 `hashSources(rootDir)`——遍历 `src/**` 与 `packages/*/src/**`，跳过 `*.test.ts`/`*.test.tsx`/`__snapshots__`，按相对路径排序后对 `路径\0内容` 求 `sha256`。

`scripts/write-build-stamp.mjs`：校验六个产物存在 → 计算 `sourceHash` → 写 `dist/build-stamp.json.tmp` 再 `rename` 为最终文件（原子写）。

`scripts/assert-dist.mjs`：断言六个产物存在、`dist/index.d.ts` 含 `export`、`build-stamp.json` 可解析且 `entries` 长度 6。

- [ ] **Step 5: 构建并验证**

Run:
```bash
pnpm run build && node scripts/assert-dist.mjs && grep -c "?raw" dist/index.js dist/core.js dist/clouds.js
```
Expected: 构建成功；`assert-dist` 无输出退出 0；三个 grep 结果均为 `0`（grep 无匹配时退出码 1，用 `|| true` 包一层）。

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
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
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

在 `apps/demo/vite.config.ts` 的 `viteStaticCopy` targets 末尾追加（保持 demo 现有 URL `/luts`、`/clouds`、`/atmosphere` 不变）：
```ts
{ src: '../../assets/luts', dest: '.' },
{ src: '../../assets/clouds', dest: '.' },
{ src: '../../assets/moon', dest: 'atmosphere' }
```

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
  - `AtmosphereStageOptions` 增加 `higherOrderScattering?: boolean`（默认 true），`buildAtmosphereUniforms` 仅 true 时绑定 `u_higherOrderScattering`。
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

Run: `pnpm --filter @cesium-geospatial/core test && pnpm --filter @cesium-geospatial/clouds test`
Expected: 全绿。

```bash
git add src/assets.ts src/assets.test.ts packages/cesium-core/src/cesium/lutLoader.ts packages/cesium-core/src/cesium/lutLoader.test.ts packages/cesium-clouds/src/weatherTextures.ts packages/cesium-clouds/src/weatherTextures.test.ts
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

**规则（必须写进注释）：** 无条件按快照还原；`scene.globe` 的属性记在捕获时的 globe 对象上；`takeOverScene:false` 时仍快照并还原 `depthTestAgainstTerrain`；还原 `requestRenderMode` 后调用 `scene.requestRender()`。

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

**Interfaces:**
- `AtmosphereStageHandle.insertStageBeforeLensFlare(stage)`：**追加**到有序列表，不销毁已有插入项。
- `AtmosphereStageHandle.removeInsertedStage(stage)`：只移除并销毁该项；传入 install 自有的 stage（云 overlay 由上层标记）→ 抛错；未插入 → no-op。

- [ ] **Step 1: 写失败测试**

在 `AtmosphereStage.insert.test.ts` 追加：
```ts
it('连续插入两个 stage 都保留，顺序与插入顺序一致', () => { ... })
it('removeInsertedStage 只销毁目标，另一个仍在链中', () => { ... })
it('移除未插入的 stage 为 no-op', () => { ... })
```
Run: `pnpm --dir packages/cesium-core exec vitest run src/cesium/AtmosphereStage.insert.test.ts` → FAIL。

- [ ] **Step 2: 实现多槽**

把 `let insertedStage` 改为 `const insertedStages: Array<PostProcessStage | PostProcessStageComposite> = []`；`insertStageBeforeLensFlare` 去重（同一实例幂等）、追加、重建链；`removeInsertedStage` 按 identity 查找后移除并销毁。回滚逻辑保持“失败时重建 lf/tm”。

- [ ] **Step 3: 运行确认通过** — PASS。

- [ ] **Step 4: dummy 销毁（写失败测试）**

在 `AtmosphereStage.test.ts` 沿用现有 Cesium mock 方式，让 `Texture`/`Texture3D` 的构造实例可被记录；触发三个 dummy 的惰性构造（调用 uniforms 闭包）后执行 `handle.destroy()`，断言三个 dummy 实例的 `destroy()` 各被调用一次。把三个局部变量提升为闭包外字段（不进 handle 公共类型）。

Run → FAIL。

- [ ] **Step 5: 实现 dummy 销毁**：三个 dummy 提升为字段，`destroy()` 末尾逐个 `destroy()`（存在且未销毁时）。

- [ ] **Step 6: 跑 core 全量测试并提交**

```bash
pnpm --dir packages/cesium-core exec vitest run
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.insert.test.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(core): 多槽插入与惰性 dummy 纹理销毁"
```

---

### Task 9: install 编排与失败回滚

**Files:**
- Create: `src/install.ts`、`src/install.test.ts`

**Interfaces:**
```ts
export interface InstallDeps {
  version: string
  checkCompat(scene: Scene): CompatResult
  loadLuts(context: Context, baseUrl: string, opts: { higherOrderScattering: boolean }): Promise<AtmosphereLUTs>
  loadWeather(context: Context, baseUrl: string): Promise<WeatherTextures>
  loadMoon(context: Context, urls: { surface: string; displacement: string }): Promise<{ texture: Texture; albedoMean: number } | undefined>
  createAtmosphere(scene: Scene, luts: AtmosphereLUTs, options: AtmosphereStageOptions): AtmosphereStageHandle
  createClouds(scene: Scene, luts: AtmosphereLUTs, weather: WeatherTextures, options: CloudsStageOptions): CloudsStageHandle | undefined
}
export async function installWithDeps(target: AtmosphereCloudsTarget, options: InstallOptions | undefined, deps: InstallDeps): Promise<AtmosphereCloudsHandle>
```
`AtmosphereCloudsTarget` / `InstallOptions` / `AtmosphereCloudsHandle` 的字段严格按 spec §8 实现（本任务先实现这些类型，Task 11 只负责从 `index.ts` 导出）。`checkCompat` 返回 Task 4 的 `CompatResult`。

- [ ] **Step 1: 写失败测试（happy path + 失败回滚 + quality 守卫）**

用 fake scene/deps（全部 `vi.fn`），断言：
```ts
it('默认装大气+云，并按顺序插入 overlay', async () => { /* createAtmosphere/createClouds 被调用；insertStageBeforeLensFlare 收到 overlay */ })
it('clouds:false 不加载天气、不传三个桥', async () => {
  await installWithDeps(scene, { clouds: false }, deps)
  expect(deps.loadWeather).not.toHaveBeenCalled()
  expect(deps.createAtmosphere.mock.calls[0][2].cloudsShadowLengthBridge).toBeUndefined()
})
it('quality 未传时不调用 setQuality（不会因 undefined 崩）', async () => { ... })
it('云创建失败返回带 cloudsError 的 handle', async () => { /* createClouds 抛错 */ })
it('overlay 插入失败时全量回滚：destroy clouds、destroy atmosphere、restore scene', async () => { ... })
it('资产加载失败时还原场景并抛错', async () => { ... })
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 实现 `installWithDeps`**

严格按 spec §8.1 的 8 步；`defaultDeps` 用真实实现（`checkCompat` 组 `CompatInput`、`loadAtmosphereLUTs`、`loadWeatherTextures`、`loadMoonTextures`、`createAtmosphereStage`、`createCloudsStage`）。`options.quality != null` 才调用 `setQuality`。`autoDestroy` 在此任务只记录，Task 10 接生命周期。

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
- `export function isInstalled(scene: Scene): boolean`
- `export class InstallCancelledError extends Error`
- `installWithDeps` 在第一个 `await` 前注册 `viewer.destroy` / `widget.destroy` 包装（`try/finally` 保证原方法执行）；每个 `await` 后检查 `scene.isDestroyed?.()`。

- [ ] **Step 1: 写失败测试**

```ts
it('并发 install 返回同一 handle，createAtmosphere 只调用一次', async () => { ... })
it('安装中 target 被销毁 → reject InstallCancelledError 且无残留（destroy 各 stage、restore scene）', async () => { ... })
it('销毁后 Map 清理，可重新安装', async () => { ... })
it('重复 install 返回旧 handle 并 warn 第二次 options 未生效', async () => { ... })
it('autoDestroy 包装 viewer.destroy：先 handle.destroy 再原 destroy；原方法抛错也执行 handle.destroy', async () => { ... })
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 实现生命周期**

模块级 `Map<Scene, Promise<AtmosphereCloudsHandle>>`；在 promise settle 的 `finally` 中，如果失败则删除条目；成功则替换为已 resolve 的 handle（用另一个 `Map<Scene, AtmosphereCloudsHandle>` 或同一 Map 存 Promise）。`destroy()` 删除条目。HMR：在 `src/index.ts` 加 `import.meta.hot?.dispose`（Task 11）。

- [ ] **Step 4: 运行确认通过** — PASS。

- [ ] **Step 5: 提交**

```bash
git add src/install.ts src/install.test.ts
git commit -m "feat: install 并发/取消/自动销毁"
```

---

### Task 11: 公共 API 面与子路径

**Files:**
- Modify: `src/index.ts`、`src/version.ts`
- Test: `src/index.test.ts`

**Interfaces:**
- `src/index.ts` 导出：`installAtmosphereClouds`、`isInstalled`、`InstallCancelledError`、类型 `InstallOptions` / `AtmosphereCloudsHandle` / `AtmosphereCloudsTarget`、`VERSION`。

- [ ] **Step 1: 写失败测试**

```ts
import * as api from './index'
it('导出主入口与类型', () => {
  expect(typeof api.installAtmosphereClouds).toBe('function')
  expect(typeof api.isInstalled).toBe('function')
  expect(typeof api.InstallCancelledError).toBe('function')
})
```

- [ ] **Step 2: 运行确认失败** — FAIL。

- [ ] **Step 3: 补全导出与 HMR dispose**

`src/index.ts`：
```ts
export { installAtmosphereClouds, isInstalled, InstallCancelledError } from './install'
export type { InstallOptions, AtmosphereCloudsHandle, AtmosphereCloudsTarget } from './install'
export { VERSION } from './version'
import.meta.hot?.dispose(() => { /* 清 Map 并销毁所有已安装 handle */ })
```
（HMR 清理函数放 `src/install.ts` 导出的 `disposeAllForHmr()`，index 只调用。）

- [ ] **Step 4: 跑测试 + 构建 + 断言 d.ts 非空**

```bash
pnpm exec vitest run src/index.test.ts
pnpm run build
grep -q "installAtmosphereClouds" dist/index.d.ts
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
cd examples/basic && pnpm install && pnpm run build
```
Expected: 构建成功，`public/cesium-geospatial-assets` 下 8 个资产存在。

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

- [ ] **Step 0: 安装 Rollup 解析依赖**

```bash
pnpm add -D @rollup/plugin-node-resolve @rollup/plugin-commonjs
```
（Rollup fixture 用 `node-resolve` 解析 `cesium-geospatial` 与 `cesium`。）

- [ ] **Step 1: 实现脚本**

对每个 fixture（vite / webpack / rollup）：
1. 写 `package.json`：`"cesium-geospatial": "file:<repo>"`、`"cesium": "1.143.0"`。
2. `pnpm install --offline`（Cesium 从本地 store 复用）。
3. 写入口 `import { installAtmosphereClouds } from 'cesium-geospatial'`（只引用，不运行）。
4. 构建；断言产物：
   - 不含 `?raw`；
   - 只出现一份 Cesium（统计 bundle 中 `Cesium` 标识数量或用 `du` 上限）；
   - `dist` 中无 `cesium-geospatial-assets` 的 `new URL`（copy-assets 方案下不应出现）。
5. `file:` 副本断言：`node_modules/cesium-geospatial` 下只有 `files` 列出的内容（无 `src`、无 `.git`）。
6. 消费方 `tsc --noEmit`：fixture 写一个 `src/check.ts` 引用 `InstallOptions` 类型，断言编译通过（验证 d.ts 非空）。

Vite dev 用例：`vite dev` 起服务，`curl` `/` 与 `/cesium-geospatial-assets/luts/transmittance.bin`，断言 200 与 131072 字节。

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

- **Spec 覆盖**：§5 约束 → Global Constraints；§7.1-7.3 → Task 1；§7.4 → Task 2/3；§7.5 → Task 3；§7.6 → Task 5/9；§7.7 → Task 8；§8.1-8.3 → Task 9/10/11；§8.4 → Task 7；§8.5 → Task 8；§8.6 → Task 8；§9 → Task 14；§10 → Task 11/12/13/14；peer/版本表 → Task 1/4/14。
- **类型一致性**：`InstallDeps` 与 `installWithDeps` 在 Task 9 定义、Task 10 扩展；`SceneTakeover` 在 Task 5 定义、Task 9 消费；`AssetUrls` 在 Task 3 定义、Task 9 消费。
- **Review Focus 对应测试**：资产 200 HTML → Task 3；安装中销毁 → Task 10；宿主改设置 → Task 5；并发/重复 → Task 10；版本/能力 → Task 4。
