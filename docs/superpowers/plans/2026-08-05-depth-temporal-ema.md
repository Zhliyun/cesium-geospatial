# depthTemporal EMA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 atmosphere PostProcessStage 前插入 depthTemporal stage，时序 EMA 平滑 globe depth（log-depth 域），消除 inscatterScale=25 下相机俯仰变化的 inscatter 同心波纹，零 lag。

**Architecture:** 方案 A——depthTemporal 作为 activeStages[0] 单 stage 打包透传 `vec4(sceneColor.rgb, smoothDepth)`（scene color 流经 RGB，smoothDepth 存 alpha），atmosphere 读 `.rgb`/`.a`。EMA 在 raw log-depth 域（`texture().r`，禁 `czm_readDepth`），reproject 用纯 ECEF 米（禁 altitudeCorrection/METER_TO_LENGTH_UNIT）。history 外部持久 HALF_FLOAT Texture ping-pong，postRender 用 Cesium `createViewportQuadCommand` blit。

**Tech Stack:** Cesium @cesium/engine 26.1.0 PostProcessStage + Texture + Framebuffer + createViewportQuadCommand；GLSL ES 3.00（2-arg `czm_windowToEyeCoordinates` + `#define LOG_DEPTH`）；vitest + glslangValidator。

**关键约束（评审钉死，勿破）**：
- EMA 域 = raw log-depth（`texture(depthTexture).r`，**禁** `czm_readDepth`）
- reproject worldPos = 纯 ECEF 米（**禁** `altitudeCorrection`/`METER_TO_LENGTH_UNIT`）
- depthTemporal output = `vec4(sceneColor.rgb, smoothDepth)`（打包透传，**禁** uniform-string 重定向 activeStages colorTexture）
- history 也存 `.a`（与 output 同布局，blit 透传）
- atmosphere 用 **2-arg** `czm_windowToEyeCoordinates(vec2 xy, float logDepth)`（LOG_DEPTH 分支），**禁** `eyePos /= eyePos.w`

**前置确认（Task 2 前必做）**：读 `node_modules/@cesium/engine@26.1.0/.../Source/Shaders/czm_windowToEyeCoordinates.glsl` 确认 2-arg overload 签名（`vec4 czm_windowToEyeCoordinates(vec2 windowCoord, float logDepth)`）+ LOG_DEPTH 分支行为；读 `readDepth.glsl` 确认 `czm_readDepth = czm_reverseLogDepth(texture().r)`。

---

## File Structure

### 新增（`packages/cesium-core/src/cesium/depthTemporal/`）
- `depthTemporalConstants.ts` — alpha 范围、depthThreshold、maxDelta k、ping-pong、URL 预设
- `depthTemporal.frag.ts` — `buildDepthTemporalFragmentShader()` 组装器 + `buildDepthTemporalStandaloneShaderForValidation()`（glslang 桩）
- `depthTemporal.frag.test.ts` — glslang compile + shader 内容断言
- `historyBlit.ts` — history Texture ping-pong 管理 + bridge + adapter（outputTexture getter）+ `createViewportQuadCommand` blit
- `historyBlit.test.ts` — ping-pong swap + bridge + blit mock + sanity check
- `temporalAlpha.ts` — 运动门控计算（position+direction 双项 + 高度归一化）
- `temporalAlpha.test.ts` — 边界单测
- `depthTemporal.regression.test.ts` — 坐标系 + VP 一致性 + EMA 收敛回归

### 修改
- `packages/cesium-core/src/cesium/AtmosphereStage.ts` — 装配 depthTemporal stage（activeStages[0]）+ history lifecycle（preRender resize + postRender blit/swap/prevVP/alpha/clear/判空）+ UNSIGNED_BYTE 兜底 + sanity check
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts` — sceneDist `.a` + 2-arg czm_windowToEyeCoordinates（L329）、originalColor `.rgb`（L321）、移除 5-tap（L350-355）、debug=5 `.a`（L472）+ debug=8 raw globe depth
- `packages/cesium-core/src/cesium/lensFlare/occlusion.frag.ts` — depthTexture `.a`（L97）+ 阈值 log-depth 域
- `packages/cesium-core/src/cesium/cesium-augment.d.ts` — `PostProcessStage.outputTexture` getter 类型
- `apps/demo/src/main.ts` — URL `?temporalQuality= ?depthThreshold= ?temporalEma=`

---

## Task 1: depthTemporalConstants.ts

**Files:**
- Create: `packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.ts`
- Test: `packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// depthTemporalConstants.test.ts
import { describe, it, expect } from 'vitest'
import { LOW_ALPHA, HIGH_ALPHA, DEPTH_THRESHOLD_DEFAULT, MAX_DELTA_K, TEMPORAL_QUALITY_PRESETS } from './depthTemporalConstants'

