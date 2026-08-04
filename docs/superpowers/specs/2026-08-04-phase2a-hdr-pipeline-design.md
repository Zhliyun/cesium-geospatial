# Phase 2a 设计：HDR 浮点后处理链基建

> **日期**：2026-08-04
> **前置**：Phase 1 已合并到 `main`（commit `faa2e6c`，B 路径 DUAL inscatter：水波纹 + 转动闪动 + 地面过曝均已闭环）。
> **目标**：把 phase1「单 stage 内联 ACES」重构为「大气 stage 输出线性 HDR（HalfFloat）+ 链尾独立 ToneMappingStage（ACES→RGBA8）」的两 stage 浮点链，为 phase2b（image-based LensFlare，three-geospatial）提供线性域消费点。**硬指标：视觉与 phase1 不可区分**（水波纹/转动闪动/山体不透明零回归）。
> **参考库定位（phase2 总纲）**：**three-geospatial 为主**（`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`，技术/算法主参考）；**cesium-clouds-atmosphere 为辅**（`/Users/zhangliyun/Documents/Ayvods/Web3D/cesium-clouds-atmosphere`，仅当 three-geospatial 方案移植到 Cesium 遇到障碍时参考其已适配方案）。
> **范围**：phase2 完整后期链拆为两步——**phase2a（本 spec）：HDR 链基建**；**phase2b（待 phase2a 验证后另起 spec）：image-based LensFlare**。

---

## 1. 背景与已验证前提

### 1.1 phase1 现状（要改动的基线）

`packages/cesium-core/src/cesium/aerialPerspective.frag.ts` 的 main 末端：
```glsl
out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
```
其中 `tonemapDisplay` = ACES filmic + gamma 1/2.2 + display triangular dithering（±1.5 LSB）。整条大气渲染在**单个 `PostProcessStage`** 内完成，输出 RGBA8（默认 `pixelDatatype`），ACES 内联在末端。input dithering 在 main 入口对 `originalColor` 加噪（打散 globe RGBA8 banding，避免 ACES 放大成水波纹）。

### 1.2 为何要 HDR 浮点链（核实结论）

phase2b 要做 three-geospatial 风格的 image-based LensFlare。一手源码核实（`three-geospatial/packages/effects/src/LensFlareEffect.ts` + `lensFlareFeatures.frag`）确认：

- three-geospatial 的 LensFlare 是**统一 image-based 流水线**：`inputBuffer → DownsampleThreshold(阈值) → MipmapBlur(8级) → features(ghosts+halo) → combine`。`lensFlareFeatures.frag` 的 ghosts/halo 采样的是 threshold+blur 后的 RT，**不是独立于 threshold**。
- `thresholdLevel` 默认 **10**，在 HDR 域筛 radiance>1 的真亮像素（太阳/高光）。LDR 域（0-1）：threshold=10 筛不出任何东西；调低会把云/雪/白墙全当眩光源（失真）。
- **结论**：image-based LensFlare 的 threshold 需在 HDR 域筛 >1 的真亮像素，要求一个**承载 >1 HDR 的线性域中间 RT** 供其采样。phase1 是单 stage 内联 tonemap（合成 + ACES 在同一 shader），没有这样的中间 RT。**注意：phase1 并不"丢失 HDR"**——其 ACES 输入是 shader float（`finalColor*exposure`，>1 完整保留），RGBA8 量化发生在 ACES+gamma 写 display **之后**；phase2a 的价值不是"把 HDR 从 RGBA8 救回"（phase1 ACES 前已保住），而是**提供「两 stage 之间的线性域消费点」**——把大气 stage 末端改为输出线性 HalfFloat + 拆出链尾 ToneMappingStage，LensFlare 即可插在「大气之后、tonemap 之前」的 HalfFloat 线性域。**该价值在 phase2a 阶段不显现**（HalfFloat 经 tonemap ACES 压回 0-1 显示，视觉与 phase1 等价），是服务 phase2b（及未来 bloom/SSR 等 HDR 后处理）的基建投入。

### 1.3 Cesium PostProcessStage 浮点支持（已核实可行）

