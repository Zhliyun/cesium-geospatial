# 大气渲染性能优化 spec（v2）

> 日期：2026-08-05，基于 Bug1-6 修复后的 main（1367709 / 1360e67）。
> 目标：在保证视觉质量前提下，优化 atmosphere/tonemap/lensflare/depthTemporal PostProcessStage 链的 GPU 开销。
> 原则：**先量化（profile），再优化**——无 profile 不优化。
> v2：纳入三专家评审（`2026-08-05-performance-optimization-review.md`）的全部修订。核心修正：Phase 1.2 方向反转（垂直才需 5-tap，掠射 5-tap 无效）、Phase 0 量化手段写死、补数值化视觉门禁、补 lensflare 子 stage / depthTemporal 默认冗余 / tapC 早退等更大收益项。

## 背景

Bug1-6 修复后功能完整，但引入性能开销（5-tap depth + fore/base 双 inscatter + HalfFloat RT + depthTemporal stage）。评审重新核算了**默认配置（lensflare 开）的全屏 pass 清单**：

```
depthTemporal(1) + atmosphere(1) + lensflare[threshold/preBlur/features/up4/composite](5) + tonemap(1) = 8 个全分辨率 pass
```

**lensflare 独占 5 个（62.5%），是链上最大 pass 带宽来源**——而旧 spec 热点表完全没列它。收益模型是 **pass 数 × 全分辨率带宽**（Cesium `PostProcessStageTextureCache` 已按依赖图回收同尺寸 RT，显存问题比直觉小，真正成本在 pass 带宽）。

## 性能热点（评审修订后）

| 热点 | 位置 | 开销 | 优化方向 |
|------|------|------|---------|
| **lensflare 5 子 stage**（评审 M2，最大盲区） | createLensFlareStage.ts threshold/preBlur/features/up4/composite | 5 个全分辨率 HalfFloat pass | 子 stage 计时；up4 并入 composite；threshold 降 0.5；preBlur/features 降分（零物理风险，不碰 LUT/depth/half-float） |
| **depthTemporal 默认冗余**（评审 M1） | activeStages[0]，AtmosphereStage.ts | 1 全分辨率 HalfFloat pass（读 3 纹理）+ 每帧 postRender 全屏 blit + 3 张常驻全分辨率 HF RT | Bug3 回退后 atmosphere 不消费 `.a`，唯一消费者是 1/16 分辨率 occlusion。评估默认移除（occlusion 回退 scene depth），`?temporalEma=1` 可选开 |
| **5-tap depth**（Bug4） | aerialPerspective main | 5 次 `texture(depthTexture)`/像素（**全屏无条件**，天空像素照 fetch 4 邻域） | **tapC 早退**（`tapC>=1.0` 跳 4 tap，零视觉风险）+ 视角自适应（**垂直保留/掠射降**，muLook 门控） |
| **双 inscatter 调用** | base（tHitG）+ fore（sceneDist） | GetSkyRadianceToPointScaled 2× | 可共享边界有限（仅第一次 GetCombinedScattering 查表，8 次 3D fetch 中的 2 次，25% 上限，仅 mask>0 像素）；无损但收益有限，由 profile 决定 |
| **LUT 3D 采样** | GetCombinedScattering | 256×128×32 sampler3D，每次多次 | 降采样有 C 灾消三重放大风险（见 Phase 2.1 风险评估） |
| **HalfFloat RT 带宽** | atmosphere/tonemap RT | RGBA16F 已是最小可渲染 HDR（Cesium 公开无 R11G11B10F，评审确认，记录防重复评估） | 降格式空间小；收益在减 pass 而非降格式 |

**乘性交互（评审遗漏 6，写入每个 Phase 风险）**：`u_inscatterScale` 默认 25，灾消残差、tap 噪声、LUT 插值误差**全部 ×25 输出**——任何精度类优化的回归都会被放大。

---

## Phase 0：量化基线（必须先做，无 profile 不优化）

评审结论：**Phase 0 是本 spec 成败关键**。两个原 critical 缺口（macOS DevTools 给不了 WebGL per-pass 分解、vsync 锁帧使 FPS 差值法失效）必须先修，否则后续 Phase 全阻塞或建立在假信号上。

### 0.1 逐 stage GPU 计时（主手段，写死方案）

