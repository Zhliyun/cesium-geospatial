# 产品化设计：把大气与体积云封装成团队可复用的库

- 日期：2026-10-27
- 状态：待评审
- 相关：`docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md`、`docs/superpowers/specs/2026-08-04-phase2a-hdr-pipeline-design.md`

## 1. 意图

现在仓库对外的形态是 demo。外部项目要用大气和体积云，必须读 demo 源码、自己准备资产、自己排后处理链、自己处理失败与销毁。本设计把这些收进一个自包含的包，让团队里**已有一个跑着的 CesiumJS 项目**的同事，按文档三步接入。

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
- 安装失败时留下半挂的 stage / primitive / 桥闭包。
- `destroy()` 之后 `scene.postProcessStages` 数量或场景设置与安装前不一致。

## 5. 关键约束与依据

1. **Cesium 必须 peer**：官方 issue #12612（同一页面不能跑两个 Cesium 版本）、#8327（`CESIUM_BASE_URL` 是页面级全局）。同类库 resium、@cesium-extends、@takram/three-atmosphere 全部走 peer。
2. **peer 范围 `>=1.143.0 <2.0.0`**：库用到了非公开 API（`Texture3D`、`context._gl`、`context._currentFramebuffer`、纹理 `_texture`/`_target`、`camera.frustum.projectionMatrix`），每个 Cesium minor 都可能破坏。
3. **消费方式已定**：团队项目通过 git submodule 引入，`file:` 依赖链接。**实测（pnpm 10.34）：`file:` 依赖不会执行该包的 `prepare`，且是硬链接复制而非符号链接**——dist 必须在 submodule 目录内先构建；submodule 移动指针后，消费方需重新安装才会刷新副本。
4. **根包不能有 workspace 运行时依赖**：`workspace:*` 在 `file:` / git 安装时无法解析；core/clouds 必须在构建期被 alias 进来并打进产物，根包 `dependencies` 为空。
5. **资产约 20.7MB**（luts 16MB + clouds 3.7MB + 月面 webp 0.65MB），不 base64 内联。
6. 现有工厂签名不变：`createAtmosphereStage(scene, luts, options)`、`createCloudsStage(scene, luts, weather, options)`。注意 `createCloudsStage` 在 `options.clouds !== true` 时直接返回 `undefined`。
7. **画面正确性依赖场景设置**：shader 无条件反演对数深度（`aerialPerspective.frag.ts:691`、`CloudsMaterial.ts:414`），宿主未开 `logarithmicDepthBuffer` 时大气 sceneDist 与云的深度截断全错；Cesium 原生 `skyAtmosphere`/`skyBox`/`sun`/`moon`/`fog`/`globe.showGroundAtmosphere` 必须关闭，否则与后处理大气叠加。demo 在 `main.ts:151-153, 256-271` 全部做了这些。
8. **demo 验收档与库缺省存在差异**：`groundShadowStrength` 库缺省 `1.0`（`AtmosphereStage.ts:382`），demo 拍板 `0.8`（`main.ts:499`）；月面纹理 demo 用两张 webp 做 canvas 合成并折算 `moonRadianceScale`（`main.ts:303-367`），库缺省是 1×1 白 dummy（`AtmosphereStage.ts:185-189`）。
9. **现有构建链是空的**：两包的 `build: vite build` 没有对应 vite 配置，实测失败；本设计需要从零搭根包构建。

## 6. 已定的决定

