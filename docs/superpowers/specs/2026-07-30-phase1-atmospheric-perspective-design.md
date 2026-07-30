# Phase 1 设计：大气透视 MVP（全量复刻 aerialPerspectiveEffect）

> **日期**：2026-07-30（v2，落实 6 专家评审 + 对抗复核）
> **前置**：Phase 0 go/no-go = GO（见 `2026-07-29-phase0-results.md`）
> **目标**：把 Phase 0"只有天空"推进到"大气参与整个场景渲染"——全量复刻源仓库 `aerialPerspectiveEffect`，含大气光照（sun/sky irradiance）+ 透射/内散射 + 法线重建，天空与大气透视合并为单一 PostProcessStage。
> **参考**：`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`（`packages/atmosphere/src/shaders/aerialPerspectiveEffect.frag`、`aerialPerspectiveEffect.vert`、`AerialPerspectiveEffect.ts`）
> **v2 修订说明**：本版经 6 名专家（Bruneton 保真 / Cesium 集成 / 法线重建 / 魔鬼代言人 / 测试验收 / 架构范围）评审 + 对抗复核，落实 9 项确认硬伤与关键 minor。评审原始记录见文末附录 A。

---

## 1. 背景与已验证前提

Phase 0 已钉死四大件，Phase 1 直接复用：

| 已验证能力 | 证据 | Phase 1 复用处 |
|---|---|---|
| bruneton GLSL 注入（Texture3D/struct const/宏替换） | G1 通过 | aerial stage 的 `#include "bruneton/runtime"` |
| 深度→世界坐标（czm 反投影） | G2 通过 | aerial 的地表点/法线重建（**但见 §5 深度路径钉死**） |
| 密切球再中心化（无抖动） | G3 通过 | aerial 的大气局部坐标（相机侧；几何侧为新增，见 §4） |
| 相对亮度 uniform + 曝光/Reinhard | G3 调试记录 | aerial 颜色管线（曝光需重新定标，见 §3.4） |

**新增核心**：源仓库 `aerialPerspectiveEffect.frag` 的三块——`getSunSkyIrradiance`（大气光照）、`applyTransmittanceInscatter`（透射+内散射）、`RECONSTRUCT_NORMAL`（深度重建法线）。

**前提外推警示（评审确认）**：G2 的深度验证是 `fract(worldPos/1e6)` 的 1000km 色环目视冒烟，**不能外推到米级法线精度**；G3 天空验证无 `inputColor` 参与，**不能外推到地表分支**。Phase 1 必须用新的量化验收重新证明（见 §6）。

## 2. 总体架构与渲染管线

单一 Cesium `PostProcessStage` 承载整个大气渲染（天空 + 地表大气透视合并，对齐源仓库单 effect 设计）。

```
[Cesium 渲染 globe/地形/ion 影像] → colorTexture + depthTexture
        ↓
[AtmosphereStage (合并的 PostProcessStage)]
  ① 读原始深度：rawDepth = texture(depthTexture, uv).r
     if (rawDepth >= 1.0 - 1e-8) → 天空分支（先判定，再做任何深度反变换）
  ② 天空分支：GetSkyRadiance（复用 G3，含 GROUND 穿地判定 + 可选 SUN 日盘）
  ③ 地表分支：
     a. 深度 → viewPosition（Cesium eye 系，czm_inverseProjection 反投影；对数深度先 czm_reverseLogDepth）
     b. 法线 = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)))（view 空间求导！）
        → mat3(czm_inverseView) 转 ECEF（w=0 方向变换，忽略平移）
     c. 世界坐标 ECEF（复用 G2）+ 密切球再中心化（几何侧，含 (1-amount) 衰减）→ 大气局部坐标
     d. correctGeometricError：法线与位置都做 mix（sphereNormal 用椭球半径平方反比公式）
     e. GetSunAndSkyIrradiance（太阳+天空照明，用法线；A 路径）
     f. GetSkyRadianceToPoint（透射衰减 + 路径内散射）
     g. 合成：radiance = albedo_linear * albedoScale * RECIPROCAL_PI * (sunIrr + skyIrr)（A 路径）
             radiance = radiance * transmittance + inscatter
        ↓
[色调映射：曝光(uniform) + Reinhard → 显示编码(pow 1/2.2)] → 屏幕
```

