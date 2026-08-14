# 体积云 M2 — 主 raymarch（three clouds.frag → Cesium 桥接）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。Steps use checkbox (`- [ ]`)。

**Goal:** 移植 three-geospatial `clouds.frag` 主 march 到 Cesium，出"能看的云"（flat lighting，无自阴影），为 M3（BSM 自阴影）/M4（temporal）/M5（god rays）铺路。

**Architecture:** `clouds.frag` 是完整 three.js shader（three varying + uniform + 完整 main 含 shadow/haze/aerial/temporal 交织）。M2 核心 = **three → Cesium 桥接**：uniform 桥接（`viewMatrix`→`czm_view`、`cameraNear/Far`→`czm_currentFrustum`、`cameraPosition`→`czm_viewerPositionWC`、`reprojectionMatrix`/`viewReprojectionMatrix`→手动 prevVP、`depthBuffer`→globe depthTexture）、varying 桥接（`vUv`←`v_textureCoordinates`、`vCameraPosition`/`vRayDirection`/`vViewPosition` 在 fragment 从 czm 重建）、跨包 `#include`（M1 T7 机制 + 兼容桩）、dummy 化 M3/M4/M5 项（shadowBuffer 全 0 = Beer-Lambert 1、SHADOW_LENGTH/HAZE 不 define、reprojection dummy velocity=0）。用 M1 基建（VolumetricPrimitive + FramebufferManager）。

**Tech Stack:** TypeScript 5.9 / Cesium WebGL2 / vitest / glslangValidator / clouds 包（M1 已搬 21 GLSL + 跨包 #include + glslang 16/16）。

## Global Constraints

- **three → Cesium 桥接铁律**：clouds.frag 不得直接改（保持 three 版形态便于上游 diff），桥接在编排层（`buildCloudsMainFragmentShader` 注入桥接 prefix + varying 重建）。
- **M2 范围严格**：无 BSM（shadowBuffer dummy 全 0 = Beer 1）、无 SHADOW_LENGTH（不 define）、无 HAZE（不 define）、temporal velocity=0（reprojection dummy，M4 接通）、getRayDistanceToScene 大气顶远截断（不读 globe depth，M6 接通 + log-depth 转换）。
- GLSL 资产层无 czm_*/Three 标识符（铁律）；桥接在编排层 prefix。
- 中文注释；TDD（glslang compile + vitest 装配 + demo 视觉验收）；零回归（`?clouds` 不传时 atmosphere 不变）。

## File Structure

**新建（clouds 包）**：
- `src/CloudsMaterial.ts` — `buildCloudsMainFragmentShader(options)` 组装 + `buildStandaloneCloudsShaderForValidation()` 校验入口（仿 core `aerialPerspective.frag.ts` 双入口）
- `src/CloudsMaterial.test.ts` / `src/cloudsMain.compile.test.ts`
- `src/CloudsPass.ts` — VolumetricPrimitive + FramebufferManager MRT + uniform 注入
- `src/CloudsPass.test.ts`
- `src/createCloudsStage.ts` — 顶层工厂 + 接 atmosphere 链 + czm 桥接
- `src/createCloudsStage.test.ts`

**修改**：
- `src/index.ts` — export 上述
- `apps/demo/src/main.ts` — `?clouds=1` 接线

---

## Task 1: `buildCloudsMainFragmentShader` + three→Cesium 桥接 + compile

**核心难点**：clouds.frag 是完整 three shader。需写桥接 prefix 注入 + varying 重建，让 clouds.frag 在 Cesium VolumetricPrimitive（viewport quad vertex）下跑。

**Files:**
- Create: `clouds/src/CloudsMaterial.ts`、`clouds/src/cloudsMain.compile.test.ts`
- 读（理解桥接需求）：`clouds/src/glsl/clouds.frag`（main + marchClouds 调用 + varying 用法）、`clouds/glsl/clouds.vert`（varying 计算逻辑——决定 fragment 重建方式）、`clouds/glsl/clouds.glsl`（sampleWeather/sampleShape）

