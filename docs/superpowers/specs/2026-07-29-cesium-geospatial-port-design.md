# three-geospatial → CesiumJS 原生注入移植 · 设计文档

> **状态**：已通过 brainstorming 决策，待 writing-plans 拆解为实施计划
> **日期**：2026-07-29
> **源仓库**：`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`（takram-design-engineering/three-geospatial，Three.js / R3F，WebGL 版）
> **目标仓库**：`/Users/zhangliyun/Desktop/cesium-geospatial`（本仓库，从零搭建）
> **背景文档**：`/Users/zhangliyun/Desktop/three-geospatial-CesiumJS移植-交接文档.md`（含三方分析全文，本文档不再重复其论据）

---

## 1. 决策摘要

| 决策点 | 选择 | 说明 |
|---|---|---|
| **D1 渲染路径** | Cesium 原生注入（不引入 Three 渲染器） | 用 Primitive/DrawCommand/PostProcessStage 重建渲染层，产物为纯 Cesium 插件 |
| **D2 范围** | 全范围支持 | 大气散射全套 + 体积云 + 后期处理链，全做 |
| **起步策略** | 先搭骨架 + Phase 0 验证 | 深度/多视锥语义是 go/no-go 前提，先钉死再铺开 |
| **包结构** | monorepo 多包（照搬源仓库结构） | `packages/cesium-{core,atmosphere,clouds,effects}` + demo app |
| **平台** | WebGL2（无 WebGPU，无 compute shader） | 锁定 Cesium WebGL2 上下文 |

**核心判断（来自交接文档，本项目采纳）**：算法（Bruneton GLSL、体积云 raymarch、UE4 光晕）是干净可搬资产；硬仗集中在四块基建的重建——深度/多视锥语义、法线缺失、HDR 对接、temporal 框架；其中 **ECEF 大坐标浮点精度 + 深度重建是算法正确性根基，必须 Phase 0 钉死**。

---

## 2. 目标与非目标

### 2.1 目标
1. 在 CesiumJS（WebGL2）场景中复现 three-geospatial 的三套渲染效果：大气散射全套、体积云、后期处理链。
2. 产物为**独立 Cesium 插件包**，不 fork Cesium 源码，命令式 API（`new CesiumAtmospherePlugin(viewer, opts)` / `.destroy()`）。
3. GLSL 资产保持渲染器无关的 Bruneton 原始形态，仅 uniform 绑定层为 Cesium 特有，便于将来与上游 GLSL 更新干净 diff。
4. 关掉插件后 Cesium 原生场景无损（可热插拔）。

### 2.2 非目标（明确不做）
- **不引入 Three.js 渲染器**（D1 锁定）。双渲染器叠加方案不在本项目范围。
- **不 fork Cesium 源码**。globe/3D Tiles 的 MRT 法线注入属 fork 级改动，明确放弃，改走深度重建法线。
- **不做 WebGPU 路径**。源仓库的 `src/webgpu/` 不移植。
- **不移植 R3F（React）层**。Cesium 侧用命令式插件 API 取代声明式 R3F 封装。
- **不做上游同步机制**。源仓库 WebGL 版将归档，本项目成为 GLSL 的新单一份事实。

---

## 3. 整体架构

### 3.1 包结构与依赖

