# phase2c 丁达尔效应（God Rays）设计

> 状态：设计中（brainstorming → 3 轮专家评审通过 with changes → 待用户审 → writing-plans）
> 日期：2026-08-12
> 评审：3 轮 3 专家 Workflow（Cesium 集成 / 图形学 / 对抗性），全部 approve_with_changes，3 轮共识已并入
> v1 决策（r3 后用户拍板）：**相对 luminance bright-pass**（threshold = ratio × 当前帧 maxSkyLuminance）根治固定 threshold 在动态 exposure 下的晨昏失效 + 量级 6× 跳变
> 关联：phase2a HDR 管线、phase2b LensFlare（`docs/superpowers/specs/2026-08-04-phase2b-lens-flare-design.md`）

## 1. 背景与目标

用户反馈："现在大气散射效果很不错，但缺少丁达尔效应。"

丁达尔效应（Tyndall effect / crepuscular rays / god rays）：阳光在大气气溶胶中侧向散射形成的可见光柱，晨昏低角度、光束从太阳辐射、被前景地物切割为其典型形态。

**目标**：在现有后处理链中加入 god rays，使阳光在大气中形成可见径向光束，被前景地物（山脊）切割，太阳盘可见比例决定光束强度（含部分遮挡的典型 crepuscular 形态），且**晨昏低角度（用户主用例）可见**。

**非目标**：
- 体积云参与的光束（耶稣光）—— 本项目当前无体积云。
- 物理正确的体积 ray march —— 性能代价过高，列为未来 phase。

## 2. 方案选择

three-geospatial 参考库**无 god rays 实现**（grep 确认：只有体积云与 Bruneton 大气）。本特性为新功能设计。

三方案对比（brainstorming 已确认选 A）：

| | 方案 A：后处理 radial blur（选定） | 方案 B：物理体积 march | 方案 C：现有 LUT 增强前向散射 |
|---|---|---|---|
| 做法 | radial blur 采样 atmosphere 输出 | 全屏 march pass 积分 Mie 前向散射 | aerialPerspective 加 HG 增强项 |
| 成本 | 1 composite（maxLum + godrays），可控 | 每像素 32-64 步，极贵 | 零新 pass |
| 风险 | 低，契合现有管线 | 性能、降采样 artifact、标定一致性 | 破坏 DUAL inscatter 标定 |

**用户确认的关键参数**：
- 默认强度：**中等**（明显但不夸张）。
- occlusion 策略：**bright-pass + depth**（细化为：bright-pass 逐像素切割 + lf_occlusion 连续太阳门控，见 §4.3）。
- **bright-pass 模式**：相对 luminance（r3 后用户决策，根治晨昏失效）。

## 3. 架构

### 3.1 链位置与采样源解耦

god rays 与 lensflare 都希望采"干净的 atmosphere 输出"。god rays composite 通过 **uniform-name 引用 atmosphere stage 输出**作为采样源（与 lensflare `u_bloomTexture: 'lf_up4'` 同模式），与 lensflare 互不采样：

```
depthTemporal → atmosphere → lensflare → godrays-composite → tonomap
                                                  │
                                  gr_maxLum: u_sourceTexture='atmosphere'（降采样 max luminance）
                                  gr_godrays: colorTexture=lensflare 输出（composite 输入）
                                              u_sourceTexture='atmosphere'（radial blur 源）
                                              u_maxLumTexture='gr_maxLum'（相对 threshold 参考）
                                              u_occlusionTexture='lf_occlusion'（太阳门控）
                                  输出 = lensflare + godrays
```

- god rays 采 atmosphere（`u_sourceTexture`）→ 无镜头伪光污染。
- lensflare 在 god rays 前，采 atmosphere → 不采 god rays → 不放大光束。
- god rays 太阳门控复用 lensflare `lf_occlusion`。
- 两者各自独立叠加到链输出。

