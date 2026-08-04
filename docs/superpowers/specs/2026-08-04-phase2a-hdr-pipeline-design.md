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
- **结论**：image-based LensFlare 本质需要 HDR float 输入。phase1 的 RGBA8 单 stage 没有「线性域后处理」的位置，无法承接。必须先把大气 stage 升到 HalfFloat 线性输出 + 拆出链尾 ToneMappingStage，LensFlare 才能插在「大气之后、tonemap 之前」的线性域。

### 1.3 Cesium PostProcessStage 浮点支持（已核实可行）

`cesium-clouds-atmosphere/.../AtmospherePostProcess.js:828-834` 实证 `PostProcessStage` 构造选项接受 `pixelFormat` + `pixelDatatype`：
```js
new Cesium.PostProcessStage({ name, fragmentShader, uniforms,
  pixelFormat: Cesium.PixelFormat.RGBA,
  pixelDatatype: postHdrPixelDatatype,  // HALF_FLOAT 优先，FLOAT 次选，UNSIGNED_BYTE 兜底
})
```
本项目 `node_modules` 即 `@cesium/engine@26.1.0`（与 cesium-clouds-atmosphere 同款），用法可直接参考。HalfFloat 渲染能力用 `context.halfFloatingPointTexture && context.colorBufferHalfFloat` 检测。

### 1.4 关键事实：地表输入仍 LDR

即使大气 stage 升 HalfFloat，它读的 `originalColor` 仍是 globe 的 RGBA8（地表已量化）。HalfFloat 只能保住 **inscatter/天空**（shader 算的真 HDR，可 >1）的精度，地表部分的 banding 源头不变 → **input dithering 仍必须留在大气 stage**（见 §5.2）。这和 cesium-clouds-atmosphere 的情况一致（天空 HDR、地表 LDR 混合）。

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
- **不开 `scene.highDynamicRange`**（副作用大：影响 Cesium 原生光照/其他后处理；HalfFloat PostProcessStage 已够）。
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

**链顺序**：`scene.postProcessStages.add(atmosphereStage)` 先，`add(tonemapStage)` 后。Cesium PostProcessStage 链按 add 顺序执行，tonemap 的 `colorTexture` = atmosphere 的输出纹理（`inputPreviousStageTexture` 默认 true，无需配置）。

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
- 理由：代码路径统一（`setMode`/`destroy` 不因设备能力分叉）；HDR 丢失是设备限制可接受（现代设备基本支持 HalfFloat）。
- 代价：兜底设备天空/太阳高光被 RGBA8 clip（>1 部分丢失），但 phase2a 视觉验收在支持 HalfFloat 的设备做；phase2b LensFlare 的兜底行为由 phase2b spec 单独处理。
- 可选：`?hdr=0` URL 参数强制 UNSIGNED_BYTE，用于在 HalfFloat 设备上对比验证兜底路径不崩。

### 5.2 atmosphere stage 改造（`aerialPerspective.frag.ts`）

main 末端由：
```glsl
out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
```
改为：
```glsl
out_FragColor = vec4(finalColor * exposure, originalColor.a);  // 线性 HDR，由链尾 tonemap stage 收尾
```
**保留不动**：
- input dithering（`originalColor += inDither * 1.5/255`，打散 RGBA8 banding，仍在 ACES 前——因为地表 banding 源头在 originalColor，dithering 必须在它进合成前加）。
- DUAL inscatter 全流程（`lookingAtGround` 分类、`baseInscatter`/`foreInscatter`/`mask`、`groundDim`）。
- `reconstructRay`、depth 反演（`hasScene`/`sceneDist`）、几何判定。
- debug 分支 `u_debugMode` 1-6（输出 0-1 可视化值，display ready）。

**函数迁移**：
- `tonemapDisplay` + `ACESFilmic`：从 atmosphere 的 `HELPERS_GLSL` **移除**，迁到 `tonemap.frag.ts`（atmosphere 末端不再 tonemap，`ACESFilmic` 无消费者；phase1 debug 分支不调 `tonemapDisplay`，移除无副作用）。
- `interleavedGradientNoise`：**保留在 atmosphere**（input dithering 的 `inDither` 仍用），**同时 tonemap 也声明一份**（display dithering 用）——GLSL 不能跨 stage 共享函数，两边各自声明同名纯函数（与 three-geospatial 每 effect 自带 helper 同理）。

