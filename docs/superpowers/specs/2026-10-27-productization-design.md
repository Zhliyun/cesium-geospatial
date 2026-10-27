# 产品化设计：把大气与体积云封装成团队可复用的库

- 日期：2026-10-27
- 状态：v3（四路评审 + 四路复审已合并）
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
2. **Cesium 版本策略**：peer `>=1.143.0 <2.0.0`（宽范围避免 npm 7+ 的 ERESOLVE 装不上）；README 维护“已验证版本表”（当前仅 1.143.x），运行期对未验证版本 `console.warn`，能力缺失（`Texture3D` / `fragmentDepth` / `depthTexture`）才抛错。库用了 `Texture3D`、`context._gl`、`_currentFramebuffer`、纹理 `_texture`/`_target`、`camera.frustum.projectionMatrix` 等非公开 API。
3. **消费方式**：git submodule + `file:` 依赖。实测（pnpm 10.34）：`file:` 不执行 `prepare`、是硬链接复制、**只拷 `files` 字段列出的内容**（消费方副本没有 `src`），submodule 移动指针后需重装才刷新。
4. **根包不能有 workspace 运行时依赖**：`workspace:*` 在 `file:` / git 安装时无法解析；core/clouds 构建期 alias 进产物，根包 `dependencies` 为空。
5. **资产约 20.7MB**（luts 16MB + clouds 3.7MB + 月面 webp 0.65MB），不 base64 内联。
6. 现有工厂签名不变；`createCloudsStage` 在 `options.clouds !== true` 时返回 `undefined`。
7. **画面正确性依赖场景设置**：shader 无条件反演对数深度（`aerialPerspective.frag.ts:691`、`CloudsMaterial.ts:414`）。Cesium 1.143 `Scene.defaultLogDepthBuffer = true`（默认已开），`Scene.logarithmicDepthBuffer` 有运行时 setter（`Scene.js:1573-1584`），Viewer 无创建选项；必须读回校验。
8. **Cesium 后处理顺序固定**（`PostProcessStageCollection.js:799-834`）：AO → bloom → autoExposure → Cesium tonemapping（`scene.highDynamicRange` 开时）→ 用户 stage → FXAA。宿主开 HDR 会先 tonemap 我们的输入；FXAA 永远最后；既有用户 stage 排在 atmosphere 之前。
9. **demo 验收档与库缺省有差异**：`groundShadowStrength` 库缺省 `1.0`（`AtmosphereStage.ts:382`），demo 拍板 `0.8`（`main.ts:499`）；月面纹理 demo 用两张 webp 做 canvas 合成（`main.ts:303-367`），库缺省 1×1 白 dummy（`AtmosphereStage.ts:185-189`）。
10. **`insertStageBeforeLensFlare` 是单槽**：插入不同实例会 `removeAndDestroy` 旧槽（`AtmosphereStage.ts:927`）。
11. **GPU 纹理无主**：`AtmosphereStage.destroy()` 只销毁 history 与 stage（`AtmosphereStage.ts:1089-1104`）；`AtmosphereStage.ts:624-671` 三个惰性 dummy（Texture + Texture3D×2）也无销毁路径。LUT/天气/月面纹理由调用方持有。
12. **现有构建链是空的**：两包 `build: vite build` 无配置、实测失败；`pnpm -r build` 不含根项目。
13. **缺失资产会返回 200 text/html**：Vite dev 的 SPA fallback 对不存在的路径返回 200，`r.ok` 恒真，HTML 会被当 half-float 读。必须按资产校验字节长度。
14. **`vite-plugin-dts` 5.x 选项是 `bundleTypes`（需 `@microsoft/api-extractor`）**；实测跨私有包 alias 时 `bundleTypes:true` 会产出 `export {}` 的空声明，必须断言 d.ts 含导出。

## 6. 已定的决定