> **跨 stage 引用可行性（3 轮评审 Cesium 源码核实）**：`PostProcessStageCollection._stageNames` 是 `add()` 递归填充的全局 flat 字典（composite 内子 stage 也注册），`getStageByName` 全局查找不区分顶层/composite 内；`PostProcessStageTextureCache.getStageDependencies` 对 string uniform 经 getStageByName 解析注册依赖。本仓库 lensflare `occlusion.depthTexture='czm_depth_temporal'`（composite 内→顶层）是生产先例；god rays 顶层→顶层 `'atmosphere'`、顶层→composite 内 `'lf_occlusion'`、composite 内 `gr_godrays→gr_maxLum` 均等价可行。**无 fallback**（r2 删除原 threshold=3.0 死路 fallback；T1 spike 早期确认）。

### 3.2 max-luminance pass（gr_maxLum，相对 threshold 参考）

**目的**：求"太阳附近天空的局部 max luminance"作为相对 threshold 的动态参考，让 bright-pass 跟随场景最亮区自适应（正午 maxLum 大、晨昏 maxLum 小，threshold 同比变化），根治固定 threshold 在动态 exposure 下的晨昏失效（r3 adversarial+graphics 共识 important）。

- `gr_maxLum` stage：`textureScale = 0.0625`（1/16 降采样，对齐 lf_occlusion 降采样理念），采 atmosphere（`u_sourceTexture='atmosphere'`，uniform-name），每像素取局部 4×4 max luminance，输出 `.r`（标量 max luminance，线性域）。
- `gr_godrays` 读 `u_maxLumTexture='gr_maxLum'`（uniform-name）在 `sunScreenPos` 处 → 太阳附近局部 max luminance（场景最亮区，通常太阳附近天空）。
- `gr_maxLum` 与 `gr_godrays` 组成 `godrays` composite（`inputPreviousStageTexture=false`，non-series 兄弟，对齐 lensflare composite 模式）。

### 3.3 depth 源（复用 lensflare 模式，仅 fallback 太阳门控用）

god rays 主路径太阳门控用 lf_occlusion（不读 depth）。仅 `lensflare=false` fallback 路径读 depth：
- `depthTemporalStageName` 传入（`temporalEmaEnabled=true` 时 `'czm_depth_temporal'`），shader 读 `texture(depthTexture, uv).a`（smoothDepth）。
- 未传（UNSIGNED_BYTE 兜底）：Cesium 内建 scene globe depth，shader 用 `czm_readDepth`。

### 3.4 像素类型与采样模式

- `pixelDatatype: postHdrDatatype`（HalfFloat，线性域）。
- `pixelFormat: RGBA`。
- `gr_maxLum` `sampleMode: NEAREST`（max 运算，NEAREST 取原始值）。
- `gr_godrays` `sampleMode: NEAREST`（对齐 lensflare composite.frag dither 保护——colorTexture 透传 lensflare 输出携带的 input dithering 必须逐像素直通进 tonomap；48-tap 径向累加本身平滑，NEAREST vs LINEAR 视觉差异极小，r2 Cesium 专家核实）。
- `gr_maxLum textureScale: 0.0625`；`gr_godrays textureScale: 1.0`（全分辨率，半分辨率优化见 §9）。

## 4. Shader 算法

### 4.1 太阳屏幕位置（shader 内算，复用 occlusion.frag 方法）

移植 `occlusion.frag.ts:114-121`（已验证）：

```glsl
uniform vec3 u_sunDirectionWC;   // state.sunDirection（单位向量，世界空间）
vec4 sunEC   = czm_view * vec4(u_sunDirectionWC, 0.0);   // w=0 无穷远方向
vec4 sunClip = czm_projection * vec4(sunEC.xyz, 1.0);
bool sunBehindCamera = (sunClip.w <= 0.0);
vec2 sunNDC  = sunClip.xy / sunClip.w;
vec2 sunScreenPos = sunNDC * 0.5 + 0.5;
bool sunOnScreen = (!sunBehindCamera) && all(greaterThanEqual(sunScreenPos, vec2(0.0)))
                                       && all(lessThanEqual(sunScreenPos, vec2(1.0)));
```

### 4.2 核心：相对 luminance bright-pass radial blur