**Interfaces:**
- Consumes: M1 `resolveCloudsIncludes`/`cloudsShaderAssembler`、core `buildAtmospherePrefix`/`getAltitudeCorrectionOffset`
- Produces: `buildCloudsMainFragmentShader(options): string`（运行时 Cesium shader）、`buildStandaloneCloudsShaderForValidation(options): string`（glslang 校验，补 #version + czm_*/sampler/drawBuffers 桩）

**桥接设计（实施时读 clouds.frag/clouds.vert 确认）**：
- **varying 重建**：clouds.frag 用 `vUv`/`vCameraPosition`/`vCameraDirection`/`vRayDirection`/`vViewPosition`（clouds.vert 算）。Cesium viewport quad 只有 `v_textureCoordinates`。桥接：prefix 注入这些 varying 的定义 + 在 fragment main 前从 `czm_viewerPositionWC`/`czm_inverseView`/`czm_inverseProjection` + `v_textureCoordinates` 重建（不依赖 clouds.vert）。或保留 clouds.vert（Cesium vertex 阶段用）。
- **uniform 桥接**：`viewMatrix`→`czm_view`、`inverseViewMatrix`→`czm_inverseView`、`cameraNear/Far`→`czm_currentFrustum.xy`、`cameraPosition`(ECEF)→`czm_viewerPositionWC` + `getAltitudeCorrectionOffset`、`reprojectionMatrix`/`viewReprojectionMatrix`→手动 prevVP（M2 dummy 单位矩阵 velocity=0）、`depthBuffer`→globe depthTexture（M2 不读，getRayDistanceToScene 远截断）、`shadowBuffer`→dummy sampler2DArray 全 0（M2 Beer 1）、sun/weather/shape/shapeDetail/scatter 参数→option 注入。
- **MRT 输出**：clouds.frag `outputColor`(location0)/`outputDepthVelocity`(location1)/`outputShadowLength`(location2 `#ifdef SHADOW_LENGTH`)。M2 不 define SHADOW_LENGTH → 只 location0/1（location1 velocity=0 dummy，M4 接通）。
- **`#include`**：clouds.frag 的 `<common>`/`<packing>`（M1 兼容桩）+ `core/*`（core GLSL）+ `atmosphere/bruneton/*`（跨包别名）+ `types`/`parameters`/`clouds`（clouds 本地）。resolveCloudsIncludes 处理。

- [ ] **Step 1: 读 clouds.frag main（找 marchClouds 调用 + varying/uniform 用法）+ clouds.vert（varying 计算）+ clouds.glsl（采样），确认桥接细节**
- [ ] **Step 2: 写 buildCloudsMainFragmentShader（桥接 prefix + varying 重建 + uniform 桥接 + #include clouds.frag）**
- [ ] **Step 3: 写 buildStandaloneCloudsShaderForValidation（补 #version 300 es + czm_*/sampler/drawBuffers 桩）**
- [ ] **Step 4: 写 cloudsMain.compile.test（glslang 编译，仿 core aerialPerspective.compile.test + clouds clouds.compile.test 双套桩）**
- [ ] **Step 5: glslang 编译过 + tsc + commit**

> **风险**：clouds.frag main 与 shadow/haze/aerial/temporal 交织，dummy 化可能引入编译错（undefined macro/函数）。实施时可能需 define 占位（如 `#define HAZE`/`#undef`）或拆分。若 clouds.frag 完整 main 难 dummy 化，回退方案 = 写简化 M2 main（调 `marchClouds` + flat color，#include clouds.frag 的函数体——需拆 clouds.frag 为库+main）。

---

## Task 2: CloudsPass（VolumetricPrimitive + MRT + uniform 注入）

