# M6 地面云影（Ground Cloud Shadows）设计

- 日期：2026-09-21（r2：经 4 路专家评审修订，见 §12）
- 状态：设计定稿（r2），待用户评审 → writing-plans
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

**方案 A（选定）：aerial fragment 内直采 BSM**。three-geospatial 原版路径（`HAS_SHADOW` 段）：地面像素→级联选择→PCF→`exp(-光深)`→太阳透射率。复用本地既有 BSM/级联，每地面像素一遍采样循环，乘子挂点已有。

**方案 B（否决）：独立屏幕空间云影 pass**。多一个全屏 pass + RT 管理，系数本可在 aerial 内一次算出——纯增成本（YAGNI）。

**方案 C（否决）：云 march pass MRT 扩位顺带输出**。链序矛盾——云 march 在 atmosphere 之后（atmo→clouds→lf→tm），地面合成已发生；且在成本最贵的 raymarch 里加工作，方向反了。

**B 路径手术点**（与 three 的唯一结构差异）：three 的 aerial 是「重算照明」路径（`getSunSkyIrradiance` 直接收 `sunTransmittance` 入参）；本仓库 B 路径不重算照明（phase1 A 路径教训），云影转为 `originalColor` 乘子链上的太阳直射份额调制（与 three `sunIrradiance *= sunTransmittance` 逐字同构，只压直射、天光不动）。

**参考库佐证**：navara 不自研云影，包装的 `@takram/three-clouds@0.7.6` 即 three-geospatial 同源——方案 A 在两个主参考库同构，成熟度已验证。navara 增量细节已吸收：`getFadedCascadeIndex` 返回 -1 平滑无影、PCF 半径屏幕像素自适应、shadowFar 钳制防浪费。

## 4. 架构与数据流

一句话：**atmosphere aerial fragment 的地面像素分支采样云 BSM，`exp(-光深)` 乘进地表太阳直射份额**；渲染链序（atmo→clouds→lf→tm）与云侧全部不动。

每帧数据流：

1. `createCloudsStage` preRender：既有 BSM 级联 update/渲染照旧。**matrices 与 inverseMatrices 均已在 changed 分支逐帧 clone 并已作 uniform 消费（createCloudsStage.ts ~:1033-1037，静止帧 changed=false 全跳、值冻结一致——这是桥安全的前提）**。本 spec 只缺一件事：把 `shadowState`（+inverseMatrices、+shellTopRadius）经桥出口导出给 atmosphere。
2. demo `main.ts`：新增 `groundShadowBridge` 惰性闭包，复刻 `cloudsShadowLengthBridge: () => cloudsShadowBridge?.()` 模式（atmosphere 先建 ~L441、clouds 后建 ~L578、桥变量赋值 ~L747，闭包后补引用），**零编排改动**。
3. aerial fragment 地面像素：raw ECEF 米制世界位置重建 → 级联选择 → vogel disk PCF N 样本 → `exp(-光深)` = `sunTransmittance`（域分工见 §6.2，为 r2 修订核心）。
4. 乘子落地：`mulSunIrr *= sunTransmittance`（见 §6.6），无云像素逐位零回归。

夜晚语义：`mulSunIrr` 含 `max(dot(n,sun),0)`，太阳沉没后归零 → 乘子数学上恒 1，云影自然消失；该归零值同时作**采样短路条件**（§6.7）。月光云影不做。

## 5. 桥接契约

core 侧新增（不 import clouds 包，依赖倒置；core 只定义接口，demo 编排层组装）：

```ts
// AtmosphereStageOptions 新增
cloudsShadowBridge?: () => CloudsShadowBridgeData | undefined

interface CloudsShadowBridgeData {
  bsm: Texture3D              // sampler3D，RGBA = frontDepth / meanExtinction / maxOpticalDepth / maxOpticalDepthTail
  matrices: Matrix4[]         // raw ECEF 米→light clip ×4 槽（world 锚定模式；实际级联数见 cascadeCount）
  inverseMatrices: Matrix4[]  // clip→raw ECEF 米 ×4 槽（PCF 半径像素尺度换算用；已逐帧维护，仅导出）
  intervals: Cartesian2[]     // ×4 槽；world 锚定模式 = 绝对视深 / far 归一化（**非** near→far 区间归一化）
  cameraNear: number          // 透传 state.shadow.cameraNear（world 锚定缺省 **0**，createCloudsStage ~:997/1005）
                              // ——禁止采样端自取 camera.frustum.near（r2 纠偏：near 自取会令级联边界漂移数百米）
  far: number                 // 透传 state.shadow.far（world 模式 = intervals 末项，缺省 60km 常数）
  shellTopRadius: number      // 云壳顶球半径（米）= CascadedShadowMaps.shellTopRadius（缺省 6362200）
                              // ——直接供标量，shader 内零加法（r2：规避 aerial ATMOSPHERE.bottom_radius 为 km 的单位陷阱）
  cascadeCount: number        // 实际级联数（现状档位 low=2 / medium/high/ultra=3；数组固定 4 槽留余量）
  sampleCount: number         // PCF 样本数（档位决定，≤16）
}
```

