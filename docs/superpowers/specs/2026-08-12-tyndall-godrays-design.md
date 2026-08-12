# phase2c 丁达尔效应（God Rays）设计

> 状态：设计中（brainstorming → 3 专家评审通过 with changes → 待用户审 → writing-plans）
> 日期：2026-08-12
> 评审：3 专家 Workflow（Cesium 集成 / 图形学算法 / 对抗性）全部 `approve_with_changes`，blocker + 共识 important 已并入本版
> 关联：phase2a HDR 管线、phase2b LensFlare（`docs/superpowers/specs/2026-08-04-phase2b-lens-flare-design.md`）

## 1. 背景与目标

用户反馈："现在大气散射效果很不错，但缺少丁达尔效应。"

丁达尔效应（Tyndall effect / crepuscular rays / god rays）：阳光在大气气溶胶中侧向散射形成的可见光柱，晨昏低角度、光束从太阳辐射、被前景地物切割为其典型形态。

**目标**：在现有后处理链中加入 god rays，使阳光在大气中形成可见径向光束，被前景地物（山脊）切割，且太阳盘可见比例决定光束强度（含部分遮挡的典型 crepuscular 形态）。

**非目标**：
- 体积云参与的光束（耶稣光）—— 本项目当前无体积云。
- 物理正确的体积 ray march（每像素数十步积分）—— 性能代价过高，列为未来 phase。

## 2. 方案选择

three-geospatial 参考库**无 god rays 实现**（grep 确认：只有体积云 `packages/clouds` 与 Bruneton 大气）。故本特性为新功能设计，不是移植。

三方案对比（brainstorming 阶段已与用户确认选 A）：

| | 方案 A：后处理 radial blur（选定） | 方案 B：物理体积 march | 方案 C：现有 LUT 增强前向散射 |
|---|---|---|---|
| 做法 | 1 个新 stage，从太阳屏幕坐标径向累积采样 atmosphere 输出 | 新增全屏 march pass，沿视线积分解析 Mie 前向散射 | 在 aerialPerspective shader 朝太阳方向额外乘 HG 增强项 |
| 成本 | 1 全屏 pass（48 tap），可控 | 每像素 32-64 步，极贵 | 零新 pass |
| 风险 | 低，契合现有管线 | 性能、降采样 artifact、与 LUT 标定一致性 | 破坏 DUAL inscatter 标定 |

**选 A 的理由**：直接覆盖用户需求（径向辐射 + 地物切割）；契合现有 PostProcessStage + HDR + lensflare occlusion 基建；便宜可控、URL 参数化验收（与现有 demo 工作流一致）。物理 march（B）作为未来可选 phase。

**用户确认的关键参数**：
- 默认强度：**中等**（明显但不夸张，全天多数视角可见）。
- occlusion 策略：**bright-pass + depth**（评审后细化为：bright-pass 逐像素切割 + lf_occlusion 连续太阳门控，见 §4.3）。

## 3. 架构

### 3.1 链位置与采样源解耦

god rays 与 lensflare 都希望采"干净的 atmosphere 输出"。若串行（god rays 采 lensflare 输出）→ 光束混入 ghost/halo 镜头伪光；若 lensflare 采 god rays 输出 → bloom 把光束当亮区放大 → 耦合过曝。

**解法**：god rays stage 通过 **uniform-name 引用 atmosphere stage 输出**作为采样源（与 lensflare 的 `u_bloomTexture: 'lf_up4'` 同模式），与 lensflare 互不采样：

```
depthTemporal → atmosphere → lensflare → godrays → tonemap
                     ↑                       ↑
                     └─── u_sourceTexture = 'atmosphere'（uniform-name 引用）
                          u_occlusionTexture = 'lf_occlusion'（uniform-name 引用，太阳门控）
                          colorTexture = lensflare 输出（inputPreviousStageTexture=true）
                          输出 = lensflare + godrays
```

