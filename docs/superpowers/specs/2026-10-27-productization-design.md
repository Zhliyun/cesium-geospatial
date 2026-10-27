# 产品化设计：把大气与体积云封装成团队可复用的库

- 日期：2026-10-27
- 状态：v2（四路专家评审已合并）
- 相关：`docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md`、`docs/superpowers/specs/2026-08-04-phase2a-hdr-pipeline-design.md`

## 1. 意图

现在仓库对外的形态是 demo。外部项目要用大气和体积云，必须读 demo 源码、自己准备资产、自己排后处理链、自己处理失败与销毁。本设计把这些收进一个自包含的包，让团队里**已有一个跑着的 CesiumJS 项目**的同事，按文档四步接入。

成功的样子：同事在已有 Viewer 上写一行 `installAtmosphereClouds(viewer)`，看到与 demo 一致的大气 + 体积云；不需要理解 stage 顺序、LUT 从哪来、云为什么不自动 add。

## 2. 目标

1. 仓库根包 `cesium-geospatial` 成为可被 git submodule + `file:` 依赖直接消费的自包含包。
2. 主入口一行安装整套效果，内部负责资产、场景接管、链顺序、失败回收、销毁还原。
3. 底层能力保留逃生门：`cesium-geospatial/core`、`cesium-geospatial/clouds`。
4. 文档足够让没读过 demo 的人接入（README + 接入指南 + 最小示例）。
5. 构建产物对消费方打包器无特殊要求（GLSL 已内联，不依赖 `?raw`）。

## 3. 非目标

- 不打包、不再导出 Cesium。
- 不公开发布到 npm、不做 CJS/UMD、不做独立文档站。
- 不改动任何渲染行为与画质（纯封装与分发）。
- 不把 demo 改造成示例站；demo 保留为内部验收工具。

## 4. 反目标

- 接入方仍然需要读 demo 源码才能接上。
- 接入方需要在自己的打包器里配置 `?raw` 或 GLSL loader。
- 接入后出现“两份 Cesium”或需要配置 `CESIUM_BASE_URL`。
- 安装失败时留下半挂的 stage / primitive / 桥闭包 / 纹理。
- `destroy()` 之后 `scene.postProcessStages` 数量、场景设置或 GPU 资源与安装前不一致。

## 5. 关键约束与依据（含实测）

1. **Cesium 必须 peer**：官方 issue #12612（同一页面不能跑两个 Cesium 版本）、#8327（`CESIUM_BASE_URL` 是页面级全局）。同类库 resium、@cesium-extends、@takram/three-atmosphere 全部走 peer。
2. **peer 范围 `~1.143.0`**：库用到了非公开 API（`Texture3D`、`context._gl`、`context._currentFramebuffer`、纹理 `_texture`/`_target`、`camera.frustum.projectionMatrix`），每个 Cesium minor 都可能破坏。只有实测过的新 minor 才放宽范围，并记录“已验证版本表”。
3. **消费方式**：git submodule + `file:` 依赖。实测（pnpm 10.34）：`file:` 不执行 `prepare`、是硬链接复制、**只拷 `files` 字段列出的内容**（消费方副本没有 `src`），且 submodule 移动指针后需重装才刷新。
4. **根包不能有 workspace 运行时依赖**：`workspace:*` 在 `file:` / git 安装时无法解析；core/clouds 必须在构建期被 alias 进来并打进产物，根包 `dependencies` 为空。
5. **资产约 20.7MB**（luts 16MB + clouds 3.7MB + 月面 webp 0.65MB），不 base64 内联。
6. 现有工厂签名不变：`createAtmosphereStage(scene, luts, options)`、`createCloudsStage(scene, luts, weather, options)`。`createCloudsStage` 在 `options.clouds !== true` 时返回 `undefined`。
7. **画面正确性依赖场景设置**：shader 无条件反演对数深度（`aerialPerspective.frag.ts:691`、`CloudsMaterial.ts:414`）。Cesium 1.143 的 `Scene.defaultLogDepthBuffer = true`（默认已开），`Scene.logarithmicDepthBuffer` 有运行时 setter（`Scene.js:1573-1584`），Viewer 没有创建选项；不支持 `fragmentDepth` 的设备（非 WebGL2）必须报错。
8. **Cesium 后处理顺序固定**（`PostProcessStageCollection.js:799-834`）：AO → bloom → autoExposure → Cesium tonemapping（`scene.highDynamicRange` 开时）→ 用户 stage → FXAA。因此宿主开 HDR 会先 tonemap 我们的输入；FXAA 永远在用户 stage 之后；既有用户 stage 会排在 atmosphere 之前。
9. **demo 验收档与库缺省存在差异**：`groundShadowStrength` 库缺省 `1.0`（`AtmosphereStage.ts:382`），demo 拍板 `0.8`（`main.ts:499`）；月面纹理 demo 用两张 webp 做 canvas 合成并折算 `moonRadianceScale`（`main.ts:303-367`），库缺省是 1×1 白 dummy（`AtmosphereStage.ts:185-189`）。
10. **`insertStageBeforeLensFlare` 是单槽**：插入不同实例会 `removeAndDestroy` 旧槽（`AtmosphereStage.ts:927`），云 overlay 装在槽里时，宿主再插一次会销毁云。
11. **GPU 纹理无主**：`AtmosphereStage.destroy()` 只销毁 history 与 stage（`AtmosphereStage.ts:1089-1104`），LUT/天气/月面纹理由调用方持有。
12. **现有构建链是空的**：两包的 `build: vite build` 没有对应 vite 配置，实测失败；本设计需要从零搭根包构建。`pnpm -r build` 不包含根项目，`prepare` 必须直接 `vite build`。

