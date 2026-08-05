# 大气渲染性能优化 spec 评审报告（主评审汇总）

> 评审对象：`docs/superpowers/specs/2026-08-05-performance-optimization-design.md`
> 评审视角：Cesium/PostProcessStage 集成、数值精度/视觉质量、GPU 性能剖析方法（三专家，关键代码引用已抽查核实）

## 1. 总体结论

**spec 当前不可直接执行。** 「先量化再优化」的原则正确，但 Phase 0 的量化手段本身有两个 critical 缺口（macOS 下 DevTools 给不了 WebGL per-pass 分解、vsync 锁帧使 FPS 差值法静默失效），而 spec 自己定死「无 profile 不优化」——不修这两点，后续所有 Phase 都被阻塞或建立在假信号上。

最大风险：**Phase 1.2「掠射才 5-tap」的自适应方向与 Bug4 修复证据恰好相反**（5-tap 修的是垂直俯视，掠射 5-tap 已被证实无效），按 spec 执行必致波纹回归。最大遗漏：**默认配置（lensflare 开）下 depthTemporal 全速运行只为喂 1/16 分辨率的 occlusion，且 lensflare 内部 5 个全分辨率 HalfFloat pass 完全不在热点表和优化项中**——这两处是比 Phase 2 LUT 降采样收益更大、风险更低的优化空间。

## 2. Critical 问题

### C1. Phase 1.2 自适应方向写反：垂直俯视才需要 5-tap，掠射 5-tap 已被证实无效
（数值精度专家，方向经核实）

- **证据**：spec L36「垂直俯视 depth 抖轻（Bug4 验证消波纹），掠射才需 5-tap」；但 `docs/superpowers/plans/2026-08-05-bug1-6-fix-results.md` L28 明确 Bug4（垂直俯视波纹）的修复手段就是 log-depth 域 5-tap 空间平滑，L50 已知限制又明确「空间 5-tap 对掠射无效（depth 时序跳非空间高频）」。且 `u_inscatterScale` 默认 25，sceneDist 残差噪声会被放大 25 倍输出。
- **后果**：按 spec 执行 → (a) 垂直俯视降 tap → Bug4 波纹直接回归（违反硬约束）且被 ×25 放大；(b) 掠射保留的 5-tap 是已知无效开销，收益为负。
- **建议**：方向反转——垂直/近垂直俯视（|muLook| 大）保留 5-tap，掠射降 tap（那里 5-tap 本就不起作用，无回归风险）。执行前用 debug=5 在 Bug4 复现视角对比降 tap 前后波纹幅值。

### C2. Phase 0 逐 stage GPU 计时无可执行落地方案
（GPU 剖析专家）

- **证据**：spec L24 只列工具名。macOS Chrome 的 DevTools Performance 面板只有 raster/composite 线程，无逐 WebGL draw 的 GPU 分解；`EXT_disjoint_timer_query_webgl2` 在 Cesium 无 query 封装（Context.js 仅初始化扩展），gl 对象需 `scene.context._gl` 受控 cast（项目已有同类惯例 AtmosphereStage.ts:239）。可插桩点实际存在（PostProcessStage.prototype.execute 同步提交 GL draw），但 spec 未写。
- **后果**：Phase 0 卡在「怎么测」，而「无 profile 不优化」使后续 Phase 全部阻塞。
- **建议**写死方案：(1) 包装各 stage 的 execute 包 `beginQuery/endQuery(TIME_ELAPSED_EXT)`（不可嵌套，同帧只能选一层粒度——lensflare 取外层或逐子 stage 二选一）；(2) 查询对象入 ring buffer 跨 ≥2 帧后轮询 `QUERY_RESULT_AVAILABLE_EXT`（立即读会 stall pipeline），每帧先查 `GPU_DISJOINT_EXT` 置位则整帧丢弃；(3) 扩展缺失时 fallback toggle-diff；(4) 封装成 `?profile=1` 模式输出逐 stage ms JSON。

### C3. vsync 锁帧下 FPS 差值法静默失效，而验收标准依赖它
（GPU 剖析专家）

- **证据**：spec L24 把 `debugShowFramesPerSecond` 当基线工具、L53「FPS 提升可测」。rAF 锁 60/120Hz，链总开销小于帧预算时关掉任何单 stage FPS 差恒为 0。
- **后果**：Phase 0 基线与 Phase 1-3 验收（「atmosphere GPU 时间降 ≥20%、FPS 提升可测」）建立在最有价值量程内不可观测的信号上。
- **建议**：二选一写进测量前提——(1) `--disable-gpu-vsync --disable-frame-rate-limit` 解锁后用 FPS/帧时间差值；(2) 推荐以 timer query 直读 ms 为主手段（不受 vsync 影响），toggle-diff 降为交叉验证。同时确认「demo 连续渲染（未开 requestRenderMode）」为测速前提。

