# Eye-Space EMA（反演后米距离域 EMA）修 camera 低 vs EMA 张力

> 设计日期：2026-08-05
> 分支：fix/arc-flicker
> 前序：depthTemporal EMA 14 task 已实现（commit `c2c22c5`→`7cd7da9`），视觉验收发现 camera 低丢大气致命问题，atmosphere 已 staged 回退 main 风格。本 spec 设计彻底解。

## 1. 背景与目标

`fix/arc-flicker` 分支的 depthTemporal EMA（消除 globe depth 时序抖导致的 inscatter 同心水波纹）存在致命张力：

- **高空（camera 移动）**：EMA 消除水波纹 ✓
- **低空（camera 低 camR≈bottomR，地表视角）**：EMA 导致大气散射丢失 ✗

当前 staged 状态（`aerialPerspective.frag.ts` + test 已 `git checkout main`）将 atmosphere 回退 main（`czm_readDepth` raw window-depth，不消费 depthTemporal `.a`），camera 低恢复正常但水波纹回归。这是临时对齐，非彻底解。

**本 spec 目标**：设计 B1——把 EMA 从 raw log-depth 域移到**反演后的米距离（sceneDist）域**，既消水波纹又保 camera 低散射正常。验证后若 C（half-float 灾消）暴露再做 float32 LUT（后续 ticket）。

## 2. 三个独立问题 + 根因

调试确认张力由三个独立问题耦合：

| 问题 | 根因（代码定位） | 现状 |
|------|-----------------|------|
| **A. 高空水波纹** | globe depth 时序抖（瓦片异步加载 depth=1 闪 + DEM/LOD 值跳变），放大到 inscatter 同心波纹 | main 有波纹；depthTemporal EMA 消除 |
| **B. camera 低 EMA 偏差** | EMA 在 raw log-depth 域 + atmosphere 2-arg `czm_windowToEyeCoordinates(LOG_DEPTH)` 反演；log-depth 远距离压缩，camera 低（sceneDist 几 km）log-depth≈1，EMA 微小误差经 2-arg 反演在 sceneDist 上**放大** | 仅 EMA 下出现；main（raw window-depth）camera 低正常 |
| **C. camera 低 inscatter 灾消** | `runtime.glsl:355` `scattering - shadow_transmittance·scattering_p`，camera 低 d 小 → r_p≈r → 两接近大数相减丢有效位（half-float ~11 位尾数） | main 下被 exposure/dithering 掩蔽（不致命）；EMA 放大 sceneDist 偏差后暴露 |

### 为什么 B 是主因（C 不先修）

main（raw window-depth，无 EMA）camera 低散射正常 → 证明 **C 灾消在 main 下不致命**（sceneDist 正确，d 正确，相减虽丢精度但 exposure/dithering 掩蔽）。**B（EMA sceneDist 偏差）才是 camera 低异常主因**——EMA 让 sceneDist 错，d 错，放大 C 或直接让 inscatter 错。

故本 spec 修 B（C 作为后续 ticket，B1 验证后评估是否必要）。

### three-geospatial 调研结论（佐证）

- three-geospatial runtime 的精度保护（`SafeSqrt`、`eps=0.004` 地平线 hack、`scattering.r<1e-5` 除无穷小）**我们已有**（`runtime.glsl:67` 等）。
- three-geospatial 的 log-space `opticalDepth` 精度保护需**预计算端配对**（`TRANSMITTANCE_PRECISION_LOG`），我们 `.bin` 是外部预生成 exp 空间 half-float，无 Generator，用不了——属于 C 的修复范畴（需重预计算），本 spec 不涉及。
- three-geospatial 的 float32 LUT = GPU 现场预计算（`PrecomputedTexturesGenerator`），不从 half-float `.bin` 转。属 C 修复（后续 ticket）。

## 3. B1 架构

**核心思路**：把 depth 反演从 atmosphere 移到 depthTemporal，EMA 改在反演后的米距离（sceneDist）域做。

### 为什么这能修 B

| | 当前（log-depth EMA）| B1（米距离 EMA）|
|---|---|---|
| depthTemporal EMA 域 | raw log-depth（`.r`，远距离压缩）| 反演后 sceneDist 米（线性物理量）|
| 反演方式 | — | window-depth 4-arg（对齐 main atmosphere，camera 低准）|
| atmosphere 取 sceneDist | 2-arg 反演 log-depth（camera 低放大 EMA 误差）| 直接读 `.a`（不反演，零放大）|