## 6. 已定的决定

| 决定 | 谁定的 | 备注 |
|---|---|---|
| 使用场景：团队内部已有 CesiumJS 项目 | 用户 | 不对外公开发布 |
| 分发：git submodule + 自动构建 + 陈旧检查 | 用户 | 备选（不做）：提交 dist |
| 包名：裸名 `cesium-geospatial`，仓库根包即产品 | 用户 | deck.gl 模式；根包当前已叫此名 |
| Cesium 走 peer，不打包 | 调研（生态证据） | |
| ESM-only + Vite lib mode + 生成 d.ts | 调研（takram 发布产物验证） | |
| 场景接管：install 全接管并在 destroy 逐项还原（`takeOverScene: false` 逃生门） | 用户 | 2026-10-27 拍板 |
| 默认参数：固化 demo 验收档（含月面纹理与合成） | 用户 | 2026-10-27 拍板 |
| **资产分发：`copy-assets` 优先，产物里不出现 `new URL`** | 评审实测（v2 修订） | 打包器改名/预打包会让 `new URL` 必坏 |
| `higher_order` 装云即加载，`clouds: false` 才省 8MB | 我（可推翻） | 与 `setQuality` 跨档冲突的简化 |
| 单包三层：主入口 + `./core` + `./clouds` 子路径 | 我（可推翻） | |
| demo 保留，另加 `examples/basic` | 我（可推翻） | demo 是内部验收工具，不是文档 |

## 7. 形态

### 7.1 仓库结构

```
cesium-geospatial/                 # 根 package.json = 产品包
  src/index.ts                     # 产品入口：installAtmosphereClouds + 类型
  src/install.ts                   # 编排 + 生命周期（并发/取消/回滚）
  src/sceneTakeover.ts             # 场景设置接管与条件还原
  src/demoProfile.ts               # demo 验收档默认值（demo 直接引用，避免手抄分叉）
  src/moonTexture.ts               # 月面 webp 加载 + 合成
  src/assets.ts                    # 资产目录解析（固定文件名）
  src/compat.ts                    # Cesium 版本/能力自检
  bin/cli.mjs                      # copy-assets / check 子命令
  assets/luts/*.bin                # 16MB（4 个文件）
  assets/clouds/*                  # 3.7MB（4 个文件）
  assets/moon/*.webp               # 0.65MB（2 个文件）
  vite.config.ts                   # lib mode：entries index/core/clouds，external cesium
  packages/cesium-core/            # 内部包，private，不发布
  packages/cesium-clouds/          # 内部包，private，不发布
  apps/demo/                       # 内部验收 demo，不发布
  examples/basic/                  # 接入示例（必须用 file: 依赖，见 §10.3）
  docs/integration.md
  docs/api.md
```

### 7.2 构建