> **Mitchell 引用**（图形学 suggestion）：Mitchell 原版（GPU Gems 3 Ch.13）循环无 bright-pass。本设计循环内加 bright-pass filter 是工程变体（强化光束对比度 + 实现地物切割）。
>
> **相对 luminance**（r3 用户决策）：threshold = `u_thresholdRatio × maxLum`（maxLum 来自 gr_maxLum，跟随场景最亮区）。对齐 lensflare `threshold.frag` 的 luminance soft smoothstep（r3 图形 suggestion：避免 RGB hard max 在彩色天空出颜色硬边）。

```glsl
// gr_godrays uniforms（u_sourceTexture/u_maxLumTexture/u_occlusionTexture 是 uniform-name 引用；
//   depthTexture 仅 fallback 路径由 buildGodRaysFragmentShader 按 useOcclusionTexture 条件生成，
//   主路径不声明 depthTexture——见 §5.1，对齐 r2 cesium suggestion）
uniform sampler2D colorTexture;        // lensflare 输出（composite 输入，被叠加，NEAREST 保 dither）
uniform sampler2D u_sourceTexture;     // atmosphere 输出（uniform-name 引用 'atmosphere'）
uniform sampler2D u_maxLumTexture;     // gr_maxLum 输出（uniform-name 引用 'gr_maxLum'）
uniform sampler2D u_occlusionTexture;  // lf_occlusion（uniform-name 引用，主路径太阳门控）
uniform vec3  u_sunDirectionWC;
uniform float u_intensity;             // 总强度（默认 0.08，待 T1 实测微调）
uniform float u_density;               // 步进密度（默认 1.0）
uniform float u_decay;                 // 每采样衰减（默认 0.86，Mitchell）
uniform float u_exposure;              // 总曝光（默认 1.0）
uniform int   u_samples;               // 采样数（默认 48）
uniform float u_thresholdRatio;        // 相对 maxLum 的 bright-pass 比例（默认 0.5）

void main() {
  vec2 uv = v_textureCoordinates;
  // §4.1 太阳屏幕投影（sunScreenPos / sunOnScreen）
  if (!sunOnScreen) { out_FragColor = vec4(texture(colorTexture, uv).rgb, 1.0); return; }

  // 相对 threshold：跟随太阳附近最亮区（gr_maxLum 在 sunScreenPos 处的局部 max）
  float maxLum = texture(u_maxLumTexture, sunScreenPos).r;
  float threshold = u_thresholdRatio * maxLum;
  float range = threshold * 0.5;       // soft knee 宽度（对齐 lensflare threshold.frag）

  // bright-pass radial blur（Mitchell 变体）
  vec2 deltaUV = (uv - sunScreenPos) * u_density / float(u_samples);
  vec2 sampleUV = uv;
  float illumDecay = 1.0;
  vec3 accum = vec3(0.0);
  for (int i = 0; i < u_samples; ++i) {
    sampleUV -= deltaUV;
    float borderFade = step(0.0, sampleUV.x) * step(sampleUV.x, 1.0)
                     * step(0.0, sampleUV.y) * step(sampleUV.y, 1.0);  // r1 图形 important：屏边缘越界检测
    vec3 s = texture(u_sourceTexture, sampleUV).rgb;
    float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
    float scale = smoothstep(threshold, threshold + range, lum);       // luminance soft bright-pass
    accum += s * scale * illumDecay * borderFade;
    illumDecay *= u_decay;
  }
  vec3 godrays = accum * u_exposure * u_intensity;

  // 太阳整体门控（r1 三方共识：lf_occlusion 36 点连续 visibility）
#ifdef GODRAYS_USE_OCCLUSION_TEXTURE
  float visibility = texture(u_occlusionTexture, sunScreenPos).r;      // 主路径
#else
  float sunDepth = GODRAYS_READ_DEPTH(sunScreenPos);                   // fallback 单点 depth
  float visibility = step(GODRAYS_SKY_DEPTH_THRESHOLD, sunDepth);
#endif
  godrays *= visibility;

  out_FragColor = vec4(texture(colorTexture, uv).rgb + godrays, 1.0);
}
```

