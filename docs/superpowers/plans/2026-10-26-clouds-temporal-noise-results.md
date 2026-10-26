# 体积云时域噪声 / 拖影 / 远地平线抖动 排查与修复结果（2026-10-26）

分支 `f2-reapply`。目标：把体积云的静止颗粒、拖动拖影、远地平线抖动对齐参考库
（three-geospatial storybook，本机 6006 常态化运行，可同 GPU 真机 A/B）。

## 一、计量方法（本轮确立，务必沿用）

1. **单对帧差不可用**：同配置复跑会给出 4.42 vs 1.67（2.3× 波动）。
2. **静止指标** = CDP `Page.captureScreenshot` 连拍 10 帧，算「逐像素时间标准差」在云区
   掩码（亮度>60 且 B−R≤18）内取均值。重复性 ±0.03。
3. **运动指标** = 页面内 `gl.readPixels` 逐帧读画布（rAF 内），连取 20–24 帧算逐像素时间
   标准差。比截图法灵敏，且能覆盖「旋转中」这种截图法测不到的场景。
4. **kymograph（时空图）** = 把连续帧的地平线带按「横轴=屏幕 x、纵轴=帧序号」叠成一张图：
   **竖条纹 = 图案锚定屏幕（不随世界移动，即用户感知的「噪点游移」）；
   斜条纹 = 图案随世界移动（正常）**。这是本轮定位远地平线问题的决定性工具。

## 二、根因与修复（按发现顺序）

| # | 根因 | 证据 | 修复 |
|---|---|---|---|
| 1 | 静止时 history 采样点逐帧抖动 | 关重投影后云区时间 std 5.6→1.35 | converge 档：静止关重投影 + 关裁剪 + EMA 1/32 |
| 2 | 纯旋转被误判为静止（`still` 只看位置） | 旋转时套用「静止关重投影」→ 拖影 | `still` 增加朝向判据（<1e-4 rad） |
| 3 | march 速度里恒定含 −jitter（射线抖动不进像素栅格） | 静止时 depthVelocity = (−0.00117, −0.00208)，应为 0 | resolve 侧 `prevUv = vUv − velocity − j(t−1)` |
| 4 | 几何抖动只作用于云射线 → 运动时云层相对地面晃 ±1.5px | 运动时 jitter=全幅 → 整体晃；=0 → 远地平线噪点游移 | 运动档缩放到 35%（±0.5px，亚像素） |
| 5 | 三态判断写错，35% 分支从未生效 | 三个对照 URL 表现完全一致 + 读 params 确认 jitter 恒 0 | 修正三态判断（`69a4963`） |
| 6 | **haze 的 alpha 在远地平线由逐像素场景深度驱动**，掠射角敏感度爆炸 → 屏幕锚定图案 | kymograph：开 haze 竖条纹 / 关 haze 斜条纹 | haze 在 >30km 淡出（近场空气透视效应；远场交给 atmosphere） |

## 三、实测数据（远端 68，1920×1080，60fps）

**静止（云区逐像素时间 std）**

| 配置 | 指标 |
|---|---|
| 参考库 storybook | 1.34 |
| 修复前 | 9.26 |
| 修复后 | **1.30** |

**运动（30°/s 平移，地平线带逐像素时间 std）**

| 阶段 | 指标 |
|---|---|
| haze 淡出前 | 4.32 |
| haze 淡出后 | **1.07**（静止 0.15） |
| 参考库同口径（云区） | 1.33 |

**kymograph 判定**：haze 淡出后地平线带由竖条纹转为斜条纹（图案随世界移动）。

## 四、旋钮（均已入库，缺省即上述定稿）

- `?cloudsConverge=0` 回退旧静止行为
- `?cloudsGeomJitter=0|1` / `?cloudsGeomJitterScale=`（运动档几何抖动，缺省 0.35）
- `?cloudsMotionBlend=`（运动 EMA，缺省 0；调大会带回拖影）
- `?cloudsFarBlend=`（远段 EMA，缺省 0.05）
- `?cloudsBlend=` / `?cloudsClip=` / `?cloudsVelDeadzone=` / `?cloudsShaftJitter=`
- `?cloudsHaze=0` 完全关 haze（远地平线最干净、但雾带消失）

## 五、遗留

用户反馈 haze 淡出后**仍有轻微抖动**。当前测量已低于参考库噪声底，无法再用现有指标
区分来源。待判定的分支：

1. 开 `?clouds=0`（完全关云）看地平线是否仍抖 → 若是，属 Cesium 底图/瓦片；
2. 开 `?cloudsTemporal=0`（关时域重建）看抖动是否明显变化 → 判定 march 还是 resolve。

