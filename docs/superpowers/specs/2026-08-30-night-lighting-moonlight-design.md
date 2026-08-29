# 夜间光照：方向性月光 + 月相（方向 C）设计

- **日期**：2026-08-30
- **状态**：r0（设计四节已经用户逐节确认：范围/基调/照云/参数）
- **上游拍板记录**：范围=月光+月盘一起做；基调=物理基调微亮银灰（倍率可调视觉拍板）
- **前置**：`2026-08-29` 夜间云底光修复（nightAmbient，71ada46/c6df0c3/23462ee 两轮收窄）——本设计是其遗留方向 C 的实现；方向 A（夜空大气侧联动）视本设计效果再定，不在本 spec 范围

## 1. 背景与目标

夜间云现状：`nightAmbient=0.12` 各向同性底光（无方向、无月相、不随时间变化）——云夜里不会全黑，但光源「隐身」：天上没有月亮，云的亮度与月球位置/月相无关。

本设计实现**方向 C：方向性月光 + 月相**：

1. **月光照云**：云被来自月球方向的光照亮——云顶（朝月面）亮、云底暗，形体感来自月光方向；强度随月相（满月最亮、新月≈无）
2. **月盘**：天上看得见月亮——物理月盘（月面明暗分布带月相，Oren-Nayar 月尘散射），过大气透视（地平线泛红变暗）
3. 两者共用同一月方向计算，demo 现有 `?time=` 直接驱动（换日期=换月相）

## 2. 非目标（YAGNI，明确不做）

- 月光云影（BSM 第二套级联阴影——成本翻倍，满月云影真实存在但首版不做，局限记录于 §9）
- 月光 god rays（lightShafts 太阳专有）
- 月光 lens flare（月光弱，lf 阈值 3.0 夜间不触发）
- 月面环形山纹理（均匀灰月面）与地球反照 earthshine
- 方向 A 夜空大气侧联动（月光 inscatter 进大气 LUT——视本设计效果再立项）
- astronomy-engine 依赖（上游用它算月位置；本项目用 Cesium 内置 Simon1994 同源方案，见 §4）

## 3. 总体架构：月方向单源，两处消费

```
viewer.clock.currentTime（demo ?time= 已驱动）
        │
        ▼
core/celestialDirections.ts（新增，唯一实现）
  computeMoonDirectionECEF(time, originECEF, result)   ── 视差修正后的观察者月方向
  computeMoonIlluminatedFraction(time)                  ── 月相因子 f∈[0,1]
        │
        ├──▶ AtmosphereStage（月盘：sky 分支 MOON 段，preRender 内部自算月方向）
        └──▶ clouds（月光照云：CloudsFrameState 每帧更新，调同一函数）
```

- 单点实现放 `cesium-core`，clouds 已依赖 core（LUT 类型/LOG_DEPTH_GLSL 先例），直接 import——两处消费同一份公式，不漂移
- 与现有太阳方向模式同构：AtmosphereStage 与 clouds 的 sunDirection 本就各自 preRender 重算（Simon1994 + ICRF→Fixed，见 `createCloudsStage.ts:453` 注释），月方向照抄该管线，仅多一步视差修正（§4.2）

## 4. 月方向与月相（core/celestialDirections.ts）

### 4.1 月方向管线

```
Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time)   // ICRF，km，地心
  → Transforms.computeIcrfToFixedMatrix(time) 旋转到 ECEF                    // 与现有太阳同款
  → 视差修正：moonECEF(km) − originECEF(km) → normalize                      // §4.2
  → 单位向量（观察者所见月方向，ECEF）
```

**API**：

```ts
/** 观察者月方向（ECEF 单位向量）。originECEF 观察者位置（km，密切球心或相机）。 */
export function computeMoonDirectionECEF(
  time: JulianDate, originECEF: Cartesian3, result: Cartesian3
): Cartesian3

/** 月相照明因子 f：新月≈0、弦月≈0.5、满月≈1（见 §4.3）。 */
export function computeMoonIlluminatedFraction(time: JulianDate): number
```

### 4.2 视差修正（必做，非可选）

太阳方向地心近似即可（距离 1.5 亿 km，视差可忽略），月亮不行——月地距离 38 万 km，月球赤道地平视差 **57′**，约为月盘视直径（≈31′）的两倍。不做修正则月盘方位/月出月落位置偏差最多两个盘径。修正本身一行：ECEF 域内 `moon − origin` 再归一（比上游 ECI 域减法简单）。

### 4.3 月相因子

从太阳-月几何直接推（无新天文表）：

```
elongation = acos(dot(sunDirECEF, moonDirECEF))    // 地心日月夹角
f = (1 − cos(elongation)) / 2                       // 新月 0 → 满月 1
```

物理近似说明：真实月相照度还含 opposition surge（满月突亮）与月轨偏心（超级月亮），首版用简单 illumination fraction，误差在艺术倍率（§6.3）内不可感。

