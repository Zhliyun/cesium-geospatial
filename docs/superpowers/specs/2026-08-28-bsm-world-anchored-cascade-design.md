# BSM 世界锚定 Cascade 设计（v3，复审修订版）

- 日期：2026-08-28（v1 三专家评审 + 校准/门禁实验 → v2 → 三专家复审 + 独立盲审裁决）
- 状态：**复审修订版——待用户终审**
- 分支：`bsm-world-anchored`
- 复审记录：集成专家【通过】/ 对抗性【有条件通过 2 重伤】/ 独立盲审【有条件通过 4 major】——分歧经独立复算裁决（§9）

## 1. 背景与问题（含新实验数据）

体积云 BSM 相机移动时云影与天空（经 shadowLength bridge）闪动。量化基础（录屏帧间差分，指标=跳变像素占比 pct>20/255）：

### 1.1 噪声分解（2026-08-28 门禁实验，v2 新增）

| 探针（同速 AB 对照） | BSM 关基线 | BSM 开 | **BSM 增量** |
|---|---|---|---|
| 慢速轨道旋转（rotateLeft，上轮同款） | 0.06% | 1.61%（开 EMA） | **1.55%** |
| 直线平移 3m/帧（180m/s） | 1.16% | 1.33% | 0.17% |
| 直线平移 12m/帧（720m/s） | 0.99% | 1.68%（关 EMA） | 0.69% |

**结论：矩阵噪声主场是轨道/旋转（位姿耦合变化），不是平移。** 校准实验证明 radius 在纯平移+纯旋转下均恒定（getFrustumRadius 用角点欧氏距离，旋转不变量）——轨道下真正呼吸的是 **center**：视锥角点在 light space 的轴对齐包围盒（AABB）随朝向变形，center 慢轨道下估算 ~30-90m/帧连续变 → texel snap 后密集跳变（c0/c1 每帧 1-3 texel）。

**EMA 抵抗通道（v3 复审修正，盲审实证）**：真正的闪动机理链是——矩阵每帧平移/跳变 → resolve 的 reprojection 对同一世界点产生亚 texel 错位 → variance clipping 拒收错位 history → 退回当帧噪声 current（EMA 失效）+ 级联边界 fade dither 以平移速度 10-25 倍扫过云场。**STBN jitter 不是 snap 的边际伤害**（第三维 frame%64 且 shadowTemporal 时每帧递增——jitter 本来就每帧全量重随机化，是背景噪声地板）；实证排序「旋转+EMA(1.55%) > 平移+关 EMA(0.69%)」只有「错位拒收」解释得通，单纯 jitter 换值解释不了。世界锚定同时消灭矩阵平移与边界扫掠两个主通道——**方案对机理细节的不确定性鲁棒**（上述所有候选通道都依赖矩阵随相机变化）。

**风险余量警示（v3 新增，盲审）**：慢速平移增量 0.17%（EMA 开、jitter 每帧变）≈ **非矩阵噪声地板**——0.3% 目标只剩 **0.13% 余量**；轨道边界 dither 扫掠更快、地板可能更高。这是本设计结构性修不掉的部分（除非 STBN 世界域索引/边界处理另立项）。轨道验收可能落在 0.2-0.4% 区间——届时用 E1' 实验（§6）归因后决定豁免或立项。

**教训（门禁实验 E1 作废）**：冻结矩阵实验被覆盖损失污染（冻结 2.28% > 不冻结 1.68%——相机飞出 BSM 盒后 uv 越界硬边界扫过云面）——反向印证覆盖配套（§3.1.1）与覆盖边界的必要性。

### 1.2 域链路（评审确认自洽）

- 矩阵域 = 真 ECEF（update 用 camera.inverseViewMatrix）；march 域 = E+altitudeCorrection（密切球中心系）；生成端 +A / 消费端 −A 闭环。
- altitudeCorrection 漂移传导率实测 ~4e-5（平移 1200m → |ΔA|=0.1m）——无害，排除嫌疑。
- ortho 盒 z 与 xy/uv/march 全解耦（getShadowUv 只取 clip.xy；z=-1 反投影仅定光线起点，球交重定 march 域）。

## 2. 目标与验收

- **验收标准（用户拍板）：肉眼不可见**——同速探针 AB 对照下 **BSM 增量 <0.3%**（轨道场景现 1.55%）。
- 静止时保持完全干净且白赚跳过生成 pass。
- march 成本不增（每帧全量重 march 与现在相同）。
- `?cloudsShadowAnchor=frustum` 回退现实现 AB 对照。