```
cesium-geospatial/                      # 本仓库根
├── packages/
│   ├── cesium-core/                    # 渲染器无关层 + Cesium 集成基建
│   │   ├── src/
│   │   │   ├── glsl/                   # GLSL 源文件（.glsl，从源仓库搬，保持原始形态）
│   │   │   │   ├── math.glsl packing.glsl depth.glsl transform.glsl
│   │   │   │   ├── raySphereIntersection.glsl cascadedShadowMaps.glsl
│   │   │   │   ├── interleavedGradientNoise.glsl generators.glsl
│   │   │   │   ├── turbo.glsl vogelDisk.glsl
│   │   │   │   └── bruneton/{definitions,common,runtime,precompute}.glsl
│   │   │   ├── glslIndex.ts            # ?raw 导出全部 GLSL（等价源仓库 shaders/index.ts）
│   │   │   ├── resolveIncludes.ts      # 从源仓库搬，零改动
│   │   │   ├── unrollLoops.ts          # 从源仓库搬，零改动
│   │   │   ├── math/                   # 纯数学（用 Cesium 原生 Cartesian3/Matrix4 重写，非搬 three 版）
│   │   │   │   ├── Ellipsoid.ts        # WGS84、密切球中心、ENU（薄封装 Cesium Ellipsoid）
│   │   │   │   ├── celestialDirections.ts  # 从源仓库搬（astronomy-engine）
│   │   │   │   └── ...
│   │   │   ├── cesium/                 # Cesium 集成基建（"迷你 Three"重建层）
│   │   │   │   ├── FullscreenPass.ts       # 全屏三角形 DrawCommand 封装
│   │   │   │   ├── FramebufferManager.ts   # FBO 池 + ping-pong（替代 WebGLRenderTarget）
│   │   │   │   ├── UniformBridge.ts        # three uniform 名 → czm_* 的桥接
│   │   │   │   ├── depthReconstruction.ts  # czm_* 多视锥深度→世界坐标（重写 reverseLogDepth）
│   │   │   │   └── CesiumTextureHelper.ts  # 3D/half-float 纹理创建（含裸 gl.texImage3D 回退）
│   │   │   └── index.ts
│   │   └── vite.config.ts
│   ├── cesium-atmosphere/              # 大气散射（依赖 cesium-core）
│   │   └── src/{SkyPrimitive, AerialPerspectiveStage, AtmosphereParameters,
│   │          PrecomputedTexturesLoader, PrecomputedTexturesGenerator, getSunLightColor,
│   │          CesiumAtmospherePlugin, ...}.ts
│   ├── cesium-clouds/                  # 体积云（依赖 core + atmosphere）
│   │   └── src/{CloudsPrimitive, CloudsPass, ShadowPass, CascadedShadowMaps,
│   │          CloudsMaterial, qualityPresets, CesiumCloudsPlugin, ...}.ts
│   └── cesium-effects/                 # 后期链（依赖 core）
│       └── src/{LensFlareStage, DepthStage, NormalStage, DitheringStage, ...}.ts
├── apps/
│   └── demo/                           # Cesium 演示应用（Phase 0 spike 载体 + 长期验证对照）
│       └── src/{main.ts, index.html, ...}
├── package.json                        # pnpm workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── nx.json
└── docs/
```

**依赖方向**（单向，无环）：
`cesium-core` ← `cesium-atmosphere` ← `cesium-clouds`
`cesium-core` ← `cesium-effects`
`apps/demo` → 全部包

### 3.2 渲染器无关层 vs Cesium 适配层（关键边界）

本项目把代码严格分两层，对应交接文档的 L0/L1（可搬）与 L2（重写）：

| 层 | 内容 | 来源 | 渲染器依赖 |
|---|---|---|---|
| **GLSL 资产层** | bruneton 四件套 + core 10 个 .glsl 模块 | 从源仓库搬，保持 Bruneton 原始形态 | 无（纯 GLSL 数学） |
| **GLSL 组装工具** | `resolveIncludes` + `unrollLoops` | 从源仓库搬，零改动 | 无（纯 JS 字符串处理） |
| **纯数学层** | Ellipsoid/Geodetic/密切球/celestialDirections | 搬算法，类型换 Cesium 原生 | 仅 Cesium 数学类型 |
| **Cesium 适配层** | FullscreenPass/FramebufferManager/UniformBridge/depthReconstruction | **全新编写** | Cesium DrawCommand/Framebuffer/czm_* |
| **效果层** | Sky/AerialPerspective/Clouds/LensFlare 的 Primitive/Stage | 编排逻辑借鉴源仓库 Pass，胶水重写 | Cesium 适配层 |

