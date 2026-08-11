# 性能优化 Phase 0+1 results

> 日期：2026-08-06（Phase 0+1 实施），2026-08-11 收尾
> 基于：spec v2（`docs/superpowers/specs/2026-08-05-performance-optimization-design.md`）+ plan（`docs/superpowers/plans/2026-08-05-performance-optimization.md`）
> 范围：Phase 0 量化基建（Task 1-3）+ Phase 1 低成本优化（Task 4-7）
> commit 范围：`0779937..d18f8c1`（8 commit）

## 总览

| Task | 内容 | 状态 | commit |
|------|------|------|--------|
| 1 | StageGpuTimer（EXT_disjoint_timer_query 逐 stage GPU 计时） | ✅ | eca5ce7 |
| 2 | demo `?profile=1` 接线 + depthTemporal blit 计时 | ✅ | 1edd6a6 + 84720f9 + 72c1fa9（2 轮 Critical 修复） |
| 3 | 结构化基线表 + 4 Bug 视角视觉门禁脚本（capture.ts） | ✅ | 266d4cb |
| 4 | 5-tap tapC 早退（tapC>=1.0 跳 4 邻域，零视觉风险） | ✅ | 60d4773 |
| 5 | depthTemporal 条件禁用（`?depthTemporal=0`） | ✅ | afc60c8 |
| 6 | 5-tap 视角自适应（muLook 门控，垂直保留/极掠射降） | ✅ | d18f8c1（含 bug5 回归修复） |
| 7 | lensflare 子 stage 压缩 | ⏭️ 跳过 | Cesium 源码证伪 plan 前提（见下） |

---

## Phase 0：量化基建（Task 1-3）

### Task 1：StageGpuTimer（commit eca5ce7）

`packages/cesium-core/src/cesium/profile/stageGpuTimer.ts`——纯类封装 `EXT_disjoint_timer_query_webgl2`：
- 包 `stage.execute` 包 `begin/endQuery(TIME_ELAPSED_EXT)`
- read 就绪门：轮询 `QUERY_RESULT_AVAILABLE_EXT`（非阻塞，立即读 `QUERY_RESULT` 会 stall pipeline）
- `GPU_DISJOINT_EXT` 置位整帧丢弃；扩展缺失 `supported=false`（fallback toggle-diff）
- read 升序遍历取**最新**值（质量评审修复：原降序让最旧值胜出，Task 2 每 60 帧 read 会上报 ~60 帧前旧值）
- 删 `tickFrame`/`framesAgo` 死代码（质量评审）

单测 4/4 + 全量 233/233 + tsc 0。

### Task 2：demo `?profile=1` 接线（commit 1edd6a6 + 84720f9 + 72c1fa9）

`apps/demo/src/main.ts` `?profile=1` 用 StageGpuTimer 包 postProcessStages 全部 stage execute（递归 composite 子 stage）+ `setBlitTimerHook` 把 depthTemporal blit 包成 `depthTemporal_blit` + postRender 每 60 帧 console 输出 `[profile]` JSON。

**两轮 Critical 修复**（Cesium 源码实证）：
1. `PostProcessStageComposite` 无 `execute` 方法（84720f9）→ 递归判 `typeof st.execute === 'function'`。
2. composite 无 `stages` 属性，子 stage 在私有 `_stages`，公开走 `.length`+`.get(i)`（72c1fa9）→ 递归条件改 `typeof st.get === 'function' && typeof st.length === 'number'`。

得逐子 stage 计时（lf_threshold/lf_preBlur/lf_features/lf_composite 等），正好是 lensflare 压缩需要的粒度。

### Task 3：基线表 + 视觉门禁脚本（commit 266d4cb）

- `scripts/perf/baseline.md`：结构化基线表（环境/场景/GPU 时间表/视觉门禁）。
- `scripts/perf/capture.ts`：Playwright headless 截图 + SSIM/maxΔ 门禁，CLI `--save-ref`/`--check`/`--only`/`--profile`；compareImages 逐通道 maxΔ + 简化窗口 SSIM（K1=0.01/K2=0.03）。
- demo `main.ts` 暴露 `window.__viewer`（harness 轮询 tilesLoaded）。
- **超预期**：headless SwiftShader 跑通，采 7 场景 ref，`--check` 自洽验证（退出码 0/1）。