`GODRAYS_READ_DEPTH` / `GODRAYS_SKY_DEPTH_THRESHOLD` 按 `useSmoothDepth` 由 `buildGodRaysFragmentShader` 替换字面量（对齐 `occlusion.frag.ts:105-109`）：smooth 路径 `texture(depthTexture, uv).a` + 阈值 `1.0 - 1e-4`；legacy 路径 `czm_readDepth` + 阈值 `1.0 - 1e-6`（从 `lensFlareConstants.DEPTH_EPSILON` 导入）。

### 4.3 occlusion 两层语义 + god rays 可见性条件

**god rays 可见性 = 源亮（sample luminance > threshold）∩ 目标暗（当前像素 ACES 不饱和，线性 <8）**（r3 对抗 suggestion：区分源侧/目标侧，§8.1 讨论目标侧、§8.2 讨论源侧）。

| 层 | 机制 | 覆盖视觉 |
|---|---|---|
| 逐像素地物切割 | bright-pass luminance soft —— 暗山脊/地表 scale≈0 不贡献 | 光束被山脊轮廓切割（山脊暗区无光束、两侧亮区继续辐射） |
| 太阳整体门控（主路径） | `lf_occlusion` 36 点连续 visibility（`godrays *= visibility`） | 太阳盘全挡→god rays=0；部分可见→按比例辐射（crepuscular 典型形态） |
| 太阳整体门控（fallback） | 单点 depth 二值（`lensflare=false`） | 太阳中心被挡→god rays=0；无部分遮挡连续性 |

**不做逐 sample depth mask**（削弱地平线 god rays）。列为 §9 未来。

## 5. 组件

### 5.1 新建 `packages/cesium-core/src/cesium/godRays/`

**`godRaysConstants.ts`** — 默认标定常量（r3 后）：

```ts
export const INTENSITY_DEFAULT = 0.08      // 待 T1 ?debug=7 实测微调（r3：相对 luminance 下 god rays ∝ maxLum，intensity 控暗区叠加不饱和）
export const DENSITY_DEFAULT = 1.0
export const DECAY_DEFAULT = 0.86          // Mitchell GPU Gems 3
export const EXPOSURE_DEFAULT = 1.0
export const SAMPLES_DEFAULT = 48
export const THRESHOLD_RATIO_DEFAULT = 0.5 // 相对 maxLum 比例（r3 用户决策：替代固定 threshold，根治晨昏失效）
export const MAXLUM_TEXTURE_SCALE = 0.0625 // gr_maxLum 降采样（对齐 lf_occlusion）
export const MAXLUM_KERNEL = 4             // gr_maxLum 局部 max kernel（4×4）
// SKY_DEPTH_THRESHOLD 不再是单一常量（r1 cesium important）：godRays.frag 按 useSmoothDepth 分支字面量
//   smooth 1e-4（occlusion.frag + depthTemporal FOG_PLANE_LOGDEPTH_EPS 单源）
//   legacy 1e-6（lensFlareConstants.DEPTH_EPSILON 导入）
```

> **r3 文档残留修复**：原 THRESHOLD_DEFAULT 注释写「过滤一般天空（量级 10-30）」是 r1 旧量级（已被 §8.1 推翻）。r3 改为相对 ratio（threshold = 0.5 × maxLum），不再用绝对量级描述。lensflare `THRESHOLD_LEVEL_DEFAULT=3.0` 已通过用户验收（ghost 可见），证明 atmosphere 亮区 luminance >3.0（r3 图形交叉参考）—— 这是 maxLum 的实测下界参考。

**`godRaysMaxLum.frag.ts`** — gr_maxLum shader 构建器：
- `buildGodRaysMaxLumFragmentShader(): string`：采 `u_sourceTexture`（atmosphere），每像素 `MAXLUM_KERNEL×MAXLUM_KERNEL` 局部 max luminance，输出 `vec4(maxLum, 0, 0, 1)`。
- `GODRAYS_MAXLUM_UNIFORM_NAMES: string[]`（`colorTexture` 白名单；`u_sourceTexture` uniform-name 引用）。
- `buildStandaloneShaderForValidation()`（glslang 校验）。

