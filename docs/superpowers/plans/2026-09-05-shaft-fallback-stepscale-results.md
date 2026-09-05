# 平视地平线 P3：兜底光柱 march 大步幅——结果

日期：2026-09-05。分支：`worktree-clouds-shaft-fallback-gate`（单 commit）。
前置：P0（夜晚太阳侧门控）+P1（光柱步长 50→100）已合 main（cf5bc8e）。

## 问题

用户机位 `?fps=1&camera=56.9420,26.8977,124,79.4,0.5`（贴地 124m 平视，白天）57FPS 未满帧。
复现：p50 17.2ms / 57.7FPS（2000×1163 dpr=1，headed Chrome，与用户角标 17.16/57 一致）。

## 根因（阶梯差分 + 代码归因）

帧时 17.3ms = globe 基线 ≤8.3（120Hz 地板）+ **god rays marchShadowLength 6.6ms** + BSM 消费 ~2.5 + 云管线其余 ~0-2。

关键结构（`clouds.frag`）：`hitClouds` 像素的光柱 march 被 `frontDepth` 截断（段短）；
**`!hitClouds` 兜底分支（原 L1105-1115）无条件满段 march**（≤16km，~146 步 × 每步 1 次 BSM 3D 采样）
→ 晴天云少时≈全屏像素白跑，成本与画面云量无关。

**重要修正**：原设想的「视线段与云层高度带无交→整体跳过」几何门控**不成立**——
`sampleShadowOpticalDepth` 是 shadow-map 语义（沿太阳方向到顶壳的光深剖面），位置在云带下采样非零
（=该点朝太阳方向的云影），兜底 march 有真实物理贡献（海面/低空大气散射的云影调制），不可跳过。
故治本落位=兜底分支专用大步幅（`marchShadowLength` 加 `startStepSize` 参数；
`hitClouds` 分支（云隙光柱主体）保持原步幅零回归）。

## 定标（真机 A/B，成对+锚点）

| 倍率 | 白天贴地 p50 | 朝太阳日落画质 | 结论 |
|---|---|---|---|
| ×1（main） | 16.6-17.3ms / 57-60FPS | 基线 | — |
| ×4 | 13.2-13.6ms / 73-75FPS | **海面灰化：meanΔ13.0 / 超差 47.7%**（低太阳角视线云影光深大，粗步幅积分系统性偏差） | 否决 |
| **×2（定稿）** | **14.2-14.7ms / 67-69FPS** | **meanΔ0.011 / 超差 0.012%**（逐位级）；白天天空 0.07% | ✓ |

黄昏场景（time=14:00Z）：A 17.2 → B 13.9-14.7ms / 67-71FPS，画质超差 0.02%（云排边缘 ≤3/255）。
编译测试 57 + 全量单测 341 + tsc 三包全绿。

## 改动

`clouds.frag`（SHADOW_LENGTH 编译分支内）：
- `marchShadowLength` 签名加 `startStepSize`；`hitClouds` 调用传 `minShadowLengthStepSize`（零回归）；
  兜底调用传 `minShadowLengthStepSize * SHADOW_FALLBACK_STEP_SCALE`（define 2.0，含 ×4 否决依据注释）。
- `?cloudsShaftStep=`（minShadowLengthStepSize）联动缩放兜底步幅。

## 测量坑（新增两条）

1. **ion 瓦片限流污染像素对照**：一下午几十次页面加载后，影像瓦片随机缺失/降级
   （海面灰化 rgb(108,108,115)=R=G、横贯暗带、整屏失焦样），且 `tilesLoaded` 连续 5s 仍可通过；
   天空/云不吃 ion 不受影响。跨版本像素对照须先目检双方画面完整性，海面区域异常样本作废。
2. **改 shader define 后 vite `?raw` 模块缓存可能不刷新**（清缓存重启前 sunset 数据与
   define 值错位的假象风险）——shader A/B 前 worktree server 也必须清 `.vite` 缓存重启。

## 验收 URL（5174=worktree server，需开发机自起）

- 治本：`http://localhost:5174/?fps=1&camera=56.9420,26.8977,124,79.4,0.5`（预期 ~67-69FPS）
- 对照 main：同 URL 换 5173（~57-60FPS）
