# P4 兜底光柱步幅太阳角自适应——results（2026-09-21）

## 动机

用户验收 main（`?camera=56.9420,26.8977,124,79.4,0.5`，**裸 URL 未钉 time**）只见 35FPS（ego-lite 与真 Chrome 38FPS 一致）。排查（全钉后归因）发现 P3 的兜底 ×2 定稿存在**场景敏感性**：

- 兜底分支（`!hitClouds`）成本 ∝ **无云像素占比**，随时刻/天气演化漂移；
- 2026-09-05 定标场景（午后，远云排占满天空）兜底 ~3.3ms；2026-09-21 上午同一机位天空开阔，兜底涨至 ~10ms（step100→400 一项回收 8ms 证实）；
- 09-05 定标两端恰好覆盖 P4 曲线：白天（elev≈60°，FULL 域）×4 逐位零差=高端证据；黄昏/朝太阳日落（14:00Z elev≈3°，FLOOR 域）×4 伤海面散射、×2 定稿=低端证据。缺的只是中间插值域。

## 实现（零依赖新增，与 A 影子预算同构）

| 文件 | 改动 |
|---|---|
| `shadowBudgetAdaptation.ts` | +`SHADOW_FALLBACK_SCALE_MIN=2.0/MAX=4.0` +纯函数 `shadowFallbackStepScale(elev, full, floor)`：≤5°→2（P3 定稿域）/≥20°→4（白天零差域）/smoothstep 插值（复用 A 预算 5°/20° 同曲线） |
| `clouds.frag` | `#define SHADOW_FALLBACK_STEP_SCALE 2.0` → `uniform float u_shadowFallbackStepScale`（P4 注释合并入 uniform 块）；兜底调用改乘 uniform |
| `CloudsPass.ts` | frame state +`shadowFallbackStepScale?`；march uniformMap +`u_shadowFallbackStepScale: () => state.shadowFallbackStepScale ?? 2` |
| `createCloudsStage.ts` | preRender 每帧算 `sunElevDeg`（复用 `localSunElevationDeg`）→ 写 state；`options.shadowAdaptive===false` 恒回 2（「回到 2026-09-05 静态行为」语义）；`options.shadowFallbackScale` 固定覆盖 |
| `apps/demo/main.ts` | `?cloudsShaftFallbackScale=N` 固定倍率旋钮 |
| 测试 | 曲线端点/单调/低角恒 2（3 条）+集成 3 条（值域/逃生门/fixed 覆盖）+编译断言（uniform 声明/兜底调用/旧 define 清除）——**347 全绿**（341+6）+tsc 两包绿 |

hitClouds 分支（云隙光柱主体）保持原步幅零回归（P3 语义不变）。

## 真机定标（headed Chrome 2000×1163 dpr=1，全钉 `time=2026-09-21T…Z&play=0`，同扫描成对）

| 场景 | elev | 倍率（自适应 vs main） | wt p50 | mn p50 | 省 | 画质（over3/maxD） |
|---|---|---|---|---|---|---|
| 高角 06:00Z | 49° | 4 vs 2 | **20.9ms/47.5FPS** | 28.1ms/35.5FPS | **7.2ms** | 0.016%/182 逐位级 |
| 今早 03:40Z（用户场景） | 11° | ~3.3 vs 2 | 22.4ms/44.6FPS | 24.3ms/40.9FPS | 1.9ms | 0.018% 逐位级 |
| 中带 13:00Z | 16° | ~3.7 vs 2 | 20.8ms/47.5FPS | 22.2ms/44.4FPS | 1.4ms | 0.008% 逐位级 |
| 低角 14:00Z | 3° | 2≡2≡2 | （噪声内） | （噪声内） | — | **三方互差 0.009-0.019% 逐位级** |

- **自适应链路生效证明**：wt≡w4（固定 ×4）逐位 0.011%——同场景强制 ×4 与自适应输出一致。
- **低角零回归**：wt≡fx2≡mn 三方逐位级——FLOOR 域与 main 语义等价（09-05 ×2 定稿的保守域完整保留）。
- 高角收益 7.2ms 与今早 step100→400 差 8ms 互洽（该场景兜底 ~10ms，×4 砍 3/4）。

## 测量坑（新增两条，必守）

1. **不钉 time 的双 tab 像素对照完全无效**：两 tab 加载时刻不同 → 天气演化相位不同 → **云形本身错位**（heat 图满屏云区亮差、地面零差），over3 27.9% 全是假差。任何像素对照必须 `?time=`+`play=0` 成对（重申既有铁律，本次 heat 图证据存档 `p4-day-wt-vs-mn.heat.png`）。
2. **三组连续 A/B 的末位组吃最热状态**：同 URL mn 第二轮 21.5ms → 第三轮（末位）28.1ms，跨轮漂 6.6ms。组序即偏差——性能结论只取**同轮内成对差**，跨轮只看首组锚点。

另：`Transforms.computeIcrfToFixedMatrix` 在 node 不可用（XYS chunk 需 document）——离线算太阳仰角用天文近似公式（EoT 忽略 ±0.5°）判 FULL/FLOOR 域足够，选时刻离域边界 ≥2° 即可（`elev-probe2.mts`）。

## 显示环境注记（2026-09-21）

当日显示环境 60Hz（no-clouds 组 p50 恒 16.7ms 帽，vs 09-05 ProMotion 120Hz）——满帧判据=60FPS；帽内（<16.7ms）差异不可分辨。

## 验收 URL（合并 main 后）

- 高角收益：`?fps=1&camera=56.9420,26.8977,124,79.4,0.5&time=2026-09-21T06:00:00Z&play=0` → ~47FPS（main 35）
- 低角回归：同机位 `&time=2026-09-21T14:00:00Z&play=0` → 与 main 逐位一致
- 旋钮：`?cloudsShaftFallbackScale=`（固定倍率）/ `?cloudsShadowAdaptive=0`（恒 2=P3 静态行为）