**铁律**：GLSL 资产层与组装工具**不得**出现任何 Cesium 或 Three 特有的标识符。对 Three 内置 uniform（`cameraPosition`/`projectionMatrix`/`viewMatrix`/`inverseViewMatrix`）的隐式依赖，统一在 **Cesium 适配层的 UniformBridge** 用文本替换或 `#define` 注入映射到 `czm_*`，保持 GLSL 源码干净。

### 3.3 GLSL 资产策略（单一份事实）

- `.glsl` 文件从源仓库 `packages/{core,atmosphere}/src/shaders/` 拷贝到本仓库 `packages/cesium-core/src/glsl/`，**保持文件名与内容不变**（含 Bruneton 版权头）。
- 通过 `?raw` 导入 + `resolveIncludes` 组装，与源仓库机制一致。
- 这样将来若源仓库 GLSL 有修复，`diff` 干净，可 cherry-pick；同时本项目成为上游归档后的唯一事实。
- Phase 4 增加 **CI GLSL 编译校验**：`resolveIncludes` 组装后在 Cesium `ShaderProgram` 下编译通过，防止编辑引入渲染器耦合。

### 3.4 Cesium 集成基建（需自建的"迷你 Three"）

交接文档估算约 **200–300 行**的 pass 管理器即可覆盖。本设计在 `cesium-core/cesium/` 下提供以下基建，供所有效果包复用：

| 基建 | 对应 Three 物 | 用途 |
|---|---|---|
| `FullscreenPass` | `ShaderPass` + 全屏 quad | 单次全屏 fragment shader 执行（DrawCommand + 全屏三角形） |
| `FramebufferManager` | `WebGLRenderTarget` 池 + ping-pong | 离屏多 pass、history 缓冲、半分辨率纹理 |
| `UniformBridge` | `onBeforeCompile` / 内置 uniform | three uniform 名 → `czm_*` / `uniformMap` 桥接 |
| `depthReconstruction` | `reverseLogDepth` + 视空间重建 | **重写**：czm 多视锥分段深度 → 世界坐标（go/no-go 核心） |
| `CesiumTextureHelper` | `WebGL3DRenderTarget` / DataTexture | 3D 纹理、half-float LUT；Cesium 封装不全时回退裸 `gl.texImage3D` |

**关键优势**（交接文档 §4.2-5）：本项目的 DrawCommand 与 Cesium 跑在**同一 WebGL2 context**（`frameState.context`），3D 纹理/half-float LUT 可直接共享，无跨 context 问题。相机矩阵由 `czm_view`/`czm_inverseView`/`czm_viewerPositionWC` 自动提供，**比 Three 侧少一层变换**（Cesium world 即 ECEF）。

---

## 4. 分阶段路线

总体遵循交接文档 §5.4 的双轨验证思路，但 D1 已锁定原生注入，故**轨 B（双渲染器对照）不纳入主线**（仅在 Phase 3 体积云进入前视需要重新评估），主线走原生注入单轨。

### Phase 0 — 原生注入验证 spike（go/no-go，首要）
**目标**：用最小 demo 钉死三件事，任一失败则需重新评估路径。
1. 源仓库 GLSL 经 `resolveIncludes` 组装后，在 Cesium `ShaderProgram`（GLSL3）下**编译通过**。
2. Cesium `depthTexture` → 世界坐标重建与源仓库数值一致（**深度语义是 go/no-go**）。
3. ECEF 相机桥接 + 密切球再中心化正确（领域首要风险）。
**产出**：`apps/demo` 下一个 Cesium app + 一个天空 PostProcessStage（bruneton runtime + LUT 采样），与 three 版 Sky-Basic 同机位截图比对；一个深度重建可视化 stage。
**决策门**：三项全过 → 进 Phase 1；深度重建走不通 → 回头评估（含重新考虑双渲染器）。

