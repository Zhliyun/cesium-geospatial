# Phase 2b 设计：image-based LensFlare（含 bloom + preBlur + occlusion）

> **日期**：2026-08-04（三方评审后修订版 v2）
> **前置**：phase2a HDR 浮点链已合并 `main`（commit `1a64787`）：`atmosphere` stage 输出线性 HalfFloat（`finalColor·exposure`，承载 >1 HDR）→ `tonemap` stage（ACES+gamma+dithering→RGBA8）。两 stage 间是**线性 HDR 域**，phase2b 消费点。
> **目标**：在 `atmosphere → tonomap` 之间插入 **image-based LensFlare Composite**（threshold + preBlur + bloom mipmap pyramid + 9 ghosts + halo + 色散 + occlusion + composite），**忠实移植 three-geospatial WebGL `LensFlareEffect`**，并新增**写实 occlusion**。**硬指标：phase1 五项视觉回归零回归**。
> **参考库定位**：**three-geospatial 为主**（`LensFlareEffect.ts` + `downsampleThreshold.frag`[learnopengl 核] + `convolution.downsampling.frag`[CoD:AW 核] + `convolution.upsampling.frag`[9-tap+radius] + `lensFlareFeatures.frag` + `KawaseBlurPass`[preBlur] + `MipmapBlurPass`[bloom，来自 postprocessing 库]）；**cesium-clouds-atmosphere 为辅**（occlusion ray-sphere + depthTexture 手法）。
> **范围**：**完整版，先完整再减法**。starburst 归后续（WebGPU compute → WebGL2 改写）。
> **v2 修订依据**：三方评审（Cesium 工程 + 图形学 + 魔鬼[含第三路 Cesium 源码核查]）—— 修 2 Critical（C1 halo/preBlur 矛盾 → 忠实移植加 preBlur；C2 bloom down0 拓扑 → threshold 并入 series get(0)）+ 多 Important（sampleMode 传播机制、bloom kernel CoD:AW、upsample radius=0.85、pyramid 6 down、up→down 强制依赖、uniform-name string 字面量、occlusion 降分辨率、depth epsilon、36 点覆盖率）。

---

## 1. 背景与已验证前提

### 1.1 phase2a 现状（插入点）

`AtmosphereStage.ts` 的 `createAtmosphereStage`：`add(atmosphereStage)` → `add(tonemapStage)`。phase2b 在两 `add` 间插入 `lensflare` Composite。`postHdrDatatype`（`resolvePostHdrDatatype`，HALF_FLOAT→FLOAT→UNSIGNED_BYTE）复用。`?hdr=0` 兜底就位。

### 1.2 Cesium PostProcessStage 多 pass 能力（@cesium/engine 26.1.0 源码核实，第三路深度核查）

- **multi-input（uniform-name 引用）**：PostProcessStage 的 uniform 值为**string 字面量**（= 另一 stage 的 name）→ Cesium 绑其 outputTexture（`PostProcessStage.js:670-680` `updateUniformTextures`）。**🆕关键约束（第三路 I10）**：必须是 **string 字面量**，**不能是 function 闭包**——function uniform 不走 stage name 解析、不建依赖（`PostProcessStage.js:489-495` + `PostProcessStageTextureCache.js:58` 只识别 `typeof value === "string"`）。项目现有 atmosphere uniforms 大量用 function 闭包（`sunDirection: () => state.sunDirection`，每帧动态值），但 **uniform-name texture 引用必须 string 字面量**。
- **跨任意 composite 边界生效**：`getStageByName` 查 `collection._stageNames`，`add` 递归注册所有嵌套 stage（`PostProcessStageCollection.js:441-463`）。features 可跨 composite 引用 `lf_bloom` 内的 stage。
- **Composite 双模式**（`PostProcessStageComposite.js`）：`inputPreviousStageTexture:true`（series，链式）+ `false`（non-series，fan-out）。执行 `PostProcessStageCollection.js:734-756`：series 第 0 个拿 composite input，后续拿前驱 output；non-series 所有子 stage 拿同一 input。
- **🆠sampleMode 传播机制（第三路 C2 关键）**：sampleMode **只作用 stage 的主 colorTexture**（`PostProcessStage.js:953-955` execute：`this._colorTexture.sampler = this._sampler`）。**series 链传播 sampler**——stage i execute 时把其主 colorTexture（= stage i-1 output）sampler 设成 stage i sampleMode。**uniform-name 引用的辅助 texture 不被设 sampler**，用源 stage 写入时留下的或默认（`FramebufferManager` 默认 NEAREST，`FramebufferManager.js:171`）。
  - **推论**：bloom 全 LINEAR 靠 **series 链传播**（down/up 在同一 series composite 内，下游 execute 设上游 output = LINEAR）。**不是** stage sampleMode 直接控 uniform-name texture。
- **降分辨率 RT**：per-stage `textureScale`（`PostProcessStage.js:32,124`），自动建不同尺寸 framebuffer（`PostProcessStageTextureCache.js:289-300`）。
- **framebuffer 共享 + 依赖追踪**：
  - **non-series composite** 内第 j 个 stage**自动**依赖所有前 j-1 个（`PostProcessStageTextureCache.js:117-128` `getCompositeDependencies` `!inSeries` 双重循环）→ framebuffer 共享检查天然阻止共享（**🆡I7：non-series 内无需 uniform-name 显式建依赖**）。
  - **series composite** 只建**直接前驱**依赖（`:110-113`）。**🆕I9 关键陷阱**：bloom pyramid 内有同 textureScale 对（down3/up0=0.0625、down2/up1=0.125、down1/up2=0.25、down0/up3=0.5），它们**不是直接前驱**（up0 直接前驱是 down4，非 down3）。**若 up[i] 不 uniform-name 显式引用 down[对应级]，down[对应] 不在 up[i] 依赖 → framebuffer 共享 → up 渲染覆盖 down 输出**。→ **强制约束**：up[i] 必须 uniform-name 引用 down[对应级]。
