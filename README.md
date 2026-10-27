# cesium-geospatial

把 **three-geospatial**（Bruneton 大气参考实现）的 **物理大气** 与 **体积云** 渲染移植进 **Cesium**：以原生 `PostProcessStage` 后处理注入，不替换 Globe、不 fork Cesium，复用 Cesium 内置的 `czm_*` uniforms、对数深度与 `depthTexture`。

## 效果特性

- **物理大气**（Bruneton 模型，预计算 LUT）：天空散射、大气透视、昼夜/晨昏过渡、太空视角大气边缘辉光（limb glow）
- **方向性月光 + 物理月盘**：月光作为第四光照项进云照明（方向/强度随月相），月盘 Oren-Nayar + IAU 月固系月面纹理（月海/环形山与真实天文一致，潮汐锁定），月相从太阳-月几何自动涌现
- **动态曝光**：按相机当地太阳高度角自动切换昼/夜曝光，晨昏带平滑过渡
- **镜头光晕**（LensFlare）：太阳入镜时 ghost/halo/bloom，image-based，物理感光；云遮挡联动（太阳被云挡时 halo/ghost 按云覆盖率衰减）
- **体积云**（raymarch）：3D 噪声形状 + 全球天气图覆盖——纬度气候带分布（ITCZ/副热带晴空带/温带气旋带）+ 时间切片演化（云图随时间聚散形变，高卷云演化快于低云）+ 风场平流（云团整体漂移、云内纹理同步流动），级联 **BSM 自阴影**（世界锚定固定网格），云间 **god rays** 光柱
- **性能自适应**（2026-09-05）：夜晚太阳侧次级采样自动门控（辐照精确零，逐位等价）+ 太阳角影子预算（BSM 步数随太阳高度平滑收缩）+ god rays march 分辨率与 BSM 信息量对齐——平视地平线视角类实测云甲内夜 30→60FPS、贴地夜 17→9.4ms，白天逐位零回归
- **HDR 管线**：HalfFloat 中间缓冲 + AGX tonemap（缺省，2026-10-24 对齐参考库；`?toneMap=aces` 回 ACES filmic 对照）+ display dithering

## 作为库使用（四步接入）

仓库根包 `cesium-geospatial` **本身就是产品包**（deck.gl 模式）：通过 git submodule + `file:`
依赖接进已有的 CesiumJS 项目，不需要读 demo 源码、不需要自己准备资产或排后处理链。

