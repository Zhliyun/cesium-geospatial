# 接入指南

面向「已有一个跑着的 CesiumJS 项目，想把物理大气 + 体积云接进来」的开发者。产品入口是一行
`installAtmosphereClouds(target, options?)`；需要自己排后处理链或自建资产管线时走
[`cesium-geospatial/core`](./api.md) 逃生门。

- 设计依据：`docs/superpowers/specs/2026-10-27-productization-design.md`
- API 参考：[`docs/api.md`](./api.md)
- 最小可运行工程：`examples/basic/`（`file:` 依赖，与真实消费路径一致）

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node | ≥ 20 |
| 包管理器 | pnpm ≥ 10（本仓库锁定 `pnpm@10.32.1`；npm / yarn 未验证） |
| Cesium | **1.143.x**（peer 范围 `>=1.143.0 <2.0.0`）。**不要升到 1.146.0**，见 §9.1 |
| 浏览器 | WebGL2，且 `scene.context.fragmentDepth`、`scene.context.depthTexture`、`Cesium.Texture3D` 可用（缺任一项安装前自检就抛错） |
| 场景 | `SceneMode.SCENE3D`、存在 `scene.globe`；2D / Columbus 会被拒绝，3D→2D morph 期间自动停用 |

安装前会做 Cesium 版本与能力自检（`src/compat.ts`）：

- 版本超出 peer 范围、缺 `Texture3D`、非 WebGL2、缺 `fragmentDepth` / `depthTexture`、无 globe、非 3D → **抛错**，错误消息带当前版本与已验证版本表；
- 在 peer 范围内但不在已验证版本表（当前仅 `1.143.0`）→ `console.warn`，不阻断安装。

> 本库用到了若干 Cesium 非公开 API（`Texture3D`、`context._gl`、`_currentFramebuffer`、纹理
> `_texture` / `_target`、`camera.frustum.projectionMatrix` 等），所以新版本 Cesium 一定要
> 先跑 `examples/basic` 冒烟再升级宿主。

---

## 2. 四步接入

以下命令在**消费方仓库根目录**执行。示例把 submodule 放在 `vendor/cesium-geospatial`，
路径可自选，但后续命令与 `file:` 路径要同步替换。

### 步骤 1：以 git submodule 引入

```bash
git submodule add <本仓库地址> vendor/cesium-geospatial
git submodule update --init --recursive
```

### 步骤 2：在 submodule 内安装依赖并构建 `dist`

```bash
pnpm --dir vendor/cesium-geospatial install
```

`package.json` 的 `prepare` 会在安装末尾自动执行 `pnpm run build`（Vite lib mode +
d.ts + 构建戳）。**构建成功的判据是能看到 `vendor/cesium-geospatial/dist/build-stamp.json`**：

```bash
ls vendor/cesium-geospatial/dist/build-stamp.json   # 必须存在
```

若宿主全局开了 `--ignore-scripts`（或 pnpm 的 `ignore-scripts=true`），`prepare` 会被跳过，
此时显式补一次构建：

```bash
pnpm --dir vendor/cesium-geospatial run build
```

> 若宿主本身也是 pnpm workspace 且命令被外层 workspace 接管，追加 `--ignore-workspace`
> （`pnpm --dir vendor/cesium-geospatial install --ignore-workspace`）。

### 步骤 3：把运行期资产拷进站点的 `public/`

```bash
node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets
```

输出：`3 个目录 / 10 个文件`（luts 4 + clouds 4 + moon 2，约 20.7MB）。

**首次之后不要靠手工记忆**——把 `copy-assets` 接进消费方的 `predev` / `prebuild`，每次启动
覆盖拷贝（< 1s），从根上消除「submodule 升级了但资产还是旧的」：

```json
{
  "scripts": {
    "predev": "node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets",
    "prebuild": "node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets",
    "dev": "vite",
    "build": "vite build"
  }
}
```

### 步骤 4：声明 `file:` 依赖并安装

```json
{
  "dependencies": {
    "cesium": "1.143.0",
    "cesium-geospatial": "file:vendor/cesium-geospatial"
  },
  "pnpm": {
    "overrides": {
      "@cesium/engine": "26.1.0",
      "@cesium/widgets": "16.1.0"
    }
  }
}
```

```bash
pnpm install
```

两个要点：