### 4.4 单测策略

- **朔望极值扫描**（自洽主验证）：扫描 60 天窗口找 `|dot(sunDir, moonDir)|` 极值时刻，断言极小值点（合相/朔）`f < 0.02`、极大值点（冲/望）`f > 0.98`
- **农历锚点抽查**：取中秋等农历十五日期断言 `f > 0.95`（锚点日期实现时以扫描结果确认，预期在中秋当天附近）
- **视差修正量级**：同一时刻，地面观察者 vs 地心的月方向差应在 0–57′ 内（cos 差 < cos(1°) 的上界断言）
- **连续性**：时间前推 1 秒，方向与 f 均无跳变（相邻帧稳定）

## 5. 月盘（AtmosphereStage sky 分支 MOON 段）

### 5.1 放置与大气透视

月盘加在 `aerialPerspective.frag` 的 **SKY 路径**：月盘 radiance × **该视线方向的大气透射率**（transmittance LUT 采样，与太阳盘衰减同源）后，叠加进天空 radiance；天空 inscatter 照常。效果：月亮靠近地平线自动泛红变暗（物理正确），不新增任何 PostProcessStage（后处理链结构不变）。

### 5.2 月面渲染（移植上游 MoonNode 方案，GLSL 重写）

- **判定**：`dot(rayDirection, moonDirection) < moonAngularRadius`（视线落在月盘锥内）
- **月面法线**：视线与月球球面交点法线（上游 `raySphereIntersectionNormal` 同款：投影 + 半弦长重建）
- **明暗**：每点 Oren-Nayar 漫反射（粗糙度 1、albedo 1 形状函数；上游 `orenNayarDiffuse` 同款公式）×太阳方向——**月相从几何自动涌现**（太阳只照亮半个月球，地球看去即朔望弦），无显式相位逻辑
- **亮度**（上游 `getLunarRadiance` 同公式）：

```glsl
vec3 moonDiscRadiance = ATMOSPHERE.solar_irradiance
                      * 2.5e-6                        // 月/日视星等差 14 等 → 亮度比（已含月面反照率）
                      / (PI * moonAngularRadius * moonAngularRadius)
                      * moonRadiance;                 // 倍率 uniform（默认 1=物理比例；§9 下溢对策或调默认）
```

- 角半径 `moonAngularRadius = 0.0045`（≈15.5′，真实值，const）

### 5.3 无昼夜门（设计要点）

月盘亮度域为「物理相对值」：白昼天空 radiance 高出月盘多个数量级，物理比例下白天月盘自动不可见（与真实白天看不见月亮同理）——**不需要任何昼夜开关**，常开零成本。夜间月盘比最亮恒星亮 4 万余倍（视星等 −12.74 vs 天狼星 −1.46），物理比例下自然成为夜空最亮天体。需要放大的只有云的月光照明（§6），门已由 nightFactor 承担。（亮度域的绝对数值受 half-float 下溢约束，倍率默认值见 §9 风险条目。）

### 5.4 uniforms / options

AtmosphereStage 新 options：`moon?: boolean`（默认 true，false 时 SKY 段整体不编入=现状画面）、`moonRadianceScale?: number`（默认 1）。月方向无需外部喂——stage preRender 内部调 `computeMoonDirectionECEF`（相机位置做 origin，视差正确）。

## 6. 月光照云（clouds 光照循环 moon 项）

### 6.1 公式：与太阳散射项同构

云的太阳光照 = 平行光 × HG 相函数 × 能量积分。月光物理上同一过程的弱化版——**光照循环加一项 moon 项，与 sun/sky/ground/nightAmbient 并列**：

```
moonLight = sunLight 同款公式，替换：
  方向 sunDirection → moonDirection
  强度 × 2.5e-6 × f(月相) × moonLightScale × nightFactor
```

上游无此实现（CloudsEffect 无 moon），本节为自研；公式同构保证形体感（云顶亮/云底暗/银边）与太阳光照一致。具体落点（光照循环哪几行、phase 函数复用哪个）在 plan 阶段按 clouds.frag 光照段现状精确展开。

### 6.2 昼夜分账：复用 nightFactor 门

月光必须艺术放大（§6.3），放大后白天会露馅（月光会变成太阳的可感比例，破坏白天画面）。门直接复用**现有 nightFactor 变量**（`1 − smoothstep(sin(−6°), sin(−1°), muSunLocal)`，即晨昏带 V 形二修的同一变量）：

- 白天（太阳 > −1°）：月光项精确 0 —— **白天逐像素零回归**（diff=0）
- 晨昏带：月光与 nightAmbient 同曲线淡入——行为天然一致，不产生新的过渡反常
- 夜间：满值

### 6.3 强度与倍率

