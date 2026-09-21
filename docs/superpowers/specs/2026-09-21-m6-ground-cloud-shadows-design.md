# M6 地面云影（Ground Cloud Shadows）设计

- 日期：2026-09-21
- 状态：设计定稿（经用户逐节确认），待评审 → writing-plans
- 前身：M6 旧立项（2026-08-04）已随 `worktree-clouds-m6-redo` 分支删除撤销（2026-09-04 拍板），本 spec 基于最新 main（45fd5e1）重新立项
- 关联记忆：phase3-clouds-m1（M6=T3 云投影地面）、project-handoff-2026-09-04、clouds-bsm-world-anchored-cascade

## 1. 背景与目标

体积云 M1-M5 已合并 main：云 march、BSM 级联自阴影（world 锚定）、god rays 光柱（shadowLength 调制天空 inscatter）、时序重建、四档质量预设。唯一缺口：**云对地面的投影**——云飘过时地面/山体上没有影子。

目标：在 atmosphere stage 的 aerial fragment 中，让地面像素采样既有 BSM，把云影折进地表光照，使云影随云移动实时投在地形上。

**非目标**：月光方向云影（BSM 为太阳方向，夜间光强不足，不做）；云影调制天空 inscatter（「阴影里的雾也更暗」，three 亦未做，成本高收益低）；窗口 resize 时 RT 重建排查（独立小项，不入本 spec）。

## 2. 范围拍板（2026-09-21 用户确认）

| 旧 M6 定义项 | 处置 |
|---|---|
| 云影投影到地面（T3） | **本 spec 主体** |
| 地形遮挡云（getRayDistanceToScene 读 globe depth） | 已于 M2 提前接通（surgery 注释 2026-08-14），销案 |
| multi-frustum near 语义复查 | 销案（伪遗留：Cesium log-depth 多视锥缺省已合并 1e9 单段，farToNearRatio 从未被读） |
| T4 resize（窗口 resize 后 RT 重建） | 独立小项待查，不入本 spec |

## 3. 方案对比与决策

**方案 A（选定）：aerial fragment 内直采 BSM**。three-geospatial 原版路径（`HAS_SHADOW` 段）：地面像素→级联选择→PCF→`exp(-光深)`→太阳透射率。复用本地既有 BSM/级联/chunk，每地面像素一遍采样循环，乘子挂点已有。

**方案 B（否决）：独立屏幕空间云影 pass**。多一个全屏 pass + RT 管理，系数本可在 aerial 内一次算出——纯增成本（YAGNI）。

**方案 C（否决）：云 march pass MRT 扩位顺带输出**。链序矛盾——云 march 在 atmosphere 之后（atmo→clouds→lf→tm），地面合成已发生；且在成本最贵的 raymarch 里加工作，方向反了。

**B 路径手术点**（与 three 的唯一结构差异）：three 的 aerial 是「重算照明」路径（`getSunSkyIrradiance` 直接收 `sunTransmittance` 入参）；本仓库 B 路径不重算照明（phase1 A 路径教训），云影转为 `originalColor` 乘子链上的太阳直射份额调制。

**参考库佐证**：navara 不自研云影，包装的 `@takram/three-clouds@0.7.6` 即 three-geospatial 同源——方案 A 在两个主参考库同构，成熟度已验证。navara 增量细节已吸收：`getFadedCascadeIndex` 返回 -1 平滑无影、PCF 半径屏幕像素自适应、shadowFar 钳制防浪费。

## 4. 架构与数据流

一句话：**atmosphere aerial fragment 的地面像素分支采样云 BSM，`exp(-光深)` 乘进地表太阳直射份额**；渲染链序（atmo→clouds→lf→tm）与云侧全部不动。

每帧数据流：