`cesium-clouds-atmosphere/.../AtmospherePostProcess.js:828-834` 实证 `PostProcessStage` 构造选项接受 `pixelFormat` + `pixelDatatype`：
```js
new Cesium.PostProcessStage({ name, fragmentShader, uniforms,
  pixelFormat: Cesium.PixelFormat.RGBA,
  pixelDatatype: postHdrPixelDatatype,  // HALF_FLOAT 优先，FLOAT 次选，UNSIGNED_BYTE 兜底
})
```
本项目 `node_modules` 即 `@cesium/engine@26.1.0`（与 cesium-clouds-atmosphere 同款），用法可直接参考。HalfFloat 渲染能力用 `context.halfFloatingPointTexture && context.colorBufferHalfFloat` 检测。

### 1.4 关键事实：地表输入仍 LDR + dithering 归属 + 能力检测语义

即使大气 stage 升 HalfFloat，它读的 `originalColor` 仍是 globe 的 RGBA8（地表已量化）。HalfFloat 中间 RT 保住的是**两 stage 之间** inscatter/天空的 HDR（供 phase2b LensFlare threshold），而非 phase1 没保住的（phase1 ACES 前 float 已保住）。地表部分的 banding 源头（RGBA8 1/256 量化）不变 → **input dithering 仍必须留在大气 stage**（见 §5.2），且经 HalfFloat RT 中转时必须 **NEAREST 采样**（见 §5.3、风险 R3）。

**HalfFloat 能力检测字段语义**（Cesium 26.1.0 核实）：`context.halfFloatingPointTexture`（WebGL2 下恒 true，管 RGBA16F 纹理采样）+ `context.colorBufferHalfFloat`（WebGL2 下实际检测 `EXT_color_buffer_float`，该扩展同时覆盖 RGBA16F + RGBA32F 的 color-renderability）。两者配合覆盖「采样 + 渲染」两端，检测完备（存在「支持纹理 half-float 采样但不支持 color-renderable」的旧移动 GPU，检测能正确降级）。

---

## 2. 目标与非目标

### 2.1 目标
1. 大气 stage 末端不再 tonemap，输出线性 HDR（`finalColor * exposure`，HalfFloat）。
2. 新增独立链尾 `ToneMappingStage`（ACES + gamma + display dithering → RGBA8），与 phase1 的 `tonemapDisplay` 视觉等价。
3. HalfFloat 能力检测 + 三级降级（HALF_FLOAT → FLOAT → UNSIGNED_BYTE），兜底不崩。
4. 视觉与 phase1 不可区分（五项回归硬指标，见 §7）。
5. 输出在 HalfFloat 线性域可被后续 stage 消费（为 phase2b LensFlare 铺路，可验证）。

### 2.2 非目标（YAGNI，phase2a 不做）
- **不做 LensFlare / bloom / 任何新效果**（phase2b）。
- **不开 `scene.highDynamicRange`**（机制，评审 I4）：Cesium 内建 tonemapping 在用户 PostProcessStage **之前**执行（`PostProcessStageCollection.execute` 先跑内建 tonemapping，再跑 `activeStages`）。开 `scene.highDynamicRange=true` 会让 globe 渲染到 HDR float colorbuffer → Cesium 内建 tonemapping 先执行输出 RGBA8 LDR → atmosphere 的 `colorTexture` 收到**已被 tonemap 过的 LDR** → 链尾 tonemap 再 ACES 一次 → **双重 tonemap + 色彩失真**。本 spec 的 tonemap 由链尾独立 stage 承担，故必须保持 `scene.highDynamicRange=false`，仅靠 PostProcessStage 的 `pixelDatatype: HALF_FLOAT` 取得中间 RT 的 HDR 精度。
- **不做 PostProcessStageComposite 封装**（用两个独立 stage，对齐 cesium-clouds-atmosphere；封装留给后续按需）。
- **不改 DUAL inscatter 主流程**（`lookingAtGround` 分类、`baseInscatter`/`foreInscatter`/mask 全部不动——这是 phase1 闪动修复的成果，phase2a 只动末端 tonemap 位置）。
- **不换 tonemap 算法**（保持 ACES；AGX 等是视觉偏好，非本阶段必需）。

---

## 3. 总体架构：数据流对比