## 3. Major 问题

### M1. 默认配置下 depthTemporal 仍全速运行，唯一消费者是 1/16 分辨率的 occlusion——spec 漏掉的最大单项冗余
（Cesium 集成专家，代码已核实）

- **证据**：`AtmosphereStage.ts:344` atmosphere 编译期 `hdrDepthTemporal:false`，不读 `.a`；全仓库唯一按名引用 `czm_depth_temporal` 的是 `lensFlare/createLensFlareStage.ts:238/254` 的 occlusion（textureScale=0.0625）；depthTemporal 成本 = 每帧 1 个全分辨率 HalfFloat pass（读 3 纹理）+ 每帧 postRender 全屏 blit（L482-492）+ 3 张常驻全分辨率 HalfFloat RT。spec Phase 1.1 只在 `?lensflare=0` 时禁用它，而 lensflare 默认开（main.ts:231）。
- **建议**：Phase 0 profile 项显式量化 depthTemporal pass + blit 的 GPU 时间以证成/证伪其存在价值；评估 occlusion 直接用 scene globe depth（回退路径已存在，`useSmoothDepth=false` 分支 UNSIGNED_BYTE 设备天天在跑），把整个 depthTemporal stage 从默认配置移除，`?temporalEma=1` 保留可选开启。收益确定（省 1 全屏 pass + 1 全屏 copy + 3 张全分辨率 HF 纹理），风险低于 Phase 2 LUT 降采样。

### M2. lensflare composite 的 5 个全分辨率 HalfFloat pass 完全缺席热点表与优化项
（Cesium 集成专家，代码已核实）

- **证据**：默认配置全屏 pass 清单 = depthTemporal(1) + atmosphere(1) + lensflare 内 threshold/preBlur/features/up4/composite(5) + tonemap(1) = 8 个，lensflare 独占 62.5%（createLensFlareStage.ts L168/228/272/288 + up 链末级）。spec 热点表无 lensflare 任何一行；Phase 0 只把 lensflare 当单一 stage 计时，无法定位子 stage。
- **建议**：热点表加 lensflare 子 stage 行；Phase 0 按子 stage 计时；新增低成本项——up4 并入 composite（composite 改引 up3@0.5 + LINEAR 采样，省 1 全屏 pass）、threshold 降 0.5（唯一消费者是 down0@0.5 与 preBlur，对 bloom 质量几乎无损）、评估 preBlur/features 降分。零物理风险（不碰 LUT/depth/half-float 精度），大概率超过 LUT 降采样收益。

### M3. 「掠射才 5-tap」的门控信号存在循环依赖
（数值精度专家）

- **证据**：spec L36 提议用 mask 门控，但 `mask = smoothstep(…, sceneDist)`（aerialPerspective.frag.ts:447），sceneDist 又由 5-tap 平滑后的 logDepth 反演——判定信号是被平滑对象的未平滑版，本身在抖 → 相邻像素 tap 数判定逐像素翻转 → 平滑强度空间不连续，在 mask 边界制造 Bug4 同类条纹。
- **建议**：门控改用 `muLook`（L400 已有的平滑视线几何量，不读 depth、无循环依赖），且过渡必须 smoothstep 连续化，避免 tap 数硬切换产生分界线。

### M4. Phase 2.1 LUT 降采样的灾消风险被五字带过，缺量化方法与三重放大评估
（数值精度专家）

- **证据**：spec L41 仅「C 灾消风险」。三重放大被漏掉：(1) 各维减半 → 三线性插值误差约 ×4，叠加 half-float 存储误差，直接喂给灾消式 `scattering − shadow_transmittance·scattering_p`（runtime.glsl:355）；(2) 相减残差再被 inscatterScale=25 放大；(3) MU_SIZE 128→64 使地平线 mu texel 变宽一倍，eps=0.004 horizon hack 余量缩水需重新标定，而地平线恰是 Bug4/5/6 artifact 集中区。安全余量未知（results:51「当前不致命」）。
- **建议**：降采样前先建 CPU 离线评估：两分辨率下对 camera 低近地 + 掠射参数网格求灾消式相对误差分布（P99/max），×25 后与 display LSB 对比定回退阈值；优先非均匀降维（nu 维最平滑可降，mu/mu_s 近地平线梯度陡尽量保）。