- god rays 采 atmosphere（`u_sourceTexture`）→ 无镜头伪光污染。
- lensflare 在 god rays 前，采 atmosphere（其 composite 输入）→ 不采 god rays → 不放大光束。
- god rays 太阳门控复用 lensflare 的 `lf_occlusion`（`u_occlusionTexture`，见 §4.2/§4.3）。
- 两者各自独立叠加到链输出。

> **跨 stage 引用可行性（Cesium 集成专家已核实源码）**：`PostProcessStageCollection._stageNames` 是 `add()` 递归填充的全局 flat 字典，`getStageByName` 全局查找（不区分顶层 / composite 内）；`PostProcessStageTextureCache.getStageDependencies` 对每个 string uniform 经 `getStageByName` 解析注册依赖、`getFramebuffer` 据此隔离 framebuffer 保 outputTexture。本仓库 lensflare `occlusion.depthTexture='czm_depth_temporal'` 已是更强的生产先例（composite 内 stage 引用更早顶层 stage）；god rays 顶层 → 顶层引用 `'atmosphere'` 与顶层 → composite 内 `lf_occlusion` 均是最简 / 等简形态，**必可行**。
>
> **无 fallback**：原设计的 fallback（god rays 放 atmosphere 后靠 lensflare `threshold=3.0` 排除）经评审是死路——god rays 量级（见 §8 量级估算）远超 3.0，lensflare bloom 会提取光束放大耦合过曝。故主方案必行，不设 fallback；T1 改为早期 30-60min spike（建占位 stage 引用 `'atmosphere'` 采红色，demo 跑通即确认），通过则进实现。

### 3.2 depth 源（复用 lensflare 模式）

god rays 的 fallback 太阳门控（`lensflare=false` 时）需读 depth。复用 lensflare occlusion 的 depth 接线：

- `createGodRaysStage(scene, state, options, depthTemporalStageName?, occlusionTextureName?)`：`depthTemporalStageName` 传入（`temporalEmaEnabled=true` 时 `'czm_depth_temporal'`），god rays 的 `depthTexture` uniform 指向该 stage（uniform-name string 跨 stage 引用），shader 读 `texture(depthTexture, uv).a`（smoothDepth，raw log-depth EMA）。
- 未传（UNSIGNED_BYTE 兜底）：不覆盖 `depthTexture`（Cesium 内建 scene globe depth），shader 用 `czm_readDepth`。

`buildGodRaysFragmentShader({ useSmoothDepth, useOcclusionTexture })` 按 `useSmoothDepth` 切换 depth 读取、按 `useOcclusionTexture` 切换太阳门控路径（对齐 `occlusion.frag.ts`）。

### 3.3 像素类型与采样模式

- `pixelDatatype: postHdrDatatype`（HalfFloat，线性域，与 lensflare/atmosphere 一致）。
- `pixelFormat: RGBA`。
- `sampleMode: NEAREST`（**评审修订**：对齐 lensflare `composite.frag.ts` dither 保护单源——colorTexture 透传 lensflare 输出携带的 input dithering 必须逐像素直通进 tonomap，避免 ACES 中间调放大阶梯成 banding。48-tap 径向累加本身平滑，NEAREST vs LINEAR 视觉差异极小——径向偏移天然采到不同像素，累加平均等效 blur；Cesium 集成专家核实）。
- `textureScale: 1.0`（全分辨率，第一版；半分辨率优化见 §9，待 `?profile=1` 实测）。

## 4. Shader 算法

### 4.1 太阳屏幕位置（shader 内算，复用 occlusion.frag 方法）

直接移植 `occlusion.frag.ts:114-121` 的太阳投影逻辑（已验证）：

