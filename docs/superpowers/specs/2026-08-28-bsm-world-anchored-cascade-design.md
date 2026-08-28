# BSM 世界锚定 Cascade 设计（v2，评审修订版）

- 日期：2026-08-28（v1 三专家评审 + 校准实验 + 门禁实验后大修）
- 状态：**评审修订版——待用户终审**
- 分支：`bsm-world-anchored`
- 前置：6b573c9（运动闪动实验矩阵，已合 main）
- 评审记录：渲染专家（1 critical）/ Cesium 集成专家（2 critical 5 major）/ 对抗性审查（2 致命 3 重伤）——意见已全部吸收，标注于各节。

## 1. 背景与问题（含新实验数据）

体积云 BSM 相机移动时云影与天空（经 shadowLength bridge）闪动。量化基础（录屏帧间差分，指标=跳变像素占比 pct>20/255）：

### 1.1 噪声分解（2026-08-28 门禁实验，v2 新增）

| 探针（同速 AB 对照） | BSM 关基线 | BSM 开 | **BSM 增量** |
|---|---|---|---|
| 慢速轨道旋转（rotateLeft，上轮同款） | 0.06% | 1.61%（开 EMA） | **1.55%** |
| 直线平移 3m/帧（180m/s） | 1.16% | 1.33% | 0.17% |
| 直线平移 12m/帧（720m/s） | 0.99% | 1.68%（关 EMA） | 0.69% |

**结论：矩阵噪声主场是旋转/轨道（朝向变），不是平移。** 校准实验证明 radius 在纯平移+纯旋转下均恒定（getFrustumRadius 用角点欧氏距离，旋转不变量）——旋转下真正呼吸的是 **center**：视锥角点在 light space 的轴对齐包围盒（AABB）随朝向变形，center 连续大范围变 → texel snap 后密集跳变 → 每次跳变 STBN jitter（按 texel 坐标索引，见 §3.1.6）大面积重随机化 → march 值跳变 ~stepSize 级 → EMA（α=0.01）追不上 → 闪动。

**教训（门禁实验 E1 作废）**：冻结矩阵实验被覆盖损失污染（冻结 2.28% > 不冻结 1.68%——相机飞出 BSM 盒后 uv 越界硬边界扫过云面）——反向印证 radius-interval 配套（§3.1.2）与覆盖边界的必要性。

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

