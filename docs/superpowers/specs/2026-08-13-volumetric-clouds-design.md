# 体积云（Phase 3）设计文档

> **状态**：已通过 brainstorming 决策（完整 Phase 3 / 逐 pass 增量 / 独立包 / M1 含 MRT spike），待用户审 spec → writing-plans 拆解
> **日期**：2026-08-13
> **参考库**：`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`（`@takram/three-clouds` v0.7.6，算法/技术主参考）
> **关联**：
> - 总计划 `docs/superpowers/specs/2026-07-29-cesium-geospatial-port-design.md` §4 Phase 3（"最大工程，进入前重新决策"——本次即该重新决策的结论）
> - god rays 调研记忆 `.claude/projects/.../memory/godRays-tyndall.md`（体积云=换 occluder 复活 god rays 的伏笔）
> - 现有大气 `packages/cesium-core/src/cesium/AtmosphereStage.ts`（云 stage 接入点 + shadow_length 钩子消费者）

---

## 1. 决策摘要

| 决策点 | 选择 | 说明 |
|---|---|---|
| **C1 范围** | 完整 Phase 3（对标 three 版全部效果） | 含云自阴影 + 云投影地面 + 地形遮挡云 + 云驱动 god rays |
| **C2 交付路线** | 逐 pass 增量，6 阶段 | 每 milestone 可视觉验收；非 spike、非一次性 |
| **C3 包结构** | 独立成包 `packages/cesium-clouds` | 遵循 master plan §3.1（非合进 core）；基建放 core 供复用 |
| **C4 基建** | 自建"迷你 Three"层（FullscreenPass + FramebufferManager） | 解决 Cesium 无 MRT / 无 2D_ARRAY 封装；裸 WebGL2 |
| **C5 atmosphere 桥接** | 复用本项目 Bruneton runtime | `shadow_length` 钩子已串好（当前传 0），云 BSM 喫它，零 atmosphere 改动 |
| **C6 MRT 实现** | 自管 RT（DrawCommand + 裸 WebGL2 Framebuffer 多附件） | raymarch 只跑一次（性能必需）；M1 早期 spike 验证可行性 |
| **C7 平台** | WebGL2（Cesium 原生 context） | 无 WebGPU，无 compute |

**核心判断**：体积云的 shadow 链**不撞 god rays 当年的死局**。god rays 撞墙是因为需要地形向 shadow map 写深度（Cesium globe 不写）；而体积云的 shadow 源是**云自身的程序化密度场**（BSM = sun-POV 全屏 raymarch 采样 weather/shape 噪声，零场景几何），云投影地面/地形遮挡云只读 `depthTexture`（Cesium 提供），云 god rays 喂现成的 `shadow_length` 钩子。**真正工程量集中在 MRT + 2D_ARRAY 两处 WebGL2 基建**（Cesium 无封装）。

---

## 2. 调研结论（可行性依据）

### 2.1 shadow 链不撞墙（4 效果全绿）

来自 three-geospatial clouds 包 Explore 调研（2026-08-13），证据 file:line：

| 效果 | 机制 | shadow 源 | Cesium 可行性 |
|---|---|---|---|
| **云自阴影** | `ShadowPass` sun-POV 全屏 raymarch 云密度 → BSM（Beer Shadow Map）→ Beer-Lambert + powder | 云自身程序化密度（`shadow.frag:147` `cascade()` 采 weather/shape 噪声，`shadow.vert` 全屏三角**无几何输入**） | ✅ 全屏 PostProcess + WebGL2 2D_ARRAY |
| **云 god rays** | `marchShadowLength`（`clouds.frag:622`）沿视线采样 BSM 累加 → 喂大气 `GetSkyRadianceToPoint(shadow_length)` | BSM（云自身） | ✅ 不依赖地形 shadow map |
| **云投影地面** | `aerialPerspectiveEffect.frag:354` 重建地形世界坐标，从 BSM 采样云遮挡，调制 sun/sky irradiance | `depthBuffer`（globe depth） | ✅ Cesium `depthTexture` 直接可用 |
| **地形遮挡云** | `clouds.frag:846` `getRayDistanceToScene()` 用主相机 depth 截断云 raymarch 远端 | `depthBuffer` | ✅ 同上 |

**结论**：四个效果的 shadow 源要么是云自身（BSM），要么是已有 `depthTexture`，**无一需要地形写 shadow map**。god rays 当年的死局（地形无 shadow）在这里不成立。

