# phase2b 验收结果：image-based LensFlare（含 bloom + preBlur + occlusion）

> **日期**：2026-08-04（视觉验收通过）
> **关联**：spec `../specs/2026-08-04-phase2b-lens-flare-design.md`；计划 `2026-08-04-phase2b-lens-flare.md`
> **状态**：✅ 通过（单测 + glslang + phase1 五项零回归 + 水波纹专项 + L1-L5 + 兜底全过；验收中发现 ghost 衰减常数 bug，已于 `f9cc1ee` 修复）
> **分支**：`phase2b/lens-flare`

## 0. 前置
- dev server：`pnpm dev`（http://localhost:5173/）
- ion token：`apps/demo/.env.local` 的 `VITE_ION_TOKEN`（不入库），无 token 裸 globe 仍可验收 lensflare（后处理不依赖底图）。

## 1. 单测（自动）✅
- [x] `pnpm --filter @cesium-geospatial/core test`：core 全测 **164/164 通过**（20 test files）
- [x] `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/lensFlare/lensFlare.compile.test.ts`：glslang **8/8 通过**（7 shader：threshold/bloomDown/bloomUp/preBlur/features/occlusion/composite + 防哑过）
- [x] `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`：core 类型干净（exit 0）
- [x] `pnpm --filter demo exec tsc --noEmit`：demo 类型干净（exit 0）

## 2. 视觉回归（硬指标：phase1 五项零回归）✅

视角：`camera=93.1569,31.6636,13469,32.0,-4.2 + time=2026-08-04T01:00:00Z`（phase2a 验收 URL）+ 默认 lensflare 全开。

| # | 回归项 | 通过? | 备注 |
|---|---|---|---|
| 1 | 水波纹（俯视 nadir 远处渐变无同心色带） | ✅ | input dithering 经 threshold/composite NEAREST 保护（dithering 稀释路径 I2 专项验） |
| 2 | 转动地平线闪动（掠射角无条纹） | ✅ | DUAL inscatter 不动 |
| 3 | 山体不透明（近处山峰不透出地平线） | ✅ | lensflare 不影响 hasScene/mask |
| 4 | 天空/太阳盘（ACES 后与 phase2a 一致） | ✅ | lensflare 加法叠加在 ACES 前 |
| 5 | 地表过曝（groundDim 压住） | ✅ | groundDim 不变 |

## 3. 水波纹专项 ✅（dithering 稀释路径 I2 无回归）

lensflare 链路（threshold → bloomDown/Up → preBlur → features → composite）多个 stage 间用 NEAREST 采样 + threshold/composite 端点保护，input dithering 三角噪声不被双线性插值稀释；俯视 nadir 远处渐变无同心色带（与 phase2a 一致）。

## 4. lensflare 验收（L1-L5）✅

转向太阳视角：`camera=95.5324,31.4975,14917,269.1,-5.2 + time=2026-08-04T10:30:00Z`。

| # | 项 | 通过? | 备注 |
|---|---|---|---|
| L1 | ghosts | ✅ | **修复衰减常数 bug `f9cc1ee`**，ghost 从「垂直/水平细长线」变回「沿太阳-屏幕中心轴的离散圆点」。详见 §6 |
| L2 | halo | ✅ | 太阳周围紧环（采 preBlur）+ 色散 RGB |
| L3 | bloom | ✅ | 默认 `threshold=3.0` 偏高，傍晚太阳低空大气衰减后 radiance<3 筛不出；URL `lfThreshold=0.5-1.0 + lfIntensity=0.03` 让 bloom 圆辉光显出。参数标定待固化（§7） |
| L4 | occlusion | ✅ | 36 点覆盖率，太阳被山挡 ghost/halo 平滑衰减（无台阶/无闪） |
| L5 | 兜底 | ✅ | `?hdr=0` threshold 失效近透传不崩；`?lensflare=0` 回退 phase2a |

URL 调参（验收建议）：`?lfThreshold=1.0&lfIntensity=0.03`（bloom 明显 + ghost 圆点）。

## 5. 验收结论 ✅
- [x] **phase2b 通过**：单测全过 + phase1 五项零回归 + 水波纹专项 + L1-L5 + 兜底全过。
- [x] 可 finishing-a-development-branch 合并 main。

## 6. ghost 衰减常数 bug 修复（验收中发现并修复，重要）

- commit `f9cc1ee`：`cesium/lensFlare/features.frag.ts` 的 ghost 衰减 `d` 分母常数移植错误。
- **根因**：three-geospatial `lensFlareFeatures.frag` 写 `#define SQRT_2 0.70710678`（**命名误导——实际是 1/√2，不是 √2**）→ `d = length(0.5 - suv) / (0.5 * SQRT_2)` = 除以 `0.35355339`。
- spec §5.4 移植时按字面 `√2 = 1.41421356` 用 → 分母 `0.5 * 1.41421356 = 0.7071`（**原版 2 倍**）→ `d` 减半 → `pow(1 - d, 3)` 衰减慢 → **ghost 圆斑半径 ~2 倍** → 密集 offset（`-0.1 / -0.2 / -0.4`）圆斑重叠成垂直/水平细长线（太阳水平居中→垂直线，垂直居中→水平线）。
- **修复**：分母改 `0.5 * 0.70710678`（对齐原版），圆斑缩半，ghost 变回离散圆点。
- **防回归**：`features.frag.test.ts` 加断言钉死——源码含 `0.70710678` 且不含 `1.41421356`。
- spec §5.4 已勘误。

## 7. 参数标定备注（实测，部分待固化）

- `thresholdLevel` 默认 **3.0**：正午/高空太阳 OK；**傍晚低空太阳大气衰减后需降到 0.5-1.0**（否则 threshold 筛不出 → bloom=0）。待固化为按太阳高度角自适应 或调默认。
- `intensity` 默认 **0.01**：bloom 偏弱（增强 <5% 看不清）；实测 `0.03` bloom 圆辉光才明显。待固化。
- `ghostAmount` 默认 **0.05**：ghost 衰减 bug 修复后 OK（离散圆点，不重叠）。
- **建议 URL（验收用）**：`?lfThreshold=1.0&lfIntensity=0.03`（bloom 明显 + ghost 圆点）。

## 8. debug 探针（后续可选增强）

spec §5.10 的 `?debug=8..12`（threshold/bloom/preBlur/occlusion/features 逐项隔离）需改 shader 加 debug 输出分支，本 phase 简化为 URL on/off + 调参 + `?lensflare=0` 对比验收。后续按需加。

## 9. 后续衔接
- **bloom 默认参数固化**：threshold 自适应（按太阳高度角）/ intensity 调默认。
- **starburst**：WebGPU compute → WebGL2 anamorphic streak。
- **bloom 减法**：`NUM_BLOOM_LEVELS` 可配置，验收后按需降级。