1. **pnpm 会把 `file:` 目录按本包 `files` 字段拷成一份实体副本**（不是软链）：只含
   `dist/`、`assets/`、`bin/`、`docs/`、`README.md`，没有 `src/`、没有 `.git`。`file:`
   安装**不会执行原包的 `prepare`**——所以 `dist/` 必须在步骤 2 先构建好。因此
   **submodule 指针移动后必须重跑步骤 2 与 `pnpm install`**，否则宿主用的还是旧副本。
2. **`@cesium/engine` 必须钉 26.1.0**：`cesium@1.143.0` 声明 `@cesium/engine@^26.1.0`，
   但 26.4.0 不再导出 `cesium/Source/Cesium.js` 需要的 `AttributeCompression` 等符号，
   Vite dev 启动即报 `No matching export ... "AttributeCompression"`。`@cesium/widgets`
   同理钉 16.1.0（与仓库根 lock 一致）。

### 最小安装代码（10 行）

```ts
import { Viewer } from 'cesium'
import { installAtmosphereClouds } from 'cesium-geospatial'

const viewer = new Viewer('cesiumContainer')

// 顶层 await 需要构建目标 ≥ es2022；Vite 缺省 es2020/chrome87，请用 async 函数包一层
const handle = await installAtmosphereClouds(viewer, { quality: 'high' })

// destroy 顺序：云 → 宿主插入的 stage → 大气 → 纹理 → 场景设置还原；幂等
window.addEventListener('beforeunload', () => handle.destroy())
```

`installAtmosphereClouds` 接管后不需要再手工 add 任何 stage、不需要知道 LUT 从哪来、
不需要处理云的插入点。安装失败时它会自己回滚（见 §7）。

---

## 3. `InstallOptions`

| 字段 | 类型 / 默认 | 说明 |
|---|---|---|
| `atmosphere` | `Omit<AtmosphereStageOptions, 'cloudsShadowLengthBridge' \| 'cloudsOcclusionBridge' \| 'cloudsShadowBridge' \| 'moonSurfaceTexture'>` | 大气 stage 选项。三个云桥与月面纹理由 install 自有，类型上已排除 |
| `clouds` | `Omit<CloudsStageOptions, 'clouds' \| 'quality'> \| false`；默认装云 | 体积云选项。`false` = 只装大气：不加载天气纹理、不请求 8MB `higher_order_scattering.bin`、不传云桥（与 demo `?clouds=0` 的零回归路径一致） |
| `quality` | `'low' \| 'medium' \| 'high' \| 'ultra'`；库缺省 `'high'` | 云质量档位，只能从顶层传。`undefined` 不调用 `setQuality` |
| `assetsBaseUrl` | `string`；默认 `new URL('cesium-geospatial-assets/', document.baseURI).href` | 资产根目录（末尾斜杠可选）。子路径部署 / 非根 `base` 依赖这个「相对 `document.baseURI`」的默认值 |
| `assets` | `{ luts?, weather?, moonSurface?, moonDisplacement? }` | 逐项覆盖为**完整 URL**（不再拼默认目录），用于 CDN |
| `takeOverScene` | `boolean`；默认 `true` | `false` 跳过完整接管表（§4），但仍会快照/还原 `globe.depthTestAgainstTerrain`，并要求宿主自行开对数深度 |
| `allowExistingStages` | `boolean`；默认 `false` | 场景已有 `postProcessStage` 时是否放行（放行后链顺序由调用方自负，见 §5） |
| `autoDestroy` | `boolean`；默认 `true` | Viewer / CesiumWidget 的 `destroy` 是否联动 `handle.destroy()`。`false` 时 target 销毁既不联动、也不取消进行中的安装；Scene 目标无此钩子 |

另外两条安装期硬约束（无论选项如何）：

- `scene.logarithmicDepthBuffer` 设置后读回必须为 `true`，否则还原场景并抛错（shader 无条件反演对数深度）；
- 安装瞬间 `scene.mode` 必须是 `SceneMode.SCENE3D`。

嵌套选项类型可从包入口命名导入：`AtmosphereStageOptions`、`CloudsStageOptions`、
`CloudsQualityPreset`。

---

## 4. 场景接管（13 项）与无条件还原

安装时按下列表写值；`handle.destroy()` 时**按安装前的快照逐项写回**（不做「值是否仍等于安装值」
的归属判断）。含义：**安装期间宿主自己改这些设置，destroy 后也会被还原**——需要保留的宿主
自定义请在 `destroy()` 之后重新应用，或用 `takeOverScene: false`。

