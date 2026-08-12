# phase2c 丁达尔效应（God Rays）设计

> 状态：设计中（brainstorming → 待用户审 → writing-plans）
> 日期：2026-08-12
> 关联：phase2a HDR 管线、phase2b LensFlare（`docs/superpowers/specs/2026-08-04-phase2b-lens-flare-design.md`）

## 1. 背景与目标

用户反馈："现在大气散射效果很不错，但缺少丁达尔效应。"

丁达尔效应（Tyndall effect / crepuscular rays / god rays）：阳光在大气气溶胶中侧向散射形成的可见光柱，晨昏低角度、光束从太阳辐射、被地物切割为其典型形态。

**目标**：在现有后处理链中加入 god rays，使阳光在大气中形成可见径向光束，且被前景地物（山脊）切割、太阳被完全遮挡时光束消失。

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
- occlusion 策略：**bright-pass + depth**。

## 3. 架构

### 3.1 链位置与采样源解耦

god rays 与 lensflare 都希望采"干净的 atmosphere 输出"。若串行（god rays 采 lensflare 输出）→ 光束混入 ghost/halo 镜头伪光；若 lensflare 采 god rays 输出 → bloom 把光束当亮区放大 → 耦合过曝。

**解法**：god rays stage 通过 **uniform-name 引用 atmosphere stage 输出**作为采样源（跨 stage 引用，与 lensflare 的 `u_bloomTexture: 'lf_up4'` 同模式），与 lensflare 互不采样：

```
depthTemporal → atmosphere → lensflare → godrays → tonemap
                     ↑                       ↑
                     └─── u_sourceTexture = 'atmosphere'（uniform-name 引用）
                          colorTexture = lensflare 输出（inputPreviousStageTexture=true）
                          输出 = lensflare + godrays
```

- god rays 采 atmosphere（`u_sourceTexture`）→ 无镜头伪光污染。
- lensflare 在 god rays 前，采 atmosphere（其 composite 输入）→ 不采 god rays → 不放大光束。
- 两者各自独立叠加到链输出。

> **跨 composite 引用风险**：god rays 引用更早的 `atmosphere` stage（跨 lensflare composite）。Cesium `getStageByName` 全局查找应支持（lensflare 内部已验证同 composite 引用；跨 composite 引用为本特性新增验证点）。
> **Fallback**（T1 验证若不支持）：god rays 改放到 atmosphere 紧后（`inputPreviousStageTexture=true` 采 atmosphere），输出 atmosphere+godrays 传给 lensflare；靠 lensflare `threshold=3.0`（默认高）排除 god rays 光束（光束亮度远低于太阳盘，不触发 soft knee）。优先用主方案。

### 3.2 depth 源（复用 lensflare 模式）

god rays 的太阳门控需读 depth。复用 lensflare occlusion 的 depth 接线：

- `createGodRaysStage(scene, state, options, depthTemporalStageName?)`：`depthTemporalStageName` 传入（`temporalEmaEnabled=true` 时 `'czm_depth_temporal'`），god rays 的 `depthTexture` uniform 指向该 stage（uniform-name string 跨 stage 引用），shader 读 `texture(depthTexture, uv).a`（smoothDepth，raw log-depth EMA）。
- 未传（UNSIGNED_BYTE 兜底）：不覆盖 `depthTexture`（Cesium 内建 scene globe depth），shader 用 `czm_readDepth`。

`buildGodRaysFragmentShader({ useSmoothDepth })` 按 `useSmoothDepth` 切换 depth 读取（对齐 `occlusion.frag.ts`）。

### 3.3 像素类型与采样模式

- `pixelDatatype: postHdrDatatype`（HalfFloat，线性域，与 lensflare/atmosphere 一致）。
- `pixelFormat: RGBA`。
- `sampleMode: LINEAR`（god rays 是径向 blur，采样位置非整数像素，LINEAR 平滑；input dithering 在 48-sample 累加中平均，无 banding 风险——banding 是单点采样风险，blur 累加无此问题）。
- `textureScale: 1.0`（全分辨率，第一版；半分辨率优化见 §9）。

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

### 4.2 核心：bright-pass radial blur（Mitchell GPU Gems 3）

