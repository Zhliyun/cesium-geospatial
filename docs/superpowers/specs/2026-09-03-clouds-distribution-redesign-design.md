# 体积云分布重设计（时间切片 3D 云图）设计文档

- 日期：2026-09-03
- 状态：已与用户逐节确认（架构/烘焙内容/参数/兼容性验收四节），待终审
- 范围：packages/cesium-clouds（weather 生成与采样链）+ apps/demo（URL 参数）
- 非范围：云渲染光照模型、march 算法、大气散射、质量档位

## 1. 背景与根因

用户反馈「体积云的分布太过于规律」。排查结论（三因素叠加）：

1. **coverage 图是离线烘焙静态图**：`local_weather.png`（512²）由 `localWeather.frag` 固定参数 Worley FBM（low/mid）+ Perlin（high）生成，RGBA 4 通道对应 3 层云。均匀频率的 Worley 斑块大小形态雷同。
2. **全球平铺 ×100**：`localWeatherRepeat=(100,100)`，cube-sphere UV REPEAT 采样——同一图案全球重复约 100 遍（周期约 400 km），壁纸效应。
3. **零时间演化**：采样链无任何时间输入。上游「演化」hack（`evolution = -normal × length(localWeatherOffset) × 2e4`）默认 offset=(0,0)，恒静止。

现有可复用资产：`coverage` 参数（Skybolt 式调制，默认 0.3）、4 层云高结构（packed uniforms）、cube-sphere UV（位置维度天然确定性）、`CloudsStageOptions.parameters` 透传管线、BSM 的 render-to-Texture3D 基建（裸 GL FBO 逐层渲染）。

## 2. 需求（已澄清拍板）

| 需求 | 拍板结论 |
|------|---------|
| 去规律化 | 自然随机分布（多尺度域扭曲噪声打破平铺周期） |
| 物理真实感 | 加纬度气候带（ITCZ/副热带晴空带/中纬度风暴带/极地干燥） |
| 时间动态演化 | 演示级默认（几分钟肉眼可感知）+ 参数可调（真实尺度调慢） |
| 跨 viewer 一致 | **同机多 Viewer 视觉一致**（同时刻同位置相同云图；不要求跨设备逐位） |
| 云密度控制 | 全局标量（URL + 运行时 API） |
| 云高度控制 | 全局标量（低云带整体升降） |
| 快捷操作 | 天气预设档（晴/少云/多云/阴天一键切换） |
| 硬约束 | 帧率不回退（march 循环内不得新增显著成本）；现有验收基线不破坏 |

## 3. 方案选型

- **A（选定）：运行时 GPU 烘焙时间切片 3D 云图**——256²×64×RGBA 3D 纹理（z=时间切片，REPEAT 回绕），首帧一次性烘焙。march 内仍是单次 textureLod（2D→3D 多一维插值），演化/气候带/确定性全满足。16.8 MB VRAM。
- B（否决）：双 2D 纹理时间插值——演化是 A↔B 往复循环，生消可预测，效果打折；内存节省有限。
- C（否决）：march 内实时程序噪声——raymarch 最贵循环内塞几十倍 ALU，帧率风险不可接受。其噪声代码复用为 A 的烘焙 shader 内容。

## 4. 总体架构

```
WeatherAtlas（新模块，packages/cesium-clouds/src/WeatherAtlas.ts）
  ├─ weatherBake.frag.glsl（烘焙 shader，见 §5）
  ├─ 烘焙 pass（复用 BSM 裸 FBO + framebufferTextureLayer 逐层渲染模式）
  └─ Texture3D 256²×64 RGBA UNSIGNED_BYTE（z=时间切片，REPEAT wrap）
        └─> sampleWeather（clouds.glsl 改造：2D→3D 采样 + 气候带 + 平流）
```

**时间轴模型（确定性核心）**：

```
tSec   = JulianDate 场景绝对秒数（scene.time，非 per-viewer 帧计数）
tNorm  = (tSec mod evolutionPeriod) / evolutionPeriod    // ∈[0,1)，默认周期 5.3h
sliceZ = tNorm（3D 纹理 z 采样坐标，LINEAR 插值相邻切片）
windOffset = windVec × tSec（mod 纹理域）                 // 平流
```

两个 Viewer clock 同时刻 ⇒ 同 tNorm 同 windOffset ⇒ 同一纹理同采样 ⇒ 逐位一致。时间回退（tSec 变小）云图随之回退——纯函数，无累积状态。