| # | 设置 | 安装值 | 备注 |
|---|---|---|---|
| 1 | `scene.logarithmicDepthBuffer` | `true` | 读回校验；`takeOverScene: false` 时宿主必须自行开启 |
| 2 | `scene.globe.depthTestAgainstTerrain` | `true` | 唯一**不受 `takeOverScene` 门控**的接管项：底层 atmospheric stage 无条件设置它（`depthTexture` 需要真实地形深度），destroy 时按快照还原 |
| 3 | `scene.highDynamicRange` | `false` | 否则 Cesium 会在本库 stage 之前 tonemap；tonemap 由链尾自有 stage 负责 |
| 4 | `scene.requestRenderMode` | `false` | 否则云/太阳在无输入时冻结；还原为 `true` 时 destroy 会补一帧 `requestRender()` |
| 5 | `scene.skyAtmosphere.show` | `false` | 由本库大气渲染 |
| 6 | `scene.skyBox.show` | `false` | |
| 7 | `scene.sun.show` | `false` | 太阳由大气/镜头光晕渲染 |
| 8 | `scene.moon.show`（存在时） | `false` | 月盘由本库渲染（含月面纹理） |
| 9 | `scene.fog.enabled` | `false` | 地平线雾由大气透视负责 |
| 10 | `scene.globe.showGroundAtmosphere` | `false` | |
| 11 | `scene.globe.enableLighting` | `false` | **同时丢掉 Cesium 原生地形阴影** |
| 12 | `scene.backgroundColor` | `Color.BLACK` | 清屏色由大气 stage 全屏覆盖 |
| 13 | `scene.globe.baseColor` | `#3a3a3a`（`Color(58/255,58/255,58/255,1)`） | 无影像（`baseLayer:false` / 裸 globe）时的地球占位底色，对齐 demo 验收档。Cesium 缺省是深蓝 `Color(0,0,0.5,1)`：不接管时半透明云层透出的底色偏蓝，产品与 demo 画面不等价（2026-10-28 裁定） |

还原规则补充：

- **按对象记录快照**：`globe` / `skyAtmosphere` / `skyBox` / `sun` / `moon` / `fog` 上的设置记在
  捕获时的对象上。宿主在安装期间替换了 `scene.globe` 等对象，旧值不会写到新对象上。
- `takeOverScene: false`：本库从未改过第 1、3–13 项，destroy **不写回**（避免静默覆盖宿主
  在安装期间自己设置的值）；只还原第 2 项。
- 3D 守卫：`morphStart` 时立即停用本库全部 stage 与云（含 march / resolve primitive），
  `morphComplete` 回到 `SCENE3D` 按 morph 前的启用态恢复（宿主手动关过的云不会被复活）；
  落到 2D / Columbus 保持停用，切回 3D 自动恢复。每次安装最多警告一次。

### 安装时会被 warn（不阻断）的场景设置

`scene.postProcessStages.ambientOcclusion.enabled`、`.bloom.enabled`、`.fxaa.enabled` 为 `true`
时会 `console.warn`。原因：AO / bloom 作用在本库 stage 之前，FXAA 被 Cesium 恒排在链尾
tonemap 之后，画面会与 demo 验收档不同。建议安装前关掉。

---

## 5. 既有后处理的迁移

安装前若 `scene.postProcessStages.length > 0`，install 会**拒绝安装**并给出迁移步骤（因为
Cesium 会把既有用户 stage 排在本库 stage 之前，链顺序无法保证）。迁移三步：

```ts
// 1. 安装前清空既有用户 stage。
//    注意：Cesium 的 remove(stage) / removeAll() 会「移除并销毁」stage——原有对象不可复用，
//    需要保留的效果请在安装后重新创建。
scene.postProcessStages.removeAll()

// 2. 安装后创建并插入自定义后处理
const handle = await installAtmosphereClouds(viewer)
const myStage = new PostProcessStage({ /* ... */ })
handle.insertStageBeforeLensFlare(myStage)

// 3. 不再需要时移除（本方法同样会一并销毁 stage）
handle.removeInsertedStage(myStage)
```

关键语义：

- **插入位置**：`insertStageBeforeLensFlare` 把 stage 追加到 atmosphere 之后、lensflare / tonemap
  之前；多次插入按插入顺序执行。这是 `AtmosphereStageHandle` 的**破坏性变更**（旧版是单槽替换）。
