# 大气渲染性能优化 spec

> 日期：2026-08-05，基于 Bug1-6 修复后的 main（1367709）
> 目标：在保证视觉质量前提下，优化 atmosphere/tonemap/lensflare PostProcessStage 链的 GPU 开销。

## 背景

Bug1-6 修复后功能完整，但引入性能开销（5-tap depth + fore/base 双 inscatter + HalfFloat RT + depthTemporal stage）。本 spec 建立性能优化步骤：**先量化（profile），再针对性优化**，避免盲目优化。

## 性能热点（静态分析初判）

| 热点 | 位置 | 开销估算 | 优化方向 |
|------|------|---------|---------|
| **5-tap depth**（Bug4） | aerialPerspective main L341-354 | 5 次 `texture(depthTexture)` / 像素（全屏） | 降 tap 数（3-tap 十字）或 LOD 采样（textureLod 用预 mip 层）；或掠射才 5-tap（垂直少 tap） |
| **双 inscatter 调用** | L430（base）+ L447（fore） | GetSkyRadianceToPointScaled 2×（每次 2× GetCombinedScattering LUT 3D 采样 + 计算） | fore mask>0 才算 fore（已有 if）；可考虑 base/fore 合并或 LUT 预积分 |
| **HalfFloat RT 带宽** | atmosphere/tonemap RT | HalfFloat RGBA（8字节/像素）读写，全屏 | 已有 HalfFloat（非 FLOAT）；可考虑降到 RGBA16F 或共享 |
| **depthTemporal stage** | activeStages[0] | 额外全屏 pass（sceneColor 透传 + EMA），但 atmosphere 不消费（Bug3 回退） | **当前仅 lensflare occlusion 用**，若 lensflare 关闭可禁用 stage 省开销 |
| **LUT 3D 采样** | GetCombinedScattering | 256×128×32 sampler3D，每次 GetSkyRadianceToPointScaled 内多次 | 已是 LINEAR；考虑 LUT 尺寸降采样（质量换性能） |

## 性能优化步骤（量化驱动）

### Phase 0：量化基线（必须先做，无 profile 不优化）

1. **建立 GPU 计时**：demo 加 `EXT_disjoint_timer_query_webgl2` 或 `scene.debugShowFramesPerSecond`，或 Chrome DevTools Performance/Rendering 面板 GPU 帧分解。目标：atmosphere/tonemap/lensflare/depthTemporal 各 stage 的 GPU 时间（ms）。
2. **量化场景**：
   - camera 低（5km，fore inscatter 密集）：`camera=139.2399,34.8752,5000,8.7,-21.1`
   - camera 高掠射（64km，LUT 采样多）：`camera=139.2399,34.8752,64309,8.7,-21.1`
   - 全屏覆盖率（atmosphere stage 占帧时间比例）
3. **记录基线**：各 stage GPU 时间 + 总帧时间 + FPS。存到本 spec 的「基线」节（实现时填）。

### Phase 1：低成本优化（预期收益 > 风险）

按「改动小 + 收益大 + 风险低」排序：

1. **depthTemporal 条件禁用**（Bug3 后 atmosphere 不消费，仅 lensflare occlusion 用）：lensflare 关闭时（`?lensflare=0`）不创建 depthTemporal stage，省一全屏 pass。改动：AtmosphereStage L358 装配条件加 `resolved.lensFlare`。
2. **5-tap 降 3-tap 或自适应**：垂直俯视 depth 抖轻（Bug4 验证消波纹），掠射才需 5-tap。或掠射（mask 大）才 5-tap，垂直少 tap。改动：atmosphere main 5-tap 条件化。
3. **fore inscatter 早退已有**（mask>0 才算）：确认 `if (mask > 0.0)` 在 LUT 采样前（L444）——已做。

### Phase 2：中成本优化（profile 确认瓶颈后）

1. **LUT 预积分/降采样**：scattering 256×128×32 → 128×64×16（4× 小），质量换性能。需重预计算 .bin + 验证视觉（C 灾消风险）。
2. **HalfFloat → 更低精度 RT**：atmosphere 输出 RGBA16F 已是最低 HalfFloat。tonemap 输入可降 RGBA8（但破坏 HDR 链，phase2a 前提，不建议）。
3. **双 inscatter 合并**：fore/base 共享部分 LUT 采样（r/mu 相同部分）。复杂，需重构 GetSkyRadianceToPointScaled。

### Phase 3：高成本（仅当 profile 证明显著瓶颈）

1. **LUT 重预计算为 float32**（C 灾消修复顺带）：Generator 或离线脚本，同时可考虑降维。
2. **多 pass 合并**：depthTemporal + atmosphere 合并单 pass（需 atmosphere 消费 .a，Bug3 回退后暂不可行）。

## 验收标准

- 每 Phase 后：demo 视觉验收（camera 低/高空 + 垂直/掠射 + 山体）无回归（对比 main 1367709 基线）。
- 性能目标：atmosphere stage GPU 时间降低 ≥20%（Phase 0 基线对比），FPS 提升可测。
- test 226/226 + tsc 0 + glslang 全过（每 Phase 保持）。

## 风险

- **视觉回归**：任何优化（降 tap/LUT 降采样/降精度）需 demo 对比验收，重点看 Bug4/5/6 修复的效果（波纹/圆圈/描边）不回归。
- **profile 工具依赖**：EXT_disjoint_timer_query_webgl2 浏览器支持不一；fallback Chrome DevTools。
- **LOD 加载波纹**（已知限制）非性能问题，但优化时不应恶化（LOD 抖在加载期 inscatter 抖）。

## 参考

- results：`docs/superpowers/plans/2026-08-05-bug1-6-fix-results.md`（Bug1-6 修复 + 已知限制）
- memory：`camera-low-ema-tradeoff.md`（调试教训）
- phase2a：`docs/superpowers/plans/2026-08-04-phase2a-hdr-pipeline.md`（HDR 链，性能相关 RT 带宽）
