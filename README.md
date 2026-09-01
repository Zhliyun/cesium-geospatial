# cesium-geospatial

把 **three-geospatial**（Bruneton 大气参考实现）的 **物理大气** 与 **体积云** 渲染移植进 **Cesium**：以原生 `PostProcessStage` 后处理注入，不替换 Globe、不 fork Cesium，复用 Cesium 内置的 `czm_*` uniforms、对数深度与 `depthTexture`。

## 效果特性

- **物理大气**（Bruneton 模型，预计算 LUT）：天空散射、大气透视、昼夜/晨昏过渡、太空视角大气边缘辉光（limb glow）
- **方向性月光 + 物理月盘**：月光作为第四光照项进云照明（方向/强度随月相），月盘 Oren-Nayar + IAU 月固系月面纹理（月海/环形山与真实天文一致，潮汐锁定），月相从太阳-月几何自动涌现
- **动态曝光**：按相机当地太阳高度角自动切换昼/夜曝光，晨昏带平滑过渡
- **镜头光晕**（LensFlare）：太阳入镜时 ghost/halo/bloom，image-based，物理感光
- **体积云**（raymarch）：3D 噪声形状 + 天气图覆盖，级联 **BSM 自阴影**（世界锚定固定网格），云间 **god rays** 光柱
- **HDR 管线**：HalfFloat 中间缓冲 + ACES filmic tonemap + display dithering

## 快速开始

环境要求：Node ≥ 20，pnpm ≥ 10（仓库用 `packageManager: pnpm@10.32.1` 锁定）。

```bash
pnpm install

# 可选：配置 Cesium ion token（影像/地形底图用；不配则自动降级裸 globe，大气/云照常可看）
echo 'VITE_ION_TOKEN=你的token' > apps/demo/.env.local

pnpm dev          # 启动 demo（= pnpm --filter demo dev）
```

浏览器打开 <http://localhost:5173>。默认是 `mode=sky` 对照分支，**看完整效果用 `?mode=atmosphere&clouds=1`**（见下方推荐 URL）。

> 渲染异常排查提示：多次热更新后如出现画面异常（云位置偏移、颜色错乱等），先清 vite 缓存再判断——`pkill -f vite && rm -rf apps/demo/node_modules/.vite && pnpm dev`。

## 推荐体验 URL（直接复制）

基准视角：白天云海 + 体积云自阴影 + god rays（7852m 高空俯视云层）：

```
http://localhost:5173/?mode=atmosphere&clouds=1&time=2026-08-28T17:30:00Z&camera=-80.6057,64.5197,7852,68.8,-17.8
```

在此之上追加参数的常用场景：

| 场景 | URL |
|---|---|
| 低太阳角晨昏近景（暖色侧光、长影） | `?mode=atmosphere&clouds=1&time=2026-08-29T00:45:00Z&camera=-80.6057,64.5197,1400,68.8,-25` |
| 太空视角大气边缘辉光 | `?mode=atmosphere&clouds=1&time=2026-08-28T17:30:00Z&camera=93.9439,31.6997,61883,89.2,-19.0` |
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
| 娥眉月（f≈0.09） | 2026-10-15T12:00Z | `?mode=atmosphere&clouds=1&time=2026-10-15T12%3A00%3A00Z&camera=103.8929,16.5428,3106,229.5,15.9` |
| 上弦月（f≈0.31） | 2026-10-18T15:00Z | `?mode=atmosphere&clouds=1&time=2026-10-18T15%3A00%3A00Z&camera=103.8929,16.5428,3106,236.3,12.5` |
| 盈凸月（f≈0.73） | 2026-09-22T17:30Z | `?mode=atmosphere&clouds=1&time=2026-09-22T17%3A30%3A00Z&camera=103.8929,16.5428,3106,238.2,20.2` |
| 满月（f≈0.97） | 2026-09-25T12:00Z | `?mode=atmosphere&clouds=1&time=2026-09-25T12%3A00%3A00Z&camera=103.8929,16.5428,3106,103.4,21.2` |
| 亏凸月（f≈0.77） | 2026-11-27T15:00Z | `?mode=atmosphere&clouds=1&time=2026-11-27T15%3A00%3A00Z&camera=103.8929,16.5428,3106,68.8,14.7` |
| 下弦月（f≈0.37） | 2026-11-30T18:00Z | `?mode=atmosphere&clouds=1&time=2026-11-30T18%3A00%3A00Z&camera=103.8929,16.5428,3106,85.4,15.2` |
| 残月（f≈0.17） | 2026-12-02T20:00Z | `?mode=atmosphere&clouds=1&time=2026-12-02T20%3A00%3A00Z&camera=103.8929,16.5428,3106,101.0,18.4` |