**`godRays.frag.ts`** — gr_godrays shader 构建器：
- `buildGodRaysFragmentShader(options: { useSmoothDepth: boolean; useOcclusionTexture: boolean }): string`
- `GODRAYS_UNIFORM_NAMES: string[]`（`u_sourceTexture`/`u_maxLumTexture`/`u_occlusionTexture` uniform-name 引用须列入；`colorTexture` 白名单；`depthTexture` 仅 fallback）
- `buildStandaloneShaderForValidation(options)`（四组合 `useSmoothDepth × useOcclusionTexture` 校验）

**`createGodRaysStage.ts`** — PostProcessStage composite 装配：
```ts
export interface GodRaysOptions {
  intensity?: number; density?: number; decay?: number;
  exposure?: number; samples?: number; thresholdRatio?: number;
}
export interface GodRaysStageHandle {
  readonly godRaysComposite: PostProcessStageComposite  // gr_maxLum + gr_godrays
  readonly maxLumStage: PostProcessStage
  readonly godRaysStage: PostProcessStage
}
export function createGodRaysStage(
  scene: Scene, state: AtmosphereFrameState, options: GodRaysOptions = {},
  depthTemporalStageName?: string, occlusionTextureName?: string
): GodRaysStageHandle
```
- `gr_maxLum`：`u_sourceTexture: 'atmosphere'`，`textureScale: 0.0625`，`sampleMode: NEAREST`。
- `gr_godrays`：`u_sourceTexture: 'atmosphere'`、`u_maxLumTexture: 'gr_maxLum'`、`u_occlusionTexture: occlusionTextureName`（string 或缺省）、`u_sunDirectionWC: () => state.sunDirection`；`textureScale: 1.0`，`sampleMode: NEAREST`。
- 外层 `godrays` composite（`inputPreviousStageTexture: false`，`stages: [gr_maxLum, gr_godrays]`）。

### 5.2 `AtmosphereStage.ts` 改动

- `AtmosphereStageOptions` 加：`godRays?: boolean`（默认 true）、`godRaysIntensity?` / `godRaysDecay?` / `godRaysExposure?` / `godRaysSamples?` / `godRaysThresholdRatio?`。
- `ResolvedAtmosphereStageOptions` 加 resolved 字段；`validateAtmosphereOptions` 补默认值。
- `createAtmosphereStage`：`resolved.godRays` 时 `createGodRaysStage(scene, state, {...}, temporalEmaEnabled ? 'czm_depth_temporal' : undefined, resolved.lensFlare ? 'lf_occlusion' : undefined)`，在 `lensflareStage` add 后、`tonemapStage` add 前 add `godRaysComposite`。
- `AtmosphereStageHandle` 加 `readonly godRaysComposite?: PostProcessStageComposite`。
- `setMode`：v1 不实现 godRays 分支（dead code 沿用 lensflare 历史决策，r3 cesium suggestion）；setMode 启用时需同时处理 `godRays.enabled` + `gr_maxLum/gr_godrays.u_sourceTexture='atmosphere'` 依赖（re-add atmosphere 后 `_stageNames` 重新注册，依赖自动恢复）。spec 明确此 v1 边界。
- `destroy`：`if (godRaysComposite) removeAndDestroy(godRaysComposite)`。
- **约束文档化**（r2 cesium+图形 suggestion）：god rays 主路径要求 `lensflareComposite.enabled=true`；运行时禁用 lensflare 必须同时 `godRays.enabled=false` 或 rebuild 走 fallback（否则 gr_godrays 读 lf_occlusion stale visibility，太阳快速移动时光束强度滞后——非随机垃圾，r3 cesium 措辞修正）。

### 5.3 `apps/demo/src/main.ts` 改动

URL 参数：`?godrays=N`（强度，0=关）、`?godraysDecay=N` / `?godraysExposure=N` / `?godraysSamples=N` / `?godraysRatio=N`（相对 threshold 比例）。

## 6. URL 参数（验收）

