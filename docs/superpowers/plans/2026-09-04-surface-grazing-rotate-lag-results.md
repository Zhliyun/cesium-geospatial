# 贴地掠射旋转卡顿调查——camera=108.2465,34.3312,19,52.0,-2.6（2026-09-04）

## 结论（根因链，逐层实证）

用户报告该机位「转动相机视角很卡顿」。systematic-debugging 四阶段调查结论：**这不是单一 bug，
是「贴地掠射」视角类 × 实时时钟坏窗口 × 旋转 TAA 全量重 march 三因子叠加**；地形/影像无辜。

### 因子 1：两个后处理 stage 在贴地掠射视角天然极重（视角类固有）

同机位同窗口阶梯（headed 真机，CDP 驱动旋转，rAF 帧间隔统计）：

| 配置 | 静止 FPS | 备注 |
|---|---|---|
| `atmo=0`（纯球） | **60.0** | p50 16.6ms、零长帧——地形/影像/瓦片完全无辜 |
| `clouds=0`（+大气 stage） | 15.5 | 大气 stage 吃 ~48ms/帧（前雾全屏+掠射 LUT） |
| 默认（+云） | 9.1-10.5 | 云再吃 ~45ms/帧（high 档掠射 march） |

### 因子 2：实时时钟坏窗口（用户踩中的时刻，3× 波动）

同一 URL 实时时钟下 **18:05 前后 = 9-10 FPS，18:35 后 = 28-33 FPS**（三批样本一致）。
太阳角+天气图覆盖随 live 时间演化：黄昏低太阳角 → 云影 BSM march 光程最长档；
云变薄 → march 提前穿透。钉时刻对照：正午（12:00 local）24 FPS vs 傍晚实时 9-10 FPS。
**用户恰在坏窗口测试**（现在=傍晚）。

### 因子 3：旋转突刺 = TAA rejection 全量重 march（「转动卡顿」的直接手感）

旋转窗口比静止系统性更差：main 旧高度旋转 p95 136ms、40s 内 **83 个 >100ms 长帧**
（静止 p95 59ms/1 个）。低帧率下帧间运动向量巨大 → |Δa| rejection 频发 → 每帧全量
march，恶性循环。另偶发 ~1s 级卡顿（瓦片突发流送）。

### 附：质量预算杠杆

钉正午同机位：`cloudsQuality=low` **43.9 FPS** vs 默认 high 24 FPS——march 预算主导云成本。

### 附：待合高度分支的帧率影响（三明治 A/B，钉 10:00Z，main→wt→main）

静止 25.8/31.6（main）vs 34.0（wt）≈中性略正；**旋转突刺显著改善**：main-a p95 136ms/
83 长帧 vs wt p95 50ms/5 长帧。结论：**高度分支在本视角无性能代价、旋转平滑度更好**，
可按画质/物理 merits 合并（5ef5f9c）。

## 方法论坑（本役新踩）

1. **实时时钟 = 移动靶**：性能测量必须钉 `?time=&play=0`（与渲染验收同规）；本役第一次
   A/B（旧高度 18:07 vs 新高度 18:26）被时间漂移混杂出假 3× 结论，三明治复测才纠正。
2. **`openOrReuseTab` 按 URL 匹配**：参数扫描每换 URL 开新 tab（用户点名批评）——同 tab
   换 URL 一律 `gotoAndWait`（已入 [[browser-tool-ego-browser]]）。
3. **19m 机位在地下**：该处地形海拔 ~490-655m，CDP 拖拽触发 Cesium 碰撞顶起相机（hash 可见）
   +瓦片突发流送可压崩标签页（profile=1 逐帧 timer query 加剧）；脚本需崩溃重载自动重试。
4. `[profile]` 行是 `console.log('[profile]', json)` 双参数形态，钩子须解析 `arguments[1]`。

## 处置建议（待用户拍板）

1. **合并高度分支**（本视角无性能代价+旋转更平滑+物理/观感 merits 已验收方向）。
2. 本视角类（贴地掠射+黄昏）若常态化使用，性能根治=新工程课题（BSM 阴影 march 的
   太阳角自适应预算/掠射 march clamp），**涉及时域/分辨率降载须过用户画质关**（两轮
   被否决方向勿直接重提）；现有无代码缓解：`?cloudsQuality=medium/low`、`?clouds=0`。

## 附：测量基建

`measure-v3.mjs` 模式（ego-browser 单 tab + CDP 拖拽旋转 + rAF 分窗统计 + 崩溃重载重试）
沉淀于本轮会话 tmp；如需长期基建可入库 scripts/perf/（未随本轮提交）。

相关：[[clouds-inlayer-march-perf]]（已收官的性能战役与 rAF 帽/热降频坑）、
[[clouds-altitude-default 待合分支]]、[[clouds-black-penetrate]]（TAA rejection 语义）、
[[project-handoff-2026-09-04]]。
