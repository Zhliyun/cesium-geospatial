# 云预算自适应设计——贴地掠射+黄昏性能（A 太阳角影子预算 / B 视线仰角段长收紧）r2

- 日期：2026-09-04（r2：三专家评审修订版；r1 见 git 历史）
- 状态：设计定稿待复审（三专家裁决全部采纳，见 §9 评审记录）
- 动机：docs/superpowers/plans/2026-09-04-surface-grazing-rotate-lag-results.md
- 评审：渲染工程（2C3M4m 全采纳）、性能方法学（2C5M3m 全采纳）、对抗红队
  （七路攻击：三重击穿/击穿/部分击穿×3/未破×1，全采纳堵法）——交叉命中两处
  公式级错误（C1 赤纬误当仰角、C2 曲线方向反），红队实锤 CI 前提性错误

## 0. 用户拍板记录（含 r2 重拍板项）

- 验收标准：Phase 0 基线数据定目标（不拍脑袋）
- 画质红线：默认启用+独立逃生门；零回归硬约束（r2 重述为显式域，见 §3/§4/§7）
- 范围：只做云侧 A+B；大气掠射降载留档候选
- 实现路径：方案 1（运行时 uniform 预算自适应，月光门控连续化推广，开环确定性）
- **r2 重拍板**：「白天零回归」的旧表述作废（红队证明其为不可兑现的模糊承诺），
  改为显式域承诺（§7）——请用户对新城确认。

## 1. 目标与非目标

**目标**（r3 按 Phase 0 数据收窄）：贴地掠射+黄昏场景的**运动帧**云侧成本下降——
仅 A（太阳角影子预算）。验收目标（基线=10:00Z 钉时刻实测）：旋转窗 p95 从
94-125ms → **≤70ms**；旋转窗 >100ms 长帧 → **≤5 帧/40s**（基线 6-12）；静止帧
不设目标（Phase 0 实证：静止成本对太阳角/预算/段长全部不敏感，为大气+云逐像素
固定开销，范围外——A 对静止无收益亦无回退，域外逐位）。

**非目标**：大气 stage 掠射成本（Phase 0 量化占比，若为大头单独立项）；时域/分辨率
降载（用户两轮否决，不重提）；god rays 月光门控现状；qualityPresets 档位结构；
BSM cascade/mapSize 结构参数；夜间 BSM 停画（留档候选）。

**预期上限与止损门**（Phase 0 强制输出）：A+B 理论上限 =（profile 分账的 BSM 生成
ms + 主 march ms）× 最大收缩率。若上限 <10ms（≈1.5FPS），回用户拍板是否转大气
掠射立项——不自动加深收缩率凑数。

## 2. Phase 0 结果（2026-09-04 实测，r3 回填——本节由计划转为结论）

代表机位 `camera=108.2465,34.3312,19,52.0,-2.6`（实际停留于地表 ~490-655m）。
测量：ego-browser 真 Chrome 真 GPU、单 tab gotoAndWait、`?time=`+`?play=0` 钉死、
帧间隔分窗统计（脚本 scripts/perf/measure-rotate.ts 入库）。

**实测结果**（数据文件 scripts/perf/out/t1-*.json）：
1. 三级阶梯 @10:00Z 静止 p50：裸球 8.7ms → +大气 16.6ms（+7.9）→ +云 31.5ms（+14.9）。
   旋转：默认 p50 32.9-34.2ms。
2. 逐 stage 分账：profile=1 有 GPU timer 饱和污染（各 stage ≈帧时间，不可拆分）——
   分解以阶梯差分为准。
3. 仰角-成本扫描（静止 p50）：04:00Z（太阳~68°）33.3 / 09:30Z（~20°）29.1 /
   10:00Z（11.3°）31.5 / 10:30Z（~6°）31.1ms——**静止成本对太阳角不敏感**
   （BSM 静止帧跳过重画=既有机制实证）。
4. 预算响应 @10:00Z 静止 p50：low 32.3 / medium 33.7 / high 31.4ms——**质量预算
   静止无感**（实际采样数=段长/步长，maxIter 只是上限）。
5. **B 有效性探针：零响应 → B 弃案**。marchClouds 段长 ×0.25（清 vite 缓存+服务内容
   核实+截图目验）静止 p50 33.2ms = 基线 31.5-33.8——主 march 采样数不是瓶颈，
   旋转 p50 同样无响应。按本节预置判据「无斜率则 B 弃案」执行。