> 娥眉月照明面积小（~6%），天际线构图下画面接近全黑是**物理正确**（亚像素宽的月牙暮光）；想看明显的月牙可把 pitch 再抬高或换 `time` 到月更高时。月相由 `time` 决定的太阳-月几何自动涌现，改任意时间都能得到正确相位；表中 URL 是逐相实测过月亮/云/天际线同框的取点。

## URL 参数说明

### 基础

| 参数 | 说明 |
|---|---|
| `mode` | `atmosphere`（完整大气+云主分支）/ `sky`（Phase 0 天空对照）/ `depth`（深度调试）。默认 `sky` |
| `clouds=1` | 开启体积云（仅 atmosphere 模式生效） |
| `time` | ISO8601 时间，决定太阳方向（昼夜、太阳高度角）。例：`2026-08-28T17:30:00Z` |
| `camera` | 初始视角 `lon,lat,height,heading,pitch`（角度制；heading/pitch 可省略，默认 0/-90） |
| `ionToken` | URL 传 Cesium ion token（优先级低于 `.env.local` 的 `VITE_ION_TOKEN`） |
| `fps=0` | 关闭左下角帧率显示（默认开） |

### 大气调节

| 参数 | 默认 | 说明 |
|---|---|---|
| `exposureDay` / `exposureNight` | 1.2 / 0.1 | 昼/夜曝光（按太阳高度角自动插值） |
| `groundDim` | 0.43 | 地表反射衰减（压地面过曝；1=不衰减；0.5→0.43 与地面光色乘子联算重标——正午乘子≈1.0-1.15 压回同量级） |
| `groundLighting` | 1 | 地面光色乘子（2026-09-01 影像×大气颜色同步）：影像=正午白光快照，乘子=(太阳直射透射+天光辐照)/solar_irradiance 让影像随太阳高度染色——日落近景橙红、夜间近黑（三专家评审定稿变体 1；0=旧合成 A/B 对照兼 CI 逃生门）。开启时自动配 lighting=0（enableLighting 夜侧 N·L 置黑像素与乘法地板冲突，?lighting=1 显式保留旧组合） |
| `groundNightAmbient` | 0.55,0.62,0.78 | 地面夜间环境底色 r,g,b（sun/sky 双归零后乘子→0，max() 地板接住；冷蓝默认，按曝光链 0.1 预放大；量级显暗属预期——夜间 exposure 压回） |
| `inscatterScale` | 25 | 内散射放大（1=回退物理量级，偏淡） |
| `distanceScale` | 1 | 散射距离缩放（等效空气密度倍率） |
| `ditherScale` | 1 | dithering 强度倍率（放大打散 banding） |
| `limbGlow` / `limbDecay` | 0.3 / 30 | 太空视角大气边缘辉光强度 / 扩散范围 km |
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
| `cloudsQuality` | `high` | 质量档位 `low`/`medium`/`high`/`ultra`：march 步数/编译开关（光柱/细节/湍流/精确天光）/BSM 级联数与尺寸整档联动；键盘 `1`-`4` 运行时切换 |
| `cloudsExposure` | 12 | 云层曝光（线性域缩放，链尾统一 tonemap；偏灰调大、过曝调小） |
| `cloudsNightAmbient` | 0.12 | 夜间环境底光：太阳沉没后云照明地板（0 = 关闭回退纯黑夜间云）。夜间云无月光/气辉模型，LUT 归零后厚云成黑洞——此值标定到与夜空底光同量级 |
| `cloudsTint` | 0.88,1,1 | 夜间云色调乘子（线性 RGB，乘底光+月光；沿革冷蓝 1.32→弱蓝 1.15→中性偏暖定稿） |
| `cloudsTwilightBoost` | 6 | 暮光天光补偿倍率：太阳 [+2°,-1.5°] 窗内云天光项 1→boost（黄昏云过黑修复——crude 天光+overlay 不乘动态曝光欠亮 ~3×；实测云/天空显示比 32%→80%；1=关；白天零回归） |
| `cloudsShadow=0` | 开 | 关 BSM 自阴影（对比云体积感） |
| `cloudsShadowAnchor=frustum` | world | 回退视锥锚定 BSM（AB 对照基线；默认 world 世界锚定固定网格，抗移动闪动） |
| `cloudsShadowScale=N` | 1 | world 锚定 radii × N（诊断用，N=5 → {80,168,480}km 膨胀层） |
| `cloudsShadowFreeze=1` | – | 冻结 BSM 矩阵（首帧后不更新，噪声分解诊断） |
| `cloudsShadowTemporal=1` | 关 | BSM 时序累积 |
| `cloudsTemporal=1` | 关 | 云 march 时序 1/4 分辨率重建（帧率↑，有抖动） |
| `cloudsLightShafts=0` | 开 | 关云间 god rays 光柱 |
| `cloudsGodRays=N` | 1 | god rays 增益（20=艺术放大出明显光柱） |
| `cloudsShapeDetail=0` / `cloudsTurbulence=0` / `cloudsAccurate=0` | – | 关对应噪声/光照分支（隔离诊断） |

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
云销毁调 `cloudsHandle.destroy()` 即可（链自动闭合）。

