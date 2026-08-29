# 夜间光照：方向性月光 + 月相（方向 C）设计

- **日期**：2026-08-30
- **状态**：r1（三专家评审全处置：红队 2C+7I / 图形学 2C+6I / 工程 2C+4I；处置表见 §11）
- **用户拍板记录**：①范围=月光+月盘一起做；②基调=物理基调微亮银灰（倍率可调视觉拍板）；③**月盘无昼夜门、保留物理白天浅月**（2026-08-30 r1 重拍板——r0「白天自动不可见」亮度论证被评审证伪：月面亮度与晴空同量级，真实白天本就隐约见月；白天验收相应改为「云侧 diff=0、月盘侧允许形状差异」）
- **前置**：`2026-08-29` 夜间云底光修复（nightAmbient，71ada46/c6df0c3/23462ee 两轮收窄）——本设计是其遗留方向 C 的实现；方向 A（夜空大气侧联动）视本设计效果再定，不在本 spec 范围

## 1. 背景与目标

夜间云现状：`nightAmbient=0.12` 各向同性底光（无方向、无月相、不随时间变化）——云夜里不会全黑，但光源「隐身」：天上没有月亮，云的亮度与月球位置/月相无关。

本设计实现**方向 C：方向性月光 + 月相**：

1. **月光照云**：云被来自月球方向的光照亮——云顶（朝月面）亮、云底暗，形体感来自月光方向；强度随月相（满月最亮、新月≈无）
2. **月盘**：天上看得见月亮——物理月盘（月面明暗分布带月相，Oren-Nayar 月尘散射），过大气透视（地平线泛红变暗）；白天为隐约浅灰盘（物理正确行为，用户拍板保留）
3. 两者共用同一月方向计算，demo 现有 `?time=` 直接驱动（换日期=换月相）

## 2. 非目标（YAGNI，明确不做）

- 月光云影（BSM 第二套级联阴影——成本翻倍，满月云影真实存在但首版不做，局限记录于 §9）
- 月光 god rays（lightShafts 太阳专有）
- 月光 lens flare——仅对默认倍率成立：`moonRadiance` 拉到 ~20+ 时夜盘线性值超 lf 阈值 3.0 会触发 flare（记录边界，不修）
- 月面环形山纹理（均匀灰月面）与地球反照 earthshine
- 月盘运行时开关切换（moon 参数为**创建期语义**，切换=重建 stage；demo 走页面重载，运行时切换不在范围——同 sun/sky 宏惯例）
- 方向 A 夜空大气侧联动（月光 inscatter 进大气 LUT——视本设计效果再立项）
- astronomy-engine 依赖（上游用它算月位置；本项目用 Cesium 内置 Simon1994 同源方案，见 §4）

## 3. 总体架构：月方向单源，两处消费

```
viewer.clock.currentTime（demo ?time= 已驱动）
        │
        ▼
core/celestialDirections.ts（新增，唯一实现）
  computeMoonDirectionECEF(time, originECEF, result)   ── 视差修正后的观察者月方向
  computeMoonIlluminatedFraction(time)                  ── 月相因子（仅供单测/独立消费）
        │
        ├──▶ AtmosphereStage（月盘：sky 分支 MOON 段，preRender 内部自算月方向）
        └──▶ clouds（月光照云：CloudsFrameState 每帧更新，调同一函数）
```

- 单点实现放 `cesium-core`，clouds 的 package.json 已有 `@cesium-geospatial/core: workspace:*` 依赖（ES import 先例：resolveCloudsIncludes/CloudsMaterial/CloudsPass/createCloudsStage）——两处消费同一份公式，不漂移（工程评审实测确认）
- 与现有太阳方向模式同构：AtmosphereStage 与 clouds 的 sunDirection 本就各自 preRender 重算（Simon1994 + ICRF→Fixed，见 `createCloudsStage.ts:453` 注释），月方向照抄该管线（**含 `computeIcrfToCentralBodyFixedMatrix`——2026-08-16 竞态修复后的版本，禁用旧 `computeIcrfToFixedMatrix`**），仅多一步视差修正（§4.2）

