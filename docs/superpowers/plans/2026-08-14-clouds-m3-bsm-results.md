# 体积云 M3（BSM 云自阴影）实施结果

> 计划：`docs/superpowers/plans/2026-08-14-clouds-m3-bsm.md`（2026-08-14）
> Spec：`docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md` §6 M3
> 分支：`phase3-clouds-m3-bsm`（自 `1588272` 切出）

## 结论

**M3 全部完成**：BSM（Beer Shadow Map）链路三段——级联矩阵（TS）→ sun-POV 生成端（Texture3D 逐层）→ 主 march 消费（Beer-Lambert + powder）——全部落地，6 commit，TDD 全程，task 级评审 5/5 通过（T1 一轮 fix），用户视觉验收通过。测试 core 258 + clouds 95 = **353 绿**，clouds/demo `tsc --noEmit` 0 错。

## 交付表

| Task | Commit | 交付 | 评审 |
|---|---|---|---|
| T1 CascadedShadowMaps | `4d27fee` + 修复 `41edc5b` | `CascadedShadowMaps.ts`（splitFrustum + FrustumCorners + 级联正交矩阵，纯 TS）+ 7 用例 | Approved（1 轮 fix：far 截断按视深 \|z\|） |
| T2 ShadowMaterial | `88f92a7` | `ShadowMaterial.ts`（shadow.frag 单 cascade surgery 组装器）+ glslang 8 用例 | Approved |
| T3 ShadowPass | `f090691` | `ShadowPass.ts`（Texture3D + 裸 FBO framebufferTextureLayer 逐层 attach + preRender render）+ 8 用例 | Approved（两条核心机制经 Cesium 源码独立核实） |
| T4 主 march 接真 BSM | `43a7d51` | CloudsMaterial surgery 三项 + CloudsShadowFrameState + CloudsPass uniform 换真值 + 10 用例 | Approved（三方数值一致性专项核对过） |
| T5 编排 | `dc45288` | createCloudsStage preRender 级联更新 + BSM 生成 + buildSharedCloudsUniforms 抽取 + demo `?cloudsShadow=0` + 7 用例；**顺带修 T2 critical gap**（densityProfile struct） | Approved |
| 终审 + 修复 | `4e1de48` | final review（opus 全分支）：1 Important——两端 SHAPE_DETAIL/TURBULENCE 默认错位（spread 显式 undefined 覆盖默认 true，BSM 密度场缺 detail）→ `?? true` 兜底 + 默认路径断言 + 两端 define 一致性常驻用例；顺带修 distance 注释（声明「BSM 两端不消费 clip.z」不变量） | 2/2 ADDRESSED（复审独立复跑 99/99 绿） |

## 设计决策落地（对照 plan D1-D6）

- **D1 BSM = Texture3D（sampler3D）逐层生成**：消费端沿用 M2 的 sampler3D surgery；生成端 Cesium `Texture3D`（HALF_FLOAT RGBA 512²×3）+ 裸 GL FBO `glFramebufferTextureLayer` 逐 cascade attach（WebGL2 允许 TEXTURE_3D attach layer，texStorage3D immutable storage）。**Plan B（copyTexSubImage3D）未触发**。z 归一化 `(i+0.5)/SHADOW_CASCADE_COUNT` 半 texel 中心采样，LINEAR 三线性 z 邻层权重 0 无跨层混叠。
- **D2 preRender 时机生成**：BSM 零场景几何（sun-POV 云密度场），`scene.preRender` 手动 execute 同帧先于云 march（VOXELS pass）；此刻 `camera.frustum.near/far` 恒为完整视锥（Cesium 分段改写在 executeCommands 内，且 Picking 5 条路径末尾都 `endFrame()` 重置 `_currentFramebuffer` → executeCommand 不切外部裸 FBO 的前提恒成立——rev-t3 在 Cesium 源码逐条核实）。
- **D3 u_shadowCameraNear 解 multi-frustum 错位**：cascade 选择的归一化视深域必须与 BSM split（完整视锥）一致；主 march 的 `cameraNear` 被 `#define` 到 `czm_currentFrustum.x`（分段值）会错位 → surgery 把 3 处调用点换独立 uniform。`getViewZ` 的 depth 反演仍用分段值（语义正确，未动）。
- **D4 cascadeCount 3 + POWDER**：`SHADOW_CASCADE_COUNT` 4→3（与 three qualityPresets 默认一致，DEBUG 视图第 4 象限自动裁掉显示黑）；补 `#define POWDER`（powderScale=0.8>0，three 默认开，M2 漏）。
- **D5 单 cascade 单输出 surgery**：每 draw 写一层（3 draw/帧，同 shader 复用），MRT out 数组/temporal velocity 段/reprojectionMatrices 全删（M4 加回）。
- **D6 BSM far = min(frustum.far, maxRayDistance)**：3 段 ≈ [0,33km]/[33,68km]/[68,200km]（near=1 时）。

## 关键不变量（改动前必读）

1. **BSM 两端不消费 clip.z**：生成端 `cascade()` 的 march 起点经 `getRayNearFar` 与云层球壳**解析求交**（z=-1 反投影只取 xy）；消费端 `getShadowUv` 只取 `clip.xy`（正交投影 xy 与 z 解耦）。因此 `cascades.update` 的 distance（虚拟光源距离，`lerp(1e6, 1e3, zenith)`）不影响 march 域——传 1e6 安全。**未来若加 clip.z 剔除/debug 依赖此约定须重审**。
2. **三方数值同源**：`SHADOW_CASCADE_COUNT`（主 shader define）= `CASCADE_COUNT`（生成 shader define）= `params.shadowCascadeCount` = 数组长度 = Texture3D depth。M6 参数化时三处同步（ledger 有完整清单）。
3. **cascade 归一化域**：`u_shadowCameraNear`/`shadowFar` 必须与 `cascades.update` 同帧同源（preRender 完整视锥值）。

