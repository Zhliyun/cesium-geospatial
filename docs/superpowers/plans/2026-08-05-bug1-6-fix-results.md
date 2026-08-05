# 大气透视调试收尾 results（Bug1-6 修复）

> 日期：2026-08-05，分支：fix/arc-flicker（合并 main）
> 起点：camera 低丢大气 + 高空水波纹张力（depthTemporal EMA 14 task 后视觉验收失败）
> 路径：B1 spec（eye-space EMA）→ 三专家评审证伪 → 诊断 → 6 bug 修复

## 调试历程

### 阶段 1：B1 spec 设计 + 三专家评审证伪

- 设计 B1（eye-space 米域 EMA）修张力：把 depth 反演移到 depthTemporal，EMA 在反演后米距离域。
- 三专家并行评审（Cesium 集成 / 数值精度 / temporal）：
  - **专家2（数值精度）CPU 证伪 B1 核心假设**：log-depth 反演不放大（sceneDist 5km，log-depth 路径 vs 米域路径误差比 1.008，非 spec 断言 >10 倍）。2-arg LOG_DEPTH 与 4-arg window-depth 反演数学等价（Cesium 源码确认同一 exp2 公式）。§5.3 决策门循环论证。
  - **专家2 M1 重大发现**：main atmosphere 的 buildAtmospherePrefix 无 `#define LOG_DEPTH` → czm_readDepth 返回 raw logDepth → 4-arg 反投影错（sceneDist≈1m）。「camera 低正常」是假象（无 fore inscatter，groundDim 兜底）。
  - **专家3（temporal）C1**：motion 门控 maxDelta=cameraHeight（地心距 6371km）*0.01=63.7km，camera 低平移 1km → alpha≈0.05（门控失效，与 EMA 域无关）。
- **结论**：放弃 B1 spec，转诊断优先。

### 阶段 2：诊断 + Bug1-3

- **Bug1**（反投影）：atmosphere 用 `czm_reverseLogDepthWindow`（logDepth.ts）显式反演 log-depth → 线性 window depth。camera 低/高空 fore inscatter 正确（sceneDist 正确）。`166e9b6`
- **Bug2**（门控）：`computeMaxDelta` 离地高度归一化（cameraHeight - ellipsoid.maximumRadius），camera 低 maxDelta≈50m（原 63.7km）。`33e5bfb`
- **Bug3**（EMA 消费）：atmosphere 双变体读 depthTemporal .a（EMA smoothLogDepth）。**验证失败**——debug=5 地球切割（reproject 错误累积，专家3 C3：raw worldPos 抖 → prevUV 抖 → history 采错）。?temporalEma=0 对比：切割消失 + 波纹仍在 → EMA temporal 对波纹无效。回退 `f4911b4`。

### 阶段 3：Bug4-6（空间平滑，波纹真根因）

波纹根因重新定位（用户描述：圆心相机正下方，等高线状）——**sceneDist 同心圆 inscatter 阶梯/抖，非 temporal**：

- **Bug4**（垂直俯视波纹）：log-depth 域 5-tap 空间平滑（中心+4邻域 depth 平均，排除 far-plane tap）。`0e8f27b`
- **Bug5**（垂直俯视圆圈阶梯）：debug=9 诊断（G=mask 圆环）→ fore mask `smoothstep(horizonKm, CLOSE_KM)` camera 高反向（horizonKm=905km > CLOSE_KM=20km，过渡带 885km 太宽）→ 改 `smoothstep(CLOSE_KM*2, CLOSE_KM)` 正向窄过渡。`1be3f9c`
- **Bug6**（地平线描边）：debug=9 诊断（B=hasScene 蓝边）→ 5-tap far-plane 排除翻转边缘 hasScene → hasScene 用中心 tap（tapC）非 5-tap 平均。`1912f70`
- 收尾：`01ef595` 移除 debug=9 临时诊断 + horizonKm dead code。

## 验证

- **test**：226/226 pass（core 全套 25 文件），含 5 个 computeMaxDelta test（Bug2）+ 3 atmosphere HDR 变体 test（Bug3）+ HDR glslang compile。
- **tsc**：0 error。
- **glslang**：aerialPerspective 全宏组合 + HDR 变体编译过。

## 视觉验收（用户确认）

- camera 低/高空 fore inscatter 正确（Bug1）✓
- 垂直俯视波纹消（Bug4）✓
- 垂直俯视圆圈阶梯消（Bug5）✓
- 地平线地形描边消（Bug6）✓
- 无 C 灾消条纹 ✓
- debug=5 无切割（Bug3 回退）✓

## 已知限制 / 后续 ticket

1. **掠射视角 LOD 加载过渡波纹**：Cesium 瓦片异步加载 depth 时序跳（camera 移动触发加载 → depth 值跳变 → sceneDist 抖 → fore inscatter 等高线波纹）。加载稳定后少。temporal EMA reproject 错（Bug3）、空间 5-tap 对掠射无效（depth 时序跳非空间高频）。彻底修需 LOD 检测降 inscatterScale 或修 EMA reproject（后续 ticket）。
2. **C 灾消（half-float LUT）**：camera 低近地形 `scattering - scattering_p` 相消丢精度（专家2 M3）。当前不致命（user 确认无条纹），但 Bug1 后 sceneDist 正确，若未来暴露需 float32 LUT 重预计算（Generator 或离线脚本）。
3. **性能优化**（另见性能优化 plan）：
   - 5-tap depth：5 次 texture fetch（每像素）
   - GetSkyRadianceToPointScaled 2× 调用（fore + base inscatter）
   - HalfFloat RT 带宽
   - depthTemporal stage（当前 atmosphere 不消费，仅 lensflare occlusion 用，可考虑禁用省开销）

## 关键文件

- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`：Bug1/4/5/6（反演 + 5-tap + mask + hasScene）
- `packages/cesium-core/src/cesium/AtmosphereStage.ts`：Bug2（computeMaxDelta 调用）+ Bug3（hdrDepthTemporal=false）
- `packages/cesium-core/src/cesium/depthTemporal/temporalAlpha.ts`：Bug2（computeMaxDelta 离地高度归一化）
- `packages/cesium-core/src/cesium/logDepth.ts`：Bug1（czm_reverseLogDepthWindow）

## 参考

- spec：`docs/superpowers/specs/2026-08-05-eye-space-ema-design.md`（B1，被证伪，保留存档）
- memory：`camera-low-ema-tradeoff.md`（完整教训）
- 三专家评审：Cesium 集成 / 数值精度（CPU 证伪）/ temporal（门控 + reproject）