1. `createCloudsStage` preRender：既有 BSM 级联 update/渲染照旧。**扩容点**——`inverseMatrices` 每帧随 matrices 一并 clone（`createCloudsStage.ts:1034` 旁补；数组本体 `:708` 已存在但未填充未导出）；`CloudsShadowFrameState` 增加 `inverseMatrices`、`topHeight`（= `params.shadowTopHeight`，cloudLayersPacking 派生）字段。
2. demo `main.ts`：新增 `groundShadowBridge` 惰性闭包，复刻 `cloudsShadowLengthBridge: () => cloudsShadowBridge?.()` 模式（atmosphere 先建 L441、clouds 后建 L578，闭包后补引用），**零编排改动**。
3. aerial fragment 地面像素：米制世界位置重建 → `getFadedCascadeIndex`（chunk 本地已有）→ vogel disk PCF N 样本 → `exp(-光深)` = `sunTransmittance`。
4. 乘子落地：`mulSunIrr *= sunTransmittance`（见 §6.6），无云像素逐位零回归。

夜晚语义：`mulSunIrr` 含 `max(dot(n,sun),0)`，太阳沉没后归零 → 乘子数学上恒 1，云影自然消失；该归零值同时作**采样短路条件**（§6.7）。月光云影不做。

## 5. 桥接契约

core 侧新增（不 import clouds 包，依赖倒置；core 只定义接口，demo 编排层组装）：

```ts
// AtmosphereStageOptions 新增
cloudsShadowBridge?: () => CloudsShadowBridgeData | undefined

interface CloudsShadowBridgeData {
  bsm: Texture3D              // sampler3D，RGBA = frontDepth / meanExtinction / maxOpticalDepth / maxOpticalDepthTail
  matrices: Matrix4[]         // world(ECEF 米)→light clip ×cascadeCount（world 锚定模式）
  inverseMatrices: Matrix4[]  // clip→world（PCF 半径像素尺度换算用）
  intervals: Cartesian2[]     // 归一化视深切分（按完整视锥 cameraNear→far 归一化）
  cameraNear: number          // BSM split 用的完整视锥 near——采样端级联选择必须与生成端同源
                              //（≠ czm_currentFrustum.x 分段值，CloudsShadowFrameState.cameraNear 注释）
  far: number                 // BSM far（= CascadedShadowMaps.far）
  topHeight: number           // 云壳顶高 m（bottomRadius + topHeight = 射线球求交半径）
  cascadeCount: number        // 档位决定（1-4）
  sampleCount: number         // PCF 样本数（档位决定，≤16）
}
```

- clouds 侧出口：`CloudsStageHandle` 新增 `getGroundShadowBridgeData()`，从 `shadowState` + `cascades` + 当前档位组装；impl destroy 后返回 undefined（handle destroyed 守卫风格）。
- 数组型 uniform 直传 `Matrix4[]`/`Cartesian2[]`——clouds 侧 M3 真机验收过同机制（`CloudsPass.ts:564-565` 先例，PostProcessStage uniforms 同走 ShaderProgram uniformMap）。风险预案见 §8.3。
- uniform 命名对齐 three：`u_shadowBuffer / u_shadowMatrices / u_shadowIntervals / u_shadowCameraNear / u_shadowFar / u_shadowTopHeight / u_sampleCount / u_groundShadowStrength`。

## 6. Shader 设计（aerialPerspective.frag.ts）

### 6.1 宏开关

`HAS_GROUND_SHADOW` define，由 `cloudsShadowBridge != null` 开启（对齐 `cloudsShadowLength` 先例：`buildAerialPerspectiveFragmentShader` options + AtmosphereStage 判定）。采样代码严格限定在**地面相关像素**；天空/太空分支零改动。

### 6.2 世界位置与单位桥

Cesium world 坐标即 ECEF **米**制，与本地 BSM（world 锚定米制）同域，**无需 three 的 `worldToECEF`/`METER_TO_LENGTH_UNIT` 转换**——这是相对 three 的简化。