### Phase 1 — 大气散射 MVP（低风险先行）
- LUT 加载预计算文件（`PrecomputedTexturesLoader` 格式从源仓库搬 + `@petamoriken/float16` 解码）。
- Sky Primitive（替换 `scene.skyAtmosphere`/`skyBox`/`sun`，禁深度写）。
- 大气透视 `PostProcessStage`（法线走深度重建路径）。
- 太阳方向由 Cesium `JulianDate` 驱动（复用 `celestialDirections.ts`）。
**验证**：日出/日落/太空俯视三场景与 three 版视觉对齐；插件关闭后 Cesium 原生场景无损。

### Phase 2 — 后期链
- Dithering / LensFlare 移植为 `PostProcessStage` / `PostProcessStageComposite`。
- 对接 Cesium HDR（`scene.highDynamicRange`）与 ToneMapping 顺序（大气/光晕必须在 tone mapping 之前的线性 radiance 域）。
- Depth/Normal 调试 stage（可选）。
**产出**：大气完整、云未上的可发布版本。

### Phase 3 — 体积云（最大工程，进入前重新决策）
- 自写离屏 pass 管理器（`FullscreenPass` + `FramebufferManager`）。
- 半分辨率 raymarch（`clouds.frag` GLSL 基本不动）+ MRT（color/depthVelocity/shadowLength）。
- `CascadedShadowMaps`（多级 DrawCommand 渲纹理数组）。
- temporal resolve（history ping-pong）→ 合成 stage 叠加。
- 处理 `requestRenderMode` 冲突（云必须每帧渲染或关闭按需渲染）。
**验证**：低/中/高质量预设（`qualityPresets.ts`）下视觉 + 帧率对比 three 版。

### Phase 4 — 硬化
- 多视锥/对数深度正式兼容（Phase 0 若回避则此阶段补齐）。
- 性能调优（半分辨率、步进参数）。
- 类型、文档、CI GLSL 编译校验。

---

## 5. Phase 0 详细设计

### 5.1 范围（最小可验证）
仅做"天空 + 深度重建可视化"两件事，不碰云、不碰 aerial perspective 完整逻辑、不碰 HDR。LUT 用预计算文件加载（若无现成文件，则先用一组 DrawCommand 预计算最小 LUT，或临时降级为 CPU 预计算）。

### 5.2 实现要点
1. **骨架**：pnpm workspace + `cesium-core` 骨架（含 GLSL 资产、组装工具、Cesium 基建雏形）+ `apps/demo`（Vite + Cesium Viewer）。
2. **GLSL 编译验证**：把 bruneton `runtime.glsl` + `common.glsl` + `definitions.glsl` + core `math.glsl`/`raySphereIntersection.glsl` 用 `resolveIncludes` 组装，包进一个全屏 PostProcessStage 的 fragmentShader，挂最小 uniform（相机 ECEF 位置、sun direction、transmittance/scattering LUT）。目标：Cesium 编译通过、无报错。
3. **uniform 桥接**：`UniformBridge` 把源仓库 GLSL 里的 `cameraPosition` 等映射到 `czm_viewerPositionWC`，验证桥接正确。
4. **深度重建验证 stage**：一个独立 PostProcessStage 读 `depthTexture`，用 `czm_*`（`czm_inverseProjection`/`czm_inverseView`/`czm_currentFrustum` 或等效）重建世界坐标，输出可视化的线性深度/世界坐标分量。与源仓库 `reverseLogDepth` 单视锥结果对比，确认多视锥分段重建正确、接缝无瑕疵。
5. **ECEF 桥接验证**：相机位置直接取 `czm_viewerPositionWC`（已是 ECEF 米），用 `Ellipsoid.getOsculatingSphereCenter`（密切球）做再中心化，确认采样点落在以相机为局部原点的球坐标系、量级 ≤ 大气顶半径，无全屏抖动。
6. **MVP 渲染设置**：`viewer.scene.logarithmicDepthBuffer = false`（先回避对数深度，单视锥优先），near/far 设为大气效果可表达的合理值。