- **czm_* 注入**（第三路亮点确认）：`ShaderSource.js:60,138-153` 按需注入 `czm_view`/`czm_projection`/`czm_inverseProjection`；PostProcessStage 自动加 LOG_DEPTH define（`PostProcessStage.js:587`），`czm_readDepth` 能正确解码 log-depth。occlusion sun 投影方案无障碍。
- **🆢clear depth 陷阱（第三路 I4）**：Cesium `Context.js:332` `_clearDepth = 1.0`，**天空像素（无几何）与远面几何在 depthTexture 同值（都=1.0，`czm_readDepth` 后≈1.0）**。太阳屏幕投影落远处 globe 边缘（接近 far 面）会被误判天空（不挡）。ray-sphere（地球背面）不覆盖此情况。

### 1.3 内建 bloom / lensflare 不复用（理由）

- `createBloomStage()`：单层 8-tap Gaussian（sigma=2，覆盖小）+ HSB ContrastBias（非 HDR luminance threshold）。做不出多级 mipmap 大光晕。→ 不复用。
- `createLensFlareStage()`：仅 4 ghost、依赖 sun position、非太空模式禁用（bug）、默认 LDR 链尾。→ 不复用（色散/halo 公式可参考）。

### 1.4 three-geospatial LensFlareEffect 第一手（移植源，v2 补全 preBlur + kernel 细分）

`LensFlareEffect.ts`（WebGL，tonemap 前线性 HDR 域，`exposure=10`、HalfFloat）。每帧 `update()`（`:145-154`）：

```
inputBuffer(HDR,full) → thresholdPass(1/2 res, learnopengl 13-tap 软阈值) → renderTarget1
                        ├─► blurPass(MipmapBlurPass, levels=8, CoD:AW down + up) → bloomBuffer
                        └─► preBlurPass(KawaseBlurPass SMALL) → renderTarget2 → featuresPass(9 ghosts+halo+色散, 采 renderTarget2) → featuresBuffer
final composite(full): outputColor = inputColor + (bloom + features) * intensity(0.005)
```

**关键（v2 修正）**：ghosts 与 halo **都采样 `renderTarget2`（preBlur 后的 threshold）**，**不**各自采 threshold/bloom。bloom 是独立路径（只进 composite 叠加，不进 features）。

- **threshold**（`downsampleThreshold.frag`，**learnopengl 核**）：13-tap 加权（center/内角 0.125、边中 0.0625、外角 0.03125，归一化），luminance 空间，软阈值 `smoothstep(thresholdLevel, thresholdLevel+range, l)`。默认 `thresholdLevel=10`、`range=1`。NaN 守护。
- **preBlur**（`KawaseBlurPass SMALL`）：轻量 Kawase 模糊 threshold 输出，软化 ghost/halo 边缘（**v2 加回**，phase2b 必须移植）。
- **bloom**（`MipmapBlurPass` levels=8，来自 **postprocessing 库**，非 three-geospatial 自有）：**手动** down/up RT 链（不依赖硬件 mipmap）。
  - **down**（`convolution.downsampling.frag`，**CoD:AW 核**）：13-tap 加权 `WEIGHT_INNER=0.125`（内角）、`WEIGHT_OUTER=0.05556`（边中 + 外角 + center）。**与 threshold learnopengl 核几何同、权重不同**（v2 修正：不可混用）。
  - **up**（`convolution.upsampling.frag`）：9-tap 加权（角 0.0625、边 0.125、中 0.25）累加成 `c`，`gl_FragColor = mix(supportBuffer, c, radius)`，**默认 `radius=0.85`**（v2 补：控制 bloom 软硬的关键旋钮，每级 85% 上一级模糊 + 15% 同级 down 锐信号）。
- **features**（`lensFlareFeatures.frag`，采 preBlur threshold）：
  - **9 ghosts**：`direction=vUv-0.5`；`suv=clamp(1-vUv+direction*offset,0,1)`；`d=clamp(length(0.5-suv)/(0.5*SQRT_2),0,1)`（**v2 补 clamp**）；衰减 `pow(1-d,3)`。offset/tint 表：
    | offset | tint | | offset | tint |
    |---|---|---|---|---|
    | -5.0 | (0.8,0.8,1.0) | | 0.7 | (0.5,1.0,0.4) |
    | -1.5 | (1.0,0.8,0.4) | | 1.0 | (0.5,0.5,0.5) |
    | -0.4 | (0.9,1.0,0.8) | | 2.5 | (1.0,1.0,0.6) |
    | -0.2 | (1.0,0.8,0.4) | | 10.0 | (0.5,0.8,1.0) |
    | -0.1 | (0.9,0.7,0.7) | | | |
    乘 `ghostAmount`（默认 0.001）。ghost 无色散（tint 模拟）。
  - **halo**：aspect-corrected 径向；`suv=fract(1-vUv+hdir*0.3)`；`cubicRingMask(d, radius=0.45, thickness=0.25)`。乘 `haloAmount`（0.001）。
  - **色散**（halo 边缘）：`offset=texelSize.x*chromaticAberration * vec3(-1,0,1)`，R/G/B 偏移采样。`chromaticAberration=10`（texel）。