| 决定 | 谁定的 | 备注 |
|---|---|---|
| 使用场景：团队内部已有 CesiumJS 项目 | 用户 | 不对外公开发布 |
| 分发：git submodule + 自动构建 + 陈旧检查 | 用户 | 备选（不做）：提交 dist |
| 包名：裸名 `cesium-geospatial`，仓库根包即产品 | 用户 | deck.gl 模式；根包当前已叫此名，无需改名 |
| Cesium 走 peer，不打包 | 调研（生态证据） | |
| ESM-only + Vite lib mode + 生成 d.ts | 调研（takram 发布产物验证） | |
| **场景接管：install 全接管并在 destroy 逐项还原**（`takeOverScene: false` 逃生门） | 用户 | 2026-10-27 拍板 |
| **默认参数：固化 demo 验收档（含月面纹理与合成）** | 用户 | 2026-10-27 拍板 |
| 资产随包；`higher_order` 装云即加载，`clouds: false` 才省 8MB | 我（可推翻） | 与 `setQuality` 跨档冲突的简化 |
| 单包三层：主入口 + `./core` + `./clouds` 子路径 | 我（可推翻） | |
| demo 保留，另加 `examples/basic` | 我（可推翻） | demo 是内部验收工具，不是文档 |

## 7. 形态

### 7.1 仓库结构

```
cesium-geospatial/                 # 根 package.json = 产品包
  src/index.ts                     # 产品入口：installAtmosphereClouds + 类型
  src/install.ts                   # 编排逻辑
  src/sceneTakeover.ts             # 场景设置接管与还原
  src/demoProfile.ts               # demo 验收档默认值
  src/moonTexture.ts               # 月面 webp 加载 + 合成
  src/assets.ts                    # 资产 URL 解析
  src/compat.ts                    # Cesium 版本/能力自检
  bin/check-dist.mjs               # 消费方 predev 检查（dist 陈旧检测）
  assets/luts/*.bin                # 16MB（4 个文件）
  assets/clouds/*                  # 3.7MB（4 个文件）
  assets/moon/*.webp               # 0.65MB（2 个文件）
  vite.config.ts                   # lib mode：entries index/core/clouds，external cesium
  packages/cesium-core/            # 内部包，private，不发布
  packages/cesium-clouds/          # 内部包，private，不发布
  apps/demo/                       # 内部验收 demo，不发布
  examples/basic/                  # 接入示例（workspace 内）
  docs/integration.md
  docs/api.md
```

### 7.2 构建