```glsl
// czm_view / czm_projection 由 Cesium 自动注入（mat4）
uniform vec3 u_sunDirectionWC;   // state.sunDirection（单位向量，世界空间）

vec4 sunEC   = czm_view * vec4(u_sunDirectionWC, 0.0);   // w=0 剔除 view 平移 → 无穷远方向
vec4 sunClip = czm_projection * vec4(sunEC.xyz, 1.0);    // 点投影拿 clip 空间
bool sunBehindCamera = (sunClip.w <= 0.0);
vec2 sunNDC  = sunClip.xy / sunClip.w;
vec2 sunScreenPos = sunNDC * 0.5 + 0.5;                  // [0,1]² 屏幕uv
bool sunOnScreen = (!sunBehindCamera) && all(greaterThanEqual(sunScreenPos, vec2(0.0)))
                                       && all(lessThanEqual(sunScreenPos, vec2(1.0)));
```

`w=0` 处理日地距无穷远（修 cesium-clouds-atmosphere 把太阳当 1e6 米远点的视差 bug，对齐 lensflare occlusion 注释）。

### 4.2 核心：bright-pass radial blur（Mitchell GPU Gems 3 变体）

> **Mitchell 引用准确性**（图形学专家 suggestion）：Mitchell 原版（GPU Gems 3 Ch.13）循环无 bright-pass（`color += sampleTexel * weight * illumDecay`），依赖源亮度形成光束。本设计在循环内加 `max(s - threshold, 0)` bright-pass filter 是工程变体（强化光束对比度 + 实现地物切割），非原版。

```glsl
uniform sampler2D colorTexture;        // lensflare 输出（inputPreviousStage，被叠加，NEAREST 保 dither）
uniform sampler2D u_sourceTexture;     // atmosphere 输出（uniform-name 引用 'atmosphere'）
uniform sampler2D depthTexture;        // fallback 太阳门控（lensflare=false 时，复用 lensflare depth 源）
uniform vec3  u_sunDirectionWC;        // state.sunDirection（§4.1 太阳投影用）
uniform float u_intensity;             // 总强度（默认 0.08，评审修订：见 §8 量级估算）
uniform float u_density;               // 步进密度（默认 1.0）
uniform float u_decay;                 // 每采样衰减（默认 0.86，Mitchell）
uniform float u_exposure;              // 总曝光（默认 1.0）
uniform int   u_samples;               // 采样数（默认 48）
uniform float u_threshold;             // bright-pass 阈值（默认 8.0，atmosphere HDR 线性域；评审修订）

void main() {
  vec2 uv = v_textureCoordinates;

  // —— §4.1 太阳屏幕投影（sunScreenPos / sunOnScreen 计算）——

  // 太阳不可见（相机后/屏外）→ god rays=0，直接透传 lensflare 输出
  if (!sunOnScreen) {
    out_FragColor = vec4(texture(colorTexture, uv).rgb, 1.0);
    return;
  }

  // —— bright-pass radial blur（核心）——
  vec2 deltaUV = (uv - sunScreenPos) * u_density / float(u_samples);
  vec2 sampleUV = uv;
  float illumDecay = 1.0;
  vec3 accum = vec3(0.0);
  for (int i = 0; i < u_samples; ++i) {
    sampleUV -= deltaUV;                                  // 朝太阳方向步进
    // 屏边缘越界检测（图形学专家 important）：clamp-to-edge 会把越界 sample 钉在边缘亮像素列
    // 反复累加 → 屏边缘平行伪光束。越界 sample 不贡献。
    float borderFade = step(0.0, sampleUV.x) * step(sampleUV.x, 1.0)
                     * step(0.0, sampleUV.y) * step(sampleUV.y, 1.0);
    vec3 s = texture(u_sourceTexture, sampleUV).rgb;
    s = max(s - u_threshold, 0.0);                        // bright-pass：暗区不贡献
    accum += s * illumDecay * borderFade;
    illumDecay *= u_decay;
  }
  vec3 godrays = accum * u_exposure * u_intensity;

  // —— 太阳整体门控（三方共识：复用 lf_occlusion 36 点连续 visibility）——
  // godrays *= visibility（0=太阳盘全挡→无光束；1=全可见；连续值处理「半遮山脊」典型 crepuscular 形态）
#ifdef GODRAYS_USE_OCCLUSION_TEXTURE
  // 主路径（lensflare=true）：lf_occlusion 输出 .r = 1 - coverage（太阳盘 36 点可见比例）
  float visibility = texture(u_occlusionTexture, sunScreenPos).r;
#else
  // fallback（lensflare=false）：单点 depth 二值门控，阈值按 useSmoothDepth 分支
  // （对齐 occlusion.frag.ts:105-109；smooth 路径 1e-4 = depthTemporal FOG_PLANE_LOGDEPTH_EPS，legacy 1e-6 = DEPTH_EPSILON）
  float sunDepth = GODRAYS_READ_DEPTH(sunScreenPos);
  float skyAtSun = step(GODRAYS_SKY_DEPTH_THRESHOLD, sunDepth);
  float visibility = skyAtSun;
#endif
  godrays *= visibility;

  out_FragColor = vec4(texture(colorTexture, uv).rgb + godrays, 1.0);
}
```