## 4. 月方向与月相（core/celestialDirections.ts）

### 4.1 月方向管线

```
Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time)   // ICRF，米，地心（Cesium 全域米制）
  → computeIcrfToCentralBodyFixedMatrix(time) 旋转到 ECEF                  // 与现有太阳管线同款（createCloudsStage.ts:485）
  → 视差修正：moonECEF(米) − originECEF(米) → normalize                      // §4.2
  → 单位向量（观察者所见月方向，ECEF）
```

**API**：

```ts
/** 观察者月方向（ECEF 单位向量）。originECEF 观察者位置（米）。 */
export function computeMoonDirectionECEF(
  time: JulianDate, originECEF: Cartesian3, result: Cartesian3
): Cartesian3

/** 月相照明因子 f：新月≈0、弦月≈0.318、满月≈1（见 §4.3）。
 *  仅供单测/独立消费——运行时消费方手头已有 sun/moon 两方向，直接 dot 求 elongation
 *  更省（本函数内部要再跑 Simon1994×2+ICRF×1，每帧独立调用是浪费）。 */
export function computeMoonIlluminatedFraction(time: JulianDate): number
```

### 4.2 视差修正（必做，非可选）

太阳方向地心近似即可（距离 1.5 亿 km，视差可忽略），月亮不行——月地距离 38 万 km，月球赤道地平视差 **57′**，约为月盘视直径（≈31′）的两倍。不做修正则月盘方位/月出月落位置偏差最多两个盘径。修正本身一行：ECEF 域内 `moon − origin` 再归一（比上游 ECI 域减法简单）。**单位纪律：Simon1994 返回米**（r0 误标 km，工程+图形学双确认），全链统一米制。

### 4.3 月相因子

从太阳-月几何直接推（无新天文表）：

```
elongation ε = acos(clamp(dot(sunDirECEF, moonDirECEF), -1.0, 1.0))   // clamp 防 float 越界 NaN（朔望点高危）
云侧照明因子  f = (sin ε − ε·cos ε) / π    // 球面 Lambert 积分：朔 0 / 弦月 0.318 / 望 1（与月盘几何相函数同曲线）
```

- r0 的线性 `f=(1−cos ε)/2` 弦月给 0.5，与月盘 Oren-Nayar 几何涌现的物理曲线（弦月≈0.318）不一致——盘亮云暗口径分叉；物理版一行免费对齐（图形学评审 M1），采纳
- 观察者域 dot 求 ε 与地心域差 <0.01 不可感，运行时直接用 state 两方向
- 物理近似说明：真实月相照度还含 opposition surge（满月突亮）与月轨偏心（超级月亮），首版用 Lambert 球积分，误差在艺术倍率（§6.3）内不可感

### 4.4 单测策略

- **朔望极值扫描**（自洽主验证）：60 天窗口 6h 粗扫 + 极值邻域三分细化。判据（r0 写反已修正）：`dot(sun,moon)` **极大**（ε→0 合相/朔）断言 `f < 0.02`；**极小**（ε→180° 冲/望）断言 `f > 0.98`。注意朔/望每朔望月各一次，两个极大解同判据不区分
- **农历锚点 sanity**（独立于扫描，不互为依据）：2026-09-25 中秋锚断言 `f > 0.95`（扫描找极值是验证主依据，历法锚只做旁证）
- **视差修正量级**：同一时刻，地面观察者 vs 地心的月方向角差 ∈ (10′, 57′]——**上下界都要**（r0 只有上界：origin 单位错 1000 倍时视差≈0 也过测，静默失效）。断言形如 `dot(观察者方向, 地心方向) ∈ [cos(1°), cos(10′)]`
- **连续性**：时间前推 1 秒，方向与 f 均无跳变（相邻帧稳定）
- 环境可行性：Simon1994/Transforms 真实实现 node 可跑（createCloudsStage.test.ts 先例）

## 5. 月盘（AtmosphereStage sky 分支 MOON 段）

### 5.1 放置、大气透视与 inscatterScale 解耦