## 3. 方案：固定半径世界锚定 cascade

### 3.1 矩阵生成端（`CascadedShadowMaps.update()` 重写）

1. **radius 固定 + interval 解析配套（v3 系数 1.6，复审裁决 §9-A）**：interval 先定 `{0, 10, 21, 60}km`，radius_i = **1.6 × d_i** = {16, 33.6, 96}km，texel {62.5, 131, 375}m。系数依据：盘心=相机时，段远端对角点**距相机欧氏距** = √(1+tan²(θ_diag/2))·d = **1.545·d**（fovy 60°/16:9，tan(θ_diag/2)=1.178），且视线⊥太阳（日落侧平视——低太阳角云影最重要的常见取向）时轴向分量**全额**落入 light-xy——1.6 覆盖最坏取向 + PCF 裕量 (1.6−1.545)·d ≈ 11 texel + fade 带外溢 0.029·d。texel 代价：c0 62.5m vs 现 46.8m（+33%，低太阳角近景验收点 §6）。广角阈值：1.6 覆盖至 fovy ≈ **65°**（tan(θ_diag/2) ≤ √(1.6²−1)），超出为覆盖降级场景（远层外缘 uv 越界走光深 0 fallback，与 shadowFar 外语义一致）。v2 的 1.25 系数把「距光轴横向半宽」误当「距盘心距离」（漏轴向分量最坏取向全额投影）——两位评审一位犯同错一位识破，独立复算裁决 1.545 为正确下界（§9-A）。
2. **center 从视锥 bbox 心改为相机位置固定网格 snap**（主修复，瞄准旋转主场）：`center.xy = round(P_cam_light.xy / texel) * texel`，网格锚定 light space 原点（地心），texel 恒定 → 网格恒定。**原地纯旋转下 center 完全不动 → 矩阵 bit 级不变**；平移下整数 texel 跳（100m/s 时 c0 每 ~28 帧一跳，720m/s 时 ~4 帧——v3 勘误，v2 的「每 4 帧」是 720m/s 的数）；**轨道（位姿耦合）下位置分量仍激发 snap 跳变——轨道验收预期 ≠ 基线 0.06%**，含 snap 频次残余（复审 G/盲审 6 预期管理）。
3. **z 域局部相对式 near 面（v3 重写，复审裁决 §9-B）**：v2 公式 `dot(P_surface,sunDir) + √(R_top²−radius²)` 是量纲级错误——第二项 ≈ 地心距 6375km，把近平面抬一个地球半径。精确基下无害（射线重合、clip.z 无消费），但**量化基（偏 0.05°）× march 精确方向非共模**：同一 uv 柱内生成端反投影点与消费端世界点的横向分离 = Δz·sin(step)，Δz=6371km 时分离 5.6km = 93+ texel（影云错位）。v3 公式（光心域 light 坐标，直接取**盘内壳顶最大 z**）：
   ```
   ρ = |相机 light-xy 投影|；ρ_min = max(0, ρ − radius_i)
   zNear_geocentric = √(max(0, R_top² − ρ_min²)) + margin   // 盘内壳顶之上；margin ≤ 30km
                                                              // （max(0,·)：ρ_min≥R_top 时盘柱与壳顶球
                                                              //  不相交、盒内无云、zNear=margin 良定义）
   orthoNear = dot(centerWorld, sunDir) − zNear_geocentric   // 域换算（光心域→light 相机相对域；符号：
                                                              //  near 面须落在壳顶太阳侧外——v3 原式差一
                                                              //  符号，实现期 T2 用例拦截后修正）
   ```
   margin 约束：**Δz·sin(0.05°) < 1 texel ⟺ margin ≤ texel/sin(step) ≈ 72km@c0（v3 texel 62.5m）**（取 ≤30km 留裕量，分离 ≤26m ≈ 0.4 texel）；margin 同时 ≥ 球冠高差（r²/2R ≈ 0.72km@96km）+ 壳厚 2.2km——30km ≫ 两者 ✓。far 随意给足（clip.z 全管线无消费，盲审逐文件核实：shadow.frag 只取 clip.xy、getShadowUv 只取 clip.xy、shadowResolve 不读 z）。z 同 snap 到粗网格（如 1km，纯为跳过判据稳定）。**顺带修复现存 bug（v3 加严重度，盲审 4）**：现 distance=lerp(1e6,1e3,zenith) 在 zenith→1 时反投影起点入壳——`rayNear>rayFar → maxRayDistance<0 → march 循环立即 break → 该 texel 光深**全量归零**`（非「少算上半段」，是全有全无；正午低相机 ≲1.2km 即触发）。固定 z 盒后此路径消失，**回归用例断言「正午低相机下 BSM 光深 >0」**（world 分支修复；frustum 分支保留 bug 作 AB 基线，复审 N2）。
