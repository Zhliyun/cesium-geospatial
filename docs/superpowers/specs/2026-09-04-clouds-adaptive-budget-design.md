# 云预算自适应设计——贴地掠射+黄昏性能（A 太阳角影子预算 / B 视线仰角段长收紧）

- 日期：2026-09-04
- 状态：设计定稿（用户逐节确认），待 Phase 0 基线数据校准常数
- 动机：docs/superpowers/plans/2026-09-04-surface-grazing-rotate-lag-results.md
  （贴地掠射+黄昏=管线最重视角类：纯球 60 → +大气 15.5 → +云 9-10 FPS；
  黄昏实时时钟坏窗口 3× 波动；旋转 TAA rejection 突刺 p95 136ms/83 长帧）
- 用户拍板记录：验收标准=Phase 0 基线数据定目标；画质红线=默认启用+独立逃生门
  +白天/高太阳角逐位零回归硬约束；范围=只做云侧（大气掠射降载留档候选）；
  实现路径=方案 1（运行时 uniform 预算自适应，月光门控的连续化推广）

## 1. 目标与非目标

**目标**：贴地掠射+黄昏场景下，云侧渲染成本显著下降（帧率目标由 Phase 0 基线数据
定稿写回本节），旋转突刺（>100ms 长帧数）对齐高度分支 A/B 口径显著下降
（83→5 长帧为参考量级），画质损失经用户真机目验可接受。

**非目标**（明确不碰）：
- 大气 stage 掠射成本（Phase 0 量化占比，若为大头单独立项）
- 时域/分辨率降载（用户两轮否决方向，本设计不重提；方案 3 反馈闭环同族亦否）
- god rays 月光门控现状、qualityPresets 档位结构、BSM cascade/mapSize 结构参数
- 夜间 BSM 是否可停画（观察到的潜在浪费，留档候选不立项）

## 2. Phase 0：基线复测与常数校准（spec 首任务）

1. 目标机位 `camera=108.2465,34.3312,19,52.0,-2.6` 钉 `?time=2026-09-04T10:00:00Z&play=0`
   （复现坏窗口太阳角），合并后 main 上重测三级阶梯（`atmo=0`/`clouds=0`/默认 ×
   静止/旋转）——注意旧阶梯测于合并前高度，须重测。
2. 据分解定帧率目标（写回 §1），并定 A/B 曲线常数（下表起草值 → 校准值）。
3. 测量纪律：headed 真机、CDP 旋转、rAF 分窗统计、同批成对、单 tab
   （ego-browser 纪律）、`?time=`+`?play=0` 钉死。

**起草常数表**（全部 Phase 0/真机校准后定稿）：

| 常数 | 起草值 | 语义 |
|---|---|---|
| A_SUN_ELEV_FULL | 30°（起草） | 乘数=1 的太阳仰角下界；**定稿=max(30°, CI 最低场景仰角+5°)**（§3 零回归域） |
| A_SUN_ELEV_FLOOR | 5° | 乘数=下限的太阳仰角上界 |
| A_BUDGET_FLOOR | 0.5 | 影子预算乘数下限 |
| B_HEIGHT_GATE | 2000m | 相机高度激活门（严格小于才启用） |
| B_ELEV_FULL | 10° | 段长不收紧的视线仰角下界 |
| B_K0 | 0.5 | 水平掠射段长乘数 |

## 3. A：太阳角自适应影子预算（BSM 生成端）

**物理依据**：BSM（shadow.frag）从太阳方向 march 云层算影。太阳仰角越低光线掠射
路径越长越贵，而低太阳角影子又长又软——细节最不值钱时恰好最贵。

**实现**（全 JS 侧，零 shader 编译分支）：
1. `createCloudsStage` 每帧由 `state.sunDirection` 算太阳仰角
   `elev = asin(dot(normalize(sunDirection), 地轴单位向量))`（ECEF z 轴）。
2. 连续曲线：`mult = 1 + (A_BUDGET_FLOOR − 1) × smoothstep(A_SUN_ELEV_FLOOR, A_SUN_ELEV_FULL, elev)`
   ——高太阳角乘数=1（原值）；随仰角降低平滑下降；无阶跃（日出日落不闪变）。
3. 乘数改写 BSM 生成端 march uniforms：`shadow.march.maxIterationCount × mult`
   （取整）、`shadow.march.minStepSize / mult`（步长加大步数减少；不超过 maxStepSize
   约束，实现处 clamp）。uniformMap 闭包每帧求值，无重建、无重编译。
4. BSM 内容随预算逐帧变化无额外失效：BSM 本就逐帧 preRender 重画（temporal resolve
   消费），预算是太阳仰角的连续函数，与 temporal/velocity 兼容（同 M4 冻结论证）。

**零回归域**：`elev ≥ A_SUN_ELEV_FULL` 时输出与现状逐位相同。⚠️ CI 七场景的太阳
仰角须 Phase 0 实算回填（pin `01:00Z` 下 139°E 场景≈40°+，但 95.7°E 场景为当地
清晨约 20-25°，**初判会落进过渡域**）——定稿规则：`A_SUN_ELEV_FULL = max(30°,
CI 最低场景仰角 + 5° 余量)`，保证 CI 全域乘数恒 1；§6.5 单测以实算值枚举守卫。
若该定稿值压缩了 A 的黄昏收益空间，按零回归优先原则接受（不做 CI ref 重录换域）。