| 决定 | 谁定的 | 备注 |
|---|---|---|
| 使用场景：团队内部已有 CesiumJS 项目 | 用户 | 不对外公开发布 |
| 分发：git submodule + 自动构建 + 陈旧检查 | 用户 | 备选（不做）：提交 dist |
| 包名：裸名 `cesium-geospatial`，仓库根包即产品 | 用户 | deck.gl 模式 |
| Cesium 走 peer，不打包 | 调研（生态证据） | |
| ESM-only + Vite lib mode + 生成 d.ts | 调研（takram 发布产物验证） | |
| 场景接管：install 全接管并在 destroy 逐项还原（`takeOverScene: false` 逃生门） | 用户 | 2026-10-27 拍板 |
| 默认参数：固化 demo 验收档（含月面纹理与合成） | 用户 | 2026-10-27 拍板 |
| 资产：`copy-assets` 优先，产物里不出现 `new URL` | 评审实测 | 打包器改名/预打包会让 `new URL` 必坏 |
| peer `>=1.143.0 <2.0.0` + 已验证版本表 + 运行期告警 | 复审修订（v3） | 宽范围避免 ERESOLVE |
| 还原策略：无条件按快照还原（不再按“值相等”判断归属） | 复审修订（v3） | 条件还原与验收 4 互斥 |
| `higher_order` 装云即加载，`clouds: false` 才省 8MB | 我（可推翻） | |
| 单包三层：主入口 + `./core` + `./clouds` 子路径 | 我（可推翻） | |
| demo 保留，另加 `examples/basic` | 我（可推翻） | |

## 7. 形态

### 7.1 仓库结构

```
cesium-geospatial/                 # 根 package.json = 产品包
  src/index.ts                     # 产品入口：installAtmosphereClouds + 类型
  src/install.ts                   # 编排 + 生命周期（并发/取消/回滚）
  src/sceneTakeover.ts             # 场景设置快照 / 接管 / 无条件还原
  src/demoProfile.ts               # demo 验收档默认值（demo 直接引用）
  src/moonTexture.ts               # 月面 webp 加载 + 合成
  src/assets.ts                    # 资产目录解析 + 字节长度校验
  src/compat.ts                    # Cesium 版本/能力自检
  bin/cli.mjs                      # copy-assets / check（纯 Node，不依赖 dist）
  assets/luts/*.bin                # 16MB（4 个）
  assets/clouds/*                  # 3.7MB（4 个）
  assets/moon/*.webp               # 0.65MB（2 个）
  vite.config.ts                   # lib mode：entries index/core/clouds，external cesium
  packages/cesium-core/            # 内部包，private，不发布
  packages/cesium-clouds/          # 内部包，private，不发布
  apps/demo/                       # 内部验收 demo，不发布
  examples/basic/                  # 接入示例（必须 file: 依赖）
  docs/integration.md
  docs/api.md
```

### 7.2 构建