### M5. 全流程视觉回归检测只有人眼，精度类优化缺数值化门禁
（数值精度专家）

- **证据**：spec L52 验收只写「demo 视觉验收无回归」，无数值手段；本 spec 优化项全属亚阈值回归类型（波纹幅值变大一点、banding 多一级），人眼单次对比极易漏判，累积到可见时已跨多个 Phase 难定位。Phase 0 量化了性能却不量化画质，与「先量化再优化」不自洽。demo 的 camera URL 参数化已具备固定视角复现能力。
- **建议**：每 Phase 加数值化门禁——4 个 Bug 复现视角固定 camera URL 截图，与 main 基线做 PSNR/SSIM + 最大像素差（可用 debug=1 log finalColor 放大暗部差异），阈值写进验收标准（如 SSIM≥0.999 且 maxΔ≤2/255），超过即回退。可纯脚本化（headless 截图）。

### M6. Phase 3「多 pass 合并」唯一具体项自认不可行，可行的合并目标漏掉
（Cesium 集成专家）

- **证据**：spec L48 唯一具体项「depthTemporal + atmosphere 合并」被自己标注「Bug3 回退后暂不可行」。真正可行的未列入：(a) lensflare 关时 atmosphere+tonemap 合并（中间无 HDR 消费者，tonemap 是纯 per-pixel 函数，tonemap.frag.ts:63），省一次全分辨率 HF 写+读；(b) lensflare 开时 tonemap 并入 lf_composite 末端（composite 输出即线性 finalColor，追加 ACES+gamma+dither 无邻域依赖）。两条路径都保住 phase2a HDR 语义。
- **建议**：Phase 3 改为上述两项条件合并；合并后随迁约束——tonemap NEAREST 语义（合并后变直接计算天然满足）、input dithering 逐像素直通、debug=7 HDR 验证分支、buildStandaloneShaderForValidation 双入口与 glslang 全宏组合矩阵。depthTemporal+atmosphere 合并标注「Bug3 未解前冻结」防踩回。

### M7. 现有开关测不出 depthTemporal 真实开销
（GPU 剖析专家）

- **证据**：`?temporalEma=0` 时 stage 仍创建走透传（AtmosphereStage.ts:428-429 注释），差值只反映 EMA vs 透传 shader 算术差，不含 RT 读写带宽；每帧全屏 blit 在 postRender（stage.execute 之外），stage 级插桩天然漏掉。两种 profiling 手段都系统性低估 depthTemporal。
- **建议**：Phase 0 先加 `?depthTemporal=0`（不创建 stage + 不注册 postRender blit listener；atmosphere 不消费 `.a`、occlusion 回退路径已存在，跳过安全）。该开关同时是 Phase 1.1 条件创建的载体，一次改动两处用。timer query 方案把 blit 包一对 query 或归入 depthTemporal 项。

### M8. 量化场景不能分离变量，且缺瓦片加载稳定前置
（GPU 剖析专家）

- **证据**：spec 仅 5km/64km 两混合场景，无法把 stage 时间归因到 sky 基线/ground 基线/5-tap/fore inscatter 哪一项——Phase 1.2 与 Phase 2.3 的收益无从单独验证。5-tap 对全屏无条件执行（天空像素照 fetch 4 邻域，代码已核实），fore inscatter 仅 mask>0 触发（nadir 全屏 mask=1 最重路径）。瓦片未加载期 depth 抖 + 网络争抢直接污染基线，spec 未要求等 tilesLoaded。
- **建议**：补纯天空（同机位 pitch 朝天）与纯地面 nadir（低空垂直俯视）两极端场景；前置写死 `scene.globe.tilesLoaded === true` 后静置 ≥2s 预热，每场景每配置 ≥5 次取中位数。

## 4. Minor / 建议（合并）