### 2.2 atmosphere 钩子现成（本项目核实）

本项目 `cesium-core/src/glsl/bruneton/runtime.glsl` **完整含 Bruneton Eq.17/18 light-shaft 实现**：

- `runtime.glsl:138` `GetSkyRadiance(... shadow_length ...)` 签名
- `runtime.glsl:253` `GetSkyRadianceToPoint(... shadow_length ...)` 签名
- `runtime.glsl:185` "Case of light shafts (shadow_length is the total length noted l)"
- `runtime.glsl:318-322` "subtract shadow_length from d" 实现
- `runtime.glsl:335` `if (shadow_length > 0.0)` 分支

且 `aerialPerspective.frag.ts` **已把 `shadow_length` 串进 base/fore inscatter**：
- `:147` `GetSkyRadianceToPointScaled(camera, point, shadow_length, ...)` 定义
- `:455` base inscatter 调用、`:475` fore inscatter 调用、`:291-299` sky 分支调用——**全部传 `shadow_length`，当前值 0**

→ 云的 BSM 经 `marchShadowLength` 产出 `shadowLength` 后，喫这个现成入参即可。**atmosphere 侧改动 = 把 uniform 数据源从"常量 0"换成"云 shadowLength 纹理"，函数链不动**。

### 2.3 真正难点收窄到两处 WebGL2 基建

本项目核实（2026-08-13）：

- **MRT 无先例**：Cesium `PostProcessStage` 单输出（自动注入 `layout(location=0) out vec4 out_FragColor`，见 `depthTemporal/historyBlit.ts:98` 注释）；lensflare 是拆多 stage 串联（单输出范式）。`drawBuffers` / `COLOR_ATTACHMENT` / `layout(location=N)` 在 `cesium-core/src/` **零使用**。
- **2D_ARRAY 无封装**：`TEXTURE_2D_ARRAY` 零使用；已有的 `Texture3D`（`cesiumTextures.ts`，phase1 用于 scattering LUT）是 `TEXTURE_3D`（体积采样插值），**不是** cascade 用的 `TEXTURE_2D_ARRAY`（每层独立）。BSM 多 cascade 需 2D_ARRAY。

→ 这两处需自建 master plan §3.4 的"迷你 Three"层（FullscreenPass + FramebufferManager）。

### 2.4 规模

`@takram/three-clouds` v0.7.6：GLSL ≈ 2740 行（19 文件），核心 TS ≈ 3377 行，helpers+uniforms ≈ 436 行，合计 **~6500 行**；加需搬的 core GLSL（噪声等 ~6 文件）。CSM 矩阵数学（`CascadedShadowMaps.ts`）是纯 TS 可直接移植。

---

## 3. 目标与非目标

### 3.1 目标
1. 在 Cesium（WebGL2）场景中复现 three-geospatial 体积云的完整效果：云自阴影、云投影地面、地形遮挡云、云驱动 god rays。
2. 产物为独立 Cesium 插件包 `@cesium-geospatial/clouds`，命令式 API（`createCloudsStage` / option 透传），接入现有 `createAtmosphereStage` PostProcess 链。
3. GLSL 资产保持渲染器无关的原始形态（从 three-geospatial 搬，`#include` 走本项目 `resolveIncludes`），便于将来与上游 diff。
4. 低/中/高/ultra 质量预设（`qualityPresets.ts`），桌面高端 60fps（high 档）。
5. 云关闭时 atmosphere 链 bit 等价零回归。

### 3.2 非目标（明确不做）
- **不做 WebGPU/TSL 路径**：three-geospatial atmosphere 包的 `webgpu/ShadowLengthNode/EpipolarShadowLengthNode` 等 epipolar 方案不移植（面向通用 occluder 含地形，本项目用 clouds 的 BSM 路线足够）。
- **不重做大气**：复用本项目 Bruneton runtime（phase1 成果），不搬 `@takram/three-atmosphere`。
- **不 fork Cesium**：MRT 通过自管 RT（DrawCommand + 裸 WebGL2）绕过 PostProcessStage 单输出限制，不改 Cesium 源码。
- **不做天气系统/数据驱动云**：用程序化噪声（perlin/worley + weather texture），不接实时气象数据。

---

## 4. 架构

