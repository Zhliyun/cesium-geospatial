# 体积云分布重设计（时间切片 3D 云图）设计文档

- 日期：2026-09-03（r2：经四专家评审修订——GPU 性能/程序化噪声/气象物理/对抗红队；r1 四节逐项用户确认）
- 状态：待用户终审
- 范围：packages/cesium-clouds（weather 生成与采样链）+ apps/demo（URL 参数/时钟）
- 非范围：云渲染光照模型、march 算法、大气散射、质量档位

## 0. 评审记录（r2 修订依据）

四专家并行评审 r1，判定：GPU 性能=有条件通过（1 BLOCKER）、程序化噪声=有条件通过（1 BLOCKER）、气象物理=有条件通过（0 BLOCKER）、对抗红队=被击穿（3 BLOCKER）。全部 BLOCKER/MAJOR 已采纳修订，无驳回冲突。关键修订：

1. **3D mipmap 机制**（三方独立命中）：r1 缺失。Cesium `Texture3D` 带 `source` 构造走 `texStorage3D` 且 `levels=1`（immutable），之后 `generateMipmap()` 报 `GL_INVALID_OPERATION` → §4.3 创建机制条款。
2. **演化机制重写**：r1 圆环路径在一种复合顺序下退化为纯平移（零形变）；改用噪声时间维扫掠为主方案 → §5.2。
3. **demo 时钟冻结**：main.ts 无 `shouldAnimate`，默认态演化不可见且原验收测不出 → §6.1 时钟开关 + §8 验收行。
4. **种子未定义**：确定性链断在「同一纹理」环 → §4.5 种子条款。
5. **fallback 类型不匹配**：2D PNG 无法绑 sampler3D → §4.4 包装为 3D 纹理。
6. **根因清单补第四根因**：Worley 特征点标量 hash 钉在 cell 对角线 → §1。
7. **周期化铁律**：烘焙域内一切噪声必须以烘焙域为周期 → §5.1。
8. ITCZ 中心/相位锚点修正、风暴带 sin 值笔误、band 上界 1.3、minHeight/maxHeight 重算漏项、逃生门 `?cloudsAtlas=0`、演化验收解耦钩子、性能口径修正——分别落入 §5.4/§6.3/§6.1/§8/§7。

## 1. 背景与根因

用户反馈「体积云的分布太过于规律」。排查结论（**四**因素叠加，r2 补第四根因）：

1. **coverage 图是离线烘焙静态图**：`local_weather.png`（512²）由 `localWeather.frag` 固定参数 Worley FBM（low/mid）+ Perlin（high）生成。均匀频率的 Worley 斑块大小形态雷同。
2. **全球平铺 ×100**：`localWeatherRepeat=(100,100)`，cube-sphere UV REPEAT 采样（per-face uv，每 face 赤道向约 10000 km，瓦物理周期约 **100 km**）。瓦与瓦图案完全相同——壁纸效应。
3. **零时间演化**：采样链无任何时间输入。上游「演化」hack（`clouds.glsl:131` `evolution = -normal × length(localWeatherOffset) × 2e4`）默认 offset=(0,0)，恒静止。
4. **Worley 特征点各向异性**（r2 新增）：`tileableNoise.glsl:56` `tp = cell - tp - noise(mod(tp, cellCount))`——`noise` 返回 float，vec3 减 float 按分量广播，每个 cell 的唯一特征点被钉在 (t,t,t) 对角线上，2D 斑块排布与格网强相关。这是与平铺无关的源内规律性。

现有可复用资产：`coverage` 参数（Skybolt 式调制，默认 0.3）、4 层云高结构（packed uniforms）、cube-sphere UV（位置维度天然确定性）、`CloudsStageOptions.parameters` 透传管线、BSM 的裸 FBO + `framebufferTextureLayer` 逐层渲染模式（含状态机防御，`ShadowPass.ts:237-356`）。

## 2. 需求（已澄清拍板）