根因链：log-depth 远距离压缩 → camera 低（sceneDist 几 km）log-depth≈1 → EMA 微小误差 → 2-arg 反演在 sceneDist 上**放大**。B1 切到米域 + window-depth 反演 + atmosphere 不反演，三段都不放大。

### 数据流

```
depthTemporal[0]（改）:
  czm_readDepth(window-depth) → 4-arg czm_windowToEyeCoordinates → czm_inverseView
    → worldPosECEF（camera 低准，对齐 main atmosphere L346-350）
  sceneDist_m = length(worldPosECEF - czm_viewerPositionWC)
  reproject worldPosECEF via u_prevViewProjection → prevUV
  EMA 米域: smoothDist_m = mix(histDist_m, sceneDist_m, alpha)
  输出 vec4(sceneColor.rgb, smoothDist_m / MAX_DIST_M)

atmosphere[1]（HDR 变体，重新接 .a）:
  originalColor = colorTexture.rgb        // depthTemporal 透传的 sceneColor
  smoothSceneDist_m = colorTexture.a * MAX_DIST_M   // 直接用，不反演
  depth = czm_readDepth                   // 仅 depth<1 布尔判 hasScene，不反演
  hasScene = (depth < 1.0) && (smoothSceneDist_m > 0) && (smoothSceneDist_m < MAX_DIST_M)
  scenePosKm = cameraPosition + rayDirection * (smoothSceneDist_m * METER_TO_LENGTH_UNIT)
  → fore inscatter 用 scenePosKm（EMA 平滑，无放大）

atmosphere[1]（UNSIGNED_BYTE 变体）:
  czm_readDepth + 4-arg 反演 worldPosECEF（main 风格，camera 低准但无 EMA）

lensflare occlusion[2]:
  .a 语义从 log-depth 改米距离；倾向独立 czm_readDepth 布尔判断（解耦）
```

**两个 stage 职责分离**：depthTemporal 负责「反演 + EMA」（camera 低准的 window-depth 反演 + 米域 EMA），atmosphere 负责「消费」（直接读 `.a`，不反演不放大）。

## 4. 详细设计

### 4.1 sceneDist 编码到 `.a`（HalfFloat 通道）

- `MAX_DIST_M = 2e6`（2000km）。依据：大气内 camera 最高 horizonKm ≈ √(6471²−6371²) ≈ 1133km，2000km 覆盖全部大气内场景。`.a = sceneDist_m / MAX_DIST_M`
- 精度：camera 低 5km → `.a=0.0025`，HalfFloat 11 位尾数 → 绝对 ≈1.2m；消费范围（fore mask `< CLOSE_KM=20km`）精度足够（inscatter 对米级距离不敏感）
- far plane（`depth=1`）：`czm_readDepth` 返回 1.0 → `depth<1` false → `hasScene=false`，**不靠 sceneDist 上限排除**；远地形 sceneDist>2000km 编码溢出（`.a` clamp 1.0）无害（fore mask=0 不消费）
- `MAX_DIST_M` 定义在 `depthTemporalConstants.ts`（single source），atmosphere import 同一常量

### 4.2 disocclusion 阈值（米域）

从 log-depth 相对改为**米域相对**：`|histDist_m − sceneDist_m| / max(sceneDist_m, EPS_M) < u_depthThreshold`，默认 0.1（≈10% 距离，与 log-depth 0.1 ≈7% 距离同量级）。`?depthThreshold=` 参数化保留。`EPS_M` 防近零除（如 1m）。

### 4.3 lifecycle（完全复用 Task 8）

Task 8 已实现（history ping-pong Texture + postRender blit/swap/prevVP/alpha + 首帧 clear + 判空保护）**完全复用**，仅 history `.a` 语义从 log-depth 改米距离。resize/prevVP/alpha/temporalAlpha 逻辑不变。

### 4.4 UNSIGNED_BYTE 兜底（编译时双变体）

非 HDR 设备（`postHdrDatatype === UNSIGNED_BYTE`）或 `?temporalEma=0`：
- **depthTemporal**：纯透传 `sceneColor.rgb`，不反演不编码米距离（UNSIGNED_BYTE `.a` 仅 8 位 = 2000km/256 ≈ 8km 精度，camera 低 fore 阶梯化不可接受）
- **atmosphere 编译时双变体**：HDR 走 B1（读 `.a` 米距离），UNSIGNED_BYTE 走 main 风格（`czm_readDepth` 4-arg 反演，camera 低准但无 EMA → 可能有水波纹，UNSIGNED_BYTE 本就是低质量兜底）
- `AtmosphereStage` 装配时按 `postHdrDatatype` 选变体（已有 UNSIGNED_BYTE 判断逻辑，扩展为选 atmosphere shader 变体）
- 选择编译时双变体（非 runtime 分支）：避免 runtime 分支开销 + shader 复杂度