**精度陷阱（实现铁律）**：JulianDate 绝对秒 ~1e9 量级，float32 尾数 24 位在该量级的分辨率约 64 秒——**tNorm 与 windOffset 必须由 CPU 侧（JS float64）完成 mod 后再传 uniform**（mod 后值域 [0, 周期秒]，float32 残余精度 <0.01s，足够）。GPU 侧不得对原始 tSec 做 mod。

**关键决策**：

1. 烘焙时机：`createCloudsStage` 创建时同步烘焙一次（64 层全屏 quad，GPU 几十 ms）；仅**烘焙输入**（演化周期/风速/种子）变化才重烘；**采样时调制**（coverage/密度/云高/气候带/预设档）走 uniform 热切。
2. RGBA 4 通道语义不变（low/mid/high/extra），`LOCAL_WEATHER_CHANNELS` 与 Skybolt 调制链保留。
3. fallback：烘焙异常（上下文丢失等）时降级加载静态 `local_weather.png`（`loadWeatherTextures` 保留该路径），行为退化为现状，不阻断。
4. 删除 `evolution` hack（`localWeatherOffset` 模长当风速）——被真风矢量平流取代；`localWeatherOffset` 保留为调试偏移。

## 5. 烘焙内容设计

分层原则：**烘焙图只负责随机 coverage 基底 + 时间演化（与地理无关）；气候带在采样侧与真实纬度相乘**（march 有真实 position；烘焙 2D uv 反解 cube-sphere 纬度不唯一，且采样侧调参免重烘）。

### 5.1 去壁纸化：域扭曲

采样 Worley 前扭曲坐标：`p' = p + warpAmp × vec2(FBM(p×f1), FBM(p×f2 + seedOffset))`。低频扭曲场把平铺图案揉乱至不可辨识（主力去壁纸手段）。warpAmp 默认 0.25（平铺周期的 25% 位移量，可调）。

### 5.2 时间演化：圆环漂移路径（无缝回绕）

第 i 切片的噪声域偏移沿圆环：

```
evolve(i) = evolveRadius × (cos(2πi/N), sin(2πi/N))    // N=64
```

z=63→0 回绕时路径恰好闭合 ⇒ 循环首尾连续无跳变。扭曲场角度随 i 旋转增强变形感。观感 = 云形缓慢生消变形（非整体平移；平移由平流承担）。

### 5.3 平流：风漂移（采样侧）

`uv × repeat + windOffset(tSec)`，`windVec` 默认 ~8 m/s（≈30 km/h）对角方向。演化（变形）+ 平流（位移）叠加 = 云的双重运动。平流是确定性纯函数。

### 5.4 纬度气候带包络（采样侧）

`latSin = normalize(position).z`（地心纬度正弦，直接作自变量，免 asin）：

```
band(latSin) = ITCZ峰 + 副热带谷 + 中纬峰 + 极地衰减
  ITCZ：中心 sin(lat)=0，半宽 ±10°，中心随季节漂移 ±8°（漂移相位=绝对时刻年周期函数，与演化同源确定性）
  副热带高压（谷）：|sin(lat)| ≈ 0.42-0.50（25-30°），压云量
  中纬度风暴带（峰）：|sin(lat)| ≈ 0.66-0.77（45-60°），抬云量
  极地：>72° 缓慢变干
总包络 clamp [0.2, 1.5]（晴空带减云但不至于全无云；风暴带增云但不全域阴）
```

实现为若干 smoothstep/cos 峰叠加，乘在 coverage 基底上：`density 调制链输入 ×= band(latSin) × u_climateBands`（`u_climateBands` 0=关 1=默认强度）。

### 5.5 默认速度标定（演示级，全部可调）

| 量 | 默认 | 语义 |
|----|------|------|
| 切片间隔 | 5 min | 相邻切片时间差（演化粒度） |
| 环周期 | 5.3 h（64×5min） | 云图完整循环周期 |
| 平流风速 | ~8 m/s | 云整体漂移速度 |

## 6. 参数与控制暴露

### 6.1 热切换组（uniform/state，创建后可变，不重烘）

