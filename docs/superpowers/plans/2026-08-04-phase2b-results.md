# phase2b 验收结果：image-based LensFlare（含 bloom + preBlur + occlusion）

> **日期**：2026-08-04（视觉验收待项目方填）
> **关联**：spec `../specs/2026-08-04-phase2b-lens-flare-design.md`；计划 `2026-08-04-phase2b-lens-flare.md`
> **状态**：⏳ 待视觉验收（单测 + glslang 已过）
> **分支**：`phase2b/lens-flare`

## 0. 前置
- dev server：`pnpm dev`（http://localhost:5173/）
- ion token：`apps/demo/.env.local` 的 `VITE_ION_TOKEN`（不入库），无 token 裸 globe 仍可验收 lensflare（后处理不依赖底图）。

## 1. 单测（自动）✅（待填实际数）
- [ ] `pnpm --filter @cesium-geospatial/core test`：core 全测 **XXX/XXX 通过**
- [ ] `pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/lensFlare/lensFlare.compile.test.ts`：glslang 全 shader（threshold/bloomDown/bloomUp/preBlur/features/occlusion/composite）**编译通过**
- [ ] `pnpm --filter demo exec tsc --noEmit`：demo 类型干净
- [ ] `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`：core 类型干净

## 2. 视觉回归（硬指标：phase1 五项零回归 + 水波纹专项）⏳

视角：phase2a 验收 URL（camera=93.1569,31.6636,13469,32.0,-4.2 + time=2026-08-04T06:30:00Z）+ 默认 lensflare 全开。

| # | 回归项 | 通过? | 备注 |
|---|---|---|---|
| 1 | 水波纹（俯视 nadir 远处渐变无同心色带） | ⏳ | input dithering 经 threshold/composite NEAREST 仍打散（dithering 稀释路径 I2 专项验） |
| 2 | 转动地平线闪动（掠射角无条纹） | ⏳ | DUAL inscatter 不动 |
| 3 | 山体不透明（近处山峰不透出地平线） | ⏳ | lensflare 不影响 hasScene/mask |
| 4 | 天空/太阳盘（ACES 后与 phase2a 一致） | ⏳ | lensflare 加法叠加在 ACES 前 |
| 5 | 地表过曝（groundDim 压住） | ⏳ | groundDim 不变 |

## 3. lensflare 验收（L1-L5）⏳

转向太阳视角（camera=93.1569,31.6636,13469,185,70 对准太阳）+ 默认 lensflare 全开。

| # | 项 | 通过? | 备注 |
|---|---|---|---|
| L1 | ghosts | ⏳ | 9 重影沿太阳-屏幕中心轴，tint 正确，preBlur 软化（非块状） |
| L2 | halo | ⏳ | 太阳周围紧环（采 preBlur）+ 色散 RGB |
| L3 | bloom | ⏳ | 太阳/亮源辉光，6 级 mipmap 渐变 |
| L4 | occlusion | ⏳ | 太阳被山挡 ghosts/halo 平滑衰减（36 点无台阶）；地球背面 flare 消失；bloom 周围溢光验收 |
| L5 | 兜底 | ⏳ | `?hdr=0` threshold 失效近透传不崩；`?lensflare=0` 回退 phase2a |

URL 调参（实测标定）：`?lfIntensity=`/`?lfThreshold=`/`?lfGhost=`/`?lfHalo=`。

## 4. 验收结论
- [ ] **phase2b 通过**：单测 + phase1 五项零回归 + 水波纹专项 + L1-L5 + 兜底全过。
- [ ] 可 finishing-a-development-branch 合并 main。

## debug 探针（后续可选增强）
spec §5.10 提 `?debug=8..12`（threshold/bloom/preBlur/occlusion/features 逐项隔离）需改 features/composite shader 加 debug 输出分支，本 phase 简化为 URL on/off + 调参 + ?lensflare=0 对比验收。后续按需加。