```
phase1（当前）：
  globe(RGBA8) → [atmosphere stage: 合成 + input dithering + 内联 ACES + display dithering] → display(RGBA8)

phase2a（目标）：
  globe(RGBA8) → [atmosphere stage: 合成 + input dithering, 输出线性 finalColor·exposure]
                     ↓ HalfFloat（inscatter/天空 HDR 保真；originalColor 部分 LDR）
                 [tonemap stage: debug>0 透传 / 否则 ACES + gamma + display dithering]
                     ↓ RGBA8
                 display
                 ↑ phase2b LensFlare 将插在 atmosphere 与 tonemap 之间（线性域）
```

**链顺序与纹理传递**（Cesium 26.1.0 核实，纠正评审 M1）：`scene.postProcessStages.add(atmosphereStage)` 先、`add(tonemapStage)` 后。`PostProcessStageCollection.execute` 按 `_stages` 数组顺序串行执行，第 i 个独立 stage 的 `colorTexture` 自动取第 i-1 个 stage 的 outputTexture（`getOutputTexture(activeStages[i-1])`）——**无需** `forceFinalRenderToTexture`（不存在此选项）或 `inputPreviousStageTexture`（那是 `PostProcessStageComposite` 专属概念，独立 stage 不用）。framebuffer 按 `pixelDatatype` 区分复用池（`PostProcessStageTextureCache`），atmosphere(HALF_FLOAT) 与 tonemap(UNSIGNED_BYTE) 不混用。

**参考库定位澄清**（评审 I3）：cesium-clouds-atmosphere 的 `AtmospherePostProcess` 是**单 stage 内联 tonemap**（与 phase1 同构），其 `pixelDatatype: HALF_FLOAT` 输出的是已 ACES 的 LDR 值（HalfFloat 仅防量化，不承载 >1）——它**不是**两 stage 范例。phase2a 的「大气线性输出 + 链尾独立 tonemap」是 **three-geospatial 风格的自创架构**（为 LensFlare 线性域）；cesium-clouds-atmosphere 仅实证「PostProcessStage 接受 `pixelDatatype`」这一 Cesium 用法。

**phase2b LensFlare 方案决策**（回应评审 C1，用户 2026-08-04 确认选 image-based HDR）：

| 维度 | three-geospatial image-based（HDR） | cesium-clouds-atmosphere sun-direction（LDR） |
|---|---|---|
| 需 HDR 链 | **是**（threshold 筛 >1） | 否（sun direction 解析定位，无 threshold） |
| 带 bloom | **是**（MipmapBlur 8 级） | 否 |
| 设备要求 | HalfFloat renderable | 无 |
| 误触云/雪/白墙 | LDR+降 threshold 会误触 | 不会 |

**决策：选 image-based HDR**（理由：① 用户原则「以 three-geospatial 为主」；② bloom 一体化是 image-based 的核心额外收益；③ HDR 链同时服务未来 bloom/SSR 等 HDR 后处理，非 LensFlare 专属）。此决策使 phase2a HDR 链必要。**退出条款**：若 phase2b 转向 LDR 方案，phase2a 的 HalfFloat 部分可回退（仅保留「拆 tonemap 到独立 stage」即可让 LDR LensFlare 插在 atmosphere 与 tonemap 之间）。

---

## 4. 组件拆分与文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/cesium-core/src/cesium/aerialPerspective.frag.ts` | 改 | 末端去 `tonemapDisplay`，输出线性 `vec4(finalColor*exposure, a)`；**保留 input dithering**；debug 分支保留（输出 0-1 可视化值） |
| `packages/cesium-core/src/cesium/tonemap.frag.ts` | **新增** | ACES + gamma + display dithering；debug>0 透传；导出 `buildTonemapFragmentShader()` + `TONEMAP_UNIFORM_NAMES` + `buildStandaloneShaderForValidation()` |
| `packages/cesium-core/src/cesium/AtmosphereStage.ts` | 改 | `createAtmosphereStage` 建两个 stage；HalfFloat 检测+兜底；`setMode`/`destroy` 管两 stage；`AtmosphereStageHandle` 加 `atmosphereStage`/`tonemapStage` |
| `packages/cesium-core/src/cesium/tonemap.frag.test.ts` | **新增** | tonemap shader 组装 + 全组合 glslang 编译 + uniform 名一致性 |
| `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts` | 改 | 去掉「含 tonemapDisplay」断言，加「输出线性 finalColor·exposure」断言 |
| `packages/cesium-core/src/cesium/AtmosphereStage.test.ts` | 改 | 双 stage 断言、HalfFloat 三分支、`AtmosphereStageHandle` 新字段 |
| `apps/demo/src/main.ts` | 基本不动 | 可选加 `?hdr=0` 强制 RGBA8 兜底调试 |