- **composite**（`lensFlareEffect.frag`）：`outputColor = inputColor + (bloom + features) * 0.005`。
- **依赖**：强依赖 HDR（亮源 >1）；**无 occlusion**；不依赖硬件 mipmap。

### 1.5 cesium-clouds-atmosphere occlusion（辅参考 + 改进点）

`LensFlareBloomStage.js`：单 stage sun-direction（image-based 反面教材），occlusion = ray-sphere（地球背面）+ **单点** `czm_readDepth(depthTexture, sunUV) < 0.999999`（**🆢M5：此 0.999999 是 log 域原始值，过渡带极窄（远山≈0.99999 vs 天空 1.0 仅差 1e-5），正是其二值闪烁根因**）。phase2b 改多点面积覆盖率（§5.5）。

---

## 2. 目标与非目标

### 2.1 目标
1. **threshold**：learnopengl 13-tap 加权 + luminance 软阈值（全分）。
2. **preBlur**（v2 加回，忠实移植）：Kawase/小高斯软化 threshold（ghost/halo 输入）。
3. **bloom**：CoD:AW down + 9-tap/radius=0.85 up，6 down mipmap pyramid（threshold 并入 series get(0)）。
4. **features**：9 ghosts + halo + 色散，**都采 preBlur threshold**（逐字移植）。
5. **occlusion**（写实）：sun 投影 + ray-ellipsoid + depthTexture 36 点覆盖率 → 连续 0-1，仅乘 ghosts/halo，**降分辨率**（标量）。
6. **composite**：`atmosphere + (bloom+features)*intensity`，全分 NEAREST。
7. phase1 五项零回归。

### 2.2 非目标
starburst / 换 bloom 算法 / `scene.highDynamicRange` / 改 DUAL inscatter / 内建 bloom/lensflare / Composite 过度抽象——均不做。

---

## 3. 总体架构：stage 拓扑与 HDR 数据流（v2 重构）

**v2 关键变更**：① threshold 并入 `lf_bloom` series composite **get(0)**（修 C2，down0 series 前驱才是 threshold）；② 加 `lf_preBlur` 独立 stage（忠实移植，ghost/halo 都采它）；③ `lf_occlusion` 降分辨率 textureScale 0.0625（标量，省 depth 采样）；④ bloom 6 down（threshold + down0-4 到 1/32）+ 5 up，`NUM_BLOOM_LEVELS` 可配置。

```
atmosphere(HalfFloat 线性, textureScale 1.0)
  │
  ▼
┌─ lensflare Composite (non-series, 全程 postHdrDatatype) ───────────────────────┐
│                                                                                │
│  ┌─ lf_bloom Composite (series, sampleMode LINEAR 靠 series 链传播) ─────────┐  │
│  │  lf_threshold (get0, textureScale 1.0, sampleMode NEAREST)                 │  │
│  │    读 atmosphere(主 colorTexture=series input)；learnopengl 13-tap 软阈值   │  │
│  │  lf_down0 (get1, 0.5, LINEAR)  CoD:AW 13-tap downsample，读 threshold       │  │
│  │  lf_down1 (get2, 0.25)        读 down0                                      │  │
│  │  lf_down2 (get3, 0.125)       读 down1                                      │  │
│  │  lf_down3 (get4, 0.0625)      读 down2                                      │  │
│  │  lf_down4 (get5, 0.03125)     读 down3                                      │  │
│  │  lf_up0 (get6, 0.0625, LINEAR) 读 down4(series) + down3(uniform-name!)      │  │
│  │  lf_up1 (get7, 0.125)          读 up0 + down2(uniform-name!)                │  │
│  │  lf_up2 (get8, 0.25)           读 up1 + down1(uniform-name!)                │  │
│  │  lf_up3 (get9, 0.5)            读 up2 + down0(uniform-name!)                │  │
│  │  lf_up4 (get10, 1.0)           读 up3 + lf_threshold(uniform-name!) 全分输出 │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  lf_preBlur (textureScale 1.0, sampleMode NEAREST)                              │
│    读 lf_threshold(uniform-name 'lf_threshold')；Kawase/小高斯软化 → ghost/halo 输入 │
│                                                                                │
│  lf_occlusion (textureScale 0.0625, sampleMode NEAREST)  ← 降分辨率（标量）     │
│    sun 投影 + ray-ellipsoid + depthTexture 36 点覆盖率 → 0-1                    │
│                                                                                │
│  lf_features (textureScale 1.0, sampleMode NEAREST)                             │
│    读 lf_preBlur(uniform-name) + lf_bloom.up4(uniform-name) + lf_occlusion(uniform-name) │
│    9 ghosts + halo + 色散（都采 preBlur），× occlusion（仅 ghosts/halo）         │
│                                                                                │
│  lf_composite (textureScale 1.0, sampleMode NEAREST)                            │
│    主 colorTexture = atmosphere（NEAREST 保 input dithering）                    │
│    + lf_bloom.up4(uniform-name) + lf_features(uniform-name)                     │
│    out = atmosphere + (bloom + features) * intensity                            │
└────────────────────────────────────────────────────────────────────────────────┘
  │
  ▼
tonemap(ACES→RGBA8)
```

**stage 表**：