1. **radius 固定 + interval 解析配套**（评审重伤-1/_render-3）：interval 先定（默认 `{0, 10, 20.8, 60}km`，沿现 practical split far=6e4 值），radius_i = **ceil(1.25 × d_i)**（视锥段远端横向展宽 d_i×tan(θ_diag/2)≈1.18×d_i + 裕量；与现拟合实测 {11.99, 24.83, 78.16}km 吻合，texel 46.8/97/305m 精度无缩水）。**radius-interval 配套后「层内点 uv 越界」结构性消失**（段内点距轴 ≤1.18 d_i < radius）。
2. **center 从视锥 bbox 心改为相机位置固定网格 snap**（主修复，瞄准旋转主场）：`center.xy = round(P_cam_light.xy / texel) * texel`，网格锚定 light space 原点（地心），texel 恒定 → 网格恒定。**纯旋转下 center 完全不动 → 矩阵 bit 级不变**；平移下整数 texel 跳（稀疏）。
3. **z 域解析 near 面**（评审 critical 双命中/render-1/M3）：现实现 distance=lerp(1e6,1e3,zenith) 是隐含的壳顶越界补偿——固定浅盒低太阳角会切壳（cascade2@太阳角10° 时壳顶跨 footprint 高差 442km）。改为解析式：`zNear = dot(P_surface, sunDir) + √(R_top² − radius_i²) + margin`（P_surface=相机地表投影，JS float64，margin 50~100km 零成本——clip.z 全管线无消费，near 面只要在壳顶之上高度不影响内容；far 随意给足）。z 同 snap 到粗网格（如 1km，纯为跳过判据稳定）。**顺带修复现存 bug**：zenith→1 时 distance=1km 反投影起点落入壳内、rayNear=max(0,·) 静默截断少算上半段光深——固定 z 盒后此路径消失，加回归用例。
4. **interval 常数区间**（评审 M1/重伤-3）：world 分支**不复用 splitFrustum**（near=0 → logarithmic 分支 0·∞=NaN 传染 practical）。直接常数区间与 radii 配套。单测断言无 NaN 且单调覆盖 [0,1]。
5. **shadowFar 固定**：`min(maxRayDistance, SHADOW_FAR_LIMIT)` 常数，去掉 `camera.frustum.far` 参与（multi-frustum 缩放时 far 不再变）；`u_shadowCameraNear` 固定注入 0（注入点已存在 CloudsPass.ts:460，**注意 uniform 名是 u_shadowCameraNear 非 cameraNear**——后者是 czm_currentFrustum.x 动不得，评审轻伤-4）。
6. **机理修正（评审致命-2）**：「整数平移保相位」为真（采样相位恒定），**「保值」为假**——STBN 蓝噪声按 gl_FragCoord（texel 坐标）索引，snap 跳变 = texel 换 jitter 值（蓝噪声去相关）→ march 采样模式部分重随机化 → per-texel 值跳变 ~stepSize 级。世界锚定的真实收益 = **跳变频率从每帧（center 呼吸）降到 snap 频率**（平移 100m/s 时 cascade0 每 ~4 帧一次 1-texel 跳，旋转下零跳变）+ EMA（半衰期 69 帧）摊薄单个跳变 + resolve velocity 在整数平移帧精确重投影（prevUv 恰落旧 texel 中心，双线性无损——评审 render-5 确认比「退化」更强）。
7. **f32 相位现实性**（评审 M4/轻伤-1 降级）：float64 严格成立；GPU float32 下矩阵平移分量与世界坐标 6.4e6 量级大数相消 → clip 误差 ~1-2m → **UV 相位噪声 0.01~0.1 texel**（radius 越小占比越大）。声称降级为「亚 0.1 texel 相位稳定」。**兜底预案**（若平移探针不达标）：texel 跳 n 时 clip 域左乘精确平移 T(n/512)（二进制精确、零舍入），仅太阳跨步/参数变时全量重建。
8. **太阳方向量化（作用域收窄，评审 M5）**：量化只作用于**矩阵构造输入**（light 基/snap/跳过判据），march 与消费端保持精确 sunDirection（生成端 getRayNearFar 与消费端 getDistanceToShadowTop 同用精确值，无系统差；矩阵基与 march 方向差 0.05° 仅表现为亚 texel 采样偏移，PCF 掩盖）。实现：**量化向量**——ECEF 单位球上网格量化（步长 0.05°，约 8.7e-4 rad；跨 ICRF/fallback 分支一致——评审 render-6b）。demo 时钟静止时 sunDirection 恒定零触发；跑钟时跨步频率 = 角速度（~15°/h）÷ 0.05° ≈ 每 12s 一次。跨步杠杆臂修正（评审中伤-1）：light 基旋转 → 相机 light 坐标位移 = 地心距 6.37e6 × 8.7e-4 ≈ 5.6km → snap 残差 ≤ 半 texel + 盘内梯度 ≤ θ·r（最差 cascade0 ~0.5 texel/跨步）——跑钟场景需专项验证（录屏跨步后 5s+）。
9. **单源构造矩阵**（评审 render-9）：废弃 lookAtMatrix 二次求基——inverseViewMatrix = lightOrientation 旋转 + translation=centerWorld 直接构造（防 69ee488 类双源漂移）。

### 3.2 消费端与编排

- `cascadedShadowMaps.glsl` / `clouds.frag` / `shadow.frag` / `ShadowPass` **shader 文本零改动**（核验成立；唯一改动是 JS 注入值：u_shadowCameraNear=0、shadowFar 常数、intervals 常数区间）。锚点测试防回归（含 getViewZ 共用面）。
- 编排（createCloudsStage）：新开关 `shadowAnchor: 'world' | 'frustum'`，**默认 world**；`?cloudsShadowAnchor=frustum` 回退。**distance 常数化**（现 lerp(1e6,1e3,zenith) 无消费语义已论证——正交 xy 与 z 解耦+球交自愈+消费只取 clip.xy——消掉跳过判据的变源）。
- **静止跳过**：判据 = 语义键 {各层 snap 后 texelIndexXY、z snap 值、太阳量化 bucket}（不做矩阵逐元素比较——评审 M2）；相同则跳过整个 `ShadowPass.render()`。**不变量**（评审 m7）：跳过时 prev/current matrices 与 history 三者冻结，恢复时 reprojection 语义自洽（prevMatrices=上次实际 render 的矩阵，history 恰为该时代）。跳帧时 params.frame 仍递增（stbn 相位跳号，任意相位低偏差无害）。
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

## 5. 设计值（校准+解析，已完成）

- 现分布实测（far=6e4，fovy 60°/16:9）：radius {11.99, 24.83, 78.16}km、texel {46.8, 97.0, 305.3}m、interval {0-10, 10-20.4, 20.4-60}km。
- 解析配套：interval `{0, 10, 20.8, 60}km` → radius = ceil(1.25×d) = {12.5, 26, 75}km——与现分布吻合（末层 75 vs 78 因 fade 扩张差异，取 78 保守值亦可）。
- 广角 90° 需 radius ×1.72（20.6/42.4/129.9km）——**固定 radii 按标准 fovy 60° 定；fov > ~72°（1.25×d < tan(θ/2)·d 时）为覆盖降级场景**：远层外缘点 uv 越界走光深 0 fallback（无自阴影，与 shadowFar 外语义一致）。demo 无广角配置，如需支持再按 fov 档扩 radii（§7 风险表）。
- 层交界 viewZ 分布校准（评审 m9b）：interval 值尽量落在无云视距段——实现时用回放序列统计微调（不阻塞）。