`GODRAYS_READ_DEPTH` / `GODRAYS_SKY_DEPTH_THRESHOLD` 按 `useSmoothDepth` 由 `buildGodRaysFragmentShader` 替换为字面量（对齐 `occlusion.frag.ts` 的 `buildMainGlsl(useSmoothDepth)` 模式）：
- `useSmoothDepth=true`（HDR/temporalEmaEnabled）：`texture(depthTexture, uv).a`；阈值 `1.0 - 1e-4`（与 occlusion.frag smooth 路径 + depthTemporal `FOG_PLANE_LOGDEPTH_EPS` 单源）。
- `useSmoothDepth=false`（UNSIGNED_BYTE 兜底）：`czm_readDepth(depthTexture, uv)`；阈值 `1.0 - 1e-6`（从 `lensFlareConstants.DEPTH_EPSILON` 导入，与 occlusion.frag legacy 路径单源）。

> **Cesium 固有限制**（同 occlusion.frag §5.5 I4）：天空像素与远面地形 depthTexture 同值（≈1.0），太阳落远处 globe 边缘时单点门控可能误判为天空（不挡）。主路径用 lf_occlusion 的 36 点覆盖率已显著缓解此问题；fallback 单点路径仍有此限制，验收 §7.3 盯。

### 4.3 occlusion 两层语义（明确）

| 层 | 机制 | 覆盖视觉 |
|---|---|---|
| 逐像素地物切割 | bright-pass（`max(s - threshold, 0)`）—— 暗山脊/地表不贡献 | 光束被山脊轮廓切割（山脊暗区无光束、两侧亮区继续辐射），与 §1 目标「被前景地物切割」对齐 |
| 太阳整体门控（主路径） | `lf_occlusion` 36 点连续 visibility（`godrays *= visibility`）—— 太阳盘可见比例决定光束强度 | 太阳盘全挡→god rays=0（不穿帮）；**太阳盘部分可见（半遮山脊）→ 按比例辐射**，覆盖典型 crepuscular rays 形态（用户最期待的黄昏山脊光束） |
| 太阳整体门控（fallback） | 单点 depth 二值（`lensflare=false` 时） | 太阳中心被地物挡→god rays=0；不含部分遮挡连续性（lensflare=true 主路径才有） |

**不**做逐 sample depth mask（会削弱地平线 god rays——地平线是 god rays 最美的区域；地物切割由 bright-pass 处理已足够）。逐 sample depth mask 列为 §9 未来增强。

## 5. 组件

### 5.1 新建 `packages/cesium-core/src/cesium/godRays/`（与 lensflare 平级）

**`godRaysConstants.ts`** — 默认标定常量（评审修订后）：