- **altitudeCorrection 不进桥**：aerial fragment 已有同名 per-frame uniform（FRAME_UNIFORMS_GLSL，与 clouds 侧同源 `getAltitudeCorrectionOffset` 逐帧同值）；**其单位/域（clouds 侧为米，见 createCloudsStage ~:849 注释）在实现时以探针核实，若 aerial 版为 km 须 ×1000 后使用**。
- clouds 侧出口：`CloudsStageHandle` 新增 `getGroundShadowBridgeData()`，从 `shadowState` + `cascades` + 当前档位组装；**实现约束：闭包读顶层 impl 引用（setQuality 重建后自动指向新 impl，对齐 `createCloudsStage.ts:1155` 既有注释模式），不得创建期捕获**；impl destroy 后返回 undefined。
- **引用语义（r2）**：preRender 侧已有逐帧快照，桥直接返回引用（数组对象复用）——bridge 闭包每帧每 uniform 求值，逐次深 clone 是无谓 GC 压力。
- 数组型 uniform 直传 `Matrix4[]`/`Cartesian2[]`——**r2 已对照 Cesium 1.143 源码实证**：PostProcessStage 的 function-uniform 与 DrawCommand 共用 `ShaderProgram._setUniforms`（createUniformMap 零包装透传），`mat4[4]`→`UniformArrayMat4` 接受 `Matrix4[]`、`vec2[4]`→`UniformArrayFloatVec2` 接受 `Cartesian2[]`、`sampler3D`→`UniformSampler`（atmosphere 前缀已有 `precision highp sampler3D`）。
- uniform 命名：`u_shadowBuffer / u_shadowMatrices / u_shadowIntervals / u_shadowCameraNear / u_shadowFar / u_shellTopRadius / u_cascadeCount / u_sampleCount / u_groundShadowStrength`。
- `?cloudsShadow=0`（关自阴影）时不建 ShadowPass → bridge bsm=undefined → dummy 路径 → **地面云影连带消失（安全但隐匿；README/spec 双处标注，防止 A/B 自阴影时污染对照）**。

## 6. Shader 设计（aerialPerspective.frag.ts）

### 6.1 宏开关

`HAS_GROUND_SHADOW` define，由 `cloudsShadowBridge != null` 开启（对齐 `cloudsShadowLength` 先例）；采样代码严格限定在**地面相关像素**；天空/太空分支零改动。

### 6.2 世界位置与双域分工（r2 修订核心）

Cesium world 坐标即 raw ECEF **米**制；aerial 内部 Bruneton 量为 **km**（`tHitG`/`sceneDist` 均 km）。距离量 ×1000 后统一在 raw ECEF 米制域重建：

```
posM（raw ECEF 米） = czm_viewerPositionWC + rayDirWC × (sceneDist_km × 1000)
```

（实现可优先复用 aerial 既有米制 ECEF 重建 `worldPos4 = czm_inverseView × eyePos`（~:578，天然继承 5-tap 平滑）；两法等价。已知 micro-caveat：sceneDist 为 5-tap 平均而 hasScene 为中心 tap，深度不连续像素 posM 略偏——PCF 软影掩盖，记录即可。）

**双域分工**（clouds.frag ~:285-300 一手代码裁决；r2 三路评审交叉验证）：

| 用途 | 域 |
|---|---|
| `distToTop` 射线球求交 | **密切球局部系**：`posLocal = posM + altitudeCorrection`，球心=原点、半径=`u_shellTopRadius`（米）——与 clouds march 同域（`cameraPosition = vCameraPosition + altitudeCorrection`，clouds.frag:1009） |
| 级联选择 `getFadedCascadeIndex` + `getShadowUv` | **raw ECEF 米**（posM 直投 `u_shadowMatrices`；矩阵 JS 侧从 raw positionWC 构建） |

