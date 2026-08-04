# phase2a 验收结果：HDR 浮点后处理链基建

> **日期**：2026-08-04
> **关联**：spec `../specs/2026-08-04-phase2a-hdr-pipeline-design.md`；计划 `2026-08-04-phase2a-hdr-pipeline.md`
> **状态**：⏳ 待项目方浏览器验收（无 GPU 环境无法自动跑视觉回归）
> **分支**：`phase2a/hdr-pipeline`
> **实现 commits**：`4cb4cbf`（Task 1 tonemap）/ `d25e721`+`83df9cd`（Task 2 atmosphere 线性 + debug 级联修复）/ `fc5505e`（Task 3 双 stage + precision）/ `6e39d62`（Task 4 ?hdr=0）

## 0. 前置
- dev server：`pnpm dev`（http://localhost:5173/）
- ion token：`apps/demo/.env.local` 的 `VITE_ION_TOKEN`（不入库），无 token 裸 globe 仍可验收大气/天空。

## 1. 单测（自动，已通过 ✅）
- [x] `pnpm -r test`：core 全测 **66/66 通过**（tonemap.frag.test 8 + aerialPerspective.frag.test 20 + AtmosphereStage.test 17 + 其余）
- [x] `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.compile.test.ts`：glslang 全组合（atmosphere 3 宏组合 + tonemap + 防回归）**编译通过**
- [x] `pnpm --filter demo exec tsc --noEmit`：demo 类型干净
- **注**：core tsc（`pnpm --filter @cesium-geospatial/core exec tsc --noEmit`）有 9 个 pre-existing 错误（`aerialPerspective.compile.test.ts` 的 `node:child_process`/`process`/`Buffer` 等，缺 `@types/node`，phase1 既有，非 phase2a 引入）。建议后续单独加 `@types/node` 到 core 包 devDep。

## 2. 视觉回归（硬指标：五项与 phase1 不可区分）—— 待项目方浏览器

复用 phase1 验收 URL（`mode=atmosphere`，B 路径参数）。建议视角：`camera=93.1569,31.6636,13469,32.0,-4.2`（phase1 闪动验收视角）+ 太阳低角 `time=...`。

| # | 回归项 | 通过? | 备注 |
|---|---|---|---|
| 1 | 水波纹（俯视 nadir 远处渐变无同心色带） | ⬜ | input dithering 仍打散（atmosphere 保留） |
| 2 | 转动地平线闪动（掠射角无绿/红条纹） | ⬜ | DUAL inscatter 全不动 |
| 3 | 山体不透明（近处山峰不透出地平线） | ⬜ | hasScene/mask 仍 work |
| 4 | 天空/太阳盘（ACES 后颜色/亮度与 phase1 一致） | ⬜ | ACES 输入仍 HDR float，数学等价 |
| 5 | 地表过曝（groundDim=0.5 仍压住） | ⬜ | groundDim 不变 |

## 3. HDR 链验证（debug=7，证明 HalfFloat 承载 >1）—— 待项目方浏览器

- [ ] `?debug=7`：tonemap 输出 `clamp(linearHdr/5,0,1)` false-color。HalfFloat 设备：太阳/天空高光区显示**亮区**（接近 1，证明 `finalColor·exposure`>1 未被 clip）。
- [ ] 对比 `?hdr=0`（强制兜底）：atmosphere RT 被 RGBA8 clip 到 1.0 → debug=7 显示**暗区**（≈0.2）。
- [ ] 两路径太阳区亮度差异 = HalfFloat 承载 >1 的证据（log 归一化无法区分，故用线性归一化）。

## 4. 兜底验证（?hdr=0）—— 待项目方浏览器

- [ ] `?hdr=0` 不崩，画面除太阳盘变暗 ~20% 外与 HalfFloat 路径基本一致（预期退化，spec §5.1 量化）。
- [ ] 切回默认（无 `?hdr=0`）：HalfFloat 路径太阳盘亮白恢复。

## 5. 验收结论
- [ ] 单测全过 + 五项视觉回归不可区分 + debug=7 证明 HDR + ?hdr=0 兜底不崩 → phase2a 通过，可 `finishing-a-development-branch` 合并 main，进 phase2b（image-based LensFlare）设计。
- [ ] 任一失败 → 记录失败项，回对应 Task 修复后复验。
