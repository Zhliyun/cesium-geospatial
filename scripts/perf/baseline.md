# 性能优化基线（Phase 0）

> 测量前提：demo 连续渲染（未开 requestRenderMode）；等 `scene.globe.tilesLoaded===true` 后静置 ≥2s 预热；
> 每场景每配置 ≥5 次取中位数；`about:gpu` 固定 GPU；记录 GPU 型号 + Chrome/ANGLE 版本 + 分辨率/DPR + 是否解锁 vsync。
> 采集工具：`scripts/perf/capture.ts`（截图 + 视觉门禁）+ demo `?profile=1`（逐 stage GPU ms，console 输出 JSON）。

## 环境

| 项 | 值 |
|---|---|
| GPU 型号 | （填，about:gpu） |
| Chrome/ANGLE 版本 | （填） |
| 窗口分辨率 + DPR | （填） |
| 计时工具 | timer query / toggle-diff |
| 是否解锁 vsync | （是/否） |

## 场景（4 个复现视角 + 2 极端分离变量）

> 公共参数：均加 `?mode=atmosphere&inscatterScale=25`（用户验收固化的主路径）。截图采集时另加 `&fps=0`（关 FPS 角标，避免污染门禁）
> **+ `&time=2026-08-04T01:00:00Z`（固定太阳方向）**——不固定则太阳位置随 wall-clock 变，ref/out 跨时间永不匹配，门禁失效；且该时刻在 139E/34N（日本）为上午日景，避免夜间过暗。
>
> **Bug4/5/6 camera URL 说明**：docs/memory 未记录逐 Bug 的精确复现视角，下表 URL 由相邻复现视角派生
> （nadir 俯视用 depth-temporal-ema results 的 `93.4055,32.7362,*,-89` 机位；山体/地平线掠射用 `95.7229,31.5070,11645,295.8,-4.3`）。
> 若 controller/用户手上有精确 Bug 视角 `#camera=`，替换后重新采集 ref 截图即可（capture.ts 按场景名对齐 ref/out）。

| 场景 | camera URL | 目的 |
|---|---|---|
| camera 低近地 | `?mode=atmosphere&camera=139.2399,34.8752,5000,8.7,-21.1` | fore inscatter 密集（mask=1 最重路径） |
| camera 高掠射 | `?mode=atmosphere&camera=139.2399,34.8752,64309,8.7,-21.1` | LUT 采样多 + 天空占比 |
| 纯天空 | `?mode=atmosphere&camera=139.2399,34.8752,64309,8.7,60` | sky 基线 + 无效 5-tap（同机位 pitch 朝天） |
| 纯 nadir | `?mode=atmosphere&camera=95.7229,31.5070,2000,295.8,-90` | 全屏 5-tap + fore mask=1（低空垂直俯视） |
| Bug4 垂直俯视山体（波纹） | `?mode=atmosphere&camera=95.7229,31.5070,11645,295.8,-90` | 波纹门禁（nadir 俯视山体，派生） |
| Bug5 圆圈阶梯 | `?mode=atmosphere&camera=93.4055,32.7362,1002025,0.0,-89` | 圆圈门禁（camera 高俯视，mask 过渡带，派生） |
| Bug6 地平线描边 | `?mode=atmosphere&camera=95.7229,31.5070,11645,295.8,-4.3` | 描边门禁（低空掠射近地平线，派生） |

## GPU 时间基线（timer query，各 stage ms，≥5 次中位数）

> 用 `?profile=1` 采集，console `[profile]` 行输出逐 stage JSON。列名与 profile 输出的 stage 名对齐。
> `depthTemporal_blit` 单独计时（每帧 postRender history blit，在 stage.execute 之外）。

| 场景 | depthTemporal | depthTemporal_blit | atmosphere | lensflare(外层) | tonemap | 总帧 ms | FPS |
|---|---|---|---|---|---|---|---|
| camera 低近地 | | | | | | | |
| camera 高掠射 | | | | | | | |
| 纯天空 | | | | | | | |
| 纯 nadir | | | | | | | |