**关键架构判断**：全部输入只来自 `colorTexture` + `depthTexture` + 已有 czm uniforms，**不需要 Cesium 渲染任何额外 G-buffer**。法线走 `RECONSTRUCT_NORMAL`（源仓库预留的深度求导路径），绕开"Cesium 无法线缓冲"障碍。**注意**：源仓库主力路径是外部 normalBuffer（`reconstructNormal` 默认 false），`RECONSTRUCT_NORMAL` 是无 MRT 的降级 fallback——本移植被迫全量走降级路径，剪影/深度不连续处会有伪法线亮边（源仓库同源的已知问题，见 §6 R-P1-1）。

## 3. 核心矛盾解法：A 路径拿到"干净 albedo"

**矛盾**：源仓库把 `inputColor` 当线性反照率 albedo（three.js 场景不发光、线性管线），用大气重算照明；Cesium 默认把**已照亮、已加雾、display-referred sRGB** 的颜色塞进 `colorTexture`，直接套会"二次光照 + 双重大气 + 色彩空间断裂"三重错误。

**决策（用户拍板）**：**A 为主、保留 B 为对照开关**。

### 3.1 A 路径（主）：让 colorTexture 接近线性 albedo

需要**同时**关闭 Cesium 的三处内建贡献（评审确认缺一不可）：

| 开关 | 值 | 为什么 |
|---|---|---|
| `scene.globe.enableLighting` | `false` | 去掉 Cesium 的 Lambert 地形光照 |
| `scene.globe.showGroundAtmosphere` | `false` | **评审确认 critical**：默认 true（WGS84），GlobeFS 的 GROUND_ATMOSPHERE 分支会把 Cesium 自己的 Rayleigh/Mie 雾霾 + 曝光 tonemap 叠加进地表 → 双重大气 |
| `scene.fog.enabled` | `false` | **评审确认**：近地面 FOG 分支以 groundAtmosphereColor 做雾混合，独立于 enableLighting |
| `scene.skyAtmosphere/skyBox/sun/moon .show` | `false` | 延续 Phase 0（避免与本 stage 天空分支重叠） |

然后由大气 stage 用 `SUN_LIGHT`+`SKY_LIGHT` 统一打光：
```
radiance = albedo_linear * albedoScale * RECIPROCAL_PI * (sunIrradiance + skyIrradiance)
```
（Lambertian BRDF 假设，`RECIPROCAL_PI = 0.3183098861837907`，需在 prefix 或 frag 头部 `#define`——cesium-core 的 `buildAtmospherePrefix` 与 `glsl/math.glsl` 均无此定义，照抄源码会编译失败。）

### 3.2 色彩空间（评审确认 critical，单列小节）

Cesium 默认 `scene.highDynamicRange=false`，此模式下：
- `czm_gammaCorrect` 是 no-op（仅 `#ifdef HDR` 才 pow），影像 **sRGB 编码值原样**进 `colorTexture`（UNSIGNED_BYTE，非硬件解码）。
- 即使开 HDR，Cesium 内建 tonemapping stage（ACES+inverseGamma）在**用户 stage 之前**执行，`colorTexture` 仍是 display-referred。

因此 AtmosphereStage 必须在 shader 内做色彩空间闭环：
- **输入端**：`albedo_linear = pow(inputColor.rgb, vec3(2.2))`（sRGB EOTF 反伽马）再当 albedo。标量 albedoScale 无法补偿 2.2 曲线，必须显式反伽马。
- **输出端**：色调映射后 `out_FragColor = vec4(pow(color, vec3(1.0/2.2)), 1.0)`（显示编码），因为 postProcess 末端的 PassThrough 直接上屏、无 gamma 编码。

**已知局限（评审确认，源仓库 README 同样承认）**：ion/Bing 正射影像在固定太阳角（近正午）拍摄，山体阴影与大气程辐射**已烘焙进像素**。A 路径用重建法线 `dot(N,L)` 再照明，晨昏时大气说"该暗"、影像烘焙阴影说"是正午亮面"——这是**固有 tradeoff**，用 albedoScale 缓解，验收措辞需注明"影像烘焙光照除外"（见 §7）。