4. **interval 常数区间**（评审 M1/重伤-3）：world 分支**不复用 splitFrustum**（near=0 → logarithmic 分支 0·∞=NaN 传染 practical）。直接常数区间 `{0, 10, 21, 60}km/60km` 与 radii 配套。单测断言无 NaN 且单调覆盖 [0,1]。**interval-radius 联动约束（复审 F）**：interval 交界微调（§5 无云视距段统计）必须联动重算 radii（texel 密度随 radii 变 → snap 网格变），实现时写死联动。
5. **shadowFar 固定（仅 world 分支；frustum 分支 bit 级保留现状，复审 N1）**：`min(maxRayDistance, SHADOW_FAR_LIMIT)` 常数，去掉 `camera.frustum.far` 参与（multi-frustum 缩放时 far 不再变）；`u_shadowCameraNear` 固定注入 0（注入点已存在 CloudsPass.ts:460，**注意 uniform 名是 u_shadowCameraNear 非 cameraNear**——后者是 czm_currentFrustum.x 动不得）。**AB 基线完整性**：`?cloudsShadowAnchor=frustum` 须为完整现实现（含 distance 入壳 bug、视锥 far 参与等已知缺陷），否则 AB 增量失锚（§1.1 数据不可比）；AB 截图差异中此类项读作「world 修复了 frustum 的 bug」非「world 回归」。
6. **机理（v3 重述，盲审 1——修正 v2 与 v1 对抗审查的共同错误）**：「整数平移保相位」为真，但 **STBN jitter 不是 snap 的边际伤害**——getSTBN 第三维 frame%64 且 shadowTemporal 时 frame 每帧递增，jitter 本来就每帧全量重随机化（背景噪声地板）。真正的 EMA 抵抗主通道：**矩阵每帧平移/跳变 → resolve reprojection 亚 texel 错位 → variance clipping 拒收 history → 退回当帧噪声 current**（EMA 收敛锁失效）+ 级联边界 fade dither 以平移速度 10-25 倍扫过云场。实证排序「旋转+EMA(1.55%) > 平移+关 EMA(0.69%)」只有错位拒收解释得通。世界锚定的收益 = 矩阵平移频率从每帧降到 snap 频率 → 错位拒收通道消失（矩阵不动帧 velocity=0 精确重投影；整数平移帧 prevUv 恰落旧 texel 中心、双线性无损）+ 边界扫掠降速。**方案对机理不确定性鲁棒**（所有候选通道都依赖矩阵随相机变化）。
7. **f32 相位现实性**（评审 M4/轻伤-1 降级；v3 texel 更新）：float64 严格成立；GPU float32 下矩阵平移分量与世界坐标 6.4e6 量级大数相消 → clip 误差 ~1-2m → **UV 相位噪声 0.01~0.06 texel**（texel 62.5m@c0，盲审复算落此区间）。「亚 0.1 texel 相位稳定」声称成立。**兜底预案**（若平移探针不达标）：texel 跳 n 时 clip 域左乘精确平移 T(n/512)（二进制精确、零舍入——对抗复审核实），仅太阳跨步/参数变时全量重建。
8. **太阳方向量化（作用域收窄，评审 M5；v3 补非共模约束）**：量化只作用于**矩阵构造输入**（light 基/snap/跳过判据），march 与消费端保持精确 sunDirection（生成端 getRayNearFar 与消费端 getDistanceToShadowTop 同用精确值，无系统差）。**但矩阵基（量化）与 march 方向（精确）非共模**——横向分离 = Δz·sin(step)，由 §3.1.3 的 margin ≤30km 约束压到 <0.5 texel（v2 版 zNear 无此约束即 §9-B 重伤）。实现：**量化向量**——ECEF 单位球网格量化（步长 0.05°≈8.7e-4 rad；跨 ICRF/GMST-fallback 分支一致）。demo 时钟静止零触发；跑钟跨步频率 ≈ 每 12s。跨步残差（盲审核算）：snap 重锚后盘内 ≤ δ·|p−p_cam| ≈ 13-26m ≈ 0.2-0.4 texel（比 v2 保守值更优）。跑钟场景专项验证（录屏跨步后 5s+）。
9. **单源构造矩阵**（评审 render-9）：废弃 lookAtMatrix 二次求基——inverseViewMatrix = lightOrientation 旋转 + translation=centerWorld 直接构造（防 69ee488 类双源漂移）。**域换算**（盲审 3，并入 §3.1.3 公式）：zNear_geocentric（光心域）→ orthoNear（light 相机相对域）显式换算，防域混用。

