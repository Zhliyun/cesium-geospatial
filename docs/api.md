# API 参考

三个入口：

| 导入路径 | 内容 | 何时用 |
|---|---|---|
| `cesium-geospatial` | 产品主入口：`installAtmosphereClouds` + `isInstalled` + `InstallCancelledError` + `VERSION` + 5 个可命名类型 | **默认选择**：一行装好大气 + 体积云，资产、场景接管、链顺序、失败回收、销毁还原全部由库负责 |
| `cesium-geospatial/core` | `@cesium-geospatial/core` 的全部导出（大气 stage 工厂、LUT 加载、shader 组装器、moon 数学、底层平台工具） | 需要自建资产管线 / 自己排后处理链 / 只装大气 |
| `cesium-geospatial/clouds` | `@cesium-geospatial/clouds` 的全部导出（云 stage 工厂、weather 纹理加载、质量档、BSM / resolve 等） | 同上，用于体积云 |

`cesium` 是 peerDependency：由宿主提供，本库不打包、不导出 Cesium。本库 ESM-only。

---

## 1. 主入口

```ts
import {
  installAtmosphereClouds,
  isInstalled,
  InstallCancelledError,
  VERSION,
  type InstallOptions,
  type AtmosphereCloudsHandle,
  type AtmosphereCloudsTarget,
  type AtmosphereStageOptions,
  type CloudsStageOptions,
  type CloudsQualityPreset
} from 'cesium-geospatial'
```

### `installAtmosphereClouds(target, options?)`

```ts
function installAtmosphereClouds(
  target: Viewer | CesiumWidget | Scene,
  options?: InstallOptions
): Promise<AtmosphereCloudsHandle>
```

一行安装整套效果。内部严格按下列顺序执行（每个 `await` 之后检查安装是否已被取消）：