### 3.3 B 路径（兜底/对照）

不定义 `SUN_LIGHT`/`SKY_LIGHT`，只套 `radiance = inputColor * transmittance + inscatter`。地表保留 Cesium 光照（B 路径下 `enableLighting` 应设回 `true`，否则退化为无光照平涂+雾，与定义矛盾——评审确认）。用于关不掉光照的 3D Tiles 场景及 A/B 对比。

### 3.4 A/B 切换机制（评审确认）

`PostProcessStage.fragmentShader` 只读，`SUN_LIGHT`/`SKY_LIGHT` 等是编译期 define，**运行时无法切换**。封装 `setMode()`：销毁旧 stage + `new` 一个（会重编译 + 重新 resolveIncludes），并**同步切换** `globe.enableLighting` / `showGroundAtmosphere` / `fog` 的状态矩阵。仅 `albedoScale`、`exposure` 等纯数值项走运行时 uniform。

**A/B 路径场景开关状态矩阵**：

| 开关 | A 路径 | B 路径 |
|---|---|---|
| `globe.enableLighting` | `false` | `true` |
| `globe.showGroundAtmosphere` | `false` | `false`（仍防双重大气） |
| `scene.fog.enabled` | `false` | `false` |
| stage 宏 | `SUN_LIGHT`+`SKY_LIGHT`+`TRANSMITTANCE`+`INSCATTER` | `TRANSMITTANCE`+`INSCATTER` only |

### 3.5 色调映射（认领 Phase 0 待办）

Phase 0 待办 4 明确"替换占位 Reinhard，对齐源仓库 exposure"，本 Phase 认领：
- 曝光从硬编码 `3.0` 提为 **uniform + options 字段**（URL 可调），加入地表分支后**重新定标**（天空 radiance 与地面 irradiance×albedo/π 同源同尺度，单一曝光理论可行，但占位值 3.0 只对天空定过标）。
- 色调映射**内联**在 AtmosphereStage main 末尾（省一个 full-screen pass），结构：线性 → 曝光 → Reinhard → 显示编码。
- 天空渐变在 RGBA8 输出下可能 banding（源仓库用 HalfFloat + 专用 ToneMapping stage），列为已知项，验收时记录。

## 4. 组件拆分与文件结构

### `packages/cesium-core/src/`（可测）

- **`cesium/aerialPerspective.frag.ts`** — 移植 `aerialPerspectiveEffect.frag` 主体 + 天空分支（含 sky.glsl 的 `getSkyRadiance` 包装）。复用 `buildAtmospherePrefix()` + bruneton runtime。头部补 `#define RECIPROCAL_PI`。色彩空间闭环（输入反伽马/输出编码）也在此。
- **`cesium/normalReconstruction.ts`** — `RECONSTRUCT_NORMAL_GLSL`：**view 空间**求导 `normalize(cross(dFdx(vp), dFdy(vp)))`（vp 由 `czm_inverseProjection` 反投影得，对数深度先 `czm_reverseLogDepth`），`mat3(czm_inverseView)` 转 ECEF。含深度间断处 `cross` 近零的回退守卫（回退球面法线 `normalize(positionECEF)`），防 NaN。配 CPU 单测——**定性：只验证 cross/归一化/ECEF 变换的数学正确性与组装，不验证 GPU 导数精度**（精度风险归浏览器验收）。
- **`cesium/AtmosphereStage.ts`** — `createAtmosphereStage(scene, luts, options)` + `setMode()`。uniforms 见 §4.1。options 形状见 §4.2。

### `apps/demo/src/`（接线 + 验证）

- **`main.ts`** — 新增 `?mode=atmosphere`。接入 ion 影像 + 全球地形（token 走环境变量/URL，不入库；失败 fallback 裸 globe + console 告警）。按 §3.4 状态矩阵设 A/B 开关。**新增 URL 参数**（评审确认 critical，为可复现验收）：`time`/`sunElevation`/`sunAzimuth`（绕过墙钟固定太阳）、`camera`（固定经纬度/高度/朝向）、`albedoScale`、`exposure`、`mode-ab`（A/B）。保留 `?mode=sky|depth` 作回归对照。
- **`public/luts/`** — `higher_order_scattering.bin` **本 Phase 不拷**（评审确认 YAGNI：无 CSM 阴影时 shadowLength 恒 0，该纹理数学上是 no-op 且需 `HAS_HIGHER_ORDER_SCATTERING_TEXTURE` define；推迟到 Phase 2 阴影）。