| stage | composite 位置 | textureScale | sampleMode | 主 colorTexture 来源 | uniform-name 引用 |
|---|---|---|---|---|---|
| `lf_threshold` | lf_bloom get0 | 1.0 | NEAREST | atmosphere（series input） | — |
| `lf_down0..4` | lf_bloom get1-5 | 0.5/0.25/0.125/0.0625/0.03125 | LINEAR | series 前驱 | — |
| `lf_up0..4` | lf_bloom get6-10 | 0.0625/0.125/0.25/0.5/1.0 | LINEAR | series 前驱 | `lf_down4/3/2/1/0` + threshold（**强制**，避同 scale 共享） |
| `lf_preBlur` | lensflare 兄弟 | 1.0 | NEAREST | atmosphere（non-series input） | `lf_threshold`（string） |
| `lf_occlusion` | lensflare 兄弟 | 0.0625 | NEAREST | atmosphere（non-series input，不用） | depthTexture（Cesium 内建）+ sun uniforms |
| `lf_features` | lensflare 兄弟 | 1.0 | NEAREST | atmosphere（non-series input，不用） | `lf_preBlur` + `lf_up4` + `lf_occlusion`（string） |
| `lf_composite` | lensflare 兄弟 | 1.0 | NEAREST | atmosphere（**用**，保 dithering） | `lf_up4` + `lf_features`（string） |

**add 顺序**（执行序，M1）：`lf_bloom`（series 内部按 get 顺序）→ `lf_preBlur` → `lf_occlusion` → `lf_features` → `lf_composite`。occlusion/preBlur/features 谁先不影响（互不依赖除 features 读它们，uniform-name 不要求执行序，只要求 add 到 collection）。

**HDR 域**：所有 stage `pixelDatatype: postHdrDatatype`（HALF_FLOAT 优先）。

---

## 4. 组件拆分与文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `lensFlare/threshold.frag.ts` | 新增 | `buildThresholdFragmentShader()`（learnopengl 13-tap 加权软阈值）+ standalone + `THRESHOLD_UNIFORM_NAMES` |
| `lensFlare/preBlur.frag.ts` | **新增（v2）** | `buildPreBlurFragmentShader()`（Kawase/小高斯软化） |
| `lensFlare/bloomDownsample.frag.ts` | 新增 | `buildBloomDownsampleFragmentShader()`（**CoD:AW** 13-tap WEIGHT_INNER=0.125/WEIGHT_OUTER=0.05556） |
| `lensFlare/bloomUpsample.frag.ts` | 新增 | `buildBloomUpsampleFragmentShader()`（9-tap 0.0625/0.125/0.25 + `mix(support,c,radius)`，radius=0.85） |
| `lensFlare/features.frag.ts` | 新增 | `buildFeaturesFragmentShader()`（9 ghosts + halo + 色散，采 preBlur，逐字移植） |
| `lensFlare/occlusion.frag.ts` | 新增 | `buildOcclusionFragmentShader()`（sun 投影 + ray-ellipsoid + depth 36 点覆盖率） |
| `lensFlare/composite.frag.ts` | 新增 | `buildCompositeFragmentShader()` |
| `lensFlare/occlusion.ts` | 新增 | `computeSunScreenUV`/`rayEllipsoidIntersect`/`generateSampleGrid36` 纯函数（node 单测） |
| `lensFlare/createLensFlareStage.ts` | 新增 | 组装 lf_bloom series composite（threshold+down+up）+ preBlur+occlusion+features+composite + 外层 non-series composite；uniforms（string 字面量引用 + function 闭包动态值） |
| `lensFlare/lensFlareConstants.ts` | **新增（v2）** | `NUM_BLOOM_LEVELS=6`（可配置，减法降 4）+ 9 ghost offset/tint 表 + halo radius/thickness + 色散 texel + depth epsilon |
| `cesium/AtmosphereStage.ts` | 改 | 插 lensflare Composite；handle 加 `lensFlareStage`；`setMode` 用 `enabled` 开关（非 rebuild） |
| `cesium/AtmosphereStageOptions` | 改 | 加 `lensFlare?`/`lensFlareIntensity?`/`lensFlareThreshold?` 等 |
| `apps/demo/src/main.ts` | 改 | `?lensflare=0`/`?lfIntensity=`/`?lfThreshold=` + debug 探针 |
| 各 `.test.ts` | 新增/改 | shader 组装 + glslang + uniform 一致性 + occlusion 纯函数 + stage 拓扑 |

**GLSL 组装模式**：TS 内联 GLSL + `buildXxxFragmentShader()` + `buildStandaloneShaderForValidation()`（补 `#version 300 es` + `czm_*`/`colorTexture`/`depthTexture`/`out_FragColor` 桩 + `luminance`/`saturate` 显式 `#define`，**v2 M4：Cesium 无 `<common>`**）。

---

## 5. 详细设计

### 5.1 threshold（`threshold.frag.ts`，lf_bloom get0）

