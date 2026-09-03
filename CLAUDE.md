# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

把 **three-geospatial** 的 Bruneton 大气渲染移植进 **Cesium**（原生注入，非替换 Globe）。渲染通过 Cesium `PostProcessStage` 后处理实现，复用 Cesium 内置的 `czm_*` automatic uniforms、对数深度、`depthTexture`。当前阶段：phase1（B 路径大气透视）已合并到 `main`；phase2a（HDR 浮点后处理链基建）设计中。

**参考库定位（关键）**：`three-geospatial`（`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`）与 `navara`（`/Users/zhangliyun/Documents/Ayvods/Web3D/navara`，Rust/WASM GIS 核心 + Three.js 渲染的 3D 地图引擎，含完整动态体积云方案 examples/weather/clouds）并列算法/技术**主参考**（2026-09-03 用户拍板：navara 地位与 three-geospatial 一致，方案可能更完整）。

## 常用命令

```bash
pnpm dev                      # 启动 demo（= pnpm --filter demo dev，Vite dev server）
pnpm test                     # 跑全部 workspace 测试（pnpm -r test）
pnpm build                    # 构建全部 workspace

# 核心库测试（@cesium-geospatial/core）
pnpm --filter @cesium-geospatial/core test
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts   # 单文件
pnpm --filter @cesium-geospatial/core exec vitest run -t "动态曝光"                        # 按用例名过滤
pnpm --filter @cesium-geospatial/core exec vitest                                          # watch 模式

# 类型检查（仓库无 lint/typecheck 脚本，显式跑 tsc）
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
```

**GLSL 编译测试**（`aerialPerspective.compile.test.ts`）依赖 `glslangValidator`：优先用系统 PATH 中的，否则用 `glslang-validator-prebuilt-predownloaded` 包内 x86_64 二进制（Apple Silicon 经 Rosetta 2 透明执行）。两者都缺时测试以清晰报错失败——装 `brew install glslang` 解决。

**Cesium ion token**：`apps/demo/.env.local` 设 `VITE_ION_TOKEN=...`（已被 .gitignore，勿提交），或 URL `?ionToken=`。无 token 时 demo 自动降级到裸 globe（atmosphere 后处理不依赖底图，仍可验收）。

## 架构总览

### Monorepo 布局（pnpm workspace）

- `packages/cesium-core`（`@cesium-geospatial/core`）：核心库。`cesium` 为 peerDependency（消费者自带）。导出 shader 组装器、LUT 加载、`createAtmosphereStage`。
- `apps/demo`：Vite + 原生 Cesium `Viewer` 的验收 demo，URL 参数化（见下）。依赖 `core` via `workspace:*`。

### GLSL 管线（本仓库最核心、跨多文件的理解点）

GLSL 以 `.glsl` 文本经 Vite `?raw` 导入，在 TS 里字符串拼装成最终 shader 串喂给 `PostProcessStage`。链路：

1. `src/glsl/*.glsl` 与 `src/glsl/bruneton/*.glsl`（Bruneton 大气模型：`definitions`/`common`/`runtime`/`precompute`）→ `src/glslIndex.ts` 用 `?raw` 汇聚成嵌套对象。
2. shader 源里写 `#include "bruneton/runtime"` → `src/resolveIncludes.ts` 递归替换为对应字符串（支持 `a/b/c` 路径寻址）。
3. `cesium/cesiumCore.ts::buildAtmospherePrefix()` 生成公共前缀（precision + 纹理尺寸 `#define` + `COMBINED_SCATTERING_TEXTURES` + bruneton `definitions` + `const ATMOSPHERE`）。**顺序关键**：`const ATMOSPHERE` 必须在 struct `definitions` 之后。
4. `cesium/aerialPerspective.frag.ts` 用 `buildAerialPerspectiveFragmentShader(options)` 组装完整 fragment：`prefix + #define(GROUND/SUN/SKY) + uniforms + #include bruneton + helper fn + main`。`{sun, sky}` 宏控制分支裁剪。

**两种构建入口**（同一文件）：
- `buildAerialPerspectiveFragmentShader()`：供 Cesium 运行时（引用 `czm_*`、`out_FragColor`、`v_textureCoordinates`，由 Cesium 自动注入，**不需 `#version`**）。
- `buildStandaloneShaderForValidation()`：供离线 glslang 校验，补 `#version 300 es` + `czm_*`/`czm_readDepth`/`czm_windowToEyeCoordinates`/`out_FragColor` **桩声明**。改 shader 后两者都要过。

### 大气合成（B 路径，phase1 成果）

核心式（`aerialPerspective.frag.ts` main 末端）：`finalColor = originalColor·transmittance·u_groundDim + inscatter`。**不重算照明、不碰屏幕法线**（A 路径已弃——重算 irradiance 需 exposure≈15，放大 half-float LUT 灾消致山体透明）。`exposure≈1.5` 即可。末端 `tonemapDisplay` = ACES filmic + gamma 1/2.2 + display triangular dithering（±1.5 LSB）。

phase2a 方向：把末端内联 ACES 拆为「atmosphere stage 输出线性 HDR（HalfFloat）+ 链尾独立 ToneMappingStage」，为 image-based LensFlare（phase2b）留线性域消费点。详见 `docs/superpowers/specs/2026-08-04-phase2a-hdr-pipeline-design.md`。

### Cesium 集成关键点

