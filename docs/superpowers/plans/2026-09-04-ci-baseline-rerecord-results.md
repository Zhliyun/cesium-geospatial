# CI 基线重录结果——遗留 #2 销项 + tilesLoaded 瞬时 true 竞速治本（2026-09-04）

## 结论

**遗留 #2「CI 基线重录」完成**：7 场景 ref 全量重录（headless SwiftShader 后端不变），
`--check` **7/7 PASS 全部逐位 0 差**（SSIM=1.00000 maxΔ=0，超 08-06 版的 6/7）；
负向验证证实门禁判别力（关乘子 → FAIL）。

顺手治本了一个门禁基建 bug：**`tilesLoaded` 首次为 true 不够**（refinement 波次间隙
瞬时 true），capture.ts 改为「连续保持 5s 为 true」才截图。

## 变更清单（commit 见 worktree-nan-probe-infra 分支）

| 文件 | 变更 |
|---|---|
| `scripts/perf/capture.ts` | ① COMMON 重定稿：`+play=0&clouds=0`，去钉 `inscatterScale=25&groundLighting=0&groundDim=0.5`；② waitTilesLoadedTolerant 连续保持判定（`TILES_LOADED_HOLD_MS=5000`，250ms 轮询，false 打回重等） |
| `scripts/perf/baseline.md` | 场景表头公共参数更新 + 「2026-09-04 基线重录」节 + 自洽状态 7/7 |
| `scripts/perf/diff-regions.ts` | **新增**诊断工具：两张 PNG 的 8×8 网格差异分布（门禁 FAIL 时定位差异区域用；本役靠它识别出平滑渐变→瓦片马赛克） |
| `scripts/perf/ref/*.png` | 7 场景全量重录 |
| `apps/demo/src/main.ts` | inscatterScale 过时注释修正（「默认 25」→「默认 8（2026-09-02 定稿）」，纯注释） |

## COMMON 重定稿理由

- `+play=0`：412182e 起时间默认流动，单 `time=` 只钉初值——不钉死则太阳方向随页面加载
  耗时漂移，ref/out 跨会话永不匹配（确定性验收铁律 `?time=+?play=0` 成对的 CI 化）。
- `+clouds=0`：本门禁目标是 atmosphere stage；headless SwiftShader 云渲染崩坏不可信
  （memory clouds-resolve-motion-artifacts）。云回归由 verify-clouds-distribution.mjs /
  bake-readback.mjs 专项工具守。
- 去钉 `inscatterScale=25`：2026-09-02 定稿缺省 8（AtmosphereStage.ts:317），旧钉测已废弃路径。
- 去钉 `groundLighting=0&groundDim=0.5`：2026-09-01 乘子上线时的过渡桥——定稿主路径=
  乘子默认开+groundDim 0.43 缺省，基线应测当前缺省。

## tilesLoaded 瞬时 true 竞速（本役核心发现）

**现象**：首轮重录后 `--check` 中 camera-high-graze（maxΔ=44）与 bug5-circle（maxΔ=53）
FAIL，但两帧间隔 6 分钟、同后端同参数。

**定位**（`diff-regions.ts` 网格分布）：差异呈越近地平线越大的宽域分布而非瓦片块状——
目检 FAIL 帧发现地表白蓝马赛克（部分瓦片影像、大块占位色）；而 ref 帧与连采两帧
（B/C 实验）**三方逐位相同**。即：ref 是好帧，check 轮抓到的是流送中间态坏帧。

**根因**：`tilesLoaded` 在 refinement 波次间隙会瞬时 true（一批瓦片渲染完、下一批
子瓦片入队前后），旧逻辑「首次 true + 2s settle」恰好落在波次中段就截马赛克帧。
bug5 首录更极端：根级瓦片全空的均匀蓝灰死帧（404KB vs 正常 1.13MB）。

**修复**：`waitTilesLoadedTolerant` 改「连续保持 `TILES_LOADED_HOLD_MS=5000`ms 为 true」
（250ms 轮询，任何一次 false 打回重等）。重录后 `--check` 7/7 逐位 0 差——含历史
老大难 nadir（08-06 版从未自洽过）。

**排除项**：ion 限流已排除（真实 Chrome 45s 探针 console 零错误零警告、tilesLoaded=true）。

## 负向验证（门禁判别力，对抗审查 D 节工序）

1. 临时 `COMMON + &groundLighting=0`（关地面光色乘子）采 camera-low 过门禁：
   `SSIM=0.99852 maxΔ=6` → **FAIL**（乘子地面足迹被抓到，门禁非橡皮图章）。
2. 还原 COMMON 复检：`SSIM=1.00000 maxΔ=0` → PASS（闭环，FAIL 确来自参数本身）。

## How to apply

- 缺省主路径再变时，按同工序重录：清 vite 缓存 → `--save-ref` 全量 → `--check` 须 7/7 →
  挑一个预期改变的参数做负向验证须 FAIL → results 记录。
- 门禁 FAIL 时先跑 `diff-regions.ts` 看差异分布：瓦片块状=流送竞速（重采即可），
  宽域渐变=渲染参数变化（真回归或缺省漂移），顶部天空带差异=大气/太阳方向问题。
- headless 远视场场景截图前必须过「连续 5s tilesLoaded」判定，瞬时 true 是马赛克帧。

相关：[[ground-light-color-multiplier]]（过渡桥钉子出处）、[[night-horizon-red-clouds]]
（三层清缓存铁律）、[[clouds-resolve-motion-artifacts]]（SwiftShader 云不可信出处）、
[[project-handoff-2026-09-04]]（遗留清单）。