**Files:** `clouds/src/CloudsPass.ts` + test
**Interfaces:** Consumes M1 `VolumetricPrimitive`/`FramebufferManager`/`FullscreenPass` + T1 `buildCloudsMainFragmentShader` + `loadWeatherTextures`；Produces `CloudsPass`（持 primitive + MRT textures + uniformMap，update/destroy）

- [ ] 创建 3 MRT texture（color/depthVelocity/shadowLength，M2 用 UNSIGNED_BYTE 或 HalfFloat）+ VolumetricPrimitive（fragmentShader=buildCloudsMainFragmentShader, mrtColorTextures, globeDepthTexture 闭包）
- [ ] uniformMap 注入（atmosphere LUT 从 createAtmosphereStage 共享 / weather shape/shapeDetail / camera/sun / scatter 参数 / dummy shadowBuffer / dummy reprojection）
- [ ] 单测（装配 + uniform 注入 + destroy，仿 AtmosphereStage.test mock）+ commit

---

## Task 3: createCloudsStage（顶层工厂 + 接链 + czm 桥接）

**Files:** `clouds/src/createCloudsStage.ts` + test
**Interfaces:** Produces `createCloudsStage(scene, luts, weather, options)` → 编排 CloudsPass + 接 createAtmosphereStage PostProcess 链（cloudsBuffer overlay 在 atmosphere 之后 via bridge）

- [ ] createCloudsStage 工厂（CloudsPass + cloudsBuffer bridge → atmosphere 或独立 overlay stage）
- [ ] czm 桥接明细（spec r1 §4.2 表）：reprojectionMatrix/viewReprojectionMatrix 手动（postRender 写本帧 preRender 读，仿 AtmosphereStage prevViewProjection）、temporalJitter（Bayer）、shadowMatrices（M3，M2 dummy）
- [ ] option 透传 + 零回归（clouds:false 时不创建）+ 单测 + commit

---

## Task 4: demo 接线 + 验收

**Files:** `apps/demo/src/main.ts`
- [ ] `?clouds=1` → loadWeatherTextures + createCloudsStage + 接 atmosphere
- [ ] 验收 URL：`?mode=atmosphere&clouds=1`（天空有云形 flat lighting；相机移动稳定 ECEF；零回归 `?clouds` 不传时 atmosphere 不变）
- [ ] debug probe（u_debugMode 扩展：云 density 可视化）+ commit

---

## Task 5: M2 results + 全量回归

- [ ] results 文档（主 march 落地 + flat 云形 + ECEF 稳定 + 零回归 + three→Cesium 桥接经验 + M3 启动前置）+ 全量回归（core+clouds test + tsc）+ commit

---

## Self-Review

**1. Spec coverage（spec r1 §6 M2）**：搬 clouds.frag 主 march（T1）+ weather/shape 采样（T1 #include）+ Beer 置 1 无 BSM（T1 dummy shadowBuffer）+ getRayDistanceToScene 远截断（T1）+ log-depth 转换（T1/M6）+ VolumetricPrimitive（T2）+ ECEF 密切球（T1 getAltitudeCorrectionOffset）+ demo 验收（T4）。✓

**2. 风险（M2 真实复杂度）**：spec r1 §6 M2 乐观假设"搬 clouds.frag 主循环"，实际 clouds.frag 是完整 three shader，three→Cesium 桥接（varying/uniform/#include/dummy 化）是核心挑战。T1 标注风险 + 回退方案（简化 main 或拆 clouds.frag）。**建议 T1 完成后视桥接复杂度决定是否多专家评审 T1 shader**（像 M1 spec 评审）。

**3. Scope check**：M2 严格无 shadow/temporal/god rays（M3/M4/M5），dummy 化这些项。flat lighting = 无 BSM 自阴影（Beer 1）。

**4. 依赖**：M1 基建（VolumetricPrimitive/FramebufferManager）+ GLSL（21 + 跨包 include）+ LUT（higher-order）+ weather（shape/shape_detail）全 ready。