| 需求 | 拍板结论 |
|------|---------|
| 去规律化 | 自然随机分布（多尺度噪声打破瓦内机械感 + 跨瓦重复的掩蔽与参数化，见 §5.1 能力边界） |
| 物理真实感 | 加纬度气候带（ITCZ/副热带晴空带/中纬度风暴带/极地干燥） |
| 时间动态演化 | 演示级默认（几分钟肉眼可感知）+ 参数可调；**demo 默认时钟冻结属 Cesium 现状语义，演化演示经 `?play=` 开关**（§6.1） |
| 跨 viewer 一致 | **同机多 Viewer 视觉一致**（同时刻同位置相同云图；不要求跨设备逐位） |
| 云密度控制 | 全局标量（URL + 运行时 API） |
| 云高度控制 | 全局标量（低云带整体升降） |
| 快捷操作 | 天气预设档（晴/少云/多云/阴天一键切换） |
| 硬约束 | 帧率不回退（门禁为准，§7.4）；逃生门铁律（§6.1 `?cloudsAtlas=0`）；现有验收基线不破坏 |

## 3. 方案选型

- **A（选定）：运行时 GPU 烘焙时间切片 3D 云图**——256²×64×RGBA8 3D 纹理（z=时间切片，REPEAT 回绕），首帧一次性烘焙 + 3D mip 链。march 内仍是单次 textureLod（2D→3D，fetch texel 数 8→16 翻倍，实测以门禁为准 §7.4）。VRAM 16.8 + mip 33% ≈ **22.4 MB**。
- B（否决）：双 2D 纹理时间插值——演化是 A↔B 往复循环，生消可预测；内存节省有限。
- C（否决）：march 内实时程序噪声——raymarch 最贵循环内塞几十倍 ALU，帧率风险不可接受。其噪声代码复用为 A 的烘焙 shader 内容。

## 4. 总体架构

```
WeatherAtlas（新模块，packages/cesium-clouds/src/WeatherAtlas.ts）
  ├─ weatherBake.frag.glsl（烘焙 shader，见 §5）
  ├─ 烘焙 pass（复用 BSM 裸 FBO + framebufferTextureLayer 逐层渲染模式与状态机防御）
  └─ Texture3D 256²×64 RGBA UNSIGNED_BYTE + 3D mip 链（z=时间切片，REPEAT wrap）
        └─> sampleWeather（clouds.glsl 改造：2D→3D 采样 + 气候带 + 平流）
```

### 4.1 时间轴模型（确定性核心）

```
tSec   = JulianDate 场景绝对秒数（scene.time，非 per-viewer 帧计数）
tNorm  = (tSec mod evolutionPeriod) / evolutionPeriod    // ∈[0,1)，默认周期 5.3h
sliceZ = tNorm（3D 纹理 z 采样坐标，LINEAR 插值相邻切片）
windOffset = windVec × tSec（mod 1，tile 单位）           // 平流，加在 uv×repeat 之后
```

两个 Viewer clock 同时刻 ⇒ 同 tNorm 同 windOffset ⇒ 同一纹理同采样 ⇒ 逐位一致。时间回退云图随之回退——纯函数，无累积状态。

**精度陷阱（实现铁律）**：JulianDate 绝对秒 ~8.4e8 量级（float32 ULP=64s）——**tNorm 与 windOffset 必须由 CPU 侧（JS float64）完成 mod 后再传 uniform**（mod 后值域有限，float32 残余精度 <0.01s）。GPU 侧不得对原始 tSec 做 mod。

### 4.2 烘焙时机

`createCloudsStage` 创建时同步烘焙一次（64 层全屏 quad，Apple Silicon ~15-40ms，Intel 低端 iGPU 可能 40-100ms+，SwiftShader 秒级——§8 冒烟项与 CI 不断言首帧时长）；仅**烘焙输入**（演化周期/风速/种子/瓦频率参数）变化才重烘；**采样时调制**（coverage/密度/云高/气候带/预设档）走 uniform 热切。运行期 context lost 经 Cesium 恢复机制触发 `WeatherAtlas.rebake()`（接口预留）。