6. 撞线约束复核：FLOOR=0.5 → maxIter=25×maxStep=1000=25km ≥ 目标域影子段长
   （11.3° 时 ≈8.7km）——A 域内无截断扩大。

**关键洞察（数据改写设计前提）**：
- **静止帧对太阳角/预算/段长全部不敏感**（BSM 跳过重画+非采样瓶颈）≈31.5ms 为
  大气+云的逐像素固定开销——本次范围外（大气不在范围；云侧固定开销非 A/B 类杠杆）。
- **旋转帧对太阳角强敏感**（正午旋转 p95 55ms/0 长帧 vs 黄昏 94-125ms/6-12 长帧）
  =BSM 运动帧重画是太阳敏感分量；low 档（影子预算减半）旋转 p95 47.7ms < high
  94.5ms 方向一致——**A 的收益域=运动帧，前提获数据正面验证**。
- A 的收益上限诚实声明：旋转 p50 中云份额 ~16ms 里的 BSM 生成部分（未单独分账，
  timer 污染）；目标按 §7 保守设定，实现后逃生门成对实测裁决。

## 2. Phase 0：基线复测、成本分账与常数校准（spec 首任务）

代表机位 `camera=108.2465,34.3312,19,52.0,-2.6`（实际停留于地表 ~490-655m，
当地太阳仰角 10:00Z≈11.3°，红队实算）。测量纪律：headed 真机、单 tab gotoAndWait、
`?time=`+`?play=0` 钉死、N≥3 取中位、冷却复测、低帧率域用 p50 帧时间（勿用 FPS
行均值）、环境记录引用 scripts/perf/baseline.md 头部模板。

**数据清单**：
1. 三级阶梯（atmo=0/clouds=0/默认 × 静止/旋转）——归因地形/大气/云。
2. **逐 stage GPU 分账**（`?profile=1`，仅静止测——旋转重载视图会压崩标签页）：
   BSM 生成端 / 主 march / resolve 各占多少——A 只动 BSM、B 只动主 march，
   两者收益上限=各自作用面。
3. **仰角-成本扫描**：4-5 个钉时刻（如 04:00/08:00/09:30/10:00/10:30Z）静止 p50
   ——得「太阳仰角→成本」曲线定 A 曲线形状，并验证最坏窗口位置。
4. **预算收缩响应扫描**（A 的代理）：钉 10:00Z 下 `?cloudsQuality=low/medium/high`
   对照。**B 无现成代理——B_K0 只能实现后二轮校准，本 spec 明说 Phase 0 不定 B_K0**。
5. **B 有效性探针**：临时 hardcode k=0.25 真机测静止 FPS 响应——验证「步数∝段长」
   前提未被既有段长/8 步长 clamp（clouds.frag:534）抵消；无斜率则 B 弃案。
6. **A 撞线仰角计算**：shadow.frag:55 `stepSize=clamp(段长/maxIter,minStep,maxStep=1000)`
   ——maxIter×maxStep 的覆盖半径 vs 目标域影子光线段长上界，推导 FLOOR 下界
   （见 §3 硬约束）。现状 high 档 maxIter=50 时 50km 外已截断——先量化现状截断域。
7. 实算回填：CI 七场景与目标场景的太阳仰角（celestialDirections.ts 同源 node 实算，
   GMST fallback 精度足够；红队手算参考值：95.7°E=28.3°、139.2°E=59.9°、
   108.2°E@10:00Z=11.3°）+ 硬code 进 §6.5 枚举表并注释来源。

## 3. A：太阳角自适应影子预算（BSM 生成端）

**输入量（r2 修正——r1 公式算的是赤纬，三专家交叉击穿）**：
当地太阳仰角 `elev = asin(clamp(dot(normalize(cameraPositionWC), sunDirection), -1, 1))`
——与 clouds.frag:594 `muSunLocal = dot(surfaceNormal, sunDirection)` 同语义；贴地
机位与云域 up 差 <0.1° 可忽略。

**曲线（r2 修正方向）**：
`mult = A_BUDGET_FLOOR + (1 − A_BUDGET_FLOOR) × smoothstep(A_SUN_ELEV_FLOOR, A_SUN_ELEV_FULL, elev)`
——elev≥FULL → mult=1（逐位原值域）；elev≤FLOOR → mult=FLOOR；中间平滑无阶跃。