### 5.3 go/no-go 判据（硬标准）
| 编号 | 判据 | 验证方法 |
|---|---|---|
| G1 | GLSL 编译通过 | Cesium console 无 shader 编译错误，全屏输出非黑 |
| G2 | 深度重建正确 | 可视化 stage 输出与几何一致，多视锥接缝无条带；切换 frustum 数量结果稳定 |
| G3 | ECEF/密切球正确 | 同机位下天空与 three 版 Sky-Basic 视觉对齐；相机移动无抖动/错位 |

### 5.4 Phase 0 产出物
- `packages/cesium-core`：GLSL 资产 + 组装工具 + Cesium 基建雏形（FullscreenPass、UniformBridge、depthReconstruction 初版）。
- `apps/demo`：可运行的 Cesium demo（天空 stage + 深度重建可视化 stage）。
- 比对截图 + go/no-go 结论文档。

---

## 6. 关键技术风险与对策（go/no-go 与高优先级）

| # | 风险 | 严重度 | 对策 | 验证阶段 |
|---|---|---|---|---|
| R1 | ECEF 大坐标单精度浮点失效（6.4e6 m 量级） | **致命** | 密切球再中心化 + 高度校正 + Cesium RTE 语义适配 | Phase 0 (G3) |
| R2 | 深度/多视锥语义不一致（源仓库单视锥 `reverseLogDepth` ≠ Cesium 多视锥分段） | **致命** | 用 `czm_*` 重写深度重建，MVP 先关对数深度 | Phase 0 (G2) |
| R3 | 法线缓冲缺失（Cesium 无 GeometryPass MRT） | 高 | 全面改深度重建法线（`reconstructNormal`），接受边缘质量折损 | Phase 1 |
| R4 | HDR 管线落点（物理 radiance 合成须在 tone mapping 前） | 高 | MVP 先默认管线 + 链尾 ToneMapping；Phase 2 开 `scene.highDynamicRange` 并定位插入点 | Phase 2 |
| R5 | temporal 框架重建（云三缓冲 ping-pong） | 高 | `FramebufferManager` 自管 history；处理 `requestRenderMode` 冲突 | Phase 3 |
| R6 | 每效果一个全屏 pass 的带宽成本（无 Effect 合并优化） | 中 | 接受；后期可手工合并 composite | Phase 2+ |
| R7 | 3D/half-float 纹理形态 Cesium 封装不全 | 中 | 同 context 优势，回退裸 `gl.texImage3D` + `bindTexture` | Phase 0/1 |

---

## 7. 资产映射表（源仓库 → 本项目）

