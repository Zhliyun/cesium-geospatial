# 体积云 M1 — 基建 + MRT/Primitive spike + 资产管线 results

> **日期**：2026-08-13
> **基于**：spec `docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md`（r1 + r2 附录 F）+ plan `docs/superpowers/plans/2026-08-13-clouds-m1-platform.md`
> **branch**：`phase3-clouds-m1`
> **结论**：✅ **M1 全过，go/no-go gate 通过**——MRT 死结有解，体积云路线确认可行，M2 启动前置满足。

## 1. spike 4 项 GO（go/no-go gate 通过）

`apps/demo/src/CloudsSpikeMRT.ts`（commit `29236e8`）实跑验证（用户 demo 验收 `?cloudsSpike=1/2/3`）：

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | custom Primitive pass=VOXELS 在 globe 后、PostProcess 前执行 | ✅ GO | 无报错 + overlay 显示（primitive 跑了、不遮 globe） |
| 2 | globe depthTexture 能被云 shader 读取 | ✅ GO | `=2` att1 显示 d 变化（地形 vs 天空） |
| 3 | czm_viewerPositionWC/czm_inverseView 自动注入 | ✅ GO | `=1` att0 绿色（`camMag = length(czm_viewerPositionWC) >= 1e6`，JS magnitude 30.6e6 太空视角） |
| 4 | 自管 MRT FBO（color/depthVelocity/shadowLength）一次 draw 多输出 | ✅ GO | `=2/=3` overlay 与 `=1` 不同（3 attachment 各自写入） |

**核心结论：MRT 死结有解**——`custom Primitive pass=VOXELS + 自管 MRT FBO + RenderState.fromCache + bridge overlay` 全链路通。spec r1 三专家评审"MRT 可能死结"判断（PostProcessStage 单输出、链中间无 hook 插自管 DrawCommand）经 Explore 深挖 + spike 实跑化解：用 **Primitive pass=VOXELS**（globe 后 PostProcess 前执行）+ **DrawCommand._framebuffer 优先 passState**（写自管 MRT FBO）+ **Context.bindFramebuffer 自动 glDrawBuffers**。

## 2. 三个 Cesium 接口坑（spike 实测，固化进 T5 基建）

| 坑 | 现象 | 根因 | 固化 |
|---|---|---|---|
| #1 Destroyable 三件套 | `primitive.isDestroyed is not a function` + 后续渲染 `reading 'id'` 崩 | `PrimitiveCollection.add` → `Scene.js:4134 createPrimitiveEventListener` 调 `primitive.isDestroyed` 检查存活，plain object 缺 | custom primitive 必须实现 `update`/`isDestroyed`/`destroy` 三件套 |
| #2 pass 调度需 renderState | 渲染帧时 `getDepthOnlyRenderState (DerivedCommand.js:75)` `reading 'id'` | cmd 进 pass 调度后，`updateDerivedCommands→createDepthOnlyDerivedCommand→getDepthOnlyRenderState` 访问 `renderState.id` 做缓存查找；undefined renderState 炸。historyBlit 不暴露因 postRender 手动 execute 不走 pass 派生 | DrawCommand 进 pass 必须设 `renderState: RenderState.fromCache(...)`（带 id） |
| #3 Primitive czm_* 注入 | （实测无问题）| Primitive 走 ShaderProgram，`czm_*` automatic uniforms 经 `_automaticUniforms` + UniformState 自动注入 | 确认注入正确（spec r1 R10 降级为已确认） |

## 3. core/platform 基建（T5，commit `f1743ef`/`82144c1`/`2ce0a4a`）

`packages/cesium-core/src/cesium/platform/`（新建目录）：
- **FullscreenPass.ts** — 通用全屏 pass（createViewportQuadCommand 封装，BSM ShadowPass/resolve/blit 用，postRender 手动 execute 不走 pass 派生）
- **VolumetricPrimitive.ts** — 云主 march 入口（封装 spike 的 custom Primitive：update 推 pass=VOXELS DrawCommand + MRT framebuffer + renderState，globe depth 私有 API 通过闭包注入隔离）
- **FramebufferManager.ts** — MRT（colorTextures[] + Context 自动 drawBuffers）+ TEXTURE_2D_ARRAY cascade（裸 WebGL texImage3D + bridge）+ ping-pong（参照 historyBlit createHistoryState）
- 单测 21 项（FullscreenPass 4 + VolumetricPrimitive 8 + FramebufferManager 9）
- cesium-augment.d.ts 补 RenderState（fromCache + id）

## 4. clouds 包（T1 + T7 + T9）

`packages/cesium-clouds/`（新包 `@cesium-geospatial/clouds`）：
- **T1 包骨架**（`bf5f4d5`）：package.json/tsconfig/vitest.config/index + cloudsConstants
- **T7 搬 21 clouds GLSL**（`efbd995`）：21 shader + 2 兼容桩（`<common>`/`<packing>`）+ 跨包 #include + glslang 编译 16/16（13 entry + 负向 + 2 constants）
- **T9 weather 纹理加载**（`7751d2d`）：shape R8 128³ + shape_detail R8 32³（搬 three 版 assets）；local_weather 2D PNG 待 M2 decode