**逃生门**：`?cloudsShadowAdaptive=0`（URL）→ 乘数恒 1。

## 4. B：视线仰角自适应段长（主 march）

**物理依据**：贴地掠射时主 march 光线斜穿云层路径长（步数∝段长），而近地平线的
远云已被大气雾霾+高空渐隐（50-300km fade）双重遮蔽——收紧段长的画质代价在该域
不可见；高空掠射（bug6 类）大气薄、远云清晰，不可收。

**实现**（GLSL 两行公式，参数全由 JS uniform 注入）：
1. JS 侧按相机高度产出门控 uniform：`u_grazingGate = cameraHeight < B_HEIGHT_GATE ? 1 : 0`
   （严格小于——CI nadir 场景恰 2000m 不触发），以及曲线常数 uniforms
   （K0/elevLo/elevHi，Phase 0 校准值）。
2. GLSL 侧主 march 段长收紧（getRayNearFar 之后、与既有段长/8 clamp 叠乘）：
   ```
   float sinElev = dot(rayDir, normalize(position));        // 逐像素视线仰角 sin
   float k = mix(K0, 1.0, smoothstep(elevLo, elevHi, sinElev));
   maxRayDistanceEff = min(maxRayDistance * mix(1.0, k, u_grazingGate), maxRayDistance);
   ```
   仰角 ≥ elevHi 或高度门关：逐位原值。
3. 逐像素性保留：同屏下半（打地/掠射）收紧、上半（仰视）不动。

**零回归域**：`cameraHeight ≥ B_HEIGHT_GATE` 的全部场景逐位同现状（CI 七场景
最低 2000m 恰在门外、视觉门禁四场景 ≥5000m）；同帧内仰角 ≥ elevHi 像素逐位不变。

**逃生门**：`?cloudsGrazingClamp=0`（URL）→ u_grazingGate 恒 0。

## 5. 与既有机制的关系

- **月光门控（7d525fc）**：god rays 用 `if (nightFactor × moonFactor > 0)` 整段跳过
  ——本设计同族推广（0/1 门 → smoothstep 连续预算），代码评审对照该先例。
- **段长/8 clamp（53e8bc6/0cbcfe2）**：既有 `stepSize = min(stepSize, max(段长×0.125,
  minStepSize))` 不动，B 的 `maxRayDistanceEff` 在其上游收窄段长，两者叠乘。
- **qualityPresets**：档位值仍是预算上限的单一来源（A/B 只在档位值域内做乘法收缩，
  不放大）；low 档用户与自适应叠加语义=更省，无需特判。
- **M4 静止冻结**：预算是相机/太阳的确定连续函数——静止时逐帧同值，冻结行为不变。

## 6. 测试策略（TDD）

1. A 曲线纯函数表驱动单测（仰角→乘数：域内三点+两边界+域外）。
2. B 参数计算单测（相机高度→门控值：2000 边界严格性、500m/11.6km 两端）。
3. createCloudsStage 级：注入高/低太阳 sunDirection，断言 shadow march uniforms
   原值/缩放；注入不同相机高度，断言 grazing 门控 uniform。
4. GLSL：glslang 编译测试（compile.test 惯例）+ 公式数值 fixture（TS 镜像同常数，
   注释声明镜像关系防漂移）。
5. CI 兼容单测：枚举 CI 七场景（太阳仰角、相机高度），断言全部落在 A/B 零回归域。
6. 真机验收（用户）：108 机位钉 10:00Z 逃生门成对（帧率/突刺/影子与远云画质目验
   三对）+ 日本 500m 云海机位回归目验 + 傍晚实时时钟复测用户原场景。

## 7. 验收标准（Phase 0 定稿后回填）

- [ ] 帧率目标：Phase 0 定稿（写在此处）
- [ ] 旋转突刺：>100ms 长帧数较合并后基线显著下降（参考量级 83→5）
- [ ] 画质：用户真机目验通过（逃生门成对对比）
- [ ] 零回归：CI 七场景门禁逐位 PASS（现有 --check 流程）+ 零回归域单测全绿
- [ ] 670+ 全量测试绿 + 两包 tsc clean

## 8. 风险与边界

| 风险 | 缓解 |
|---|---|
| 低太阳角影子变淡/细节损失 | 常数校准+逃生门；影子时域 resolve 平滑 |
| 掠射远云变薄显形 | 高度门 2000m 限定贴地域；远云本被雾霾遮蔽 |
| 大气 stage 天花板（非本设计范围） | Phase 0 量化占比给预期；若为大头单独立项 |
| 曲线常数拍脑袋 | 全部标注起草值，Phase 0 数据+真机校准定稿 |

相关：[[clouds-inlayer-march-perf]]（性能战役史与测量坑）、
[[clouds-space-view-stepsize]]（段长 clamp 先例）、
[[clouds-linear-overlay]]（时域降载否决史）、
docs/superpowers/plans/2026-09-04-surface-grazing-rotate-lag-results.md（动机数据）。