- **输入是线性 HDR**：经 handle 插入的 stage 拿到的是 atmosphere 之后的线性 HDR 颜色，不是
  原始 globe 颜色；tonemap 与 gamma 在链尾统一收尾。shader 必须按线性域处理（否则画面会
  过亮/发灰）。
- **所有权转移**：安装期间经 `handle.insertStageBeforeLensFlare` 插入的 stage 归库管理——
  `handle.destroy()` 会一并移除并销毁它们；宿主需要的话在 destroy 后自行重建。
- 逃生门 `allowExistingStages: true` 只跳过拒绝，不调整链顺序；除非你清楚自己在做什么，不要用。

---

## 6. 资产、部署与 CORS

### 6.1 目录布局

`copy-assets --out public/cesium-geospatial-assets` 产出的结构（与包内 `assets/` 一致）：

```
public/cesium-geospatial-assets/
  luts/    transmittance.bin  scattering.bin  irradiance.bin  higher_order_scattering.bin
  clouds/  shape.bin  shape_detail.bin  stbn.bin  local_weather.png
  moon/    moon-surface.webp  moon-displacement.webp
```

默认 `assetsBaseUrl` = `new URL('cesium-geospatial-assets/', document.baseURI)`，即
`/cesium-geospatial-assets/`、Vite `base: '/app/'` 下的 `/app/cesium-geospatial-assets/`、以及
`<base href>` 都无需改代码。

### 6.2 字节长度校验

所有 `.bin` 按**精确字节数**校验（`r.ok` 挡不住 Vite dev / SPA fallback 的 `200 text/html`）：

| 资产 | 字节数 |
|---|---|
| `luts/transmittance.bin` | 131072 |
| `luts/scattering.bin` | 8388608 |
| `luts/irradiance.bin` | 8192 |
| `luts/higher_order_scattering.bin` | 8388608（`clouds: false` 时不请求） |
| `clouds/shape.bin` | 2097152 |
| `clouds/shape_detail.bin` | 32768 |
| `clouds/stbn.bin` | 1048576 |
| `clouds/local_weather.png`、`moon/*.webp` | 非空 + 可解码 |

长度不符时抛错，消息包含 **URL、期望字节、实际字节、Content-Type**，例如：

```
资产长度不符：http://localhost:5173/cesium-geospatial-assets/luts/transmittance.bin
（期望 131072 字节，实际 1000 字节，content-type: application/octet-stream）——缺失资产常以 200 text/html 返回
```

安装因资产失败时会先还原场景再抛错（场景不会留下半接管状态）。

### 6.3 CDN 与 CORS

- `.bin` / `.png` 走 `fetch()`，`.webp` 走 Cesium `Resource.fetchImage`（跨源时自动
  `crossOrigin = 'anonymous'` 等价匿名请求）。**跨域部署时服务器必须返回
  `Access-Control-Allow-Origin`**。
- 月面纹理是可选增强：请求 / 解码 / 合成任何一步失败都只 `console.warn` 并回退均匀月面
  （安装继续）；`.bin` 失败则是硬错误（LUT 缺失无法渲染）。
- 逐项覆盖示例：

```ts
await installAtmosphereClouds(viewer, {
  assetsBaseUrl: 'https://cdn.example.com/cesium-geospatial/',
  assets: { luts: 'https://cdn.example.com/luts-v2/' }
})
```

---

## 7. 销毁、并发与安装失败

### 7.1 `destroy()`

`handle.destroy()` 幂等，释放顺序固定：

1. 3D guard 监听；
2. 云 stage（overlay + march / resolve primitive）；
3. 经 handle 插入的宿主 stage（移除并销毁）；
4. 大气 stage（含内部惰性 dummy 纹理）；
5. install 持有的纹理：4 张 LUT + 4 张天气 + 月面合成纹理（约 20MB GPU 显存）；
6. 场景设置按快照还原（§4）。

destroy 后 `scene.postProcessStages` 数量、场景设置、GPU 纹理均回到安装前；`isInstalled()`
返回 `false`，可直接重新安装（全新实例）。

### 7.2 并发与重复安装

| 场景 | 行为 |
|---|---|
| 安装中再次 `installAtmosphereClouds` | 返回**同一个** Promise；第二个调用方的 options 不生效并 `console.warn` |
| 已安装完成再次调用 | 返回既有 handle + `console.warn`（options 不生效）；要换配置先 `destroy()` |
| `handle.destroy()` 后再 install | 全新安装 |
| `isInstalled(target)` | 仅在**已安装完成**时为 `true`；安装中、已销毁、安装失败均为 `false` |