`debugShowFramesPerSecond`（已开）只给整体帧率；macOS Chrome DevTools Performance 面板只有 raster/composite 线程，**无逐 WebGL draw 的 GPU 分解，对本任务基本不可用**。逐 stage 计时用 `EXT_disjoint_timer_query_webgl2`：

1. **插桩点**：包装各 stage 实例的 `execute`（`PostProcessStage.prototype.execute` 末行 `this._command.execute(context, passState)` 同步提交 GL draw，execute 首尾即该 stage 的 GL 命令区间）。`beginQuery(TIME_ELAPSED_EXT) → 原 execute → endQuery`。gl 对象用 `scene.context._gl` 受控 cast（项目已有惯例 AtmosphereStage.ts:239）。
   - **不可嵌套**：`TIME_ELAPSED` 同帧只能选一层粒度——lensflare 取外层 composite **或**逐子 stage 二选一（评审 M2 要求细分到子 stage）。
   - **blit 计时**：depthTemporal 的每帧全屏 history blit 在 postRender（stage.execute 之外），单独包一对 query 或归入 depthTemporal 项（评审 M7）。
2. **读取协议（关键，否则 stall pipeline 改变被测对象）**：查询对象入 ring buffer，跨 **≥2 帧**后轮询 `QUERY_RESULT_AVAILABLE_EXT` 再取 `QUERY_RESULT_EXT`（立即 `getQueryParameter` 会 stall）。每帧先查 `GPU_DISJOINT_EXT`，置位则整帧丢弃。
3. **fallback**：`gl.getExtension('EXT_disjoint_timer_query_webgl2')` 为 null 时退到 toggle-diff。
4. **封装**：`?profile=1` 模式，console 输出逐 stage ms JSON（可脚本化复测，评审 blindSpot）。

### 0.2 vsync 处理（评审 C3）

rAF 锁 60/120Hz。链总开销 < 帧预算时，关掉任何单 stage FPS 差恒为 0——**toggle-diff 和「FPS 提升」在最有价值量程内不可观测**。

- **主手段**：timer query 直读 ms（不受 vsync 影响）。
- **交叉验证**：FPS/帧时间差值仅在 Chrome 启动参数 `--disable-gpu-vsync --disable-frame-rate-limit` 解锁后有效。
- **测速前提**：demo 未开 `requestRenderMode`（连续渲染）；macOS 双 GPU 切换会致跨次基线漂移，`about:gpu` 固定 GPU 并写进基线表。

### 0.3 量化场景（评审 M8：能分离变量）

原 5km/64km 两混合场景无法把 stage 时间归因到 sky/ground/5-tap/fore 哪项。补两个极端场景分离变量：

| 场景 | camera | 目的 |
|------|--------|------|
| camera 低近地 | `139.2399,34.8752,5000,8.7,-21.1` | fore inscatter 密集（mask=1 最重路径） |
| camera 高掠射 | `139.2399,34.8752,64309,8.7,-21.1` | LUT 采样多 + 天空占比 |
| **纯天空**（新增） | 同机位 pitch 朝天 | 全屏 sky 基线 + 无效 5-tap，暴露固定采样开销（验证 tapC 早退收益） |
| **纯 nadir**（新增） | 低空垂直俯视 | 全屏 5-tap + fore mask=1，压满双 inscatter（验证合并收益） |

**前置条件**：等 `scene.globe.tilesLoaded === true`（瓦片未加载期 depth 抖 + 网络争抢污染基线）后静置 ≥2s 预热；每场景每配置 **≥5 次取中位数**（Apple TBDR 相邻 pass 时间 ±5-10% 涂抹）。

### 0.4 基线记录（结构化，评审 minor）

固定表格，每 Phase 后同表回写对比：

| 场景 URL | 分辨率+DPR | GPU 型号+Chrome/ANGLE 版本 | 工具/是否解锁 vsync | 每配置≥5次中位数 | depthTemporal ms | atmosphere ms | lensflare 子 stage ms | tonemap ms | 总帧 ms | FPS |
|---|---|---|---|---|---|---|---|---|---|---|

### 0.5 视觉数值基线（评审 M5，与性能基线同步建立）

原 spec 只量化性能不量化画质，与「先量化再优化」不自洽。同步建立**数值化视觉门禁**：