**作用点**：仅 `shadow.march.maxIterationCount`（high 档 50）。闭包返回值层求值：
`() => Math.max(1, Math.round(params.shadowMarch.maxIterationCount × mult))`
——params 源对象**永不被回写**（防逐帧复利衰减 25→12→6→1 污染档位语义）。
r1 的 minStepSize/mult 杠杆砍掉（high 档 minStep=100 远小于自然基步长，除法无效——
红队攻击 4，YAGNI）。

**覆盖硬约束（红队攻击 4 新增）**：步长 `clamp(段长/maxIter, minStep, maxStep=1000)`
在 maxIter 减半后，若撞 maxStep 上限则覆盖半径减半=**影子尾部漏采错位（banding/
错位，非变淡）**。硬约束：`maxIter(FLOOR) × maxStep ≥ 目标域影子段长上界`，FLOOR
下界由此推导且 **≥0.5 硬性**；不满足则弃案回用户（不自动加深收缩）。Phase 0 任务
6 先算现状撞线域。

**收益场景与 BSM 重画时机**（createCloudsStage.ts:986-988 实证）：
`if (freezeActive || changed || shadowTemporal) render()` ——旋转/云演化帧逐帧重画
（**A 的收益正对旋转卡顿主诉**）；完全静止帧跳过重画（白赚，已有机制）。默认
`shadowTemporal=off`（=M3 无 resolve 无 velocity；demo 仅 `?cloudsShadowTemporal=1`
显式开）——**连续性靠预算连续性本身**（黄昏乘数变化 ~0.2%/min；SUN_QUANT_STEP
量化台阶扰动 <0.1% 不可见），r1 的「resolve 平滑」话术删除（引用了不存在的默认
机制）。仅当用户开 shadowTemporal=1 时，逃生门成对截图须等 resolve 收敛。

**常数（Phase 0 定稿）**：
| 常数 | 起草值 | 语义 |
|---|---|---|
| A_SUN_ELEV_FULL | **20°**（起草，硬上限 30°） | 乘数=1 域下界；红队实算后由目标场景校准（r1 的「CI 最低+5°」规则作废——CI 门禁 clouds=0 不渲染云，前提不成立，见 §7） |
| A_SUN_ELEV_FLOOR | 5° | 乘数=FLOOR 的仰角上界 |
| A_BUDGET_FLOOR | **≥0.5 硬下界**（起草 0.5） | 预算乘数下限；由 §3 覆盖约束推导可更严；不达标回用户重立项 |

**逃生门**：`?cloudsShadowAdaptive=0` → 乘数恒 1（uniform 同值逐位回退）。

## 4. B：视线仰角自适应段长（主 march）——**r3 弃案**

> **Phase 0 探针否决（2026-09-04）**：marchClouds 段长 ×0.25（清缓存+服务内容核实+
> 目检）静止 p50 33.2ms = 基线 31.5-33.8，旋转 p50 同样无响应——「步数∝段长→段长
> 收紧省成本」前提被证伪，主 march 采样数不是该视角瓶颈。按 §2 预置判据「无斜率则
> B 弃案」执行。以下原设计文本保留作历史记录（若未来视角类变化可复活，须重探针）。

**物理依据（r2 修正）**：贴地掠射光线斜穿云层路径长（步数∝段长，前提待 Phase 0
探针验证）。r1 的「高空渐隐遮蔽」论据**删除**（该 fade 是相机高度门控，对 19m 贴地
相机完全无效——红队攻击 6）；贴地域的真实遮蔽=大气雾霾一项，且黄昏地平线云带
（云高 2km@50km≈2.3° 仰角）**整带落在收紧域内=最显眼内容**——K0/elev 常数校准
必须含黄昏地平线云带目验，不做「不可见」的无据假设。

**实现**（GLSL 公式两行，参数全由 JS uniform 注入）：
1. JS 侧计算并注入：门控（**r2 连续化——红队攻击 2**）
   `u_grazingGate = 1 − smoothstep(1500, 2500, cameraHeight)`（相机穿越门限平滑
   过渡，无阶跃跳变）；曲线常数 u_grazingK0 / u_grazingElevLo / u_grazingElevHi
   （**注意 elev 用 sin 值域注入或 GLSL 内 sin()，二选一写死**——防 TS 镜像 fixture
   在此漂移）。