- Vite lib mode，多入口：`index`、`core`、`clouds`；`external: ['cesium']`；`formats: ['es']`。
- 构建期 alias：`@cesium-geospatial/core` → `packages/cesium-core/src/index.ts`，`@cesium-geospatial/clouds` → `packages/cesium-clouds/src/index.ts`，产物自包含（`@petamoriken/float16` 一并打入；无跨实例状态，重复体积可接受）。
- **d.ts 必须扁平化**：`vite-plugin-dts` 默认会输出 `import '../packages/.../src/index.ts'` 之类指向不存在的路径（实测），消费方 `skipLibCheck: false` 报 TS2307。用 `rollupTypes: true`（api-extractor）或等价的单文件声明方案，并在消费方冒烟里跑 `tsc --noEmit`。
- 产物：`dist/index.js`、`dist/core.js`、`dist/clouds.js` + 各自 `.d.ts` + Rollup 共享 chunk + `dist/build-stamp.json`（源码哈希，供 `check` 用）。
- GLSL 的 `?raw` 在构建期内联；消费方产物中不得出现 `?raw` 导入。
- 两包现有的 `build: vite build` 脚本（无配置、实测失败）删除或改为 `tsc --noEmit`。
- `prepare` 直接写 `vite build`（`pnpm -r build` 不含根项目）。

### 7.3 根 package.json 关键字段

```json
{
  "name": "cesium-geospatial",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./core": { "types": "./dist/core.d.ts", "import": "./dist/core.js" },
    "./clouds": { "types": "./dist/clouds.d.ts", "import": "./dist/clouds.js" }
  },
  "bin": { "cesium-geospatial": "./bin/cli.mjs" },
  "files": ["dist", "assets", "docs", "bin", "README.md"],
  "sideEffects": false,
  "scripts": {
    "build": "vite build",
    "prepare": "vite build",
    "verify": "tsc --noEmit && vitest run && vite build && node scripts/smoke-consumers.mjs"
  },
  "peerDependencies": { "cesium": "~1.143.0" }
}
```

- `private: true` 只阻止 `npm publish`，不影响 submodule / `file:`。
- `prepare` 在 submodule 目录内 `pnpm install` 时执行；`--ignore-scripts` 会静默跳过，文档需注明。
- `files` 直接决定消费方 `file:` 副本内容——**不要**把 `src` 放进去（见 §10.6 的 check 方案）。
- `dependencies` 为空。

### 7.4 资产分发（v2 修订：copy-assets 优先）

**不使用 `new URL(..., import.meta.url)`**。实测（Vite 6.4 / Webpack 5.112 / Rollup 4.65）：

- Vite dev 会把 `file:` 副本预打包进 `.vite/deps/`，esbuild 原样保留 `new URL`，基准目录变成 `.vite/deps/`，fetch 命中 SPA fallback 得到 **200 text/html**（比 404 更隐蔽）。
- Vite/Webpack 会把资产哈希改名并扁平化，不存在“公共目录 + 固定文件名”。
- 裸 Rollup 不 emit 资产。

方案：

1. 包内保留 `assets/`（`luts/`、`clouds/`、`moon/`，文件名固定）。
2. `cesium-geospatial copy-assets <outDir>` 把资产按原目录结构复制到消费方指定目录（默认建议 `public/cesium-geospatial-assets`）。
3. `install` 默认 `assetsBaseUrl = '/cesium-geospatial-assets'`，加载器按固定名拼 URL；可用 `InstallOptions.assetsBaseUrl` 或逐项 `assets` 覆盖到 CDN。
4. 加载器对每个 `fetch` 检查 `r.ok`，失败抛错并带上 URL/状态码（现状 `lutLoader.ts:35`、`weatherTextures.ts:174` 不检查，404 的 HTML 会被当 half-float 读）。
5. 月面贴图若走跨域 CDN：`crossOrigin = 'anonymous'`，文档写明 CORS 要求（否则 canvas 污染 → `getImageData` 抛 SecurityError）。

### 7.5 `higher_order` 加载策略

- 只在 `clouds: false` 时跳过 `higher_order_scattering.bin`（省 8MB）；只要装云就加载。
- 理由：`lightShafts` 是质量档的编译开关（low/medium 关，high/ultra 开），`setQuality` 随时可能跨档把光柱编译回来；按需加载会引入换档补下载的异步状态机。
- `loadAtmosphereLUTs` 增加可选第三参数 `{ higherOrderScattering?: boolean }`（默认 `true`）；`clouds: false` 时用 1×1 dummy 或条件绑定，取最小改动路径。