- 物理月光 = 太阳 × 2.5e-6 ≈ 4×10⁻⁶ 量级 irradiance，相对 nightAmbient(0.12) 不可见
- 目标观感（用户拍板）：满月夜云「微亮银灰」、月光主导夜间照明
- `moonLightScale`（新 CloudsParameters 字段）默认估算 **25000**（使满月云月光贡献 ≈0.1 irradiance 量级，与 nightAmbient 同数量级并主导方向性）；demo `?moonLightScale=` 可调，**默认值由用户视觉验收拍板**（同 cloudsExposure=12 流程）
- 月光颜色：中性白（与太阳同光谱）；偏蓝 tint 留待视觉验收后视需求加参数

### 6.4 nightAmbient 关系

**保留不动**，语义改为「星光/气辉底光」：各向同性、无月也有（新月夜云不至于纯黑——真实星光确实微弱照亮云）。满月时月光（方向性、强）主导，nightAmbient（均匀、弱）退居兜底。两者独立参数（`?cloudsNightAmbient=` 已有），物理上本就是独立光源；若满月夜观感过亮再调 nightAmbient 默认值（视觉验收定夺）。

### 6.5 uniforms / state

`CloudsFrameState` 增 `moonDirection: Cartesian3`，preRender 内与 sunDirection 同步更新（调 core `computeMoonDirectionECEF`，origin 用密切球心——与 altitudeCorrection 同源位置）。新 uniforms：`moonDirection(vec3)`、`moonIlluminatedFraction(float)`、`moonLightScale(float)`。

## 7. Demo 参数

| 参数 | 语义 | 默认 |
|---|---|---|
| `?moon=0` | 总开关（月盘不编入 + 云月光项乘 0）——诊断基线/回退现状 | 开 |
| `?moonRadiance=N` | 月盘亮度倍率 | 1（物理比例；若 §9 half 下溢实测成立则调整为曝光域默认值） |
| `?moonLightScale=N` | 云月光倍率 | 25000（估算，视觉拍板） |
| `?cloudsNightAmbient=N` | 既有，语义不变 | 0.12 |

无结构性改动：月方向全部 stage 内部自算，demo 只透传参数。

## 8. 验收判据

| 场景 | 判据 |
|---|---|
| 满月夜（农历十五日期） | 云银灰微亮；云顶亮/云底暗方向性可见；月盘显眼全圆 |
| 新月夜 | 云回落至 nightAmbient 底光水平（≈现状画面）；无月盘或极细月牙 |
| 弦月 | 月盘半圆；云亮度约满月一半 |
| 满月夜相机转向月亮 | 云被照亮方向与月盘位置一致（方向性自洽） |
| 白天（现有验收视角） | 逐像素 diff = 0（?moon 开/关对比） |
| 晨昏带 | 无新过渡反常（月光与底光同变量淡入） |
| 地平线月亮 | 月盘泛红变暗（大气透视生效） |

验收环境注意（既有坑）：视觉验收用 HEADED、console/profile 验证用 headless session；改 GLSL 后清 vite 缓存；AI 读图结论须像素级佐证。

## 9. 风险与局限

- **月光无云影**：月光散射项不参与 BSM（云自阴影是太阳的）——满月夜云无自阴影，形体感仅来自散射方向项。若观感不足，后续再评估月光 BSM（成本敏感，预期不做）
- **月盘 additive 不遮星**：月盘背后的星星透出（月盘远亮于星，无感）；月盘也不写 depth（sky 后处理内，与 lf 的太阳 occlusion 无交互——lf 只看太阳）
- **月相照度简化**：无 opposition surge/月轨偏心，误差被艺术倍率吸收
- **Oren-Nayar 与视星等能量不自洽**（上游同款近似）：视星等 −12.74 是总亮度，Oren-Nayar 只是明暗分布形状，两者相乘是近似——照抄上游，视觉验收把关
- **half-float 精度（重点）**：月盘 radiance ~2.5e-6 量级乘 transmittance 后进 HalfFloat 链——16 位 half 最小正规数 ~6e-5，2.5e-6 **低于之，月盘 radiance 会下溢为 0**。对策方向：月盘亮度域提升（如 `moonRadiance` 默认值设为夜间 tonemap 曝光量级（12）并在乘入处保持相对关系，语义从「物理倍率」调整为「曝光域倍率」），或 sky HDR 链末端对月盘单独缩放——**plan 阶段以实测下溢为准定案**，本节记录风险与两条对策

## 10. 测试策略

- **celestialDirections 单测**（§4.4）：朔望扫描/农历锚/视差量级/连续性
- **shader 编译**：aerialPerspective（MOON 段开/关两态）与 cloudsMain（moon 项）glslang 真编译过（既有 compile test 范式扩展）
- **文本断言**：MOON define 门/nightFactor 复用（moon 项乘同一 smoothstep）/零回归（moon=0 时产物与现状逐字符一致）
- **像素验收**：白天 diff=0、满月/新月对照（demo URL，agent-browser 同批成对录制）