| 参数 | 默认 | 作用 |
|---|---|---|
| `?godrays=N` | 0.08 | 总强度（0=关） |
| `?godraysDecay=N` | 0.86 | 每采样衰减 |
| `?godraysExposure=N` | 1.0 | 总曝光 |
| `?godraysSamples=N` | 48 | 采样数 |
| `?godraysRatio=N` | 0.5 | 相对 maxLum 的 bright-pass 比例（r3：替代固定 threshold） |

验收：`#camera=` 复现视角；`?godrays=0` 基线；`?debug=7`（atmosphere false-color）辅助看量级（注意 /5.0 上限，见 §8.2）。

## 7. 测试策略

### 7.1 单元测试

- **`godRaysConstants.test.ts`**：默认值（INTENSITY=0.08 / THRESHOLD_RATIO=0.5 / SAMPLES=48 / DECAY=0.86 / MAXLUM_TEXTURE_SCALE=0.0625）。
- **`godRaysMaxLum.frag` 结构测试**：`u_sourceTexture` 在 GODRAYS_MAXLUM_UNIFORM_NAMES；`buildGodRaysMaxLumFragmentShader` 含 4×4 max kernel；glslang 校验。
- **`godRays.frag` 结构测试**：`u_sourceTexture`/`u_maxLumTexture`/`u_occlusionTexture` 在 GODRAYS_UNIFORM_NAMES；`useOcclusionTexture` 双路径切换正确；`useSmoothDepth` 分支阈值（smooth 1e-4 / legacy 1e-6）字面量；borderFade 越界检测代码存在；相对 threshold（`u_thresholdRatio * maxLum`）代码存在；太阳屏幕投影代码存在。glslang 四组合校验。
- **`createGodRaysStage.test.ts`**：stage uniforms 含 `u_sourceTexture:'atmosphere'`、`u_maxLumTexture:'gr_maxLum'`、`u_occlusionTexture:'lf_occlusion'`（传时）/ 不含（undefined 时）；composite `inputPreviousStageTexture=false`、`stages=[gr_maxLum, gr_godrays]`。
- **`AtmosphereStage.test.ts`**：`godRays=true` 默认创建 composite；`godRays=false` 不创建；`lensFlare=false` 时 `occlusionTextureName=undefined`。
- **量级回归锚点单测**（r2 对抗 important，r3 改良）：把 T1 实测的 atmosphere HDR 量级（远天空 `SKY_FAR_HDR` / 近太阳天空 `SKY_NEAR_SUN_HDR`，?debug=7 实测，见 §8.2 debug=7 ceiling 应对）作为常量，断言默认参数下 god rays 量级（相对 luminance：`maxLum × (1-ratio) × Σdecay × intensity`）叠加暗区后 ACES 输入落在可见区间。**不用假设值证明假设值**（r2 self-validating 循环测试已废）。

### 7.2 视觉门禁

- `?godrays=0` vs 默认：maxΔ 预期显著改变，"无结构伪影"标准。
- 验收视角：正午山脊阴影、**晨昏低角度（用户主用例，相对 luminance 下应可见）**、太阳半遮山脊、太阳近屏边（borderFade）。
- Bug 敏感区零容忍：太阳被完全挡→god rays=0；太阳屏内不白盘；屏边缘无平行伪光束；**晨昏 god rays 可见**（相对 luminance 根治验证）。

### 7.3 手动 demo 验收（用户）

- 正午山脊阴影/暗区：god rays 光束照亮暗区。
- **晨昏地平线**：god rays 明显径向光束（相对 luminance 下 maxLum 自适应，晨昏不失效——r3 核心验收点）。
- 山脊切割：光束被山脊轮廓切割。
- 太阳半遮山脊：光从可见边缘辐射（crepuscular 典型）。
- 太阳被山完全挡：god rays 消失。
- 正对太阳：不白盘。
- `?godrays=0` 回退无回归。

## 8. 风险与默认标定

### 8.1 默认标定（相对 luminance，待 T1 实测微调）