**采集发现**（影响门禁设计）：
1. `time` 必须固定（否则太阳方向随 wall-clock 变，ref/out 永不匹配）→ 脚本固定 `time=2026-08-04T01:00:00Z`。
2. 纯天空视角 `tilesLoaded` 可能不 settle → 容错。
3. **nadir 低空 LOD 非确定**（瓦片异步加载抖）→ 视觉门禁以 4 Bug 视角为准，nadir/sky-only 仅作性能分离场景。

---

## Phase 1：低成本优化（Task 4-7）

### Task 4：tapC 早退（commit 60d4773，零视觉风险）

`aerialPerspective.frag.ts` 非 EMA `#else` 分支：`if (tapC < 1.0)` 包住 4 邻域 tap fetch + 5-tap 平均。天空/未渲染像素（tapC>=1.0）省 80% depth 采样，**ground 像素逐位不变**（数值等价：tapC<1.0 时 tapSum=tapC/tapCount=1.0 起 + 条件累加等价原三元；tapC>=1.0 时 logDepth/depth 不被 `if (hasSceneDepth<1.0)` 消费故输出零差异）。

质量评审实证 mip 安全：depthTexture 单级 NEAREST 无 mipmap（Cesium FramebufferManager），非均匀控制流内 texture() 无 UB。

frag 26/26 + glslang 6/6 + 视觉门禁 6/7 SSIM=1.0/maxΔ=0（nadir pre-existing LOD）。

### Task 5：depthTemporal 条件禁用（commit afc60c8）

`?depthTemporal=0` → 不创建 depthTemporal stage + 不注册 postRender blit listener（省 1 全分辨率 HalfFloat pass + 1 全屏 copy + 3 张全分辨率 HF RT）。`depthTemporal` option 三处（options/Resolved/validate）默认 true，`stageCreated = postHdrDatatype !== UNSIGNED_BYTE && resolved.depthTemporal`。

- atmosphere 不消费 `.a`（`hdrDepthTemporal:false` Bug3 回退）+ occlusion 回退 scene globe depth（`temporalEmaEnabled=false`），跳过安全。
- **Phase 0 计时载体 + Phase 1.1 优化载体**（评审 M7）。
- 默认 true 行为与现状完全一致（逻辑等价）。

AtmosphereStage.test 40/40 + core 232/232 + tsc 0。

### Task 6：5-tap 视角自适应（commit d18f8c1，含 bug5 回归修复）

**方向反转**（评审 C1，旧 spec 写反）：垂直/近垂直俯视（|muLook|→1）保留 5-tap（Bug4 有效场景），极掠射（|muLook|<0.3）降 tap（5-tap 对掠射无效=depth 时序跳非空间高频）。muLook 门控（评审 M3：不读 depth、无循环依赖，绝不用 mask/sceneDist 循环依赖）。

- 前移 `cameraPosition/rayDirection/radialOut/muLook` 到 depth 采样前。
- `useSpatial = smoothstep(0.15, 0.3, abs(muLook))`，`if (useSpatial > 0.5)` 5-tap else 中心 tap。

**bug5 回归修复**（plan 未预见）：原过渡带 `smoothstep(0.3, 0.6)` 导致 bug5 圆圈阶梯回归（高空俯视 1002km 地球边缘 |muLook|≈0.5 落过渡带 → tap 切换 → inscatter 敏感区回归 maxΔ=43）。收窄到 `smoothstep(0.15, 0.3)`：仅极掠射（|muLook|<0.3，如 bug6≈0.075）降 tap，地球边缘（0.4-0.5）保留 5-tap。

- bug4/bug5/camera-low/camera-high-graze 确定性 PASS（maxΔ≤1）。
- bug6 极掠射 footprint（弥散 ≤3 LSB，SSIM=0.99994，用户决策 A 接受 + regen ref）。
- frag 27/27 + glslang 6/6 + tsc 0。

### Task 7：lensflare 子 stage 压缩 ⏭️ 跳过（Cesium 源码证伪 plan 前提）

plan 两个方案都基于对 Cesium 机制的不正确假设（impl-task7 读 Cesium 1.143 源码实证）：

**up4 并入技术不可行**（真实原因比 plan 的 dithering 冲突更深）：
- 移除 up4 → up3 成 series 末级无后继 → outputTexture.sampler 退化 NEAREST（FramebufferManager 默认，series 后继 execute 才覆盖前驱 sampler）→ composite 采样 lf_up3@0.5 块状上采样。
- composite.sampleMode 改 LINEAR 也救不了：只设 atmosphere input colorTexture.sampler，`u_bloomTexture` sampler 独立不受控（仍 NEAREST）→ 双输（抹 dithering + 块状）。