### 3.2 消费端与编排

- `cascadedShadowMaps.glsl` / `clouds.frag` / `shadow.frag` / `ShadowPass` **shader 文本零改动**（核验成立；唯一改动是 JS 注入值：u_shadowCameraNear=0、shadowFar 常数、intervals 常数区间）。锚点测试防回归（含 getViewZ 共用面）。
- 编排（createCloudsStage）：新开关 `shadowAnchor: 'world' | 'frustum'`，**默认 world**；`?cloudsShadowAnchor=frustum` 回退。**distance 常数化**（现 lerp(1e6,1e3,zenith) 无消费语义已论证——正交 xy 与 z 解耦+球交自愈+消费只取 clip.xy——消掉跳过判据的变源）。
- **静止跳过**：判据 = 语义键 {各层 snap 后 texelIndexXY、z snap 值、太阳量化 bucket、altitudeCorrection 粗 bucket（如 10km 档——漂移传导 4e-5 视觉可忽略但语义在变，盲审 7）}（不做矩阵逐元素比较——评审 M2）；相同则跳过整个 `ShadowPass.render()`。**不变量**（评审 m7）：跳过时 prev/current matrices 与 history 三者冻结，恢复时 reprojection 语义自洽（prevMatrices=上次实际 render 的矩阵，history 恰为该时代）。跳帧时 params.frame 仍递增（stbn 相位跳号，任意相位低偏差无害）。
- ICRF XYS 懒加载完成瞬间 sunDirection 跳变（一次性重 march，可接受，已知项）。

### 3.3 明确不做（YAGNI）

- tile cache / LRU 换页 / 增量 march：每帧全量重 march 成本与现在相同，静止已跳过；profile 证明移动时成本瓶颈再立项。
- 三件套参数调整（实验已证无益）。

## 4. 改动面盘点

| 文件 | 改动 |
|---|---|
| `packages/cesium-clouds/src/CascadedShadowMaps.ts` | update() 重写（world 分支：固定 radii/相机 snap/解析 zNear/常数 interval/单源矩阵；frustum 旧路径保留） |
| `packages/cesium-clouds/src/createCloudsStage.ts` | shadowAnchor 开关、distance 常数化、far 固定、静止跳过（语义键）、太阳量化（矩阵输入）、u_shadowCameraNear=0 |
| `packages/cesium-clouds/src/CascadedShadowMaps.test.ts` | 时序稳定性用例组（f32 仿真）+ interval NaN 防护 + zNear 解析回归 + 旧用例迁 frustum 分支 |
| `packages/cesium-core/src/cascadedShadowMaps.glsl.test.ts` | 注入值锚点（u_shadowCameraNear=0、shadowFar 恒定） |
| `apps/demo/src/main.ts` | `?cloudsShadowAnchor=frustum` 解析 + console 提示更新 |

## 5. 设计值（校准+解析，v3 修订）

- 现分布实测（far=6e4，fovy 60°/16:9）：radius {11.99, 24.83, 78.16}km、texel {46.8, 97.0, 305.3}m、interval {0-10, 10-20.4, 20.4-60}km——**注意这些是「视锥截面心盒」语义，与「相机心盘」所需半径不可直接比较**（§9-A 假吻合教训）。
- **v3 解析配套**：interval `{0, 10, 21, 60}km` → radius = 1.6×d = **{16, 33.6, 96}km**，texel {62.5, 131, 375}m（c0 比现 +33%，覆盖最坏取向的必要代价）。
- 广角阈值 **65°**（1.6 系数，tan(θ_diag/2)≤√(1.6²−1)=1.249）；90° 广角所需 ≈ 2.27×d——fov>65° 为覆盖降级场景（远层外缘 uv 越界走光深 0 fallback，与 shadowFar 外语义一致）。
- 层交界 viewZ 分布校准（评审 m9b）：interval 值尽量落在无云视距段——实现时用回放序列统计微调（**联动重算 radii**，§3.1.4）。
- **close zoom 精度回退（已知项，评审 render-3a）**：现 far≈20km 时 cascade0 texel 15.6m（视锥收紧红利），固定 radii 后统一 62.5m——近景 texel 粗 4 倍，PCF 世界宽度同步变粗。低太阳角近景专看（§6）；过软则按相机高度分 2-3 档 radii（高度量化仍时序稳定，档间一次跳变可 EMA；**语义键须含档位**——复审 N5）。