### 7.6 场景接管（install 执行，destroy 条件还原）

| 设置 | 安装值 | 备注 |
|---|---|---|
| `scene.logarithmicDepthBuffer` | `true` | 默认已开；设置后校验 `scene.context.fragmentDepth`，非 WebGL2 报错 |
| `scene.globe.depthTestAgainstTerrain` | `true` | `createAtmosphereStage` 内部无条件设置（`:582`） |
| `scene.highDynamicRange` | `false` | 否则 Cesium 在我们的 stage 之前 tonemap |
| `scene.requestRenderMode` | `false` | 否则云/太阳只在 preRender 推进，画面冻结 |
| `scene.skyAtmosphere.show` | `false` | |
| `scene.skyBox.show` | `false` | |
| `scene.sun.show` | `false` | |
| `scene.moon.show`（存在时） | `false` | |
| `scene.fog.enabled` | `false` | |
| `scene.globe.showGroundAtmosphere` | `false` | |
| `scene.globe.enableLighting` | `false` | 会同时关掉 Cesium 地形阴影，文档明示 |
| `scene.backgroundColor` | `Color.BLACK` | |

规则：

- **条件还原**：destroy 时只有“当前值仍等于我们设置的值”才还原；宿主在安装期间改过的设置不被旧值覆盖。
- `takeOverScene: false` 时跳过本表，但 `depthTestAgainstTerrain` 仍必须快照并还原（底层会强制改它）。
- **安装前置拒绝**：`scene.postProcessStages.length > 0` 时抛错并给出迁移步骤（先 remove 既有 stage，再用 handle 插入）；逃生门 `allowExistingStages: true`。
- `ambientOcclusion` / `bloom` / `fxaa` 处于 enabled 时 `console.warn`：Cesium 固定顺序会让 AO/bloom 处理未加特效的原图、FXAA 固定在我们 tonemap 之后。
- **3D 守卫**：安装时 `scene.mode !== SceneMode.SCENE3D` 直接抛错；监听 `morphComplete`，进入非 3D 时把我们的 stage `enabled=false` 并 warn，回到 3D 自动恢复；destroy 时移除监听。
- 宿主既有 3D Tiles / labels 会被 `groundDim × groundLightColor` 整体压暗（`enableLighting=false` 同时丢地形阴影），文档明示，不做规避。

### 7.7 链位置与多 stage 插入

Cesium 的后处理顺序是固定的（§5.8），install 只能保证自己的 stage 相对顺序（depthTemporal → atmosphere → clouds overlay → lensflare → tonemap），不能保证绝对链尾（FXAA 恒在最后）。

**core 改造**：`insertStageBeforeLensFlare` 从单槽改为**有序多槽**（内部数组），插入新 stage 只追加、不销毁旧槽；删除走显式 `removeInsertedStage`。云 overlay 是第一个插入项。同步更新 core 测试。

## 8. API

```ts
export type AtmosphereCloudsTarget = Viewer | CesiumWidget | Scene

export async function installAtmosphereClouds(
  target: AtmosphereCloudsTarget,
  options?: InstallOptions
): Promise<AtmosphereCloudsHandle>

export function isInstalled(scene: Scene): boolean

export interface InstallOptions {
  atmosphere?: Omit<AtmosphereStageOptions, 'cloudsShadowLengthBridge' | 'cloudsOcclusionBridge' | 'cloudsShadowBridge' | 'moonSurfaceTexture'>
  clouds?: Omit<CloudsStageOptions, 'clouds'> | false
  quality?: CloudsQualityPreset
  assetsBaseUrl?: string
  assets?: { luts?: string; weather?: string; moonSurface?: string; moonDisplacement?: string }
  takeOverScene?: boolean       // 默认 true
  allowExistingStages?: boolean // 默认 false
  autoDestroy?: boolean         // 默认 true；对 Viewer / CesiumWidget 生效
}

export interface AtmosphereCloudsHandle {
  readonly atmosphere: AtmosphereStageHandle
  readonly clouds?: CloudsStageHandle
  readonly cloudsError?: unknown   // 云创建失败时存在
  insertStageBeforeLensFlare(stage: PostProcessStage | PostProcessStageComposite): void
  removeInsertedStage(stage: PostProcessStage | PostProcessStageComposite): void
  setQuality(q: CloudsQualityPreset): void
  destroy(): void                  // 幂等；逆序：clouds → atmosphere → 纹理 → 场景还原
}
```