### 7.3 安装中 target 被销毁

`autoDestroy`（默认 `true`）会在**第一个 await 之前**包装 `viewer.destroy` / `widget.destroy`。
安装过程中 target 被销毁：

- 安装被取消并回滚，Promise 以 `InstallCancelledError` `reject`；
- 若 GL 上下文已随 target 释放，跳过 stage / 纹理的 GL 销毁（只清注册表与监听）；
- `InstallCancelledError` 与普通安装失败可区分（`instanceof`），调用方应按需 `catch`。

```ts
try {
  await installAtmosphereClouds(viewer)
} catch (error) {
  if (error instanceof InstallCancelledError) return   // 页面已关/已销毁，无需处理
  throw error
}
```

### 7.4 安装失败语义

| 失败点 | 后果 |
|---|---|
| 自检 / 非 3D / 既有 stage 拒绝 | 无任何改动，直接抛错（消息含原因与迁移步骤） |
| 对数深度读回失败 / 资产校验失败 / 大气创建失败 | 已接管 → 还原场景后抛错 |
| 月面纹理解码失败 | `warn` + 回退均匀月面，安装成功 |
| 天气 / 云创建失败 | 大气保留，返回仅含大气的 handle，错误在 `handle.cloudsError` |
| 云 overlay 插入失败 | 全量回滚（云、纹理、大气、场景）后抛错 |
| 安装中 target 被销毁 | 全量回滚后 `reject(InstallCancelledError)` |

### 7.5 HMR 说明

`src/index.ts` 里有 `import.meta.hot.dispose(() => disposeAllForHmr())`：**只在宿主直接消费源码
（workspace / 源码 alias）时生效**。消费 `dist/` 构建产物时该分支被静态消除（产物里没有
`import.meta`），HMR 不会自动 destroy。

---

## 8. submodule 升级流程

按顺序全做一遍，漏一步的典型症状是「代码升级了但宿主仍用旧 dist / 旧资产」：

```bash
# 1. 移动 submodule 指针（拉到目标 tag/commit），并在宿主仓库提交指针变更
git -C vendor/cesium-geospatial fetch --tags
git -C vendor/cesium-geospatial checkout <tag-or-sha>
git add vendor/cesium-geospatial && git commit -m "chore: 升级 cesium-geospatial"

# 2. 在 submodule 内重新安装 + 构建 dist（prepare 自动跑；必须看到新的 build-stamp.json）
pnpm --dir vendor/cesium-geospatial install

# 3. 刷新资产（已接进 predev/prebuild 的话可省，这里显式执行一次）
node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets

# 4. 重装宿主依赖（pnpm 的 file: 是实体副本，不重装不会刷新）
pnpm install

# 5. 一致性校验：源码没变、副本与 submodule 同源
node vendor/cesium-geospatial/bin/cli.mjs check \
  --root vendor/cesium-geospatial \
  --copy node_modules/cesium-geospatial
```

`check` 的两种失败与修复：

| 输出 | 含义 | 修复 |
|---|---|---|
| `源码已变更但未重新构建`（戳内/实际 `sourceHash` 不一致） | submodule 拉了新代码但没 build | `pnpm --dir vendor/cesium-geospatial run build` |
| `副本 … 与根 … 的构建不一致（副本陈旧）` | 宿主的 `file:` 副本还是旧的 | `pnpm install` |
| `缺少构建戳 …` | `prepare` 被跳过或构建失败 | 显式 `pnpm --dir vendor/cesium-geospatial run build` |

---

## 9. 已知影响与限制

### 9.1 Cesium 1.146.0 不能用（云 shader 编译失败）

1.146 会自动注入 `out_FragData_*` 片段输出，与本库云 MRT shader 的显式
`layout(location=…)` 输出（`outputColor` / `outputDepthVelocity`）位置冲突：

```
'out_FragData_1' : conflicting output locations with previously defined output 'outputDepthVelocity'
'out_FragData_0' : conflicting output locations with previously defined output 'outputColor'
```

表现是页面右上角 `An error occurred while rendering` + 不渲染。纯 Cesium、以及本库仅大气
都正常，**只要装云就崩**。已验证组合是 **cesium 1.143.0 + `@cesium/engine` 26.1.0 +
`@cesium/widgets` 16.1.0**（§2 步骤 4 的 overrides 即为此刻锁定）。

