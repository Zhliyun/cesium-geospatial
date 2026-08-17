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