- Vite lib mode，多入口：`index`、`core`、`clouds`；`external: ['cesium']`；`formats: ['es']`。
- 构建期 alias：`@cesium-geospatial/core` → `packages/cesium-core/src/index.ts`，`@cesium-geospatial/clouds` → `packages/cesium-clouds/src/index.ts`，让产物自包含（`@petamoriken/float16` 一并打入）。
- `vite-plugin-dts` 生成 d.ts，三个入口各自对应。
- 产物：`dist/index.js`、`dist/core.js`、`dist/clouds.js` + 各自 `.d.ts` + Rollup 共享 chunk。
- GLSL 的 `?raw` 在构建期被 Vite 内联为字符串；消费方产物中不得出现 `?raw` 导入。
- 两包现有的 `build: vite build` 脚本（无配置、实测失败）在实现时删除或改为 `tsc --noEmit` 类型检查。

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
    "./clouds": { "types": "./dist/clouds.d.ts", "import": "./dist/clouds.js" },
    "./assets/*": "./assets/*"
  },
  "files": ["dist", "assets", "docs", "bin", "README.md"],
  "sideEffects": false,
  "scripts": {
    "build": "vite build",
    "prepare": "pnpm build",
    "verify": "<typecheck/test/build/消费者冒烟，由 builder 组合>"
  },
  "peerDependencies": { "cesium": ">=1.143.0 <2.0.0" }
}
```

- `private: true` 只阻止 `npm publish`，不影响 submodule / `file:` / git 依赖安装；保留它防止误发布。
- `prepare` 在 submodule 目录内执行 `pnpm install` 时会跑（这是构建入口）；**消费方的 `file:` 安装不会跑**，所以 README 的三步里包含“在 submodule 内构建”这一步。
- `dependencies` 为空；`devDependencies` 保留构建与测试工具（体积较大，见 §12）。
- `files` 只影响 `npm pack`，不影响 `file:` 复制。

### 7.4 资产解析

共 10 个资产：`luts/` 4 个、`clouds/` 4 个、`moon/` 2 个。

默认（零配置）：`src/assets.ts` 对每个资产各写一条**静态字面量** `new URL('../assets/luts/transmittance.bin', import.meta.url)`，由消费方打包器 emit；`assetsBaseUrl` 由这些 URL 的公共目录推导。

覆盖：`InstallOptions.assetsBaseUrl` 直接指定目录。

兜底：`fetch` 失败时，错误信息给出两条可执行路径——(a) 传 `assetsBaseUrl` 指向已拷贝的目录；(b) 运行 `npx cesium-geospatial copy-assets <dir>` 后再指向它。

**已知风险**：Vite 依赖预打包对 `node_modules` 内 `new URL` 的处理不一定生效，Webpack 5 行为也可能不同。消费方冒烟矩阵必须验证；若不可行，默认方案改为「copy-assets 优先」，零配置降级为可选。

### 7.5 `higher_order` 加载策略

- 只在 `clouds: false` 时跳过 `higher_order_scattering.bin`（省 8MB）；只要装云就加载。
- 理由：`lightShafts` 是质量档的**编译开关**（low/medium 关，high/ultra 开），`setQuality` 随时可能跨档把光柱编译回来；按需加载会引入“换档补下载”的异步状态机，收益不抵复杂度。
- 实现上需要让 `loadAtmosphereLUTs` 支持可选第三参数 `{ higherOrderScattering?: boolean }`（默认 `true`），但**不**需要把 `HAS_HIGHER_ORDER_SCATTERING_TEXTURE` 动态化——`clouds: false` 时可以直接用一个 1×1 dummy 或不创建该 uniform 的路径，实现时按最小改动选择。

### 7.6 场景接管（install 时执行，destroy 时逐项还原）

| 设置 | 安装值 | 还原 |
|---|---|---|
| `scene.globe.depthTestAgainstTerrain` | `true`（`createAtmosphereStage` 已强制） | 原值 |
| `scene.skyAtmosphere.show` | `false` | 原值 |
| `scene.skyBox.show` | `false` | 原值 |
| `scene.sun.show` | `false` | 原值 |
| `scene.moon.show`（存在时） | `false` | 原值 |
| `scene.fog.enabled` | `false` | 原值 |
| `scene.globe.showGroundAtmosphere` | `false` | 原值 |
| `scene.globe.enableLighting` | `false` | 原值 |
| `scene.backgroundColor` | `Color.BLACK` | 原值 |
| `scene.logarithmicDepthBuffer` | `true` | 原值 |

补充规则：

- `logarithmicDepthBuffer` 在 Cesium 里可能不允许运行时切换。install 设置后必须校验（读回值）；若无效或读回为 `false`，**抛错**并提示“请在创建 Viewer 时传 `logarithmicDepthBuffer: true`”。这是正确性要求，不是观感取舍。
- `globe.baseColor` 不改（demo 改过，但非必需）。
- `takeOverScene: false` 时跳过整张表（log-depth 仍需检测，不满足则抛错）。
- install 拥有后处理链的**链尾**：宿主不要在 tonemap 之后追加写颜色的 stage；需要插入自定义后处理时用 `handle.insertStageBeforeLensFlare(stage)`。

## 8. API

```ts
export type AtmosphereCloudsTarget = Viewer | CesiumWidget | Scene

export async function installAtmosphereClouds(
  target: AtmosphereCloudsTarget,
  options?: InstallOptions
): Promise<AtmosphereCloudsHandle>