照单全收裸 posM 做球求交 = 球心偏 |R_椭球(lat)−6360km|（赤道 ~18km）→ 低纬全球无影、高纬全黑硬影（r2 BLOCKER，反向亦有 cascade/UV 域错位数百米-公里级）。

**hasScene=false 兜底（r2，吸收 mul 直线/depth 灰膜两次同型 artifact 教训）**：不做硬跳过——`discG>0 && !hasScene` 时用椭球交点距离兜底 `posM = czm_viewerPositionWC + rayDirWC × (tHitG_km × 1000)` 继续采样（继承 fore fallback `foreDist = hasScene ? sceneDist : (discG>0 ? tHitG : -1)` 语义），避免瓦片流送窗口边界「影有/无」直线跳变。仅真天空（discG<0）不采样。

### 6.3 级联选择（r2 修订：aerial 局部运行期变体，不逐字复用 chunk）

core chunk `cascadedShadowMaps.glsl` 直接 include 在 aerial 语境**不可行**：顶部 `#error SHADOW_CASCADE_COUNT` 宏守卫、循环体依赖 clouds 侧 `unrollLoops` 预处理（core `resolveIncludes.ts` 无此 pass）、依赖 `viewZToOrthographicDepth`（clouds compatPacking）/`saturate`/`remapClamped`/`PI2` 等 aerial 现有 include 链外的符号。

**方案**：aerial 本地写 ~30 行运行期变体（ES 3.00 plain loop `for (int i=0;i<u_cascadeCount;++i)` 合法），复刻 chunk 语义（区间匹配 + dithered fade + far 上界 + 未命中 -1），只依赖 `core/math` 的 `saturate/remapClamped`（补 include）。uniform 数组仍声明固定 `[4]` 槽（桥恒供满长度值，见 §8.1），运行期循环以 `u_cascadeCount` 为界——空槽永不读取，无 padding 契约负担；另加防御性 `cascadeIndex = min(cascadeIndex, u_cascadeCount-1)`。已知可接受差别：运行期计数使末层 fade 行为与 clouds 端（编译期宏=实际值）有细微差异，同为 dither 淡出，观感无别（r2 明示接受）。

### 6.4 光深公式（three 逐字移植，米制无单位换算）

```glsl
// BSM texel: r=frontDepth g=meanExtinction(1/m) b=maxOpticalDepth a=maxOpticalDepthTail
float readShadowOpticalDepth(vec2 uv, float distToTopM, int cascade) {
  vec4 s = texture(u_shadowBuffer, vec3(uv, (float(cascade) + 0.5) / u_cascadeCount));
  // 尾项 a 不加（three 注释：地面影会被 inscatter 衰减，加尾项反而锯齿明显）
  return min(s.b, s.g * max(0.0, distToTopM - s.r));
}
```

`distToTopM` = §6.2 局部系射线球求交（`raySphereSecondIntersection`，**core 已有**：`packages/cesium-core/src/glsl/raySphereIntersection.glsl` 4-arg 重载、判别式 NaN 安全，core glslIndex 已注册，直接 include；无需移植）。`distToTopM <= 0` 守卫返回 0（three 同款）。`u_shadowBuffer` 为 `sampler3D`，z 层中心采样与本地消费端手术一致（CloudsMaterial.ts ~:403）。

### 6.5 PCF 采样

- vogel disk N 样本 + `interleavedGradientNoise(gl_FragCoord.xy)` 旋转（同一 IGN 值兼作级联 fade jitter）；**不引 STBN**（省跨包纹理依赖；`core/vogelDisk`、IGN chunk 均已在 cesium-core，直接 include）。
- **uv 越界守卫必须移植**（three aerial L192）：`uv` 出 [0,1] → 返回 0——BSM 三轴 CLAMP_TO_EDGE，无守卫则级联侧向越界采边缘 texel 出条纹。
- PCF 半径随屏幕像素密度自适应（three `getShadowRadius` 逐字可移植，r2 核验：`czm_view/czm_projection/czm_viewport` automatic uniform 可用、`inverseMatrices[0]` 经桥可得）：BSM clip 空间 2px 偏移反投影回主相机 clip 测像素尺寸 → `remapClamped(size, 10, 50, 0, u_shadowRadius)`，远处自然变软；`u_shadowRadius` 缺省 3 texel。
- 循环上限编译期常量 16，实际样本数 uniform（§7）。

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

云影改动（一处采样 + 一行乘法）：