### 旧代码处置

`SkyStage`/`skyStage.frag`（Phase 0 天空）保留作 `?mode=sky` 回归对照，不删。其天空逻辑并入 `AtmosphereStage` 天空分支——注意 `SkyStage` 在 `apps/demo`、`AtmosphereStage` 在 `packages/cesium-core`，**不跨包复用 uniforms 同步逻辑**，而是把每帧 preRender 的太阳方向 + altitudeCorrection 计算下沉到 `AtmosphereStage`（cesium-core）内聚，`SkyStage` 逐步退化（评审确认，避免双份维护）。

### 4.1 AtmosphereStage uniforms 清单（命名对齐源仓库）

| uniform | 类型 | 来源 | 备注 |
|---|---|---|---|
| `sunDirection` | vec3 | preRender 每帧（Simon1994 + ICRF→Fixed） | 复用 G3 |
| `altitudeCorrection` | vec3 | preRender 每帧（密切球） | 复用 G3 |
| `SUN_SPECTRAL_RADIANCE_TO_LUMINANCE` / `SKY_SPECTRAL_...` | vec3 | 相对亮度常量 | 复用 G3 |
| `transmittance_texture` / `scattering_texture` / `single_mie_scattering_texture` / `irradiance_texture` | sampler | LUT | 复用 G3 |
| `albedoScale` | float | options/URL | 默认 1.0 |
| `exposure` | float | options/URL | 重新定标（起点 3.0） |
| `bottomRadius` | float | `ATMOSPHERE_BOTTOM_RADIUS_M * METER_TO_LENGTH_UNIT` | |
| `geometricErrorCorrectionAmount` | float | **CPU 每帧计算**（见 §5） | **命名对齐源仓库**（非 correctGeometricErrorAmount） |
| `ellipsoidRadii` | vec3 | `scene.globe.ellipsoid.radii * METER_TO_LENGTH_UNIT` | correctGeometricError 的 sphereNormal 用（椭球半径平方反比） |
| `cosSunAngularRadius` | float | `cos(SUN_ANGULAR_RADIUS)` | SUN 日盘抗锯齿用 |
| `u_debugMode` | float | URL | 延续 Phase 0 诊断 |

### 4.2 options 形状与宏组合枚举

```ts
interface AtmosphereStageOptions {
  sunLight?: boolean        // A 路径：SUN_LIGHT（默认 true）
  skyLight?: boolean        // A 路径：SKY_LIGHT（默认 true）
  transmittance?: boolean   // TRANSMITTANCE（默认 true）
  inscatter?: boolean       // INSCATTER（默认 true）
  sun?: boolean             // SUN 日盘（默认 true）
  ground?: boolean          // GROUND 穿地判定（默认 true，对齐源 ground:true）
  correctGeometricError?: boolean // CORRECT_GEOMETRIC_ERROR（默认 true）
  sky?: boolean             // SKY 天空分支存在性（默认 true；false 时远平面直通 inputColor）
  albedoScale?: number
  exposure?: number
}
```

**合法宏组合枚举**（非法组合在 `createAtmosphereStage` 入口显式报错）：

| 组合 | 宏 | 用途 |
|---|---|---|
| A 路径（默认） | `SUN_LIGHT`+`SKY_LIGHT`+`TRANSMITTANCE`+`INSCATTER`+`SUN`+`GROUND`+`CORRECT_GEOMETRIC_ERROR`+`SKY`+`RECONSTRUCT_NORMAL` | 全量大气 |
| B 路径 | `TRANSMITTANCE`+`INSCATTER`+`SUN`+`GROUND`+`SKY`（无 SUN_LIGHT/SKY_LIGHT） | 对照/3D Tiles |
| 调试：仅透射 | `TRANSMITTANCE` only | 隔离验证 |
| 调试：仅内散射 | `INSCATTER` only | 隔离验证 |

**alpha 语义**（评审确认）：地表分支 `out_FragColor = vec4(color, inputColor.a)`，天空分支 `alpha = 1.0`。