- 对 4 个 Bug 复现视角（camera 低 5km、高空 64km 掠射、垂直俯视山体、地平线）固定 camera URL 截图，作为 main 基线参考。
- 每 Phase 优化后与基线做 **PSNR/SSIM + 最大像素差**（可用 `debug=1` log finalColor 放大暗部差异）。
- demo 的 camera URL 参数化 + 停稳 `#camera=` 自动更新，使 harness 可纯脚本化（headless 截图）。

**落地（Phase 0.4/0.5 基建，2026-08-06）**：harness 在 `scripts/perf/`——`baseline.md`（结构化基线表 + 场景清单）+ `capture.ts`（Playwright headless 截图 + SSIM/maxΔ 门禁，CLI `--save-ref`/`--check`/`--profile`，退出码 0/1）。已 headless（SwiftShader）跑通并采 7 场景 ref，`--check` 自洽验证通过（退出码契约正确）。三个决策相关发现（详见 baseline.md「采集发现」）：①截图 URL 必须**固定 `time`**（否则太阳方向随 wall-clock 变，ref/out 永不匹配）；②纯天空视角 `tilesLoaded` 可能不 settle（脚本已容错）；③**nadir 低空垂直俯视 headless 有 LOD 加载非确定性**（两次 capture 收敛不同瓦片 LOD → tint 差超阈），故视觉门禁以 4 Bug 视角为准，nadir/sky-only 仅作性能分离场景。**待办**：真实 GPU 的环境信息 + `?profile=1` GPU ms 基线 + 同后端 ref 重采，由 controller/用户在真实浏览器回填 `baseline.md`（headless SwiftShader 的 ms 无意义）。

---

## Phase 1：低成本优化（预期收益 > 风险，零/低视觉回归）

### 1.0 tapC 早退跳 4-tap（评审 blindSpot 1，**排最前，零视觉风险**）

5-tap 全屏无条件执行，`tapC >= 1.0`（天空/未渲染像素）时 4 次邻域 fetch 对输出零影响（logDepth/sceneDist/mask 仅在 `hasSceneDepth < 1.0` 内消费；hasSceneDepth 只由 tapC 反演）。

```
float tapC = texture(depthTexture, v_textureCoordinates).r;
if (tapC < 1.0) { 取 tapR/L/U/D + 平均 }  // 否则 logDepth = 1.0
```

省天空区 80% depth 采样，**不动任何 ground 像素数值**（Bug4 的 5-tap 平均只在 tapC<1.0 时有意义）。改动最小、零风险，先量化（纯天空场景）再做。

### 1.1 depthTemporal 条件禁用 / 默认移除（评审 M1/M7 升级）

- **Phase 0 先量化** depthTemporal pass + blit GPU 时间，证成/证伪其默认存在价值。
- **加 `?depthTemporal=0`**：不创建 stage + 不注册 postRender blit listener（atmosphere 不消费 `.a`、occlusion 回退路径已存在，跳过安全）。该开关同时是本项与 Phase 0 计时载体，一次改动两处用。
- **评估默认移除**：Bug3 回退 + 「波纹非 temporal 是 LOD 加载抖」结论后，唯一消费者是 1/16 分辨率 occlusion。occlusion 直接用 scene globe depth（`useSmoothDepth=false` 回退分支 UNSIGNED_BYTE 设备天天在跑），把整个 depthTemporal stage（含 history RT + blit + lifecycle listener）从默认配置移除，`?temporalEma=1` 保留可选开。**收益确定**（省 1 全屏 pass + 1 全屏 copy + 3 张全分辨率 HF RT），风险低于 Phase 2 LUT 降采样。
- **实现注记**（评审 minor）：条件在 `AtmosphereStage.ts:373 stageCreated`（非 spec 旧写的 L358）；`temporalEmaEnabled`(L374) 与 occlusion 接线（L393) 从 stageCreated 派生无需改。**必须同步更新 AtmosphereStage.test.ts 的 stageCreated 断言 + 补 `lensFlare:false`+HDR 新用例**（与「每 Phase 保持 226/226」验收直接相关）。
- **`?lensflare=0` 是创建时参数**（评审 minor）：main.ts:231 创建时传入，注释声称的运行时 `enabled=false` 机制无人使用。本项仅覆盖创建时关闭；二选一：修正注释，或补运行时联动（`lensFlareStage.enabled=false` 时同步关 depthTemporal + 跳 blit）。