2. GLSL 侧：**在 marchClouds 内局部段长变量定义处直接替换**（r2 修明确落点——该
   局部变量被下游三处消费：段长/8 步长 clamp、startJitter 守卫（53e8bc6 盐粒黑块
   修复：段长<8×stepSize 时关 jitter）、march 终止；只喂终止条件会导致 jitter 守卫
   用旧段长误判→黑块复发风险）：
   ```
   // maxRayDistance = rayNearFar.y - rayNearFar.x（局部段长，非 uniform maxRayDistance）
   float k = mix(u_grazingK0, 1.0, smoothstep(u_grazingElevLo, u_grazingElevHi, abs(sinElev)));
   maxRayDistance = min(maxRayDistance * mix(1.0, k, u_grazingGate), maxRayDistance);
   ```
   sinElev = dot(rayDir, normalize(cameraPosition))（相机位置逐像素共用，march 前算
   一次；密切球局部系与测地法线差 ≤0.19° 由校准吸收）。**取 abs**：俯视掠射（相机
   在云上）与仰视掠射同样产生长穿越路径，双向对称收紧；云下相机俯视线无云段可
   march（近端空段），收紧为无成本 no-op。|sinElev| ≥ elevHi 或门≈0：逐位原值
   （gate=0 时 mix=1.0 精确、min(x,x)=x，IEEE 逐位）。
3. 与 getRayNearFar 既有截断（nearFar.y=min(nearFar.y, maxRayDistance)）共存：先 min
   后乘，单调收缩无冲突（渲染专家已核）。

**零回归域**：cameraHeight ≥ 2500m（平滑门上界）逐位原值；同帧内 |sinElev| ≥ elevHi
像素逐位不变。CI 七场景因 query 含 `clouds=0` 云 stage 不实例化——对本改动天然
免疫（nadir 2000m 虽落在门平滑过渡区 gate≈0.5 亦无云可渲染）；CI 门禁继续作为
大气 stage 回归门（§7）。

**逃生门**：`?cloudsGrazingClamp=0` → u_grazingGate 恒 0（IEEE 逐位回退；自动化无处
落地云侧 diff——真机双 URL 截图 pixel-diff=0 为准，见 §6.6）。

## 5. 与既有机制的关系

- **月光门控（7d525fc）**：god rays `if (nightFactor × moonFactor > 0)` 整段跳过——
  本设计同族推广（0/1 门 → smoothstep 连续预算）。
- **段长/8 clamp（53e8bc6/0cbcfe2）**：§4 落点替换局部段长后，步长 clamp 与 jitter
  守卫自动一致（渲染专家 M3 修法）；L528 起始步长只依赖 rayNearFar.x 不受影响。
- **qualityPresets**：档位值=预算上限单一来源，A/B 只做域内收缩不放大；low 档叠加
  语义=更省，无特判。
- **M4 主 march temporal**：与 A/B 无耦合（A 动 BSM 端、B 动段长）；静止冻结
  （positionWC 位移<0.01m 冻 frame/jitter 相位）在 play=0 下逐帧同值；**play=1 下
  预算随太阳/云场连续缓变，非跳变**（r2 措辞修正）。
- **haze/god rays 侧效应**：god rays 段长随 frontDepth 顺带缩短（收益方向）；haze
  解析雾仍按原段长积分（无 crash）——归真机验收项。

## 6. 测试与验收

6.1 A 曲线纯函数表驱动单测（期望值按文字语义写：高仰角=1、低仰角=FLOOR——
r1 公式方向错误正是此类测试能抓的形态）。
6.2 B 参数计算单测（高度门平滑域两端+2000/2500 边界、sin 换算一致性）。
6.3 createCloudsStage 级：注入高/低太阳 sunDirection 断言 shadow march uniform
原值/缩放；**断言 params 源对象不被回写**；注入相机高度断言 grazing 门控。
6.4 GLSL：glslang 编译测试 + TS 镜像数值 fixture（常数同源注释防漂移）。
6.5 **真实消费域枚举**（r2 改——原 CI 枚举是空保护）：真机验收场景 + 云专项工具
（verify-clouds-distribution.mjs）的场景/钉时刻，实算太阳仰角 hardcode+单测断言
与 celestialDirections 实算一致。
6.6 真机验收（用户）：①108 机位钉 10:00Z 逃生门成对（帧率/突刺/画质三对——
若开 shadowTemporal=1 须等 resolve 收敛再截）；②黄昏地平线云带目验（B 校准必过
项）；③日本 500m 云海机位回归；④傍晚实时时钟复测原场景。突刺协议钉死：测量
脚本入库（measure-v3 模式）、40s 窗口、N≥3 中位、CDP 拖拽参数写死、>1s 瓦片突发
帧单列不混入、**目标按重测基线等比收缩（≤基线×0.5 且 ≤10 帧；「83→5」旧口径随
高度分支合并作废）**。