| 参数 | URL | 默认 | 说明 |
|------|-----|------|------|
| 云密度 | `?cloudsCoverage=` | 0.3 | Skybolt 调制，0≈晴 1≈全域阴 |
| 云高度 | `?cloudsAltitudeOffset=` | 0 | 低云带（L0/L1）整体升降，米；0=现状零回归；clamp [-500,+3000] |
| 天气预设 | `?cloudsWeather=clear\|fair\|cloudy\|overcast` | — | 一键组合；显式标量优先于预设 |
| 气候带强度 | `?cloudsClimateBands=` | 1 | 0=关（纯随机分布） |

预设初值（验收时拍板微调）：clear=0.08 / fair=0.2 / cloudy=0.45 / overcast=0.65+coverageFilterWidths 收窄（连片）。

运行时 API：全部经 `options.parameters` 透传（现成管线）；预设热切 = state 闭包引用改值（nightAmbient 同款模式）。

### 6.2 烘焙输入组（创建时定死，v1 无运行时重烘 UI）

| 参数 | URL | 默认 |
|------|-----|------|
| 演化环周期 | `?cloudsEvolutionHours=` | 5.3 |
| 风速 | `?cloudsWind=` | 8（m/s，风向固定对角） |

### 6.3 云高度偏移的实现路径（风险项，必须进计划）

`minLayerHeights/maxLayerHeights/minIntervalHeights/maxIntervalHeights/shadowTopHeight/shadowBottomHeight` 目前是**写死值**（three 的 pack 派生函数未移植）。云高度偏移需移植 `packValues/packSums/packIntervalHeights`（three uniforms.ts:124-186 逻辑），输入=4 层参数（L0/L1 altitude 加偏移），输出=全部 packed 向量 + BSM 域（shadowTop/BottomHeight）重算。单测覆盖派生正确性。

## 7. 兼容性

1. **BSM 云影自动跟随**：`shadow.frag` 复用 `sampleWeather`，云影自动获得新云图/气候带/演化，云影一致；两套 shader 编译测试均须通过。
2. **temporal 兼容**：演化 = 5 min 级慢连续函数，TAA 友好；静止冻结只冻结 jitter 相位不冻结云演化（期望行为）。验收项：静止收敛检查。
3. **质量档正交**：烘焙纹理 16.8 MB 固定开销全档共用；render-to-3D 在 SwiftShader 可行性已由 BSM 证实。
4. **性能预算**：march 循环内新增 = 2D→3D textureLod（多一维插值）+ 气候带几个 smoothstep + 平流加法，预期 <5%。**门禁：既有帧率基线场景（M 系列锁帧三档 + ultra 两组）成对录制不回退。**
5. **cube-sphere face 接缝**：`getCubeSphereUv` 在 face 边界 uv 不连续，coverage 图案在边界断裂——**现状已存在**，本设计不改变采样域（仅换纹理维度），不恶化、不在本任务范围修复。

## 8. 测试与验收矩阵

| 层 | 验什么 | 方法 |
|----|--------|------|
| 单测 | 烘焙 shader 编译；packed 派生函数；预设档映射；气候带包络值域 | vitest（沿用 clouds 包测试模式） |
| 确定性 | 同机两 Viewer 同 URL 同时刻像素 diff ≈ 0 | agent-browser 双 tab 截图 diff（噪声基线=FPS 面板） |
| 去壁纸 | 全球远观视角：旧版重复图案可辨 vs 新版不可辨 | 同视角新旧对照截图 |
| 演化 | t₀ vs t₀+30min（?time 快进）云形明显变化；5.3h 回绕处无跳变 | 同视角时刻对照 |
| 气候带 | 赤道/副热带/中纬度云量带状对比；`?cloudsClimateBands=0` 消失 | 三视角对照 |
| 参数 | 每个新 URL 参数开/关对照 | off-vs-off 噪声基线法（既有方法论） |
| 帧率 | 既有基线场景不回退 | 成对录制对比 |

验收环境铁律（memory 沿革）：三层清 vite 缓存 + 等 tilesLoaded + 像素量化 + headless 不可信须 headed。

## 9. 非目标（YAGNI）

- 真实气象数据接入（卫星云图/NWP）
- 跨设备逐位一致（用户拍板同机视觉一致即可）
- 运行时重烘 UI（演化周期/风速 v1 URL 定死；`WeatherAtlas.rebake()` 留内部接口）
- per-layer 云高/密度控制（4 层结构保留但只暴露全局标量）
- 风向暴露（固定对角）、地形抬升/锋面对流等中尺度气象模型