```ts
export const INTENSITY_DEFAULT = 0.08   // 评审修订（原 0.6）：见 §8 量级估算，godrays 落 ACES 中间调
export const DENSITY_DEFAULT = 1.0
export const DECAY_DEFAULT = 0.86       // Mitchell GPU Gems 3
export const EXPOSURE_DEFAULT = 1.0
export const SAMPLES_DEFAULT = 48
export const THRESHOLD_DEFAULT = 8.0    // 评审修订（原 0.5）：atmosphere HDR 线性域，提取太阳附近强 inscatter，过滤一般天空（量级 10-30）与亮地表
// SKY_DEPTH_THRESHOLD 不再是单一常量（评审 important）：godRays.frag 按 useSmoothDepth 分支字面量
//   smooth 路径 1e-4（与 occlusion.frag + depthTemporal FOG_PLANE_LOGDEPTH_EPS 单源）
//   legacy 路径 1e-6（从 lensFlareConstants.DEPTH_EPSILON 导入）
```

**`godRays.frag.ts`** — shader 构建器：
- `buildGodRaysFragmentShader(options: { useSmoothDepth: boolean; useOcclusionTexture: boolean }): string`
  - `useOcclusionTexture=true`：声明 `u_occlusionTexture`，走 `#define GODRAYS_USE_OCCLUSION_TEXTURE` 主路径。
  - `useOcclusionTexture=false`：声明 `depthTexture`，走 fallback 单点 depth；`GODRAYS_READ_DEPTH` / `GODRAYS_SKY_DEPTH_THRESHOLD` 按 `useSmoothDepth` 替换字面量。
- `GODRAYS_UNIFORM_NAMES: string[]`（供接线一致性测试；`colorTexture`/`depthTexture` 白名单；`u_sourceTexture`/`u_occlusionTexture` 是 uniform-name 引用须列入）
- `buildStandaloneShaderForValidation(options): string`（补 `#version 300 es` + precision + `czm_view`/`czm_projection`/`czm_readDepth` 桩 + `out_FragColor`，对齐 `occlusion.frag.ts` validation 桩；两路径 × 两 useSmoothDepth 四组合校验）

**`createGodRaysStage.ts`** — PostProcessStage 装配：
```ts
export interface GodRaysOptions {
  intensity?: number; density?: number; decay?: number;
  exposure?: number; samples?: number; threshold?: number;
}
export interface GodRaysStageHandle { readonly godRaysStage: PostProcessStage }
export function createGodRaysStage(
  scene: Scene,
  state: AtmosphereFrameState,
  options: GodRaysOptions = {},
  depthTemporalStageName?: string,   // 复用 lensflare 模式（fallback 路径 depth 源）
  occlusionTextureName?: string      // 'lf_occlusion'（lensflare=true 主路径）；undefined 走 fallback
): GodRaysStageHandle
```
- `useSmoothDepth = !!depthTemporalStageName`；`useOcclusionTexture = !!occlusionTextureName`。
- uniforms：`u_sourceTexture: 'atmosphere'`（uniform-name string，强制依赖）；`u_occlusionTexture: occlusionTextureName`（string，主路径）；`u_sunDirectionWC: () => state.sunDirection`；控制量传值；`depthTexture` 按 `depthTemporalStageName` 覆盖（仅 fallback 路径需要）。
- `pixelDatatype: postHdrDatatype`、`sampleMode: NEAREST`、`textureScale: 1.0`。

### 5.2 `AtmosphereStage.ts` 改动

- `AtmosphereStageOptions` 加：`godRays?: boolean`（默认 true）、`godRaysIntensity?` / `godRaysDecay?` / `godRaysExposure?` / `godRaysSamples?` / `godRaysThreshold?`。
- `ResolvedAtmosphereStageOptions` 加对应 resolved 字段。
- `validateAtmosphereOptions` 补默认值（透传 `godRaysConstants`）。
- `createAtmosphereStage`：`resolved.godRays` 时 `createGodRaysStage(scene, state, {...}, temporalEmaEnabled ? 'czm_depth_temporal' : undefined, resolved.lensFlare ? 'lf_occlusion' : undefined)`，在 `lensflareStage` add 后、`tonemapStage` add 前 add（链：atmosphere → lensflare → godrays → tonemap）。
- `AtmosphereStageHandle` 加 `readonly godRaysStage?: PostProcessStage`。
- `setMode`：`godRays` 用 `enabled` 开关（对齐 lensflare，非 rebuild）。
- `destroy`：`if (godRaysStage) removeAndDestroy(godRaysStage)`。