**threshold 降 0.5 非「零物理风险」**（评审 M2 前提被证伪）：
- (a) up4 仍消费 threshold（`UP_DOWN_LEVEL_NAMES[4]='lf_threshold'`）。
- (b) threshold@0.5 + down0@0.5 同分 → down0 下采样退化同分 blur → bloom pyramid 少一级 → 光晕高频变化。
- (c) 需同步改 3 处 `u_texelSize`（threshold/down0/preBlur）+ up4 support 降分。

用户决策 A 跳过。**Phase 2 方向**：降 preBlur/features 分辨率，或重构 pyramid（配套 threshold 降分同时移除 down0）。

---

## 视觉门禁方法论（Phase 1 实践修正）

`maxΔ≤2/255` 硬阈值适用于「**零影响优化**」（Task 4 tapC 早退、Task 5 depthTemporal 默认 true）——这类优化输出逐位不变，任何 delta 是 bug。

对「**预期改变渲染的优化**」（Task 6 掠射 tap 切换、Task 7 lensflare 压缩），门禁改为：
- **无结构 artifact**（无条纹/分界线/描边，SSIM≥0.999 佐证）。
- **弥散 LSB 差异可接受**（优化足迹区 ≤3/255）。
- **ref 随优化更新**（每 Phase regen ref）。
- **Bug 敏感区零容忍**（Bug4/5/6 复现视角即使预期改变优化也 maxΔ≤2/255）。

详见 `scripts/perf/baseline.md`「视觉门禁方法论」节。

---

## 验证状态

| 项 | 结果 |
|---|---|
| core test | 233/233 ✅ |
| tsc core + demo | 0 error ✅ |
| glslang（atmosphere 全宏组合） | 6/6 ✅ |
| 视觉门禁（headless SwiftShader） | 4 Bug 视角确定性 PASS；nadir pre-existing LOD 抖；bug6 极掠射 footprint（用户接受） |
| 真实 GPU profile ms | ⏳ 待用户真实浏览器采集（headless ms 无意义） |

---

## Phase 2/3 go/no-go（需真实 GPU profile 数据）

spec Phase 2/3 的 go/no-go 由 Phase 0 各项耗时占比决定（非预先承诺）。**待用户用 `?profile=1` 在真实 GPU 采集各 stage ms 后回填 `scripts/perf/baseline.md` GPU 时间表**，据数据决定：

- **depthTemporal 默认移除**（Phase 1.1 升级）：Phase 0 量化 depthTemporal pass+blit 占比 → 若显著，默认移除（occlusion 回退 scene depth），`?temporalEma=1` 可选开。
- **lensflare 重设计**（Phase 2）：Task 7 跳过后，按 profile 数据选 preBlur/features 降分 或 pyramid 重构。
- **LUT 降采样**（Phase 2.2）：C 灾消三重放大风险，需 CPU 离线误差评估管线（同时是 Phase 3.1 float32 LUT 前置）。
- **多 pass 合并**（Phase 3.2）：lensflare 关时 atmosphere+tonemap / lensflare 开时 tonemap 并入 lf_composite。

---

## 待办

1. **真实 GPU profile ms 采集**（用户）：`?profile=1` 4 场景（camera 低/高掠射/纯天空/纯 nadir）+ 真实 GPU ref 重采，回填 `baseline.md`。
2. **Phase 2/3 go/no-go**：基于 profile 数据决定上述优化项。
3. **nadir/bug6 LOD 抖**（已知限制）：headless 门禁这两场景不可靠，真实 GPU 验收时复核；或降 SSE 缓解（`?sse=N`）。
4. **Task 7 Phase 2 重设计**：lensflare 压缩需绕开 Cesium sampler 机制约束（series 末级退化 NEAREST）。

## 参考

- spec：`docs/superpowers/specs/2026-08-05-performance-optimization-design.md`（v2）
- 评审：`docs/superpowers/specs/2026-08-05-performance-optimization-review.md`（三专家）
- plan：`docs/superpowers/plans/2026-08-05-performance-optimization.md`
- baseline：`scripts/perf/baseline.md`
- Bug1-6 results：`docs/superpowers/plans/2026-08-05-bug1-6-fix-results.md`