### 4.3 Texture3D 创建机制（r2 新增，BLOCKER 修订）

**禁止带 `source` 构造**（`texStorage3D` immutable 且 `levels=1`，后续 `generateMipmap()` 报错）。正确路径：

1. 无 `source` 构造 Texture3D（可变存储，走 `texImage3D` 路径）；
2. 裸 FBO + `framebufferTextureLayer` 逐层烘焙 64 切片（照抄 ShadowPass 的状态机防御与反馈环规避）；
3. 烘焙完成后调 `generateMipmap()`（Cesium Texture3D 有该方法，裸 `gl.generateMipmap(TEXTURE_3D)`），以 `gl.getError()` + `checkFramebufferStatus` 验证（`ShadowPass.ts:348` 先例）；
4. sampler 分两步：烘焙期间 LINEAR，mip 验证通过后切 `LINEAR_MIPMAP_LINEAR`。

**mip 降级链**：`generateMipmap` 报错 → minFilter 降 LINEAR（textureLod 自动 clamp 到 lod 0，远观天气遮罩略糊/闪但可用，console.warn）→ 整体烘焙失败 → PNG fallback（§4.4）。SwiftShader/浏览器后端对 TEXTURE_3D generateMipmap 的实际支持需冒烟验证（§8；BSM 从未生成过 mip，不能作为证据）。

### 4.4 fallback 与逃生门（r2 修订，BLOCKER 修订）

- **PNG fallback 路径**：烘焙异常时，`local_weather.png` decode 后**上传为 256²×64 每层同图的 Texture3D**（2D 纹理无法绑 sampler3D——类型不匹配）。行为：有平流（采样侧 uniform 不依赖烘焙）、无时间演化演化（各层同图）、有气候带。不阻断。
- **逃生门 `?cloudsAtlas=0`**：走上述同一条 PNG-3D 包装路径 = 旧静态云图行为。同时是 §8 新旧对照验收的基建（同 URL 成对录制）。
- 运行期 context lost：Cesium 恢复机制回调中 `rebake()`，非 PNG fallback（fallback 仅创建时同步路径）。

### 4.5 种子与确定性（r2 新增，BLOCKER 修订）

- 烘焙种子为**硬编码常量**（`WEATHER_BAKE_SEED`），保证两个 Viewer 各自烘焙结果逐位相同（同机同 GPU 同 shader）。`?cloudsSeed=` 暴露便于 A/B 对照（改变即重烘）。
- 单测断言：同输入参数两次烘焙的输出 buffer 哈希一致。
- 路径完整性：clock 同刻 ⇒ 同 tNorm ⇒ 同一种子烘焙的同一纹理 ⇒ 同采样 ⇒ 逐位一致。`?cloudsAtlas=0` 路径下无烘焙、天然一致。

### 4.6 其余决策

1. RGBA 4 通道语义保持 low/mid/high；**第 4 通道（a）现状为死值**（`localWeather.frag:82` 无条件 `=1.0`）——新烘焙保持 a=1 不激活，避免计划外观感变化。
2. 4 通道时间演化策略放**烘焙侧**（各通道错相/错速：高卷云快、低云慢，物理合理；采样端单次 rgba fetch 不变——采样侧按通道分风需 4 次 fetch，违反硬约束，明确排除）。
3. 删除 `evolution` hack（`localWeatherOffset` 模长当风速）；`localWeatherOffset` 保留为调试偏移。
4. `sampleWeather` 签名增加 `position` 参数（纬度气候带用）——三个调用点（clouds.frag 主 march/次 raymarch、shadow.frag BSM）position 均在作用域内，机械改动；BSM 云影自动获得气候带（`shadow.frag` position 与主 march 同为密切球系世界坐标，已验证）。

## 5. 烘焙内容设计

分层原则：**烘焙图只负责随机 coverage 基底 + 时间演化（与地理无关）；气候带在采样侧与真实纬度相乘**（march 有真实 position；烘焙 2D uv 反解 cube-sphere 纬度不唯一，且采样侧调参免重烘）。