---

## 5. 详细设计

### 5.1 HalfFloat 能力检测 + 兜底（`AtmosphereStage.ts`）

新增纯函数（可单测）：
```ts
export function resolvePostHdrDatatype(scene: Scene): PixelDatatype {
  const ctx = scene.context
  if (ctx.halfFloatingPointTexture && ctx.colorBufferHalfFloat) return PixelDatatype.HALF_FLOAT
  if (ctx.colorBufferFloat && ctx.floatingPointTexture) return PixelDatatype.FLOAT
  return PixelDatatype.UNSIGNED_BYTE
}
```
**兜底策略**：UNSIGNED_BYTE 时**仍保持两 stage 架构**（大气 stage RGBA8 输出线性 + tonemap ACES），**不回退 phase1 单 stage**。
- 理由：代码路径统一（`createAtmosphereStage`/`setMode`/`destroy` 不因设备能力分叉）。
- 代价（评审量化，色彩专家 I2 + 魔鬼 I4）：兜底设备 atmosphere 输出 `finalColor*exposure`（>1）写 RGBA8 RT 时被 clamp 到 1.0，tonemap `ACES(1.0)≈0.80` vs HalfFloat 路径 `ACES(真值>1)≈1.0` → **太阳盘亮度降低约 20%（ACES 饱和差异）**，天空/太阳高光区 HDR 渐变层次丢失（发白、变硬）。地表（≤1，经 `trans·groundDim` 压低）几乎不受影响。可接受——主视觉验收在 HalfFloat 设备做；兜底用 `?hdr=0` 目检太阳盘变暗属预期退化（不崩）。
- 可选：`?hdr=0` URL 参数强制 UNSIGNED_BYTE，在 HalfFloat 设备上对比验证兜底路径。

### 5.2 atmosphere stage 改造（`aerialPerspective.frag.ts`）

main 末端由：
```glsl
out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
```
改为：
```glsl
out_FragColor = vec4(finalColor * exposure, originalColor.a);  // 线性 HDR，由链尾 tonemap stage 收尾
```
**`sky=false` 分支同步改**（评审 I1，否则编译失败）：`buildMainFn` 的 `skyBranch` 在 `o.sky=false` 时末端也调用 `tonemapDisplay`（透传地表 + ACES）。phase2a 改为线性输出：
```glsl
finalColor = originalColor.rgb;
out_FragColor = vec4(finalColor * exposure, originalColor.a);  // 线性，链尾 tonemap 收尾
return;
```
否则 `tonemapDisplay` 从 atmosphere `HELPERS_GLSL` 移除后，`sky=false` 宏组合 glslang 编译会失败。

**保留不动**：
- input dithering（`originalColor += inDither * 1.5/255`，打散 RGBA8 banding，仍在 ACES 前——因为地表 banding 源头在 originalColor，dithering 必须在它进合成前加）。
- DUAL inscatter 全流程（`lookingAtGround` 分类、`baseInscatter`/`foreInscatter`/`mask`、`groundDim`）。
- `reconstructRay`、depth 反演（`hasScene`/`sceneDist`）、几何判定。
- debug 分支 `u_debugMode` 1-6（输出 0-1 可视化值，display ready）。

**函数迁移**：
- `tonemapDisplay` + `ACESFilmic`：从 atmosphere 的 `HELPERS_GLSL` **移除**，迁到 `tonemap.frag.ts`（atmosphere 末端不再 tonemap，`ACESFilmic` 无消费者；phase1 debug 分支不调 `tonemapDisplay`，移除无副作用）。
- `interleavedGradientNoise`：**保留在 atmosphere**（input dithering 的 `inDither` 仍用），**同时 tonemap 也声明一份**（display dithering 用）——GLSL 不能跨 stage 共享函数，两边各自声明同名纯函数（与 three-geospatial 每 effect 自带 helper 同理）。