### 5.3 `apps/demo/src/main.ts` 改动

URL 参数解析（与现有 lensflare 参数同模式）：
- `?godrays=N`（强度，0=关 → 运行时 `godRaysStage.enabled=false`）
- `?godraysDecay=N` / `?godraysExposure=N` / `?godraysSamples=N` / `?godraysThreshold=N`

## 6. URL 参数（验收）

| 参数 | 默认 | 作用 |
|---|---|---|
| `?godrays=N` | 0.08 | 总强度（0=关 god rays stage；评审修订量级） |
| `?godraysDecay=N` | 0.86 | 每采样衰减（越大光束越长） |
| `?godraysExposure=N` | 1.0 | 总曝光 |
| `?godraysSamples=N` | 48 | 采样数（性能/质量旋钮） |
| `?godraysThreshold=N` | 8.0 | bright-pass 阈值（atmosphere HDR 线性域；越高只越亮区贡献） |

验收流程（与现有 demo 一致）：相机停稳后地址栏 `#camera=...` 自动更新，复制可精确复现视角；`?godrays=0` 对比基线；`?debug=7`（atmosphere HDR false-color）辅助看量级。

## 7. 测试策略

### 7.1 单元测试（node，纯函数/结构）

- **`godRaysConstants.test.ts`**：默认值断言（INTENSITY=0.08 / DECAY=0.86 / SAMPLES=48 / THRESHOLD=8.0）。
- **`godRays.frag` 结构测试**（对齐 `features.frag.ts` 测试模式）：
  - `GODRAYS_UNIFORM_NAMES` 含 `u_sourceTexture`、`u_occlusionTexture`（主路径，uniform-name 引用强制依赖）。
  - `buildGodRaysFragmentShader({useSmoothDepth:true, useOcclusionTexture:true})` 含 `texture(u_occlusionTexture, ...)` + 不含单点 depth 门控；`useOcclusionTexture:false` 含单点 depth + `GODRAYS_READ_DEPTH`。
  - `useSmoothDepth` 分支阈值（smooth 1e-4 / legacy 1e-6）字面量正确（对齐 occlusion.frag）。
  - `borderFade` 越界检测代码存在（图形学专家 important）。
  - 太阳屏幕投影代码存在（`czm_view * vec4(u_sunDirectionWC, 0.0)`）。
- **`createGodRaysStage.test.ts`**（结构，不实例化 GL）：
  - mock `resolvePostHdrDatatype`，断言 stage uniforms 含 `u_sourceTexture: 'atmosphere'`、`u_occlusionTexture: 'lf_occlusion'`（传 occlusionTextureName 时）/ 不含（undefined 时）。
  - `depthTemporalStageName` 传入时 fallback 路径 `depthTexture` uniform = 该 name；未传时不覆盖。
- **`AtmosphereStage.test.ts`** 扩展：
  - `godRays=true`（默认）时 resolved 含 godRays 字段；`godRays=false` 时 stage 不创建。
  - 默认值断言（intensity 0.08 / threshold 8.0）。
  - `lensFlare=false` 时 createGodRaysStage 收到 `occlusionTextureName=undefined`（走 fallback）。
- **glslang 编译校验**（`godRays.compile.test.ts`，依赖 `glslangValidator`）：`buildStandaloneShaderForValidation` 四组合（`useSmoothDepth` × `useOcclusionTexture`）均编译通过。
- **量级估算单测**（纯 JS，对抗性 blocker 防回归）：断言默认参数下 god rays 量级公式 `accum ≈ (skySample - threshold) × Σdecay × intensity` 落在 ACES 中间调（godrays 叠加 atmosphere 后 ACES 输入 ∈ [5, 40]，不全饱和）。用典型天空 sample=15、太阳附近 sample=100 代入，断言天空路径 godrays < 10（中间调）、太阳附近核心允许饱和。