```glsl
#ifdef HAS_GROUND_SHADOW
float groundSunTrans = 1.0;
// 短路：太阳直射项归零（夜晚/背阳坡）或 strength=0 → 乘子数学恒 1，跳过全部采样（逐位等价，
// mix(1.0, t, 0.0)=1.0 IEEE 精确）
if (u_groundShadowStrength > 0.0 && max(dot(mulNormal, sunDirection), 0.0) > 0.0) {
  groundSunTrans = exp(-sampleGroundShadowOpticalDepth(posM, posLocal));  // §6.2-6.5
}
mulSunIrr *= mix(1.0, groundSunTrans, u_groundShadowStrength);  // 强度旋钮，缺省 1
#endif
```

- **零回归锚**（r2 红队核验通过，含三个隐含前提，见 §8.1）：`sunTrans=1`（无云/桥关/强度 0/级联外）→ `mulSunIrr` 不变 → `groundLightColor` 逐位不变。
- 阴影里地板 = 天光份额 `mulSkyIrr` + 夜间地板 `u_groundNightAmbient`（物理正确：天空光无方向性不被云影调制；正午阴影内部 ≈15-30% 亮度符合真实云影——r2 物理评审核验）。
- `groundLighting=0` 诊断逃生门时云影随之归零（外层 `mix(vec3(1),…)` 既有行为，好性质）。
- `GetTransmittanceToSun/GetIrradiance` 消费不动（half-float LUT 相对比值消费，无灾消结构）。

### 6.7 短路正确性

`mulSunIrr` 太阳项在 `max(dot(n,sun),0)=0` 时为 0，`sunTransmittance` 乘 0 仍为 0 → 跳过采样逐位等价（与云侧 P0 夜晚太阳侧门控同语义同论证）。`strength=0` 并入短路（r2）。

## 7. 质量档位与 URL 参数

**样本数用 uniform 循环上限，不用 define**：atmosphere stage 先建、clouds 后建，`setQuality` 热切时 define 无法改（PostProcessStage 需整体重建、断链重插）；uniform 方案换档即时生效零重建。

```glsl
const int MAX_GROUND_SHADOW_SAMPLES = 16;
for (int i = 0; i < MAX_GROUND_SHADOW_SAMPLES; ++i) {
  if (i >= u_sampleCount) break;
  ...
}
```

- 档位映射（`qualityPresets.ts` applied 结构新增 `groundShadowSamples`）：**low 4 / medium 8 / high 16 / ultra 16**。口径（r2 纠偏）：three 缺省 `shadowSampleCount=8`、define 上限 16——medium=three 缺省档，high/ultra 取其上限为画质取向（超 three 缺省成本，实测量化后可下调）。
- URL 参数（demo `main.ts` + README 参数表）：`?groundShadow=0`（桥不注入 → define 不开 → 零回归路径）、`?groundShadowStrength=N`（0-1，缺省 1）；并标注 `?cloudsShadow=0` 连带关闭地面云影。
- 诊断：`debug=11` 直显 `groundSunTrans`（灰度=云影系数；现有编号用到 10，顺延空闲）；验收另加 aerial 光深 vs `cloudsDebug=6` 并排比对探针（域/错位定位）。

## 8. 错误处理与边界

1. **首帧/桥未就绪——字段级 dummy 值表（r2 补全；Cesium `_setUniforms` 对 undefined 返回值直接 TypeError 崩帧）**：

   | 字段 | dummy | 效果 |
   |---|---|---|
   | bsm | **1×1×1 全 0 Texture3D**（Texture3D 构造路径，非 shadowLength 的 2D dummy） | 光深 0 → sunTrans=1 |
   | matrices / inverseMatrices | 4× Matrix4.IDENTITY 满长度数组 | -1 路径不消费 |
   | intervals | vec2[4] 零填 (0,0)（区间测试恒假 → **恒 -1**，cascadedShadowMaps.glsl 区间测试已核） | 级联 -1 无影 |
   | cameraNear / far / shellTopRadius | 0 / 1 / 6362200 | -1 路径不消费 |
   | cascadeCount / sampleCount | 0 / 1（u_cascadeCount=0 → 循环不执行 → -1） | 无影 |

   **零回归三个隐含前提（r2 红队钉死，实现必须保持）**：① cascade=-1 早退必须在 `getShadowUv` 之前（identity 矩阵 clip.w=0 → NaN uv，NaN 比较全 false 会穿透 `uv<0||uv>1` 守卫）；② dummy bsm 须 Texture3D 构造（2D dummy 是 shadowLength 先例的 sampler2D 路径，不通用）；③ JS 侧 u_shadowIntervals 缺省零填 vec2[4]。