### 4.1 包结构（独立包 + core 基建）

```
packages/
├── cesium-core/                          # 已有，新增通用基建层
│   └── src/cesium/
│       ├── platform/                     # 新增（master plan §3.4，供所有效果包复用）
│       │   ├── FullscreenPass.ts         # DrawCommand 全屏三角形
│       │   ├── FramebufferManager.ts     # 裸 WebGL2 FBO：MRT 多 attachment + TEXTURE_2D_ARRAY + ping-pong
│       │   └── index.ts
│       └── （existing: depthReconstruction, cesiumTextures, cesiumCore, lensFlare, ...）
└── cesium-clouds/                        # 新包 @cesium-geospatial/clouds
    ├── src/
    │   ├── glsl/                         # 搬 three-geospatial clouds 19 shader（保持形态）
    │   │   ├── clouds.frag               # 主 raymarch（1003 行，含 shadow 采样/marchShadowLength/haze/aerial perspective）
    │   │   ├── clouds.glsl               # 共享 weather/media 采样（clouds.frag + shadow.frag #include）
    │   │   ├── shadow.frag               # sun-POV BSM 生成
    │   │   ├── shadow.vert               # 全屏三角（10 行）
    │   │   ├── cloudsResolve.frag        # temporal resolve（color）
    │   │   ├── shadowResolve.frag        # temporal resolve（shadow）
    │   │   ├── perlin.glsl / tileableNoise.glsl / structuredSampling.glsl
    │   │   ├── catmullRomSampling.glsl / varianceClipping.glsl
    │   │   ├── localWeather.frag / cloudShape.frag / cloudShapeDetail.frag / turbulence.frag
    │   │   └── cloudsEffect.frag         # 合成 overlay（11 行）
    │   ├── CloudsPass.ts                 # 主相机 raymarch + temporal（编排重写为 DrawCommand）
    │   ├── ShadowPass.ts                 # sun-POV BSM（编排重写）
    │   ├── CascadedShadowMaps.ts         # 纯数学 split/frustum/matrix（近零改动搬）
    │   ├── CloudsMaterial.ts             # 主 march shader 组装（重写为 Cesium stage shader）
    │   ├── ShadowMaterial.ts             # BSM shader 组装
    │   ├── CloudsResolveMaterial.ts / ShadowResolveMaterial.ts
    │   ├── qualityPresets.ts             # low/medium/high/ultra（搬）
    │   ├── CloudLayers.ts                # 4 层云定义（altitude 750/1000/7500m，搬）
    │   ├── uniforms.ts                   # uniform 集合（搬，类型适配 Cesium）
    │   ├── weatherTextures.ts            # weather/shape/detail 噪声纹理加载（离线生成或搬）
    │   ├── cloudsConstants.ts            # 默认值常量（仿 lensFlareConstants）
    │   ├── createCloudsStage.ts          # 顶层工厂：编排 ShadowPass+CloudsPass+Resolve，接 atmosphere 链
    │   └── index.ts
    ├── package.json                      # 依赖 @cesium-geospatial/core (workspace:*)，cesium peerDep
    ├── tsconfig.json
    └── vite.config.ts
```

**依赖方向**（单向，无环）：`cesium-core` ← `cesium-clouds`。atmosphere 物理在 core 包内（实际演进），故 clouds 只依赖 core 即可拿到 Bruneton runtime + 基建。

### 4.2 两层划分