### 7.2 视觉门禁（`scripts/perf/capture.ts`，预期改变类）

- `?godrays=0` vs 默认：maxΔ 预期显著改变（god rays 叠加），用"无结构伪影"标准。
- 验收视角：晨昏低角度（太阳近地平线）、太阳在屏幕内、太阳半遮山脊（crepuscular 典型）、有山脊切割。
- Bug 敏感区零容忍：
  - 太阳被山完全遮挡 → god rays=0（不穿帮）。
  - **太阳屏内不白盘**（对抗性 blocker 防回归）：默认参数下天空不全白（与旧 threshold=0.5/intensity=0.6 量级误判对比）。
  - 屏边缘无平行伪光束（borderFade 防回归）。

### 7.3 手动 demo 验收（用户）

- 晨昏地平线：god rays 明显径向光束（中等强度，不全屏雾化）。
- 山脊切割：光束被山脊轮廓切割，山脊后天空继续辐射。
- **太阳半遮山脊**：光从太阳可见边缘辐射（crepuscular 典型形态，lf_occlusion 连续门控）。
- 太阳被山完全挡：god rays 消失（无穿帮）。
- 正对太阳：不白盘（量级在 ACES 中间调，与 lensflare Ghost offset 修复独立）。
- `?godrays=0` 回退无回归（与 phase2b 视觉一致）。

## 8. 风险与默认标定

### 8.1 默认标定量级估算（对抗性 + 图形学共识 blocker 修复）

旧默认（threshold=0.5, intensity=0.6）量级误判（已废）：
- atmosphere 天空 inscatter 量级 = Bruneton inscatter × `u_inscatterScale=25` × exposure 1.2 ≈ 10-30（太阳附近 100+）。
- bright-pass `max(s - 0.5, 0)` 几乎不过滤（0.5 远低于天空量级）。
- 48-tap 累加 Σ(0.86^i, i=0..47) ≈ 7.14。
- 天空路径 accum ≈ (15 − 0.5) × 7.14 ≈ 104，godrays ≈ 104 × 0.6 ≈ **62** → ACES(62) ≈ 1.0 全饱和 → **全屏白雾非光束**。

新默认（threshold=8.0, intensity=0.08）量级正确：
- bright-pass `max(s - 8.0, 0)` 过滤一般天空（10-30 → 贡献 2-22）、保留太阳附近强 inscatter（100+ → 贡献 92+）。
- 天空路径 accum ≈ (15 − 8) × 7.14 ≈ 50，godrays ≈ 50 × 0.08 ≈ **4.0**。
- 叠加 atmosphere（15）→ ACES 输入 ≈ 19 → ACES ≈ 0.8（中间偏高调，可见光束，**不全饱和**）。
- 太阳附近 accum ≈ (100 − 8) × 7.14 ≈ 657，godrays ≈ 52 → 光束核心饱和（期望的"亮核心"，只太阳附近像素，非全屏）。

结论：新默认 god rays 在 ACES 中间调形成可见光束，太阳附近核心饱和是期望效果，全屏不白。

### 8.2 风险表（评审修订后）