## 5. 深度路径与 correctGeometricError（钉死）

### 5.1 深度路径（评审确认 major）

Phase 0 用 `logarithmicDepthBuffer=false` 单视锥回避多视锥，但 Phase 1 是全球地形（太空视角 far 需 ~1e8m），单视锥远处地形深度精度极差 → 法线/透射端点噪声。**决策：启用对数深度 `logarithmicDepthBuffer=true`**，重建前必须 `czm_reverseLogDepth`（对应源仓库 reverseLogDepth），否则 viewPosition 全错。

- **天空判定**：对 `depthTexture` **原始采样值**判 `rawDepth >= 1.0 - 1e-8` 进天空分支，**先于** `czm_reverseLogDepth`（log 深度下 depth=1.0 映射成远平面有限 windowZ，先反转再判会引入边界误差）。
- **`czm_currentFrustum` 禁用**：post 阶段它只反映最后渲染的视锥，对远片段线性化是错的（评审确认）。深度线性化改走对数深度 + `czm_reverseLogDepth`。
- 参考实现：Cesium 内建 `AmbientOcclusionGenerate.glsl` 的 `pixelToEye`（含 `depth>=1.0` 时远平面保护），可作重建参考。

### 5.2 correctGeometricError（评审确认 major，补全三处耦合）

源仓库该机制有三处耦合，spec v1 全漏，必须补齐：

1. **`geometricErrorCorrectionAmount` 每帧 CPU 计算**（源 `AerialPerspectiveEffect.ts:352-366`）：
   ```
   cameraHeight = 相机椭球高（positionCartographic.height）
   projectedScale = projectionMatrix * vec3(0, ellipsoid.maximumRadius, -max(0, cameraHeight))
   amount = saturate(remap(projectedScale.y, 41.5, 13.8, 0, 1))
   ```
   **评审确认**：41.5/13.8 是绑定 three.js 投影 + PR#23 标定的 magic number，**Cesium 默认 FOV 60°（three 50°）下需重新标定**——clip y 含 `1/tan(fov/2)`。实现时复刻公式结构，常数按 Cesium 投影重新定标；若标定困难，Phase 1 可固定 `amount` 按高度分段（近地≈0 保地形法线、太空≈1 压噪声），并把标定列为验收项。
2. **`vGeometryAltitudeCorrection *= (1 - amount)`**（源 vert:48-55，PR#23：理想球面上高度校正会过度校正）。Cesium 无自定义顶点 shader，此衰减**移入 fragment**（对几何侧 altitudeCorrection 预乘 `(1-amount)`）。
3. **法线与位置同时 mix**（源 frag:96-99）：`sphereNormal = normalize(positionECEF / ellipsoidRadiiSquared)`、`spherePosition = bottomRadius * sphereNormal`，`positionECEF = mix(positionECEF, spherePosition, amount)`、`normalECEF = mix(normalECEF, sphereNormal, amount)`。位置变化影响后续 `GetSunAndSkyIrradiance` 的 r/mu_s 和 `GetSkyRadianceToPoint` 查询，**两个量都必须 mix**（spec v1 只提法线）。

### 5.3 几何位置的单位换算与再中心化（评审确认 minor，补公式）

相机/几何两侧顺序不对称（源 vert:45 vs frag:331），写错会在高空产生错误的 r 与 transmittance：
- 相机侧（G3 已验证）：`cameraPos_km = (cameraECEF_m + altitudeCorrection_m) * METER_TO_LENGTH_UNIT`
- 几何侧（Phase 1 新增）：`position_km = worldECEF_m * METER_TO_LENGTH_UNIT + altitudeCorrection_m * METER_TO_LENGTH_UNIT * (1 - amount)`