### 4.5 lensflare occlusion

当前读 `.a`（smoothLogDepth）做 log-depth 阈值。B1 `.a` 改米距离。两个选项：
- **选项 a（推荐）**：lensflare occlusion 改用独立 `czm_readDepth` 布尔判断（太阳方向像素 `depth<1` = 被地形遮挡；`depth≥1` = 天空不遮挡）。太阳遮挡本就是布尔，不需 EMA 平滑的精确值。解耦 depthTemporal，简单。
- 选项 b：保留读 `.a`，阈值改 `sceneDist < MAX_DIST_M`（地形=近遮挡）vs `depth≥1`（天空）。

倾向选项 a（解耦 + 简单）。

## 5. 测试策略

### 5.1 单元测试（更新现有 + 新增）

**`depthTemporal.frag.test.ts`**（更新）：
- shader 含 `czm_readDepth(depthTexture, ...)`（window-depth，**非** raw `texture().r`）
- shader 含 4-arg `czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, depth, 1.0))`
- shader 含 `length(worldPosECEF - czm_viewerPositionWC)`（sceneDist 米计算）
- shader 含 `/ MAX_DIST_M`（import 自 `depthTemporalConstants.ts`，single source）编码
- shader 含米域 `mix(histDist, sceneDist, alpha)`
- **不含** `#define LOG_DEPTH`
- **不含** raw `texture(depthTexture, ...).r` 直接 EMA（旧 log-depth 路径）
- glslang 校验桩补 `czm_readDepth` + 4-arg `czm_windowToEyeCoordinates`

**`aerialPerspective.frag.test.ts`**（新增双变体）：
- `buildAerialPerspectiveFragmentShader({ hdrDepthTemporal: true })`（HDR 变体）：含 `colorTexture` `.a` 读取、含 `MAX_DIST_M` 解码；**不含** `czm_readDepth` 反演 worldPosECEF（仅 `depth<1` 布尔）
- `buildAerialPerspectiveFragmentShader({ hdrDepthTemporal: false })`（UNSIGNED_BYTE 变体）：含 `czm_readDepth` + 4-arg 反演（main 风格）
- 两变体都输出线性 `out_FragColor = vec4(finalColor * exposure, originalColor.a)`（phase2a HDR 不破坏）
- 默认 `hdrDepthTemporal` 由 `AtmosphereStage` 按 `postHdrDatatype` 决定（测试显式传两值）

### 5.2 glslang 编译验证

5 个 shader 编译通过：
- depthTemporal（HDR enabled + debug=8 raw depth 诊断分支）
- atmosphere HDR 变体
- atmosphere UNSIGNED_BYTE 变体
- occlusion（smooth + legacy UNSIGNED_BYTE 兜底）

桩更新：`czm_readDepth(sampler2D, vec2) → float` + 4-arg `czm_windowToEyeCoordinates(vec4) → vec4`。

### 5.3 数学回归（B1 核心假设 CPU 验证）

新增 `depthTemporal.math.test.ts`（或扩展现有 regression）。**此测试应在实现前先跑**，验证 B1 核心假设。构造 camera 低场景（camera 高 5km，sceneDist=5km），对比两条路径在**同等输入抖动**下的 sceneDist 输出误差：

- **log-depth 路径**（当前）：sceneDist 5km → Cesium log-depth 公式 `logDepth = log2(z+near+1)/log2(far+near+1)`（z=眼坐标负距离，far≈Cesium 默认 1e7m）→ 在 log-depth 域注入抖动 ±Δ（模拟 EMA 残差/量化，如 ±0.001）→ 2-arg `czm_windowToEyeCoordinates(LOG_DEPTH)` 反演回 sceneDist' → 误差 = |sceneDist' − 5km|
- **米域路径**（B1）：sceneDist 5km → 直接在米域注入等价抖动（Δ 对应的米值，由 log-depth 局部导数 `d sceneDist / d logDepth` 换算）→ sceneDist'' → 误差 = 注入量本身
- **断言**：log-depth 路径误差 > 米域路径误差至少 1 个量级（证明"log-depth 域小抖动 → 反演非线性放大"）。