采样点（米）：`posM = czm_viewerPositionWC + rayDirWC × sceneDistM`。`sceneDist` 已有（depth 重建；aerial 内部 km 量与米制换算在该段内局部完成，**不与 km 制乘子锚点段混用**）。`hasScene=false`（depth 丢失/瓦片未流送）→ 不采样，`sunTransmittance=1`（与既有 fallback 语义一致：无深度区不算前景雾）。

### 6.3 级联选择

复用本地 chunk `getFadedCascadeIndex(viewMatrix, pos, intervals, cameraNear, far, jitter)`（clouds.frag 同款，three 同源移植）：jitter 用 IGN 值（不引 STBN，见 6.5）；返回 -1（级联外/超 far）→ 无影平滑淡出。

### 6.4 光深公式（three 逐字移植，米制无单位换算）

```glsl
// BSM texel: r=frontDepth(g) g=meanExtinction(1/m) b=maxOpticalDepth a=tail
float readShadowOpticalDepth(vec2 uv, float distToTopM, int cascade) {
  vec4 s = texture(u_shadowBuffer, vec3(uv, (float(cascade) + 0.5) / u_cascadeCount));
  // 尾项 a 不加（three 注释：地面影会被 inscatter 衰减，加尾项反而锯齿明显）
  return min(s.b, s.g * max(0.0, distToTopM - s.r));
}
```

`distToTopM` = 沿太阳方向到云壳顶（半径 `bottomRadius + topHeight` 米）的射线第二交点距离；本地缺该函数则从 three 同名 chunk（`raySphereSecondIntersection`）移植。`distToTopM <= 0` 守卫返回 0（three 同款）。注意 `u_shadowBuffer` 为 `sampler3D`（本地 BSM 形态，z 层中心采样 `(cascade+0.5)/cascadeCount`——与 clouds 消费端同款）。

### 6.5 PCF 采样

- vogel disk N 样本 + `interleavedGradientNoise(gl_FragCoord.xy)` 旋转（同一 IGN 值兼作级联 fade jitter）；**不引 STBN**——省跨包纹理依赖（core atmosphere 无 STBN），16 样本+IGN 已是 three 原版画质基准。
- PCF 半径随屏幕像素密度自适应（three `getShadowRadius` 原文移植：BSM clip 空间 2px 偏移经 `inverseMatrices[0]` 反投影回主相机 clip 测像素尺寸 → `remapClamped(size, 10, 50, 0, u_shadowRadius)`，远处自然变软；`u_shadowRadius` 缺省 3 texel）。
- 循环上限编译期常量 16，实际样本数 uniform（见 §7）。

### 6.6 乘子插入点（零回归锚）

现状（`aerialPerspective.frag.ts` groundLightColor 段，2026-09-01 地面光色乘子）：

```glsl
vec3 mulSunIrr = ATMOSPHERE.solar_irradiance * GetTransmittanceToSun(...) * max(dot(mulNormal, sunDirection), 0.0);
vec3 mulSkyIrr = GetIrradiance(...) * (1.0 + dot(mulNormal, mulAnchorKm) / length(mulAnchorKm)) * 0.5;
groundLightColor = max((mulSunIrr + mulSkyIrr) / ATMOSPHERE.solar_irradiance, u_groundNightAmbient);
...
groundLightColor = mix(vec3(1.0), groundLightColor, u_groundLighting);
finalColor = originalColor.rgb * groundLightColor * transmittance * u_groundDim + inscatter * u_inscatterScale(+ moonDisc);
```

云影改动（一行乘法 + 一处采样）：

```glsl
#ifdef HAS_GROUND_SHADOW
float groundSunTrans = 1.0;
// 短路条件：mulSunIrr 太阳直射项已归零（夜晚/背阳坡）→ 乘子数学上恒 1，跳过 16 taps（逐位等价）
if (max(dot(mulNormal, sunDirection), 0.0) > 0.0 && hasScene) {
  groundSunTrans = exp(-sampleGroundShadowOpticalDepth(posM));  // §6.3-6.5
}
mulSunIrr *= mix(1.0, groundSunTrans, u_groundShadowStrength);  // 强度旋钮，缺省 1
#endif
```