learnopengl 13-tap **加权**（非均匀平均，v2 修正 I7）：
```glsl
// luminance/saturate 显式定义（Cesium 无 <common>）
#define luminance(c) dot(c, vec3(0.2126, 0.7152, 0.0722))
#define saturate(x) clamp(x, 0.0, 1.0)
uniform sampler2D colorTexture;   // atmosphere（series input）
uniform vec2 u_texelSize;          // 源 texture（atmosphere）的 1/w,1/h
uniform float u_thresholdLevel, u_thresholdRange;
vec3 mainThreshold(vec2 uv) {
  vec2 ts = u_texelSize;
  // learnopengl 13-tap 加权：center 0.125 + 内角(±1,±1)×4 @0.125 + 边中(±2,0)/(0,±2)×4 @0.0625 + 外角(±2,±2)×4 @0.03125，归一化
  vec3 color = texture(colorTexture, uv).rgb * 0.125;
  color += (texture(colorTexture, uv+vec2(-1,-1)*ts).rgb + texture(colorTexture, uv+vec2(1,1)*ts).rgb
          + texture(colorTexture, uv+vec2(-1,1)*ts).rgb + texture(colorTexture, uv+vec2(1,-1)*ts).rgb) * 0.125;
  color += (texture(colorTexture, uv+vec2(-2,0)*ts).rgb + texture(colorTexture, uv+vec2(2,0)*ts).rgb
          + texture(colorTexture, uv+vec2(0,-2)*ts).rgb + texture(colorTexture, uv+vec2(0,2)*ts).rgb) * 0.0625;
  color += (texture(colorTexture, uv+vec2(-2,-2)*ts).rgb + texture(colorTexture, uv+vec2(2,2)*ts).rgb
          + texture(colorTexture, uv+vec2(-2,2)*ts).rgb + texture(colorTexture, uv+vec2(2,-2)*ts).rgb) * 0.03125;
  // （以上权重和=1.0，归一化）
  float l = luminance(color);
  float scale = smoothstep(u_thresholdLevel, u_thresholdLevel + u_thresholdRange, l);
  vec3 result = color * scale;
  if (any(isnan(result))) result = vec3(0.0);   // NaN 守护
  return result;
}
```
**textureScale=1.0（全分）理由（v2 修正 M4）**：非"解 sampleMode 矛盾"，而是① ghost 经 threshold 全分更锐；② threshold 作 lf_bloom get0，down0 LINEAR 读全分 threshold 无锯齿放大；③ 全分 13-tap 作轻度低通抑制单像素热点（非"抗锯齿"，全分无下采样）。

### 5.2 bloom down（`bloomDownsample.frag.ts`，CoD:AW 核，v2 修正 I4）

**CoD:AW 权重**（非 learnopengl，**不可与 threshold 混**）：
```glsl
uniform sampler2D colorTexture;   // series 前驱（threshold 或 down[i-1]）
uniform vec2 u_texelSize;          // 源 texture 的 1/w,1/h（v2 I8：源非目标）
#define WEIGHT_INNER 0.125   // 内角(±1,±1)
#define WEIGHT_OUTER 0.05556 // 边中(±2,0)/(0,±2) + 外角(±2,±2) + center
// 13-tap CoD:AW downsample
```
6 级：threshold(get0) → down0(0.5) → down1(0.25) → down2(0.125) → down3(0.0625) → down4(0.03125)。`NUM_BLOOM_LEVELS` 可配置（减法降 4 级）。

### 5.3 bloom up（`bloomUpsample.frag.ts`，9-tap + radius，v2 修正 I5）

```glsl
uniform sampler2D colorTexture;          // series 前驱（up[i-1] 或 down4 for up0）
uniform sampler2D u_downLevel;            // 对应 down 级（uniform-name string，强制避共享）
uniform vec2 u_texelSize;
uniform float u_upsampleRadius;           // 默认 0.85
vec3 mainUp(vec2 uv) {
  vec3 c = vec3(0.0);
  // 9-tap 加权：角(±1,±1)×4 @0.0625 + 边中(±1,0)/(0,±1)×4 @0.125 + center @0.25
  c += texture(colorTexture, uv).rgb * 0.25;
  c += (texture(colorTexture, uv+vec2(-1,0)*u_texelSize).rgb + texture(colorTexture, uv+vec2(1,0)*u_texelSize).rgb
      + texture(colorTexture, uv+vec2(0,-1)*u_texelSize).rgb + texture(colorTexture, uv+vec2(0,1)*u_texelSize).rgb) * 0.125;
  c += (texture(colorTexture, uv+vec2(-1,-1)*u_texelSize).rgb + texture(colorTexture, uv+vec2(1,1)*u_texelSize).rgb
      + texture(colorTexture, uv+vec2(-1,1)*u_texelSize).rgb + texture(colorTexture, uv+vec2(1,-1)*u_texelSize).rgb) * 0.0625;
  vec3 support = texture(u_downLevel, uv).rgb;   // 同 scale down 级（锐信号）
  return mix(support, c, u_upsampleRadius);       // 85% 模糊 + 15% 锐
}
```
5 级：up0(0.0625, 读 down4+down3) → up1(0.125, up0+down2) → up2(0.25, up1+down1) → up3(0.5, up2+down0) → up4(1.0, up3+threshold)。**up4 全分输出**（features/composite 全分读）。

**🆕强制约束（I9）**：up[i] 的 `u_downLevel` 必须 uniform-name 引用 down[对应级]（string 字面量），否则同 textureScale 的 down/up 共享 framebuffer 冲刷。

### 5.4 features（`features.frag.ts`，采 preBlur，v2 修正 C1）