**决策门**：若此 CPU 验证显示「反演放大」**不显著**（两路径误差同量级），则 B1 的核心假设不成立——根因更可能是 reproject 跨帧滞后（camera 移动时 history 像素不对齐）而非反演放大。此时 spec 需修订：B1 转向「诊断运动门控/temporalAlpha/reproject 精度」，而非盲目实现米域 EMA。此门在 Task 1（数学回归）完成后、后续 shader 改动前 review。

### 5.4 视觉验收（demo，用户）

1. **水波纹消除（camera 移动）**：
   `http://localhost:5173/?mode=atmosphere&time=2026-08-04T01:00:00Z&camera=93.4055,32.7362,1002025,0.0,-89&inscatterScale=25`
   - 预期：相机俯仰变化时，远处 inscatter 同心波纹消除（depthTemporal EMA 米域平滑）。静止后稳定无残留抖。
2. **camera 低散射正常**（B1 核心）：
   `http://localhost:5173/?mode=atmosphere&time=2026-08-04T01:00:00Z&camera=139.2399,34.8752,5000,8.7,-21.1&inscatterScale=25`
   - 预期：地表散射正常（对比当前 staged main 的 camera 低效果，应一致或更稳）。**这是 B1 的核心验收点**。
3. **山体清晰**：
   `http://localhost:5173/?mode=atmosphere&inscatterScale=25#camera=95.7229,31.5070,11645,295.8,-4.3`
   - 预期：山体边缘清晰不透明（EMA 不糊 fore/mask）。
4. **lensflare 不闪**：
   上述 URL 加 `&lensflare=1`，orbit/快速俯仰。
   - 预期：lensflare occlusion 稳定不闪。
5. **UNSIGNED_BYTE 兜底**：
   上述 URL 加 `&temporalEma=0`。
   - 预期：回退 main raw depth 反演，camera 低正常（无 EMA，可能有水波纹，属兜底可接受）。

## 6. 回归保护

- **现有 217/217（main atmosphere test）+ Task 13 depthTemporal 回归**不破坏（更新断言，不删用例）
- **phase2a HDR 链**不破坏：双变体都输出线性 `finalColor·exposure`，链尾 tonemap stage 不变
- **phase2b lensflare**不破坏：occlusion 改独立 depth 或 `.a` 米距离阈值，功能保持
- **UNSIGNED_BYTE 变体 = main 风格**：main 效果保底（即使 B1 HDR 路径出问题，UNSIGNED_BYTE 回退 main）

## 7. 风险 + Fallback

1. **B1 假设未实测验证**："log-depth 反演放大"是 B 根因（memory `camera-low-ema-tradeoff` 标注「未完全定位」）。§5.3 数学回归作为**实现前决策门**：若 CPU 验证「反演放大」不显著（两路径误差同量级），B1 核心假设不成立，根因更可能是 **reproject 跨帧滞后**（camera 移动时 history 像素不对齐）→ spec 修订为诊断运动门控/temporalAlpha/reproject 精度，而非盲目实现米域 EMA。
2. **Fallback 安全**：B1 失败可回退当前 staged 状态（atmosphere main raw window-depth + depthTemporal 仅给 lensflare occlusion），不破坏现状。整个工作在 `fix/arc-flicker` 分支，不合并 main 直到视觉验收通过。

## 8. 关键文件

- `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.ts` — depthTemporal shader 组装器（改：window-depth 反演 + 米域 EMA + 编码）
- `packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.ts` — `MAX_DIST_M`、`EPS_M` 常量（新增/扩展）
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts` — atmosphere shader 组装器（改：双变体 `hdrDepthTemporal` option，HDR 读 `.a` / UNSIGNED_BYTE raw 反演）
- `packages/cesium-core/src/cesium/AtmosphereStage.ts` — 装配（改：按 `postHdrDatatype` 选 atmosphere 变体）
- `packages/cesium-core/src/cesium/lensFlare/createLensFlareStage.ts` — occlusion（改：独立 `czm_readDepth` 布尔 或 `.a` 米距离阈值）
- 测试：`depthTemporal.frag.test.ts`、`aerialPerspective.frag.test.ts`、`depthTemporal.math.test.ts`（新增）、compile test

## 9. 参考

- three-geospatial `aerialPerspectiveEffect.frag`（window-depth 反演 L346-350 + correctGeometricError L89-100，camera 低反演参考）
- three-geospatial `runtime.glsl`（精度 hack：SafeSqrt / eps=0.004 / 1e-5 除无穷小，我们已有）
- memory `camera-low-ema-tradeoff.md`（张力记录 + P0 修复方向）
- spec 前序：`docs/superpowers/specs/2026-08-05-depth-temporal-ema-design.md`（depthTemporal EMA v2，方案 A 打包透传）