1. 解析 `scene`；**在第一个 await 之前**包装 `viewer.destroy` / `widget.destroy`（`autoDestroy` 时），使安装中的销毁可取消；
2. Cesium 版本 / 能力自检 + 安装前置检查（既有 postProcessStage、3D 模式）；
3. 场景快照 + 接管（12 项，见 [integration.md §4](./integration.md#4-场景接管12-项与无条件还原)），读回校验对数深度；
4. 解析资产 URL 并加载 LUT（`clouds: false` 时跳过 8MB `higher_order_scattering.bin`）、加载月面纹理会合成；
5. `createAtmosphereStage`（云桥闭包惰性求值）；
6. `loadWeatherTextures` → `createCloudsStage`（`clouds: false` 跳过）；给了 `quality` 才 `setQuality`；
7. 云 overlay 插入 atmosphere 与 lensflare 之间（受保护项）；
8. 注册到模块级 `Map<Scene, handle>`，返回 handle。

失败语义（回滚 / 降级 / 取消）见 [integration.md §7](./integration.md#7-销毁并发与安装失败)。

### `isInstalled(target)`

```ts
function isInstalled(target: Viewer | CesiumWidget | Scene): boolean
```

仅在**安装完成**时为 `true`。安装中、`handle.destroy()` 之后、target 销毁、安装失败均返回 `false`。

### `InstallCancelledError`

```ts
class InstallCancelledError extends Error {
  name: 'InstallCancelledError'
}
```

安装期间 target 被销毁（或模块 HMR 清理取消了进行中的安装）时，Promise 以它 `reject`。
此时库已回滚；它与普通安装失败（资产错误等）可区分，调用方通常只需忽略。

### `VERSION`

包的语义化版本字符串（当前 `0.1.0`），与 `package.json` 一致。

### `AtmosphereCloudsHandle`

| 成员 | 类型 | 说明 |
|---|---|---|
| `atmosphere` | `AtmosphereStageHandle`（`./core`） | 大气 stage 句柄：`atmosphereStage` / `tonemapStage` / `lensFlareStage` / `depthTemporalStage` 等 |
| `clouds` | `CloudsStageHandle \| undefined` | 体积云句柄；`clouds: false` 或云创建失败时不存在 |
| `cloudsError` | `unknown` | 云创建失败的原始错误（仅失败时存在） |
| `insertStageBeforeLensFlare(stage, opts?)` | `(stage, opts?: { protectedStage?: boolean }) => void` | 把宿主 stage 追加到 atmosphere 之后、lensflare / tonemap 之前（多槽、按插入顺序执行）。**所有权在安装期间转移给库**：`destroy()` 会一并移除并销毁 |
| `removeInsertedStage(stage)` | `(stage) => void` | 移除并销毁经本 handle 插入的 stage；未插入过 → no-op + warn；受保护项（云 overlay）拒绝 |
| `setQuality(q)` | `(q: CloudsQualityPreset) => void` | 运行时换云质量档。无云 / `cloudsError` 时 no-op + warn；`undefined` 被守卫 no-op |
| `destroy()` | `() => void` | 幂等释放：云 → 宿主 stage → 大气 → 纹理（4 LUT + 4 weather + 月面合成）→ 场景还原，并摘注册表、恢复 destroy 包装 |

`clouds` 句柄（来自 `cesium-geospatial/clouds` 的 `CloudsStageHandle`）常用成员：

| 成员 | 说明 |
|---|---|
| `overlayStage` | 云的合成 `PostProcessStage`（本库已替你插入链中；自建管线时需自己 add） |
| `cloudsPass` | raymarch 主 pass（`getShadowLengthBridge()` / `getColorBridge()` 等桥数据） |
| `setQuality(q)` | 换质量档（`handle.setQuality` 的内部实现） |
| `setEnabled(enabled)` / `isEnabled()` | 停用/启用云（3D 守卫内部使用；宿主也可用） |

### `InstallOptions`

字段级说明（含默认值与接管语义）见 [integration.md §3](./integration.md#3-installoptions)。
要点：

```ts
interface InstallOptions {
  atmosphere?: Omit<AtmosphereStageOptions, 'cloudsShadowLengthBridge' | 'cloudsOcclusionBridge' | 'cloudsShadowBridge' | 'moonSurfaceTexture'>
  clouds?: Omit<CloudsStageOptions, 'clouds' | 'quality'> | false
  quality?: CloudsQualityPreset
  assetsBaseUrl?: string
  assets?: { luts?: string; weather?: string; moonSurface?: string; moonDisplacement?: string }
  takeOverScene?: boolean      // 默认 true
  allowExistingStages?: boolean // 默认 false
  autoDestroy?: boolean        // 默认 true（Viewer / CesiumWidget）
}
```

- 三个云桥（`cloudsShadowLengthBridge` / `cloudsOcclusionBridge` / `cloudsShadowBridge`）与
  `moonSurfaceTexture` 由 install 自有，类型上禁止传入。
- `quality` 只能从顶层传；`options.clouds.quality` 被 `Omit`。
- `clouds: false` 时：不加载天气纹理、不请求 `higher_order_scattering.bin`、不传三个云桥，
  与 demo `?clouds=0` 的零回归路径一致。

---

## 2. 子路径逃生门

`./core` 与 `./clouds` 把内部包的全部导出原样再导出（`export *`）。产品主入口只做编排；
需要自己控制资产来源、stage 顺序或只装一半效果时用这两个入口。

### 2.1 自建资产管线（走 `./core`）

产品主入口只接受资产 **URL**（`assetsBaseUrl` / `assets`）。要注入**已预加载的纹理**、
自定义 LUT 来源（比如从 IndexedDB 读）或自己控制 stage 链，走 `./core`：

```ts
import { loadAtmosphereLUTs, createAtmosphereStage } from 'cesium-geospatial/core'
import {
  loadWeatherTextures,
  createCloudsStage,
  type CloudsStageHandle
} from 'cesium-geospatial/clouds'

// 1. 自己加载资产：baseUrl 末尾带 /，例如 '/cesium-geospatial-assets/luts/'
const luts = await loadAtmosphereLUTs(scene.context, lutsBaseUrl, {
  higherOrderScattering: true   // 不装云传 false 可省 8MB
})

// 2. 先声明云句柄：三个桥是惰性闭包，创建云后自动指向真实 handle
let cloudsHandle: CloudsStageHandle | undefined
scene.logarithmicDepthBuffer = true
const atmosphere = createAtmosphereStage(scene, luts, {
  // 三个云桥（install 内部同样必传）：
  // 不传 = 大气不知道云的存在——云不遮挡大气、不产生光柱联动、地面云影 define 不编译
  cloudsOcclusionBridge: () => cloudsHandle?.cloudsPass.getColorBridge(),
  cloudsShadowLengthBridge: () => cloudsHandle?.cloudsPass.getShadowLengthBridge(),
  cloudsShadowBridge: () => cloudsHandle?.getGroundShadowBridgeData()
})

// 3. 云（可选）：weather 纹理自己加载
const weather = await loadWeatherTextures(scene.context, weatherBaseUrl)
cloudsHandle = createCloudsStage(scene, luts, weather, { clouds: true }) // 不传 clouds:true 会返回 undefined

// 4. 链顺序自己排：云 overlay 插到 atmosphere 与 lensflare 之间（线性 HDR 域）
if (cloudsHandle) atmosphere.insertStageBeforeLensFlare(cloudsHandle.overlayStage)
```

自建管线时**调用方负责**：

- **三个云桥**（`cloudsOcclusionBridge` / `cloudsShadowLengthBridge` / `cloudsShadowBridge`）：
  不传桥 = 云不遮挡大气（无云遮挡联动、无 god rays 天空路径）、地面云影 `HAS_GROUND_SHADOW`
  不编译（无云影）——画面「能跑但和 demo 不一样」；
- 资产字节校验（`./core` 的加载器已内置，但自定义来源要自己保证长度/可解码）；
- 纹理生命周期：`loadAtmosphereLUTs` / `loadWeatherTextures` 返回的 `Texture` / `Texture3D`
  由调用方在 destroy 时释放（`AtmosphereStage.destroy()` 只销毁自己的 history 与 stage）；
- 场景接管项（对数深度必须为 `true`，否则 shader 会反演出错误深度）；
- `createCloudsStage` 返回的 `overlayStage` **不会自动 add**（`insertStageBeforeLensFlare`
  或 `scene.postProcessStages.add` 由调用方决定）。

### 2.2 只装大气

```ts
await installAtmosphereClouds(viewer, { clouds: false })
```

或自建：`loadAtmosphereLUTs(..., { higherOrderScattering: false })` +
`createAtmosphereStage(scene, luts)`。

### 2.3 自定义后处理

产品入口下用 `handle.insertStageBeforeLensFlare(stage)`（见 §1）；自建管线直接用
`AtmosphereStageHandle.insertStageBeforeLensFlare(stage, opts?)`。

**破坏性变更（2026-10-27 起）**：`insertStageBeforeLensFlare` 从「单槽替换」改为「有序多槽
追加」——多次插入按顺序全部保留；新增 `removeInsertedStage(stage)`（移除并销毁）。
`protectedStage: true` 标记 install 自有项，`removeInsertedStage` 拒绝移除。

---

## 3. 类型索引

### 主入口 `cesium-geospatial`

| 名称 | 种类 | 说明 |
|---|---|---|
| `installAtmosphereClouds` | 函数 | §1 |
| `isInstalled` | 函数 | §1 |
| `InstallCancelledError` | class | §1 |
| `VERSION` | const | 包版本 |
| `InstallOptions` | interface | 安装选项（§1） |
| `AtmosphereCloudsHandle` | interface | 安装句柄（§1） |
| `AtmosphereCloudsTarget` | type | `Viewer \| CesiumWidget \| Scene` |
| `AtmosphereStageOptions` | interface | 大气选项（再导出自 `./core`） |
| `CloudsStageOptions` | interface | 云选项（再导出自 `./clouds`） |
| `CloudsQualityPreset` | type | `'low' \| 'medium' \| 'high' \| 'ultra'` |

### `cesium-geospatial/core`

| 分类 | 导出 |
|---|---|
| 大气 stage | `createAtmosphereStage`、`AtmosphereStageHandle`、`AtmosphereStageOptions`、`AtmosphereLUTs`、`AtmosphereFrameState`、`ResolvedAtmosphereStageOptions` |
| LUT | `loadAtmosphereLUTs`、`parseHalfFloatBin` |
| shader 组装 | `buildAtmospherePrefix`、`buildAerialPerspectiveFragmentShader`、`buildStandaloneShaderForValidation`、`buildAtmosphereUniforms`、`AERIAL_PERSPECTIVE_UNIFORM_NAMES`、`LOG_DEPTH_GLSL`、`DEPTH_RECONSTRUCTION_GLSL`、`ATMOSPHERE_DEFAULT_GLSL` |
| GLSL 工具 | `resolveIncludes`、`unrollLoops`、`glslIndex` |
| moon 数学 | `computeMoonDirectionECEF`、`computeMoonFixedToECEFMatrix`、`computeMoonIlluminatedFraction`、`computeMoonIlluminatedFractionFromDirections` |
| 平台工具 | `FullscreenPass`、`createVolumetricPrimitive`、`createArrayTextureBridge`、`createMRTFramebuffer`、`createPingPong`、`StageGpuTimer` |
| 常量 / 数学 | `ATMOSPHERE_BOTTOM_RADIUS_M`、`ATMOSPHERE_TOP_RADIUS_M`、`getAltitudeCorrectionOffset` |

月面纹理加载器 `loadMoonTextures` 目前是根包内部模块（`src/moonTexture.ts`），不在 `./core`
的公开导出里；需要 `albedoMean` 或自定义月面合成时参考其实现自行加载。

### `cesium-geospatial/clouds`

| 分类 | 导出 |
|---|---|
| 云 stage | `createCloudsStage`、`CloudsStageHandle`、`CloudsStageOptions`、`CloudsPass`、`CloudsPassOptions`、`createCloudsPass` |
| weather | `loadWeatherTextures`、`WeatherTextures`、`WEATHER_PRESETS`、`CloudsWeatherPreset`、`CloudsWeatherBakeOptions` |
| weather atlas | `WeatherAtlas`、`createWeatherAtlas`、`resolveWeatherAtlasPlan`、`bakeSeedToOffset`、`ATLAS_SIZE`、`ATLAS_SLICES` |
| 质量档 | `CloudsQualityPreset`、`CLOUDS_DEFAULT_QUALITY`、`cloudsQualityPresets`、`applyQualityPreset`、`AppliedCloudsQuality` |
| 云层参数 | `CLOUDS_LAYER_ALTITUDES_M`、`CloudLayerParams`、`DEFAULT_CLOUD_LAYERS`、`applyAltitudeOffset`、`ALTITUDE_OFFSET_RANGE`、`packLayerUniforms` |
| shader 组装 | `buildCloudsMainFragmentShader`、`buildStandaloneCloudsShader`、`buildStandaloneCloudsShaderForValidation`、`CloudsMainOptions`、`CloudsParameters` |
| 状态 | `CloudsFrameState`、`CloudsShadowFrameState`、`CloudsShadowMarchParameters`、`defaultCloudsParameters` |

完整导出（含调试 / 探针类型）以 `dist/core.d.ts`、`dist/clouds.d.ts` 为准，或直接看
`packages/cesium-core/src/index.ts` / `packages/cesium-clouds/src/index.ts`。

---

## 4. 兼容与版本

- peer：`cesium >=1.143.0 <2.0.0`；**已验证版本表当前只有 `1.143.0`**，运行期对未验证版本
  `console.warn`。**1.146.0 会在装云时崩渲染**（详见 [integration.md §9.1](./integration.md#91-cesium-11460-不能用云-shader-编译失败)）。
- `@cesium/engine` 必须 26.1.0（cesium 1.143 声明 `^26.1.0`，但 26.4.0 的 ESM 入口删了
  `AttributeCompression` 等再导出）。
- 本库使用若干 Cesium 非公开 API；升级 Cesium 前先跑 `examples/basic` 冒烟。
- HMR：`import.meta.hot` 钩子只在宿主直接消费源码时生效，消费 `dist/` 时被静态消除。