## 实施中发现并修复的计划缺口

- **T1（plan 移植错，评审抓出）**：far 角截断我写成欧氏范数——three 原文按视深 |z| 截断。范数版会把末段 cascade 盒收窄 22-34% → 远处云影系统性缺失。断言改为 ortho 半径绝对下界（有真区分度，TDD 红绿验证）。
- **T1（实现者抓出）**：fade 扩张项的 zRatio 在 light 旋转系取值会爆到 5e7——须用变换前 camera-local 视深。
- **T2/T5（跨 task 接缝，T5 实现者抓出）**：`densityProfile` struct uniform 在生成端 shader 未做 const 注入——Cesium uniformMap 不支持 struct，链接后拆点分名查不到 → 全 0 → `getLayerDensity` 恒 0 → **BSM 静默失效（不报错）**。T5 补齐（与 CloudsMaterial 同值）。
- **T5（brief 骨架错）**：shadowState 复用 params 默认矩阵数组——元素是 Cesium 冻结的 `Matrix4.IDENTITY`，clone 覆写必抛 TypeError。改独立分配。

## 视觉验收（2026-08-15 用户验收通过）

| 验收项 | 结果 |
|---|---|
| 云体积厚度/暗部（`?clouds=1` vs `?cloudsShadow=0` 来回切） | ✅ 有明暗、体积差异（BSM 生效） |
| 晨昏光（`time=2026-08-14T22:30:00Z`） | ✅ 有体积明暗、晨昏染色、背阳侧阴影 |
| BSM debug（`cloudsDebug=4`） | ✅ 三 cascade 层云形正常（近细远粗）；右下角全黑 = 无第 4 层（预期，CASCADE_COUNT=3） |
| 晨昏 + BSM debug | ✅ 三块红色 = 无云 texel 的 debug 色值（frontDepth=maxRayDistance → r 通道饱和 2.0）；主视图对照有体积明暗确认非 bug |
| console `[clouds] BSM FBO 不完整` warn | 未出现（RGBA16F attach 正常，Plan B 未触发） |

> 注：视觉验收时 BSM 生成端 SHAPE_DETAIL/TURBULENCE 因终审 Important-1 处于关闭状态（错位仍过验收——基础 shape 密度在，阴影大体正确）；修复后 BSM 密度场带 detail，阴影应更贴云形细节，默认视角快速复验即可。

## 终审（final whole-branch review，opus）结论

- **可合并**（修 1 项 Important 后，已修 `4e1de48`）。
- **已核实的关键正确性**（供 M4/M6 引用）：preRender 时机（Cesium Scene.js `_preRender` 在 render() 前；executeCommands 用独立 working frustum 分段，`camera.frustum.near/far` 不被改写 → D2/D3 双成立）；requestRenderMode 下 preRender 仅真渲染帧触发（BSM 不白算）；生成端 uniform 链完整（resolution 唯一消费点在主 march，生成端 inactive 安全）；cascadeCount 全局一致 = 3；两端 altitudeCorrection/sunDirection 同 state 同帧。
- **Deferred minors 裁决**：T1 scratch 化→M6 性能 pass；T2 '// Velocity' 注释残留→M4（temporal 加回时锚点在此）；T4 恒真断言→M6 顺手；T5 shadowPass=false 卫生 + `!` 谎言→M6（包进 enableShadow）；T5 scene 参数未用→无需处理；T3 两条已在 T5 commit 内修掉。新记一条：显式传 `shapeDetail: undefined` 键时主 march 被覆盖而生成端 `?? true` 兜底（两端错位的边界形态）——实际调用方均不显式传 undefined 键，M6 建议顶层归一化一次两端同传。

## 已知项与交接

- **BSM temporal**（`TEMPORAL_PASS`/`ShadowResolveMaterial`/varianceClipping）→ **M4** 与主云 resolve 一起接；生成端 velocity 段/reprojectionMatrices 届时按 three 原文加回（git 可寻）。
- **march jitter 静态噪声**（STBN frame=0）与 M2 相同 → M4 temporal 根治。
- **M6 参数化三处同步清单**：①cascadeCount 假单源（params 值 vs 硬编码 3 元素 vs define）②densityProfile 双处字面量（CloudsMaterial/ShadowMaterial）③编译测试 define 同步。
- **M7/HAZE note**：clouds.frag L988 HAZE 分支的 `cameraNear*rayDirection` 保留分段语义 token，HAZE 接通时需同 `u_shadowCameraNear` 思路复核。
- Deferred minors（final review 裁决后并入 M4/M6 或已修）：见 `.superpowers/sdd/2026-08-14-clouds-m3-bsm/progress.md` ledger。
- **multi-frustum 段 near 语义**：M3 已用 `u_shadowCameraNear` 解耦 cascade 域；M6 复查项（M2 遗留）不变。

## M4 前置

- `cloudsResolve.frag`（方差裁剪 + velocity reprojection + Bayer 4×4 jitter + 1/4 分 → 全分 upscale）
- BSM temporal：ShadowPass 补 resolve/history ping-pong（`temporalAlpha=0.01`，three 注释：shadow map 单像素闪烁高可见）
- STBN frame 递增 + `temporalJitter` Bayer 注入
- 不复用 depthTemporal/historyBlit（NEAREST+EMA 的 depth 专用，语义不同）