月盘加在 `aerialPerspective.frag` 的 **SKY 路径**：

- 月盘 radiance × **该视线方向的大气透射率**（transmittance LUT 采样——月盘 38 万 km 远，「无穷远天体」沿视线穿整层大气，视线方向 transmittance 即全部衰减），叠入天空项
- **注入点钉死在 `inscatter × u_inscatterScale` 之前、以独立项注入**（r0 未定义，红队指出月盘亮度会被雾浓艺术旋钮 inscatterScale(默认 25) 劫持——`?inscatterScale=1` 月盘熄灭）：月盘**不吃** inscatterScale，亮度只由 moonRadiance 与曝光链决定
- `moonRadiance` 默认 **25**：语义=「内含 inscatterScale(25) 等效补偿」——月盘 display 量级与 r0 预期（约 124/255 显眼银盘）对齐且不随雾旋钮漂移
- 天空 inscatter 照常叠加；盘随 hasScene mask 被前景雾混掉=地形自动遮月（与太阳盘行为一致）；limbFade/inscatterScale 同路部分与太阳盘保持一致

### 5.2 月面渲染（移植上游 MoonNode 方案，GLSL 重写）

- **判定与盘缘 AA**（r0 公式余弦/角度混比已修正——`dot < ω` 会渲出占半天球的巨月）：

```glsl
// 照抄本仓库 SUN_DISK_GLSL 范式（acos + fragmentAngle smoothstep，非 dot 与弧度直比）
float moonAngle = acos(clamp(dot(rayDirection, moonDirection), -1.0, 1.0));
float moonDisc = smoothstep(moonAngularRadius, moonAngularRadius - fragmentAngle, moonAngle);
```

`fragmentAngle` 已在控制流分叉前算好（dFdx/dFdy 纪律），盘缘 ~1px 过渡即 AA；MoonNode 的 chordLength+fwidth 那套是为月面纹理扰动配的，v1 无纹理不用。

- **月面法线**：视线与月球球面交点法线（上游 `raySphereIntersectionNormal` 同款：投影 + 半弦长重建）
- **明暗**：Oren-Nayar 漫反射——**钉死 MoonNode 版**（改进版 mimosa-pudica：A=(1/π)(1−0.5/1.33+0.17/1.13)、B=(1/π)(0.45/1.09)、t=mix(1,max(max(NoL,NoV),0.1),smoothstep(s,0,0.1))），实参序 **(L=sunDirection, V=−rayDirection, N=月面法线)**；**禁用 sky.glsl 旧版**（常量 0.62406/0.41284、无 1/π、实参序相反——照抄会把明暗中段倒相，图形学评审 I4）。月相从几何自动涌现（太阳只照亮半个月球），无显式相位逻辑
- **亮度**（上游 `getLunarRadiance` 同公式，**量级基准 0.058**——r0 误算 2.5e-6 漏除 1/(π·ω²)，红队+图形学双验算）：

```glsl
vec3 moonDiscRadiance = ATMOSPHERE.solar_irradiance
                      * 2.5e-6                        // 月/日视星等差 14 等 → 亮度比（已含月面反照率）
                      / (PI * moonAngularRadius * moonAngularRadius)
                      * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE   // 对齐上游亮度换算（不乘则相对日盘差 ~1.35× 且 ~7% 色偏）
                      * moonRadiance;                 // 倍率 uniform（默认 25，语义见 §5.1）
```

量级链：×solar_irradiance(1.474)×2.5e-6÷(π×0.0045²) ≈ **0.058**（G 0.073 / B 0.075）→ ×25 → ×夜间曝光 0.1 → 0.145 → ACES ≈ **124/255**（显眼银盘）。全程高于 half 最小正规数 5× 以上——**无下溢风险**（r0 §9 风险条目系推导漏项，已改写，见 §9）。

