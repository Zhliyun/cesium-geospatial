# 体积云 resolve 时域累积重写（N>1 降分路线）

- 日期：2026-10-10
- 状态：立项（r1 draft）
- 起因：用户拍板上游路线（降分 march 保性能），但 N>1 静止画面出现密集白/黑方块，上游同条件干净
- 关联：[F2 march RT 超分 spec](2026-10-09-clouds-march-supersampling-design.md)、worktree `worktree-f2-supersample`

## 1. 问题陈述（量化）

**现象**：N=4（1/16 像素降分 march + temporal upscale）静止时画面出现密集白/黑方块；同机位 N=1（全分）无此现象。用户真机目验证实，上游 storybook 俯视对照无此现象。

**量化口径**：钉 `?time=2026-09-21T11:30:00Z&play=0`，同一页面加载内连拍两帧，像素差分（|Δ|>8 计为变化）：

| 配置 | 帧间差分 | maxD |
|---|---|---|
| **上游 storybook（300m 视角，cov 0.30）** | **0.83%** | 44 |
| 我们 N=4 11470m cov0.45（缺省） | 33.2% | 181 |
| 我们 N=4 11470m cov0.30 | 11.3% | 172 |
| 我们 N=4 11470m cov0.20 | 3.6% | 172 |
| 我们 N=4 421m cov0.30（近景，最接近上游条件） | 12.4% | 158 |
| 我们 N=4 + `frameUnfreeze=0` | **0.016%** | 173 |
| 我们 N=1 421m（参考） | 待测 | — |

**关键**：闪动与云覆盖率强相关（0.45→29.6%、0.30→11.3%、0.20→3.6%），但与上游在任何可比条件下都差 13-15 倍。

**闪动的两条通道**（`frameUnfreeze=1` = 静止时也递增 marchFrame，白点治理机制）：
- STBN 相位轮换：贡献 ~1.6%（`cloudsUnfreezeMip=99` 冻结后仍 31.6%）
- **jitter 相位轮换：贡献 ~31.6%**（`frameUnfreeze=0` 同时冻结两者 → 0.016%）

## 2. 已完成的调查（排除清单，全部实测）

| 环节 | 结论 | 证据 |
|---|---|---|
| despeckle 坐标域 / resolve RT 尺寸 | 已修（真 bug），非本问题 | `7d2fdac`，修复后分界线消失 |
| jitter 相位冻结 | 已修（`17d01d5`），**代价是暴露本问题** | 近景方块消失，远俯闪动 33% |
| α mix（上游 upscale 分支无 mix） | 非主因 | α=0 → 28.6%；α=0.5 → 39.1% |
| disocclusion rejection（上游无） | 非主因 | 禁用 → 27.9% |
| `getClosestFragment` 同质守卫（上游纯 closest） | 非主因 | 纯 closest → 29.6% |
| AABB 宽度 γ | 非主因 | γ=10 → 33.9%；γ=0.001 → 29.5% |
| despeckle | 非主因 | 关闭 → 34.5% |
| STBN 相位分域 | 非主因 | mip=99 冻结 → 31.6% |
| **三处「我们独有」的 resolve 改动全关（最大程度上游语义）** | **仍 29.6%** | `α=0 + disocclusion=1.01 + 纯 closest` |

**上游 resolve 逐行对比结论**：上游 `temporalUpscale` = `texelFetch current` → Bayer 直通 → `getClosestFragment`（纯 closest）→ `prevUv` 越界 rejection → `varianceClipping` → **`outputColor = clippedColor`（无 mix）**。我们比它多三处（上一表），全部排除。

**velocity 调查**：
- 静止相机下未命中分支 velocity 实测 ~77px（应≈0）；`frontDepth ≈ 1e5`（cameraFar，量级正常）
- 排除：ray 坐标域（`czm_viewport` 探针实测为低分，与 `gl_FragCoord` 一致）、jitter 幅度（±2px，与上游 bayerOffsets 逐值相同）、矩阵构造（`elements[8]/[9]`，上游同款）、`vViewPosition` 语义（归一化差异被齐次除法抵消）
- 尝试修 `frontDepth` clamp（1e5）→ **42.3%（更差）**；无云像素 velocity 置 0 → **39.2%（更差）**——原 77px 会触发越界 rejection 直出 current（变相保护），修小反而进入有效区间错采 history

**探针读数**：`current`（march 原始输出）帧间变化 **78.6%**；最终输出 33%——即 **resolve 只把变化压缩 2.4 倍，上游压缩 ~94 倍**（假设上游 current 变化量级相近，**待测**）。

## 3. 核心未知（本立项的第一个任务）

**上游的 march 输出帧间变化是多少？**

- 若上游也 ~78% → 差异在 resolve 的累积能力（需按上游重写累积链，但已排除三处显式差异，说明是更隐蔽的实现细节）
- 若上游远小于 78% → **差异在 march 侧**（我们的 march 对 jitter 敏感度远超上游）→ 审查我们 march 的特有加码：段长/8 clamp、层内禁早退完整横穿、shape 显式 LOD（E2）、软化 T 门控、mipLevelScale 等

**取证方法**：上游 storybook 加同款探针（直显 `colorBuffer` 的 current）→ 同口径帧间差分。

## 4. 方案候选

- **A（取证）**：测上游 current 的帧间变化 → 分流 march 侧 / resolve 侧
- **B（march 侧方案）**：审查并对齐 march 特有加码；若 jitter 敏感性来自「低分 + 我们的采样序列」，考虑 jitter 幅度标定（对当前场景降幅）
- **C（resolve 侧方案）**：按上游重写累积链（长窗 IIR + 16 相位完整注入），可能需要改变 history 的写入/读取时序（怀疑累积被某些路径绕过）
- **D（兜底门控）**：N>1 仅在近景/静止满足条件的域启用（F2 spec 方案 A 的按需触发形态）

## 5. 验收门

1. **11470m cov0.45 帧间差分 ≤ 5%**（对齐上游量级；现 33%）
2. 四基准机位（421m/3021m/11470m/太空）无画质回归
3. 帧时不高于 N=1 同机位
4. 运动帧（转动相机）无拖影回归

## 6. 风险

- **场景不可比**：上游 storybook 无地形（海面+天空），我们有地形山脉——云缘占比与背景对比度不同，可能影响可见度而非机制
- **云形态/天气场差异**：我们自研烘焙天气场 vs 上游纹理，云缘的密度梯度不同 → 对 jitter 的敏感度不同
- 上游 storybook 用 `setPixelRatio(devicePixelRatio)`（与我们相同），但分辨率/覆盖率可调 —— 需锁定同参对照

## 7. 前置与工具

- 帧间差分脚本：`$CLAUDE_JOB_DIR/tmp/png-diff-f2.mjs`（全图）、`png-diff-regions.mjs`（分区）
- 探针范式：shader 内 `#ifdef DEBUG_*` + `outputColor` 直显（本仓库已有 6 个同类探针可参照）
- 上游 storybook：`localhost:6006`（`Clouds/Basic`，controls 在 shadow DOM 内，程序化操作受限）