### 跨包 #include 机制结论（T7）
core 的 `resolveIncludes` 与"包"无关——只对嵌套对象树按 `split('/')` 分量 walk 取字符串，不碰文件系统。clouds `glslIndex` 合并：`core: coreIndex.core`（直引）+ `atmosphere: { bruneton: coreIndex.bruneton }`（路径前缀别名，clouds 源写 `atmosphere/bruneton/runtime` 一字不改）+ clouds 本地库。`resolveCloudsIncludes` 补尖括号 Three chunk（`<common>`/`<packing>`）映射 + unrollLoops（resolve 先 unroll 后）。端到端实证：`clouds.frag` 编译过，证明跨包链路（core/cascadedShadowMaps + raySphereIntersection + depth + math + atmosphere/bruneton/runtime）全 resolve 成功。

## 5. higher-order scattering LUT（T8，commit `368f2c3`，C9）

- 搬 three 版 `higher_order_scattering.bin`（8MB = 256×128×32 half-float RGBA，与 scattering 同格式同维度）
- `cesiumCore.ts buildAtmospherePrefix` 加 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE`
- `lutLoader` 加载第 4 张 LUT（`AtmosphereLUTs.higherOrderScattering: Texture3D`）
- `aerialPerspective.frag.ts` 加 `uniform sampler3D higher_order_scattering_texture` 声明 + UNIFORM_NAMES
- `AtmosphereStage buildAtmosphereUniforms` 注入
- **零回归数学保证**：`shadow_length=0`（当前 atmosphere）时 `HAS_HIGHER_ORDER` 与 `#else` 数学等价（single+higher 分解后合并 = 全 scattering − transmittance·scattering_p）；`shadow_length>0`（M5 云 god rays）才走物理正确分支（只遮 single Rayleigh 保留多阶），防 phase2c 过暗黑

## 6. T7 不确定点（→ M2 处理）

1. **glslangUtil 重复**：clouds 拷贝 core 的（core 未 export compileShader）。建议 M2 core export `compileShader`，clouds 删拷贝改 import。
2. **define 值编译期占位**：assembler 注入的 `SHADOW_CASCADE_COUNT=4`/`SCATTER_ANISOTROPY_*` 等仅供 glslang 验证；M2 运行时 Cesium assembler 按质量档位提供真实值。
3. **cloudsEffect.frag main() wrapper**：Three `mainImage(out)` 约定（无 main），M2 Cesium assembler 决定真实合成。
4. **weather format 校准**：shape/shape_detail R8 128³/32³ 推算自文件大小 + CLOUD_SHAPE_TEXTURE_SIZE，M2 云 shader 实际采样时校准；local_weather.png 2D PNG decode M2 实现。

## 7. 全量回归

| 项 | 结果 |
|---|---|
| core 测试 | **258/258 ✅**（含 T5 +21、T8 +3） |
| clouds 测试 | **17/17 ✅**（constants 2 + compile 14 + weather 1） |
| tsc core + clouds + demo | **0 error ✅** |
| atmosphere 零回归 | ✅（T8 shadow_length=0 数学等价；spike `?cloudsSpike` 不传时 atmosphere 完全不变） |

## 8. M2 启动前置（全满足）

- ✅ MRT 渲染入口确认（Primitive pass=VOXELS + 自管 FBO）
- ✅ 基建 ready（FullscreenPass/VolumetricPrimitive/FramebufferManager）
- ✅ GLSL 资产 ready（21 clouds shader + 跨包 #include + glslang 过）
- ✅ higher-order LUT ready（C9，M5 god rays 防过暗）
- ✅ weather 资产 ready（shape/shape_detail，local_weather M2 decode）
- ✅ 3 Cesium 坑已固化（M2 不再踩）

## 9. M1 commit 清单（branch phase3-clouds-m1）

| commit | 内容 |
|---|---|
| `bf5f4d5` | T1 cesium-clouds 包骨架 |
| `66bdfe4` | T2 spike probe（初版） |
| `99b726b` | fix spike primitive isDestroyed（坑#1） |
| `29236e8` | T2 4 项 GO + 固化 3 坑 |
| `f1743ef`/`82144c1`/`2ce0a4a` | T5a/b/c FullscreenPass/VolumetricPrimitive/FramebufferManager |
| `368f2c3` | T8 higher-order LUT（C9） |
| `efbd995` | T7 搬 21 GLSL + 跨包 #include + glslang |
| `7751d2d` | T9 weather 纹理加载 |

## 10. 下一步（M2）

M2 = 主 raymarch（无 shadow，flat lighting）：搬 `clouds.frag` 主 march + weather/shape 采样 + 用 VolumetricPrimitive + FullscreenPass + 跨包 #include bruneton。验收：demo `?clouds=1` 天空有云形（无体积厚度）；ECEF 密切球再中心化下相机移动稳定；零回归。

M1 基建（VolumetricPrimitive/FramebufferManager）+ 资产（GLSL/LUT/weather）+ 跨包机制 + 3 坑经验全 ready，M2 可直接组装。