**debug 输出语义**：debug=1..6 在 atmosphere 内输出 0-1 可视化值（phase1 行为不变），写入 HalfFloat RT，tonemap 透传不改——显示正确。**debug=7（新增，HDR 链验证）**：atmosphere debug 分支上限改为 `< 6.5`（debug=7 不触发可视化，走正常线性输出 `finalColor*exposure`，>1 原样写 HalfFloat），tonemap 加 `u_debugMode>6.5` 子分支做**线性归一化 false-color**（见 §5.3）——HalfFloat 设备太阳区 >1 显示亮区，RGBA8 兜底被 clip 到 1.0 显示暗区，**可证伪地**证明 HDR 链承载 >1（评审 C2/I2/M1 共识：log 归一化无法区分，因 log 值 ≤1 两路径都不 clip）。

### 5.3 tonemap stage（`tonemap.frag.ts`，新增）

```glsl
#version 300 es  // buildStandaloneShaderForValidation 用；运行时由 Cesium 注入
precision highp float;
uniform sampler2D colorTexture;   // atmosphere stage 的 HalfFloat 线性输出
uniform float u_debugMode;        // 与 atmosphere stage 同步
in vec2 v_textureCoordinates;
out vec4 out_FragColor;

// ACESFilmic + interleavedGradientNoise（从 aerialPerspective.frag.HELPERS_GLSL 迁来，原样）
vec3 ACESFilmic(vec3 x) { /* a=2.51 b=0.03 c=2.43 d=0.59 e=0.14，clamp(0,1) */ }
float interleavedGradientNoise(vec2 p) { /* fract(52.98.. * fract(dot(p, vec2(0.0671, 0.0058)))) */ }

void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  if (u_debugMode > 6.5) {
    // debug=7：线性归一化 false-color 证明 HalfFloat 承载 >1（评审 C2 可证伪方案）。
    // HalfFloat 设备：太阳区 finalColor·exposure>1 → clamp(/5,0,1) 接近 1（亮）；
    // RGBA8 兜底：atmosphere RT 已被 clip 到 1.0 → /5=0.2（暗）。两路径差异即 HDR 链证据。
    out_FragColor = vec4(clamp(c.rgb / 5.0, 0.0, 1.0), 1.0);
    return;
  }
  if (u_debugMode > 0.5) { out_FragColor = c; return; }  // debug=1..6 透传（atmosphere 已输出 display ready 可视化值）
  vec3 linearHdr = c.rgb;
  vec3 t = ACESFilmic(linearHdr);
  t = pow(t, vec3(1.0 / 2.2));
  float dither = interleavedGradientNoise(gl_FragCoord.xy)
    + interleavedGradientNoise(gl_FragCoord.xy + vec2(7.11, 5.17)) - 1.0;  // [-1,1] triangular
  t += dither * 1.5 / 255.0;
  out_FragColor = vec4(t, c.a);
}
```
**关键点**：
- 与 phase1 `tonemapDisplay` **完全等价**（ACES 常数、gamma、dithering 系数原样），仅位置移到独立 stage。ACES 输入仍是 HDR float（phase1 也是 shader float，>1 保留）——数学等价，太阳/天空亮度不变，**无需重标定 exposure**（评审色彩专家核实）。
- 无 `exposure` uniform（exposure 已在 atmosphere 线性段乘进 `finalColor*exposure`，对齐 cesium-clouds-atmosphere `AtmospherePostProcess`「曝光在上一 pass 线性段完成，本 pass 仅 ACES+gamma」——tonomap stage 无状态、不持 exposure，便于后续复用/替换为 AGX）。
- `u_debugMode` 必须与 atmosphere stage 同步（同一 `resolved.debugMode`，分别注入两 stage uniforms）。
- **必须 `sampleMode: NEAREST`（Cesium 默认，勿改，评审 I3 钉死）**：input dithering 经 atmosphere→HalfFloat RT→tonomap 中转需逐像素 1:1 直通；改 LINEAR 会四邻域平均抹掉 dither 噪声 → phase1 `d0efe87` 修的水波纹回归。Cesium 26.1.0 `PostProcessStage` 默认 `sampleMode=NEAREST`（`PostProcessStage.js:34,102`）。
- 默认 `pixelDatatype`（UNSIGNED_BYTE）→ 输出 RGBA8 display。