- **角半径视觉决策**：`moonAngularRadius = 0.0045`（≈15.5′，真实值）在 1080p/fov60° 下月盘直径仅 **≈9 px**——物理正确（真实广角照片里月亮就这么大）但月相细节难读。**默认物理值 + demo `?moonAngularRadius=` 可调**（艺术放大 2-10× 是电影惯例）；耦合纪律：放大 ω 同式下总亮度×ω²，只放大不增亮须同步 `moonRadiance ×(ω_phys/ω_art)²`（URL 层组合或文档注明，plan 定实现位置）

### 5.3 无昼夜门（用户拍板保留物理白天浅月）

白昼天空 inscatter 与月盘 radiance 同量级（月面亮度≈晴空亮度的 0.3-1，角面积小故整体不显眼）——物理正确渲染下白天月盘是**隐约浅灰盘**（真实世界的白昼月亮本就如此可见）。用户拍板（2026-08-30）保留此物理行为：月盘**无昼夜门、常开**。相应地白天零回归验收为「**云侧**逐像素 diff=0；月盘侧允许 moon 形状差异」（§8），不因白天浅月盘报障。

（r0「比最亮恒星亮 4 万倍故自然最亮」论证删除——星空是 skyBox 艺术纹理非物理 radiance，星等比较无意义；月盘显示量级由 §5.1 量级链决定。）

### 5.4 uniforms / options / state

- AtmosphereStage 新 options：`moon?: boolean`（默认 true；**创建期语义**——false 时 MOON 段不拼入（JS 条件拼接，同 sun/sky 惯例），切换=重建 stage，运行时切换不在范围）、`moonRadianceScale?: number`（默认 25）
- 月方向 preRender 内部自算（同现有太阳模式）；**origin = viewerPositionWC + altitudeCorrection**（与 reconstructRay 射线起点同帧同源——太空相机 offset 可达 1e4 km，用裸相机位置月盘方位偏 1-2°）
- `AtmosphereFrameState` 增 `moonDirection: Cartesian3`（每帧更新）
- **集成要求**：库消费者须自设 `scene.moon.show = false`（Cesium 内置月亮会与本月盘重叠成双月亮；demo main.ts 已关）

## 6. 月光照云（clouds 光照循环 moon 项）

### 6.1 公式：与太阳方向散射项同构，独立构造

云的太阳光照 = 平行光 × HG 相函数 × 能量积分。月光物理上同一过程的弱化版——光照循环加一项 moon 项，与 sun/sky/ground/nightAmbient 并列：

- **同构范围**（r0「同款公式」限定）：方向散射项（HG/相位/密度积分）同构；**不含** BSM light march（§9 一致）；**不走** accurate 路径的 GetSunAndSkyScalarIrradiance LUT（夜间 LUT 太阳项归零，月光走简化 HG）
- **独立构造**（非「现有 sun 项乘系数」——夜间 LUT sunIrradiance=0，乘系数恒 0）：

```
moonIrradiance = ATMOSPHERE.solar_irradiance × 2.5e-6 × f(月相,Lambert 曲线) × moonLightScale × nightFactor
cosTheta_moon  = dot(moonDirection, rayDirection)     // 相函数自变量须重算（现 cosTheta 只算太阳）
```

- **朝月光深 march（显式决策）**：moon 项的 opticalDepth 朝**月亮方向**独立 march（复用 marchOpticalDepth、maxIterationCountToSun=2 同预算）——不能复用太阳方向（夜间太阳在地平下方向反了，复用会把「云顶被月光照亮」直接杀死，正是主视觉）；成本 = 每受照样本多 ~2 次 media 采样（百分之几，可接受）；**不采 BSM**（月光无云影，§9）
- 上游无此实现（CloudsEffect 无 moon），本节为自研；具体落点（光照循环哪几行、phase 函数复用哪个）在 plan 阶段按 clouds.frag 光照段现状精确展开

### 6.2 两道门：昼夜分账 + 月升落

moon 项乘两个 smoothstep 门：