### 1.2 5-tap 视角自适应（评审 C1/M3，**方向反转**）

**方向**：垂直/近垂直俯视（|muLook| 大）**保留** 5-tap，掠射（|muLook| 小）**降** tap。

- **依据（评审 C1）**：Bug4 修的是垂直俯视波纹（log-depth 域 5-tap 空间平滑，results:28）；已知限制明确「空间 5-tap 对掠射无效（depth 时序跳非空间高频）」（results:50）。掠射 5-tap 是已知无效开销，降 tap 无回归风险；垂直俯视降 tap 会让 Bug4 波纹回归（违反硬约束）且被 ×25 放大。**旧 spec「掠射才 5-tap」方向写反**。
- **门控信号（评审 M3）**：绝不用 mask/sceneDist（循环依赖——mask←sceneDist←5-tap，判定信号本身在抖，会制造边界条纹）。改用 `muLook`（aerialPerspective.frag.ts:400 已有的平滑视线几何量，不读 depth、无循环依赖），且过渡必须 smoothstep 连续化，避免 tap 数硬切换产生分界线。如 `float taps = mix(3.0, 5.0, smoothstep(0.3, 0.6, abs(muLook)))`。
- **对称结构（评审 minor）**：降 tap 须保持对称——禁止 3-tap 十字（相邻两向 R+U 方向性偏置被 ×25 放大成方向性条纹；对向两向 R+L 垂直向无平滑恰是 Bug4 所需）。保留 5-tap、或 2×2 双线性单 fetch、或掠射才降。
- **验证**：执行前 `debug=5` 在 Bug4 复现视角（垂直俯视山体）对比降 tap 前后波纹幅值。

### 1.3 lensflare 子 stage 低成本项（评审 M2，零物理风险）

- **up4 并入 composite**：composite 已 string 引用 lf_up4，改引 lf_up3@0.5 + 采样 LINEAR，省 1 个全屏 HalfFloat pass。
- **threshold 降 0.5**：唯一消费者是 down0@0.5 与 preBlur，对 bloom 质量几乎无损，省半张全屏 HF 写。
- **评估 preBlur/features 降分**：ghost/halo 是低频量。
- 不碰 LUT/depth/half-float 精度，**零物理风险，大概率超过 Phase 2 LUT 降采样收益**。

---

## Phase 2：中成本优化（profile 确认瓶颈后）

**收益排序（评审遗漏 5）**：无损的 2.1（合并）先于有损的 2.2（降采样）。

### 2.1 双 inscatter 合并（无损，但收益有限）

- **可共享边界（评审 minor）**：base（point=camera+ray·tHitG）与 fore（point=camera+ray·sceneDist）同 camera 同方向仅 d 不同 → 仅第一次 GetCombinedScattering 的 r/mu/mu_s/nu 相同可共享（8 次 3D fetch 中的 2 次，**25% 上限**，且仅 mask>0 近地像素）。transmittance 查表含 d、第二次查表 r_p/mu_p 全依 d → 不可共享。
- **数学安全**：相同输入 bit 等价、不加剧灾消——这是该方案的优点。
- **边界坑**：ClipAtBottomAtmosphere 对 base/fore 行为可能不同（point 在椭球面上 float 舍入可使 point_below 翻转），共享第一查表在这些边界像素不再 bit 等价 → 共享值按各自 ClipAtBottomAtmosphere 后状态分别校验，或边界像素回退独立计算。
- **由 profile 决定**：收益上限写明（fore 像素 3D fetch 的 25%），让 Phase 0 数据决定是否值得重构 GetSkyRadianceToPointScaled 暴露中间查表结果。

### 2.2 LUT 降采样（有损，三重放大风险，评审 M4）