- **零回归锚**：`sunTrans=1`（无云/桥关/强度 0/级联外）→ `mulSunIrr` 不变 → `groundLightColor` 逐位不变。
- 阴影里地板 = 天光份额 `mulSkyIrr` + 夜间地板 `u_groundNightAmbient`（物理正确：天空光无方向性，不被云影调制）。
- `groundLighting=0` 诊断逃生门时云影随之归零（外层 `mix(vec3(1),…)` 既有行为，好性质，无需额外处理）。
- `u_groundShadowStrength` 分母侧无新增除法，无新除零点；`GetTransmittanceToSun/GetIrradiance` 消费不动（half-float LUT 相对比值消费，无 A 路径式灾消——同现有乘子的安全性论证）。

### 6.7 短路正确性

`mulSunIrr` 的太阳项在 `max(dot(n,sun),0)=0` 时为 0，`sunTransmittance` 乘 0 仍为 0 → 跳过采样逐位等价（与云侧 P0 夜晚太阳侧门控同语义同论证）。白天向阳地面正常采样。

## 7. 质量档位与 URL 参数

**样本数用 uniform 循环上限，不用 define**：atmosphere stage 先建、clouds 后建，`setQuality` 热切时 define 无法改（PostProcessStage 需整体重建、断链重插）；uniform 方案换档即时生效零重建。

```glsl
const int MAX_GROUND_SHADOW_SAMPLES = 16;
for (int i = 0; i < MAX_GROUND_SHADOW_SAMPLES; ++i) {
  if (i >= u_sampleCount) break;
  ...
}
```

- 档位映射（`qualityPresets.ts` applied 结构新增 `groundShadowSamples`）：low 4 / medium 8 / high 16 / ultra 16（high = three 原版）。
- URL 参数（demo `main.ts` + README 参数表）：`?groundShadow=0`（桥不注入 → define 不开 → 零回归路径）、`?groundShadowStrength=N`（0-1，缺省 1）。
- 诊断：`debug=11` 直显 `groundSunTrans`（灰度 = 云影系数，定位采样/级联问题用；现有编号用到 1-10，顺延）。

## 8. 错误处理与边界

1. **首帧/BSM 未就绪**：atmosphere 侧惰性 1×1 黑 dummy（`appendCloudsShadowLengthUniform` 同款）→ 光深 0 → `sunTrans=1` → 零回归帧；bridge 返回 undefined 同路径。
2. **`clouds=0`**：bridge 恒 undefined → define 不开 → shader 无云影段，完全零回归。
3. **cascadeCount 跨档热切**：GLSL 数组 uniform 编译期定死 → 声明固定 `mat4 u_shadowMatrices[4]` + `u_cascadeCount` uniform（1-4），换档只改 uniform 值。**风险预案**：若 Cesium uniformMap 对 PostProcessStage 侧 `mat4[]` 数组派发有意外（clouds 侧 M3 已验证 VolumetricPrimitive 路径可行，PostProcessStage 同机制，风险低），fallback = 逐元素 `u_shadowMatrix0..3`。
4. **impl destroy 后**：bridge 组装闭包走 handle destroyed 守卫 → undefined → 零回归路径。
5. **远处/级联外**：`getFadedCascadeIndex` 返回 -1 → 无影平滑淡出（navara 报告确认的远距语义）；`distToTopM <= 0` 守卫。
6. **掠射过渡带**：云影乘子只进 `groundLightColor`，DUAL inscatter 的 mask 语义、天空分支、limb fade、夜间天空淡出全部不动。
7. **half-float BSM 精度**：光深量级数百，half 够用（云自阴影同源消费已验收）；采样端只作 Beer 输入，无 inscatter 式灾消结构。
8. **resize**：BSM/矩阵每帧更新无 RT 依赖；atmosphere RT 由 Cesium 随 drawingBuffer 自动处理——本 spec 不新增 resize 敏感点（既有 T4 独立小项不在此）。