## 7. 零回归承诺（r2 显式域重述，用户已拍板「可以」；r3 收窄为 A-only）

- CI 视觉门禁（SSIM/maxΔ 七场景）：query 含 `clouds=0`，云 stage 不实例化——对本
  改动天然免疫；继续作为**大气 stage 回归门**保留，但不构成云侧验收（spec 明示，
  防验收误判）。
- **A 域承诺**：太阳当地仰角 ≥ A_SUN_ELEV_FULL（定稿 20°，硬上限 30°）→ BSM 预算
  逐位原值。即约 9:00-16:00（冬短夏长）零回归；**清晨/傍晚低于 FULL 的时段影子
  预算平滑收缩至 ≥FLOOR≥0.5**——设计意图本身，不称「白天零回归」。
- ~~B 域承诺~~ **r3 弃案**（§4 探针否决），无 B 侧域承诺与逃生门
  （?cloudsGrazingClamp=0 不再接线）。
- 域外激活必须可一键回退（A 逃生门）且回退逐位（uniform 同值论证+真机双 URL
  截图 diff=0）。
- **r3 验收目标（Phase 0 实测基线上设定）**：10:00Z 钉时刻旋转窗 p95 ≤70ms
  （基线 94-125ms）、旋转窗 >100ms 长帧 ≤5 帧/40s（基线 6-12）；静止帧无目标
  （对 A 不敏感，域外逐位）。

## 8. 风险与硬规则

| 风险 | 缓解 |
|---|---|
| 影子 banding/错位（非变淡——maxStep 撞线截断域扩大） | §3 覆盖硬约束推导 FLOOR 下界；Phase 0 撞线仰角计算；撞线即弃案不硬上 |
| 掠射远云/地平线云带变薄显形 | 高度门限制贴地域；**黄昏地平线云带目验为校准必过项**（红队攻击 6：该云带整带在收紧域） |
| B 前提不成立（步长 clamp 抵消） | Phase 0 探针先验证斜率，无斜率 B 弃案 |
| 大气 stage 天花板 | Phase 0 分账+理论上限公式（§1）；<10ms 止损回用户 |
| 常数漂移成「降档换皮」 | FLOOR≥0.5 硬下界、FULL≤30° 硬上界、不达标回用户重立项**不自动加深**（红队攻击 7；伪影形态点名：步长加倍产生 banding「带」，用户此前只否决过「糊」——拍板物料=黄昏对照截图） |

## 9. 评审记录（2026-09-04，三专家并行，裁决=全采纳）

- 渲染工程：C1 赤纬公式/C2 曲线方向（CRITICAL）+M3 落点/M4 闭包层级/M5 收敛+4minor——
  全采纳；M5 因 BSM temporal 默认关（红队攻击 3 证实）改写为条件性备注。
- 性能方法学：C1/C2 交叉确认+M1 CI 空转/M2 Phase 0 三组数据/M3 突刺协议/M4 止损门/
  M5 B 前提——全采纳（M3 脚本入库与基线重定进 §6.6）。
- 对抗红队：攻击 1 三重击穿（实算 CI 28.3°/59.9°、用户 11.3°；CI clouds=0 前提性错误；
  FULL=33.3° 时黄昏收益仅 6.3%）/攻击 2 高度门阶跃/攻击 4 maxStep 撞线/攻击 6 fade
  论据失效+地平线云带=击穿；攻击 3 BSM temporal 默认关/攻击 5 接线缺口/攻击 7 边界
  防守=部分击穿；攻击 1e nadir 2000m 边界=未破。全采纳堵法；**FULL 释放至场景校准
  （黄昏收益从 6.3% 回到 20-38% 空间）**。

相关：[[clouds-inlayer-march-perf]]、[[clouds-space-view-stepsize]]、
[[clouds-linear-overlay]]（时域降载否决史）、
docs/superpowers/plans/2026-09-04-surface-grazing-rotate-lag-results.md。