2. **`clouds=0`**：bridge 恒 undefined → define 不开 → shader 无云影段，完全零回归。
3. **cascadeCount 跨档热切**：数组固定 `[4]` 槽 + `u_cascadeCount` 运行期循环界（§6.3），换档只改 uniform 值。数组 uniform 机制已经 Cesium 源码实证（§5），原「逐元素 fallback」预案撤销——若真异常，本设计恒供满 4 槽天然规避动态索引问题。
4. **impl destroy 后**：bridge 组装闭包走 handle destroyed 守卫 → undefined → 零回归路径；**闭包读顶层 impl（setQuality 重建后自动切换，禁止创建期捕获）**。
5. **远处/级联外**：级联 -1 → 无影平滑淡出；`distToTopM <= 0` 守卫（three 同款）。
6. **掠射过渡带**：云影乘子只进 `groundLightColor`，DUAL inscatter 的 mask 语义、天空分支、limb fade、夜间天空淡出全部不动。
7. **half-float BSM 精度**：光深量级数百，half 够用（云自阴影同源消费已验收）；采样端只作 Beer 输入，无 inscatter 式灾消结构。
8. **resize**：BSM/矩阵每帧更新无 RT 依赖（静止帧冻结一致是既有行为）；atmosphere RT 由 Cesium 随 drawingBuffer 自动处理。
9. **静态帧一致性**：changed=false 时云侧不 clone 不 render，桥返回的矩阵/BSM 为冻结一致快照——桥安全的前提，实现不得在 aerial 侧引入会破坏该前提的异步读。

## 9. 测试与验收

### 9.1 单测 / glslang（每次改动必过）

1. `aerialPerspective.compile.test.ts` 新增 HAS_GROUND_SHADOW 变体编译用例（glslang 真编译 + 防哑过锚，模式同 `shadowMain.compile.test.ts`）；**standalone 校验桩补 `czm_view/czm_viewProjection/textureSize` 桩**（r2：现桩表缺，不补则离线校验编不过）。
2. 乘子性质测试（公式抽 TS 纯函数）：`sunTrans=1` ≡ 现状公式逐位；`sunTrans=0` = 纯天光份额 + 夜地板；`strength=0` 与短路路径恒等。
3. 桥接单测：`getGroundShadowBridgeData()` 组装（引用语义、undefined/destroy 守卫、闭包读顶层 impl）、`CloudsShadowFrameState` 扩容导出、dummy 值表逐字段。
4. `qualityPresets` 四档 `groundShadowSamples` 映射测试。
5. 全量 `pnpm test` + 双包 `tsc --noEmit`（包目录内跑）。

### 9.2 真机验收（纪律全沿用）

- 场景（r2 扩充）：① 贴地平视山体（云影投山、PCF 软边）② 高空俯瞰云影扫地 ③ **云影扫海面**（最低对比+最大平滑，banding 最暴露；r2 结论：非新 artifact 类——乘子 float 平滑+IGN+源头 dither 同缩放，阴影内 8-bit 阶梯相对更显，与既有乘子同级别）④ 夜晚（无影回归）⑤ `?groundShadow=0` 对照 ⑥ 低太阳角（**预期管理：影子极软极粗**——BSM graze march 欠采样 + 长影落粗 texel 级联；**盯影子明暗帧间抖动**）⑦ 晨昏带（twilight boost 下影可见度）⑧ **瓦片流送窗口**（hasScene 兜底边界，重点盯直线 artifact——两次同型前科）⑨ 云影形状与头顶云形对应性目验（含 **aerial 光深 vs cloudsDebug=6 并排**，域错位定位）。
- 协议：清 `.vite` 缓存重启、`?time=`+`?play=0` 成对钉时间（时变内容全确定：天气演化/BSM/太阳）、tilesLoaded **连续保持 5s**、成对 A/B 同扫描、headed 真 Chrome。
- 性能：`?fps=1` 同扫描成对帧时，贴地满屏地面 = worst case；`<3ms delta 不可分辨` 纪律。量级预估（r2 红队推演）：4K 满屏地面 ≈ 8.3Mpx×16 taps，BSM 1.5MB 级 L2 驻留——独显 <1ms、4K 集显 1-3ms，可承受须实测。
- 零回归门：`?groundShadow=0` vs main 像素 maxΔ/超差占比 vs 噪声地板；另加便宜逐位门 **`?groundShadowStrength=0` vs `?groundShadow=0` 等价对照**（r2）。