下一步候选（按优先级）：
- 若属 march：远地平线掠射段的 `maxRayDistance ← 场景深度` 同样是屏幕锚定输入，
  可用与 haze 同款「远段退让」处理（云射线终止距离在 >30km 时用解析几何而非深度）；
- 若属 resolve：远段改用更长的 EMA 或对远段单独做空间低通。

---

## 六、2026-10-27 补轮：三个并存问题的共同根因（已根治）

### 根因（一句话）

`clouds.frag` 的射线重建用 `temporalJitter * resolution` 做窗口偏移，而 `czm_viewport` 是
**低分 FBO（320×180）**、`resolution` 是 **低分×4（1280）** → 射线位移被放大 4 倍：
N=4 时 ±1.5 **低分** texel = **±6 个全分像素**（three-geospatial 是 ±1.5 全分像素）。

同帧实测（`probe-ratio.mjs`，直接读 temporalJitter 与 depthVelocity）：

| 阶段 | velocity / temporalJitter |
|---|---|
| 修复前 | 恒 **4.00×** |
| 修复后（改用 `jitterPx = 低分 FBO 尺寸`） | **1.00×**（逐帧误差 <1e-5） |

这一条同时解释三个现象：
- **整体晃**：云射线整帧平移 ±6px，而地形（Cesium 自己渲染）不抖；
- **垂直噪点移动**：同一位移的 y 分量；
- **运动噪点增多**：±6px 的相位跨度让 16 相位平均退化成 3 低分 texel 的模糊，
  重投影误差也同比放大。

### 两处配套修复

1. **去抖动重采样**（`cloudsResolve.frag`）：低分 texel q 的真实采样位置是
   `(q+0.5)/lowRes + j(t)`，所以当前帧改用 `texture(colorBuffer, vUv − j(t))`，
   把整帧平移过的低分图重采样回**像素栅格**；`velocity` 在重投影前加回 `j(t)`
   （静止时精确为 0）。history 与 current 因此落在同一栅格上，EMA 才能长窗累积。
2. **统一档翻缺省**：`?cloudsUniform` 缺省改为统一（全程重投影 + 关裁剪 + EMA 1/32）。
   2026-10-26 该档被否决的「静止抖 + 拖动残影」正是「用上帧 j(t−1) 补偿」造成的
   （静止时 history 采样点 `p + j(t) − j(t−1)` 每帧游走）。

### 同构建 A/B（地平线带 256×48，1280×720，静止 20 帧 / 旋转 30°/s 20 帧 / 停后追平 12 帧）

| 配置 | 静止 std | 旋转 std | 停后追平 |
|---|---|---|---|
| 2026-10-26 缺省（jitter 4×、两套档） | 0.777 | 6.953 | 0.896 |
| 4× jitter + 去抖动 + 两套档 | 0.772 | 3.196 | 1.855 |
| **新缺省（jitter 1× + 去抖动 + 统一档）** | **0.462** | **1.363** | **0.282** |
| 新缺省 + `cloudsDejitter=0` | 2.280 | 3.196 | 1.855 |
| 新缺省 + `cloudsUniform=0`（两套档） | 0.462 | 2.252 | 0.426 |
| 新缺省 + `cloudsGeomJitter=0`（无抖动地板） | 0.211 | 1.402 | 0.140 |
| 统一档 + `cloudsClip=1`（AABB 裁剪） | 2.241 | 5.133 | 2.002 |

结论：去抖动重采样是主力（去掉它静止 0.46→2.28、追平 0.28→1.86）；统一档在运动与追平上
都优于两套档；**统一档下 AABB 裁剪必须关**（裁剪会把历史拉回当前帧噪声邻域 → 静止 2.24）。

### 新旋钮 / 逃生门

- `?cloudsDejitter=0` 回去抖动前的点采样（A/B 用）
- `?cloudsUniform=0` 回两套参数旧行为
- `?cloudsGeomJitter=0` / `?cloudsGeomJitterScale=`（现在缺省不再按 0.35 降幅，满幅 1.0）

### 坑（务必记住）

- **Cesium `removeComments()` 对「无换行的 `/** ... */` 块注释」会抛
  `TypeError: Cannot read properties of null (reading 'length')`**（`match(/\n/g)` 返回 null
  再取 `.length`），表现为**体积云整个创建失败**并被 demo 的 catch 报成「weather 纹理加载失败」。
  GLSL 里一律用 `//`。
- `windowCoord` 的实际位置在 **`CloudsMaterial.ts` 的 bridge 字符串**里，不在 `clouds.frag`
  （`clouds.frag` 只有 `uniform` 声明）——改射线重建别只改 `.frag`。
- 量纲自检工具：`tmp/probe-ratio.mjs`（同帧读 temporalJitter 与 depthVelocity，直接给倍率）。