| 层 | 内容 | 来源 | 渲染器依赖 |
|---|---|---|---|
| **基建层**（core/platform） | FullscreenPass / FramebufferManager | 全新编写 | Cesium DrawCommand + 裸 WebGL2 |
| **GLSL 资产层**（clouds/glsl） | 19 个 clouds shader | 从 three-geospatial 搬，保持形态 | 无（纯 GLSL 数学） |
| **编排层**（clouds/*.ts） | CloudsPass/ShadowPass/Resolve 编排 + Material 组装 | 算法借鉴 three 版 Pass，胶水重写 | Cesium 基建层 |

**铁律**（继承 master plan §3.2）：GLSL 资产层不得出现 Cesium/Three 特有标识符；Three 内置 uniform（`cameraPosition` 等）在编排层用 `czm_*` 桥接。

### 4.3 集成点

`createCloudsStage(scene, options)` 产出云 stage 集合，接入 `createAtmosphereStage` 的 PostProcess 链：

```
[现有 atmosphere 链]
  depthTemporal?(off) → atmosphere → lensflare → tonemap
                          ↑
                  [云插入点]
  cloudsShadowPass → cloudsMainPass → cloudsResolve
       ↓ shadowLength 纹理
  atmosphere 的 shadow_length uniform（从 0 → BSM 采样）
```

云的 `shadowLength` 输出作为纹理 uniform 注入 atmosphere stage 的 `u_shadowLength`（当前常量 0 处）。云 overlay（`cloudsBuffer`）在 atmosphere 之前或合成阶段叠加（具体顺序 M6 定，参照 three 版 `cloudsEffect.frag` overlay + `aerialPerspectiveEffect` 合成）。

---

## 5. 数据流（渲染管线）

```
离线生成：weather / shape / shapeDetail / turbulence 噪声纹理（perlin/worley，~几 MB）
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  ShadowPass                    │
  (sun-POV 全屏 raymarch)       │
  cascade(i):                    │
    inverseShadowMatrices[i]     │
    → sunPosition(ECEF)          │
    rayDir = -sunDirection       │
    与云层球壳求交                │
    marchClouds() 采密度         │
    → BSM cascade layer i        │
  输出: TEXTURE_2D_ARRAY          │
    [frontDepth, meanExtinction, │
     maxOpticalDepth, tail]      │
        │                       │
        ▼                       ▼
  CloudsPass (主相机, 1/4 分辨率)
    ├ raymarch 云密度（weather+shape+detail）
    ├ Beer-Lambert(BSM) + powder（云自阴影）
    ├ getRayDistanceToScene(depthTexture) 截断（地形遮挡云）
    ├ marchShadowLength()：沿视线累加 BSM 遮挡 → shadowLength
    └ MRT 一次 draw 三附件：
       location 0 = vec4 color
       location 1 = vec3 depthVelocity (frontDepth + 2D velocity)
       location 2 = float shadowLength
        │
  Resolve (temporal)
    ├ history ping-pong（FramebufferManager）
    ├ velocity reprojection + variance clipping
    └ Bayer 4×4 jitter upscale → 全分辨率
        │
        ├──→ cloudsBuffer overlay → 合成进 atmosphere 链
        │
        └──→ shadowLength 纹理 → atmosphere u_shadowLength
              → Bruneton GetSkyRadianceToPoint(shadow_length)
              → 云 god rays（光柱）

  云投影地面（atmosphere 侧，读 globe depth）:
    重建地形片元 positionECEF → sampleShadowOpticalDepth(BSM)
    → sunTransmittance = exp(-opticalDepth) → 调制 sun/sky irradiance
```

---

## 6. 实施阶段（6 milestone，逐 pass 增量）

每阶段交付一个可视觉验收的结果，TDD（spec → plan → results）。阶段间有依赖（M1 基建 → M2+ 消费）。

### M1 — 基建 + 资产管线（含 MRT spike）

**范围**：跨 core + clouds 两包。
- **core**：`FullscreenPass`（DrawCommand 全屏三角）+ `FramebufferManager`（裸 WebGL2 FBO：MRT 多 attachment via `gl.drawBuffers`、`TEXTURE_2D_ARRAY` cascade 创建/采样、ping-pong history swap）。
- **clouds**：包骨架（package.json/tsconfig/vite）+ 搬 19 GLSL 到 `src/glsl/`（保持形态）+ core GLSL 依赖引用（噪声/raySphere/CSM 数学）+ `weatherTextures.ts`（weather/shape/detail 噪声纹理离线生成或搬）。
- **MRT spike（前置）**：在 Cesium frame loop 里用自管 Framebuffer + `gl.drawBuffers` 跑一个最小三附件全屏 pass，确认时机/清除/blend 正确、输出可被后续 stage 采样。**这是 M1 的第一件事，go/no-go**。

**验收**：
- MRT spike：三附件分别输出 R/G/B 纯色，截图确认三通道独立可读
- `glslang` 编译搬来的 19 GLSL（经 `resolveIncludes` 组装）
- 单测：`FramebufferManager` attachment 绑定、`TEXTURE_2D_ARRAY` cascade 层采样、`FullscreenPass` DrawCommand 装配
- tsc core + clouds 0 error

**风险**：若 MRT spike 失败（Cesium frame loop 不允许插入自管 FBO），回退方案 = 拆多 stage（color/depthVelocity/shadowLength 分三次单输出 draw，raymarch 跑三次）——性能差但可跑，作为 plan B 记录。

### M2 — 主 raymarch（无 shadow，flat lighting）

**范围**：`CloudsMaterial` + `CloudsPass` 主 march，搬 `clouds.frag` 主循环 + `clouds.glsl` weather/shape 采样，**不含 BSM 采样**（Beer-Lambert 项置 1）。含 `getRayDistanceToScene` 骨架但**暂用大气顶远截断**（不读 `depthTexture`——云可能穿地，M2 阶段容忍，M6 接通真实 depth）。

**验收**：demo `?clouds=1`（新 URL 参数）天空出现云形（无体积厚度，flat 灰白）；ECEF 大坐标下相机移动云稳定（密切球再中心化正确）；零回归（`?clouds=0` atmosphere bit 等价）。

### M3 — BSM + 云自阴影

**范围**：`ShadowMaterial` + `ShadowPass` + `CascadedShadowMaps`（CSM split/frustum/matrix），sun-POV 全屏 raymarch 生成 BSM（2D_ARRAY cascade），`CloudsMaterial` 接入 Beer-Lambert + powder。

**验收**：demo 云有体积厚度/层次（云内部明暗，迎光面亮背光面暗）；多 cascade 在不同距离云上覆盖一致（无接缝）。

### M4 — temporal resolve

**范围**：`CloudsResolveMaterial` + history ping-pong + velocity reprojection + variance clipping + Bayer 4×4 jitter（1/4 分渲染 → 全分 upscale）。

**验收**：demo 云边缘干净（无 noise banding）；动态相机拖影可接受（motion-gating，参照本项目 depthTemporal EMA 经验）；1/4 分下静态画面收敛到接近全分质量。

### M5 — 云 god rays

**范围**：`marchShadowLength`（`clouds.frag:622` 沿视线累加 BSM）输出 `shadowLength` → 注入 atmosphere `u_shadowLength` uniform → Bruneton `GetSkyRadianceToPoint(shadow_length)` 产生光柱。

**验收**：demo 朝太阳方向云间出现体积光柱；`debug` probe 隔离 shadowLength 量级合理；与 god rays 历史失败对比（同心波纹应消失——因 shadow 源是 BSM 而非 screen-space 地形 depth）。

### M6 — 地形交互 + 质量预设 + 集成

**范围**：
- 云投影地面阴影（atmosphere 侧读 globe depth + 采样 BSM → 调制 sun/sky irradiance）
- 地形遮挡云（`getRayDistanceToScene` 接通真实 `depthTexture` 截断——M2 暂用大气顶远截断，此处换为真实地形 depth，云不再穿地）
- `qualityPresets.ts`（low/medium/high/ultra，搬）+ `createCloudsStage` 完整工厂 + 接 `createAtmosphereStage` 链 + demo URL 参数（`?clouds=`/`?cloudsQuality=`/`?cloudsLightShafts=` 等）

**验收**：demo 地表有云投下的影子（随云移动）；山体遮住云的底部/挡住阳光照云；low/medium/high 三档帧率与视觉对比（桌面 high ≥ 60fps 目标）；完整零回归。

### 阶段拆分与 plan 策略

体积云规模 ~6500 行（远超 god rays ~1200 / lensflare），**一个总 plan 不现实**。本 spec 为**总设计**（架构/数据流/选型/风险/6 阶段概览），实施按 **每 milestone 一个独立 plan**（`plans/2026-08-13-clouds-m1-platform.md` … `m6-integration.md`），每个 plan 走自己的 plan→results→多专家评审→TDD 循环。M1（基建 + MRT spike）是后续所有 milestone 的依赖，先行；**M1 spike go/no-go 通过后再铺 M2+**（若 MRT 自管 RT 不可行，整个路线回退 plan B 重新评估）。

---

## 7. 关键技术选型

| 选型点 | 选择 | 理由 |
|---|---|---|
| **MRT** | 自管 RT（DrawCommand + 裸 WebGL2 Framebuffer 多附件，`gl.drawBuffers`） | raymarch 重，三通道必须一次 draw；拆多 stage = 3× 成本不可接受 |
| **BSM 纹理** | `TEXTURE_2D_ARRAY`（每层一个 cascade） | cascade 各层独立、不插值；非 Texture3D（体积采样） |
| **atmosphere** | 复用本项目 Bruneton runtime | `shadow_length` 钩子已串好（当前 0），零改动 |
| **temporal** | 1/4 分 + 16 帧 Bayer 累积 + variance clipping | three 版跑得动的核心；FramebufferManager ping-pong |
| **GLSL 资产** | 从 three-geospatial 搬 19 文件，保持形态 | `#include` 走 `resolveIncludes`，便于上游 diff |
| **CSM 数学** | 直接搬 `CascadedShadowMaps.ts`（纯 TS） | 渲染器无关 |
| **云层定义** | 搬 `CloudLayers.ts`（4 层，750/1000/7500m） | 物理参数，无需改 |
| **质量预设** | 搬 `qualityPresets.ts`（low/medium/high/ultra） | 默认 high（lightShafts on） |

`qualityPresets` 档位（搬自 three 版，`qualityPresets.ts:59`）：

| 档 | lightShafts | shapeDetail | maxIter | minStep | shadow.cascade | shadow.mapSize | shadow.maxIter |
|---|---|---|---|---|---|---|---|
| low | off | off | 200 | 100 | 2 | 256 | 25 |
| medium | off | turbulence off | 500 | 50 | 3 | 256 | 50 |
| **high(默认)** | **on** | on | 500 | 50 | 3 | 512 | 50 |
| ultra | on | on | 500 | 10 | 3 | 1024 | 50 |

---

## 8. 资产映射（three-geospatial → 本项目）

| 源（three-geospatial clouds） | 本项目 | 处理 |
|---|---|---|
| `src/shaders/*.glsl`（19 个） | `cesium-clouds/src/glsl/` | 搬，保持形态；`#include` 改走本项目 `resolveIncludes` |
| `CloudsPass.ts` | `cesium-clouds/src/CloudsPass.ts` | 编排借鉴，胶水重写为 DrawCommand + FramebufferManager |
| `ShadowPass.ts` | `cesium-clouds/src/ShadowPass.ts` | 同上（sun-POV BSM） |
| `CascadedShadowMaps.ts` | 同名 | 纯数学，近零改动搬 |
| `CloudsMaterial.ts` / `ShadowMaterial.ts` | 同名 | `RawShaderMaterial` → Cesium stage shader（`buildXxxFragmentShader` 模式，仿 `aerialPerspective.frag.ts`） |
| `CloudsResolveMaterial.ts` / `ShadowResolveMaterial.ts` | 同名 | 同上 |
| `qualityPresets.ts` / `CloudLayers.ts` / `uniforms.ts` | 同名 | 搬，类型适配 Cesium |
| `postprocessing` 的 `Effect`/`ShaderPass`/`Resolution` | — | 不搬，换 Cesium `createCloudsStage` + DrawCommand |
| `WebGLRenderTarget`/`WebGLArrayRenderTarget`/`DataArrayTexture` | `FramebufferManager`（core/platform） | 重写为裸 WebGL2 FBO + `TEXTURE_2D_ARRAY` |
| `@takram/three-atmosphere` Bruneton | 本项目 `cesium-core` Bruneton runtime（已有） | 不搬，桥接 `shadow_length` 钩子 |
| `@takram/three-geospatial` core GLSL（噪声等） | `cesium-core/src/glsl/`（部分已有） | 搬缺失的（perlin/worley 等若 core 没有） |

---

## 9. 风险与对策

| # | 风险 | 严重度 | 对策 | 阶段 |
|---|---|---|---|---|
| **R1** | MRT 自管 RT 无法插入 Cesium frame loop（PostProcessStage 框架限制） | **致命** | M1 早期 spike go/no-go；plan B = 拆多 stage（3× raymarch，性能差但可跑） | M1 |
| **R2** | ECEF 大坐标（相机 6.4e6 m）单精度失效，云 raymarch 抖动 | **致命** | 密切球再中心化 + 高度校正（复用本项目 `getAltitudeCorrectionOffset` / Ellipsoid） | M2 |
| **R3** | temporal jitter 与 Cesium `requestRenderMode` 冲突（云须每帧） | 高 | 云激活时强制每帧渲染（关 requestRenderMode 或 `scene.requestRenderMode = false`） | M4 |
| **R4** | weather 噪声纹理资产缺失 | 中 | 离线生成 perlin/worley（Node 脚本输出 `.bin`，仿 LUT 加载）；或搬 three 版生成器 | M1 |
| **R5** | 2D_ARRAY 在 Cesium Context 的创建/绑定路径未验证 | 中 | M1 spike 一并验证（与 R1 同）；参照已有 `Texture3D._target` 绑定经验（`cesiumTextures.ts`） | M1 |
| **R6** | atmosphere `shadow_length` 接口语义与 clouds `shadowLength` 单位/量级不匹配 | 中 | M5 核实 `marchShadowLength` 输出单位（km? m?）与 Bruneton `shadow_length`（`m`）对齐；参照 god rays spec r2 单位 1000× 教训 | M5 |
| **R7** | 性能（high 档桌面 60fps 目标） | 中 | 1/4 分 + temporal 是核心；profile 用现有 `StageGpuTimer`（`EXT_disjoint_timer_query_webgl2`）逐 pass 计时 | M4/M6 |
| **R8** | 云 overlay 与 atmosphere 合成顺序/blend 错误（云太亮/穿透地形） | 中 | 参照 three 版 `cloudsEffect.frag` + `aerialPerspectiveEffect` 合成；depth 截断保证云不穿地 | M6 |

---

## 10. 测试策略

### 10.1 GLSL 编译测试
照搬 `aerialPerspective.compile.test.ts` 范式（`glslangValidator`，两构建入口）：
- **运行时入口**：供 Cesium 运行时（引用 `czm_*` / `out_FragColor` / `v_textureCoordinates`，无 `#version`）
- **校验入口**：`buildStandaloneShaderForValidation()`，补 `#version 300 es` + `czm_*`/drawBuffers 桩声明
- 19 个搬来的 shader + 编排层组装的 CloudsPass/ShadowPass/Resolve shader 都过

### 10.2 TS 单元测试（vitest）
- `CascadedShadowMaps`：split/frustum/matrix 数学（照搬 three 版测试基线）
- `FramebufferManager`：MRT attachment 绑定、`TEXTURE_2D_ARRAY` cascade 创建/层采样、ping-pong swap
- `FullscreenPass`：DrawCommand 装配
- `weatherTextures`：噪声纹理加载/解析
- `qualityPresets`：档位参数完整性
- `createCloudsStage`：装配/制服/生命周期/option 透传（仿 `AtmosphereStage.test.ts` 范式）

### 10.3 零回归测试
`clouds` 关闭时 atmosphere 链 bit 等价（仿 lensflare `?lensflare=0` 范式）：`createCloudsStage` 默认 `clouds: false` 时 stage 不创建、`u_shadowLength` 保持常量 0。

### 10.4 视觉验收（demo URL）
每阶段一个验收 URL（`?mode=atmosphere&clouds=1&cloudsQuality=high&...`），debug-probe shader（`u_debugMode` 扩展）隔离失效物理量——继承本项目递进式 debug 方法论。

---

## 11. 待确认事项（实现中据实定，不阻塞 spec）

- **weather 资产来源**：离线 Node 脚本生成（倾向）还是搬 three 版生成器？→ M1 启动时定。
- **Cesium 具体版本的 MRT/2D_ARRAY 支持度**：M1 spike 确认（当前项目用的 Cesium 版本应已支持 WebGL2 全特性，spike 验证）。
- **云 overlay 与 atmosphere 合成的精确插入点**：M6 据视觉验收定（atmosphere 前 vs 合成阶段）。
- **默认质量档**：倾向 high（对标 three 版默认，lightShafts on）；若桌面主流帧率不达标降 medium 默认。
- **god rays 与历史 phase2c-god-rays branch 的关系**：本路线（云 BSM 驱动）与 phase2c 的 screen-space 路线完全不同，不复用其代码；phase2c branch 保留作历史参考。

---

## 12. 成功标准

- **M1**：MRT spike 过（三附件独立可读）+ 19 GLSL glslang 编译 + 基建单测绿
- **M2-M6**：每阶段 demo 视觉验收通过 + 零回归
- **全程**：GLSL 资产保持渲染器无关（无 `czm_*` 污染 `clouds/glsl/`）；CI glslang 编译通过；high 档桌面 ≥ 60fps
- **终极**：4 个效果（云自阴影 / 云投影地面 / 地形遮挡云 / 云 god rays）全部可验收，god rays 经此路线复活