| 风险 | 缓解 |
|---|---|
| ~~跨 composite 引用 `'atmosphere'` 不支持~~ | Cesium 源码已核实必可行（§3.1）；T1 改 spike 确认（30-60min），无 fallback |
| ~~god rays 量级远小于 lensflare 全白~~ | **删除**（量级误判）；新默认经 §8.1 量级估算验证 |
| bright-pass 阈值/exposure 随昼夜变化（exposure 0.1-1.2 动态） | threshold 作用在 finalColor·exposure 域，昼夜 god rays 强度可能跳变；URL `?godraysThreshold=` 按场景调；或未来改相对 luminance 判定（§9） |
| 与 lensflare 强度叠加过曝 | god rays 默认 intensity 0.08（godrays 量级 ~4）+ lensflare 0.001，叠加量级平衡；URL 各自可调 |
| god rays 在太阳屏外仍跑（浪费 GPU） | shader 内 `!sunOnScreen` 早 return（透传，无累加）；§4.2 |
| 屏边缘 clamp-to-edge 伪光束 | 循环内 `borderFade` 越界检测（图形学专家 important）；§4.2 |
| 正对太阳时 god rays + lensflare 叠加全白 | 新默认量级 godrays ≈4（中间调），远小于旧误算 62；§8.1 + 手动验收 |
| 全分辨率 48 tap 性能（4K/移动端） | 第一版全分（1080p ≈10ms 桌面可接受）；半分辨率优化（§9）待 `?profile=1` 实测 |

## 9. 未来增强（非 v1）

- **半分辨率优化**（图形学专家 important，v1 暂不采纳）：god rays 是软光束，半分视觉无损，省 4× 成本。但 god rays stage `textureScale=0.5` 输出半分会破坏 tonomap NEAREST 的 dither 保护（半分 → tonomap NEAREST 最近邻上采样 → 像素化 + dither 断链）。正确实现需双 stage 拓扑：god rays half-pass（0.5，只算累加）+ 全分 additive composite（1.0，LINEAR 上采样 god rays + 叠加 lensflare 输出）。链 +1 stage。待 `?profile=1` 实测全分过贵再上。
- **逐 sample depth mask**（L2）：沿径向每个 sample 读 depth，前景地物不贡献。处理"被阳光直射的亮山坡不被当作光束源"。默认关（避免削弱地平线 god rays），`?godRaysDepthMask=1` 开。需 log-depth 天空/远山阈值标定（远山 d≈0.999，天空 d≈1.0，区分难，可能需距离反演）。
- **物理体积 march**（方案 B）：若后处理 god rays 物理感不足，新增全屏 march pass 积分解析 Mie 前向散射（HG g≈0.76）。公式参考 three-geospatial 体积云。需大幅降采样 + 时序累积。
- **god rays 色散**：径向采样 R/G/B 通道偏移（波长依赖前向散射），制造轻微彩色光束边缘。
- **相对 luminance bright-pass**：threshold 改为相对当前帧最亮 sky 值，与动态 exposure / inscatterScale 解耦（§8.2 昼夜跳变的根治）。

## 10. 实现任务分解（供 writing-plans）

预估 7-9 个 task（TDD）：
1. T1：`godRaysConstants.ts` + 测试；**早期 spike**——建占位 stage（`u_sourceTexture:'atmosphere'` + `u_occlusionTexture:'lf_occlusion'` 采红色输出），add 到 lensflare 后 tonomap 前，demo 跑通即确认跨 stage 引用可行（§3.1，Cesium 源码已证低风险）。
2. T2：`godRays.frag.ts` shader 构建器（`useSmoothDepth` × `useOcclusionTexture` 四组合）+ 结构测试 + glslang 校验。
3. T3：`createGodRaysStage.ts` 装配（含 occlusionTextureName 参数）+ 结构测试。
4. T4：`AtmosphereStage.ts` 集成（options/resolved/默认/create/setMode/destroy + lensFlare=false 时 occlusionTextureName=undefined）+ 测试。
5. T5：demo URL 参数连线。
6. T6：量级估算单测（对抗性 blocker 防回归）+ 视觉门禁参考采集（`?godrays=0` 基线 + 默认参数对比）。
7. T7：默认参数 demo 验收 + 标定调整（与用户，重点：晨昏山脊 crepuscular 形态、不白盘、屏边缘无伪光束）。
8. T8：results 文档（含 §8.1 量级估算实测验证、`?profile=1` 性能数据、go/no-go 半分辨率优化）。
