# 体积云 M5 云 god rays——结果

> plan：`docs/superpowers/plans/2026-08-17-clouds-m5-god-rays.md`
> spec：`docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md` §6 M5
> 时间：2026-08-17（main 直接开发，3 commits）

## 最终状态

**SHADOW_LENGTH 链路全通（默认开）**：`marchShadowLength` 沿视线累加 BSM 光深（M3 成果）→ `applyAerialPerspective` 以 shadow_length 调 `GetSkyRadianceToPoint` 的 higher-order 分支（M1 成果，只遮 single 防过暗）→ 云前表面的大气散射被云影调制 = 朝太阳方向的云间体积光柱。效果量级 subtle（与 three 实跑一致），`?cloudsLightShafts=0` 诊断基线对比可辨。

## 前置核实（spec r1 要求，2026-08-17 完成）

three-geospatial storybook `clouds-clouds--basic`（lightShafts 默认 on）实跑：太阳方向穿云隙的放射状光芒**存在且有效**（强度 subtle）。「作者称 WebGL 未实现」的矛盾解决——有实现。启动方式备忘：`pnpm exec nx storybook storybook`（nx workspace，非 pnpm storybook）。

## 任务清单（T1–T3 全过）

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 | `CloudsMaterial.lightShafts` option（默认 true）→ `#define SHADOW_LENGTH` 编译分支（loc2 out + marchShadowLength + 三 uniform + applyAerialPerspective 3 参） | ✅ glslang 真编译 |
| T2 | 参数三件套 `maxShadowLengthIterationCount/minShadowLengthStepSize/maxShadowLengthRayDistance`（500/50/2e5，three defaults 逐字）+ MRT 3 attachment（lightShafts 分支；attachment 数=out 数 M2 坑双向适用） | ✅ |
| T3 | demo `?cloudsLightShafts=0` + smoke + results | ✅ |

**测试**：clouds 143 + core 271 = **414 全绿**；三处 tsc 0。

## 技术 smoke

- console 0 错误（无 GL/TS）
- lightShafts 开/关差分：上部云区 37.7% 像素差异（mean 3.24 / max 134）、中上天空 9.7%（远景 inscatter 微调）、**下部地表 0%**——效果分布正确（云前表面 aerial perspective，非全屏）
- 静止无新增抖动（BSM 采样路径与 M3 共用）

## 实现要点（复用价值）

- **M5 几乎零 GLSL 工作**——clouds.frag 的 SHADOW_LENGTH 分支 M2 移植时原文就绪，只差 define + 参数 + MRT att3。`applyAerialPerspective`/`marchShadowLength`/`getShadowRayNearFar` 全部原文直用。
- **attachment 数 = out 数的双向坑**：2 out + 3 attachment 炸（M2 实测），3 out + 2 attachment 同炸——lightShafts 分支决定 MRT 数量。
- att2（shadowLengthTex）无消费者：three 喂 `atmosphereShadowLength` 给大气系统的路径 spec 明确不做（god rays 在云 shader 内完成）；纹理保留供 M6/后续。
- `out float` 写 RGBA attachment 合法（R 通道）。

## 已知限制

- spec r1 的「debug probe 可视化 shadowLength 确认无 1/4 分方块边缘」针对 temporal 语境（resolve 后 historyBuffer）——temporal 已默认关（M4 回退），该检查不适用；temporal 收敛修复迭代接回时补。
- god rays 强度 subtle（three 同款）；如需更戏剧化是参数/艺术问题非 bug。

## 验收（用户）

- [ ] 朝太阳方向云间体积光柱（subtle）
- [ ] `?cloudsLightShafts=0/1` 对比可辨
- [ ] 无同心波纹（vs 历史 screen-space god rays 失败模式）
- [ ] 无过暗（云影区不死黑）
- [ ] 静止无新增抖动

## 下一步

M6 地形交互 + 质量预设 + 集成（云投影地面 B 路径 hack / `getRayDistanceToScene` 已通 / qualityPresets / resize / M6 参数化三处同步清单——见 plan 与 memory）。

---

## atmosphere 路径（T4，用户拍板追加；2026-08-17 深挖收尾）

**实装**（commit b67eaf1，core 277 + clouds 143 全绿）：
- att2（march shadowLength，m→km）经 `cloudsShadowLengthBridge` 喂 atmosphere stage 天空分支 `GetSkyRadiance` 的 shadow_length 参数（桥未就绪帧回退 1×1 黑 dummy，零回归）。
- `u_cloudsGodRaysGain`（默认 1 物理精确；demo `?cloudsGodRays=N`）采样后相乘——atmosphere 路径增益通道。

**消费端正确性**：常量 50km 探针 → 天空变暗 31%（Bruneton shadow_length 分支、桥、采样、uniform 全通）。

**效果结论：任何现实增益下不可见——根因是 BSM 光深量级，非 atmosphere 路径**（强制 reload 对照实验，-30,45 海面 70-80% 积云云下机位）：
- trace 探针（TEMP `DEBUG_SHOW_SHADOW_TRACE`，复刻 march 循环）实测：视线 4km 路径上 od max ≈ **0.01**，平均 ~1e-4 量级 → shadowLength 累积 ≈ **0.35m**（不是此前记的 0.35-0.5km——旧测值来自 no-op reload 污染的页面，作废）。
- 对照 gain 10000 → 3.5km 等效影长 → 亮度调制 <1.5%（<差分阈值 8/255）→ 零差分；gain 20/100 同理。
- BSM 内容排查：级联 0/1/2 有数据（BSM debug），但 march 投影位置采到的 meanExtinction ~0.0004-0.02（与画面 70-80% 厚云不符）——**BSM 光深比预期小 3-4 个数量级，指向 M3 BSM 移植的深层问题**（级联投影/密度采样/resolve 链路之一），与 atmosphere 路径无关。
- 附注：M3 验收的「云自阴影全过」走 Beer/powder 相对明暗，弱 BSM 也能出体积感；god rays 需要绝对光深量级，问题才暴露。

**遗留任务（新建专门迭代）**：BSM 光深量级调查——trace 已把断点缩到 `readShadowOpticalDepth` 的输入侧（sh.g 极小 / march 路径 texel 采样）。修复后 M5 god rays 重新验收。

**本阶段方法论修正**（探针验证的坑，记忆见 memory）：
- **agent-browser `open` 同 URL 不触发 reload**（query 全同只 no-op）——多组「逐位一致」的对照全是假象；URL 对照实验必须加随机参数（`&_r=N`）强制导航。
- **eval `camera.setView` 会冻结画面更新**（eval 只改 uniform/enabled 无此问题）；相机定位走 URL 参数 reload。
- **core 包（vite workspace 源链接）改动必须 pkill vite + rm apps/demo/node_modules/.vite + 重启**，HMR/reload 拿不到新代码。
- Cesium 碰撞检测每帧 `_adjustHeightForTerrain` 会把地下相机推高（-53.5,77 机位 800m→2010m）——跨页差分前必须用 eval 读回 `positionCartographic.height` 确认稳定，或选海面机位。
- FPS 面板是分区统计恒定 ~1.6% 暗像素的来源；AI 视觉分析在均匀低对比画面上会产生「云」幻觉——数值佐证是硬要求（memory 教训的第三次验证）。