## 6. 测试与验收（TDD）

单测：
- **时序稳定性（f32 仿真）**：矩阵 16 元素与世界坐标逐 `Math.fround` 后重算 uv——平移序列断言 |Δuv|<0.1 texel（f64 域断言会平凡通过，测不出风险——评审 render-2）；纯旋转断言 f32 化矩阵逐帧不变；缩放断言矩阵不变。
- interval 无 NaN 单调覆盖 [0,1]；zNear 局部相对式在太阳角 2°/10°/30°/60° 下全 footprint rayNear 为壳顶首交（非 0）；**正午低相机（≲1.2km）下 BSM 光深 >0**（zenith bug 全量归零回归，盲审 4）。
- 现有视锥拟合断言迁 frustum 分支保留。

端到端（**相对同速基线增量**指标，评审致命-1/C1）：
- 四探针各测 BSM 开/关 AB：慢速轨道（主战场，现增量 1.55%；**预期值非基线**——轨道含位置分量，snap 频次残余仍在，预期 0.1-0.3% 区间）、慢速直线平移 3m/帧（现 0.17%）、**快速直线平移 12m/帧（现 0.69%——唯一已超标工况，v3 补入，复审 C）**、滚轮 dolly 缩放——目标各 **增量 <0.3%**；快速平移若不达标，E1' 归因后决定豁免（720m/s 非目标场景）或立项。
- **E1' 归因实验（v3 新增，复审 E）**：冻结矩阵 + radii 膨胀 3-5× 覆盖全程航迹（消除覆盖损失污染）+ 平移录屏 = 非 snap 噪声地板——轨道验收若落 0.2-0.4% 区间（§1.1 风险余量警示），用它区分层界残余/snap 残余/f32 相位，定修复方向。
- 静态同视角 world vs frustum 单帧截图对比（检测覆盖/精度回归+防「阴影消失」假阴性；**差异注记**：正午低相机差异读作「world 修复 distance 入壳 bug」非回归，复审 N2）；BSM on/off 静态视觉对比确认阴影存在。
- `?cloudsShadowTemporal=0` 裸残余对照（隔离 EMA 掩护）。
- 跑钟场景：太阳跨步后录屏 5s+ 确认无可见台阶/无单帧 GPU 尖峰。
- 低太阳角近景专看 PCF 软化（texel 62.5m×6=375m vs 现最好 94m；过软则分 2-3 档 radii，语义键含档位，§5）。
- 静止跳过用 render 计数验证。

## 7. 风险与开放问题（v3 重排——非矩阵地板升为首要）

| 风险 | 缓解 |
|---|---|
| **非矩阵噪声地板（首要，结构性）**：慢平移增量 0.17% 已是地板，0.3% 目标只剩 0.13% 余量；轨道边界 dither 扫掠更快、地板可能更高 | 世界锚定修不掉（矩阵无关）；E1' 归因实测；若轨道落 0.2-0.4% → 豁免决议或 STBN 世界域索引/边界处理立项（大改） |
| snap 频次跳变残余（轨道/快速平移） | EMA+PCF 摊薄；`?cloudsShadowTemporal=0` 裸残余实测；不达标同上立项 |
| f32 相位 0.01~0.06 texel 噪声 | fround 仿真单测；clip 域增量平移兜底（§3.1.7） |
| uv 越界硬边界（无 fade） | 1.6×d 覆盖最坏取向（§3.1.1）后仅 fov>65° 降级场景出现；防御性保留越界返 0（与现状同） |
| 太阳跨步 0.2-0.4 texel 跳变（跑钟） | 12s 一次+EMA+PCF；专项录屏验证；不达标缩步长或加 blend |
| 覆盖语义变化（c0 texel +33%） | §5 解析配套+静态截图 AB 验收；低太阳角近景验收点 |
| 跳过判据漏判 | 语义键完备（含 A bucket/档位）；漏判最坏=多 march（无视觉错误） |

开放：interval 交界微调（§5 回放统计，联动 radii）；低太阳角 PCF 软化分档（验收后定）。