**v2 关键**：ghost/halo **都采 `lf_preBlur`**（忠实移植，非 v1 的 ghost 采 threshold/halo 采 bloom）。
```glsl
uniform sampler2D u_preBlurTexture;      // lf_preBlur（uniform-name string）
uniform sampler2D u_occlusionTexture;     // lf_occlusion（uniform-name string）
uniform vec2 u_texelSize;
uniform float u_ghostAmount, u_haloAmount, u_chromaticAberration;
vec2 aspect = vec2(u_texelSize.x/u_texelSize.y, 1.0);   // v2 M6：vec2 非 vec3

vec3 mainFeatures(vec2 uv) {
  vec2 direction = uv - 0.5;
  vec3 ghosts = vec3(0.0);
  for (int i = 0; i < 9; ++i) {
    vec2 suv = clamp(1.0 - uv + direction * u_ghostOffset[i], 0.0, 1.0);
    float d = clamp(length(0.5 - suv) / (0.5 * 1.41421356), 0.0, 1.0);  // v2 M5：补 clamp
    ghosts += texture(u_preBlurTexture, suv).rgb * u_ghostTint[i] * pow(1.0 - d, 3.0);
  }
  ghosts *= u_ghostAmount;
  vec2 hdir = normalize((uv - 0.5) / aspect) * aspect;
  vec2 hsuv = fract(1.0 - uv + hdir * 0.3);
  vec3 hoffset = vec3(u_texelSize.x * u_chromaticAberration) * vec3(-1.0, 0.0, 1.0);
  vec3 halo;
  halo.r = texture(u_preBlurTexture, hsuv + hdir * hoffset.r).r;
  halo.g = texture(u_preBlurTexture, hsuv + hdir * hoffset.g).g;
  halo.b = texture(u_preBlurTexture, hsuv + hdir * hoffset.b).b;
  float d = distance((uv - vec2(0.5,0.0))/aspect + vec2(0.5,0.0), vec2(0.5));
  halo *= cubicRingMask(d, 0.45, 0.25) * u_haloAmount;
  float occ = texture(u_occlusionTexture, uv).r;
  return (ghosts + halo) * occ;   // 仅 ghosts/halo 衰减；bloom 不衰减
}
```

### 5.5 occlusion（`occlusion.frag.ts` + `occlusion.ts`，v2 多处修正）

**降分辨率 textureScale=0.0625**（v2 I9/专2：occlusion 是空间常数标量，全分每像素 16 次 depth 采样 = 200 万×16 冗余；降 1/16，features NEAREST 采样低分常数图每像素同一值，等价，depth 采样降 256×）。

**36 点覆盖率**（v2 I5/专2+专3：16 点 6.25% 步进台阶，提 36 点 ~2.7% 步进；或每帧旋转抖动网格配合 tonemap dithering）。

```glsl
uniform sampler2D depthTexture;
uniform vec3 u_sunDirectionWC; uniform vec3 u_cameraPositionWC;   // czm_viewerPositionWC
uniform float u_sunAngularRadius;
uniform vec3 u_ellipsoidRadiiSquared;   // v2 M9：椭球非球（scene.globe.ellipsoid）
#define DEPTH_EPSILON 1e-6   // v2 I10：log 域 epsilon（沿用 cesium-clouds-atmosphere 实测）
// czm_view/czm_projection/czm_inverseProjection 自动注入
```

**算法**：
1. **sun 屏幕投影**（`computeSunScreenUV`）：`sunEC = czm_view * vec4(u_sunDirectionWC, 0.0)`（w=0 无穷远，修 cesium-clouds-atmosphere 1e6 视差）；`sunClip = czm_projection * vec4(sunEC.xyz, 1.0)`；NDC→UV。sun 不在屏内 → occlusion=0（flare 不画，bloom 仍画）。
2. **ray-ellipsoid（地球背面）**（`rayEllipsoidIntersect`，v2 M9 椭球）：对 WGS84 椭球求交，`tHit>0` → 背面 → 0。
3. **depth 36 点覆盖率**：sun 屏幕位置周围，`u_sunAngularRadius` 投影屏幕**圆**内（v2 专1 M3：w=0 正交投影足迹是圆，半径 = `sunAngularRadius/fov_y*viewportHeight`），36 点网格采样 `czm_readDepth(depthTexture, uv)`，`sceneDepth < 1.0 - DEPTH_EPSILON` → 被挡。被挡数/36 → 0-1。
4. `occlusion = rayEllipsoidVisible(0/1) * depthCoverageRatio(0..1)`，写 `out_FragColor.r`。

**🆢clear depth 陷阱（第三路 I4）**：天空像素与远面几何 depthTexture 同值（=1.0）。太阳落远处 globe 边缘（接近 far 面）会被误判天空（不挡）——Cesium 固有限制。spec 风险表注一句（低仰角/轨相机可能 flare 穿透远处正面地形）。

**纯函数（`occlusion.ts`）**：`computeSunScreenUV`/`rayEllipsoidIntersect`/`generateSampleGrid36`（node 单测）。

### 5.6 composite（`composite.frag.ts`）

```glsl
uniform sampler2D colorTexture;          // atmosphere（主，NEAREST 保 dithering）
uniform sampler2D u_bloomTexture;         // lf_up4（uniform-name string）
uniform sampler2D u_featuresTexture;      // lf_features（uniform-name string）
uniform float u_intensity;
vec3 mainComposite(vec2 uv) {
  vec3 atmosphere = texture(colorTexture, uv).rgb;
  vec3 bloom = texture(u_bloomTexture, uv).rgb;
  vec3 features = texture(u_featuresTexture, uv).rgb;
  return atmosphere + (bloom + features) * u_intensity;
}
```

### 5.7 sampleMode 传播机制（v2 重写，三专家共识）

**机制（第三路 C2）**：
- sampleMode **只作用 stage 的主 colorTexture**（execute 时 `colorTexture.sampler = stage.sampler`）。
- **series 链传播**：series 内 stage i execute 时把其主 colorTexture（= stage i-1 output）sampler 设成 stage i sampleMode。故 lf_bloom series 内 down/up 全 LINEAR（靠链传播，**非** stage sampleMode 直接控 uniform-name texture）。
- **uniform-name 引用的辅助 texture**：不被设 sampler，用源 stage 写入时留下的或默认（FramebufferManager 默认 NEAREST）。