1. **昼夜分账门（nightFactor，复用现有变量）**：`1 − smoothstep(sin(−6°), sin(−1°), muSunLocal)`——月光艺术放大后白天会露馅，此门保证白天精确 0（云侧零回归）、晨昏带与 nightAmbient 同曲线淡入。**注释须随消费方扩写**：该变量现同时是 nightAmbient 与 moonlight 的「夜间曝光分账门」——艺术处理非物理量（物理上月光的可见性连续），后续维护者勿当物理量「修」
2. **月升落门（r0 缺失，图形学评审 I1 补）**：`smoothstep(-0.05, 0.02, dot(surfaceNormal, moonDirection))`——月落西山后 moonDirection 在地平线下，无此门则云被「地下来的光」照亮、云底亮反转（弦月下半夜必现，夜验收盲区）。窗口≈云层高度的地平俯角（8km 云层≈−3°，可调）

已知局限：极地夏季「白夜」（太阳 >−1° 但地方时为夜）满月当空云也无月光——nightFactor 是太阳仰角门非地方时门，记录不修。

### 6.3 强度与倍率

- 物理月光 = 太阳 × 2.5e-6，相对 nightAmbient(0.12) 不可见，必须艺术放大
- 目标观感（用户拍板）：满月夜云「微亮银灰」、**月光主导夜间照明**——量化：满月月光 irradiance 贡献 ≥ nightAmbient 的 1.5×（验收拍板锚，见 §8）
- `moonLightScale`（新 CloudsParameters 字段）默认估算 **50000**（r0 估算 25000 时月光≈0.092 **<** nightAmbient 0.12，「主导」不成立——红队验算；50000 → ≈0.18 ≈ nightAmbient 1.5×）；demo `?moonLightScale=` 可调，**默认值由用户视觉验收拍板**（同 cloudsExposure=12 流程）
- 月光颜色：中性白（与太阳同光谱；真实月光光谱本就中性，偏蓝是 Purkinje 感知+摄影惯例——夜间 ACES 低亮度段本就去饱和，图形学评审确认决策正确）；tint 留验收后视需求加参数

### 6.4 nightAmbient 关系

**保留不动**，语义改为「星光/气辉底光」：各向同性、无月也有（新月夜云不至于纯黑——真实星光确实微弱照亮云）。满月时月光（方向性、强）主导，nightAmbient（均匀、弱）退居兜底。两者独立参数（`?cloudsNightAmbient=` 已有），物理上本就是独立光源；若满月夜观感过亮再调 nightAmbient 默认值（视觉验收定夺）。

### 6.5 uniforms / state

- `CloudsFrameState` 增 `moonDirection: Cartesian3` 与 `moonIlluminatedFraction: number`，preRender 内与 sunDirection 同步更新（调 core `computeMoonDirectionECEF`；origin 用与 altitudeCorrection 同源的密切球心位置=clouds 几何域惯例；f 用 state 两方向 dot 求 ε 按物理曲线算，不独立调 §4.1 API）
- 新 uniforms：`moonDirection(vec3)`、`moonIlluminatedFraction(float)`、`moonLightScale(float)`（uniform 门粒度，不触发重建——与 atmosphere 侧 moon 宏的粒度分野同现状 sun/sky 宏 vs params uniform 惯例）
- setQuality 换档：走「创建时显式 options 重新 resolve」现有路径，月参数在换档后不丢（工程评审实测确认）

## 7. Demo 参数

| 参数 | 语义 | 默认 |
|---|---|---|
| `?moon=0` | 总开关：atmosphere 月盘段不拼入 + 云月光项 uniform 乘 0——诊断基线/回退现状 | 开 |
| `?moonRadiance=N` | 月盘亮度倍率（不吃 inscatterScale，语义见 §5.1） | 25 |
| `?moonAngularRadius=N` | 月盘角半径 rad（物理 0.0045≈9px；艺术放大时注意 §5.2 亮度耦合纪律） | 0.0045 |
| `?moonLightScale=N` | 云月光倍率 | 50000（估算，视觉拍板） |
| `?cloudsNightAmbient=N` | 既有，语义不变 | 0.12 |

无结构性改动：月方向全部 stage 内部自算，demo 只透传参数（?moonLightScale 走 parameters 浅合并入口，同 nightAmbient 先例）。

## 8. 验收判据