- **Phase 1.1 实现注记行号漂移 + 测试断言需同步**（Cesium 专家）：「L358 装配条件」实为 AtmosphereStage.ts:373 `stageCreated`；L374 temporalEmaEnabled 与 L393 occlusion 接线从 stageCreated 派生无需改；**必须同步更新 AtmosphereStage.test.ts 中 stageCreated 断言并补 lensFlare:false+HDR 新用例**——与「每 Phase 保持 test 226/226」验收直接相关，spec 改动说明应写明。
- **「?lensflare=0」是创建时参数，与注释声称的运行时 enabled=false 机制不一致**（Cesium 专家）：main.ts:231 创建时传入（false 则 composite 不存在），注释描述的 M1 运行时切换无人使用。spec 写明 Phase 1.1 仅覆盖创建时关闭；并二选一：修正注释，或补运行时联动（lensFlareStage.enabled=false 时同步关 depthTemporalStage + 跳过 blit）。
- **「3-tap 十字」不可能对称**（精度专家）：相邻两向（R+U）有方向性偏置会被 ×25 放大成方向性条纹；对向两向（R+L）垂直向无平滑恰是 Bug4 所需。降 tap 须保持对称（5-tap 保留、2×2 双线性单 fetch、或按 C1 方向掠射才降）。
- **Phase 2.1 依赖的 .bin 重预计算管线不在仓库内，「中成本」低估**（精度专家）：只有 precompute.glsl 源码，无可运行 harness，lutLoader 尺寸常量与 cesiumCore.ts 的 SCATTERING_TEXTURE_*_SIZE define 全写死。把「可重复预计算管线（参数化分辨率 + half-float 导出 + 离线误差评估）」显式列为 Phase 2.1 第 0 步单独估时——它同时是 Phase 3.1 float32 LUT 的前置，一次投入两处复用。
- **基线记录需结构化**（GPU 剖析专家）：固定表格字段——场景 URL | 窗口分辨率+DPR | GPU 型号+Chrome/ANGLE 版本 | 工具与是否解锁 vsync | 每配置 ≥5 次中位数 | 各 stage ms | 总帧 ms | FPS；每 Phase 后同表回写对比。

## 5. 遗漏的更大收益项（blindSpots 汇总）

1. **tapC 早退跳 4-tap（GPU 剖析专家，代码已核实）——比 Phase 1.2 更简单且零视觉风险**：5-tap 全屏无条件执行，`tapC >= 1.0`（天空/未渲染像素）时 4 次邻域 fetch 对输出零影响（logDepth/sceneDist/mask 仅在 hasScene 内消费）。`if (tapC < 1.0)` 包住另 4 tap 即省天空区 80% depth 采样，不动任何 ground 像素数值（Bug4 的 5-tap 平均只在 tapC<1.0 时有意义）。**建议作为 Phase 1 新增项排在视角自适应之前**，用纯天空场景先量化。
2. **lensflare 子 stage 降分/合并是零物理风险的纯带宽优化**（Cesium 专家）：threshold/up4/preBlur/features 不碰 LUT、不碰 depth、不碰 half-float 精度，比有 C 灾消风险的 LUT 降采样更符合「低成本高收益」却完全缺席（见 M2）。
3. **depthTemporal 的存在价值本身需 profile 证成**（Cesium 专家）：Bug3 回退 + 「波纹非 temporal 是 LOD 加载抖」结论后，唯一消费者是 1/16 分辨率 occlusion，spec 没有要求用数据证成它在默认配置下的留存理由（见 M1）。
4. **收益模型应明确为「pass 带宽」而非显存**（Cesium 专家）：Cesium PostProcessStageTextureCache 已按依赖图回收同尺寸 RT，「每 stage 一个 RT」的显存问题比直觉小；Phase 3 减 pass 方向对，但应写明收益在 pass 数 × 全分辨率带宽。
5. **精度视角的收益排序**（精度专家）：无损的 Phase 2.3（双 inscatter 合并，相同输入 bit 等价、数学零风险）应先于有损的 2.1（降采样，三重放大）——spec 顺序恰好相反。注意 2.3 可共享范围被高估：仅第一次 GetCombinedScattering 查表可共享（8 次 3D fetch 中的 2 次，25% 上限，且仅 mask>0 近地像素），spec 应写明边界让 profile 决定是否值得重构；边界像素 ClipAtBottomAtmosphere 后 base/fore 可能不再 bit 等价需回退独立计算。
6. **inscatterScale=25 的乘性交互应写进每个 Phase 的风险节**（精度专家）：灾消残差、tap 噪声、LUT 插值误差全部 ×25 输出，目前风险节完全没提。
7. **depthTexture 预滤波方向未展开**（精度专家）：生成 mip 后 textureLod 单 fetch 近似 5-tap，log-depth 域 mip 平均 ≈ 几何平均，与现 5-tap 语义一致、回归风险低——既保平滑质量又省 fetch，spec 热点表只提了一句「LOD 采样」未展开。
8. **天空分支开销未评估**（精度专家）：高空 64km 场景天空像素占比大，若 profile 显示 sky 分支是热点，three-geospatial 的 `GetExtrapolatedSingleMieScattering` 等裁剪项值得排查。
9. **R11G11B10F 结论应记录防重复评估**（Cesium 专家）：Cesium 公开 PixelDatatype 无 R11G11B10F，RGBA16F 确是最小可渲染 HDR（spec Phase 2.2 结论成立）；atmosphere RT 的 `.a` 下游无人消费，理论上可省一半中间 RT 带宽，但需绕开公开 API 自建纹理，收益/侵入性不划算——建议 spec 明确记录此结论。
10. **profiling 环境稳定性**（GPU 剖析专家）：macOS 双 GPU 切换造成跨次基线漂移（about:gpu 固定 GPU 并写进基线表）；Apple TBDR 上相邻 pass 时间有 ±5-10% 涂抹（取中位数缓解）；Phase 2/3 的 go/no-go 应由 Phase 0 各项耗时占比决定而非预先承诺。