**dithering 真正保护点（专1 I2）**：**仅 `lf_composite` 的主 colorTexture（atmosphere）必须 NEAREST**——input dithering 只在 atmosphere 原色上，只被 composite 直接采样。threshold/preBlur/bloom/features/occlusion 的中间结果**不含 dithering**（threshold 13-tap 平均、bloom blur、features 重影——dithering 已不在），其 sampleMode 不影响 dithering 保护。

**sampleMode 分配（v2 简化）**：
- lf_bloom series（threshold + down + up）：threshold NEAREST（读 atmosphere）；down/up LINEAR（series 链传播双线性）。**threshold 并入 get0 是 C2 修复关键**——down0 series 前驱才是 threshold，sampler 传播正确。
- lf_preBlur / lf_occlusion / lf_features / lf_composite：sampleMode NEAREST（保守，且 composite 必须 NEAREST 保 dithering）。它们的中间结果 sampleMode 无视觉影响（preBlur 是 blur 自带软化、occlusion 标量、features 重影）。

**🆢dithering 稀释路径风险（专3 I2）**：threshold 调低时 bloom 扩散 → composite 输出整体抬高 → tonemap ACES 输入抬高 → dithering 被压缩到更窄有效位 → 水波纹**可能**回归。**测试必须含水波纹重验**（不只 phase1 五项定性，threshold 实测标定后专门验水波纹，§6.3）。

### 5.8 参数标定（v2 修正 I3：实测非 ACES 线性缩放）

**v2 修正**：intensity 线性缩放（10/1.2≈8x）在 ACES 非线性下**不成立**（专家 2/3）。改**实测起点 + URL 滑**：
- **threshold**：debug=7（atmosphere `clamp(c/5,0,1)`）量太阳盘量级≈5 → `thresholdLevel` 起点 3.0、`range=1.0`。
- **intensity / ghostAmount / haloAmount**：**不线性缩放**，demo `?lfIntensity=`/`?lfGhost=`/`?lfHalo=` 滑动实测定（起点 intensity=0.01、ghost=0.05、halo=0.05，仅 order-of-magnitude）。
- **upsampleRadius**：0.85（逐字）。
- **chromaticAberration**：10.0（texel，逐字）。
- **9 ghost offset/tint + halo radius/thickness**：逐字（§1.4 表）。
- **DEPTH_EPSILON**：1e-6（log 域）。

### 5.9 集成（`AtmosphereStage.ts`，v2 修正）

**uniforms 接线**（🆕I10）：uniform-name texture 引用必须 **string 字面量**（`u_preBlurTexture: 'lf_preBlur'`）；每帧动态值用 function 闭包（`sunDirection: () => state.sunDirection`）。

```ts
const lensFlareStage = options.lensFlare
  ? createLensFlareStage(scene, state, lensFlareOptions)  // 外层 non-series Composite
  : undefined
scene.postProcessStages.add(atmosphereStage)
if (lensFlareStage) scene.postProcessStages.add(lensFlareStage)
scene.postProcessStages.add(tonomapStage)
```

**lensflare on/off（v2 M1 专1）**：用 `lensFlareStage.enabled = true/false`（`PostProcessStageComposite.enabled` setter 一键设所有子 stage），**非** setMode rebuild 15 子 stage。`?lensflare=0` → `enabled=false`（stage 仍 add，透传）。`AtmosphereStageHandle` 加 `lensFlareStage?`。

### 5.10 demo 接线（`main.ts`）

`?lensflare=0`（enabled=false）/`?lfIntensity=`/`?lfThreshold=`/`?lfGhost=`/`?lfHalo=`。debug 探针 `?debug=8..12`（threshold/bloom/preBlur/occlusion/composite 逐项隔离，CLAUDE.md 调试方法论）。

---

## 6. 测试策略

### 6.1 单测
threshold（learnopengl 加权 + smoothstep + NaN）/preBlur/bloom down（CoD:AW 权重）/bloom up（9-tap + radius mix）/features（9 ghost offset/tint + halo ringMask + 色散 + clamp(d) + occlusion 乘）/occlusion（`computeSunScreenUV`/`rayEllipsoidIntersect`/`generateSampleGrid36` + depth epsilon + 多点覆盖率）/composite/createLensFlareStage（lf_bloom series get0=threshold + up→down uniform-name 强制依赖 + textureScale/sampleMode/pixelDatatype 每 stage + non-series 外层 + string 字面量 uniform）/AtmosphereStage（三 stage + enabled 开关 + lensFlare=false）。

### 6.2 glslang 编译（全组合）
各 `buildStandaloneShaderForValidation()`（补 `#version 300 es` + `czm_*`/`colorTexture`/`depthTexture`/`out_FragColor` + `luminance`/`saturate` 桩）经 glslangValidator。防回归：phase2a atmosphere+tonomap 仍过。

### 6.3 视觉回归（硬指标）

**phase1 五项零回归** + **🆢水波纹专项重验**（threshold 实测标定后，俯视 nadir 远景专门验同心色带——dithering 稀释路径 I2）。

