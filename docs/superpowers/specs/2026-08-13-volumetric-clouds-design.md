# 体积云（Phase 3）设计文档

> **状态**：r1（经三专家评审修订——4 critical + 3 important + 7 should-fix，附录 E 修订表），待用户审 → writing-plans
> **日期**：2026-08-13（r0）/ 2026-08-13 r1（评审修订）
> **参考库**：`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`（`@takram/three-clouds` v0.7.6，算法/技术主参考）
> **关联**：
> - 总计划 `docs/superpowers/specs/2026-07-29-cesium-geospatial-port-design.md` §4 Phase 3
> - god rays 失败记忆 `.claude/projects/.../memory/godRays-tyndall.md`（体积云=换 occluder 复活 god rays；缺 higher-order LUT 致过暗的教训）
> - 现有大气 `packages/cesium-core/src/cesium/AtmosphereStage.ts`

---

## 1. 决策摘要

| 决策点 | 选择 | 说明 |
|---|---|---|
| **C1 范围** | 完整 Phase 3 | 云自阴影 + 云投影地面 + 地形遮挡云 + 云驱动 god rays |
| **C2 交付路线** | 逐 pass 增量，6 阶段 | 每 milestone 可视觉验收；非 spike、非一次性 |
| **C3 包结构** | 独立成包 `packages/cesium-clouds` | 遵循 master plan §3.1；基建放 core 供复用 |
| **C4 基建** | 自建"迷你 Three"层（FullscreenPass + FramebufferManager） | 解决 Cesium 无 MRT / 无 2D_ARRAY 封装 |
| **C5 atmosphere 桥接**（r1 修订） | **god rays 在云 shader 内完成**（clouds 包 `#include` core bruneton runtime，对云前表面调 `GetSkyRadianceToPoint`）；atmosphere stage **不消费 cloudsBuffer** | 评审 critical #1：原"喂 atmosphere shadow_length 钩子"路线被证伪（sky 分支硬编码 0.0 + 语义不匹配）。云 god rays 完成于云 shader，atmosphere god rays 路径零改动。**云投影地面**是唯一需 atmosphere 侧改动的项 |
| **C6 MRT 实现**（r1 修订） | 倾向 **custom Primitive**（Pass 排 globe 后/PostProcess 前，渲染进 scene FBO 天然有 depth），自管 DrawCommand + 裸 WebGL2 为备选 | 评审 critical #4：原"自管 RT 插 PostProcessStage 链中间"无先例（historyBlit 是 postRender 事后 blit），plan B（拆多 stage 3× raymarch）性能不可用 = 无 viable backup。M1 spike 验 Primitive/自管 RT 两条路 |
| **C7 平台** | WebGL2（Cesium 原生 context） | 无 WebGPU，无 compute |
| **C8 god rays 实现位置**（r1 新增） | 云 shader 内 `applyAerialPerspective`（复刻 `clouds.frag:701`），cloudsBuffer 作 overlay 合成在 atmosphere **之后** | 三专家共识：原"喂 atmosphere stage 钩子"路线错（见 §2.2） |
| **C9 higher-order scattering LUT**（r1 新增，用户决策） | 预计算第 4 张 `higher_order_scattering` LUT + `cesiumCore.ts` 加 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE` | 评审 critical #2：缺此 LUT，shadow_length>0 必走 `runtime.glsl:354-356` 把 single+多阶全扣 → 精确复现 phase2c「过暗黑」 |

**核心判断**：体积云的 shadow 链**不撞 god rays 当年的死局**——BSM 是云自身程序化密度场（sun-POV 全屏 raymarch，零场景几何），云投影地面/地形遮挡云只读 `depthTexture`。**但 god rays 的实现位置不是"喂 atmosphere 钩子"**（评审证伪），而是在云 shader 内完成。真正工程量集中在 **MRT/2D_ARRAY 基建 + 云 shader 桥接 core Bruneton + higher-order LUT 预计算**。

---

## 2. 调研结论（可行性依据）

### 2.1 shadow 链不撞墙（4 效果的 shadow 源）

来自 three-geospatial clouds 包 Explore 调研 + 三专家源码核实（2026-08-13）：

| 效果 | 机制（r1 修订） | shadow 源 | 可行性 |
|---|---|---|---|
| **云自阴影** | `ShadowPass` sun-POV 全屏 raymarch 云密度 → BSM → Beer-Lambert + powder | 云自身程序化密度（`shadow.frag:147`，`shadow.vert` 全屏三角**无几何输入**） | ✅ 全屏 raymarch + WebGL2 2D_ARRAY |
| **云 god rays**（r1 修订） | **云 shader 内** `applyAerialPerspective`（`clouds.frag:701`）对云前表面调 `GetSkyRadianceToPoint(shadow_length)`；`marchShadowLength`（`clouds.frag:622`）沿视线累加 BSM | BSM（云自身） | ✅ 不依赖地形 shadow map；**不走 atmosphere stage**（评审 critical #1） |
| **云投影地面**（r1 修订） | **B 路径 hack**：`originalColor.rgb *= exp(-sampleShadowOpticalDepth(groundPosECEF, BSM))` 减暗地面 | BSM + globe `depthTexture`（重建地形 ECEF） | ✅ 需 atmosphere 加 BSM 采样 uniform（非零改动，见 §6 M6） |
| **地形遮挡云** | `clouds.frag:846 getRayDistanceToScene()` 用主相机 depth 截断云 raymarch 远端 | `depthTexture`（需 log-depth→线性转换，评审 important #7） | ✅ 需 log-depth 处理 |

> **r1 删除**：原 §2.1 引用 three 版 `aerialPerspectiveEffect.frag:354`（"调制 sun/sky irradiance"）属概念混淆——该文件是 three-geospatial **atmosphere 包的 A 路径文件**（含 irradiance），本项目是 B 路径（`aerialPerspective.frag.ts:9-12/504` 明确删了 irradiance，`finalColor = originalColor·transmittance·u_groundDim + inscatter`，无 irradiance 项）。B 路径下云投影地面唯一可行 = hack 减暗 originalColor。

### 2.2 atmosphere 钩子（r1 重大修订）

**r0 声称**（已被评审证伪）：云 BSM 经 marchShadowLength 产出 shadowLength 喂 atmosphere stage 的 `shadow_length` 钩子（`aerialPerspective.frag.ts:455/475`），"零 atmosphere 改动"。

**r1 修正**（三专家共识，critical #1）：此路线有三处致命矛盾：
1. **sky 分支硬编码 0.0**：`aerialPerspective.frag.ts:313` `getSkyRadiance(..., 0.0, ...)` 第三参是字面量 0.0（非 uniform）。god rays 在天空像素最显著，而 sky 分支 shadow_length 恒 0 → 永远不产生 god rays。
2. **Bruneton sky 语义不匹配**：`runtime.glsl:179-213` sky 版 `shadow_length` 表示"从 view ray 末端（大气顶方向）回退 N 米的 scattering 被忽略"，即 occluder 在视线**末端**。但云在大气**中部**（750-7500m），塞进去会让"大气顶回退 N 米"，物理 wrong。
3. **`marchShadowLength` 语义 ≠ Bruneton Eq.17**：物理专家核实——`marchShadowLength` 是视向 opacity 加权积分，仅在 `clouds.frag:701 applyAerialPerspective` 内（point=云前表面）自洽；喂 atmosphere stage（point=地形）语义错位。

**r1 正确路线**：clouds 包 `#include` core 的 bruneton runtime GLSL，**在云 shader 内**对云前表面调 `GetSkyRadianceToPoint(shadow_length)`（复刻 `clouds.frag:701 applyAerialPerspective`）。cloudsBuffer 作 overlay 合成在 atmosphere **之后**。**atmosphere stage 不消费 cloudsBuffer / shadowLength**——因此：
- atmosphere 的 god rays 路径**真正零改动**（三处 0.0 保持不动，云不喫它）
- 云投影地面是**唯一**需 atmosphere 侧改动的项（加 BSM 采样 uniform 减暗 originalColor，见 §6 M6）