**导出 API**：
```ts
export const TONEMAP_UNIFORM_NAMES: string[] = ['u_debugMode']  // colorTexture 是 Cesium 内建，不列入
export function buildTonemapFragmentShader(): string
export function buildStandaloneShaderForValidation(): string  // #version 300 es + precision + out_FragColor 桩
```

### 5.4 AtmosphereStage.ts 双 stage 改造

```ts
const postHdrDatatype = resolvePostHdrDatatype(scene)  // 一次性检测（构造时）

function buildAtmosphereStage(): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildAerialPerspectiveFragmentShader(resolved),
    uniforms: buildAtmosphereUniforms(luts, resolved, state),
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: postHdrDatatype
  })
}
function buildTonemapStage(): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildTonemapFragmentShader(),
    uniforms: { u_debugMode: resolved.debugMode }  // 直接值，与 atmosphere 同源；setMode rebuild 时同步
    // sampleMode 默认 NEAREST——勿改（保护 input dithering 经 RT 中转，见 §5.3 关键点）
  })  // 默认 RGBA8
}

let atmosphereStage = buildAtmosphereStage()
let tonemapStage = buildTonemapStage()
scene.postProcessStages.add(atmosphereStage)
scene.postProcessStages.add(tonemapStage)
```

**`setMode`**（评审 I2 简化：setMode/destroy 全仓库 0 调用属 dead code，demo 切 mode 靠页面重载）：语义等价于 `destroy()` + 以新 options 重建——removeAndDestroy 两 stage → rebuild 两 stage → add（顺序不变）。**不做**「单 stage 增量重建」的过度同步设计（两 stage 共享同一 `resolved`，rebuild 天然同步；setMode 是 JS 单线程同步原子操作，无中间帧竞态）。
**`destroy`**：`removePreRender()` + removeAndDestroy 两 stage。
**`AtmosphereStageHandle` 接口变化**：
```ts
export interface AtmosphereStageHandle {
  readonly atmosphereStage: PostProcessStage   // 原 `stage` 拆分
  readonly tonemapStage: PostProcessStage       // 新增
  readonly postHdrDatatype: PixelDatatype       // 检测结果（验收/调试用）
  setMode(newOptions: AtmosphereStageOptions): void
  destroy(): void
}
```
> **兼容性**：phase1 的 `handle.stage` 字段移除。`main.ts` 不接 `createAtmosphereStage` 返回值（无影响）；测试需更新（phase1 `AtmosphereStage.test.ts` 若引用 `.stage` 则改为 `.atmosphereStage`）。

**`buildAtmosphereUniforms` 不变**（uniform 集合与 phase1 一致；exposure 仍在此注入，atmosphere stage 消费）。

### 5.5 demo 接线（`main.ts`）

`createAtmosphereStage(scene, luts, options)` 内部已改双 stage，`main.ts` 调用点不变。可选新增：
- `?hdr=0`：强制 `pixelDatatype = UNSIGNED_BYTE`（绕过检测，验证兜底路径）。
- debug 模式复用 phase1 的 `?debug=N`（N=1..6 atmosphere 可视化）；**新增 N=7（HDR 链验证）**：atmosphere 正常输出线性 `finalColor·exposure`（>1 写 HalfFloat），tonomap `u_debugMode>6.5` 子分支做 `clamp(linearHdr/5, 0, 1)` 线性归一化 false-color——HalfFloat 设备太阳区亮、`?hdr=0` 兜底被 clip 到 1.0 显示暗（0.2），对比即证明 HDR 链承载 >1（详见 §5.2/§5.3，评审 C2 可证伪方案；log 公式不可用，因 ≤1 不 clip 无法区分）。

---

## 6. 测试策略

### 6.1 单元测试（node，vitest）

**`tonemap.frag.test.ts`（新增）**：
- `buildTonemapFragmentShader()` 含 `ACESFilmic(`、`pow(., vec3(1.0 / 2.2))`、`interleavedGradientNoise`、display dithering `1.5 / 255.0`。
- 含 `u_debugMode > 0.5 && < 6.5` debug=1..6 透传分支。
- 含 `u_debugMode > 6.5` debug=7 线性归一化分支（`clamp(c.rgb / 5.0, 0.0, 1.0)`）。
- 不含 input dithering（input dithering 留 atmosphere）。
- 全组合 glslang 编译通过（tonemap 无宏开关，单一组合；`buildStandaloneShaderForValidation` 补 `#version 300 es` + `out_FragColor` 桩）。
- `TONEMAP_UNIFORM_NAMES` 与声明的 uniform 一致（`u_debugMode`；`colorTexture` 白名单）。