```glsl
uniform sampler2D colorTexture;        // lensflare 输出（inputPreviousStage，被叠加）
uniform sampler2D u_sourceTexture;     // atmosphere 输出（uniform-name 引用 'atmosphere'）
uniform sampler2D depthTexture;        // 太阳门控（复用 lensflare depth 源）
uniform vec3  u_sunDirectionWC;        // state.sunDirection（单位向量，世界空间；§4.1 太阳投影用）
uniform float u_intensity;             // 总强度（默认 0.6，中等）
uniform float u_density;               // 步进密度（默认 1.0）
uniform float u_decay;                 // 每采样衰减（默认 0.86，Mitchell）
uniform float u_exposure;              // 总曝光（默认 1.0）
uniform int   u_samples;               // 采样数（默认 48）
uniform float u_threshold;             // bright-pass 阈值（默认 0.5 线性）

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
    vec3 s = texture(u_sourceTexture, sampleUV).rgb;
    s = max(s - u_threshold, 0.0);                        // bright-pass：暗区不贡献
    accum += s * illumDecay;
    illumDecay *= u_decay;
  }
  vec3 godrays = accum * u_exposure * u_intensity;

  // —— depth 太阳门控 ——
  // 采样太阳位置 depth：太阳被前景地物挡 → god rays 整体消失。
  // （bright-pass 已处理逐像素地物切割；此处仅整体门控，不逐 sample mask——
  //   逐 sample mask 会削弱地平线 god rays，而地平线是 god rays 最美的区域。）
  float sunDepth = readDepth(sunScreenPos);               // useSmoothDepth 切换
  float skyAtSun = step(SKY_DEPTH_THRESHOLD, sunDepth);   // 太阳处是天空(1)/地物(0)
  godrays *= skyAtSun;

  out_FragColor = vec4(texture(colorTexture, uv).rgb + godrays, 1.0);
}
```

`SKY_DEPTH_THRESHOLD = 1.0 - 1e-4`（log-depth farPlane 阈值，与 `occlusion.frag.ts` farPlane 判定单源一致）：太阳处 depth ≥ 0.9999 = 天空/远面（太阳可见）；< 0.9999 = 几何存在（太阳被地物挡）。

`readDepth(uv)` 按 `useSmoothDepth` 切换：
- `true`（HDR/temporalEmaEnabled）：`texture(depthTexture, uv).a`（depthTemporal smoothDepth，raw log-depth EMA）。
- `false`（UNSIGNED_BYTE 兜底）：`czm_readDepth(depthTexture, uv)`（scene globe depth，log-depth 解码）。

### 4.3 occlusion 两层语义（明确）

| 层 | 机制 | 覆盖视觉 |
|---|---|---|
| 逐像素地物切割 | bright-pass（`max(s - threshold, 0)`）—— 暗山脊/地表不贡献 | 光束被山脊轮廓切割、山脊后亮天空继续 → "山脊漏光" |
| 太阳整体门控 | depth 采样太阳位置（`skyAtSun`）—— 太阳被地物完全挡 → god rays=0 | 太阳在山后/地平线下 → 无穿帮光束 |

**不**做逐 sample depth mask（会削弱地平线 god rays，见 §4.2 注释）。

## 5. 组件

### 5.1 新建 `packages/cesium-core/src/cesium/godRays/`（与 lensflare 平级）

**`godRaysConstants.ts`** — 默认标定常量：

```ts
export const INTENSITY_DEFAULT = 0.6    // 中等强度（用户确认）
export const DENSITY_DEFAULT = 1.0
export const DECAY_DEFAULT = 0.86       // Mitchell GPU Gems 3
export const EXPOSURE_DEFAULT = 1.0
export const SAMPLES_DEFAULT = 48
export const THRESHOLD_DEFAULT = 0.5    // bright-pass 线性域阈值
export const SKY_DEPTH_THRESHOLD = 1.0 - 1e-4  // log-depth farPlane（与 occlusion.frag 单源）
```