- **`scene.globe.depthTestAgainstTerrain = true`**（`createAtmosphereStage` 内强制）：PostProcess `depthTexture` 才能拿到真实地形深度。false 时 depth 走椭球面，山体算成地平线量级距离 → transmittance 过低 + inscatter 主导 → 山体持续透明。
- **`PostProcessStage` 的内建纹理 uniform（`colorTexture`/`depthTexture`）必须由 shader 显式声明**——Cesium 只提供值不注入声明。
- **`czm_*` automatic uniforms**（`czm_viewerPositionWC`/`czm_inverseView`/`czm_windowToEyeCoordinates`/`czm_readDepth` 等）运行时由 Cesium 注入；离线校验需手写桩。
- **3D 散射 LUT** 用 Cesium `Texture3D`（公开 `.d.ts` 未声明，`cesium/cesium-augment.d.ts` 补最小类型）。`UniformSampler.set()` 读 `Texture3D._target` 绑定 `sampler3D`，故 uniforms 可直接传 `Texture3D` 对象。
- PostProcessStage 链按 `add` 顺序执行；`inputPreviousStageTexture` 默认 true，后一 stage 的 `colorTexture` 即前一 stage 输出。
- 视线方向重建用 `czm_windowToEyeCoordinates` 近/远平面差分（`reconstructRay`），避免 ndc + `inverseProjection` 在仰视净空/对数深度下退化。

### LUT 加载

`cesium/lutLoader.ts`：`transmittance.bin`(256×64) / `scattering.bin`(256×128×32) / `irradiance.bin`(64×16) 是 **half-float (Uint16) RGBA**。`@petamoriken/float16` 的 `Float16Array` 视图 → `Float32Array.from` → Cesium `Texture`/`Texture3D`（`PixelDatatype.FLOAT`）。demo 在 `public/luts/` 提供三份 `.bin`。

## 非显而易见的约束与陷阱

- **天空/地面分类用视线方向，绝不用 raw depth 硬分类**。`lookingAtGround = brunetonIntersectsGround || hitBottom`（平滑、不读 depth）。`depthTexture` 不抗锯齿，在掠射地平线逐像素硬翻转会产生条纹。depth 仅用于近处地形的「前景雾」`sceneDist`，且经 `smoothstep(horizonKm, CLOSE_KM, sceneDist)` mask 过渡带（终点落在地平线）才消费——见 DUAL inscatter（`baseInscatter` 平滑基线 + `foreInscatter` depth 前景雾）。
- **LUT 是 half-float（Float16）**。phase1 曾因 half-float 16 位精度出现 inscatter 灾难性抵消（catastrophic cancellation）；改动采样/量级相关代码时留意精度。
- **input dithering 必须留在大气 stage**：地表 `originalColor` 是 globe 的 RGBA8（已量化），HalfFloat 升级只保住 inscatter/天空 HDR 精度，地表 banding 源头不变；ACES 中间调放大 2–3× 会把 8-bit 阶梯放大成远处「水波纹」，需在源头对 `originalColor` 加 triangular 噪声打散。
- **dFdx/dFdy 必须在控制流分叉前算**（如 `fragmentAngle`），保证 quad 内控制流一致。
- Cesium globe 异步渲染固有限制：瓦片未加载区 `depth=1`（与真天空同色 clearColor），shader 用视线方向判定 fallback。

## Demo URL 参数（验收/复现）

`apps/demo/src/main.ts` 解析（`?mode=` 切分支；2026-09-03 拍板默认值=主体验裸 URL 即可）：
- `mode=atmosphere|sky|depth`（**默认 atmosphere** = B 路径主分支；sky/depth 为回归对照）
- `clouds` **默认开启**（atmosphere 模式自动建云；`clouds=0` 关闭）；`fps` **默认关闭**（`fps=1` 开右上角帧率角标）
- `time=ISO8601`（太阳方向）、`camera=lon,lat,height,heading,pitch`（角度制）
- `debug=N`（u_debugMode：1=log finalColor 2=太阳方向 3=相机 r 量级 5=depth/r 6=透传 inputColor）——**排查 artifact 的主手段**
- `exposureDay`/`exposureNight`/`groundDim`/`tileCache`/`lighting=0`/`atmo=0`（诊断基线，跳过大气后处理）
- 相机停稳后地址栏 `#camera=...` 自动更新为当前视角，复制即可精确复现问题视角。

## 开发流程（本项目惯例）

- **spec → plan → results**：`docs/superpowers/specs/<date>-<topic>-design.md`（设计，常经多专家 workflow 评审）→ `docs/superpowers/plans/<date>-<topic>.md`（实现计划）→ `plans/<date>-<topic>-results.md`（结果）。`.superpowers/sdd/` 存任务 brief/report 与评审 diff。动手前先看对应 spec。
- **调试方法论**：递进式编号 debug-probe shader（`u_debugMode` 1→2→3→5→6）隔离单个失效物理量，而非盲改。
- **渲染异常先清 vite 缓存再排查**：vite 对 workspace 包（symlink）的模块级编译产物缓存（`apps/demo/node_modules/.vite`）在多次改代码+HMR 后会与源码不一致（重启也可能不生效）——曾把缓存不一致导致的「云球壳 91km 高空偏移」误判为渲染 bug（2026-08-17 假警报，`pickEllipsoid` 实测云几何本正确、清缓存即恢复）。**看到渲染/行为异常先 `pkill -f vite && rm -rf apps/demo/node_modules/.vite && pnpm dev`，清缓存后仍在的异常才是真 bug。** 另：低对比画面（高空云海/均匀天空）上像素拟合与 AI 目测都不可靠，几何位置判断须用 `camera.pickEllipsoid` 等 Cesium 精确投影佐证。
- 所有代码注释、文档、对话用**中文**（遵循全局规范）。