## 10. 风险与预案

| 风险 | 概率 | 预案 |
|---|---|---|
| ~~PostProcessStage mat4[] 数组 uniform~~ | 已排除 | Cesium 1.143 源码实证 UniformArrayMat4 接受 Matrix4[]（§5） |
| 16 taps 地面像素帧时超预算 | 中 | u_sampleCount 档位下调即降载（low 4 taps）；实测量化 |
| **地面像素无时域吸收**（链上时序重建只覆盖云 RT；IGN 静态噪声无 temporal jitter） | 中 | low=4 样本呈固定结构噪声——§9.2 场景③/⑥专门盯；可选 P5 式运动自适应降载（不强制） |
| 级联 fade jitter 用 IGN 与 clouds 消费端不同源观感差异 | 低 | 地面影与云内影少同屏直比；不一致再对齐 |
| aerial altitudeCorrection 单位/域与 clouds 版不一致 | 低 | 实现时探针核实（§5）；若 km 须 ×1000 |
| depth 重建位置与 BSM 域偏差 | 低 | debug=11 + cloudsDebug=6 并排探针（递进式 debug 方法论） |

## 11. 参考

- three-geospatial：`packages/atmosphere/src/shaders/aerialPerspectiveEffect.frag`（HAS_SHADOW 段；`shadowSampleCount` 缺省 8 上限 16）、`packages/atmosphere/src/types.ts`（AtmosphereShadow）、`packages/clouds/src/CascadedShadowMaps.ts`
- navara 调查（2026-09-21 子代理报告）：方案同源验证 + 远距淡出/shadowFar 钳制细节
- 本地：`packages/cesium-clouds/src/glsl/clouds.frag`（:164 ecefToWorld、:174 getDistanceToShadowTop、:285-300 sampleShadowOpticalDepth 双域分工一手证据、:1009 局部系相机）、`ShadowPass.ts`（BSM 生成）、`CascadedShadowMaps.ts`（world 锚定级联、shellTopRadius）、`createCloudsStage.ts`（~:997 cameraNear=0、~:1033-1037 matrices/inverseMatrices 逐帧 clone、~:823-831 altCorr 更新）、`packages/cesium-core/src/glsl/raySphereIntersection.glsl`（已有）、`packages/cesium-core/src/cesium/aerialPerspective.frag.ts`（乘子段 ~:641-660、hasScene/sceneDist ~:571-589、米制重建 ~:578）
- 纪律依据：CLAUDE.md「开发流程」+ 记忆（A/B 测量纪律、验收铁律、vite 缓存坑、mul 直线/depth 灰膜同型 artifact 前科）

## 12. 评审记录（2026-09-21，4 路并行专家评审）

评审人：GLSL/渲染管线、Cesium 集成、物理/画质、对抗性审查（红队）。全部对照真实代码/Cesium 1.143 源码求证。

**裁决汇总**：

| 级别 | 数量 | 代表条目 | 处置 |
|---|---|---|---|
| BLOCKER | 1 | distToTop 域错误（遗漏 altitudeCorrection，低纬全球无影/高纬全黑） | §6.2 双域分工表 |
| MAJOR | 8 | chunk 复用不可行、cameraNear 契约反语义、dummy 崩帧表、hasScene 直线、级联区间污染、单位陷阱、inverseMatrices 描述反、样本基线失实 | §5/§6.3/§6.4/§8.1/§9 全部吸收 |
| MINOR | ~15 | uv 守卫、include 表、验收场景扩充、strength 短路、文案订正等 | 已吸收或入验收表 |

**关键裁决（评审意见冲突，以一手代码为准）**：distToTop 域归属——physics 路与红队（A1）主张局部系（posM+altCorr）、cesium 路主张 raw ECEF，经 `clouds.frag:285-300/:1009` 亲读裁决：**distToTop=局部系、级联/UV=raw ECEF**（cesium 路实操建议正确、域解释反了）。

**红队未击穿项**（方案信心来源）：零回归数学链（含 3 隐含前提钉死）、三端 packing/topHeight/z 采样同源、时变内容钉法、逃生门语义、乘子挂点自洽。

**红队修正的事实错误**：three `shadowSampleCount` 缺省 8（非 16，16 为 define 上限）；`inverseMatrices` 已逐帧填充（原 spec「未填充」不实）；`raySphereSecondIntersection` core 已有（无需移植）；demo 桥赋值行号 ~L747（原写 L578）。