## 6. 测试与验收（TDD）

单测：
- **时序稳定性（f32 仿真）**：矩阵 16 元素与世界坐标逐 `Math.fround` 后重算 uv——平移序列断言 |Δuv|<0.1 texel（f64 域断言会平凡通过，测不出风险——评审 render-2）；纯旋转断言 f32 化矩阵逐帧不变；缩放断言矩阵不变。
- interval 无 NaN 单调覆盖 [0,1]；zNear 解析式在太阳角 2°/10°/30°/60° 下全 footprint rayNear 为壳顶首交（非 0）。
- 现有视锥拟合断言迁 frustum 分支保留。

端到端（**相对同速基线增量**指标，评审致命-1/C1）：
- 三探针各测 BSM 开/关 AB：慢速轨道（主战场，现增量 1.55%）、慢速直线平移 3m/帧（现 0.17%）、滚轮 dolly 缩放——目标各 **增量 <0.3%**。
- 静态同视角 world vs frustum 单帧截图对比（检测覆盖/精度回归+防「阴影消失」假阴性）；BSM on/off 静态视觉对比确认阴影存在。
- `?cloudsShadowTemporal=0` 裸残余对照（隔离 EMA 掩护）。
- 跑钟场景：太阳跨步后录屏 5s+ 确认无可见台阶/无单帧 GPU 尖峰。
- 低太阳角近景专看 PCF 软化（texel 47m×6=280m vs 现最好 94m；过软则按相机高度分 2-3 档 radii，高度量化仍时序稳定）。
- 静止跳过用 render 计数验证。

## 7. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| STBN 重随机化残余（snap 频次跳变） | EMA+PCF 摊薄；`?cloudsShadowTemporal=0` 裸残余实测；不达标则研究 STBN 世界域索引（大改，另立项） |
| f32 相位 0.01~0.1 texel 噪声 | radii 不低于现分布；fround 仿真单测；clip 域增量平移兜底（§3.1.7） |
| uv 越界硬边界（无 fade） | radius-interval 配套后结构性消失（层内点必在盘内）；防御性保留越界返 0（与现状同） |
| 太阳跨步 0.5 texel 跳变（跑钟） | 12s 一次+EMA+PCF；专项录屏验证；不达标缩步长或加 blend |
| 覆盖语义变化（固定半径） | §5 解析配套+静态截图 AB 验收 |
| 跳过判据漏判 | 语义键含太阳 bucket/帧号独立递增已知项；漏判最坏=多 march（无视觉错误） |

开放：interval 交界微调（§5 回放统计）；低太阳角 PCF 软化分档（验收后定）。

## 8. 评审意见落实对照表

| 意见 | 落实 |
|---|---|
| 渲染-1 z 域 critical | §3.1.3 解析 zNear + 现存 bug 回归用例 |
| 渲染-2/对抗轻伤-1 f32 | §3.1.7 降级声称+fround 单测+兜底 |
| 渲染-3 校准方法 | §5 解析配套（已替换统计上界） |
| C1/致命-1 验收探针 | §6 三探针+增量指标+静态截图 |
| C2 层界论断 | §1.1 机理修正（层分配仍随相机变，靠两层各自稳定+fade 单次翻转） |
| M1/重伤-3 NaN | §3.1.4 常数区间 |
| M2 跳过判据 | §3.2 语义键+distance 常数化 |
| M3 z 公式 | §3.1.3 |
| M5 量化作用域 | §3.1.8 矩阵量化/march 精确+向量量化 |
| 重伤-1 覆盖几何 | §3.1.2 解析配套+§1.1 E1 教训 |
| 重伤-2 噪声分解 | §1.1 门禁实验（已完成） |
| 中伤-1 杠杆臂 | §3.1.8 修正 |
| 轻伤-2/3 边界 | §3.2 ICRF 已知项+§3.1.3 现存 bug |
| 轻伤-4 uniform 名 | §3.1.5 u_shadowCameraNear |
| m6 勘误 | CloudsResolvePass 非调用方——无工作项 ✓ |
| m7 不变量 | §3.2 |
| m8/m9 | §3.1.5 锚点测试+§5 交界校准+§4 console 提示 |
| render-9 单源矩阵 | §3.1.9 |
| render-10 PCF 软化 | §6 低太阳角验收点+分档预案 |
