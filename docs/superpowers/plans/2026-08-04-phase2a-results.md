# phase2a 验收结果：HDR 浮点后处理链基建

> **日期**：2026-08-04（视觉验收 2026-08-04 14:54 CST）
> **关联**：spec `../specs/2026-08-04-phase2a-hdr-pipeline-design.md`；计划 `2026-08-04-phase2a-hdr-pipeline.md`
> **状态**：✅ **通过**（单测 + 视觉回归 + HDR 链验证 + 兜底全过）
> **分支**：`phase2a/hdr-pipeline`
> **实现 commits**：`4cb4cbf`（Task 1 tonemap）/ `d25e721`+`83df9cd`（Task 2 atmosphere 线性 + debug 级联修复）/ `fc5505e`（Task 3 双 stage + precision）/ `6e39d62`（Task 4 ?hdr=0）

## 0. 前置
- dev server：`pnpm dev`（http://localhost:5173/）
- ion token：`apps/demo/.env.local` 的 `VITE_ION_TOKEN`（不入库），无 token 裸 globe 仍可验收大气/天空。

## 1. 单测（自动）✅
- [x] `pnpm -r test`：core 全测 **66/66 通过**（tonemap.frag.test 8 + aerialPerspective.frag.test 20 + AtmosphereStage.test 17 + 其余）
- [x] `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`：glslang 全组合（atmosphere 3 宏组合 + tonomap + 防回归）**编译通过**
- [x] `pnpm --filter demo exec tsc --noEmit`：demo 类型干净
- **注**：core tsc 有 9 个 pre-existing 错误（`aerialPerspective.compile.test.ts` 的 `node:child_process`/`process`/`Buffer` 等，缺 `@types/node`，phase1 既有，非 phase2a 引入）。建议后续单独加 `@types/node` 到 core 包 devDep。

## 2. 视觉回归（硬指标：五项与 phase1 不可区分）✅

视角：`camera=93.1569,31.6636,13469,32.0,-4.2` + `time=2026-08-04T06:30:00Z`（phase1 闪动验收视角）。

| # | 回归项 | 通过? | 备注 |
|---|---|---|---|
| 1 | 水波纹（俯视 nadir 远处渐变无同心色带） | ✅ | input dithering 仍打散（atmosphere 保留） |
| 2 | 转动地平线闪动（掠射角无绿/红条纹） | ✅ | DUAL inscatter 全不动 |
| 3 | 山体不透明（近处山峰不透出地平线） | ✅ | hasScene/mask 仍 work |
| 4 | 天空/太阳盘（ACES 后颜色/亮度与 phase1 一致） | ✅ | ACES 输入仍 HDR float，数学等价 |
| 5 | 地表过曝（groundDim=0.5 仍压住） | ✅ | groundDim 不变 |

## 3. HDR 链验证（debug=7，证明 HalfFloat 承载 >1）✅

视角转向南方高空对准太阳：`camera=93.1569,31.6636,13469,185,70`。

- [x] `?debug=7`（HalfFloat）：太阳盘区**白点（亮）**——`finalColor·exposure`>5 → `clamp(/5,0,1)` 接近 1，证明 HalfFloat 承载 >1 未被 clip。
- [x] `?debug=7&hdr=0`（强制兜底）：太阳盘**变暗**（≈0.2）——atmosphere RT 被 RGBA8 clip 到 1.0 → /5=0.2。
- [x] 两路径太阳盘亮度差 = HalfFloat 承载 >1 的证据。周围天空/地表在 debug=7 下昏暗属预期（`<1` → /5 暗；debug=7 是 HDR 量级归一化视图，非光照显示）。

## 4. 兜底验证（?hdr=0）✅

- [x] `?hdr=0` 不崩，太阳盘变暗 ~20%（预期退化，spec §5.1 量化），其余与 HalfFloat 路径基本一致。
- [x] 切回默认（无 `?hdr=0`）：HalfFloat 路径太阳盘亮白恢复。

## 5. 验收结论

- [x] **phase2a 通过**：单测全过 + 五项视觉回归与 phase1 不可区分 + debug=7 证明 HDR 链承载 >1（HalfFloat 亮 / 兜底暗）+ ?hdr=0 兜底不崩。
- [x] 可 `finishing-a-development-branch` 合并 main，进 phase2b（image-based LensFlare，three-geospatial 为主）设计。

## deferred Minor（合并后或 phase2b 前择机，不阻塞）

- **M1** tonomap.frag.test：ACES 常数单测钉死（`2.51` 等值断言）。
- **M2** AtmosphereStage `buildTonemapStage`：显式 `sampleMode: NEAREST`（防上游 Cesium 默认值变更，最低成本最高防护比）。
- **M3** tonomap.frag.test：uniform 名一致性从 shader 解析验证（对齐 aerialPerspective 模式）。
- **M4** core 包加 `@types/node` devDep（修 9 个 pre-existing tsc 错）。