- Vite lib mode，多入口 `index` / `core` / `clouds`；`external: ['cesium']`；`formats: ['es']`。
- 构建期 alias：`@cesium-geospatial/core` → `packages/cesium-core/src/index.ts`，clouds 同理；`@petamoriken/float16` 打入产物。
- **d.ts**：`vite-plugin-dts` 用 `bundleTypes: true`（不是 5.x 已移除的 `rollupTypes`），安装 `@microsoft/api-extractor`；构建后断言三个入口的 d.ts 含实际导出（非 `export {}`）。若跨包 alias 仍产出空声明，退回“内部包先各自产出 d.ts，再由根入口重导出类型”的方案。
- 产物：`dist/index.js`、`dist/core.js`、`dist/clouds.js` + 各自 `.d.ts` + 共享 chunk + `dist/build-stamp.json`。
- `build-stamp.json` 包含：包版本、源码哈希（`src/**` 与 `packages/**/src/**`）、三个入口产物存在性。**最后原子写入**（先写临时文件再 rename），任何一步失败不落 stamp。
- GLSL `?raw` 构建期内联；消费方产物不得出现 `?raw`。
- 两包现有 `build` 脚本删除或改为 `tsc --noEmit`；`prepare` 直接 `vite build`。

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
  "peerDependencies": { "cesium": ">=1.143.0 <2.0.0" }
}
```

- `private: true` 只阻止 `npm publish`，不影响 submodule / `file:`。
- `prepare` 在 submodule 内 `pnpm install` 时执行；`--ignore-scripts` 会静默跳过，文档注明“构建后必须看到 `dist/build-stamp.json`”。
- `files` 决定 `file:` 副本内容；`src` 不进去。
- `dependencies` 为空。

### 7.4 资产分发（copy-assets）

**产物里不使用 `new URL(..., import.meta.url)`**（实测：Vite dev 预打包改基准目录、Vite/Webpack 哈希改名、Rollup 不 emit）。

1. 包内 `assets/` 保留固定文件名。
2. `bin/cli.mjs copy-assets --out <dir>`（纯 Node，不依赖 dist）复制到消费方目录；默认建议 `public/cesium-geospatial-assets`。
3. **推荐把 copy-assets 接进消费方 `predev`/`prebuild`**，每次启动覆盖拷贝（20MB，耗时 <1s），从根上消除“忘记重拷”的陈旧问题：
   ```json
   "predev": "node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets"
   ```
4. 默认 `assetsBaseUrl` 用**相对 `document.baseURI`** 解析（不是根绝对路径），兼容 Vite `base: '/app/'` 与子路径部署：
   ```ts
   new URL('cesium-geospatial-assets/', document.baseURI).href
   ```
   可用 `InstallOptions.assetsBaseUrl` 或逐项 `assets` 覆盖到 CDN。
5. **加载器逐资产校验字节长度**（`r.ok` 挡不住 200 text/html）：

   | 资产 | 字节 |
   |---|---|
   | `transmittance.bin` | 131072 |
   | `scattering.bin` | 8388608 |
   | `higher_order_scattering.bin` | 8388608 |
   | `irradiance.bin` | 8192 |
   | `shape.bin` | 2097152 |
   | `shape_detail.bin` | 32768 |
   | `stbn.bin` | 1048576 |
   | `local_weather.png` / 月面 webp | 校验非空 + 可解码 |

   长度不符抛错，消息带 URL、期望/实际字节、Content-Type。
6. 月面贴图走跨域 CDN 时 `crossOrigin = 'anonymous'`，文档写明 CORS 要求（否则 canvas 污染 → `getImageData` 抛 SecurityError，静默退化为白月亮）。

### 7.5 `higher_order` 加载策略

- 只在 `clouds: false` 时跳过 `higher_order_scattering.bin`；只要装云就加载。
- 理由：`lightShafts` 是质量档编译开关（low/medium 关，high/ultra 开），`setQuality` 随时跨档。
- `loadAtmosphereLUTs` 增加可选第三参数 `{ higherOrderScattering?: boolean }`（默认 `true`）；`clouds: false` 时用 1×1 dummy 或条件绑定。

### 7.6 场景接管（install 执行，destroy 无条件还原）

| 设置 | 安装值 | 备注 |
|---|---|---|
| `scene.logarithmicDepthBuffer` | `true` | 设置后读回必须为 `true`；否则抛错 |
| `scene.globe.depthTestAgainstTerrain` | `true` | 底层无条件设置（`:582`） |
| `scene.highDynamicRange` | `false` | 否则 Cesium 在我们的 stage 之前 tonemap |
| `scene.requestRenderMode` | `false` | 否则云/太阳冻结；还原后补 `scene.requestRender()` |
| `scene.skyAtmosphere.show` | `false` | |
| `scene.skyBox.show` | `false` | |
| `scene.sun.show` | `false` | |
| `scene.moon.show`（存在时） | `false` | |
| `scene.fog.enabled` | `false` | |
| `scene.globe.showGroundAtmosphere` | `false` | |
| `scene.globe.enableLighting` | `false` | 同时丢 Cesium 地形阴影，文档明示 |
| `scene.backgroundColor` | `Color.BLACK` | |

规则：

- **无条件还原**：destroy 时按安装快照写回。宿主在安装期间改过的设置会被还原，文档明示“安装期间不要改这些设置，或 destroy 后重新应用”；需要完全不接管用 `takeOverScene: false`。
- **按对象记录快照**：`scene.globe` 的属性记在 `scene.globe` 对象上；宿主替换 `scene.globe` 后旧值不写回新对象。
- `takeOverScene: false` 跳过本表，但 `depthTestAgainstTerrain` 仍必须快照并还原（底层会强制改）。
- **安装前置拒绝**：`scene.postProcessStages.length > 0` 抛错并给迁移步骤；逃生门 `allowExistingStages: true`。迁移说明必须写明：经 handle 插入的 stage 拿到的是 atmosphere 之后的**线性 HDR** 输入，不是原始 globe 颜色，shader 需按线性域处理。
- `ambientOcclusion` / `bloom` / `fxaa` 处于 enabled 时 `console.warn`。
- **3D 守卫**：安装时 `scene.mode !== SCENE3D` 抛错；监听 `morphStart`（进入 MORPHING 立即禁用）与 `morphComplete`（回到 SCENE3D 恢复）。禁用时同时：我们的 stage `enabled=false`、`CloudsStageHandle.setEnabled(false)`（底层同时停 march preRender 与 `VolumetricPrimitive`，后者需要新增 `setEnabled`）。destroy 移除监听。
- 宿主 3D Tiles / labels 会被 `groundDim × groundLightColor` 压暗，文档明示。

### 7.7 链位置与多 stage 插入

Cesium 后处理顺序固定（§5.8），install 只保证自身顺序：depthTemporal → atmosphere → clouds overlay → lensflare → tonemap；FXAA 恒在最后。

**core 改造（破坏性，需测试）**：`insertStageBeforeLensFlare` 从单槽改为**有序多槽**，插入只追加、不销毁旧槽；新增 `removeInsertedStage(stage)` 显式移除**并销毁**（与 Cesium 语义一致），拒绝移除 install 自有的 stage（云 overlay）。

**归属规则**：`insertStageBeforeLensFlare(stage, opts?: { protectedStage?: boolean })` 中 `protectedStage` 标记 install 自有项（云 overlay），`removeInsertedStage` 拒绝移除它们。经 handle 插入的宿主 stage 在 `handle.destroy()` 时会被一并移除并销毁（所有权在安装期间转移给库）；文档明示，宿主需要的话自行重建。

## 8. API

```ts
export type AtmosphereCloudsTarget = Viewer | CesiumWidget | Scene