### 5.1 噪声基底与去壁纸（r2 修订）

**周期化铁律**：烘焙域内一切噪声（基底 FBM、warp 场、演化偏移后的场）必须以烘焙域为周期——只允许 `tileableNoise.glsl` 周期 Worley（整频）与 `perlin.glsl` periodic 版（`perlin(position, rep)`）；warp 频率 f1/f2 必须整数（建议 f1=3、f2=5 互质起步）。非周期噪声 = 全球 ~100km 间距接缝网格，比壁纸更糟。瓦边界连续性单测（§8）兜底。

**第四根因修正**：Worley 特征点 hash 改 vec3（三路相位错开标量噪声合成，`turbulence.frag:19-24` 手法），打散对角线偏置——仅烘焙侧成本。

**域扭曲（定位：瓦内去机械化）**：`p' = p + warpAmp × vec2(FBM_per(p×f1), FBM_per(p×f2 + seed))`，warp 作用于未平移的 p。**能力边界（如实声明）**：静态 warp 烘焙进瓦内即与瓦同周期，跨瓦 motif 重复（repeat=100）不能被 warp 消除——掩蔽依赖①时间演化（切片间内容去相关）②气候带（南北向去相关）③瓦内机械感消除。`repeat` 参数化 `?cloudsWeatherRepeat=`（默认 100 不动；降 repeat 需同步提瓦内频率，分辨率/频率三角：repeat=10 需 512² 瓦 ≈67MB+mip——留作验收翻车后的升级路径，纹理尺寸/repeat 均已参数化）。§8 加同屏多瓦重复观感检查。

warpAmp 按低云基频 cell 数标定（FBM 实际输出 ±0.5-0.7，有效位移≈amp×0.6 tile），默认令低频通道位移 ~2-4 cell；各通道按各自基频归一（防高频通道被扭碎）。

### 5.2 时间演化：噪声时间维扫掠（r2 重写，BLOCKER 修订）

**主方案：平面沿噪声的时间维扫掠**。现有噪声原生支持但被闲置：Worley 是 3D 周期噪声而烘焙把 z 钉死 0（`localWeather.frag:30`）；perlin 是 4D 周期而 w 恒 0（`perlin.glsl:74`）。切片 i 采样：

```
Worley 通道：point = vec3(uv, zPhase_i)     // zPhase = i/N × 闭合行程
Perlin warp/extra：w = wPhase_i
```

平面扫过 3D 特征点云 ⇒ **云单体原地长大/缩小/消亡**（真生消，形变带空间相位差，不同云不同步），零额外 ALU。相邻切片 LINEAR 插值 = cross-fade（非形变）——zPhase 步长足够小（相邻切片位移 ≪ 云特征尺寸）时无鬼影；evolveRadius（等效每环噪声域行程）默认 0.25 tile、上限以「相邻切片域位移 ≪ 特征尺寸」为准。

**xy 圆环漂移为辅（可选低频分量）**：`evolve(i) = R×(cos 2πi/N, sin 2πi/N)`（R 默认 0.25 tile，环程 ~157km/5.3h ≈ 8 m/s 与平流同量级）。**复合顺序钉死：warp 作用于未平移的 p，演化偏移加在 warp 之后**（`F(p + w(p) + evolve_i)`——若反向复合则为纯刚体平移零形变，禁止）。

**演化闭合铁律**：任何随 i 前进的噪声输入，全环总行程必须是其（各 octave 放大后的）周期的整数倍。perlin w 维无频率放大，Δw=1/N 即闭合；Worley z 维 FBM 每 octave 频率×2，须 Δz 使全部 octave 行程为整数（量化：baseFreq=16、N=64 时须 Δz=1/16 即整环 4 个 z 周期；N 取 baseFreq 倍数亦可）。四通道各自的 baseFreq/Δz/Δw 值表在实现计划中定死并配单测。单测断言：相邻切片差分去平移后残差非平凡（互相关检验，防纯平移退化）。