**lensflare 验收**：
| # | 项 | 验证 |
|---|---|---|
| L1 | ghosts | 9 重影沿太阳-屏幕中心轴，tint 正确，preBlur 软化（非块状） |
| L2 | halo | 太阳周围紧环（采 preBlur，非宽 bloom），色散 RGB |
| L3 | bloom | 太阳/亮源辉光，6 级 mipmap 渐变（接近 three-geospatial 宽度） |
| L4 | occlusion | 太阳被山挡 ghosts/halo 平滑衰减（36 点无台阶）；地球背面 flare 消失；**bloom 周围溢光验收**（image-based 固有，不违和） |
| L5 | 兜底 | `?hdr=0` threshold 失效近透传不崩 |

### 6.4 成功标准
单测全过 + phase1 五项零回归 + 水波纹专项 + L1-L5 + `?lensflare=0` 回退。

---

## 7. 风险与应对（v2 更新）

| # | 风险 | 严重度 | 对策 | 验证 |
|---|---|---|---|---|
| R1 | **phase1 水波纹回归**（dithering 稀释路径） | **高** | composite 主 colorTexture NEAREST；threshold 实测标定后**水波纹专项重验**；URL 调参 | §6.3 水波纹专项 |
| R2 | **C2 sampleMode 传播**（bloom LINEAR 靠 series 链） | **高** | threshold 并入 lf_bloom get0（非外层兄弟）；down/up 同 series；plan 阶段实测 sampler 传播 | createLensFlareStage.test + 浏览器 |
| R3 | **up→down 同 scale framebuffer 共享冲刷** | **高** | up[i] 必须 uniform-name string 引用 down[对应级]（强制约束） | createLensFlareStage.test 断言依赖 |
| R4 | **uniform-name 必须 string 字面量** | 中 | createLensFlareStage uniforms 接线：texture 引用 string、动态值 function；单测断言 typeof | createLensFlareStage.test |
| R5 | **性能**（~15 stage + bloom 6 级） | 中 | occlusion 降 1/16（标量）；`NUM_BLOOM_LEVELS` 可配置；减法降级 | 性能记录 |
| R6 | **clear depth=1.0 与远面同值**（远处 globe 边缘误判天空） | 中 | DEPTH_EPSILON 1e-6；spec 注明固有限制（低仰角/轨相机 flare 可能穿透远处正面地形） | §6.3 L4 |
| R7 | **参数标定**（ACES 非线性，不可线性缩放） | 中 | 实测起点 + URL 滑；threshold debug=7 量级 | §5.8 |
| R8 | **occlusion 36 点台阶** | 低 | 36 点（2.7% 步进）或抖动网格 | §6.3 L4 |
| R9 | **bloom 周围溢光**（image-based 固有） | 低 | L4 验收盯；接受（物理合理） | §6.3 L4 |
| R10 | **`?hdr=0` threshold 失效** | 低 | lensflare 近透传不崩 | §6.3 L5 |

---

## 8. 与后续衔接

- **starburst**：WebGPU compute → WebGL2 anamorphic streak 改写，插 features/composite 间。features/composite 为 starburst 预留 uniform 输入点（不过度设计）。
- **bloom 减法**：`NUM_BLOOM_LEVELS` 6→4；砍 halo 色散；occlusion 降更多；换内建 bloom（轻弱）。
- **其他 HDR 后处理**（SSR/GodRay）：复用「user stage 间线性 HDR + uniform-name 多输入」模式。

---

## 9. 工程约定

中文文档/注释；WebGL2/GLSL ES 3.00；`sampler3D` LUT（atmosphere）；`dFdx/dFdy`；glslangValidator；`packages/cesium-core/src/cesium/lensFlare/` 子目录；vitest + glslang；ion token 不入库；three-geospatial 为主。

---

## 10. 已定死事项（v2，三方评审后）

- **C2 修复**：threshold 并入 `lf_bloom` series composite **get(0)**（非外层 non-series 兄弟）；bloom 全 LINEAR 靠 series 链 sampler 传播。
- **C1 修复**：忠实移植——`lf_preBlur` 独立 stage，ghost/halo **都采 preBlur threshold**（非 v1 的 ghost 采 threshold/halo 采 bloom）。
- **sampleMode**：仅 `lf_composite` 主 colorTexture（atmosphere）NEAREST 是 dithering 硬约束；其余中间结果 sampleMode 无 dithering 影响。bloom down/up LINEAR（series 链）。
- **up→down 强制依赖**：up[i] 必须 uniform-name string 引用 down[对应级]（避同 scale framebuffer 共享冲刷）。
- **uniform-name string 字面量**：texture 引用必须 string（非 function）。
- **bloom kernel**：threshold=learnopengl 加权（0.125/0.0625/0.03125）；bloom down=CoD:AW（0.125/0.05556）；bloom up=9-tap（0.0625/0.125/0.25）+ mix(radius=0.85)。
- **bloom 级数**：6 down（threshold+down0-4 到 1/32）+ 5 up，`NUM_BLOOM_LEVELS=6` 可配置。
- **occlusion**：textureScale 0.0625（标量降分）；36 点覆盖率；depth epsilon 1e-6（log 域）；ray-ellipsoid（WGS84）；仅乘 ghosts/halo。
- **9 ghost offset/tint + halo 0.45/0.25 + 色散 texel 10**：逐字 three-geospatial。
- **lensflare on/off**：`stage.enabled` 开关（非 setMode rebuild）。
- **参数标定**：实测非线性缩放（intensity/ghost/halo URL 滑）。
- **starburst 不做**（归后续）。
- **内建 bloom/lensflare 不复用**。
- **stage 名 `lf_` 前缀全局唯一**。
- **水波纹专项重验**（threshold 标定后）。