export async function installAtmosphereClouds(
  target: AtmosphereCloudsTarget,
  options?: InstallOptions
): Promise<AtmosphereCloudsHandle>

export function isInstalled(target: AtmosphereCloudsTarget): boolean

export class InstallCancelledError extends Error
export const VERSION: string
// 让消费者能命名嵌套选项类型
export type { AtmosphereStageOptions, CloudsStageOptions, CloudsQualityPreset }

export interface InstallOptions {
  atmosphere?: Omit<AtmosphereStageOptions, 'cloudsShadowLengthBridge' | 'cloudsOcclusionBridge' | 'cloudsShadowBridge' | 'moonSurfaceTexture'>
  clouds?: Omit<CloudsStageOptions, 'clouds' | 'quality'> | false
  quality?: CloudsQualityPreset
  assetsBaseUrl?: string
  assets?: { luts?: string; weather?: string; moonSurface?: string; moonDisplacement?: string }
  takeOverScene?: boolean       // 默认 true
  allowExistingStages?: boolean // 默认 false
  autoDestroy?: boolean         // 默认 true；Viewer / CesiumWidget 生效
}

export interface AtmosphereCloudsHandle {
  readonly atmosphere: AtmosphereStageHandle
  readonly clouds?: CloudsStageHandle
  readonly cloudsError?: unknown
  insertStageBeforeLensFlare(stage: PostProcessStage | PostProcessStageComposite, opts?: { protectedStage?: boolean }): void
  removeInsertedStage(stage: PostProcessStage | PostProcessStageComposite): void
  setQuality(q: CloudsQualityPreset): void
  destroy(): void
}
```

契约：

- `quality` 只能从顶层传；`options.clouds.quality` 被 Omit。`setQuality(undefined)` 不调用（install 内部守卫）；无云或 `cloudsError` 时 `setQuality` 为 no-op + `warn`。
- `assets` 只接受 URL；需要注入已预加载纹理的自建资产管线走 `cesium-geospatial/core`（api.md 写明）。
- `clouds: false` 时不传三个云桥（与 `?clouds=0` 的零回归路径一致），并跳过天气/云资产加载。

### 8.1 编排顺序（严格）

1. 解析 `scene`/`context`；**立即**注册 `viewer.destroy`/`widget.destroy` 包装（在第一个 await 之前），使安装中的销毁可被取消。
2. 自检（§8.3）与安装前置检查（既有 stage、3D 模式）。
3. 场景快照 + 接管（§7.6）；读回校验 log-depth。
4. 资产解析；加载 LUT（`clouds: false` 跳过 `higher_order`）；加载月面纹理并合成。
5. `createAtmosphereStage(...)`；`clouds: false` 时不传桥。
6. 装云：`loadWeatherTextures` → `createCloudsStage(..., { clouds: true })`；`options.quality != null` 才 `setQuality`。
7. `atmosphere.insertStageBeforeLensFlare(clouds.overlayStage)`（多槽）。
8. 注册到模块级 `Map<Scene, AtmosphereCloudsHandle>`；返回 handle。

每个 `await` 之后检查 target 是否已销毁；已销毁则全量回滚并 `reject` 一个 `InstallCancelledError`（README 示例用 `try/catch` 或顶层 await，不吞错）。取消由包裹的 `destroy` 同步置位（不是轮询）；回滚时若 target 已销毁、GL 上下文已释放，跳过 stage/纹理销毁，只清监听与 Map 条目（Cesium `destroyObject` 会把方法替换为抛错版本，`scene.requestRender()` 等调用必须先 `isDestroyed()` 守卫）。

### 8.2 失败语义

| 失败点 | 后果 | 处理 |
|---|---|---|
| 自检 / 非 3D / 既有 stage 拒绝 | 无改动 | 抛错，含原因与迁移步骤 |
| log-depth 读回失败 | 已接管 | 还原场景后抛错 |
| 资产校验失败 | 场景已接管 | 还原场景后抛错（URL、期望/实际字节、Content-Type） |
| 大气创建失败 | 场景已接管 | 还原场景后抛错 |
| 月面纹理解码失败 | 无 | `warn`，回退白 dummy |
| 天气/云创建失败 | 大气已挂 | `warn`，返回只含大气的 handle，`cloudsError` |
| overlay 插入失败 | 大气已挂、云已建 | **全量回滚**（云、纹理、大气、场景）后抛错 |
| 安装中 target 被销毁 | 部分资源 | 全量回滚后 `reject(InstallCancelledError)` |

并发与幂等：

- 模块级 `Map<Scene, Promise<Handle>>`；安装中再次调用返回同一 Promise，`warn` 第二个调用方的 options 未生效。
- 安装完成后再次调用：返回既有 handle + `warn`（“已安装，options 未生效”）。
- `destroy()` 与安装失败时删除 Map 条目，允许重装。
- `destroy()` 幂等；destroy 后再 install 创建全新实例。
- HMR：`import.meta.hot?.dispose(() => handle?.destroy())`，并清 Map；文档写明库模块自身被替换时注册表会丢。

### 8.3 Cesium 兼容自检

- `VERSION` 在 peer 范围；不在已验证版本表则 `warn`（不抛）。
- `Texture3D` 存在、`scene.context.webgl2 === true`、`fragmentDepth` 与 `depthTexture` 可用。
- `scene.mode === SceneMode.SCENE3D`。
- 能力缺失抛错，消息附当前版本与已验证版本表。

### 8.4 demo 验收档

`src/demoProfile.ts` 固化 demo 默认路径（`groundShadowStrength: 0.8`、月面纹理与合成、其余逐项对照 `main.ts`）。**demo 直接 import 这份 profile**，URL 参数在其上覆盖，避免手抄分叉。

### 8.5 资源归属

install 拥有并销毁：4 张 LUT 纹理、4 张天气纹理、月面合成纹理（约 20MB GPU 显存），以及 `AtmosphereStage` 内三个惰性 dummy（**必做**：`AtmosphereStage.ts:624-671` 改为可销毁字段，destroy 时释放）。销毁顺序：stage → primitive → 纹理。

### 8.6 现有工厂与破坏性变更

`cesium-geospatial/core` 与 `/clouds` 再导出内部包全部导出。**破坏性变更**：`insertStageBeforeLensFlare` 由“单槽替换”改为“有序追加”，新增 `removeInsertedStage`；core 现有测试与 demo 需同步更新。其余工厂签名不变。

## 9. 文档

1. `README.md`：定位；四步接入（submodule add → submodule 内 `pnpm install` 构建 → 首次 `node <submodule>/bin/cli.mjs copy-assets` → `file:` 依赖）；推荐 `predev` 自动拷贝脚本；10 行示例；已验证 Cesium 版本表；链接。
2. `docs/integration.md`：选项表、场景接管全表与无条件还原语义、既有后处理迁移（含线性 HDR 输入说明）、资产与 CDN/CORS、销毁与并发、submodule 升级流程（移动指针 → 重建 → 重装 → `check`）、已知影响（3D Tiles/labels 变暗、非 3D 禁用）。
3. `docs/api.md`：主入口与 handle、子路径逃生门、类型索引、自建资产管线走 `./core`。
4. `examples/basic`：最小 Vite 工程，**必须 `file:` 依赖**（workspace 会被视为 linked dep 而不预打包，验收假绿）。

## 10. 验收标准

1. `examples/basic`（`file:`）`pnpm dev` 出大气 + 云；与 demo 同相机、同时间（`?time=` + `?play=0`）对比：同构建连跑两次取噪声地板，判据为 maxΔ 与超差占比不高于地板（沿用仓库像素对比纪律，不用 PNG 字节比对）。
2. 只有 Viewer 的空工程按 README 四步接入成功，不读 demo 源码。
3. 消费方冒烟（dev 与 build 分开）：Vite dev、Vite build、Webpack 5、Rollup（copy-assets 后）各一最小工程，`file:` 安装；断言：无 `?raw`、单份 Cesium、资产可 fetch、消费方 `tsc --noEmit` 通过、**d.ts 实际引用类型**（不是空 `export {}`）。
4. **非根 base 部署**：Vite `base: '/app/'` 下资产可加载。
5. `clouds: false` 只出大气且不请求云资产；`destroy()` 后 stage 数量、场景设置（§7.6 全表）、GPU 纹理回到安装前。
6. 失败路径：坏资产 → 字节长度报错含 URL/期望/实际/Content-Type；非 WebGL2 → 指明能力；既有 stage → 迁移步骤。
7. `cesium-geospatial check --root <submodule>`：`dist/build-stamp.json` 与源码哈希不一致时报错；`--copy <node_modules/...>` 时校验消费方副本 stamp 与 submodule 一致（防止改了 submodule 没重装）。
8. 现有测试全绿（core 354、clouds 363）；**新增**单测覆盖：场景快照/无条件还原、资产长度校验、失败回滚、并发 install、取消、多槽插入/移除、`setQuality(undefined)` 守卫。
9. 并发 install 返回同一 handle；安装中 destroy 触发 `InstallCancelledError` 且无残留。

## 11. 留给 builder 的决定

- `InstallOptions` 字段最终命名与默认值。
- d.ts 扁平化方案（`bundleTypes` 失败时的回退形态）。
- `check` 的哈希范围与输出格式。
- `pnpm verify` 组成与是否接 Gitee CI。
- destroy 包装的细节（恢复原方法、异常顺序）。
- `clouds: false` 时 `higher_order` 的最小改动路径。
- core 多槽数据结构与测试覆盖。
- 3D 守卫停用 primitive 的具体 API（`primitive.show` vs 显式 stop）。

## 12. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 消费方漏跑 copy-assets | 资产 404/200 HTML | `predev` 模板 + 字节长度校验 + README 四步 |
| 子路径部署 base 不匹配 | 资产全 404 | 默认相对 `document.baseURI`；验收 4 |
| d.ts 生成空声明 | 消费方类型全 any | 构建断言 + 消费方 `tsc` 冒烟 |
| peer 宽范围 + 私有 API | 新 minor 运行时崩 | 已验证版本表 + 自检 warn/throw + 升级后跑冒烟 |
| submodule 更新后忘记重建/重装 | 消费旧 dist | build-stamp + `check --copy` + 文档流程 |
| 无条件还原覆盖宿主安装期改动 | 宿主设置被重置 | 文档明示；`takeOverScene:false` 逃生门 |
| 3D 过渡期花屏 | morph 时深度反演错误 | `morphStart` 立即禁用（stage + primitive） |
| core 多槽语义变更 | 既有调用方行为变化 | 破坏性变更记录 + 测试 + demo 同步 |