## 6. 风险与应对

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| R-P1-1 | 法线重建精度：view 空间求导在远处/地形边缘有噪声；剪影/深度不连续处伪法线亮边（源仓库同源已知问题）；地平线处 amount≈0 无保护 | **高**（评审上调） | correctGeometricError 球面 mix（§5.2，太空 amount≈1 压制）；深度间断回退守卫；验收拆分"太空 limb（amount≈1 应干净）"与"地面地平线（允许噪声，源仓库同源）"两条 |
| R-P1-2 | 关光照后画面偏平；色彩空间断裂（sRGB 当线性） | 高 | §3.1 完整开关 + §3.2 反伽马/编码闭环；albedoScale/exposure URL 可调 |
| R-P1-3 | B 路径大气照明与 Cesium 光照并存，日落不一致；ion 影像烘焙光照与法线再照明冲突 | 已知 | B 定位对照/兼容；影像烘焙光照为源仓库同源固有 tradeoff，§7 验收注明"烘焙光照除外" |
| R-P1-4 | ion token 与资产加载依赖网络 | 低 | token 走环境变量/URL 不入库；失败 fallback 裸 globe + console 告警（验收含错 token 用例） |
| R-P1-5 | ~~higher_order_scattering 3D LUT~~ | 已推迟 | 无 CSM 阴影时数学 no-op，推迟到 Phase 2（评审确认 YAGNI） |
| R-P1-6 | 天空与大气透视 stage 边界 | 已决 | 合并为单一 stage（用户拍板）；天空判定用原始 depth（§5.1），避免边界接缝 |
| R-P1-7 | 跨视锥深度分段不连续 → 重建位置阶跃 → 法线接缝 | 中 | 对数深度 + `czm_reverseLogDepth`（§5.1）；验收含视锥边界检查 |
| R-P1-8 | 深度间断/退化 quad → `normalize(cross(0,0))` = NaN 像素 | 中 | cross 长度 < ε 回退球面法线；验收加全屏 NaN/Inf 检测 |
| R-P1-9 | 夜半球全黑（irradiance≈0）——与 Cesium 默认影像常显体验不同 | 已知 | §7 写明夜半球预期外观（必要给 ground 环境光下限） |

## 7. 测试策略与成功标准（评审确认 critical，全面量化）

### 7.1 单测（node，vitest）

- `normalReconstruction.test.ts` — CPU 重实现的数学正确性（cross/归一化/ECEF 变换）+ 退化输入（平行/零向量导数）回退分支。**不验证 GPU 导数精度**（定性注明）。
- `aerialPerspective.frag` 组装测试 — **改断言目标**（评审确认）：断言移植代码的**调用点**在正确宏组合下出现/消失（如 SUN_LIGHT 开/关时 shader 文本含/不含 `getSunSkyIrradiance(` 调用、`applyTransmittanceInscatter(` 调用），而非 bruneton 固有函数签名（恒真、测的是错误的东西）。
- **GLSL 编译验证**（评审确认 critical，二选一或并用）：①引入 `glslangValidator`（或 `@shaderfrog/glsl-parser`）对展开后的 shader 做解析级校验，覆盖 §4.2 全部合法宏组合；②demo 内置浏览器编译冒烟（每种合法宏组合实例化 stage 渲染一帧，监听 errorEncountered）。
- uniform 接线一致性测试：从组装后 shader 文本正则提取 uniform 声明集合，与 `createAtmosphereStage` 的 uniforms 键集合做差集断言（czm_* 白名单），抓拼写错误/漏传。
- LUT 资产校验：断言 `public/luts/*.bin` 存在且字节数符合维度（宽×高×深×通道×2 字节），防拷错/LFS pointer/拷贝漏配。

### 7.2 浏览器验收（项目方跑，可复现 + 量化）

**前置**：demo 加 URL 参数 `time`/`sunElevation`/`sunAzimuth`/`camera`（固定太阳与位姿），使每个用例一键复现；验收记录 = 固定 URL + 截图 + 量化采样，存档到 `docs/superpowers/specs/` 旁验收目录（格式参照 Phase 0 results）。

**可量化判据**（readPixels / 截图像素分析代理断言）：