> **r3 修订**：固定 threshold 在动态 exposure 下有结构性缺陷（晨昏失效 + 量级 6× 跳变，graphics 数值验证）。r3 用户决策改为**相对 luminance**（threshold = ratio × maxLum），threshold 跟随场景最亮区自适应——正午 maxLum 大、晨昏 maxLum 小，threshold 同比变化，根治晨昏失效。原 §8.1 的 ACES(19)≈0.8 纸面推导（r2 发现错误，ACES(8) 即饱和）已废。

**god rays 可见性条件**（r3 对抗 suggestion）：源亮（sample lum > threshold）∩ 目标暗（当前像素 ACES 不饱和，线性 <8）。god rays 只在暗区可见是 ACES+HDR 固有限制（亮天空已饱和，god rays 叠加无变化）；god rays 照亮暗区（晨昏地平线下方、山脊阴影、近地表暗区）。

**相对 luminance 量级框架**：
- atmosphere 输出 = Bruneton inscatter × `u_inscatterScale=25` × 动态 exposure。实际量级须 `?debug=7` 实测（见 §8.2 ceiling）。
- **交叉参考**（r3 图形 important）：lensflare `THRESHOLD_LEVEL_DEFAULT=3.0` 已通过用户验收（ghost 可见），证明 atmosphere 亮区 luminance >3.0 → maxLum 实测下界 ≥3.0；"远天空 likely 1-3"只适用远天空暗区，太阳附近亮区 >3.0。
- god rays 量级（路径全亮区上界）= `maxLum × (1 - ratio) × Σdecay × intensity` = `maxLum × 0.5 × 7.14 × 0.08 ≈ maxLum × 0.286`。实际路径穿过暗区（soft scale 衰减），远小于上界。
  - 正午 maxLum~10 → god rays 上界 ≈2.9，叠加暗区 0.5 → ACES 输入 ≈3.4 → ACES(3.4)≈0.95（亮光束）。
  - 晨昏 maxLum~3 → god rays 上界 ≈0.86，叠加暗区 0.5 → ACES 输入 ≈1.36 → ACES(1.36)≈0.85（可见光束）。
  - **相对 luminance 让 god rays 随场景最亮区自适应，正午强、晨昏弱但都可见（ACES 中间调）** —— 根治固定 threshold 晨昏失效。

**默认 intensity=0.08 / thresholdRatio=0.5 是待 T1 实测微调的起点**（相对 luminance 下更稳定，但 maxLum 跨场景变化大时 intensity 可能需场景分档，列 §9 v1.1）。T1 实测三档量级（远天空/近太阳/太阳盘，正午+晨昏）后微调 intensity（控制暗区叠加不饱和）。

### 8.2 风险表（r3 后）

| 风险 | 缓解 |
|---|---|
| ~~固定 threshold 晨昏失效~~ | **r3 根治**：相对 luminance（threshold=ratio×maxLum）跟随场景最亮区，晨昏 maxLum 低→threshold 同比低，god rays 可见 |
| ~~固定 threshold 量级 6× 跳变~~ | **r3 根治**：相对 luminance 让 god rays ∝ maxLum，随场景自适应 |
| **debug=7 的 /5.0 上限让 >5 量级不可读**（r3 三方共识） | T1 实测时：(1) `?lensflare=0` 关 lensflare（否则 debug=7 读 lensflare 输出污染近太阳量级）；(2) 若近太阳/太阳盘全白（>5），临时改 `tonemap.frag.ts:48` 除数（如 `/20.0`）扩大归一化上限，或加 `debug=8` 用 `clamp(log(c+1)/log(50),0,1)` log 归一化覆盖 0-50 动态范围。spec §10 T1 文档化此 fallback |
| bright-pass 阈值/exposure 随昼夜变化 | 相对 luminance 已解耦（threshold ∝ maxLum，maxLum 含 exposure 效应）；剩余 intensity 跨场景分档列 §9 v1.1 |
| 与 lensflare 强度叠加过曝 | god rays intensity 0.08 + lensflare 0.001，量级平衡；URL 各自可调 |
| god rays 在太阳屏外仍跑 | shader `!sunOnScreen` 早 return |
| 屏边缘 clamp-to-edge 伪光束 | 循环内 borderFade（r1 图形 important） |
| 运行时禁用 lensflare 与 god rays 主路径耦合（r2 suggestion） | §5.2 文档化约束：禁用 lensflare 必须同时 godRays.enabled=false 或 rebuild 走 fallback（否则读 lf_occlusion stale visibility，r3 措辞修正：非随机垃圾） |
| 全分辨率 48 tap 性能 | 第一版全分（1080p ≈10ms 桌面可接受）；半分辨率优化（§9）待 `?profile=1` 实测 |
| **borderFade 硬 step 太阳近屏边断口**（r3 对抗 suggestion） | v1 保留硬 step（越界多为末段低 illumDecay sample，损失小）；若 T7 验收发现断裂，改 smoothstep 软衰减（§9） |
| **bright-pass luminance soft vs lensflare 一致性**（r3 图形 suggestion） | 已对齐 lensflare `smoothstep(level, level+range, lum)`（§4.2），避免 RGB hard max 彩色硬边 |