## 8. 评审意见落实对照表（v1→v2）

| 意见 | 落实 |
|---|---|
| 渲染-1 z 域 critical | §3.1.3 解析 zNear + 现存 bug 回归用例 |
| 渲染-2/对抗轻伤-1 f32 | §3.1.7 降级声称+fround 单测+兜底 |
| 渲染-3 校准方法 | §5 解析配套（已替换统计上界） |
| C1/致命-1 验收探针 | §6 多探针+增量指标+静态截图 |
| C2 层界论断 | §1.1 机理修正（层分配仍随相机变，靠两层各自稳定+fade 单次翻转） |
| M1/重伤-3 NaN | §3.1.4 常数区间 |
| M2 跳过判据 | §3.2 语义键+distance 常数化 |
| M3 z 公式 | §3.1.3 |
| M5 量化作用域 | §3.1.8 矩阵量化/march 精确+向量量化 |
| 重伤-1 覆盖几何 | §3.1.1 解析配套+§1.1 E1 教训 |
| 重伤-2 噪声分解 | §1.1 门禁实验（已完成） |
| 中伤-1 杠杆臂 | §3.1.8 修正 |
| 轻伤-2/3 边界 | §3.2 ICRF 已知项+§3.1.3 现存 bug |
| 轻伤-4 uniform 名 | §3.1.5 u_shadowCameraNear |
| m6 勘误 | CloudsResolvePass 非调用方——无工作项 ✓ |
| m7 不变量 | §3.2 |
| m8/m9 | §3.1.5 锚点测试+§5 交界校准+§4 console 提示 |
| render-9 单源矩阵 | §3.1.9 |
| render-10 PCF 软化 | §6 低太阳角验收点+分档预案 |

## 9. 复审分歧裁决记录（v2→v3）

复审三方（集成【通过】/ 对抗【有条件 2 重伤】/ 盲审【有条件 4 major】）出现两处直接分歧，独立复算裁决：

**§9-A 覆盖系数 1.25（盲审认可）vs 1.545（对抗判错）→ 裁决：对抗正确。**
盲审推导「段内点距光轴 lateral ≤1.178d，light-xy 投影只缩不放 → <1.25d」把「垂直视线的横向偏移」当成了「light-xy 投影上界」——点 p 的 light-xy 投影是 |p−P_cam| 中垂直太阳方向的分量；当视线⊥太阳（日落侧平视常见取向）时轴向分量 d **全额**垂直于太阳 → 投影 = √(d²+(1.178d)²) = 1.545d。v1 渲染专家的 1.18 推导与 v2 的 1.25 同源同错。修正为 1.6×d（§3.1.1），撤回「结构性消失」，广角阈值 72°→65° 重推。盲审核验中「与现拟合 {11.99,24.83,78.16} 吻合」是两心不同源（截面心盒 vs 相机心盘）的假吻合。

**§9-B zNear 公式「安全」（盲审）vs「量纲错误成灾」（对抗）→ 裁决：两者各对一半，对抗的交互攻击成立。**
盲审验证的是精确基下的内容正确性（near 面高于壳顶即安全——成立，且 78.16 实测值精确复现）；对抗发现的是**量化基（0.05°）× march 精确方向的非共模放大**：同 uv 柱横向分离 = Δz·sin(step)，v2 公式 Δz≈6371km → 5.6km = 93+ texel。盲审自己 §3.1.8「共模无系统差」的结论漏查了矩阵基与 march 方向的非共模。修正为局部相对式 + margin ≤30km 约束（§3.1.3），盲审的域换算式（#3）一并吸收。

**盲审独有贡献（v3 采纳）**：机理再修正（STBN 每帧重随机化与 snap 无关——v1 对抗与 v2 作者同错一层；主通道=reprojection 错位拒收+边界 dither 扫掠，实证排序支撑）；非矩阵地板余量 0.13% 警示（升为首要风险）；zenith bug 全量归零（非少算）；语义键补 A bucket；fov 阈值修正。

**对抗复审其余项（v3 采纳）**：快速平移 0.69% 入验收（C）；E1' 归因实验（E）；interval-radius 联动（F）；轨道探针语义与预期值（G）；跳频勘误 28 帧（D）。

**集成复审项（v3 采纳）**：frustum 分支 bit 级保留 + AB 增量基线完整性（N1）；AB 差异注记（N2）；P_surface 输入依赖（N3，plan 阶段落）；跳频勘误（N4）；分档 radii 语义键含档位（N5）。