> 本项目 `cesium-core/src/glsl/bruneton/runtime.glsl` **完整含 Bruneton Eq.17/18 light-shaft 实现**（`runtime.glsl:138/253/185/318-335`）——这些函数被云 shader `#include` 复用，云 god rays 走它（配合 C9 higher-order LUT）。

### 2.3 真正难点（MRT/2D_ARRAY 基建）

- **MRT 无先例**：Cesium `PostProcessStage` 单输出；`drawBuffers` / `COLOR_ATTACHMENT` / `layout(location=N)` 在 `cesium-core/src/` 零使用。lensflare 是拆多 stage 串联（单输出范式），非自管 DrawCommand 先例。
- **2D_ARRAY 无封装**：Cesium 1.143.0 bundle 无 `Texture2DArray` class（已核实）；已有的 `Texture3D`（`cesiumTextures.ts`）是 `TEXTURE_3D`，非 cascade 用的 `TEXTURE_2D_ARRAY`。需裸 WebGL + bridge 对象（仿 `historyBlit.ts:80 getHistoryBridge`）。
- **MRT 执行时机**（r1 critical #4）：云需在 globe 渲染后、PostProcess 链前执行——`historyBlit.ts` 跑在 `scene.postRender`（全 PostProcess 跑完后），非"链中间插入"先例。倾向 **custom Primitive**（C6）。

### 2.4 规模

`@takram/three-clouds` v0.7.6：GLSL ≈ 2740 行（19 文件），核心 TS ≈ 3377 行，helpers ≈ 436 行，合计 ~6500 行。**r1 修订（评审 minor）**：加上 higher-order LUT 离线预计算 + weather 资产生成 + temporal 跨 frame loop lifecycle 适配 + MRT 基建可能的回退成本，**总风险预算按 8000-10000 行评估**（含回退；若 MRT 失败转 epipolar 则更大）。

---

## 3. 目标与非目标

### 3.1 目标
1. 在 Cesium（WebGL2）复现 three-geospatial 体积云完整效果：云自阴影、云投影地面、地形遮挡云、云驱动 god rays。
2. 产物为独立包 `@cesium-geospatial/clouds`，命令式 API（`createCloudsStage`），接入 `createAtmosphereStage` PostProcess 链（cloudsBuffer overlay 在 atmosphere 之后）。
3. GLSL 资产保持渲染器无关（从 three-geospatial 搬，`#include` 走 `resolveIncludes`），云 shader `#include` core bruneton runtime。
4. 低/中/高/ultra 质量预设，桌面高端 60fps（high 档）。
5. 云关闭时 atmosphere 链 bit 等价零回归。