| 用例 | 量化判据 |
|---|---|
| 远山雾化（A 路径） | 远距离采样带 B/R 比 > 近距离带 |
| 光照随太阳一致 | 向阳坡平均亮度 > 背阳坡；太阳高度角 20°→0° 时地表 R/B 比单调上升（**影像烘焙光照除外**——选平坦/低起伏区验证） |
| 天空/地表无缝衔接 | 地平线扫描线相邻像素最大梯度 < 阈值 |
| 太空视角 | 相机 20000km 固定 pose，地球 limb 大气辉光弧连续、法线噪声在 amount≈1 下干净 |
| NaN/Inf 防护 | 全屏无异常 0/极值像素（浮点帧缓冲或色调映射前 debug 输出检测） |
| A/B 对比 | A 路径地表亮度随太阳角变化、B 路径不变化（验证 A 未静默退化成 B） |
| 双重大气检查 | 开关 `showGroundAtmosphere` 前后截图对比，确认无叠加雾 |
| 法线可视化（debug） | `?debug=4` 输出 `normalECEF*0.5+0.5`，对照赤道/极点/斜坡朝向目检 |
| Phase 0 回归 | `?mode=sky`/`?mode=depth` 不劣化；**新合并 stage 天空分支与 Phase 0 天空截图对比**（建立基线） |
| 夜半球 | 夜侧外观符合 §6 R-P1-9 预期，非全黑到无法辨识 |
| 性能 | 1080p 下 `mode=atmosphere` 相对无 stage 基线帧率下降 < 30%（记录项） |

### 7.3 成功标准

1. `?mode=atmosphere` 下 ion 影像+地形场景呈现正确大气透视，满足 §7.2 全部量化判据。
2. 天空与地表在同一 stage 内无缝衔接，地平线与太空视角均正确（地平线扫描线梯度 + 太空辉光弧判据）。
3. 单测全过（含 GLSL 编译验证 + uniform 接线）、浏览器量化验收通过、A/B 可切换且行为差异符合 §3.4。
4. 不破坏 Phase 0 已有 `sky`/`depth` 模式，新 stage 天空分支不劣化于 Phase 0 天空。

## 8. 非目标（YAGNI，本 Phase 不做）

- **CSM 阴影（`HAS_SHADOW` 分支）、lightingMask、overlayBuffer**——依赖额外 G-buffer，留待 Phase 2。（源仓库无阴影时 `sunTransmittance=1.0`，即无地形自投影；Cesium 原生地形光照同样无自阴影，相对 Cesium 基线零回归——评审确认，不构成问题。）
- **体积云（clouds）**——Phase 3。
- **星空/月亮 billboard**——后续可选。
- **太阳圆盘（SUN 日盘）**：源仓库默认开启（`sun:true`），排除会"直视太阳无日轮"。**本 Phase 纳入**（成本极低：~10 行 GLSL + `cosSunAngularRadius` uniform + `fragmentAngle` 抗锯齿），宏表加 `SUN`。月亮（MOON）仍排除。
- **地平线地面反弹（GROUND_ALBEDO 分支，来自 sky.frag 而非 aerialPerspectiveEffect）**——本 Phase 不做；如后续需要单独立项（注意 sky.frag:70 疑似把 cameraPosition 而非 groundPosition 传给 GetSunAndSkyIrradiance，移植时需决断）。
- **WebGPU 路径**——本移植只针对 WebGL2/Cesium。

---

## 附录 A：评审记录摘要

6 名专家评审（Bruneton 保真 / Cesium 集成 / 法线重建 / 魔鬼代言人 / 测试验收 / 架构范围），28 条 critical/major 发现经对抗复核：18 条确认成立、10 条被驳回，另 27 条 minor/nit。本版（v2）落实全部确认的 critical/major 与关键 minor。

**被驳回的质疑（供参考，知所不必担心）**：
- "多视锥下 depthTexture 只剩最近视锥深度、远山被天空吃掉"（强形式）——经本人核实 Cesium `executeCommands`/`GlobeDepth` 源码：深度从远到近逐视锥累积进同一 depth-stencil texture、深度测试保证最近表面胜出，最终 depthTexture 含全部视锥合并深度。**不成立**。但其引出的跨视锥重建精度 + `czm_currentFrustum` 误用为真实 major，已并入 §5.1/R-P1-7。
- "CSM 阴影划非目标的视觉代价"——阴影缺失不违反任何成功标准，且 Cesium 原生地形光照同样无自阴影（零回归），驳回。
- "天空判定边界、CPU 单测覆盖不全、A/B 通过定义为空、Phase 0 回归无基线、B 路径 3D Tiles 无验收、SkyStage 跨包双份维护、宏组合欠定义、uniform 命名漂移"——部分被驳回为 minor，已并入对应章节（§3.4/§4/§7）。