| 场景 | 判据 |
|---|---|
| 满月夜（2026-09-25 中秋锚） | 云银灰微亮；云顶亮/云底暗方向性可见；月盘显眼全圆（默认参数 display ≥80/255 数值锚） |
| 满月夜「月光主导」量化 | 满月 vs 新月云区像素均值比（agent-browser 同批成对录制）≥ 与 nightAmbient×1.5 对应的阈值（实现时随 moonLightScale 默认定标） |
| 新月夜 | 云回落至 nightAmbient 底光水平（≈现状画面）；无月盘或极细月牙 |
| 弦月 | 月盘半圆；云明显暗于满月（物理 Lambert 曲线 ≈满月 1/3——非对半，验收措辞按此） |
| 月落夜（弦月下半夜，月高 <−5° 日期） | 云回落 nightAmbient 基线，无「地下光」云底亮反转 |
| 满月夜相机转向月亮 | 云被照亮方向与月盘位置一致（方向性自洽） |
| 白天（现有验收视角） | **云侧**逐像素 diff = 0（?moon 开/关对比，uniform 乘 0 精确 0）；**月盘侧允许 moon 形状差异**（白天浅月=物理正确，用户拍板） |
| 晨昏带 | 无新过渡反常（月光与底光同变量淡入） |
| 地平线月亮 | 月盘泛红变暗（大气透视生效） |

验收环境注意（既有坑）：视觉验收用 HEADED、console/profile 验证用 headless session；改 GLSL 后清 vite 缓存；AI 读图结论须像素级佐证。

## 9. 风险与局限

- ~~half-float 下溢~~（**r0 条目证伪删除**：月盘 radiance 实为 0.058 而非 2.5e-6——r0 推导漏除 1/(π·ω²)，红队+图形学双验算；0.058×0.05(最暗 transmittance)×25×0.1=7.3e-3，全程高于 half 最小正规数 6.1e-5 两百倍以上，无下溢；moonRadiance 默认 25 是 inscatterScale 解耦补偿语义，非下溢对策）
- **月光无云影**：月光散射项不参与 BSM——满月夜云无自阴影，形体感仅来自散射方向项。若观感不足，后续再评估月光 BSM（成本敏感，预期不做）
- **月盘 additive 不遮星**：月盘背后的星星透出（月盘远亮于星，无感）；月盘不写 depth（sky 后处理内，lf 的太阳 occlusion 无交互——lf 只看太阳）
- **月相照度简化**：Lambert 球积分无 opposition surge/月轨偏心，误差被艺术倍率吸收
- **Oren-Nayar 与视星等能量不自洽**（上游同款近似）：视星等 −12.74 是总亮度，Oren-Nayar 只是明暗分布形状，相乘是近似——照抄上游，视觉验收把关
- **月盘 lf 触发边界**：moonRadiance 拉到 ~20+ 夜盘线性值超 lf 阈值 3.0 会触发 lens flare（「月光 lf 不触发」仅默认倍率成立）
- **极地白夜**：nightFactor 是太阳仰角门，极地夏季白夜满月当空云无月光（记录不修）
- **moonLightScale 与 nightAmbient 的比例拍板**：满月夜若观感过亮/过暗，优先调 moonLightScale 默认（视觉验收流程），nightAmbient 兜底不动

## 10. 测试策略

- **celestialDirections 单测**（§4.4）：朔望扫描（判据已修正）/农历独立锚/视差上下界/连续性
- **shader 编译**：aerialPerspective（MOON 段开/关两态）与 cloudsMain（moon 项）glslang 真编译过（既有 compile test 范式扩展）
- **文本断言**：MOON 段判定式用 acos+smoothstep（非 dot 直比）/Oren-Nayar MoonNode 版常量/盘缘 AA fragmentAngle；云侧 moon 项乘 nightFactor 同 smoothstep + 月升落门
- **零回归口径拆开**（r0 口径矛盾修正）：atmosphere 侧 moon:false 产物与现状**逐字符一致**（golden 基线=snapshot 或内嵌 golden 串，改前录守门——现状 JS 条件拼接下字面成立）；云侧是 uniform 门（项×0 精确 0）**值等价**而非文本一致——不断言 shader 字符串，断言运行时行为（白天 diff=0）
- **像素验收**：白天云侧 diff=0、满月/新月/月落对照（demo URL，agent-browser 同批成对录制）