## 9. 未来增强（非 v1）

- **半分辨率优化**（r1 图形 important，v1 暂不采纳）：god rays 软光束半分视觉无损，省 4×。但 `gr_godrays textureScale=0.5` 破坏 tonomap NEAREST dither 保护（需双 stage 拓扑：half god rays + 全分 additive composite）。待 `?profile=1` 实测过贵再上。
- **逐 sample depth mask**（L2）：前景地物不贡献，处理"亮山坡不被当光束源"。默认关（避免削弱地平线）。
- **物理体积 march**（方案 B）：若后处理物理感不足，新增全屏 march pass 积分 Mie 前向散射。
- **intensity 场景分档**（r3）：相对 luminance 下 maxLum 跨场景变化大时，intensity 可能需按正午/晨昏分档或进一步相对化。
- **god rays 色散**：径向 R/G/B 偏移。
- **borderFade smoothstep 软衰减**（r3 对抗 suggestion）：若硬 step 在太阳近屏边断裂，改基于到屏边距离的 smoothstep。

## 10. 实现任务分解（供 writing-plans）

预估 9-11 个 task（TDD）：
1. T1：`godRaysConstants.ts` + 测试；**早期 spike**——建占位 composite（gr_maxLum + gr_godrays，`u_sourceTexture:'atmosphere'` + `u_occlusionTexture:'lf_occlusion'` + `u_maxLumTexture:'gr_maxLum'` 采红色输出），add 到 lensflare 后 tonomap 前，demo 跑通即确认跨 stage 引用可行（§3.1，Cesium 源码已证低风险）；**`?debug=7` 实测 atmosphere HDR 量级**（远天空/近太阳/太阳盘三档，正午+晨昏两视角，`?lensflare=0` 避污染，>5 区间用临时除数 /log probe，见 §8.2），回填 §8.1 intensity 默认 + §7.1 回归锚点 SKY_FAR_HDR/SKY_NEAR_SUN_HDR 常量。
2. T2：`godRaysMaxLum.frag.ts`（4×4 局部 max）+ 结构测试 + glslang 校验。
3. T3：`godRays.frag.ts`（相对 luminance bright-pass + 四组合 useSmoothDepth×useOcclusionTexture）+ 结构测试 + glslang 校验。
4. T4：`createGodRaysStage.ts`（composite 装配 gr_maxLum + gr_godrays）+ 结构测试。
5. T5：`AtmosphereStage.ts` 集成（options/resolved/默认/create/setMode 边界/destroy + lensFlare=false fallback + lensflare 禁用约束）+ 测试。
6. T6：demo URL 参数连线。
7. T7：量级回归锚点单测（T1 实测值）+ 视觉门禁参考采集（`?godrays=0` 基线 + 默认对比 + 晨昏复核）。
8. T8：默认参数 demo 验收 + 标定调整（重点：晨昏 god rays 可见、太阳半遮山脊、不白盘、屏边缘无伪光束）。
9. T9：results 文档（§8.1 量级实测验证、`?profile=1` 性能、borderFade/bright-pass 验收、go/no-go 半分辨率）。