### 诊断

| 参数 | 说明 |
|---|---|
| `debug=N` | 大气调试视图：1=finalColor 量级 / 2=太阳方向 / 3=相机距离量级 / 5=depth / 6=透传输入色 |
| `cloudsDebug=N` | 云调试视图：1=天气图 UV / 2=云前深度 / 3=march 采样数 / 4=BSM 阴影图 / 5=级联层 |
| `tileCache=N` | 瓦片缓存（默认 5000，减少回收引起的深度时序抖动） |
| `sse=N` | 屏幕空间误差阈值（调高→瓦片更晚细化，减 LOD 抖动；地形更粗） |
| `profile=1` | 逐 stage GPU 计时（每 60 帧 console.log，需 EXT_disjoint_timer_query_webgl2） |
| `temporalEma=0` / `temporalQuality=high` / `depthThreshold=N` / `depthTemporal=1` | 深度时域平滑开关/档位/阈值/显式创建 |

### 移动探针（验收云影闪动用，30 帧后自动启动）

| 参数 | 说明 |
|---|---|
| `cloudsProbeMove=N` | 每帧前进 N 米（匀速平移） |
| `cloudsProbeOrbit=N` | 每帧左转 N 弧度（轨道，N=0.00001 为慢速） |
| `cloudsProbeZoom=N` | 每帧 zoomIn N 米（dolly，滚轮语义） |

## 常用命令

```bash
pnpm dev                 # 启动 demo
pnpm test                # 全部 workspace 测试
pnpm build               # 构建全部包

# 单包测试 / 单文件 / 按用例名过滤
pnpm --filter @cesium-geospatial/core test
pnpm --filter @cesium-geospatial/clouds test
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts
pnpm --filter @cesium-geospatial/core exec vitest run -t "动态曝光"

# 类型检查（仓库无统一脚本，显式跑 tsc）
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
```

## 仓库结构

```
packages/
  cesium-core    # @cesium-geospatial/core —— Bruneton 大气：LUT 加载、shader 组装、AtmosphereStage（B 路径大气透视 + 动态曝光 + LensFlare）
  cesium-clouds  # @cesium-geospatial/clouds —— 体积云：weather 纹理、raymarch pass、级联 BSM（世界锚定）、god rays、时序重建
apps/
  demo           # Vite + 原生 Cesium Viewer 验收 demo（URL 参数化，见上）
docs/
  superpowers/   # specs（设计文档）与 plans（实现计划 + 验收结果）
```

依赖说明：`cesium` 为 peerDependency（demo 自带），两个核心包只依赖 Cesium 官方发布版。静态资源在 `apps/demo/public/`：`luts/`（大气预计算查找表，half-float .bin）与 `clouds/`（3D 噪声 shape/detail、天气图、STBN）。

## 设计文档

重要架构决策与实验数据都在 `docs/superpowers/` 下按日期归档，例如：

- `specs/2026-08-28-bsm-world-anchored-cascade-design.md` —— BSM 世界锚定级联设计（移动闪动消除）
- `plans/` 下同名 `-results.md` —— 各项端到端验收数据

## License

MIT