**「循环+平流非公倍」设计余量**：可见图案重复周期 > 环周期本身（平流 153km/循环 ≠ 整周期），连看 6 小时不觉循环。

### 5.3 平流：风漂移（采样侧）

`uv × repeat + windOffset(tSec)`，`windOffset` 为 **tile 单位 mod 1**、加在 `uv×repeat` 之后（与 repeat 语义解耦）。`windVec` 默认 ~8 m/s 对角（量级=信风/中纬地面风，~690km/天与真实天气系统位移一致；单矢量方向结构不物理——低纬东风/中纬西风——升级路径「zonal 分量 × sign(latSin)」一行改动，记 §9 例外）。

### 5.4 纬度气候带包络（采样侧，r2 修订）

`latSin = normalize(position).z`（ECEF z=极轴已验证；position 在密切球平移系，纬度系统偏差 ≤0.4°，对半宽 10°+ 云带不可见）。以 latSin 自变量设计（免 asin）：

```
band(latSin, tSec) = ITCZ峰 + 副热带谷 + 中纬峰 + 极地衰减，总 clamp [0.2, 1.3]
  ITCZ：中心 latC = 5° + 7.5°·cos(2π(doy−215)/365.25)   // 年均 ~5°N（海陆不对称北偏），
        // 8 月上旬最北 ≈12.5°N、2 月 ≈−2.5°S（不对称漂移：北移 ~12°、南移 ~3°）
        // 相位锚点：doy=227 → latC≈max、doy=47 → latC≈min（单测断言）
        // 半宽 ±10°（sin 值 0.174）
  副热带高压（谷）：|latSin| ≈ 0.42-0.50（25-30°）
  中纬度风暴带（峰）：|latSin| ≈ 0.707-0.866（45-60°）    // r2 修正 r1 笔误 0.66-0.77
  极地：>72° 缓慢变干（南北不对称可选：南极 ×1.5、北极 ×0.7——北极夏季洋面层云 60-80%）
```

年相位 doy 取 `mod(tSec, 365.25×86400)`，与演化同源 scene.time（确定性一致；闰秒 37s 量级可忽略）。上界 1.3 起步（r1 的 1.5 经 coverageFilterWidths 调制链会大面积饱和成「实心白环」，真实纬向峰谷比仅 ~2×）——§8 加「风暴带非云像素占比读数」检查。**气候带 × 预设组合语义**：预设激活时 band 下限 clamp ≥0.6（防止「阴天」预设 × 副热带 0.2 → 近晴空的直觉冲突；验收时拍板）。全部走 `u_climateBands` 开关（0=关）。

### 5.5 默认速度标定（演示级，全部可调）

| 量 | 默认 | 语义 |
|----|------|------|
| 切片间隔 | 5 min（64 切片/5.3h 环） | 演化粒度 |
| evolveRadius | 0.25 tile | 生消变形强度（环程≈157km/环） |
| 平流风速 | 8 m/s 对角 | 整体漂移 |
| 瓦内基频 | low/mid freq 16 / high perlin 6-12 | cell 尺寸 ~6km（repeat=100 下） |

## 6. 参数与控制暴露

### 6.1 热切换组（uniform/state，创建后可变，不重烘）

| 参数 | URL | 默认 | 说明 |
|------|-----|------|------|
| 云密度 | `?cloudsCoverage=` | 0.3 | Skybolt 调制，0≈晴 1≈全域阴 |
| 云高度 | `?cloudsAltitudeOffset=` | 0 | 低云带（L0/L1）整体升降，米；clamp [-500,+3000] |
| 天气预设 | `?cloudsWeather=clear\|fair\|cloudy\|overcast` | — | 一键组合；显式标量优先（demo spread 顺序现成支持）；激活时 band 下限 clamp ≥0.6 |
| 气候带强度 | `?cloudsClimateBands=` | 1 | 0=关（纯随机分布） |
| **demo 时钟** | `?play=1&speed=N` | 关 | `clock.shouldAnimate=true` + multiplier=N（默认 60）。默认态时钟冻结 = Cesium 现状语义（太阳也不动），演化演示与「太阳走云也走」体验经此开关；确定性验收用 `?time=` 钉死不受影响 |