### 3.2 非目标（r1 补充）
- **不做 WebGPU/TSL 路径**（atmosphere 包 epipolar/ShadowLengthNode 不移植）。
- **不重做大气**：复用本项目 Bruneton runtime（云 shader `#include` 它，不搬 `@takram/three-atmosphere`）。
- **不 fork Cesium**：MRT 通过 custom Primitive / 自管 RT 绕过 PostProcessStage 单输出。
- **云 god rays 不走 atmosphere stage 钩子**（r1：评审证伪，改云 shader 内）。
- 不做天气系统/数据驱动云（程序化噪声）。

---

## 4. 架构

### 4.1 包结构（独立包 + core 基建）

```
packages/
├── cesium-core/                          # 已有，新增通用基建 + higher-order LUT
│   └── src/cesium/
│       ├── platform/                     # 新增（master plan §3.4，供所有效果包复用）
│       │   ├── FullscreenPass.ts         # DrawCommand 全屏三角形
│       │   ├── FramebufferManager.ts     # 裸 WebGL2 FBO：MRT + TEXTURE_2D_ARRAY + ping-pong
│       │   └── index.ts
│       └── （existing: bruneton/runtime.glsl ← clouds 包 #include；lutLoader；cesiumCore prefix）
└── cesium-clouds/                        # 新包 @cesium-geospatial/clouds
    ├── src/
    │   ├── glsl/                         # 搬 three-geospatial clouds 19 shader
    │   │   ├── clouds.frag / clouds.glsl / shadow.frag / shadow.vert
    │   │   ├── cloudsResolve.frag / shadowResolve.frag
    │   │   ├── perlin.glsl / tileableNoise.glsl / structuredSampling.glsl
    │   │   ├── catmullRomSampling.glsl / varianceClipping.glsl
    │   │   ├── localWeather.frag / cloudShape.frag / cloudShapeDetail.frag / turbulence.frag
    │   │   └── cloudsEffect.frag         # overlay 合成（在 atmosphere 之后）
    │   ├── CloudsPass.ts / ShadowPass.ts # 编排重写为 DrawCommand/Primitive
    │   ├── CascadedShadowMaps.ts         # 纯数学（搬）
    │   ├── CloudsMaterial.ts / ShadowMaterial.ts / CloudsResolveMaterial.ts / ShadowResolveMaterial.ts
    │   ├── qualityPresets.ts / CloudLayers.ts / uniforms.ts
    │   ├── weatherTextures.ts            # weather/shape/detail 噪声纹理
    │   ├── cloudsConstants.ts
    │   ├── createCloudsStage.ts          # 顶层工厂
    │   └── index.ts
    ├── package.json                      # 依赖 @cesium-geospatial/core (workspace:*)
    └── ...
```

**依赖路径**（r1 厘清）：`cesium-core` ← `cesium-clouds`。clouds 包通过 `resolveIncludes` **跨包** `#include "bruneton/runtime"` 引用 core 的 Bruneton GLSL（core 已 export `glslIndex` + `resolveIncludes`）——无需搬一份 bruneton runtime 到 clouds（消除 r0 §1 C5 与 §3.2 自相矛盾）。

### 4.2 两层划分 + uniform 桥接明细（r1 补充）