| 源（three-geospatial） | 本项目 | 处理 |
|---|---|---|
| `core/src/resolveIncludes.ts`、`unrollLoops.ts` | `cesium-core/src/` | 零改动搬 |
| `core/src/shaders/*.glsl`（10 个） | `cesium-core/src/glsl/` | 搬，保持形态 |
| `atmosphere/src/shaders/bruneton/*.glsl` | `cesium-core/src/glsl/bruneton/` | 搬，保持形态 |
| `core/src/Ellipsoid.ts`/`Geodetic.ts`/`math.ts` | `cesium-core/src/math/` | 算法搬，类型换 Cesium 原生 |
| `atmosphere/src/celestialDirections.ts` | `cesium-core/src/math/` | 搬（astronomy-engine） |
| `atmosphere/src/PrecomputedTexturesLoader.ts` + `@petamoriken/float16` | `cesium-atmosphere/src/` | 搬解析格式 |
| `atmosphere/src/PrecomputedTexturesGenerator.ts`（FBO 编排） | `cesium-atmosphere/src/` | 重写为 Cesium DrawCommand + FramebufferManager |
| `atmosphere/src/SkyMaterial.ts` | `cesium-atmosphere/src/SkyPrimitive.ts` | 重写为 Cesium Primitive（全屏/椭球壳，禁深度写） |
| `atmosphere/src/AerialPerspectiveEffect.ts`（postprocessing Effect） | `cesium-atmosphere/src/AerialPerspectiveStage.ts` | 重写为 PostProcessStage；法线走深度重建 |
| `atmosphere/src/getSunLightColor.ts`（CPU 采样 LUT） | `cesium-atmosphere/src/` | 近零改动搬（纯 CPU 数学） |
| `clouds/src/CloudsPass.ts`/`ShadowPass.ts`/`CascadedShadowMaps.ts` | `cesium-clouds/src/` | 编排借鉴，胶水重写为 DrawCommand |
| `clouds/src/shaders/*.glsl`（18 个） | `cesium-clouds/src/glsl/` | 搬，保持形态 |
| `effects/src/LensFlareEffect.ts`/`DepthEffect`/`NormalEffect` | `cesium-effects/src/` | 重写为 PostProcessStage/Composite |
| `*/r3f/*.tsx`（React 层） | — | 不移植；瞬态状态设计（`AtmosphereTransientStates`）照搬为每帧 uniform 同步集合 |
| three `RawShaderMaterial` + `onBeforeCompile`（唯一处，MRT 注入） | Cesium `ShaderProgram` + `DrawCommand`（多附件 + `layout(location=N) out`） | 重写 |

---

## 8. 工程约定

### 8.1 构建与打包
- **工具链**：pnpm workspace + nx + vite lib mode + vite-plugin-dts（照搬源仓库 `vite.config.ts` 模式）。
- **external**：`['cesium', /^@cesium-geospatial\//]`，ES + CJS 双产物。
- **TypeScript**：5.9，`strict`，照搬源仓库 `tsconfig.base.json` 约定。
- **GLSL 格式化**：`prettier-plugin-glsl`（源仓库已用）。

### 8.2 测试
- 纯数学、GLSL 组装工具用 vitest 单测（照搬源仓库 `resolveIncludes.test.ts` 等）。
- GLSL 编译校验：CI 跑一遍 `resolveIncludes` 组装 + Cesium `ShaderProgram` 编译（headless WebGL2，如 `headless-gl` 或 Playwright + 真实浏览器）。

### 8.3 命名与 API
- 包名：`@cesium-geospatial/{core,atmosphere,clouds,effects}`（scoped，避免与源仓库 `@takram/*` 冲突）。
- 插件 API：命令式，`new CesiumAtmospherePlugin(viewer, opts)` / `.destroy()`，与 Cesium 社区 primitive/stage 挂载习惯一致。

### 8.4 版本锁定
- 锁定 Cesium 目标版本（Phase 0 spike 时确认 HDR `scene.highDynamicRange` 成熟度后定具体版本号，倾向最新稳定版）。

---

## 9. 成功标准

- **Phase 0**：G1/G2/G3 三项判据全过，输出比对截图与 go/no-go 结论。
- **Phase 1**：日出/日落/太空俯视三场景与 three 版视觉对齐，插件可热插拔且 Cesium 原生无损。
- **Phase 2**：大气完整 + 后期链可发布版本。
- **Phase 3**：体积云在多质量预设下视觉与帧率可接受。
- **全程**：GLSL 资产保持渲染器无关，CI GLSL 编译校验通过。

---

## 10. 待确认事项（实现中据实定，不阻塞启动）

- **LUT 数据来源**：源仓库是否随包发布预计算 LUT 文件？若无，Phase 0 需先实现最小 LUT 预计算（DrawCommand）或 CPU 降级。→ Phase 0 启动时确认。
- **Cesium 具体版本**：Phase 0 spike 时锁定（倾向最新稳定版，确认 HDR 管线挂载点）。
- **轨 B（双渲染器成本参照）**：D1 已锁定原生注入，轨 B 是否仍做最小成本参照以备 Phase 3 云的重新决策？→ 默认不做，Phase 3 进入前再议。