export interface InstallOptions {
  atmosphere?: AtmosphereStageOptions   // 透传 createAtmosphereStage
  clouds?: CloudsStageOptions | false   // false = 只装大气；缺省 = 用 demo 验收档装云
  quality?: CloudsQualityPreset         // 云质量档（low|medium|high|ultra）
  assetsBaseUrl?: string                // 覆盖默认资产目录
  takeOverScene?: boolean               // 默认 true
  autoDestroy?: boolean                 // Viewer 销毁时自动清理，默认 true
}

export interface AtmosphereCloudsHandle {
  readonly atmosphere: AtmosphereStageHandle
  readonly clouds?: CloudsStageHandle
  insertStageBeforeLensFlare(stage: PostProcessStage | PostProcessStageComposite): void
  setQuality(q: CloudsQualityPreset): void
  destroy(): void                       // 逆序：还原场景 → clouds → atmosphere；幂等
}
```

### 8.1 编排顺序（严格）

1. 解析 `scene` 与 `context`（`Viewer`/`CesiumWidget` 取 `.scene`；`Scene` 直接用）。
2. 兼容自检（§8.3）。
3. 记录场景原值并接管（§7.6）；校验 log-depth 生效。
4. 资产 URL 解析；加载 LUT（`clouds: false` 时跳过 `higher_order`）；加载月面纹理并合成（demo 验收档）。
5. `createAtmosphereStage(scene, luts, { ...demoProfile.atmosphere, ...options.atmosphere, cloudsShadowLengthBridge: () => cloudsHandle?.cloudsPass.getShadowLengthBridge(), cloudsOcclusionBridge: () => cloudsHandle?.cloudsPass.getColorBridge(), cloudsShadowBridge: () => cloudsHandle?.getGroundShadowBridgeData() })` —— 三个桥闭包读外层 `cloudsHandle` 变量，先挂后补。
6. 若装云：`loadWeatherTextures(context, weatherBaseUrl)` → `createCloudsStage(scene, luts, weather, { ...demoProfile.clouds, ...options.clouds, clouds: true })`，随后 `setQuality(options.quality)`。
7. `atmosphere.insertStageBeforeLensFlare(clouds.overlayStage)`。
8. `autoDestroy` 且 target 是 `Viewer`：包装 `viewer.destroy`（WeakSet 防重、可重入），调用原方法前先 `handle.destroy()`。

### 8.2 失败语义

| 失败点 | 后果 | 处理 |
|---|---|---|
| 兼容自检 | 无任何 stage | 抛错，消息含 Cesium 版本与修复建议 |
| log-depth 无法开启 | 未接管或已接管 | 还原已改设置后抛错，提示 Viewer 创建参数 |
| 资产/LUT 加载 | 场景已接管 | 还原场景后抛错，调用方可修资产后重试 |
| 大气创建 | 场景已接管 | 还原场景后抛错 |
| 月面纹理解码失败 | 无 | `console.warn`，回退 1×1 白 dummy（与库缺省一致） |
| 天气纹理或云创建 | 大气已挂 | `console.warn`，返回只含大气的 handle（云失败不阻断大气） |
| overlay 插入 | 大气已挂、云已创建 | `clouds.destroy()` + 清桥 + 抛错（大气保留） |

幂等与重复安装：同一 `scene` 重复 install 抛错（消息说明需先 `destroy()`）；`destroy()` 幂等，销毁后清空桥闭包并还原场景。

### 8.3 Cesium 兼容自检

install 开始时检查：

- `VERSION` 是否落在 `>=1.143.0 <2.0.0`；
- `Texture3D` 是否存在；
- `scene.globe` 是否存在（不支持 2D/Columbus 模式）。

任一不满足：抛错，消息写明“本库依赖 Cesium 非公开 API，当前版本 X 未验证；请对齐到已验证版本或提交适配”。

### 8.4 demo 验收档

`src/demoProfile.ts` 固化一份与 demo 默认路径对齐的默认值对象，至少包含：

- `groundShadowStrength: 0.8`（demo 拍板值）；
- 月面纹理与合成结果（`moonSurfaceTexture` + 折算后的 `moonRadianceScale`）；
- demo `main.ts` 默认路径里其余显式参数（实现时逐项对照，不在本文档复制数值）。

用户传入的 `options.atmosphere` / `options.clouds` 覆盖 demo 档。

### 8.5 现有工厂的保留

`cesium-geospatial/core` 与 `cesium-geospatial/clouds` 直接再导出内部包的全部导出（含 `createAtmosphereStage` / `createCloudsStage` / 质量预设 / 类型），签名不变。只装云、自排链、单独用 tonemap 等高级场景走这里。

## 9. 文档

1. `README.md`：一句话定位；三步接入（submodule add → **在 submodule 内 `pnpm install` 构建 dist** → 消费方 `file:` 依赖）；10 行示例；链接到接入指南与 API。
2. `docs/integration.md`：选项表、场景接管清单（§7.6 全表）、资产说明与覆盖方式、销毁与重复安装、submodule 升级流程（移动指针 → 重新构建 → 消费方重装 → 检查脚本）、Cesium 兼容与已知坑（非公开 API 清单；Viewer 必须开 log depth）。
3. `docs/api.md`：主入口与 handle、子路径逃生门、类型索引。
4. `examples/basic`：最小 Vite 工程，用 workspace 依赖或 `file:../..`，只演示主入口。

## 10. 验收标准

1. `examples/basic` 里 `pnpm dev` 出大气 + 云；与 demo 同相机、同时间（`?time=` + `?play=0`）下的画面一致，允许 dither 噪声级差异。
2. 一个只有 Viewer 的空工程，按 README 三步接入成功，全程不读 demo 源码。
3. 消费方冒烟：Vite 与 Webpack 5 各一个最小工程，以 `file:` 安装后构建成功；产物无 `?raw` 残留；10 个资产可 fetch。
4. `installAtmosphereClouds(viewer, { clouds: false })` 只出大气；`destroy()` 后 `scene.postProcessStages.length` 与场景设置逐项回到安装前（§7.6 全表）。
5. 失败路径：故意改坏资产目录，报错信息给出可执行的修复建议；Viewer 未开 log depth 时报错信息指明创建参数。
6. `npx cesium-geospatial check` 在 dist 早于 src 时报错。
7. 现有测试全绿：core 354、clouds 363；两包 `tsc --noEmit` 无错。

## 11. 留给 builder 的决定

- `InstallOptions` 字段的最终命名与默认值。
- 资产解析最终方案（静态 `new URL` 优先还是 `copy-assets` 优先），以消费方冒烟结果为准。
- `examples/basic` 的依赖方式（workspace 还是 `file:../..`）。
- `check-dist` 的实现细节（mtime 粒度、忽略规则、输出格式）。
- `pnpm verify` 的组成，以及是否接入 Gitee CI。
- `viewer.destroy` 包装的实现细节（是否需要恢复原方法、异常时的清理顺序）。
- `clouds: false` 时 `higher_order` uniform 的最小改动路径（dummy 或条件绑定）。

## 12. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 消费方打包器不处理 `new URL` 资产引用 | 资产 404 | 冒烟矩阵验证；不行则切 copy-assets 优先 |
| `logarithmicDepthBuffer` 无法运行时切换 | 接入失败 | 校验 + 明确报错；README 写明 Viewer 创建参数 |
| Cesium minor 破坏非公开 API | 运行时崩 | peer 收窄 + 兼容自检 + CI 矩阵（1.143 与最新） |
| submodule 更新后忘记重建 | 消费到陈旧 dist | `check-dist` 脚本 + 文档流程 |
| submodule 内 `pnpm install` 需装完整 devDeps（含 cesium、vite、vitest） | 每个接入方多几百 MB | 文档说明；后续可拆构建专用 workspace |
| 全接管场景设置后 destroy 还原不全 | 宿主环境被污染 | 还原表 + 验收 4 |