> **Cesium 版本警告：当前只验证 1.143.x，不要把宿主升到 1.146.0。** 1.146 会自动注入
> `out_FragData_*` 片段输出，与本库云 MRT shader 的显式 `layout(location=…)` 输出
> （`outputColor` / `outputDepthVelocity`）位置冲突，fragment shader 编译失败、渲染中止
> （右上角 `An error occurred while rendering`）。把 cesium 钉在 `1.143.0`，并按下面第 4 步
> 加上 `@cesium/engine` overrides。详见 [docs/integration.md §9.1](docs/integration.md#91-cesium-11460-不能用云-shader-编译失败)。
> **1.146.0 是已知坏版本：安装自检会直接报错（`installAtmosphereClouds` 抛错），不是只打印 warning。**

### 1. submodule 引入

```bash
git submodule add <本仓库地址> vendor/cesium-geospatial
git submodule update --init --recursive
```

### 2. 在 submodule 内安装并构建 `dist`

```bash
pnpm --dir vendor/cesium-geospatial install
```

`prepare` 会自动跑 `vite build` + d.ts + 构建戳。**成功判据**：能看到
`vendor/cesium-geospatial/dist/build-stamp.json`（`--ignore-scripts` 会跳过 prepare，此时显式
`pnpm --dir vendor/cesium-geospatial run build`）。

### 3. 首次拷贝运行期资产（之后接进 `predev` / `prebuild`）

```bash
node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets
```

把这两条写进消费方 `package.json`，submodule 升级后就不会忘：

```json
"predev": "node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets",
"prebuild": "node vendor/cesium-geospatial/bin/cli.mjs copy-assets --out public/cesium-geospatial-assets"
```

### 4. 声明 `file:` 依赖并安装

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

`file:` 会被 pnpm 按本包 `files` 字段拷成实体副本（不含 `src`）；**submodule 指针移动后必须
重新 `pnpm install`**。`@cesium/engine` 必须钉 26.1.0（26.4.0 与 cesium 1.143 的 ESM 入口
不兼容，Vite dev 报 `No matching export ... "AttributeCompression"`）。

### 十行接入代码

```ts
import { Viewer } from 'cesium'
import { installAtmosphereClouds } from 'cesium-geospatial'

const viewer = new Viewer('cesiumContainer')

// 顶层 await 需要 es2022 构建目标；Vite 缺省 es2020，实际项目请用 async 函数包一层
const handle = await installAtmosphereClouds(viewer, { quality: 'high' })

// 释放：云 → 大气 → 纹理 → 场景设置还原；幂等
window.addEventListener('beforeunload', () => handle.destroy())
```

### 已验证 Cesium 版本

| Cesium 版本 | 状态 | 说明 |
|---|---|---|
| `1.143.0` | **已验证** | 与 `@cesium/engine@26.1.0` / `@cesium/widgets@16.1.0` 组合；`examples/basic` 与消费方冒烟矩阵均基于此 |
| `1.143.x` 其他补丁 | 未逐版验证 | 补丁级通常兼容；运行期 `console.warn`，不阻断安装。建议钉 `1.143.0` |
| `1.146.0` | **已知坏** | 装云时云 shader 编译失败、渲染中止（见上方警告）；**安装自检直接报错，install 时抛错** |
| 其他 1.x | 未验证 | 运行期 warn；升级前先跑 `examples/basic` 冒烟 |

`peerDependencies` 声明为宽范围 `>=1.143.0 <2.0.0`（避免 npm 7+ ERESOLVE 装不上）；版本/能力
自检在安装前执行：能力缺失（`Texture3D` / `fragmentDepth` / `depthTexture` / 非 WebGL2 / 非 3D）
直接抛错；未验证版本只 warn；**已知坏版本（`1.146.0`）与能力缺失同级——直接抛错**。

完整选项、场景接管全表、资产与 CORS、并发与销毁、submodule 升级流程见
[**docs/integration.md**](docs/integration.md)；API 与类型索引见 [**docs/api.md**](docs/api.md)；
可直接运行的最小工程见 [`examples/basic/`](examples/basic/)。

## 快速开始（本仓库 demo 验收）

> 这一节是给本仓库开发/验收用的 demo；消费方接入见上一节。

环境要求：Node ≥ 20，pnpm ≥ 10（仓库用 `packageManager: pnpm@10.32.1` 锁定）。

```bash
pnpm install

# 可选：配置 Cesium ion token（影像/地形底图用；不配则自动降级裸 globe，大气/云照常可看）
echo 'VITE_ION_TOKEN=你的token' > apps/demo/.env.local

pnpm dev          # 启动 demo（= pnpm --filter demo dev）
```

浏览器打开 <http://localhost:5173> 即是主体验：`mode=atmosphere` 完整大气 + 体积云默认开启、帧率角标默认关闭（2026-09-03 拍板）。回归对照用 `?mode=sky`（Phase 0 天空）/ `?mode=depth`（深度调试），关云 `?clouds=0`，帧率角标 `?fps=1`。

> 渲染异常排查提示：多次热更新后如出现画面异常（云位置偏移、颜色错乱等），先清 vite 缓存再判断——`pkill -f vite && rm -rf apps/demo/node_modules/.vite && pnpm dev`。

## 推荐体验 URL（直接复制）

基准视角：白天云海 + 体积云自阴影 + god rays（7852m 高空俯视云层）：

```
http://localhost:5173/?time=2026-08-28T17:30:00Z&camera=-80.6057,64.5197,7852,68.8,-17.8
```

在此之上追加参数的常用场景：

| 场景 | URL |
|---|---|
| 低太阳角晨昏近景（暖色侧光、长影） | `?time=2026-08-29T00:45:00Z&camera=-80.6057,64.5197,1400,68.8,-25` |
| 太空视角大气边缘辉光 | `?time=2026-08-28T17:30:00Z&camera=93.9439,31.6997,61883,89.2,-19.0` |
| 关自阴影对比（云更"平"） | 基准 + `&cloudsShadow=0` |
| 关云间光柱对比 | 基准 + `&cloudsLightShafts=0` |
| 光柱艺术放大（默认 1 为物理量级，subtle） | 基准 + `&cloudsGodRays=20` |
| 关镜头光晕 | 基准 + `&lensflare=0` |
| 关大气后处理（纯 Cesium 对照） | 基准 + `&atmo=0` |
| 无 token 裸 globe | 基准（不配 `.env.local` 即是） |

> 相机停稳后地址栏 hash 会自动更新为 `#camera=lon,lat,height,heading,pitch`——复制整个地址即可精确复现/分享当前视角。

### 七个月相夜景（月亮 + 体积云 + 天际线同框，已实测）

同一高空观测点（越南上空 3106m），各取月相与月升落窗口内太阳已沉没的时刻——夜空冷蓝月盘照云，天际线在画面下 1/3：

| 月相（照明比） | time（UTC） | 完整 URL |
|---|---|---|
| 娥眉月（f≈0.09） | 2026-10-15T12:00Z | `?time=2026-10-15T12%3A00%3A00Z&camera=103.8929,16.5428,3106,229.5,15.9` |
| 上弦月（f≈0.31） | 2026-10-18T15:00Z | `?time=2026-10-18T15%3A00%3A00Z&camera=103.8929,16.5428,3106,236.3,12.5` |
| 盈凸月（f≈0.73） | 2026-09-22T17:30Z | `?time=2026-09-22T17%3A30%3A00Z&camera=103.8929,16.5428,3106,238.2,20.2` |
| 满月（f≈0.97） | 2026-09-25T12:00Z | `?time=2026-09-25T12%3A00%3A00Z&camera=103.8929,16.5428,3106,103.4,21.2` |
| 亏凸月（f≈0.77） | 2026-11-27T15:00Z | `?time=2026-11-27T15%3A00%3A00Z&camera=103.8929,16.5428,3106,68.8,14.7` |
| 下弦月（f≈0.37） | 2026-11-30T18:00Z | `?time=2026-11-30T18%3A00%3A00Z&camera=103.8929,16.5428,3106,85.4,15.2` |
| 残月（f≈0.17） | 2026-12-02T20:00Z | `?time=2026-12-02T20%3A00%3A00Z&camera=103.8929,16.5428,3106,101.0,18.4` |

> 娥眉月照明面积小（~6%），天际线构图下画面接近全黑是**物理正确**（亚像素宽的月牙暮光）；想看明显的月牙可把 pitch 再抬高或换 `time` 到月更高时。月相由 `time` 决定的太阳-月几何自动涌现，改任意时间都能得到正确相位；表中 URL 是逐相实测过月亮/云/天际线同框的取点。时间默认正常流速流动——打开即从取点时刻走时（短时内构图基本不变）；需精确定格追加 `?play=0`。

## URL 参数说明

### 基础

| 参数 | 说明 |
|---|---|
| `mode` | `atmosphere`（完整大气+云主分支，**默认**）/ `sky`（Phase 0 天空对照）/ `depth`（深度调试） |
| `clouds` | 体积云开关，**默认开**（`clouds=0` 关闭；仅 atmosphere 模式生效） |
| `time` | ISO8601 时间，决定太阳方向（昼夜、太阳高度角）。例：`2026-08-28T17:30:00Z` |
| `play` / `speed` | 时间流动**默认开、正常速度**（太阳/云演化/平流按真实流速持续变化，2026-09-03 拍板）；`play=0` 冻结，`speed=N` 调倍率（如 `speed=60` = 1 秒 1 分钟延时）。确定性验收用 `?time=` 钉初值 + `?play=0` 冻结 |
| `camera` | 初始视角 `lon,lat,height,heading,pitch`（角度制；heading/pitch 可省略，默认 0/-90） |
| `ionToken` | URL 传 Cesium ion token（优先级低于 `.env.local` 的 `VITE_ION_TOKEN`） |
| `fps=1` | 开启右上角帧率/帧时显示（**默认关**） |

### 大气调节

| 参数 | 默认 | 说明 |
|---|---|---|
| `exposureDay` / `exposureNight` | 1.2 / 0.1 | 昼/夜曝光（按太阳高度角自动插值） |
| `groundDim` | 0.43 | 地表反射衰减（压地面过曝；1=不衰减；0.5→0.43 与地面光色乘子联算重标——正午乘子≈1.0-1.15 压回同量级） |
| `groundLighting` | 1 | 地面光色乘子（2026-09-01 影像×大气颜色同步）：影像=正午白光快照，乘子=(太阳直射透射+天光辐照)/solar_irradiance 让影像随太阳高度染色——日落近景橙红、夜间近黑（三专家评审定稿变体 1；0=旧合成 A/B 对照兼 CI 逃生门）。开启时自动配 lighting=0（enableLighting 夜侧 N·L 置黑像素与乘法地板冲突，?lighting=1 显式保留旧组合） |
| `groundNightAmbient` | 0.55,0.62,0.78 | 地面夜间环境底色 r,g,b（sun/sky 双归零后乘子→0，max() 地板接住；冷蓝默认，按曝光链 0.1 预放大；量级显暗属预期——夜间 exposure 压回） |
| `inscatterScale` | 8 | 内散射放大（2026-09-02 定稿 25→8，近景海景视角实测；1=回退物理量级，偏淡；25=旧默认） |
| `distanceScale` | 1 | 散射距离缩放（等效空气密度倍率） |
| `ditherScale` | 1 | dithering 强度倍率（放大打散 banding） |
| `limbGlow` / `limbDecay` | 1.0 / 30 | 太空视角大气边缘辉光强度 / 扩散范围 km（强度 1.0 线性域、独立加 finalColor 不乘 inscatterScale；`limbGlow=0` 关） |
| `toneMap` / `agxExposure` | AGX / 1.0 | 色调映射模式：缺省 AGX（2026-10-24 对齐参考库），`?toneMap=aces` 回退 ACES Filmic（A/B 对照）；`agxExposure` 标定 AGX 曝光（本项目 exposure 已在 atmosphere 施加，AGX 段不再二次放大） |
| `lighting=0` | 开 | 关 Cesium 原生地表光照（无昼夜分界线，大气仍提供昼夜感） |
| `atmo=0` | – | 跳过全部大气后处理，画面=纯 Cesium globe |
| `hdr=0` | 自动 | 强制 RGBA8 管线（HalfFloat 设备上对比用） |

### 月亮（月盘 + 月光照云）

| 参数 | 默认 | 说明 |
|---|---|---|
| `moon=0` | 开 | 全关（月盘不渲染 + 云月光乘 0，诊断基线） |
| `moonRadiance` | 1546 | 月盘亮度倍率（改 `moonAngularRadius` 时自动 ×k² 补偿保亮度） |
| `moonAngularRadius` | 0.014 | 月盘角半径 rad（物理值 ×3.1，~17px 盘径） |
| `moonTint` | 0.72,1,1.32 | 月盘色调乘子（线性 RGB；`1,1,1` 回中性） |
| `moonDispScale` | 1 | 环形山对比度强度（0=纯颜色图，>1 更强） |
| `moonSurface=0` | 开 | 关月面纹理（均匀月面基线） |
| `moonLightScale` | 25000 | 云月光倍率 |
| `moonGlow` | 200000 | 月晕倍率（月光天空散射——月盘周围天空柔光增亮；`0`=关） |

### 镜头光晕（LensFlare）

| 参数 | 说明 |
|---|---|
| `lensflare=0` | 关闭 |
| `lfIntensity` / `lfThreshold` / `lfGhost` / `lfHalo` / `lfPreBlur` | 强度 / 阈值 / ghost 量 / halo 量 / 模糊半径倍数 |

### 体积云

| 参数 | 默认 | 说明 |
|---|---|---|
| `cloudsQuality` | `high` | 质量档位 `low`/`medium`/`high`/`ultra`：march 步数（high=缺省 `minStepSize` 25，low 100，ultra 10）/编译开关（光柱/细节/湍流/精确天光）/BSM 级联数与尺寸整档联动；四档 march 降采样均为 1/4（见 `cloudsUpscale`）；键盘 `1`-`4` 运行时切换 |
| `cloudsExposure` | 12 | 云层曝光（线性域缩放，链尾统一 tonemap；偏灰调大、过曝调小） |
| `cloudsNightAmbient` | 0.03 | 夜间环境底光：太阳沉没后云照明地板（0 = 关闭回退纯黑夜间云）。2026-09-02 过亮重标（原 0.12 标定漏算 ACES+gamma 暗部放大+月光叠加未整体验收，深夜云带亮度达夜空底光 30 倍）；?cloudsNightAmbient=0.12 可回旧行为 |
| `cloudsNightRetreat` | 0.25 | 月光地板退让上限（2026-09-21）：底光乘 mix(1, 本值, moonFactor)——月光（真实照明）主导时非物理底光让位，moonFactor=月相×月高度门（0 新月/月落、1 满月+月高）。满月夜地板贡献 ×1/4 对冲 84f3306 后残余偏亮（>120 像素 24%）；1=关零回归（新月/月落/白天逐位） |
| `cloudsTint` | 0.88,1,1 | 夜间云色调乘子（线性 RGB，乘底光+月光；沿革冷蓝 1.32→弱蓝 1.15→中性偏暖定稿） |
| `cloudsTwilightBoost` | 6 | 暮光天光补偿倍率：太阳 [+2°,-1.5°] 窗内云天光项 1→boost（黄昏云过黑修复——crude 天光+overlay 不乘动态曝光欠亮 ~3×；实测云/天空显示比 32%→80%；1=关；白天零回归） |
| `cloudsInLayerFog` | 0 | 层内雾化（2026-09-28 方案 A，**2026-10-27 缺省关闭**）：相机在云层带内时 march 专用路径（步长细化+早退抑制+去饱和提亮+出口 alpha 软化），治「层内单点辐射平刷」（1536 白板/1692 蓝板）。缺省关闭原因：该路径作用于所有层内像素，代价是云体变圆润、丢细节、出现等距等高线条纹（3158m 实测；逐条收窄无法根治）；`1`=恢复护栏 |
| `cloudsTopPuff` | 0 | 顶面蓬松化权重（2026-09-29 密度分布专项，**2026-10-27 缺省关闭**）：`1`=(1,1,0,0) L0/L1 开、L2 卷云关；`0`=全关。缺省关闭原因：它把云顶压成近乎等高的平台，俯视等于用平面切 3D 噪声 → 云面大量同心圆/等值线环纹（`?cloudsTopPuff=1` 可恢复该观感） |
| `cloudsFade=0` | 开 | 高空云层渐隐开关：相机高度 >50km 起云渐隐、>300km 全隐（太空俯视视角云 march 域外伪影不可根治且视觉贡献趋零，隐去后为干净蓝色地球；`0` 关闭看全量云盘）。近地/航空体验域（<50km）零影响 |
| `cloudsHitMipBoost=N` | 1 | 云内步 mip 调制倍率（甲内近水平性能修复，2026-09-04）：命中云后的 march 步长 `mix(stepSize, maxStepSize, min(1, mipLevel·N))` 与空区步 LOD 对齐——上游云内步只 ×1.01/步，甲内近水平「沿云飞」几十 km 时 500 步打满（2519m+pitch≈-9.5° 实测 28 FPS）。缺省 1=38 FPS 档（近景 <2km 逐位不变）；`4`=54 FPS（中景云略淡、俯视云海轻微糊化）；`8`=59 FPS 满帧（中景云墙消解，慎用）。近景/俯视主视觉优先保真时保持 1 |
| `cloudsShadow=0` | 开 | 关 BSM 自阴影（对比云体积感） |
| `cloudsShadowAnchor=frustum` | world | 回退视锥锚定 BSM（AB 对照基线；默认 world 世界锚定固定网格，抗移动闪动） |
| `cloudsShadowScale=N` | 1 | world 锚定 radii × N（诊断用，N=5 → {80,168,480}km 膨胀层） |
| `cloudsShadowFreeze=1` | – | 冻结 BSM 矩阵（首帧后不更新，噪声分解诊断） |
| `cloudsShadowTemporal=1` | 关 | BSM 时序累积 |
| `groundShadow` | `1` | M6 地面云影总开关；`0`=桥不注入（define 不开，与 main 逐位零回归）。注意 `cloudsShadow=0`（关自阴影）时地面云影连带关闭（无 BSM）。 |
| `groundShadowStrength` | 0.8 | 地面云影强度 0-1（demo 缺省 0.8，2026-09-30 拍板；库缺省 1=物理满档，勿 >1）；`0` 时采样短路（与 `groundShadow=0` 像素等价，便宜逐位门）。 |
| `cloudsShadowAdaptive=0` | 开 | 太阳角影子预算（2026-09-04）：BSM 生成端 march 步数随当地太阳仰角平滑收缩（≥20° 满档逐位原值，≤5° 收缩至一半），低太阳角运动帧省成本；`0`=恒满档逐位回退（逃生门） |
| `cloudsShaftStep=` | 100 | god rays shadowLength march 起始步长（米，2026-09-05 P1）：BSM 纹理 texel 实际足迹 62-375m，50m 本就过采样；100=缺省（迭代 -34%，贴地夜 17→9.4ms，黄昏光柱画面数值不可见级）；`50`=three 上游原值（光柱形态 A/B 对照）；`150`=更省（近级联 texel 2.4× 欠采样，慎用）。另：夜晚（太阳当地沉没 >5°）云照明自动跳过朝太阳次级采样（辐照精确为零，逐位等价，无参数）——云甲内夜视角实测 30→60FPS |
| `cloudsShaftFallbackScale=` | 自适应 | 兜底光柱步幅倍率（2026-09-21 P4）：无云像素（!hitClouds）的 shadowLength march 起步步长 = `cloudsShaftStep` × 本倍率。缺省按当地太阳仰角自适应 2→4（≤5°=×2 低角零回归域，≥20°=×4 白天逐位零差域，smoothstep 中间带）——兜底成本 ∝ 无云像素占比随时刻/天气漂移，高太阳角放开倍率对冲（实测某上午时刻 25.7→17ms 满帧）；`2`=恒 P3 静态行为；`cloudsShadowAdaptive=0` 时恒回 2 |
| `cloudsMotionShaft=` | 1 | 运动帧光柱步幅上限（2026-09-21 P5，**2026-10-26 缺省回退 1=关**）：相机运动时光柱 march（hitClouds+兜底两处）步幅乘 shaftMotionScale∈[1,本值]，静止精确 1 零回归。`4`=旧 P5 降载档（旋转 p50 22.7ms 档）；实测不粗化时运动中颗粒反而更低（1.24 vs 1.51），故缺省回满精度，`?cloudsMotionShaft=4` 可恢复降载 |
| `cloudsTemporal=0` | 开 | 云时序重建开关（`0` 回退全分 march 无 resolve）：march 低分辨率 + resolve 时域重建（帧率↑）。缺省 converge 档（2026-10-26 定稿）：相位持续轮换 + 静止关重投影 + 静止 EMA 1/256（停下头 6 帧先用 1/32 快速收敛）+ 运动 EMA 0.1（进入运动头 6 帧用 `cloudsMotionFlush` 洗掉旧历史）；静止判据=位移 <0.01m 且朝向变化 <1e-5 rad（慢拖/惯性尾段不再误判静止）；运动时远段（20-60km）另用 α=0.05 长窗（`?cloudsFarBlend=0` 关） |
| `cloudsUpscale` | 4 | march 降采样分母 `1`/`2`/`4`：**缺省 4 = 1/4 分 march**（四档预设均为 4，2026-10-24 对齐参考库；同帧实测颗粒 −54% 且帧率更高）；`2`=半分（RT 面积 ×4）；`1`=全分 march + resolve 切 TAA 分支（画质最佳、最贵，此时 `temporalAlpha`/`cloudsMotionAlpha` 才生效）。用户显式 > 质量档位 |
| `cloudsMotionAlpha` | 0.4 | 运动中混合比上限（仅 `cloudsUpscale=1` 的 TAA 分支）：相机移动/旋转超阈值时 resolve 的新帧占比从 0.1 平滑升至此值（拖影/错位换细颗粒，防移动抖动；停止自动回落收敛）。= temporalAlpha 时等效禁用 |
| `temporalAlpha` | 0.1 | 云 resolve 静止混合比（仅 `cloudsUpscale=1` 的 TAA 分支；新帧占比；0=纯 history 收敛慢，1=纯 current 无降噪） |
| `temporalGamma` | 2.0 | variance clipping AABB 宽度（大=更宽容 history 拖影多；小=更快贴 current 抖动大） |
| `cloudsDisocclusion` | 1.01 | disocclusion rejection 阈值：云 alpha 差异超阈拒 history 直出 current。缺省 `1.01`=关闭（2026-10-24 对齐参考库——该 rejection 让云缘每帧直出原始噪声=颗粒带）；`0.5`=2026-09-02 云地平线黑块修复档 |
| `cloudsMotionJitter` | 1 | 运动时 march 逐样本相位抖动倍率（2026-10-27）：`1`=满幅不调制；降低可压运动颗粒，但步进采样重新同相位 → 云面出现等高线状驻波环纹（`0.3` 即可见）。只缩放逐样本相位——起点抖动与朝太阳光深 march 的步数 dither 恒满幅（缩放会产生等距条纹/等高线阴影） |
| `cloudsMotionFlush` | 0.5 | 进入运动后头 6 帧的「洗历史」α：静止 1/256 长寿历史若按正常 α=0.1 衰减要约 30 帧才冲掉（刚开始转动半秒有拖影），故先大 α 快速洗掉再回落 |
| `cloudsHoldBlend` | 0.00390625 | 静止稳态 EMA 权重（=1/256）：停下后先用 1/32 收敛 `cloudsWarmupFrames`(6) 帧，之后切 1/256 长窗；相位仍持续轮换（冻结会把单相位锯齿烤进画面），但云面细碎游动残留降档 |
| `cloudsDejitter` | 1 | resolve 去抖动重采样（2026-10-27）：`1`=用 `texture(colorBuffer, vUv − u_jitterUV)` 把整帧平移过的低分图重采样回像素栅格（jitter 不再产生跨帧位移，history/current 同一栅格才能长窗累积）；`0`=旧点采样行为。jitter 以低分 FBO 尺寸归一化（N=4 时 ±1.5 全分像素，与参考库一致） |
| `cloudsMotionBlendDepthFalloff` | 0 | 运动 EMA 权重的距离衰减（0=关）：实测收益很小（rotate 13.0→12.6），按需开启 |
| `cloudsDetailLod` | 1.5 | detail 层显式 `textureLod` 的 LOD 值（缺省 1.5；`0`=mip0 全细节）。shape 层已对齐参考库恒 LOD 0（参考库 3D 纹理无 mip 链；LOD 随步长走会在入云首样本处跳变 → 以相机为圆心的同心环）；detail 保留此旋钮压 N=1 全分 march 的走样 |
| `cloudsLightShafts=0` | 开 | 关云间 god rays 光柱 |
| `cloudsGodRays=N` | 1 | god rays 增益（20=艺术放大出明显光柱） |
| `cloudsShapeDetail=0` / `cloudsTurbulence=0` / `cloudsAccurate=0` | – | 关对应噪声/光照分支（隔离诊断） |

> **伪影判别速查（2026-10-27 集中排查定论）**：俯视云面**同心圆/等值线环** → 顶面蓬松化（`?cloudsTopPuff=0` 已是缺省）与 shape 层纹理 LOD（已对齐参考库恒 LOD 0）；相机在云层带内**云体变圆润 + 等高线条纹** → 层内雾化路径（`?cloudsInLayerFog=0` 已是缺省）；**拖影** → 慢转判据（朝向变化 <1e-5 rad 才算静止，慢拖/惯性尾段不再冻结历史）/ 运动远段长窗（缺省 0.05，`?cloudsFarBlend=0` 可关）/ 起步洗历史（`cloudsMotionFlush`）；**运动颗粒** → march 采样密度（`minStepSize` 25 已压 −29%）优先于降步进抖动（`cloudsMotionJitter` 降幅有等高线驻波代价）。

#### 云分布重设计参数

| 参数 | 说明 |
|---|---|
| `?cloudsCoverage=` | 云密度 0-1（默认 0.4，2026-09-05 拍板 0.3→0.4） |
| `?cloudsAltitudeOffset=` | 低云带升降（米，clamp -500..+3000，默认 0） |
| `?cloudsWeather=` | 天气预设 clear\|fair\|cloudy\|overcast（与 `?cloudsCoverage=` 同传时显式密度优先，预设让位） |
| `?cloudsClimateBands=` | 纬度气候带强度（0=关，默认 1） |
| `?cloudsEvolutionHours=` | 云图演化环周期（小时，默认 5.3） |
| `?cloudsWind=` | 平流风速 m/s（默认 8） |
| `?cloudsSeed=` | 烘焙种子（默认 1337） |
| `?cloudsWeatherRepeat=` | 云图经向平铺瓦数（默认 400，纬向自动取半，瓦近物理方形 ≈100km；face 缝根治后为经纬等距圆柱域，400 与旧 face 域瓦尺寸观感连续。经度割缝靠偶数整周期闭合） |
| `?cloudsEvolutionPhase=` | 演化相位偏移秒（调试，不动太阳） |
| `?cloudsAtlas=0` | 逃生门：旧静态云图 |

#### 体积云 stage API（库消费者必读）

`createCloudsStage` 返回的 `overlayStage` **不会自动 add** 到 `scene.postProcessStages`——
add 时机由消费者编排，否则云不可见：

- **配合 atmosphere（推荐，demo 同款）**：把 overlay 插到 atmosphere 与 lensFlare 之间，
  云在线性 HDR 域合成、halo 光晕叠加在云上：

  ```ts
  const cloudsHandle = createCloudsStage(scene, luts, weather, { clouds: true })
  atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)
  ```

- **独立使用（无 atmosphere stage）**：自行 add 到链尾（云在 display 域直接上屏，
  无 halo 层级保证）：`scene.postProcessStages.add(cloudsHandle.overlayStage)`

`insertStageBeforeLensFlare` 语义：同实例幂等、传已 add/已销毁的 stage 抛错、失败尽力回滚；
云销毁调 `cloudsHandle.destroy()` 即可（链自动闭合）。**2026-10-27 起为有序多槽**：插入只追加、
不销毁旧槽，新增 `removeInsertedStage(stage)`（移除并销毁）；`protectedStage: true` 标记库自有项
（云 overlay），`removeInsertedStage` 拒绝移除。

> 产品接入直接用根包 `installAtmosphereClouds` 即可——上面这些接线（LUT/天气加载、云插入点、
> 线性 HDR 链、销毁顺序）全部由它负责，见 [docs/api.md](docs/api.md)。

### 诊断

| 参数 | 说明 |
|---|---|
| `debug=N` | 大气调试视图：1=finalColor 量级 / 2=太阳方向 / 3=相机距离量级 / 5=depth / 6=透传输入色 / 11=地面云影透射率灰度直显（R=groundSunTrans，定位采样/级联问题） |
| `cloudsDebug=N` | 云调试视图：1=天气图 UV / 2=云前深度 / 3=march 采样数 / 4=BSM 阴影图 / 5=级联层 / 6=march 分量 / 7=marchA / 8=末次采样光照 / 9=ext+光深+radiance / 10=aerial 前 rgb / 12=雾化三通道 / 13=raw weather |
| `tileCache=N` | 瓦片缓存（默认 5000，减少回收引起的深度时序抖动） |
| `sse=N` | 屏幕空间误差阈值（调高→瓦片更晚细化，减 LOD 抖动；地形更粗） |
| `profile=1` | 逐 stage GPU 计时（每 60 帧 console.log，需 EXT_disjoint_timer_query_webgl2） |
| `temporalEma=0` / `temporalQuality=high` / `depthThreshold=N` / `depthTemporal=1` | 深度时域平滑开关/档位/阈值/显式创建 |

## 常用命令

```bash
pnpm dev                 # 启动 demo
pnpm test                # 全部 workspace 测试（含 GLSL 编译测试，依赖 glslangValidator：brew install glslang）
pnpm build               # 构建产品包（dist + d.ts + build-stamp）
pnpm run verify          # 全链门禁：tsc → 根 vitest → 子包 vitest（core+clouds 含 GLSL 编译）→ build → assert-dist → 消费方类型 → 冒烟矩阵

# 单包测试 / 单文件 / 按用例名过滤
pnpm --filter @cesium-geospatial/core test
pnpm --filter @cesium-geospatial/clouds test
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts
pnpm --filter @cesium-geospatial/core exec vitest run -t "动态曝光"

# 类型检查（仓库无统一脚本，显式跑 tsc）
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit

# 构建戳一致性（改源码未重建 / file: 副本陈旧时报错）
node bin/cli.mjs check --root .
node bin/cli.mjs check --root . --copy examples/basic/node_modules/cesium-geospatial
```

## 仓库结构

```
package.json     # 根包 = 产品包 cesium-geospatial（dist / assets / bin / docs 对外分发）
src/             # 产品入口与编排（install / sceneTakeover / assets / compat / moonTexture）
bin/cli.mjs      # copy-assets / check（纯 Node，不依赖 dist）
assets/          # 唯一资产源：luts/（4 个 .bin）+ clouds/（4 个）+ moon/（2 个 webp）
packages/
  cesium-core    # @cesium-geospatial/core —— Bruneton 大气：LUT 加载、shader 组装、AtmosphereStage（B 路径大气透视 + 动态曝光 + LensFlare）
  cesium-clouds  # @cesium-geospatial/clouds —— 体积云：weather 纹理、raymarch pass、级联 BSM（世界锚定）、god rays、时序重建
apps/
  demo           # Vite + 原生 Cesium Viewer 验收 demo（URL 参数化，见上；经 viteStaticCopy 从 assets/ 服务）
examples/
  basic          # 最小接入示例（file: 依赖，与真实消费路径一致）
docs/
  integration.md # 消费方接入指南
  api.md         # API 参考
  superpowers/   # specs（设计文档）与 plans（实现计划 + 验收结果）
```

依赖说明：`cesium` 为 peerDependency（宿主/demo 自带），两个核心包只依赖 Cesium 官方发布版。
静态资源唯一源是包根 `assets/`：`luts/`（大气预计算查找表，half-float .bin）、`clouds/`
（3D 噪声 shape/detail、天气图、STBN）与 `moon/`（月面颜色/位移 webp）；消费方经
`node bin/cli.mjs copy-assets --out public/cesium-geospatial-assets` 拷到自己的站点目录。

## 设计文档

重要架构决策与实验数据都在 `docs/superpowers/` 下按日期归档，例如：

- `specs/2026-08-28-bsm-world-anchored-cascade-design.md` —— BSM 世界锚定级联设计（移动闪动消除）
- `plans/` 下同名 `-results.md` —— 各项端到端验收数据

## License

MIT