### 8.1 编排顺序（严格）

1. 解析 `scene` 与 `context`（`Viewer`/`CesiumWidget` 取 `.scene`；`Scene` 直接用）。
2. 兼容自检（§8.3）与安装前置检查（§7.6 拒绝项、3D 模式）。
3. 场景原值快照 + 接管（§7.6）；校验 log-depth 生效。
4. 资产目录解析；加载 LUT（`clouds: false` 时跳过 `higher_order`）；加载月面纹理并合成（demo 验收档）。
5. `createAtmosphereStage(scene, luts, { ...demoProfile.atmosphere, ...options.atmosphere, cloudsShadowLengthBridge: () => cloudsHandle?.cloudsPass.getShadowLengthBridge(), cloudsOcclusionBridge: () => cloudsHandle?.cloudsPass.getColorBridge(), cloudsShadowBridge: () => cloudsHandle?.getGroundShadowBridgeData() })`。
6. 若装云：`loadWeatherTextures(context, weatherBaseUrl)` → `createCloudsStage(scene, luts, weather, { ...demoProfile.clouds, ...options.clouds, clouds: true })`，随后 `setQuality(options.quality)`。
7. `atmosphere.insertStageBeforeLensFlare(clouds.overlayStage)`（v2 多槽）。
8. `autoDestroy` 且 target 为 `Viewer` / `CesiumWidget`：包装其 `destroy`（WeakSet 防重、`try/finally` 保证原方法执行）；`Scene` 无 hook，文档注明。

### 8.2 失败语义

| 失败点 | 后果 | 处理 |
|---|---|---|
| 自检 / 非 3D / 既有 stage 拒绝 | 无任何改动 | 抛错，消息含具体原因与迁移步骤 |
| log-depth 不生效（非 WebGL2） | 已接管的部分 | 条件还原后抛错 |
| 资产/LUT 加载 | 场景已接管 | 还原场景后抛错（`fetch` 带 `r.ok` 与 URL） |
| 大气创建 | 场景已接管 | 还原场景后抛错 |
| 月面纹理解码失败 | 无 | `warn`，回退 1×1 白 dummy |
| 天气纹理或云创建 | 大气已挂 | `warn`，返回只含大气的 handle，`cloudsError` 带原因 |
| overlay 插入 | 大气已挂、云已创建 | **全量回滚**：销毁云与纹理、销毁大气、还原场景，然后抛错 |

幂等与并发：

- 模块级 `Map<Scene, Promise<AtmosphereCloudsHandle>>`；并发 install 返回同一个 Promise/Handle，并 `warn` 选项差异。
- install 期间调用 `destroy()`：标记取消，加载结束后清理并 reject。
- 重复 install（已完成）：返回既有 handle + `warn`，不抛错（兼容 HMR / StrictMode）。

### 8.3 Cesium 兼容自检

- `VERSION` 落在 peer 范围；
- `Texture3D` 存在；
- `scene.context.webgl2 === true` 且有 `fragmentDepth`；
- `scene.mode === SceneMode.SCENE3D`。

失败消息写明“本库依赖 Cesium 非公开 API，当前版本 X 未验证；已验证版本表见 README”。

### 8.4 demo 验收档

`src/demoProfile.ts` 固化与 demo 默认路径对齐的默认值（`groundShadowStrength: 0.8`、月面纹理与合成、其余逐项对照 `main.ts` 默认路径）。**demo 直接 import 这份 profile**，避免手抄分叉；URL 参数在其上覆盖。

### 8.5 资源归属

install 拥有并负责销毁：4 张 LUT 纹理、4 张天气纹理、月面合成纹理（约 20MB GPU 显存）。销毁顺序：stage → primitive → 纹理。`AtmosphereStage` 内部的惰性 dummy 纹理由 builder 决定是否改为可销毁字段。

### 8.6 现有工厂的保留

`cesium-geospatial/core` 与 `cesium-geospatial/clouds` 直接再导出内部包的全部导出，签名不变（除 §7.7 的 `insertStageBeforeLensFlare` 语义升级）。只装云、自排链、单独用 tonemap 等高级场景走这里。