## 11. 评审处置表（r0 → r1，2026-08-30 三专家）

| 编号 | 来源 | 问题 | 处置 |
|---|---|---|---|
| C1 单位 | 工程 | Simon1994 返回米非 km，r0 标 km 视差静默失效 | §4.1/§4.2 改米（图形学 I5 双确认） |
| C2 函数名 | 工程 | computeIcrfToFixedMatrix=已弃用竞态版 | §3/§4.1 改 central-body-fixed（红队 I2/图形学 I5 三重确认） |
| C1 判定式 | 图形学 | dot<ω 余弦/角度混比→巨月 | §5.2 改 acos+smoothstep SUN_DISK 范式+盘缘 AA（红队 I4 双确认） |
| C2 下溢 | 图形学 | 下溢推导漏除 1/(π·ω²)，实际 0.058 无下溢 | §5.2 写量级链、§9 条目证伪删除、moonRadiance 默认回语义值（红队 I1 双确认） |
| C1 白天门 | 红队 | 「白天不可见」伪物理，diff=0 必挂 | **用户重拍板：保留物理白天浅月**；§5.3 改写、§8 白天判据改云侧（图形学 I2/I3 同源） |
| C2 inscatterScale | 红队 | 月盘亮度被雾旋钮劫持 | §5.1 注入点钉死 inscatterScale 前独立项、moonRadiance 默认 25 补偿语义 |
| I1 月落门 | 图形学 | 月落后云被地下光照亮、云底反转 | §6.2 门 2 补、§8 加月落夜验收行 |
| I2 f 签名 | 工程 | time 签名诱导每帧重算 | §4.1 注明仅供单测、§6.5 运行时 state dot |
| I3 盘开关 | 工程 | 创建期语义未言明 | §2 非目标+§5.4 明写 |
| I4 golden 基线 | 工程 | 逐字符一致断言载体 | §10 零回归口径拆开+snapshot 载体 |
| I6 尺寸 | 图形学 | 9px 月盘视觉决策缺席 | §5.2 物理默认+?moonAngularRadius=+亮度 ω² 耦合纪律 |
| I5c 主导量化 | 红队 | 25000 时月光<nightAmbient 主导不成立 | §6.3 默认 50000+§8 量化验收锚 |
| I5a/b 光深 | 红队 | march 分叉被 plan 展开掩盖 | §6.1 显式决策：朝月独立 march+2 采样、cosTheta 重算、成本披露 |
| I3 朔望判据 | 红队 | \|dot\| 极值→弦月，判据写反 | §4.4 修正（dot 极大→朔/极小→望）+工程 M3 视差上下界 |
| I6 零回归口径 | 红队 | 云侧逐字符一致不可能 | §10 拆开（atmosphere 文本/云侧值等价） |
| I7 origin | 红队 | 月方向 origin 与射线系不一致 | §5.4 viewerPositionWC+altitudeCorrection |
| I4 O-N 版本 | 图形学 | 上游两版 Oren-Nayar 常量/实参序不同 | §5.2 钉死 MoonNode 版+实参序，禁 sky.glsl 旧版 |
| M1 月相曲线 | 图形学 | 线性 f 与盘几何曲线不一致 | §4.3 Lambert 球积分（sin ε−ε cos ε)/π，弦月 0.318 |
| 其余 Minor | 三方 | 亮度换算补乘/lf 边界/极地白夜/双月亮集成/量级数字/参数入口等 | 全部吸收进对应节（§2/§5.2/§5.4/§7/§8/§9） |

**总体**：架构骨架（core 单源、两处消费、盘走 SKY 分支、云走第四光照项、无新 stage、依赖方向、宏/uniform 分野、setQuality 存活）三方逐点验证通过未动；r1 全部为文本级修正与决策补录。