预设初值（验收时拍板微调）：clear=0.08 / fair=0.2 / cloudy=0.45 / overcast=0.65+coverageFilterWidths 收窄（连片）。

运行时 API：`options.parameters` 透传（现成管线）；预设热切 = state 闭包引用改值（nightAmbient 同款模式）。

### 6.2 烘焙输入组（创建时定死，v1 无运行时重烘 UI；变更即重建 stage）

| 参数 | URL | 默认 |
|------|-----|------|
| 演化环周期 | `?cloudsEvolutionHours=` | 5.3 |
| 风速 | `?cloudsWind=` | 8（m/s，风向固定对角） |
| 种子 | `?cloudsSeed=` | WEATHER_BAKE_SEED 常量 |
| 瓦平铺 | `?cloudsWeatherRepeat=` | 100 |
| 演化解耦钩子（调试） | `?cloudsEvolutionPhase=` | 0 | 仅偏移演化/平流的时间输入、不动太阳——演化验收归因用（§8） |

### 6.3 云高度偏移的实现路径（风险项，r2 补漏）

需移植 `packValues/packSums/packIntervalHeights`（three uniforms.ts:124-186 逻辑），输入=4 层参数（L0/L1 altitude 加偏移），输出重算——**完整清单（r2 补 minHeight/maxHeight 两个标量）**：

- packed 向量：`minLayerHeights / maxLayerHeights / minIntervalHeights / maxIntervalHeights`
- 标量：`minHeight = min(altitude)`、`maxHeight = max(altitude+height)`——**march 入射壳直接消费**（`clouds.frag:835` `raySphereFirstIntersection(bottomRadius + vec4(0, minHeight, maxHeight, shadowTopHeight))`、`:479` 层内 alpha、`:844-894` 相机分支——漏算则负偏移时低云下半截永不被 march）
- BSM 域：`shadowTopHeight / shadowBottomHeight`（`shadowLayerMask` 只记层成员，无需重算）

派生函数纯函数化 + 单测覆盖全部输出项。

## 7. 兼容性

1. **BSM 云影自动跟随**：`sampleWeather` 加 position 参数后 shadow.frag 同链生效（已验证 position 同系）；**`?cloudsShadowTemporal=1` 时注意**——BSM resolve temporalAlpha=0.01（滞后 ~100 帧 ≈1.7s），云影以 8 m/s 拖尾 ~13m，默认关闭无碍，开启时 α 需与演化速率联动（验收检查项）。
2. **temporal 兼容（定量）**：tNorm 每帧增量 ~8.7e-7、平流每帧 ~3.3e-7 uv——远低于可见阈值，resolve mix(clip(history), current, 0.1) 滞后 ~10 帧无 ghosting；静止冻结只冻 frame 相位（jitter），march 每帧照跑演化内容正常流入。
3. **质量档正交**：烘焙纹理 22.4MB（含 mip）固定开销全档共用；render-to-3D 已由 BSM 证实，**3D generateMipmap 需冒烟验证**（BSM 无 mip 先例，不能作证据，§8）。
4. **性能口径（r2 修正）**：weather fetch 2D→3D 为 **8→16 texel/fetch 翻倍**（原「<5%」无依据），且主 march（≤500 步）+ 次 raymarch（每受照样本 2+2+3 步）+ BSM 生成端（512²×3 级联×50 步，运动帧全量）三处都吃。**「未实测，以门禁为准」**——门禁场景必须含：运动中（激活 BSM re-march）、low/ultra 两端档、Apple M 集成显卡（带宽敏感 UMA）；ultra 结果单独如实记录（memory 先例：曾独跌两组）。
5. **mipLevel 重标定**：纹理 512²→256² 后同 mipLevel 清晰度/混叠整体偏移一档——`getMipLevel`/`mipLevelScale`/BSM 固定 mip 表（`shadow.frag:183` {0,0.5,1,2}）迁移后复核，§8 验收项。
6. **cube-sphere face 接缝**：现状已存在，本设计不改变采样域，不恶化、不在范围修复。