**`aerialPerspective.frag.test.ts`（改）**：
- 去掉「含 `tonemapDisplay(finalColor * exposure`」相关断言。
- 加「末端为 `out_FragColor = vec4(finalColor * exposure, originalColor.a)`」（线性输出）。
- 加「`sky=false` 组合也线性输出、不含 `tonemapDisplay`」（评审 I1，否则编译失败）。
- 加「仍含 input dithering `inDither`」「仍含 `ACESFilmic` 为 **false**（已迁走）」。
- DUAL inscatter 断言全部保留（`lookingAtGround`/`baseInscatter`/`foreInscatter`/`mask`/`groundDim`）。
- 全宏组合 glslang 编译仍通过（atmosphere shader 去掉 tonemapDisplay 后仍自洽）。

**`AtmosphereStage.test.ts`（改）**：
- `resolvePostHdrDatatype` 三分支：HalfFloat 支持→HALF_FLOAT；仅 float→FLOAT；都不支持→UNSIGNED_BYTE（mock context 字段）。
- `createAtmosphereStage` 产出的 handle 含 `atmosphereStage` + `tonemapStage`（两个 PostProcessStage）。
- `buildAtmosphereUniforms` 覆盖 `AERIAL_PERSPECTIVE_UNIFORM_NAMES`（不变）。
- tonemap stage 的 uniforms 含 `u_debugMode`。

### 6.2 浏览器视觉回归（项目方跑，硬指标）

复用 phase1 验收 URL（`mode=atmosphere`，B 路径参数：`time`/`camera`/`groundDim`/`exposureDay`）。**五项与 phase1 不可区分**：

| # | 回归项 | 验证方法 |
|---|---|---|
| 1 | 水波纹（俯视 nadir 远处渐变 banding） | input dithering 仍打散；高空俯视远景无同心色带 |
| 2 | 转动地平线闪动（掠射角） | DUAL inscatter 仍平滑；转动相机地平线无绿/红条纹 |
| 3 | 山体不透明（前景雾） | `hasScene`/`mask` 仍 work；近处山峰不透出地平线 |
| 4 | 天空 / 太阳盘 | ACES 后颜色/亮度与 phase1 一致 |
| 5 | 地表过曝（groundDim） | groundDim=0.5 仍压住地面过曝 |

**新增 HDR 链验证**（评审 C2 可证伪方案，非 log 归一化）：
- `?debug=7`：tonomap 输出 `clamp(linearHdr/5, 0, 1)` 线性归一化 false-color。HalfFloat 设备：太阳/天空高光区 `finalColor·exposure`>1 → 显示亮区（接近 1）。
- 对比 `?hdr=0`（强制兜底）：atmosphere RT 被 RGBA8 clip 到 1.0 → debug=7 显示暗区（≈0.2）。两路径太阳区亮度差异即 HalfFloat 承载 >1 的证据。

### 6.3 成功标准
1. 全部单测通过（core vitest + glslang 编译 + demo tsc）。
2. 五项视觉回归与 phase1 不可区分（项目方浏览器确认）。
3. debug=7 证明 HalfFloat 链承载真 HDR（天空 >1 值未被 clip）。
4. `?hdr=0` 兜底路径不崩（视觉退化可接受但不报错）。

---

## 7. 风险与应对