**`godRays.frag.ts`** — shader 构建器：
- `buildGodRaysFragmentShader(options: { useSmoothDepth: boolean }): string`
- `GODRAYS_UNIFORM_NAMES: string[]`（供接线一致性测试，`colorTexture`/`depthTexture` 白名单，`u_sourceTexture` 是 uniform-name 引用须列入）
- `buildStandaloneShaderForValidation(options): string`（补 `#version 300 es` + precision + `czm_view`/`czm_projection`/`czm_readDepth` 桩 + `out_FragColor`，对齐 `occlusion.frag.ts` validation 桩）

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
  depthTemporalStageName?: string  // 复用 lensflare 模式
): GodRaysStageHandle
```
- uniforms：`u_sourceTexture: 'atmosphere'`（uniform-name string，强制依赖）；`u_sunDirectionWC: () => state.sunDirection`；控制量传值；`depthTexture` 按 `depthTemporalStageName` 覆盖。
- `pixelDatatype: postHdrDatatype`、`sampleMode: LINEAR`、`textureScale: 1.0`。

### 5.2 `AtmosphereStage.ts` 改动

- `AtmosphereStageOptions` 加：`godRays?: boolean`（默认 true）、`godRaysIntensity?` / `godRaysDecay?` / `godRaysExposure?` / `godRaysSamples?` / `godRaysThreshold?`。
- `ResolvedAtmosphereStageOptions` 加对应 resolved 字段。
- `validateAtmosphereOptions` 补默认值（透传 `godRaysConstants`）。
- `createAtmosphereStage`：`resolved.godRays` 时 `createGodRaysStage(scene, state, {...}, temporalEmaEnabled ? 'czm_depth_temporal' : undefined)`，在 `lensflareStage` add 后、`tonemapStage` add 前 add（链：atmosphere → lensflare → godrays → tonemap）。
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
| `?godrays=N` | 0.6 | 总强度（0=关 god rays stage） |
| `?godraysDecay=N` | 0.86 | 每采样衰减（越大光束越长） |
| `?godraysExposure=N` | 1.0 | 总曝光 |
| `?godraysSamples=N` | 48 | 采样数（性能/质量旋钮） |
| `?godraysThreshold=N` | 0.5 | bright-pass 阈值（越高只越亮区贡献） |

验收流程（与现有 demo 一致）：相机停稳后地址栏 `#camera=...` 自动更新，复制可精确复现视角；`?godrays=0` 对比基线。

## 7. 测试策略

### 7.1 单元测试（node，纯函数/结构）

- **`godRaysConstants.test.ts`**：默认值断言（INTENSITY=0.6 / DECAY=0.86 / SAMPLES=48 / THRESHOLD=0.5 / SKY_DEPTH_THRESHOLD=1-1e-4）。
- **`godRays.frag` 结构测试**（对齐 `features.frag.ts` 测试模式）：
  - `GODRAYS_UNIFORM_NAMES` 含 `u_sourceTexture`（uniform-name 引用强制依赖）。
  - `buildGodRaysFragmentShader({useSmoothDepth:true})` 含 `texture(depthTexture, ...).a`；`useSmoothDepth:false` 含 `czm_readDepth`。
  - 太阳屏幕投影代码存在（`czm_view * vec4(u_sunDirectionWC, 0.0)`）。
- **`createGodRaysStage.test.ts`**（结构，不实例化 GL）：
  - mock `resolvePostHdrDatatype`，断言 stage uniforms 含 `u_sourceTexture: 'atmosphere'`（string）。
  - `depthTemporalStageName` 传入时 `depthTexture` uniform = 该 name；未传时不覆盖。
- **`AtmosphereStage.test.ts`** 扩展：
  - `godRays=true`（默认）时 resolved 含 godRays 字段；`godRays=false` 时 stage 不创建。
  - 默认值断言（intensity 0.6 等）。
- **glslang 编译校验**（`godRays.compile.test.ts`，依赖 `glslangValidator`）：`buildStandaloneShaderForValidation({useSmoothDepth:true/false})` 两分支均编译通过。

### 7.2 视觉门禁（`scripts/perf/capture.ts`，预期改变类）