## 9. 测试与验收

### 9.1 单测 / glslang（每次改动必过）

1. `aerialPerspective.compile.test.ts` 新增 HAS_GROUND_SHADOW 变体编译用例（glslang 真编译 + 防哑过锚，模式同 `shadowMain.compile.test.ts`）。
2. 乘子性质测试（公式抽 TS 纯函数）：`sunTrans=1` ≡ 现状公式逐位；`sunTrans=0` = 纯天光份额 + 夜地板；短路条件下结果恒等。
3. 桥接单测：`getGroundShadowBridgeData()` 组装（matrices/inverseMatrices 深度 clone、undefined/destroy 守卫）、`CloudsShadowFrameState` 扩容字段、inverseMatrices 每帧填充。
4. `qualityPresets` 四档 `groundShadowSamples` 映射测试。
5. 全量 `pnpm test` + 双包 `tsc --noEmit`（包目录内跑）。

### 9.2 真机验收（纪律全沿用）

- 场景：① 贴地平视山体（云影投山、PCF 软边）② 高空俯瞰云影扫地 ③ 夜晚（无影回归）④ `?groundShadow=0` 对照 ⑤ 云影形状与头顶云形对应性目验 ⑥ 低太阳角（影子拉长为 BSM 投影固有物理，确认无 artifact）。
- 协议：清 `.vite` 缓存重启、`?time=`+`?play=0` 成对钉时间、tilesLoaded **连续保持 5s**、成对 A/B 同扫描、headed 真 Chrome（headless SwiftShader 不可信）。
- 性能：`?fps=1` 同扫描成对帧时，贴地满屏地面 = worst case；`<3ms delta 不可分辨` 纪律（120Hz vsync 量化）。
- 零回归门：`?groundShadow=0` vs main 像素 maxΔ/超差占比 vs 噪声地板（PNG 字节比对无效——dither ±1LSB 纪律）。
- 画质：静止帧噪声水平观感对照 three 原版（16 样本 IGN）；预期 = three 同级。

## 10. 风险与预案

| 风险 | 概率 | 预案 |
|---|---|---|
| PostProcessStage 侧 mat4[] 数组 uniform 派发异常 | 低 | 逐元素 u_shadowMatrix0..3 fallback（§8.3） |
| 16 taps 地面像素帧时超预算 | 中 | u_sampleCount 档位下调即降载（low 4 taps）；无需改结构 |
| 级联 fade jitter 用 IGN 与 clouds 消费端不同源观感差异 | 低 | 地面影与云内影不同屏直比场景少；不一致再对齐 |
| depth 重建位置与 BSM 米制域偏差（高度换算） | 低 | 实现时以 debug 探针直显投影 UV 验证（递进式 debug 方法论） |

## 11. 参考

- three-geospatial：`packages/atmosphere/src/shaders/aerialPerspectiveEffect.frag`（HAS_SHADOW 段：getShadowUv / readShadowOpticalDepth / sampleShadowOpticalDepthPCF / getShadowRadius）、`packages/atmosphere/src/types.ts`（AtmosphereShadow 接口）、`packages/clouds/src/CascadedShadowMaps.ts`
- navara 调查（2026-09-21 子代理报告）：方案同源验证 + 远距淡出/shadowFar 钳制细节
- 本地：`packages/cesium-clouds/src/ShadowPass.ts`（BSM 生成）、`CascadedShadowMaps.ts`（world 锚定级联，matrix/inverseMatrix/interval 已齐）、`createCloudsStage.ts:1034`（每帧矩阵 clone 扩容点）、`aerialPerspective.frag.ts`（groundLightColor 乘子段、cloudsShadowLengthBridge 先例）
- 纪律依据：CLAUDE.md「开发流程」+ 记忆（A/B 测量纪律、验收铁律、vite 缓存坑）