| # | 风险 | 严重度 | 对策 | 验证 |
|---|---|---|---|---|
| R1 | 拆 ACES 引入 phase1 回归（水波纹/闪动/山体透明重现） | **高** | ACES 仅位置移动（常量/dithering 系数原样）；input dithering 留 atmosphere；DUAL inscatter 全不动；五项视觉回归硬指标 | §6.2 五项 |
| R2 | HalfFloat 设备不支持（兜底） | 中 | 三级降级（HALF_FLOAT→FLOAT→UNSIGNED_BYTE）；兜底保持两 stage 不崩 | `?hdr=0` 验证 |
| R3 | input dithering 经 HalfFloat RT 中转被双线性滤波抹掉 → 水波纹回归（评审 I3） | 中 | tonomap（及未来中间 stage）**必须 `sampleMode: NEAREST`**（Cesium 默认）；代码注释钉死；HalfFloat 0-1 段 ULP≈1/1024，dither 噪声 ±1.5/255 完整保留 | §6.2 #1 水波纹 |
| R4 | debug 模式被 tonemap ACES 扭曲 | 中 | tonemap 加 `u_debugMode`，>0 透传；两 stage 同步 debugMode | debug=1..7 显示正确 |
| R5 | PostProcessStage 链顺序错误（tonemap 先于 atmosphere） | 中 | 严格 `add(atmosphere)` 先、`add(tonemap)` 后；单测验 add 顺序 | §6.1 |
| R6 | 兜底设备太阳盘变暗 ~20%（RGBA8 clip 后 ACES 饱和差异） | 低 | 接受（代码统一权衡；§5.1 量化）；`?hdr=0` 目检太阳盘属预期退化 | `?hdr=0` 目检 |
| R7 | 性能/内存：多一个全屏 HalfFloat RT（1080p ≈16MB）+ tonomap 全屏 pass（移动端 bandwidth，评审 M2） | 低 | tonomap 极轻（texture sample + ACES + pow + dither <0.3ms@1080p）；atmosphere shader 本身重，bandwidth 增量占比小；移动端若卡顿再评估 | 性能记录项 |

---

## 8. 与 phase2b 的衔接

phase2a 完成后，atmosphere 与 tonemap 之间是**线性 HDR HalfFloat 域**，phase2b LensFlare 将作为新 stage 插入：
```
atmosphere(HalfFloat 线性) → [phase2b: LensFlare(threshold+mipmap blur+ghosts/halo, 线性域)] → tonemap(ACES→RGBA8)
```
phase2b 的设计前提（phase2a 必须先满足）：
1. atmosphere 输出 HalfFloat 线性（threshold 可筛 >1 真亮像素）—— **phase2a §5.2 保证**。
2. 链尾有独立 tonemap（LensFlare 在线性域合成，ACES 收尾）—— **phase2a §5.3 保证**。
3. 两 stage 间可插入新 stage（Cesium PostProcessStageCollection 支持）—— **phase2a 验证 add 顺序机制**。

phase2b spec 待 phase2a 验收通过后另起（那时 HDR 链已验证，LensFlare 设计可基于实际 HalfFloat 输出量级精确定标）。

---

## 9. 工程约定（沿用项目既有）

- **语言**：所有对话/文档/注释中文；Markdown。
- **GLSL**：WebGL2 / GLSL ES 3.00；`sampler3D` LUT；`dFdx/dFdy`；`glslangValidator` 编译校验（与 phase1 一致）。
- **包结构**：`packages/cesium-core/src/cesium/` 下（atmosphere + tonemap 并列）；不新增包。
- **测试**：vitest 单测 + glslang 编译；无 GPU 自动化（视觉靠浏览器验收）。
- **ion token**：不入库（`apps/demo/.env.local` 的 `VITE_ION_TOKEN`；URL `?ionToken=` fallback）。phase2a 不涉及 ion。
- **参考库定位**：three-geospatial 为主，cesium-clouds-atmosphere 仅 Cesium 适配细节参考（见 header）。

---

## 10. 已定死事项（评审 I6，不再推给实现）

- **`?debug=7` HDR 可视化**：已定 `clamp(linearHdr/5, 0, 1)` 线性归一化 false-color（§5.3），**非 log**（log ≤1 两路径都不 clip，无法区分，评审 C2）。N=5 据 exposureDay=1.2 + 天空量级，实现时若天空普遍 <5 可调小。
- **FLOAT 降级路径**：保留三级检测（HALF_FLOAT→FLOAT→UNSIGNED_BYTE，对齐 cesium-clouds-atmosphere）。FLOAT（32-bit color buffer）罕见但不删——`EXT_color_buffer_float` 同时覆盖 RGBA16F+RGBA32F，HalfFloat 不支持的设备 FLOAT 通常也不支持，三级无害且代码极少。
- **`AtmosphereStageHandle.stage` 别名**：**不保留**（评审核实全仓库 0 外部引用 `.stage`，无迁移成本），干净断开为 `atmosphereStage` + `tonemapStage`。
