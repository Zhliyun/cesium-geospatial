# depthTemporal 默认移除（Phase 1.1 升级）results

> 日期：2026-08-13
> 基于：spec `docs/superpowers/specs/2026-08-05-performance-optimization-design.md` §1.1（"评估默认移除"，原 gate 在真实 GPU profile 数据）
> 关联：`docs/superpowers/plans/2026-08-05-performance-optimization-results.md` Phase 2/3 go/no-go（depthTemporal 默认移除项）

## 背景

spec §1.1 把"depthTemporal 默认移除"列为 Phase 1.1 升级，原计划等真实 GPU `?profile=1` 数据 go/no-go。本次用户决定**不等数据直接执行**（"立刻写代码"），并在执行前采集了 BEFORE 基线 profile 数据确认收益。

## 真实 GPU profile（BEFORE 基线，depthTemporal 默认 true，stage 创建）

太阳镜头光斑场景 `?mode=atmosphere&time=2026-08-04T10:30:00Z&camera=95.5324,31.4975,14917,269.1,-5.2&lensflare=1&profile=1`，4 帧 `[profile]` JSON 取样：

| 项 | ms（4 帧取样） | 说明 |
|---|---|---|
| `czm_depth_temporal`（stage execute） | 2.54 / 1.68 / 1.77 / 1.45 | ~1.5–2.5ms |
| `depthTemporal_blit`（postRender 全屏 copy） | 0.42 / 3.15 / 1.59 / 4.12 | 高方差，0.4–4ms |
| **合计** | **≈ 2–6ms/帧** | 16.7ms 预算下占比明显 |

**数据可信度警告（重要）**：所有 stage（含 `lf_down4` 这种 1/256 分辨率 pass）profile 都 ~3–4ms 且同涨同跌 → `EXT_disjoint_timer_query` 值被 GPU clock boost/throttle + 驱动开销整体调制，**非干净 per-stage 隔离**，绝对值勿过度信任。真正硬验收是**翻转后 presence vs absence**（见验收 A/B），抗此噪声。

## 改动（3 生产 + 14 测试）

| 文件 | 改动 |
|---|---|
| `AtmosphereStage.ts:231` | `depthTemporal: options.depthTemporal !== false` → `=== true`（默认 **false**） |
| `AtmosphereStage.ts:98-102` | option 文档注释更新（默认 false + profile 依据 + ?depthTemporal=1 恢复） |
| `demo/main.ts:259` | `getString('depthTemporal') !== '0'` → `=== '1'`（默认关，`?depthTemporal=1` 显式开） |
| `demo/main.ts:312-325` | profile 守卫：`setBlitTimerHook` 注册 + `snap['depthTemporal_blit']` 写入都加 `if (atmosphereHandle.depthTemporalStage)` 守卫——depthTemporal off 时 profile JSON 不再出现 `depthTemporal_blit: null` 占位（验收 A 实测确认） |
| `AtmosphereStage.test.ts` | ① 默认断言 `depthTemporal: true→false`；② 12 处 depthTemporal-feature 测试显式 `depthTemporal:true` opt-in（装配/uniforms/lifecycle/option 透传，本就测此特性，显式更清晰）；③ **新增**"默认（不传 depthTemporal）HDR → 不创建 stage + temporalEmaEnabled=false"用例 |

**不动**：`temporalEma` 默认仍 true（`?depthTemporal=1` 即带 EMA 全恢复）；UNSIGNED_BYTE 路径；atmosphere 渲染（本就 `hdrDepthTemporal:false` 不消费 depthTemporal 输出）。

## 效果

默认配置（无 `?depthTemporal=`）→ `stageCreated=false`（`AtmosphereStage.ts:401`）→ 不创建 depthTemporal stage、不注册 postRender blit、不分配 3 张 HF history RT → **省 1 全屏 HalfFloat pass + 1 全屏 copy + 3 张全分辨率 HF RT**。`temporalEmaEnabled=false` → lensflare occlusion 的 `depthTexture` 走 `AtmosphereStage.ts:422` `undefined` 分支 = **scene globe depth**（UNSIGNED_BYTE 设备天天跑的现成兜底，非新代码）。

## 为何不等 profile 也安全

atmosphere 恒 `hdrDepthTemporal:false`（Bug3 禁用）→ **根本不读 depthTemporal 输出**；唯一消费者是 1/16 分辨率 lensflare occlusion，且其 scene-globe-depth 兜底是现成、已验证路径（UNSIGNED_BYTE 设备长期跑）。即"全成本跑 stage 只为喂一个有现成兜底的 1/16 消费者"——浪费与精确占比无关。

## 验证

| 项 | 结果 |
|---|---|
| core test | **234/234 ✅**（+1 新增 default-off 用例） |
| tsc core + demo | 0 error ✅ |
| 验收 A（默认 profile） | 待用户浏览器复核：JSON 应**无** `czm_depth_temporal`/`depthTemporal_blit` |
| 验收 B（`?depthTemporal=1`） | 待复核：JSON **有** 两键（开关恢复旧行为，零回归） |
| 验收 C（occlusion 视觉） | ✅ 用户确认"看着可以"（M1 风险清除：scene globe depth occlusion 边缘可接受） |
| 验收 D（atmosphere 零回归） | ✅ 用户确认"看着可以"（Bug6 掠射视角默认 vs `?depthTemporal=1` 等价） |

## 验收 URL（复现）

```
# A 默认（stage 应消失）
http://localhost:5173/?mode=atmosphere&time=2026-08-04T10:30:00Z&camera=95.5324,31.4975,14917,269.1,-5.2&lensflare=1&profile=1
# B 旧行为（+&depthTemporal=1）
http://localhost:5173/?mode=atmosphere&time=2026-08-04T10:30:00Z&camera=95.5324,31.4975,14917,269.1,-5.2&lensflare=1&profile=1&depthTemporal=1
# D atmosphere 零回归（Bug6 掠射）
http://localhost:5173/?mode=atmosphere&time=2026-08-04T01:00:00Z&camera=95.7229,31.5070,11645,295.8,-4.3
```

## 后续

- perf Phase 2/3 其余项（lensflare 重设计 / LUT 降采样 / 多 pass 合并 / float32 LUT）仍 gate 在更细 profile 数据；本次仅清掉 Phase 1.1 这一项（收益最确定、风险最低）。
- profile 数据噪声问题（timer 被 GPU clock 调制）若要支撑后续 go/no-go，需改进测量手段（如固定 GPU 频率 / 锁 vsync off / 多帧去极值），属 Phase 0 基建改进。