**debug 输出语义**：phase2a 下 debug 值（0-1）写入 HalfFloat RT，再经 tonemap stage。tonemap 在 `u_debugMode>0` 时透传（见 §5.3），故 debug 可视化不被 ACES 扭曲，显示正确。

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
  if (u_debugMode > 0.5) { out_FragColor = c; return; }  // debug 透传（atmosphere 已输出 display ready 可视化值）
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
- 与 phase1 `tonemapDisplay` **完全等价**（ACES 常数、gamma、dithering 系数原样），仅位置移到独立 stage。
- 无 `exposure` uniform（exposure 已在 atmosphere stage 乘进 `finalColor*exposure`）。
- `u_debugMode` 必须与 atmosphere stage 同步（同一 `resolved.debugMode`，分别注入两个 stage 的 uniforms）。
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
  })  // 默认 RGBA8
}

let atmosphereStage = buildAtmosphereStage()
let tonemapStage = buildTonemapStage()
scene.postProcessStages.add(atmosphereStage)
scene.postProcessStages.add(tonemapStage)
```

**`setMode`**：removeAndDestroy 两个旧 stage → rebuild 两个 → add（顺序不变）。
**`destroy`**：`removePreRender()` + removeAndDestroy 两个 stage。
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
- debug 模式复用 phase1 的 `?debug=N`（N=1..6 atmosphere 可视化；新增 N=7 输出 atmosphere 线性 HDR 的 `log(1+finalColor·exposure)` 证明 >1 HDR 存在）。

---

## 6. 测试策略

### 6.1 单元测试（node，vitest）

**`tonemap.frag.test.ts`（新增）**：
- `buildTonemapFragmentShader()` 含 `ACESFilmic(`、`pow(., vec3(1.0 / 2.2))`、`interleavedGradientNoise`、display dithering `1.5 / 255.0`。
- 含 `u_debugMode > 0.5` 透传分支。
- 不含 input dithering（input dithering 留 atmosphere）。
- 全组合 glslang 编译通过（tonemap 无宏开关，单一组合；`buildStandaloneShaderForValidation` 补 `#version 300 es` + `out_FragColor` 桩）。
- `TONEMAP_UNIFORM_NAMES` 与声明的 uniform 一致（`u_debugMode`；`colorTexture` 白名单）。

**`aerialPerspective.frag.test.ts`（改）**：
- 去掉「含 `tonemapDisplay(finalColor * exposure`」相关断言。
- 加「末端为 `out_FragColor = vec4(finalColor * exposure, originalColor.a)`」（线性输出）。
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

**新增 HDR 链验证**：
- `?debug=7`：atmosphere 输出 `log(1+finalColor·exposure)` 可视化——天空/太阳附近应明显 >0（证明 HalfFloat 链承载 >1 HDR 值，RGBA8 会被 clip 成 1.0）。
- 对比 `?hdr=0`（强制兜底）：debug=7 下天空被 clip（≤1），证明 HalfFloat 与兜底差异。

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
| R3 | HalfFloat RT 的 dithering 行为差异（display dithering 加在 HalfFloat→RGBA8 转换点） | 中 | display dithering 在 tonemap stage 输出 RGBA8 前加（与 phase1 位置语义一致：打散最终 8-bit 量化） | §6.2 #1 水波纹 |
| R4 | debug 模式被 tonemap ACES 扭曲 | 中 | tonemap 加 `u_debugMode`，>0 透传；两 stage 同步 debugMode | debug=1..7 显示正确 |
| R5 | PostProcessStage 链顺序错误（tonemap 先于 atmosphere） | 中 | 严格 `add(atmosphere)` 先、`add(tonemap)` 后；单测验 add 顺序 | §6.1 |
| R6 | 兜底设备地表/天空色彩偏移（RGBA8 线性中间值量化） | 低 | 接受（兜底设备少见，phase2a 验收在 HalfFloat 设备） | `?hdr=0` 目检 |

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

## 10. 待确认事项（实现中据实定，不阻塞）

- **`?debug=7` 的 HDR 可视化公式**：暂定 `log(1+finalColor·exposure)/log(100)` 归一化（复用 phase1 debug=1 的 log 公式），实现时据天空量级微调。
- **FLOAT（32-bit）降级路径是否真有人遇到**：现代设备要么 HalfFloat 要么都不支持，FLOAT 中间态罕见；实现时若 `context.colorBufferFloat` 检测复杂可简化为 HALF_FLOAT/UNSIGNED_BYTE 两级。
- **`AtmosphereStageHandle` 是否保留 `stage` 别名**（指向 atmosphereStage）以减迁移成本：倾向不保留（干净断开），实现时看测试迁移量决定。