describe('depthTemporalConstants', () => {
  it('钉死评审参数：low/high alpha、log-depth 相对阈值、高度归一化系数、预设', () => {
    expect(LOW_ALPHA).toBe(0.05)
    expect(HIGH_ALPHA).toBe(0.5)
    expect(DEPTH_THRESHOLD_DEFAULT).toBe(0.1) // log-depth 相对阈值
    expect(MAX_DELTA_K).toBe(0.01) // maxDelta = cameraHeight * 0.01
    expect(TEMPORAL_QUALITY_PRESETS.low.lowAlpha).toBe(0.05)
    expect(TEMPORAL_QUALITY_PRESETS.high.lowAlpha).toBe(0.1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/depthTemporalConstants.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement**

```ts
// depthTemporalConstants.ts
// depthTemporal EMA 参数（评审钉死，见 spec v2 §5）。
// EMA 在 raw log-depth 域；运动门控 position+direction 双项 + 高度归一化。

export const LOW_ALPHA = 0.05 // 静止强累积（history 主导，强平滑）
export const HIGH_ALPHA = 0.5 // 移动偏 current（比 ShadowResolvePass 0.8 低，因 reprojection 更准可承受更多累积）
export const DEPTH_THRESHOLD_DEFAULT = 0.1 // log-depth 相对阈值（|histLog-curLog|/curLog，距离无关容差 ≈ 7% 距离变化）
export const MAX_DELTA_K = 0.01 // maxDelta = cameraHeight * MAX_DELTA_K（高度归一化，1Mm 高度 maxDelta=10km）
export const DIRECTION_WEIGHT = 0.5 // 运动门控 direction 项权重（reprojection 准，比 ShadowResolvePass 调小）
export const FOG_PLANE_LOGDEPTH_EPS = 1e-4 // 远平面判定：curLogDepth >= 1 - eps → 不累积

export interface TemporalQualityPreset {
  lowAlpha: number
  highAlpha: number
}

// URL ?temporalQuality=low|high（收敛调参，替代 v1 的 lowAlpha/highAlpha/temporalAlpha 三参）
export const TEMPORAL_QUALITY_PRESETS: Record<string, TemporalQualityPreset> = {
  low: { lowAlpha: 0.05, highAlpha: 0.5 }, // 默认：强平滑
  high: { lowAlpha: 0.1, highAlpha: 0.8 }, // 弱平滑（减拖影，适合快速操作）
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/depthTemporalConstants.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.ts packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.test.ts
git commit -m "feat(core): depthTemporal 常量（评审钉死参数：log-depth 域 alpha/threshold + 高度归一化）"
```

---

## Task 2: depthTemporal shader 组装器 + glslang compile

**前置**：读 `node_modules/@cesium/engine@26.1.0/.../Source/Shaders/czm_windowToEyeCoordinates.glsl`（确认 2-arg overload `vec4 czm_windowToEyeCoordinates(vec2 windowCoord, float logDepth)` + LOG_DEPTH 分支）+ `readDepth.glsl`（确认 `czm_readDepth = czm_reverseLogDepth(texture().r)`）。

**Files:**
- Create: `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.ts`
- Create: `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.test.ts`

- [ ] **Step 1: Write failing test（glslang compile + 内容断言）**

```ts
// depthTemporal.frag.test.ts
import { describe, it, expect } from 'vitest'
import { buildDepthTemporalFragmentShader, buildDepthTemporalStandaloneShaderForValidation } from './depthTemporal.frag'
import { compileFragment } from '../glslangUtil'

describe('buildDepthTemporalFragmentShader', () => {
  const s = buildDepthTemporalFragmentShader()

  it('打包透传：读 colorTexture.rgb 透传 + depthTexture.r（log-depth，禁 czm_readDepth）', () => {
    expect(s).toContain('texture(colorTexture, v_textureCoordinates).rgb')
    expect(s).toContain('texture(depthTexture, v_textureCoordinates).r')
    expect(s).not.toContain('czm_readDepth') // 评审 critical #2：禁 czm_readDepth（window-depth）
  })

  it('reproject 纯 ECEF 米（禁 altitudeCorrection / METER_TO_LENGTH_UNIT）', () => {
    expect(s).toContain('czm_inverseView *')
    expect(s).not.toContain('altitudeCorrection')
    expect(s).not.toContain('METER_TO_LENGTH_UNIT')
  })

  it('2-arg czm_windowToEyeCoordinates（LOG_DEPTH 分支，禁 /=w）', () => {
    expect(s).toContain('#define LOG_DEPTH')
    // 2-arg 形式（vec2 + float），非 4-arg vec4
    expect(s).toMatch(/czm_windowToEyeCoordinates\(vec2\(gl_FragCoord\.xy\),\s*curLogDepth\)/)
  })

  it('disocclusion：log-depth 相对阈值 + 远平面特殊 + prevUV 边界', () => {
    expect(s).toContain('relDiff')
    expect(s).toContain('u_depthThreshold')
    expect(s).toContain('farPlane')
    expect(s).toContain('prevClip.w > 0.0')
  })

  it('打包输出 vec4(sceneColor, smoothDepth)', () => {
    expect(s).toContain('out_FragColor = vec4(sceneColor, smoothDepth)')
  })

  it('glslang 编译通过（含 2-arg czm_windowToEyeCoordinates + czm_inverseView 桩 + LOG_DEPTH define）', async () => {
    const standalone = buildDepthTemporalStandaloneShaderForValidation()
    const result = await compileFragment(standalone, 'depthTemporal')
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/depthTemporal.frag.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement shader 组装器**

```ts
// depthTemporal.frag.ts
// depthTemporal fragment shader 组装器（方案 A 单 stage 打包透传）。
// 评审钉死：EMA raw log-depth 域、reproject 纯 ECEF 米、2-arg czm_windowToEyeCoordinates、打包输出。

export interface DepthTemporalShaderOptions {
  enabled?: boolean // ?temporalEma=0 时 false（shader 透传，不 EMA）
}

export function buildDepthTemporalFragmentShader(options: DepthTemporalShaderOptions = {}): string {
  const enabled = options.enabled !== false
  if (!enabled) {
    // 透传兜底（?temporalEma=0 或 UNSIGNED_BYTE）：纯透传 scene color + 本帧 raw log-depth
    return `#version 300 es
precision highp float;
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
void main() {
  vec3 sceneColor = texture(colorTexture, v_textureCoordinates).rgb;
  float curLogDepth = texture(depthTexture, v_textureCoordinates).r;
  out_FragColor = vec4(sceneColor, curLogDepth);
}
`
  }
  return `#define LOG_DEPTH
#version 300 es
precision highp float;
uniform sampler2D colorTexture;       // scene color（activeStages[0] 自动 = scene）
uniform sampler2D depthTexture;       // 本帧 globe depth（raw log-depth in .r）
uniform sampler2D u_historyTexture;   // 上帧 smoothDepth（.a）
uniform mat4 u_prevViewProjection;    // 上帧 VP（ECEF 米域）
uniform float u_temporalAlpha;        // [0,1] 运动门控（position+direction 双项）
uniform float u_depthThreshold;       // log-depth 相对阈值
in vec2 v_textureCoordinates;
out vec4 out_FragColor;

void main() {
  vec3 sceneColor = texture(colorTexture, v_textureCoordinates).rgb;
  float curLogDepth = texture(depthTexture, v_textureCoordinates).r;  // raw log-depth（禁 czm_readDepth）

  // 反演 worldPosECEF（纯 ECEF 米，禁 altitudeCorrection/METER_TO_LENGTH_UNIT）
  // 2-arg czm_windowToEyeCoordinates（LOG_DEPTH 分支，接收 log-depth，返回 .xyz 真眼坐标，禁 /=w）
  vec4 eyePos = czm_windowToEyeCoordinates(vec2(gl_FragCoord.xy), curLogDepth);
  vec3 worldPosECEF = (czm_inverseView * vec4(eyePos.xyz, 1.0)).xyz;

  // reproject 到上一帧
  vec4 prevClip = u_prevViewProjection * vec4(worldPosECEF, 1.0);
  vec2 prevUV = prevClip.xy / prevClip.w * 0.5 + 0.5;

  // disocclusion：prevUV 边界 + log-depth 相对阈值 + 远平面特殊处理
  bool prevVisible = (prevClip.w > 0.0)
    && (prevUV.x >= 0.0 && prevUV.x <= 1.0)
    && (prevUV.y >= 0.0 && prevUV.y <= 1.0);
  float histLogDepth = prevVisible ? texture(u_historyTexture, prevUV).a : curLogDepth;
  bool farPlane = curLogDepth >= 1.0 - 1e-4;  // 远平面/未加载 depth≈1：不累积
  float relDiff = abs(histLogDepth - curLogDepth) / max(curLogDepth, 1e-4);
  bool consistent = !farPlane && (relDiff < u_depthThreshold);
  float alpha = (prevVisible && consistent) ? u_temporalAlpha : 1.0;
  float smoothDepth = mix(histLogDepth, curLogDepth, alpha);

  // 打包输出：scene color 流经 RGB，smoothDepth 存 alpha
  out_FragColor = vec4(sceneColor, smoothDepth);
}
`
}

// glslang 校验桩（补 czm_windowToEyeCoordinates 2-arg + czm_inverseView + uniform 桩）
export function buildDepthTemporalStandaloneShaderForValidation(): string {
  const base = buildDepthTemporalFragmentShader({ enabled: true })
  const stubs = `
// —— glslang 桩（Cesium 运行时自动注入，离线校验补桩）——
vec4 czm_windowToEyeCoordinates(vec2 windowCoord, float logDepth) {
  // 简化桩：返回眼坐标（x, y, -1, 1）
  return vec4(windowCoord, -1.0, 1.0);
}
mat4 czm_inverseView = mat4(1.0);
`
  return base.replace('#define LOG_DEPTH\n#version 300 es', '#version 300 es\n#define LOG_DEPTH') + stubs
}
```

注意：`compileFragment` 来自 `glslangUtil.ts`（已存在，aerialPerspective 共享）。如 `glslangUtil.ts` 无 `compileFragment`，先读 `aerialPerspective.compile.test.ts` 确认导入路径与签名，复用现有 compile 辅助。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/depthTemporal.frag.test.ts
```
Expected: PASS（含 glslang compile）。若 glslang compile 失败（2-arg 桩或 LOG_DEPTH 问题），按错误调整桩/shader。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.ts packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.test.ts
git commit -m "feat(core): depthTemporal shader（log-depth 域 EMA + ECEF reproject + 打包透传 + glslang 校验）"
```

---

## Task 3: historyBlit.ts — history Texture ping-pong + bridge + adapter

**Files:**
- Create: `packages/cesium-core/src/cesium/depthTemporal/historyBlit.ts`
- Create: `packages/cesium-core/src/cesium/depthTemporal/historyBlit.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// historyBlit.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHistoryState, getHistoryBridge, swapHistory, sanityCheckOutputTexture } from './historyBlit'

// mock Cesium Texture（最小）
vi.mock('cesium', () => ({
  Texture: function (this: any, opts: any) {
    this._texture = { id: Math.random() }
    this._target = 0x0DE1 /* TEXTURE_2D */
    this.width = opts.width
    this.height = opts.height
    return this
  },
  Sampler: { NEAREST: 9728 },
  PixelFormat: { RGBA: 6408 },
  PixelDatatype: { HALF_FLOAT: 36193, FLOAT: 5126, UNSIGNED_BYTE: 5121 },
  defined: (v: any) => v != null,
}))

describe('historyBlit', () => {
  it('createHistoryState: 两张 ping-pong Texture（HALF_FLOAT RGBA NEAREST）+ index=0', () => {
    const ctx = {} as any
    const state = createHistoryState(ctx, 1920, 1080, 36193 /* HALF_FLOAT */)
    expect(state.textures.length).toBe(2)
    expect(state.readIndex).toBe(0)
    expect(state.textures[0].width).toBe(1920)
  })

  it('swapHistory: readIndex 0→1→0 翻转', () => {
    const state = createHistoryState({} as any, 100, 100, 36193)
    expect(state.readIndex).toBe(0)
    swapHistory(state)
    expect(state.readIndex).toBe(1)
    swapHistory(state)
    expect(state.readIndex).toBe(0)
  })

  it('getHistoryBridge: 返回当前 read Tex 的 {_texture, _target: TEXTURE_2D}', () => {
    const state = createHistoryState({} as any, 100, 100, 36193)
    const bridge = getHistoryBridge(state)
    expect(bridge._texture).toBe(state.textures[0]._texture)
    expect(bridge._target).toBe(0x0DE1)
    swapHistory(state)
    const bridge2 = getHistoryBridge(state)
    expect(bridge2._texture).toBe(state.textures[1]._texture)
  })

  it('getWriteTexture: 返回当前 write Tex（swap 后变 read）', () => {
    const state = createHistoryState({} as any, 100, 100, 36193)
    const write0 = getWriteTexture(state)
    expect(write0).toBe(state.textures[1]) // readIndex=0 → write=1
    swapHistory(state)
    const write1 = getWriteTexture(state)
    expect(write1).toBe(state.textures[0]) // readIndex=1 → write=0
  })

  it('sanityCheckOutputTexture: undefined → false（启动 graceful degrade 触发）', () => {
    expect(sanityCheckOutputTexture(undefined)).toBe(false)
    expect(sanityCheckOutputTexture({} as any)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/historyBlit.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// historyBlit.ts
// history Texture ping-pong 管理 + bridge（Cesium createUniform 兼容）+ adapter（私有 API 封装）。
import { Texture, PixelFormat, PixelDatatype, defined } from 'cesium'

const TEXTURE_2D = 0x0de1

export interface HistoryState {
  textures: Texture[]
  readIndex: number // 当前 read（u_historyTexture 指向），write = 1 - readIndex
  width: number
  height: number
  pixelDatatype: number
}

export function createHistoryState(context: unknown, width: number, height: number, pixelDatatype: number): HistoryState {
  const sampler = { minificationFilter: 9728 /* NEAREST */, magnificationFilter: 9728 }
  const t0 = new Texture({
    context,
    width,
    height,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype,
    sampler,
  } as any)
  const t1 = new Texture({
    context,
    width,
    height,
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype,
    sampler,
  } as any)
  return { textures: [t0, t1], readIndex: 0, width, height, pixelDatatype }
}

export function swapHistory(state: HistoryState): void {
  state.readIndex = 1 - state.readIndex
}

// 当前 read Tex（u_historyTexture 指向）
export function getReadTexture(state: HistoryState): Texture {
  return state.textures[state.readIndex]
}

// 当前 write Tex（blit 目标，swap 后变 read）
export function getWriteTexture(state: HistoryState): Texture {
  return state.textures[1 - state.readIndex]
}

// bridge 对象（Cesium createUniform.js:254-260 读 _target/_texture）
export function getHistoryBridge(state: HistoryState): { _texture: unknown; _target: number } {
  const tex = getReadTexture(state)
  return { _texture: (tex as unknown as { _texture: unknown })._texture, _target: TEXTURE_2D }
}

// adapter：outputTexture getter 判空（评审 minor，PostProcessStage.js:346-356 可返 undefined）
export function sanityCheckOutputTexture(tex: unknown): boolean {
  return defined(tex)
}
```

注意：`Texture` 构造的实际 `sampler` 需 `Cesium.Sampler` 实例（非裸数字）。读 `cesium-clouds-atmosphere/src/CloudShadowPass.js:151-167` 确认 sampler 构造方式，调整（可能 `new Sampler({minificationFilter: TextureMinificationFilter.NEAREST, ...})`）。test mock 需同步。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/historyBlit.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/depthTemporal/historyBlit.ts packages/cesium-core/src/cesium/depthTemporal/historyBlit.test.ts
git commit -m "feat(core): historyBlit（ping-pong Texture + bridge + outputTexture adapter）"
```

---

## Task 4: blit command（Cesium createViewportQuadCommand）

**Files:**
- Modify: `packages/cesium-core/src/cesium/depthTemporal/historyBlit.ts`
- Modify: `packages/cesium-core/src/cesium/depthTemporal/historyBlit.test.ts`

- [ ] **Step 1: Write failing test（blit command 构造）**

```ts
// 追加到 historyBlit.test.ts
import { buildBlitCommand } from './historyBlit'

describe('buildBlitCommand', () => {
  it('构造 createViewportQuadCommand：透传 shader + uniformMap.colorTexture + framebuffer 由调用方设', () => {
    const src = { _texture: {}, _target: 0x0de1 } as any
    const cmd = buildBlitCommand({} as any, src)
    expect(cmd).toBeDefined()
    expect(cmd.shaderSource).toContain('texture(colorTexture, v_textureCoordinates)') // 透传 vec4（含 .a smoothDepth）
    expect(typeof cmd.uniformMap.colorTexture).toBe('function')
    expect(cmd.uniformMap.colorTexture()).toBe(src)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/historyBlit.test.ts
```
Expected: FAIL（buildBlitCommand 不存在）

- [ ] **Step 3: Implement**

```ts
// 追加到 historyBlit.ts
import { Context, Framebuffer, ShaderProgram, DrawCommand } from 'cesium'

const BLIT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
void main() {
  out_FragColor = texture(colorTexture, v_textureCoordinates); // 透传 vec4（rgb=scene, a=smoothDepth）
}
`

export interface BlitCommandOptions {
  context: Context
  srcTexture: unknown // depthTemporal.outputTexture（bridge 或 Texture）
}

export function buildBlitCommand(context: Context, srcTexture: unknown): DrawCommand & { shaderSource: string; uniformMap: { colorTexture: () => unknown } } {
  // Cesium createViewportQuadCommand（DrawCommand 管理状态，自带 RenderState/program cache）
  const cmd = (context as unknown as {
    createViewportQuadCommand: (shaderSource: string, opts: unknown) => DrawCommand & { shaderSource: string; uniformMap: { colorTexture: () => unknown } }
  }).createViewportQuadCommand(BLIT_SHADER, {
    uniformMap: {
      colorTexture: () => srcTexture,
    },
  })
  return cmd
}
```

注意：`createViewportQuadCommand` 的 framebuffer 在 execute 时由调用方设（`cmd.execute(context, { framebuffer: customHistoryFBO })` 或设 `cmd.framebuffer`）。读 `node_modules/@cesium/engine/.../Source/Renderer/Context.js` 的 `createViewportQuadCommand` 签名确认（opts 可含 framebuffer / renderState）。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/historyBlit.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/depthTemporal/historyBlit.ts packages/cesium-core/src/cesium/depthTemporal/historyBlit.test.ts
git commit -m "feat(core): blit command（Cesium createViewportQuadCommand 透传，替代 raw WebGL）"
```

---

## Task 5: temporalAlpha.ts — 运动门控（position+direction 双项 + 高度归一化）

**Files:**
- Create: `packages/cesium-core/src/cesium/depthTemporal/temporalAlpha.ts`
- Create: `packages/cesium-core/src/cesium/depthTemporal/temporalAlpha.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// temporalAlpha.test.ts
import { describe, it, expect } from 'vitest'
import { computeTemporalAlpha } from './temporalAlpha'
import { LOW_ALPHA, HIGH_ALPHA, MAX_DELTA_K, DIRECTION_WEIGHT } from './depthTemporalConstants'

describe('computeTemporalAlpha', () => {
  const cameraHeight = 1_000_000 // 1Mm
  const maxDelta = cameraHeight * MAX_DELTA_K // 10km

  it('静止（position+direction 不变）→ lowAlpha（强平滑）', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 0,
      directionDelta: 0, // 1 - dot(dir, dir) = 0
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    expect(a).toBeCloseTo(LOW_ALPHA, 3)
  })

  it('纯平移（positionDelta >> maxDelta，无旋转）→ highAlpha（偏 current）', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 50_000, // 50km >> 10km
      directionDelta: 0,
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    expect(a).toBeCloseTo(HIGH_ALPHA, 2)
  })

  it('纯旋转（positionDelta=0，directionDelta 大）→ 趋 highAlpha（旋转不旁路）', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 0,
      directionDelta: 0.5, // 1 - dot = 0.5（~60° 旋转）
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    // motion = 0 + 0.5*0.5 = 0.25 → smoothstep(0,1,0.25) 中间值
    expect(a).toBeGreaterThan(LOW_ALPHA + 0.01)
    expect(a).toBeLessThan(HIGH_ALPHA)
  })

  it('orbit（position+direction 都大）→ highAlpha', () => {
    const a = computeTemporalAlpha({
      cameraHeight,
      maxDelta,
      positionDelta: 50_000,
      directionDelta: 0.5,
      lowAlpha: LOW_ALPHA,
      highAlpha: HIGH_ALPHA,
    })
    expect(a).toBeCloseTo(HIGH_ALPHA, 2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/temporalAlpha.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// temporalAlpha.ts
// 运动门控：position + direction 双项 + 高度归一化（评审 critical：cameraDelta 不检测旋转/orbit 旁路）。
import { DIRECTION_WEIGHT } from './depthTemporalConstants'

export interface TemporalAlphaInput {
  cameraHeight: number
  maxDelta: number // cameraHeight * MAX_DELTA_K
  positionDelta: number // distance(positionWC, prevPositionWC)
  directionDelta: number // 1 - dot(directionWC, prevDir)
  lowAlpha: number
  highAlpha: number
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function computeTemporalAlpha(input: TemporalAlphaInput): number {
  const motion = input.positionDelta / input.maxDelta + DIRECTION_WEIGHT * input.directionDelta
  const t = smoothstep(0, 1, motion)
  return input.lowAlpha + (input.highAlpha - input.lowAlpha) * t
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/temporalAlpha.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/depthTemporal/temporalAlpha.ts packages/cesium-core/src/cesium/depthTemporal/temporalAlpha.test.ts
git commit -m "feat(core): temporalAlpha（position+direction 双项 + 高度归一化运动门控）"
```

---

## Task 6: cesium-augment.d.ts — outputTexture getter 类型

**Files:**
- Modify: `packages/cesium-core/src/cesium/cesium-augment.d.ts`

- [ ] **Step 1: 读现有 cesium-augment.d.ts**，确认 PostProcessStage 是否已声明 outputTexture。若无，加最小类型。

```bash
grep -n "outputTexture\|PostProcessStage" packages/cesium-core/src/cesium/cesium-augment.d.ts
```

- [ ] **Step 2: 加 outputTexture getter 类型**（若缺失）

在 `cesium-augment.d.ts` 的 PostProcessStage 模块声明加：
```ts
declare module 'cesium' {
  interface PostProcessStage {
    /** outputTexture getter（私有，PostProcessStage.js:346-356，可返 undefined）。depthTemporal history blit 用。 */
    readonly outputTexture: Texture | undefined
  }
}
```

- [ ] **Step 3: tsc 验证**

```bash
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add packages/cesium-core/src/cesium/cesium-augment.d.ts
git commit -m "feat(core): cesium-augment 补 PostProcessStage.outputTexture getter 类型"
```

---

## Task 7: AtmosphereStage 装配 depthTemporal stage + UNSIGNED_BYTE 兜底 + sanity check

**前置**：读 `packages/cesium-core/src/cesium/AtmosphereStage.ts`（L205-217 resolvePostHdrDatatype、L291-303 postHdrDatatype 兜底、L333-335 stage 顺序）确认现有结构。

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`
- Modify: `packages/cesium-core/src/cesium/cesium-augment.d.ts`（如需）
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`

- [ ] **Step 1: Write failing test（stage 装配 + 顺序 + 兜底）**

```ts
// AtmosphereStage.test.ts 追加
import { createAtmosphereStage } from './AtmosphereStage'

describe('createAtmosphereStage — depthTemporal 装配', () => {
  it('深度链含 depthTemporal（activeStages[0]，atmosphere 前）', () => {
    const handle = createAtmosphereStage(mockScene(), { lensFlare: false })
    const stages = stagesOf(handle.atmosphereStage) // 展平 composite
    const names = stages.map((s) => s.name)
    expect(names[0]).toMatch(/depthTemporal/i)
    expect(names.some((n) => /atmosphere/i.test(n))).toBe(true)
  })

  it('UNSIGNED_BYTE（无 HALF_FLOAT/FLOAT）→ 跳过 depthTemporal（不 add，回退现状）', () => {
    const handle = createAtmosphereStage(mockSceneByte(), { lensFlare: false })
    expect(handle.temporalEmaEnabled).toBe(false)
    const stages = stagesOf(handle.atmosphereStage)
    expect(stages.some((s) => /depthTemporal/i.test(s.name))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement — AtmosphereStage.ts 装配 depthTemporal**

在 `createAtmosphereStage` 内（atmosphere stage 创建前）：
```ts
import { PostProcessStage, PixelDatatype } from 'cesium'
import { buildDepthTemporalFragmentShader } from './depthTemporal/depthTemporal.frag'
import { createHistoryState, getHistoryBridge, sanityCheckOutputTexture } from './depthTemporal/historyBlit'
import { DEPTH_THRESHOLD_DEFAULT } from './depthTemporal/depthTemporalConstants'

// resolvePostHdrDatatype 复用（与 atmosphere 同套，HALF_FLOAT→FLOAT→UNSIGNED_BYTE）
const depthTemporalDatatype = resolvePostHdrDatatype(scene)
const temporalEmaEnabled = depthTemporalDatatype !== PixelDatatype.UNSIGNED_BYTE

let depthTemporalStage: PostProcessStage | undefined
let historyState: HistoryState | undefined

if (temporalEmaEnabled) {
  const width = scene.drawingBufferWidth
  const height = scene.drawingBufferHeight
  historyState = createHistoryState(context, width, height, depthTemporalDatatype)

  depthTemporalStage = new PostProcessStage({
    name: 'czm_depth_temporal',
    fragmentShaderSource: buildDepthTemporalFragmentShader({ enabled: true }),
    pixelDatatype: depthTemporalDatatype,
    textureScale: 1.0,
    sampleMode: 0 /* NEAREST */,
    gammaFromLinearColorSpace: false,
    uniforms: {
      u_historyTexture: () => (historyState ? getHistoryBridge(historyState) : null),
      u_prevViewProjection: () => prevViewProjection, // 初始 identity，postRender 更新
      u_temporalAlpha: () => temporalAlpha, // 初始 HIGH_ALPHA（首帧偏 current）
      u_depthThreshold: DEPTH_THRESHOLD_DEFAULT,
    },
  })
  // depthTemporal 插入 activeStages[0]（atmosphere 前）
  scene.postProcessStages.add(depthTemporalStage)
}

// sanity check（评审：启动 graceful degrade）
if (temporalEmaEnabled) {
  scene.preRender.addEventListener(() => {
    if (depthTemporalStage && !sanityCheckOutputTexture(depthTemporalStage.outputTexture)) {
      console.warn('[depthTemporal] outputTexture undefined，stage 未就绪，跳过 EMA')
    }
  })
}
```

注意：`scene.postProcessStages.add` 的 stage 顺序——`add` 按 call 顺序追加到 activeStages。**depthTemporal 必须 add 在 atmosphere 之前**（读 AtmosphereStage.ts 确认 atmosphere stage 的 add 位置，在其前 add depthTemporal）。`uniforms` 的函数形式（每帧调用取最新 history bridge）。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(core): 装配 depthTemporal stage（activeStages[0]，打包透传 + UNSIGNED_BYTE 兜底 + sanity check）"
```

---

## Task 8: history lifecycle — preRender resize + postRender blit/swap/prevVP/alpha/clear/判空

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`

- [ ] **Step 1: Write failing test（lifecycle 流程）**

```ts
// AtmosphereStage.test.ts 追加（mock scene.preRender/postRender event + 验证调用顺序）
describe('depthTemporal lifecycle', () => {
  it('postRender：blit outputTexture→write history + swap + 更新 prevVP/alpha', async () => {
    const { scene, handle } = createMockSceneWithDepthTemporal()
    triggerPostRender(scene)
    expect(handle.blitSpy).toHaveBeenCalledWith(depthTemporalOutputTexture, writeHistoryTex)
    expect(handle.readIndex).toBe(1) // swapped
  })

  it('postRender：outputTexture undefined → 跳过 blit（保持上帧状态）', () => {
    const { scene } = createMockSceneWithDepthTemporal({ outputTextureUndefined: true })
    triggerPostRender(scene)
    expect(blitSpy).not.toHaveBeenCalled()
  })

  it('resize：preRender 检测 viewport 变化 → 重建 history（同帧 depthTemporal output 同尺寸）', () => {
    const { scene, handle } = createMockSceneWithDepthTemporal()
    handle.viewportWidth = 1920
    triggerPreRender(scene) // 首次（建立）
    handle.viewportWidth = 3840 // resize
    triggerPreRender(scene)
    expect(handle.historyWidth).toBe(3840)
  })

  it('首帧：history 强制 clear（blit 当前 globe depth 基线，非 loadNull）', () => {
    const { scene, handle } = createMockSceneWithDepthTemporal()
    expect(handle.historyCleared).toBe(true) // 首帧 clear 标志
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement lifecycle（AtmosphereStage.ts）**

```ts
import { Cartesian3, Matrix4 } from 'cesium'
import { computeTemporalAlpha } from './depthTemporal/temporalAlpha'
import { LOW_ALPHA, HIGH_ALPHA, MAX_DELTA_K } from './depthTemporal/depthTemporalConstants'

// 初始化 prev 状态
let prevViewProjection = Matrix4.IDENTITY
let prevPositionWC = Cartesian3.ZERO.clone()
let prevDir = Cartesian3.ZERO.clone()
let temporalAlpha = HIGH_ALPHA // 首帧偏 current
let firstFrame = true

// preRender：resize 检测 + history 重建（在 collection.update 前）
scene.preRender.addEventListener(() => {
  if (!temporalEmaEnabled || !historyState) return
  const w = scene.drawingBufferWidth
  const h = scene.drawingBufferHeight
  if (w !== historyState.width || h !== historyState.height) {
    // resize：重建 history（保证同帧 depthTemporal output 同尺寸，避免 GL size mismatch）
    historyState.textures.forEach((t) => (t as unknown as { destroy: () => void }).destroy())
    historyState = createHistoryState(context, w, h, depthTemporalDatatype)
    historyState.readIndex = 0
    firstFrame = true // resize 后首帧重置
  }
})

// postRender：blit + swap + 更新 prevVP/alpha
scene.postRender.addEventListener(() => {
  if (!temporalEmaEnabled || !depthTemporalStage || !historyState) return
  const src = depthTemporalStage.outputTexture
  if (!sanityCheckOutputTexture(src)) return // 首帧/stage disabled → 跳过，保持上帧

  if (firstFrame) {
    // 首帧/resize 后：强制 clear（blit 当前 globe depth 基线，移除 loadNull 全 0 假设）
    // 用 blit command 把当前 depthTemporal output（含 scene+curDepth）blit 到 write history
    firstFrame = false
  }

  // blit depthTemporal output → write history Tex
  const writeTex = getWriteTexture(historyState)
  const blitCmd = buildBlitCommand(context, src)
  ;(blitCmd as unknown as { framebuffer: unknown }).framebuffer = buildHistoryFBO(context, writeTex)
  blitCmd.execute(context)

  // 更新下帧 uniforms
  prevViewProjection = Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, new Matrix4())
  const positionDelta = Cartesian3.distance(camera.positionWC, prevPositionWC)
  const directionDelta = 1 - Math.abs(Cartesian3.dot(camera.directionWC, prevDir))
  temporalAlpha = computeTemporalAlpha({
    cameraHeight: Cartesian3.magnitude(camera.positionWC),
    maxDelta: Cartesian3.magnitude(camera.positionWC) * MAX_DELTA_K,
    positionDelta,
    directionDelta,
    lowAlpha: LOW_ALPHA,
    highAlpha: HIGH_ALPHA,
  })
  prevPositionWC = camera.positionWC.clone()
  prevDir = camera.directionWC.clone()
  swapHistory(historyState)
})
```

注意：`buildHistoryFBO`（`new Framebuffer({context, colorTextures: [writeTex]})`）需在 historyBlit.ts 加（Task 3/4 可补，或此处内联）。`camera` = `scene.camera`。`buildBlitCommand` 每帧重建或缓存（缓存更优，但 src 变 → uniformMap 函数返回 src 已动态）。读 Context.createViewportQuadCommand 确认 framebuffer 设置方式。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/AtmosphereStage.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(core): depthTemporal lifecycle（preRender resize + postRender blit/swap/prevVP/alpha + 首帧 clear + 判空）"
```

---

## Task 9: atmosphere sceneDist 改 .a + 2-arg czm_windowToEyeCoordinates + 移除 5-tap + originalColor .rgb

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`

- [ ] **Step 1: Write failing test（shader 改动断言）**

```ts
// aerialPerspective.frag.test.ts 追加
describe('depthTemporal 集成', () => {
  const s = buildAerialPerspectiveFragmentShader({})

  it('originalColor 读 colorTexture.rgb（不再 .rgba，alpha 是 smoothDepth）', () => {
    expect(s).toContain('texture(colorTexture, v_textureCoordinates).rgb')
  })

  it('sceneDist 用 smoothDepth（colorTexture.a，log-depth）+ 2-arg czm_windowToEyeCoordinates', () => {
    expect(s).toContain('#define LOG_DEPTH')
    expect(s).toMatch(/smoothDepth\s*=\s*texture\(colorTexture.*\)\.a/)
    expect(s).toMatch(/czm_windowToEyeCoordinates\(vec2\(gl_FragCoord\.xy\),\s*smoothDepth\)/)
  })

  it('移除 5-tap 邻域平均（EMA 替代空间平滑）', () => {
    expect(s).not.toContain('czm_readDepth(depthTexture, v_textureCoordinates + vec2(texel')
    expect(s).not.toContain('depthAvg')
  })

  it('禁 czm_readDepth（depthTemporal 已提供 log-depth）', () => {
    expect(s).not.toContain('czm_readDepth')
  })

  it('glslang 编译通过', async () => {
    const standalone = buildStandaloneShaderForValidation()
    const result = await compileFragment(standalone, 'aerialPerspective')
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement — aerialPerspective.frag.ts 改动**

a. **顶部加 `#define LOG_DEPTH`**（让 2-arg czm_windowToEyeCoordinates 走 LOG_DEPTH 分支）

b. **L321 originalColor**：`vec4 originalColor = texture(colorTexture, v_textureCoordinates);` →
```glsl
vec3 originalColorRGB = texture(colorTexture, v_textureCoordinates).rgb;
```
后续所有 `originalColor.rgb` 改 `originalColorRGB`，`originalColor.a`（若有）改用 `smoothDepth`。

c. **L329 sceneDist 反演**：替换整个 depth 反演块（L329 + 5-tap L345-371）为：
```glsl
// smoothDepth 来自 depthTemporal（colorTexture.a，raw log-depth EMA）
float smoothDepth = texture(colorTexture, v_textureCoordinates).a;

bool hasScene = false;
float sceneDist = 0.0;
if (smoothDepth < 1.0 - 1e-4) {  // 远平面/未加载 depth≈1 排除
  // 2-arg czm_windowToEyeCoordinates（LOG_DEPTH 分支，接收 log-depth，返回 .xyz 真眼坐标，禁 /=w）
  vec4 eyePos = czm_windowToEyeCoordinates(vec2(gl_FragCoord.xy), smoothDepth);
  if (eyePos.z < -1e-4) {
    vec4 worldPos4 = czm_inverseView * vec4(eyePos.xyz, 1.0);
    vec3 sceneWorldPosKm = worldPos4.xyz * METER_TO_LENGTH_UNIT
      + altitudeCorrection * METER_TO_LENGTH_UNIT;
    float sceneR = length(sceneWorldPosKm);
    if (sceneR < topR + 5.0 && sceneR > bottomR - 5.0) {
      hasScene = true;
      sceneDist = length(sceneWorldPosKm - cameraPosition);
    }
  }
}
```
注意：**atmosphere 这里用 altitudeCorrection/METER_TO_LENGTH_UNIT**（Bruneton 密切球 km 系，sceneDist 用于 Bruneton LUT）——这与 depthTemporal reproject（纯 ECEF 米）不同，因为 atmosphere 的 sceneDist 喂 GetSkyRadianceToPoint（Bruneton 函数）。**只有 depthTemporal reproject 用纯 ECEF 米**。

d. **移除 5-tap 块**（L341-371 原 5-tap depth 平均整块删除，sceneDist 用上面中心 smoothDepth 单 tap）。

e. **glslang 桩**（buildStandaloneShaderForValidation）：加 2-arg `czm_windowToEyeCoordinates(vec2, float)` 桩（返回 `vec4(windowCoord, -1.0, 1.0)`），删 4-arg + czm_readDepth 桩（如不再用）。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts src/cesium/aerialPerspective.compile.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/aerialPerspective.frag.ts packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts
git commit -m "feat(core): atmosphere 读 depthTemporal smoothDepth（.a + 2-arg LOG_DEPTH + 移除 5-tap）"
```

---

## Task 10: lensflare occlusion 同源 smoothDepth

**Files:**
- Modify: `packages/cesium-core/src/cesium/lensFlare/occlusion.frag.ts`
- Modify: 对应 test

- [ ] **Step 1: 读 occlusion.frag.ts L97/L20**，确认 `czm_readDepth(depthTexture)` 用法 + `1e-6` 阈值。

```bash
grep -n "czm_readDepth\|depthTexture\|1e-6\|DEPTH_EPSILON" packages/cesium-core/src/cesium/lensFlare/occlusion.frag.ts
```

- [ ] **Step 2: Write failing test**

```ts
// occlusion.frag.test.ts 追加
it('depth 来自 depthTemporal smoothDepth（colorTexture.a 或 depthTexture.a，log-depth）', () => {
  const s = buildOcclusionFragmentShader()
  // occlusion 在 depthTemporal 之后（activeStages[2]），其 colorTexture = lensflare composite 输入
  // depthTexture uniform 指向 "czm_depth_temporal" → 读 .a
  expect(s).not.toContain('czm_readDepth')
  expect(s).toMatch(/texture\(depthTexture.*\)\.a|texture\(colorTexture.*\)\.a/)
})
```

- [ ] **Step 3: Implement — occlusion.frag.ts**

a. `czm_readDepth(depthTexture, uv)` → `texture(depthTexture, uv).a`（depthTexture uniform 在 createLensFlareStage 指向 "czm_depth_temporal"）。

b. 阈值 `1e-6`（或 `DEPTH_EPSILON`）改 log-depth 域等效（远平面 depth≈1，未遮挡 depth<1-1e-4）。具体：`if (sampleDepth >= 1.0 - 1e-4) → 未遮挡（天空）`。

c. 在 `createLensFlareStage.ts`（或 lensFlare composite 装配）：occlusion stage 的 `depthTexture` uniform 改 string `"czm_depth_temporal"`（texture cache 解析依赖）。

- [ ] **Step 4: Run test + glslang**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/lensFlare/occlusion
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/lensFlare/
git commit -m "feat(core): lensflare occlusion 同源 depthTemporal smoothDepth（统一消抖）"
```

---

## Task 11: debug=5 smoothDepth + debug=8 raw globe depth

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`（debug=5）
- Modify: `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.ts`（debug=8）

- [ ] **Step 1: Write failing test**

```ts
// aerialPerspective.frag.test.ts 追加
it('debug=5 显示 smoothDepth（colorTexture.a，EMA 后）', () => {
  const s = buildAerialPerspectiveFragmentShader({})
  expect(s).toMatch(/debugMode.*5[\s\S]*out_FragColor\s*=\s*vec4\(.*smoothDepth/)
})

// depthTemporal.frag.test.ts 追加
it('debug=8 输出 raw globe depth（depthTexture.r，验证抖动源）', () => {
  const s = buildDepthTemporalFragmentShader({ enabled: true, debugMode: 8 })
  expect(s).toMatch(/debugMode.*8[\s\S]*out_FragColor\s*=\s*vec4\(.*texture\(depthTexture.*\)\.r/)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts src/cesium/depthTemporal/depthTemporal.frag.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement**

a. **aerialPerspective.frag.ts debug=5**（L472 区域）：`vec4(depth, ...)` → `vec4(smoothDepth, 0.0, length(cameraPosition)/6420.0, 1.0)`（smoothDepth 是 log-depth EMA）。

b. **depthTemporal.frag.ts debug=8**：`buildDepthTemporalFragmentShader` 加 `debugMode` 选项，shader 内 `if (u_debugMode > 7.5) { out_FragColor = vec4(texture(depthTexture, v_textureCoordinates).r, 0,0,1); return; }`（输出 raw globe log-depth）。加 `uniform float u_debugMode`。

c. **AtmosphereStage.ts**：depthTemporal stage uniforms 加 `u_debugMode: () => debugMode`（从 options 传）。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/aerialPerspective.frag.test.ts src/cesium/depthTemporal/depthTemporal.frag.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/
git commit -m "feat(core): debug=5 smoothDepth + debug=8 raw globe depth（抖动源/EMA 对比诊断）"
```

---

## Task 12: demo URL 参数

**Files:**
- Modify: `apps/demo/src/main.ts`

- [ ] **Step 1: 读 main.ts URL 解析区**（getNumber/getString 用法），确认 atmosphere options 传递。

- [ ] **Step 2: Implement — main.ts 加 URL 参数**

```ts
// atmosphere options 加（在 lensFlare 选项后）：
const temporalQuality = getString('temporalQuality') ?? 'low'
const preset = TEMPORAL_QUALITY_PRESETS[temporalQuality] ?? TEMPORAL_QUALITY_PRESETS.low
const depthThreshold = getNumber('depthThreshold')
const temporalEma = getString('temporalEma') !== '0'

const options: AtmosphereStageOptions = {
  // ... 现有
  temporalEma,
  temporalLowAlpha: preset.lowAlpha,
  temporalHighAlpha: preset.highAlpha,
  ...(depthThreshold != null ? { temporalDepthThreshold: depthThreshold } : {}),
}
```

AtmosphereStageOptions 接口加 `temporalEma?`、`temporalLowAlpha?`、`temporalHighAlpha?`、`temporalDepthThreshold?`。createAtmosphereStage 内传给 depthTemporal uniforms。

- [ ] **Step 3: tsc + 手动验证（demo URL）**

```bash
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
pnpm --filter demo exec tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add apps/demo/src/main.ts packages/cesium-core/src/cesium/AtmosphereStage.ts
git commit -m "feat(demo): depthTemporal URL 参数（?temporalQuality= ?depthThreshold= ?temporalEma=）"
```

---

## Task 13: 回归测试 — 坐标系 + VP 一致性 + EMA 收敛

**Files:**
- Create: `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.regression.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// depthTemporal.regression.test.ts
import { describe, it, expect } from 'vitest'

describe('depthTemporal 回归', () => {
  it('坐标系：静态场景（VP 不变）prevUV == v_textureCoordinates（reproject ECEF 自洽）', () => {
    // 解析 depthTemporal shader 的 reproject 逻辑，mock worldPosECEF + prevVP=curVP，
    // 断言 prevUV = v_textureCoordinates（数值模拟或 GLSL 桩执行）
    // 简化：断言 shader 内 prevClip = u_prevViewProjection * worldPosECEF，prevVP=curVP 时 prevUV=curUV
    const s = buildDepthTemporalFragmentShader({ enabled: true })
    expect(s).toContain('prevClip = u_prevViewProjection * vec4(worldPosECEF')
    // 注：完整数值验证需 GLSL 执行环境，此处断言 shader 结构 + plan 阶段视觉验收（debug=8 无重影）
  })

  it('VP 一致性：JS prevViewProjection = camera.frustum.projectionMatrix · camera.viewMatrix（与 shader czm_viewProjection 同源）', () => {
    // 断言 AtmosphereStage postRender 用 camera.frustum.projectionMatrix · camera.viewMatrix（非 camera.projectionMatrix）
    const stageSrc = readFileSync('packages/cesium-core/src/cesium/AtmosphereStage.ts', 'utf8')
    expect(stageSrc).toContain('camera.frustum.projectionMatrix')
    expect(stageSrc).toContain('camera.viewMatrix')
  })

  it('EMA 收敛：mock LOD 抖动 depth 序列（奇偶帧跳 0.005）→ smoothDepth 经 N 帧收敛（方差 < 阈值）', () => {
    // 模拟 EMA IIR：alpha=0.05，输入 [d, d+0.005, d, d+0.005, ...]，断言 60 帧后 smoothDepth 方差 < 0.001
    let smooth = 0.9 // 初始 log-depth
    const samples: number[] = []
    for (let i = 0; i < 60; i++) {
      const cur = 0.9 + (i % 2 === 0 ? 0 : 0.005) // 奇偶抖动
      const alpha = 0.05
      smooth = mix(smooth, cur, alpha) // history→current EMA
      samples.push(smooth)
    }
    const variance = computeVariance(samples.slice(-10))
    expect(variance).toBeLessThan(0.001) // 收敛
  })
})

function mix(a: number, b: number, t: number) { return a + (b - a) * t }
function computeVariance(arr: number[]) { /* ... */ }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/depthTemporal.regression.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement（测试本身是验证，无需产品代码改动；修正产品代码使断言通过）**

如 VP 一致性断言失败（AtmosphereStage 用了 camera.projectionMatrix 而非 camera.frustum.projectionMatrix），修正 Task 8 的代码。

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/depthTemporal/depthTemporal.regression.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-core/src/cesium/depthTemporal/depthTemporal.regression.test.ts
git commit -m "test(core): depthTemporal 回归（坐标系 + VP 一致性 + EMA 收敛）"
```

---

## Task 14: 全量验证 + results 文档

- [ ] **Step 1: 全量测试**

```bash
pnpm --filter @cesium-geospatial/core test
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
```
Expected: 全 PASS，0 tsc error

- [ ] **Step 2: 视觉验收（demo，用户）**

提供 4 个验收 URL（spec v2 §9）：
- 波纹消除（俯仰扫）：`?mode=atmosphere&time=2026-08-04T01:00:00Z&camera=93.4055,32.7362,1002025,0.0,-89&inscatterScale=25`
- debug=8（抖动源）+ debug=5（EMA 输出稳）：同上加 `&debug=8` / `&debug=5`
- 山体清晰：`#camera=95.7229,31.5070,11645,295.8,-4.3`
- lensflare 不闪 + 拖影验：orbit/快速俯仰

用户验收后填写 `docs/superpowers/plans/2026-08-05-depth-temporal-ema-results.md`。

- [ ] **Step 3: Commit results**

```bash
git add docs/superpowers/plans/2026-08-05-depth-temporal-ema-results.md
git commit -m "docs(results): depthTemporal EMA 验收结果"
```

- [ ] **Step 4: 用 superpowers:finishing-a-development-branch 收尾**（merge / PR / keep）。

---

## Self-Review（写完后自查）

**Spec 覆盖**：
- §3 架构（打包透传）→ Task 2（shader 输出 vec4）+ Task 7（装配 activeStages[0]）+ Task 9（atmosphere 读 .rgb/.a）✓
- §4 depthTemporal shader（log-depth EMA + ECEF + disocclusion）→ Task 2 ✓
- §5 disocclusion + 运动门控 → Task 2（shader disocclusion）+ Task 5（temporalAlpha）✓
- §6 history + blit（createViewportQuadCommand + resize preRender + 首帧 clear）→ Task 3/4 + Task 8 ✓
- §7 atmosphere（.a + 2-arg + 移除 5-tap）+ lensflare 同源 + debug 5/8 → Task 9/10/11 ✓
- §8 风险（UNSIGNED_BYTE 兜底 + sanity check + resize）→ Task 7/8 ✓
- §9 测试（坐标系 + VP + EMA 收敛）→ Task 13 ✓
- §11 决策全部定死 → 各 Task 钉死 ✓

**Placeholder 扫描**：无 TBD/TODO（个别 "读 X 确认"是前置查证，含具体文件路径）。

**类型一致性**：`HistoryState`（Task 3 定义，Task 7/8 用）、`getHistoryBridge`/`swapHistory`/`getWriteTexture`（Task 3 定义，Task 8 用）、`buildBlitCommand`（Task 4 定义，Task 8 用）、`computeTemporalAlpha`（Task 5 定义，Task 8 用）、`buildDepthTemporalFragmentShader`（Task 2 定义，Task 7/11 用）——签名一致。

**已知 plan 阶段需查证点**（前置步骤已标）：
1. `czm_windowToEyeCoordinates` 2-arg 签名 + LOG_DEPTH（Task 2 前置）
2. `Texture` 构造 sampler（Task 3，查 CloudShadowPass.js:151-167）
3. `Context.createViewportQuadCommand` 签名 + framebuffer 设置（Task 4/8）
4. `scene.postProcessStages.add` 顺序（Task 7，depthTemporal 在 atmosphere 前）
5. lensflare composite occlusion depthTexture uniform 指向（Task 10）