## 视觉基线（参考截图 + 门禁阈值）

- **参考截图**：main 基线 4 Bug 视角 + 2 混合场景，存 `scripts/perf/ref/<场景名>.png`。
  采集命令见 `scripts/perf/capture.ts` 头部注释（`--save-ref` 写 ref，默认写 `out/` 并可 `--check` 门禁）。
- **门禁阈值**：`SSIM ≥ 0.999` 且 `maxΔ ≤ 2/255`，超过即回退（对应 spec §0.5 / 验收 §视觉）。
- **重点**：Bug4 垂直波纹 / Bug5 圆圈阶梯 / Bug6 地平线描边 / camera 低大气 不回归。
- **诊断放大**：如需放大暗部差异对照，可在 URL 加 `&debug=1`（log finalColor）单独采集对照组。

## 采集状态

> 本模板建立时（2026-08-06）的回填进度。**headless（SwiftShader）已跑通**；真实 GPU 数据待 controller/用户采集回写。

- [x] `capture.ts` headless 截图 + SSIM/maxΔ 门禁跑通（Playwright chromium + SwiftShader WebGL）。
- [x] ref 参考截图采集（`scripts/perf/ref/`，7 场景全）——**headless SwiftShader 后端**。
- [x] 门禁自洽验证：`--check` 6/7 PASS（SSIM=1.0 maxΔ=0），退出码契约正确（PASS=0 / FAIL=1）。
- [ ] 环境信息（GPU / Chrome / 分辨率 / vsync）回填——需真实浏览器。
- [ ] GPU 时间基线（`?profile=1`）回填——headless SwiftShader 的 ms 无意义，**必须真实 GPU**。
- [ ] **真实 GPU ref 重采**：下方注意——ref 与 out 必须同后端，真实 GPU 验收前需 `--save-ref` 重采。

### 采集发现（决策相关）

1. **`time` 必须固定**：不固定太阳方向随 wall-clock 变，ref/out 跨时间永不匹配。脚本已固定 `time=2026-08-04T01:00:00Z`（139E/34N 上午日景）。
2. **纯天空视角 `tilesLoaded` 可能长时间不 settle**（globe 出视锥）：capture.ts 已改容错（超时 warn 仍截图），单场景失败不中断整批。
3. **nadir 低空（2000m 垂直俯视）headless LOD 非确定**：两次 capture 收敛到不同瓦片 LOD（低 LOD 占位色 vs 部分影像），tint 差异 maxΔ=49 超阈。这是项目已知的瓦片异步加载抖（见 memory `camera-low-ema-tradeoff`），**非渲染/工具 bug**。
   → **视觉门禁以 4 Bug 视角为准**（camera 低/高掠射/Bug4 nadir 11645m/Bug6 地平线均确定性 PASS）；
   nadir/sky-only 是 spec §0.3 的**性能分离场景**，主要用于 GPU ms，不兼作视觉门禁。

## 注意（视觉门禁可比性前提）

ref 与 out 必须**同一渲染后端**采集（同 headless 或同真实 GPU）。headless Chromium 默认 SwiftShader 软件渲染，数值与真实 GPU 不可比；跨后端对比无意义。性能基线（GPU ms）只能在真实浏览器采集。真实 GPU 验收流程：

```bash
pnpm dev                                        # 起 demo
pnpm exec tsx scripts/perf/capture.ts --save-ref   # 真实 GPU 采 ref（需本地 Playwright 用 GPU，见下）
# ... 优化后 ...
pnpm exec tsx scripts/perf/capture.ts --check      # 过门禁
```

> headless 要用真实 GPU 而非 SwiftShader，可在 capture.ts `chromium.launch` 加 `--use-angle=metal --enable-gpu`
> （macOS/ANGLE Metal；headless=new 下有效性随 Chrome 版本变，需实测）。默认（无参）走 SwiftShader 自洽门禁。