## 6. 对 spec 的具体修改建议（按 Phase）

### Phase 0（成败关键，全部前置）
- [ ] 写死 timer query 插桩方案：包装 stage.execute 包 query + ring buffer 跨帧异步读 + disjoint 整帧丢弃 + 扩展缺失 fallback；blit 单独包 query 归入 depthTemporal 项（C2/M7）。
- [ ] 写明 vsync 处理：timer query 为主手段，FPS 差值法仅在解锁帧率后有效（C3）；验收标准「FPS 提升可测」改为「各 stage GPU ms 对比可测」。
- [ ] 加 `?depthTemporal=0` 开关（不创建 stage + 不注册 blit listener），同时作为 Phase 1.1 载体（M7）。
- [ ] 计时粒度细分到 lensflare 子 stage（threshold/preBlur/features/up4/composite 分别计时）（M2）。
- [ ] 量化场景补纯天空 + 纯 nadir 两极端；前置 tilesLoaded + 静置 2s + ≥5 次中位数（M8）。
- [ ] 基线节改固定表格（分辨率/DPR/GPU/浏览器版本/工具/是否解锁 vsync），并固定 GPU（M4-minor/遗漏 10）。
- [ ] **同步建立视觉数值基线**：4 个 Bug 复现视角参考截图 + PSNR/SSIM/maxΔ 阈值（M5）。

### Phase 1
- [ ] **新增第 0 项：tapC 早退**（`tapC >= 1.0` 跳过另 4 次 depth fetch）——零视觉风险，排在所有项之前（遗漏 1）。
- [ ] 1.1 修正行号为 AtmosphereStage.ts:373；写明仅覆盖创建时 lensFlare:false；同步更新测试断言 + 补新用例；升级评估「默认移除 depthTemporal（occlusion 回退 scene depth），`?temporalEma=1` 可选开」——由 Phase 0 数据决定（M1/minor×2）。
- [ ] 1.2 **方向反转**：垂直俯视保留 5-tap、掠射降 tap；门控用 muLook + smoothstep 连续过渡，禁用 mask/sceneDist 门控；降 tap 保持对称结构，禁止 3-tap 十字（C1/M3/minor）；执行前 debug=5 在 Bug4 视角验证。
- [ ] 新增：lensflare 子 stage 低成本项——up4 并入 composite、threshold 降 0.5（M2）。

### Phase 2
- [ ] **2.3（无损合并）提到 2.1（有损降采样）之前**；写明可共享边界（仅第一次 scattering 查表、25% 上限）与 ClipAtBottomAtmosphere 边界像素处理（遗漏 5）。
- [ ] 2.1 前置第 0 步：搭可重复预计算管线（参数化分辨率 + half-float 导出 + 离线误差评估）；降采样前跑 CPU 误差网格定回退阈值；优先非均匀降维；地平线 eps 重新标定（M4/minor）。
- [ ] 记录 R11G11B10F 评估结论，防后续重复评估（遗漏 9）。
- [ ] 每个 Phase 风险节补 inscatterScale=25 乘性交互（遗漏 6）。

### Phase 3
- [ ] 「多 pass 合并」改为可执行两项：lensflare=off 时 atmosphere+tonemap 条件合并；lensflare=on 时 tonemap 并入 lf_composite。随迁约束：NEAREST/dither 语义、debug=7 分支、standalone 校验双入口、glslang 宏矩阵。depthTemporal+atmosphere 合并标注「Bug3 未解前冻结」（M6）。

### 验收标准
- [ ] 视觉验收从「人眼对比」改为数值化门禁（SSIM≥0.999 且 maxΔ≤2/255，超过即回退）（M5）。
- [ ] 「FPS 提升可测」改为各 stage GPU ms 与总帧 ms 的基线表对比（C3）。