### 9.2 `@cesium/engine@26.4.0` 与 cesium 1.143 的 ESM 入口不兼容

见 §2 步骤 4：必须 override 到 26.1.0，否则 Vite dev 报
`No matching export in "…/cesium/Source/Cesium.js" for import "AttributeCompression"`。

### 9.3 宿主 3D Tiles / labels / models 会被压暗

本库的成分为 `originalColor × transmittance × groundDim + inscatter`：所有进入屏幕的
3D 内容（3D Tiles、labels、实体）都按地表处理，被 `groundDim`（缺省 0.43）与地面光色
乘子压暗，并叠加大气透视。这是物理上正确的结果，但与未接入时的观感不同；需要更亮可调
`atmosphere.groundDim`（1 = 不衰减）。

### 9.4 globe 原生光照与地形阴影关闭

`globe.enableLighting = false`（§4 第 11 项）意味着 Cesium 原生地形阴影不再出现；
昼夜感由大气系统提供。

### 9.5 非 3D 视图

安装要求 `SCENE3D`；运行时 3D→2D morph 会自动停用本库全部效果，回到 3D 恢复。2D / Columbus
下保持停用（大气与云的世界系与深度语义不适用于 2D 投影）。

### 9.6 云在 50km 以上开始渐隐、300km 以上全隐

设计行为（太空俯视视角的 march 域外伪影不可根治，视觉贡献趋零）：远距离默认全球视角
（~15000km）只能看到大气，看不到体积云。想首屏看到云，请把相机放到 300km 以下
（`examples/basic` 用 15km 俯视云海）。

### 9.7 月面角半径与亮度补偿不自动做

install 会加载月面纹理（`moonSurfaceTexture`），但不按纹理均值补偿 `moonRadianceScale`，
也不随 `moonAngularRadius` 自动保亮度——默认路径与 demo 缺省档逐值一致。若宿主自行改
`atmosphere.moonAngularRadius`，月盘显示亮度会按 `k²`（k = 新值 / 0.014）变化，需要自行设置
`moonRadianceScale = 1546 / albedoMean × k²`。注意：`albedoMean` **不在产品 handle 上暴露**，
`loadMoonTextures` 目前也不是公开导出（根包内部模块 `src/moonTexture.ts`）——需要精确补偿时，
按该文件的实现自行加载月面并计算合成均值（`modulateMoonPixels` 返回该均值）；只按 `k²`
近似也行，但会与默认档相差一个 `albedoMean` 倍率。

### 9.8 性能与电量

安装期间 `requestRenderMode` 被强制关闭（§4 第 4 项）：Cesium 会持续渲染，不再按需渲染。
这是云与太阳演化的前提；移动端/长时间挂机场景请自行考虑 destroy 时机。

---

## 10. 故障排查

| 症状 | 原因 | 修复 |
|---|---|---|
| `资产请求失败：…（HTTP 404）` | 没跑 copy-assets 或 `--out` 与服务目录不一致 | 按 §2 步骤 3 拷贝；检查 `assetsBaseUrl` |
| `资产长度不符：… 期望 131072 字节，实际 …`，content-type `text/html` | 服务器 SPA fallback 把缺失资产返回成首页 | 同上；确认静态目录映射 |
| `安装自检失败：… 不在已验证版本表` 只是 warn，但画面全黑/渲染面板报错 | 宿主用了 1.146.x | 降到 1.143.0 并按 §2 步骤 4 加 overrides |
| `No matching export in "…Cesium.js" for import "AttributeCompression"` | `@cesium/engine` 解析到 26.4.0 | 加 `pnpm.overrides`（§2 步骤 4）后干净重装 |
| `场景已有 N 个后处理 stage…` | 宿主已有 postProcessStage | 按 §5 迁移 |
| `安装自检失败：… scene.context.webgl2 非 true` / 缺 `fragmentDepth` / `depthTexture` | 浏览器或上下文不满足 | 换 WebGL2 环境；检查 Cesium 初始化参数 |
| `场景进入非 3D 视图（morph）…` warn | 3D→2D morph | 正常行为；回 3D 自动恢复 |
| 云不可见，但大气正常 | 相机高度 > 300km（§9.6），或 `clouds: false` | 降到 300km 以下；检查 `handle.clouds` 是否存在 |
| 月面是均匀白盘 | 月面 webp 加载/解码失败（跨域缺 CORS） | 服务器加 `Access-Control-Allow-Origin`；看 `[moon-surface]` warn |