## 8. 测试与验收矩阵（r2 扩充）

| 层 | 验什么 | 方法 |
|----|--------|------|
| 单测 | 烘焙 shader 编译；packed 派生（含 minHeight/maxHeight）；预设档映射；气候带包络值域+ITCZ 相位锚点（doy=227 max / doy=47 min） | vitest |
| 烘焙确定性 | 同输入两次烘焙输出 buffer 哈希一致 | node/头less GL |
| 烘焙正确性 | 瓦边界连续性（读回首尾行/列像素 diff≈0）；相邻切片差分去平移残差非平凡（互相关，防纯平移退化）；mip 生成 getError()==NO_ERROR | 读回断言 |
| SwiftShader 冒烟 | 烘焙路径 GL 无错（不验画面——headless 云画面不可信） | headless 跑一次 |
| 确定性 | 同机两 Viewer 同 URL（**必须钉死 ?time=**）同时刻像素 diff≈0；静置等静止冻结 + FPS 面板区域 mask | agent-browser 双 tab |
| 默认态演化 | `?play=1` 静置 5 分钟云形可见变化（**无 ?time**，覆盖 r1 验收盲区） | 同视角间隔截图 |
| 演化归因 | `?cloudsEvolutionPhase=` 解耦钩子（仅偏移演化/平流输入不动太阳）下 t₀ vs t₀+30min 对照；5.3h 回绕处无跳变 | 同视角对照 |
| 去壁纸 | 全球远观：旧版（?cloudsAtlas=0）vs 新版同视角对照；瓦内斑点各向同性（第四根因修正）；同屏多瓦重复观感检查 | 同 URL 成对录制 |
| 气候带 | 赤道/副热带/中纬度云量带状对比；`?cloudsClimateBands=0` 消失；**风暴带非云像素占比读数**（防实心白环）；7 月 vs 2 月 ITCZ 位移 | 多视角对照 |
| 参数 | 每个新 URL 参数开/关对照（off-vs-off 噪声基线法）；overcast×副热带组合（band clamp） | 既有方法论 |
| 帧率 | 既有基线场景 + **运动中**（BSM re-march）+ low/ultra 端档 + M 集成；ultra 单独记录 | 成对录制 |
| 环境铁律 | 三层清 vite 缓存 + 等 tilesLoaded + 像素量化 + headed（headless 不可信） | memory 沿革 |

## 9. 非目标（YAGNI）与已知取舍

- 真实气象数据接入（卫星云图/NWP）
- 跨设备逐位一致（同机视觉一致即可）
- 运行时重烘 UI（演化周期/风速/种子 v1 URL 定死；`WeatherAtlas.rebake()` 留内部接口供 context lost）
- per-layer 云高/密度控制（4 层结构保留但只暴露全局标量）
- 风向暴露（固定对角）——**例外升级路径**：zonal 分量 × sign(latSin) 一行改动，物理化留待需求出现
- **跨瓦壁纸的根治**（降 repeat+提频率+512² 瓦 ≈67MB+mip）：`?cloudsWeatherRepeat=` 参数化已备好，验收观感翻车时作为升级路径，v1 不默认启用
- **经度调制瓣**（副热带层积云甲板：秘鲁/本格拉/加州外海 ×1.5，撒哈拉干瓣 ×0.3，海洋大陆湿瓣 ×1.4——每瓣 ~4 smoothstep，预算内）：v1 不做，**已知穿帮点如实记录**（纯纬度带会把真实地球最醒目的 Sc 甲板压成晴空）；若验收被指出再启用（Phase 2，采样侧纯 uniform 逻辑）
- ITCZ 之外的气象模型（气旋/锋面/地形抬升/季风）
- 极地南北不对称衰减（可选一行，验收后定）