## 9. 文档

1. `README.md`：一句话定位；四步接入（submodule add → 在 submodule 内 `pnpm install` 构建 → `copy-assets` → `file:` 依赖）；10 行示例；已验证 Cesium 版本表；链接。
2. `docs/integration.md`：选项表、场景接管全表（§7.6）、既有后处理的迁移步骤、资产拷贝与 CDN 覆盖（含 CORS）、销毁与并发安装、submodule 升级流程（移动指针 → 重建 → 重新 copy-assets → 重装 → `check`）、已知影响（3D Tiles/labels 变暗、非 3D 模式禁用）。
3. `docs/api.md`：主入口与 handle、子路径逃生门、类型索引。
4. `examples/basic`：最小 Vite 工程，**必须用 `file:` 依赖**（workspace 依赖会被 Vite 视为 linked dep 而不预打包，验收假绿）。

## 10. 验收标准

1. `examples/basic`（`file:` 依赖）`pnpm dev` 出大气 + 云；与 demo 同相机、同时间（`?time=` + `?play=0`）画面对比：同构建连跑两次取噪声地板，判据为 maxΔ 与超差占比不高于地板（沿用仓库既有像素对比纪律，不用 PNG 字节比对）。
2. 一个只有 Viewer 的空工程，按 README 四步接入成功，全程不读 demo 源码。
3. 消费方冒烟矩阵（dev 与 build 分开）：Vite dev、Vite build、Webpack 5、Rollup（copy-assets 后）各一个最小工程，`file:` 安装；断言产物无 `?raw`、单份 Cesium、资产可 fetch、消费方 `tsc --noEmit` 通过。
4. `installAtmosphereClouds(viewer, { clouds: false })` 只出大气；`destroy()` 后 stage 数量、场景设置（§7.6 全表）与 GPU 纹理逐项回到安装前。
5. 失败路径：坏资产目录 → `r.ok` 报错含 URL/状态；非 WebGL2 → 指明 `fragmentDepth`；既有 stage → 给出迁移步骤。
6. `cesium-geospatial check --root <submodule>` 在 `dist/build-stamp.json` 与当前源码哈希不一致时报错（在 submodule 内跑，不依赖消费方副本里的 src）。
7. 现有测试全绿（core 354、clouds 363）；**新增**单测覆盖：场景接管/条件还原、资产 URL 解析、失败回滚、并发 install、`insertStageBeforeLensFlare` 多槽语义。
8. 并发 install 返回同一 handle；install 过程中 destroy 能清理干净。

## 11. 留给 builder 的决定

- `InstallOptions` 字段的最终命名与默认值。
- d.ts 扁平化的具体工具配置（以消费方 `tsc --noEmit` 冒烟为准）。
- `examples/basic` 的依赖方式（固定 `file:../..`）。
- `check` 的哈希范围与输出格式。
- `pnpm verify` 的组成，以及是否接入 Gitee CI。
- `viewer.destroy` / `widget.destroy` 包装的细节（恢复原方法、异常顺序）。
- `clouds: false` 时 `higher_order` 的最小改动路径。
- core 多槽插入的数据结构与测试覆盖。

## 12. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| `copy-assets` 多一步人工操作 | 接入方漏做 → 资产 404 | README 四步写明；提供 npm script 模板；`r.ok` 报错可诊断 |
| d.ts 生成路径错乱 | 消费方类型报错或降级 any | 扁平化 + 消费方 `tsc --noEmit` 冒烟 |
| peer 收紧到 `~1.143.0` | 宿主升级 Cesium 需同步升库 | 已验证版本表；升级流程写进 README |
| 消费方文件监听/预打包缓存 | 改库后消费方看不到变化 | 文档：改 submodule 后重装 `file:` 依赖 |
| submodule 更新后忘记重建 | 消费到陈旧 dist | `build-stamp` + `check` |
| 全接管场景设置后还原不全 | 宿主环境被污染 | 条件还原 + 验收 4 |
| 私有 API 随 Cesium minor 破坏 | 运行时崩 | peer 收紧 + 自检 + 已验证版本表 |
| demoProfile 与 demo 漂移 | 默认画面分叉 | demo 直接 import profile |