- `?godrays=0` vs 默认：maxΔ 预期显著改变（god rays 叠加），用"无结构伪影"标准（SSIM 不适用，god rays 是叠加光束）。
- 验收视角：晨昏低角度（太阳近地平线）、太阳在屏幕内、有山脊遮挡。
- Bug 敏感区零容忍：太阳被完全遮挡（`?camera=` 太阳在山后）→ god rays=0（不穿帮）。

### 7.3 手动 demo 验收（用户）

- 晨昏地平线：god rays 明显径向光束。
- 山脊切割：光束被山脊轮廓切割，山脊后天空继续辐射。
- 太阳被山完全挡：god rays 消失（无穿帮）。
- 正对太阳：不白盘（与 lensflare Ghost offset 修复独立，god rays 不引入新全白）。
- `?godrays=0` 回退无回归（与 phase2b 视觉一致）。

## 8. 风险与默认标定

| 风险 | 缓解 |
|---|---|
| 跨 composite uniform-name 引用 `'atmosphere'` 不支持 | T1 验证；fallback：god rays 放 atmosphere 后 + lensflare threshold 3.0 排除（§3.1） |
| bright-pass 阈值标定（太低→地表高光成光束；太高→god rays 太弱） | 默认 0.5 线性域，URL `?godraysThreshold=` 调；demo 验收 |
| 与 lensflare 强度叠加过曝（两者都是太阳伪光） | god rays 默认 0.6 + lensflare 0.001（已调透明），叠加量级平衡；URL 各自可调 |
| god rays 在太阳屏外仍跑（浪费 GPU） | shader 内 `!sunOnScreen` 早 return（透传，无累加）；§4.2 |
| `sampleUV` 越界（太阳在屏边缘） | Cesium texture 采样默认 clamp-to-edge，径向采样自然衰减；不需显式 clamp |
| 正对太阳时 god rays + lensflare 叠加是否全白 | god rays bright-pass 阈值 0.5 + intensity 0.6，累加量级远小于 lensflare 全白奇点（已修）；手动验收 |
| 全分辨率 48 tap 性能 | 第一版全分；若 `?profile=1` 实测过贵，半分辨率优化（§9） |

**默认标定**（用户确认"中等"）：
- `intensity=0.6`：全天多数视角可见明显光束，不夸张。
- `threshold=0.5`：排除中暗区，保留天空/太阳/亮大气。
- `decay=0.86`：Mitchell 标定，光束长度适中。
- `samples=48`：质量/性能平衡。

## 9. 未来增强（非 v1）

- **半分辨率优化**：god rays pass `textureScale=0.5` + 一个 upsample stage（LINEAR 上采样），省 4× 成本。god rays 是软光束，半分辨率视觉无损。若 `?profile=1` 实测过贵再上。
- **逐 sample depth mask**（L2）：沿径向每个 sample 读 depth，前景地物不贡献。处理"被阳光直射的亮山坡不被当作光束源"。默认关（避免削弱地平线 god rays），`?godRaysDepthMask=1` 开。需 log-depth 天空/远山阈值标定（远山 d≈0.999，天空 d≈1.0，区分难）。
- **物理体积 march**（方案 B）：若后处理 god rays 物理感不足，新增全屏 march pass 积分解析 Mie 前向散射（HG g≈0.76）。公式参考 three-geospatial 体积云。需大幅降采样 + 时序累积。
- **god rays 色散**：径向采样 R/G/B 通道偏移（波长依赖前向散射），制造轻微彩色光束边缘。

## 10. 实现任务分解（供 writing-plans）

预估 6-8 个 task（TDD）：
1. T1：`godRaysConstants.ts` + 测试；跨 composite uniform-name 引用可行性验证（写最小 spike stage 引用 'atmosphere'，demo 跑通或定 fallback）。
2. T2：`godRays.frag.ts` shader 构建器 + 结构测试 + glslang 校验。
3. T3：`createGodRaysStage.ts` 装配 + 结构测试。
4. T4：`AtmosphereStage.ts` 集成（options/resolved/默认/create/setMode/destroy）+ 测试。
5. T5：demo URL 参数连线。
6. T6：视觉门禁参考采集（`?godrays=0` 基线）+ 验收视角标定。
7. T7：默认参数 demo 验收 + 标定调整（与用户）。
8. T8：results 文档。