| 层 | 内容 | 来源 |
|---|---|---|
| 基建层（core/platform） | FullscreenPass / FramebufferManager | 全新 |
| GLSL 资产层（clouds/glsl） | 19 clouds shader | 搬，保持形态 |
| 编排层（clouds/*.ts） | Pass 编排 + Material 组装 | 借鉴 three 版，胶水重写 |

**铁律**：GLSL 资产层不得出现 Cesium/Three 特有标识符。

**uniform 桥接明细**（r1 important #6，评审要求）——clouds.frag 的 three.js 命名 uniform → Cesium 映射：

| three.js uniform | Cesium 映射 | 说明 |
|---|---|---|
| `cameraPosition` / `viewMatrix` / `inverseViewMatrix` | `czm_viewerPositionWC` / `czm_view` / `czm_inverseView` | 自动注入（若 Primitive/PostProcess 内） |
| `cameraNear` / `cameraFar` | `czm_currentFrustum.xy` | 自动 |
| `inverseProjectionMatrix` | **不能直接用 `czm_inverseProjection`** | 需注入 temporalJitter 偏移（`elements[8]/[9] += dx*2/dy*2`），否则 temporal 收敛质量下降 |
| `reprojectionMatrix` / `viewReprojectionMatrix`（前帧 VP） | **手动管理**（无 czm_\* 等价） | 仿 `AtmosphereStage.ts:437 prevViewProjection`：postRender 写本帧、preRender 读 |
| `temporalJitter`（vec2） | 手动 uniform | 每帧提供（Bayer 4×4） |
| `shadowMatrices[]`（CSM cascade） | 手动（`CascadedShadowMaps.ts` 算） | 纯 TS 数学 |

**自管 DrawCommand / Primitive 下 czm_\* 注入未验证**（r1 important #6 / critical #4）：`historyBlit.ts:101-106` 的 BLIT_SHADER 零 czm_\* 引用，从未验证自管 DrawCommand 下 `czm_viewerPositionWC`/`czm_inverseView` 是否注入。**M1 spike 必验**；若不注入，云 shader 改用手动 uniform（`scene.camera.positionWC` 等，仿 `createLensFlareStage.ts:244`）。

### 4.3 集成点（r1 重大修订）

```
[渲染管线]
  globe/primitives 渲染 → [云 Primitive/Pass：ShadowPass + CloudsPass + Resolve]
                            ↓ 输出 cloudsBuffer（overlay）+ BSM（供云投影地面）
  PostProcessStageCollection:
    [云投影地面减暗*] → depthTemporal?(off) → atmosphere → cloudsBuffer overlay → lensflare → tonemap
        (* 云投影地面：atmosphere **之前**减暗 originalColor *= exp(-cloudOpticalDepth)，让 atmosphere 的
           transmittance·groundDim 作用于已减暗地表；独立 reduce stage 解耦，或 atmosphere 内前置 BSM 采样)
```

- **cloudsBuffer overlay 在 atmosphere 之后**（tonemap 前 additive/alpha blend）——不作为 atmosphere 的 originalColor（否则 atmosphere 用 globe depth 算云的 aerial perspective，物理错误，评审 important）。
- **atmosphere stage 不消费 cloudsBuffer / shadowLength**（god rays 完成于云 shader）。
- **云投影地面**：唯一需 atmosphere 侧改动的项——在 atmosphere 输出后、overlay 前，读 BSM + globe depth 重建地形 ECEF，`originalColor *= exp(-cloudOpticalDepth)`（独立 reduce stage 或 atmosphere stage 加 BSM uniform，M6 定）。
- **云 god rays**：云 shader 内 `applyAerialPerspective`（`#include bruneton/runtime`），cloudsBuffer 已含 god rays 效果。

---

## 5. 数据流（r1 修订）

```
离线：higher_order_scattering LUT（C9，Bruneton precompute）+ weather/shape/detail 噪声纹理
        │
  ShadowPass (sun-POV 全屏 raymarch)  ──→ BSM (TEXTURE_2D_ARRAY, N cascade)
        │                                 [frontDepth, meanExtinction, maxOpticalDepth]
  CloudsPass (主相机, 1/4 分)
     ├ raymarch 云密度（weather+shape+detail）
     ├ Beer-Lambert(BSM) + powder（云自阴影）
     ├ getRayDistanceToScene(depthTexture, log-depth→线性) 截断（地形遮挡云）
     ├ applyAerialPerspective（clouds.frag:701）：
     │    对云前表面调 GetSkyRadianceToPoint(camera, frontPos, shadow_length)  ← 云 god rays
     │    #include bruneton/runtime（core），需 higher_order_scattering LUT（C9）
     ├ marchShadowLength()：沿视线累加 BSM → shadowLength（云前表面 god rays 用）
     └ MRT 一次 draw：color / depthVelocity / shadowLength
        │
  Resolve (temporal: cloudsResolve.frag 方差裁剪 + history ping-pong + Bayer upscale)
        ├──→ cloudsBuffer overlay（含 god rays）→ atmosphere 之后合成
        └──→ BSM + shadowLengthHistory → 云投影地面 reduce stage（读 globe depth）

  云投影地面（atmosphere **之前**，减暗 originalColor）:
    重建地形 positionECEF（globe depth）→ sampleShadowOpticalDepth(BSM)
    → originalColor.rgb *= exp(-cloudOpticalDepth)（B 路径 hack，让 atmosphere 的 transmittance·groundDim 作用于已减暗地表）
```

---

## 6. 实施阶段（6 milestone，逐 pass 增量）

### M1 — 基建 + 资产管线 + MRT/Primitive spike（r1 强化）

**范围**：跨 core + clouds。
- **core**：`FullscreenPass` + `FramebufferManager`（MRT via `gl.drawBuffers`、`TEXTURE_2D_ARRAY` + bridge、ping-pong）；`cesiumCore.ts` 加 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE`（C9）；`lutLoader` 扩展加载第 4 张 LUT。
- **clouds**：包骨架 + 搬 19 GLSL + 跨包 `#include bruneton/runtime` 验证 + `weatherTextures` 资产管线。
- **spike（前置 go/no-go，r1 追加验收项）**：
  1. **链中间插入**：custom Primitive（C6 倾向）或自管 DrawCommand 能否在 globe 渲染后、PostProcess 链**中间**执行，且输出（cloudsBuffer/BSM）可被后续 PostProcessStage 消费？
  2. **globe depthTexture 访问**：云 pass 能否拿到本帧 globe depthTexture（Primitive 渲染进 scene FBO 天然有 depth；自管 DrawCommand 需深入私有 API）？
  3. **czm_\* 注入**：Primitive/自管 DrawCommand 下 `czm_viewerPositionWC`/`czm_inverseView` 是否注入？不注入则改手动 uniform。
  4. **2D_ARRAY + precision**：裸 WebGL 创建 `TEXTURE_2D_ARRAY` + bridge 绑定 `sampler2DArray` 能否采样；`precision highp sampler2DArray` 声明顺序（须在 sampler 使用前）。

**验收**：上述 4 项 spike 全过；`glslang` 编译搬来的 19 GLSL（含 `#include bruneton/runtime`）；单测 FramebufferManager/FullscreenPass；tsc 0 error。
**plan B 不可用**（r1）：若 spike 失败，拆多 stage（3× raymarch）性能破 60fps（1500 步/像素），**非 viable backup**——R1 失败触发整个路线重新评估（含 epipolar ~7000-10000 行，见 godRays-tyndall.md）。

### M2 — 主 raymarch（无 shadow，flat lighting）

搬 `clouds.frag` 主循环 + weather/shape 采样，不含 BSM 采样（Beer-Lambert 置 1）。含 `getRayDistanceToScene` 骨架但**暂用大气顶远截断**（不读 depthTexture，M6 接通）。**r1**：云读 depthTexture 前须 log-depth→线性转换（编排层注入 `czm_reverseLogDepthWindow` 或等价 helper，不污染 GLSL 资产层）。

**验收**：demo `?clouds=1` 天空有云形（无体积厚度）；ECEF 密切球再中心化下相机移动稳定；零回归。

### M3 — BSM + 云自阴影

`ShadowMaterial` + `ShadowPass` + `CascadedShadowMaps`，sun-POV 生成 BSM（2D_ARRAY cascade），`CloudsMaterial` 接入 Beer-Lambert + powder。**r1**：验收增 cascade 边界带状 artifact probe（god ray march 路径跨 cascade 的 opticalDepth 跳变）。

**验收**：云有体积厚度/层次；多 cascade 无接缝（含 god ray march 路径）。

### M4 — temporal resolve

`CloudsResolveMaterial`（搬 `cloudsResolve.frag`）+ history ping-pong + velocity reprojection + variance clipping + Bayer 4×4 jitter（1/4 分 → 全分 upscale）。**r1**：云 temporal 走 `cloudsResolve.frag` 方差裁剪（**不复用**本项目 depthTemporal/historyBlit——那是 NEAREST+EMA 的 depth 专用）；云场演化（weather scroll/shape 演化）区 temporal 糊为已知限制。

**验收**：云边缘干净无 banding；动态相机拖影可接受；1/4 分静态收敛近全分。

### M5 — 云 god rays（r1 重写）

`applyAerialPerspective`（`clouds.frag:701`）对云前表面调 `GetSkyRadianceToPoint(camera, frontPos, shadow_length)`，`#include bruneton/runtime`；`marchShadowLength` 沿视线累加 BSM → shadowLength。**前置**（C9）：higher-order LUT 已加载（M1），走 `runtime.glsl:341-353` 只遮 single 保留多阶的物理正确分支（防过暗）。

**r1**：
- god rays 在云 shader 内完成（**非**喂 atmosphere 钩子）
- 验收与历史 screen-space god rays 对比（同心波纹应消失——BSM 是 sun-POV 云密度场，避开 screen-space Q 投影不稳定）
- `debug` probe 可视化 shadowLength 纹理确认无 1/4 分方块边缘（resolve 后全分 historyBuffer）
- **前置核实**（评审 minor）：跑一次 three-geospatial clouds demo 确认 lightShafts=on 时 god rays 视觉效果达标（memory 记录作者曾说 WebGL 未实现，但代码链路完整，二者矛盾需实跑确认）

**验收**：朝太阳方向云间体积光柱；无同心波纹；无过暗（higher-order LUT 生效）。

### M6 — 地形交互 + 质量预设 + 集成（r1 修订）

- **云投影地面**（B 路径 hack）：**atmosphere 之前**减暗 originalColor，读 BSM + globe depth 重建地形 ECEF → `originalColor *= exp(-sampleShadowOpticalDepth(groundPosECEF))`（让 atmosphere transmittance·groundDim 作用于已减暗地表）。独立 reduce stage（解耦）或 atmosphere 内前置 BSM 采样（省 stage）。**决策点**：地面视向 foreInscatter（`aerialPerspective.frag.ts:475`）云影区是否需单独 shadow_length（成本 vs 忽略记录地影处大气散射偏亮）。
- **地形遮挡云**：`getRayDistanceToScene` 接通真实 `depthTexture`（M2 远截断→真实地形 depth，log-depth 转换）。
- `qualityPresets` + `createCloudsStage` 完整工厂 + 接 atmosphere 链（cloudsBuffer overlay 在 atmosphere 后）+ demo URL。

**验收**：地表有云影（随云移动）；山遮云底；云不穿山；temporal reprojection 无拖影；low/medium/high 帧率（桌面 high ≥ 60fps）；完整零回归。

### 阶段拆分与 plan 策略

体积云规模 ~6500 行（含回退 8000-10000）。本 spec 为**总设计**，实施按 **每 milestone 一个独立 plan**（`plans/2026-08-13-clouds-m1-platform.md` … `m6-integration.md`），每个走 plan→results→多专家评审→TDD 循环。**M1（基建 + spike）是后续所有 milestone 的依赖，先行；M1 spike 4 项 go/no-go 全过才铺 M2+**（失败则整体重评）。

---

## 7. 关键技术选型（r1 修订）

| 选型点 | 选择 | 理由 |
|---|---|---|
| **MRT**（r1） | **倾向 custom Primitive**（Pass 排 globe 后/PostProcess 前，渲染进 scene FBO 天然有 depth）；自管 DrawCommand + 裸 WebGL2 备选 | 评审 critical #4：Primitive 天然解决执行时机 + depthTexture 访问；M1 spike 验两条路 |
| **BSM 纹理** | `TEXTURE_2D_ARRAY` + bridge（无 Cesium 封装） | cascade 各层独立 |
| **god rays**（r1） | **云 shader 内** `applyAerialPerspective`（`#include bruneton/runtime`） | 评审 critical #1：不走 atmosphere 钩子（sky 硬编码 0 + 语义不匹配） |
| **higher-order LUT**（r1，C9） | 预计算第 4 张 + `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE` | 评审 critical #2：防过暗黑 |
| **atmosphere** | 复用本项目 Bruneton runtime（云 shader `#include`）；atmosphere stage god rays 路径**零改动**（不消费 cloudsBuffer） | god rays 完成于云 shader |
| **temporal** | `cloudsResolve.frag` 方差裁剪（搬，不复用 depthTemporal） | 云体积场 reprojection |
| **GLSL 资产** | 搬 19 文件保持形态，`#include bruneton/runtime` 跨包 | resolveIncludes |
| **云投影地面**（r1） | B 路径 hack `originalColor *= exp(-opticalDepth)` | 评审 critical #3：本项目无 irradiance |

`qualityPresets` 档位不变（low/medium/high(默认)/ultra）。

---

## 8. 资产映射（three-geospatial → 本项目）

（同 r0，r1 补 uniform 桥接明细见 §4.2 表）
搬 19 shader 保持形态；`CloudsPass`/`ShadowPass` 编排重写为 DrawCommand/Primitive；`CascadedShadowMaps` 纯数学搬；`postprocessing` Effect/ShaderPass → `createCloudsStage`；`WebGLRenderTarget`/`WebGLArrayRenderTarget`/`DataArrayTexture` → `FramebufferManager` + bridge；`@takram/three-atmosphere` Bruneton → **不搬**，clouds 包 `#include` core 的 bruneton/runtime（r1 厘清）。

---

## 9. 风险与对策（r1 修订）

| # | 风险 | 严重度 | 对策 | 阶段 |
|---|---|---|---|---|
| **R1**（r1 强化） | MRT 执行时机 + globe depthTexture 访问（自管 DrawCommand 无先例） | **致命** | M1 spike 4 项 go/no-go；倾向 custom Primitive（C6）；**plan B 不可用**（3× raymarch 破 60fps），失败触发整体重评 | M1 |
| **R2** | ECEF 大坐标单精度失效 | 致命 | 密切球再中心化 + `getAltitudeCorrectionOffset` | M2 |
| **R3**（r1） | requestRenderMode 冲突（云须每帧，静止也满载） | 高 | 云激活强制每帧；相机静止 N 帧降级（停 temporal 或降 iter）；qualityPresets 加"静止降帧"档 | M4 |
| **R4** | weather 噪声资产缺失 | 中 | 离线 Node 脚本生成 perlin/worley `.bin` | M1 |
| **R5**（r1） | 2D_ARRAY 创建/绑定 + precision 顺序 | 中 | M1 spike 验（bridge + `precision highp sampler2DArray` 声明顺序） | M1 |
| **R6**（r1 降级） | ~~shadow_length 单位不匹配~~ | ~~已确认~~ | **已核实无 1000× bug**：`clouds.frag:1001` 输出 km（`METER_TO_LENGTH_UNIT=0.001`），与本项目 Bruneton `m=km` 一致。仅提醒：跨纹理采样勿误 ×二次 `METER_TO_LENGTH_UNIT`。另：`GetSkyRadianceToPointScaled` 的 `u_distanceScale` 与 shadow_length 错配（wrapper 引入），需 `d = max(d - shadow_length*u_distanceScale, 0)` 对齐，M5 加 distanceScale≠1 测试 | M5 |
| **R7** | 性能（high 档 60fps） | 中 | 1/4 分 + temporal；`StageGpuTimer` 逐 pass | M4/M6 |
| **R8** | 云 overlay 合成顺序/blend | 中 | cloudsBuffer overlay 在 atmosphere 后（非 originalColor）；depth 截断防穿地 | M6 |
| **R9**（r1 新增） | higher-order LUT 预计算工作量 + 离线 Bruneton precompute 正确性 | 中 | M1 扩展 precompute（仿现有 lutLoader）；M5 验收对比过暗 | M1/M5 |
| **R10**（r1 新增） | 自管 DrawCommand/Primitive 下 czm_\* 注入未验证 | 高 | M1 spike 验；不注入则手动 uniform（仿 lensflare） | M1 |
| **R11**（r1 新增） | 云 1/4 分读全分 globe depthTexture（分辨率 mismatch + log-depth 转换） | 高 | targetUvScale + temporalJitter offset；编排层注入 log-depth→线性转换 | M2/M6 |
| **R12**（r1 新增） | 云投影地面需 atmosphere 加 BSM 采样（非零改动） | 中 | reduce stage 或 atmosphere 加 uniform；地面 foreInscatter 决策 | M6 |

---

## 10. 测试策略

- **GLSL 编译测试**（glslang，两构建入口）：19 clouds shader + 云 shader `#include bruneton/runtime` + god rays 路径（含 higher-order LUT sampler3D 声明）都过。
- **TS 单元**：`CascadedShadowMaps` split/frustum；`FramebufferManager` MRT/2D_ARRAY/ping-pong；`FullscreenPass`；`weatherTextures`；higher-order LUT 加载（lutLoader 扩展）；`createCloudsStage` 装配/生命周期/option 透传。
- **零回归**：`clouds` 关闭时 atmosphere 链 bit 等价；atmosphere stage 三处 shadow_length 仍为 0（云不喫它）。
- **视觉验收**：每阶段 demo URL + debug-probe（含 shadowLength 纹理可视化、cascade 边界、log-depth 截断）。

---

## 11. 待确认事项（实现中据实定）

- **three-geospatial clouds WebGL god rays 视觉效果**（评审 minor）：memory 记作者曾说 WebGL 未实现，但代码链路完整（`marchShadowLength`+`lightShafts=on`+`outputShadowLength`+消费）。**M5 前跑 three demo 确认 god rays 确实可见**再投入移植。
- **云投影地面 foreInscatter 决策**：地面视向 foreInscatter（`aerialPerspective.frag.ts:475`）云影区是否需单独 shadow_length（M6 定）。
- **跨包 `#include bruneton/runtime`**：`resolveIncludes` 是否支持 clouds 包引用 core GLSL 路径（M1 验，可能需路径前缀约定）。
- **云投影地面实现位置**：atmosphere stage 加 BSM uniform vs 独立 reduce stage（M6 据性能/复杂度定）。
- **czm_\* 在 custom Primitive 的注入**：M1 spike 确认（Primitive 的 shader 经 Cesium 预处理，应注入，但需验证）。
- 默认质量档倾向 high；weather 资产来源（离线脚本 vs 搬 generator）。

---

## 12. 成功标准

- **M1**：spike 4 项过（链中间插入 + globe depthTexture + czm 注入 + 2D_ARRAY/precision）+ 19 GLSL glslang（含 bruneton #include）+ higher-order LUT 加载 + 基建单测绿
- **M2-M6**：每阶段 demo 视觉验收 + 零回归
- **全程**：GLSL 资产渲染器无关；CI glslang 通过；high 档桌面 ≥ 60fps
- **终极**：4 效果（云自阴影 / 云投影地面 / 地形遮挡云 / 云 god rays）全可验收；god rays 经云 BSM 路线复活（在云 shader 内，无 screen-space 几何 artifact）

---

## 附录 E：r1 评审修订表（三专家评审，2026-08-13）

来源：Cesium 集成专家（approve_with_changes）/ 大气物理专家（approve_with_changes）/ 对抗红队（reject）。综合 approve_with_changes。实质问题三专家强共识，严重度判定有分歧（红队判 critical 想整体 reject，另两位判 important 可修订——本 r1 按红队方向修订但保留核心架构）。

| # | 评审 finding（severity·来源） | r1 修订 |
|---|---|---|
| E1 | 云 god rays 路线"喂 atmosphere shadow_length 钩子"不通：sky 硬编码 0.0（`:313`）+ Bruneton sky 语义（大气顶回退）与云位置（大气中部）不匹配 + marchShadowLength ≠ Eq.17（critical·红队/important·Cesium+物理） | **§1 C8 新增 + §2.2 重写 + §4.3/§5/§6 M5/§7 修订**：god rays 移云 shader 内 `applyAerialPerspective`（`#include bruneton/runtime`，对云前表面调 `GetSkyRadianceToPoint`），cloudsBuffer overlay 在 atmosphere 后；atmosphere 不消费 cloudsBuffer → god rays 路径真正零改动 |
| E2 | 缺 `HAS_HIGHER_ORDER_SCATTERING_TEXTURE`（`cesiumCore.ts` 已核实无 define）→ shadow_length>0 走 `runtime.glsl:354-356` 全扣 → 复现 phase2c 过暗黑（critical·物理+Cesium） | **§1 C9 新增（用户决策）+ §6 M1/M5 + §9 R9**：预计算第 4 张 higher-order LUT + cesiumCore define，走 `runtime.glsl:341-353` 物理正确分支 |
| E3 | 云投影地面引用 three 版 A 路径 `aerialPerspectiveEffect.frag:354`（含 irradiance），本项目 B 路径无 irradiance——概念混淆（critical·红队/important·物理） | **§2.1 表 + §5 + §6 M6 + §7 + §9 R12 修订**：删 A 路径引用，改 B 路径 hack `originalColor *= exp(-opticalDepth)`；需 atmosphere 加 BSM 采样（非零改动） |
| E4 | M1 MRT spike 漏 depthTexture 访问 + 链中间插入；plan B 性能不可用 = 无 viable backup（critical·红队/important·Cesium） | **§1 C6 + §2.3 + §6 M1 + §9 R1 强化**：spike 追加 4 项验收；倾向 custom Primitive；明确 plan B 不可用、失败触发整体重评 |
| E5 | "零 atmosphere 改动"不准（三处硬编码 0.0）（important·三专家） | **§1 C5 + §2.2 修订**：采纳 E1（god rays 移云 shader）后 atmosphere god rays 路径真零改动；云投影地面（E3）是唯一 atmosphere 改动项 |
| E6 | czm_\* 桥接被低估：reprojection/jitter 矩阵无 czm_\* 等价 + 自管 DrawCommand czm 注入未验证（important·Cesium+红队） | **§4.2 uniform 映射表 + §9 R10 + §11 新增**：手动管理明细 + M1 spike 验注入 |
| E7 | 云 1/4 分读全分 globe depthTexture：分辨率 mismatch + log-depth 转换（important·红队+Cesium） | **§5 + §6 M2/M6 + §9 R11 + §11 新增**：targetUvScale + log-depth→线性转换 |
| E8 | R6 单位对齐已核实无 1000× bug（minor·物理） | **§9 R6 降级**为已确认 + u_distanceScale 错配提醒（M5 测试） |
| E9 | u_distanceScale 与 shadow_length 错配（wrapper 引入）（important·物理） | **§9 R6 补**：`d = max(d - shadow_length*u_distanceScale, 0)` 对齐 + M5 distanceScale≠1 测试 |
| E10 | 上游 three 版 WebGL god rays 视觉效果存疑（memory 说未实现，代码链路完整）（minor·Cesium） | **§6 M5 前置 + §11**：M5 前跑 three demo 确认 |
| E11 | 云 temporal 不复用 depthTemporal，搬 cloudsResolve（minor·物理） | **§6 M4 + §7**：走 cloudsResolve.frag 方差裁剪，云演化区糊为已知限制 |
| E12 | cascade 边界带状 artifact（god ray march 路径）（minor·物理） | **§6 M3 验收 + §9**：faded cascade 混合 + probe |
| E13 | requestRenderMode 永久关的性能代价（minor·Cesium） | **§9 R3 补**：静止降级档 |
| E14 | 6500 行乐观（含回退 8000-10000）（minor·红队） | **§2.4 + §6 补**：风险预算 |
| E15 | Texture2DArray 无封装 + precision 顺序（minor·Cesium） | **§9 R5 + §6 M1 spike**：bridge + precision 声明顺序 |

---

## 附录 F：r2 调研增补（Cesium 渲染入口深度核实，2026-08-13）

来源：Explore agent 调研 `@cesium/engine@26.1.0` 源码（`Scene.js` 帧序 / `PostProcessStage.js` / `Framebuffer.js` / `Context.js` / `Pass.js`）+ three-geospatial `clouds.frag`/`cloudsResolve.frag` 核实。**spec r1 架构方向经核实正确，本附录为精确化增补。**

### F1. MRT 确认必需（option a 单输出打包不成立）
spec r1 §6 M1 spike 曾考虑"PostProcessStage 单输出（color RGB + shadowLength alpha）+ 方差裁剪替代 depthVelocity"绕开 MRT。**核实不成立**（三硬伤）：
- alpha 已被 transmittance 占（`clouds.frag:617`），丢则 composite 无法 over-blend。
- shadowLength 线性米塞 alpha 精度不够（对比 depthTemporal 的 log-depth 压缩才能塞）。
- **depthVelocity 不可由方差裁剪替代**：`cloudsResolve.frag:85-86/127-129` 证明 velocity 做 per-pixel history 重投影（找采样点），方差裁剪（`varianceClipping.glsl:42-68 clipAABB`）只 clip 不找采样点。

### F2. MRT 死结有解：custom Primitive pass=VOXELS + 自管 MRT FBO
- pass VOXELS(10) 在 GLOBE(2) 后、PostProcess 前执行（`Pass.js:27` + `Scene.js executeCommands` 序）→ globe depthTexture 已存在。
- `DrawCommand._framebuffer` 优先于 `passState.framebuffer`（`Context.js:1412`）→ 云 DrawCommand 写自己的 3-attachment MRT FBO。
- `Context.bindFramebuffer` 自动 `glDrawBuffers`（`Context.js:1219-1239`）→ MRT 无需额外 gl 调用。
- `Framebuffer.js:84-215` 原生支持 `colorTextures: [t0,t1,t2]` 多 attachment。
- czm_* 自动注入（`ShaderProgram._automaticUniforms`，Primitive 走 ShaderProgram）。

### F3. 新增基建：VolumetricPrimitive（spec r1 §1 C6 精确化）
spec r1 C6"倾向 custom Primitive"未列设计。r2 明确：core/platform 加 `VolumetricPrimitive`——封装"自定义 primitive 对象，`update(frameState)` 下发 `pass=VOXELS` + 自带 MRT framebuffer 的 DrawCommand"。这是**云主 march 的渲染入口**（`FullscreenPass`/`createViewportQuadCommand` 用于 BSM ShadowPass + resolve + history blit，二者职责不同）。

### F4. cloudsBuffer → PostProcessStage 桥接：必须 bridge
云主 pass 是 Primitive（非 PostProcessStage），cloudsBuffer **不能用 uniform-name 字符串**（`createLensFlareStage.ts:228` 那种 stage 间机制只适用于 stage→stage）。**必须用 bridge 对象**（`{_texture, _target}`，仿 `historyBlit.ts:80 getHistoryBridge`）注入后续 cloudsOverlay PostProcessStage 的 uniform。

### F5. globe depthTexture 访问路径
Primitive 内手动注 `scene._view.globeDepth.depthStencilTexture`（私有 API，`Scene.js:2841` 内部就用它）。封装进 VolumetricPrimitive helper 隔离私有 API 访问。

### F6. 风险降级
- **R10（czm_* 注入）已确认**：Primitive 走 ShaderProgram 必注入。降级为"实跑确认具体 uniform（czm_inverseView 等）可用"。
- **M1 spike #1（链中间插入）调研已预答**：Primitive pass=VOXELS 可行。
- **M1 spike #3（czm 注入）已确认**。
- M1 spike #2（globe depth 访问）：路径明确（F5），仍需实跑验证私有 API 稳定。
- M1 spike #4（2D_ARRAY + precision）：仍需实跑。

### F7. M1 plan 调整
- T5 `FullscreenPass`（createViewportQuadCommand 封装，BSM/resolve/blit 用）+ **新增 T5b `VolumetricPrimitive`**（pass=VOXELS + MRT FBO，云主 march 入口）。
- spike 合并：#1/#3 调研已答，probe 聚焦 #2（globe depth 私有 API）+ #4（2D_ARRAY/precision）+ 实跑确认 Primitive pass=VOXELS + MRT 三 attachment 输出。