- **前置第 0 步（评审 minor）**：搭可重复预计算管线（参数化分辨率 + half-float 导出 + 离线误差评估）。仓库内仅有 precompute.glsl 源码，无可运行 harness；lutLoader 尺寸常量与 cesiumCore 的 SCATTERING_TEXTURE_*_SIZE define 全写死。**该管线同时是 Phase 3.1 float32 LUT 的前置，一次投入两处复用**。
- **三重放大风险评估（评审 M4，先量化再决定）**：(1) 各维减半 → 三线性插值误差约 ×4，叠加 half-float 存储误差，喂给灾消式 `scattering − shadow_transmittance·scattering_p`（runtime.glsl:355）；(2) 相减残差再被 inscatterScale=25 放大；(3) MU_SIZE 128→64 使地平线 mu texel 变宽一倍，eps=0.004 horizon hack 余量缩水需重新标定，而地平线恰是 Bug4/5/6 artifact 集中区。安全余量未知（results:51「当前不致命」）。
- **离线评估**：两分辨率下对 camera 低近地 + 掠射参数网格求灾消式相对误差分布（P99/max），×25 后与 display LSB 对比**定回退阈值**。
- **优先非均匀降维**：nu 维最平滑可降，mu/mu_s 近地平线梯度陡尽量保，而非各维一律减半。

### 2.3 HalfFloat 格式（记录结论，防重复评估）

Cesium 公开 PixelDatatype 无 R11G11B10F，RGBA16F 已是最小可渲染 HDR（评审确认）。atmosphere RT 的 `.a` 下游无人消费，理论上 R11G11B10F 可省一半中间 RT 带宽，但需绕开公开 API 自建纹理，收益/侵入性不划算——**记录此结论，不再重复评估**。

---

## Phase 3：高成本（仅当 profile 证明显著瓶颈）

### 3.1 float32 LUT 重预计算（顺带修 C 灾消）

Generator 或离线脚本。复用 Phase 2.2 前置搭的可重复预计算管线。

### 3.2 多 pass 合并（评审 M6，改为可执行项）

原 spec「depthTemporal+atmosphere 合并」自认不可行（Bug3 回退）→ **标注「Bug3 未解前冻结」**。改为两项可执行条件合并：

- **lensflare 关时 atmosphere+tonemap 合并**：中间无 HDR 消费者，tonemap 是纯 per-pixel 函数（tonemap.frag.ts:63），省一次全分辨率 HF 写+读。
- **lensflare 开时 tonemap 并入 lf_composite 末端**：composite 输出即线性 finalColor，追加 ACES+gamma+display dither 是纯 per-pixel 操作，无邻域采样依赖。
- **随迁约束**：tonemap NEAREST 语义（合并后变直接计算天然满足）、input dithering 逐像素直通、`debug=7` HDR 验证分支随迁、buildStandaloneShaderForValidation 双入口与 glslang 全宏组合矩阵。

---

## 验收标准（评审 C3/M5 修订）

- **性能**：以 **各 stage GPU ms 与总帧 ms 的基线表对比**为准（不再用「FPS 提升可测」——vsync 锁帧下不可观测）。目标：atmosphere 链总 GPU 时间降 ≥20%（Phase 0 基线对比）。
- **视觉（数值化门禁）**：4 个 Bug 复现视角固定 camera URL 截图，与 main 基线 **SSIM≥0.999 且 maxΔ≤2/255**，超过即回退。重点看 Bug4 垂直波纹 / Bug5 圆圈阶梯 / Bug6 描边 / camera 低大气不回归。
- **test 226/226 + tsc 0 + glslang 全过**每 Phase 保持。
- **Phase 2/3 的 go/no-go 由 Phase 0 各项耗时占比决定**（评审 blindSpot），非预先承诺。

## 风险

- **视觉回归**：任何优化需过数值化门禁（0.5），重点 Bug4/5/6 修复效果不回归。**inscatterScale=25 乘性交互**写入每个精度类优化的风险评估。
- **profile 工具**：timer query 插桩按 0.1 写死方案；扩展缺失 fallback toggle-diff（仅解锁 vsync 后有效）。
- **LOD 加载波纹**（已知限制）非性能问题，优化时不应恶化。

## 参考

- 评审：`docs/superpowers/specs/2026-08-05-performance-optimization-review.md`（三专家评审，C/M/Minor + 10 遗漏项）
- results：`docs/superpowers/plans/2026-08-05-bug1-6-fix-results.md`（Bug1-6 修复 + 已知限制）
- memory：`camera-low-ema-tradeoff.md`（调试教训：波纹非 temporal 是 LOD 加载抖）
- phase2a：`docs/superpowers/plans/2026-08-04-phase2a-hdr-pipeline.md`（HDR 链，RT 带宽）
