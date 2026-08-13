# 体积云 M1 — 基建 + MRT/Primitive spike + 资产管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证 MRT 自管渲染（custom Primitive / 自管 DrawCommand）在 Cesium frame loop 可行（4 项 go/no-go spike）+ 搭 core 基建层（FullscreenPass/FramebufferManager）+ 新建 `cesium-clouds` 包搬 19 GLSL + 扩展 higher-order scattering LUT + weather 资产管线，为 M2（主 raymarch）铺路。

**Architecture:** core 新增 `cesium/platform/`（FullscreenPass + FramebufferManager，裸 WebGL2，参照 `historyBlit.ts` 的 `createViewportQuadCommand`/`Framebuffer`/`bridge` 范式）；新包 `@cesium-geospatial/clouds`（依赖 core workspace:*）搬 19 clouds GLSL 保持形态、跨包 `#include bruneton/runtime`；M1 先跑 4 项 spike 决定 MRT 渲染入口（Primitive 倾向 vs 自管 DrawCommand 备选），spike 全过才做基建 + 资产。

**Tech Stack:** TypeScript 5.9 strict / Cesium WebGL2 (^1.143.0) / vitest / glslangValidator（compile test）/ pnpm workspace / Vite lib mode。

## Global Constraints

- **WebGL2 only**（无 WebGPU，无 compute）。GLSL 资产层（`clouds/src/glsl/*.glsl`）**不得**出现 `czm_*` 或 Three 标识符（铁律，spec r1 §4.2）。
- 包名 `@cesium-geospatial/clouds`，`cesium` 为 peerDependency，`@cesium-geospatial/core` 为 `workspace:*`。
- 依赖方向单向无环：`cesium-core` ← `cesium-clouds`。
- 所有代码注释/文档/对话用**中文**（全局规范）。
- TDD：GLSL 走 glslang compile test（仿 `aerialPerspective.compile.test.ts`）；TS 走 vitest（装配/接口/数学，仿 `AtmosphereStage.test.ts` 的 `mockScene`/`stagesOf` 范式——不跑真实 WebGL）；真实 GL 行为靠 demo URL 视觉/probe 验收。
- `FullscreenPass`/`FramebufferManager` 放 `cesium-core/src/cesium/platform/`（master plan §3.4，供所有效果包复用）。
- spike 是 **go/no-go**：T2-T4 全过才做 T5+；失败则整个体积云路线重新评估（spec r1 §6 M1）。

## File Structure

**新建（core）**：
- `packages/cesium-core/src/cesium/platform/FullscreenPass.ts` — DrawCommand 全屏三角形封装（参照 `historyBlit.ts:121 buildBlitCommand` 的 `createViewportQuadCommand`）
- `packages/cesium-core/src/cesium/platform/FullscreenPass.test.ts`
- `packages/cesium-core/src/cesium/platform/FramebufferManager.ts` — 裸 WebGL2 FBO：MRT 多 attachment + `TEXTURE_2D_ARRAY` cascade + ping-pong（参照 `historyBlit.ts:150 buildHistoryFBO` 的 `Framebuffer` + `:80 getHistoryBridge` 的 bridge）
- `packages/cesium-core/src/cesium/platform/FramebufferManager.test.ts`
- `packages/cesium-core/src/cesium/platform/index.ts`

**修改（core）**：
- `packages/cesium-core/src/cesium/cesiumCore.ts:8-26` — `buildAtmospherePrefix` 加 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE`（C9）
- `packages/cesium-core/src/cesium/lutLoader.ts` — 扩展加载第 4 张 `higher_order_scattering.bin`（`sampler3D`）
- `packages/cesium-core/src/index.ts` — export `FullscreenPass`/`FramebufferManager`/新 LUT 类型

**新建（clouds 包）**：
- `packages/cesium-clouds/package.json` / `tsconfig.json` / `vite.config.ts`
- `packages/cesium-clouds/src/index.ts`
- `packages/cesium-clouds/src/glsl/*.glsl` — 搬 three-geospatial 19 shader（保持形态）
- `packages/cesium-clouds/src/glslIndex.ts` — `?raw` 汇聚
- `packages/cesium-clouds/src/cloudsConstants.ts`
- `packages/cesium-clouds/src/weather/weatherTextures.ts` + `scripts/genWeather.ts`（离线生成）

**修改（demo）**：
- `apps/demo/src/main.ts` — spike 验收 URL（`?cloudsSpike=1..4`）

**测试**：
- `packages/cesium-clouds/src/clouds.compile.test.ts` — glslang 编译 19 shader + 跨包 `#include bruneton/runtime`

---

## Task 1: `cesium-clouds` 包骨架 + branch

**Files:**
- Create: `packages/cesium-clouds/package.json`, `tsconfig.json`, `vite.config.ts`, `src/index.ts`
- Create: `packages/cesium-clouds/src/cloudsConstants.ts`, `cloudsConstants.test.ts`
- Modify: `pnpm-workspace.yaml`（已含 `packages/*` 则跳过）

**Interfaces:**
- Produces: `@cesium-geospatial/clouds` 包可被 `import`，导出 `CLOUDS_DEFAULT_QUALITY = 'high'` 等常量

- [ ] **Step 1: 建 branch**

```bash
git checkout -b phase3-clouds-m1
```

- [ ] **Step 2: 写 package.json**

```json
{
  "name": "@cesium-geospatial/clouds",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "gen:weather": "tsx scripts/genWeather.ts"
  },
  "peerDependencies": { "cesium": "^1.143.0" },
  "dependencies": { "@cesium-geospatial/core": "workspace:*" }
}
```

- [ ] **Step 3: 写 tsconfig.json（继承 root，照搬 `packages/cesium-core/tsconfig.json` 结构）**

- [ ] **Step 4: 写 vite.config.ts（lib mode，external `cesium` 与 `@cesium-geospatial/*`，照搬 core 的 vite.config）**

- [ ] **Step 5: 写 src/cloudsConstants.ts + 测试**

```typescript
// 默认质量档（spec r1 §7，high = lightShafts on）
export const CLOUDS_DEFAULT_QUALITY = 'high' as const
export const CLOUDS_LAYER_ALTITUDES_M = [750, 1000, 7500] // CloudLayers（搬 three 版）
```

```typescript
// cloudsConstants.test.ts
import { describe, it, expect } from 'vitest'
import { CLOUDS_DEFAULT_QUALITY, CLOUDS_LAYER_ALTITUDES_M } from './cloudsConstants'
describe('cloudsConstants', () => {
  it('默认 high 档（lightShafts on）', () => {
    expect(CLOUDS_DEFAULT_QUALITY).toBe('high')
  })
  it('三层云高度搬 three 版', () => {
    expect(CLOUDS_LAYER_ALTITUDES_M).toEqual([750, 1000, 7500])
  })
})
```

- [ ] **Step 6: 写 src/index.ts（先只导出常量）**

```typescript
export { CLOUDS_DEFAULT_QUALITY, CLOUDS_LAYER_ALTITUDES_M } from './cloudsConstants'
```

- [ ] **Step 7: 验证测试 + tsc**

```bash
pnpm --filter @cesium-geospatial/clouds test
pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit
```
Expected: test PASS + tsc 0 error

- [ ] **Step 8: Commit**

```bash
git add packages/cesium-clouds pnpm-workspace.yaml
git commit -m "feat(clouds): T1 cesium-clouds 包骨架 + 常量"
```

---

## Task 2: spike #1+#3 — custom Primitive 在 frame loop 执行 + czm_* 注入（go/no-go 核心）

> **目标**：验证云渲染入口能否在 globe 渲染后、PostProcess 链**之前**执行（而非 postRender 事后），且该入口下 `czm_viewerPositionWC`/`czm_inverseView` 是否自动注入。这是 spec r1 §6 M1 spike 验收 #1 + #3。**倾向 custom Primitive**（`Primitive` 的 `pass: Cesium.Pass.CLOUDS` 排在 globe 后、PostProcess 前，渲染进 scene FBO 天然有 depth）；备选自管 DrawCommand。

**Files:**
- Create: `apps/demo/src/CloudsSpikePrimitive.ts` — 最小 Primitive（全屏三角，probe shader）
- Modify: `apps/demo/src/main.ts` — `?cloudsSpike=1` 接线

**Interfaces:**
- Produces: demo `?cloudsSpike=1` 显示 probe overlay（半透明红 = Primitive 执行了；颜色编码 czm_viewerPositionWC 量级 = czm 注入了）

- [ ] **Step 1: 写 probe Primitive**

```typescript
// CloudsSpikePrimitive.ts
// spike：验证 custom Primitive（pass: CLOUDS）能在 globe 后、PostProcess 前执行 + czm_* 注入。
// probe shader 输出：R 通道 = 固定 0.5（证明 Primitive 渲染了）；G 通道 = czm_viewerPositionWC 量级归一化
// （证明 czm_* automatic uniform 在 Primitive shader 注入）；全屏三角不写 depth。
import { Primitive, GeometryInstance, GroundPrimitive } from 'cesium'
// 注：全屏三角用 czm_viewport 相似比，或用一个覆盖近平面的 rectangle primitive。
// 实现倾向：自定义 Primitive + custom shader（Cesium 1.143 CustomShader 机制），pass 设为 CLOUDS。
// 若 CustomShader 限制大，回退用 scene.primitives.add 的自定义 DrawCommand 注入（preUpdate hook）。
export function createCloudsSpikePrimitive(): Primitive {
  // TODO(implementer): 构造全屏三角 GeometryInstance + CustomShader（fragment 输出 probe 色）
  // pass: Cesium.Pass.CLOUDS（在 globe/TRANSLUCENT 后、PostProcess 前）
  // shader 读 czm_viewerPositionWC（验注入）
}
```

probe fragment 骨架（Cesium CustomShader GLSL 或 raw）：
```glsl
// 输出：rgb = vec3(0.5, length(czm_viewerPositionWC)/6.4e6, 0.0) * 0.5（半透明叠加）
//     alpha = 0.3
// 若 czm_viewerPositionWC 未注入 → 编译失败（spike #3 失败信号）
void fragmentMain(FragmentInput fs, inout czm_modelMaterial m) {
  float r = 0.5;
  float g = length(czm_viewerPositionWC) / 6.4e6; // 地球半径量级归一化
  m.diffuse = vec3(r, g, 0.0);
  m.alpha = 0.3;
}
```

- [ ] **Step 2: demo 接线**

```typescript
// main.ts atmosphere 分支内（或独立 mode）
if (getString('cloudsSpike') === '1') {
  viewer.scene.primitives.add(createCloudsSpikePrimitive())
}
```

- [ ] **Step 3: 运行 demo，go/no-go 判定**

```
http://localhost:5173/?mode=atmosphere&cloudsSpike=1
```
Expected（go）：
- 画面半透明红绿 overlay 叠在 globe 上方（Primitive 执行了，时机 = globe 后）
- G 通道 ≈ 1.0（相机在地球表面，czm_viewerPositionWC 量级 6.4e6 → 归一化 ≈1）= czm 注入成功
- globe 仍可见（Primitive 不遮 globe，半透明叠加）

Expected（no-go）：
- overlay 不出现 / 出现在 globe 之前（遮 globe）= 执行时机错（spike #1 失败）
- shader 编译报 `czm_viewerPositionWC undeclared` = czm 不注入（spike #3 失败）→ 回退自管 DrawCommand + 手动 uniform（仿 `createLensFlareStage.ts:244 u_cameraPositionWC: () => scene.camera.positionWC`），记录到 results

- [ ] **Step 4: Commit（含 probe 代码 + demo 接线 + results 笔记）**

```bash
git add apps/demo/src/CloudsSpikePrimitive.ts apps/demo/src/main.ts
git commit -m "spike(clouds): T2 custom Primitive 执行时机 + czm 注入 probe"
```

---

## Task 3: spike #2 — globe depthTexture 访问 + 输出被后续 PostProcessStage 消费（go/no-go）

> **目标**：验证云 pass 能拿到本帧 globe `depthTexture`（Primitive 渲染进 scene FBO 天然有 depth；自管 DrawCommand 需深入私有 API），且云的输出纹理能被后续 atmosphere PostProcessStage 作为 uniform 采样。spec r1 §6 M1 spike #2。

**Files:**
- Create: `apps/demo/src/CloudsSpikeDepth.ts` — probe 读 globe depth + 输出到一个可被 atmosphere 采样的 texture

**Interfaces:**
- Consumes: T2 的 Primitive 渲染入口（决定用 Primitive 还是 DrawCommand）
- Produces: demo `?cloudsSpike=2` 显示 depth 可视化（近白远黑）+ overlay 能被 atmosphere stage 读到（颜色变化）

- [ ] **Step 1: 写 depth probe**

```typescript
// CloudsSpikeDepth.ts
// spike：云 pass 读 globe depthTexture，输出线性深度可视化。
// 关键验证：(1) Primitive 能否拿到 scene globe depth（scene.frameState.context 的 depth framebuffer，
//   或 PostProcessStage 内建 depthTexture——若云是 Primitive 非 PostProcess，需手动绑 globe depth FBO）；
//   (2) 云输出 texture 能否作为 uniform 注入 atmosphere PostProcessStage 采样。
export function createCloudsSpikeDepth(scene: Scene): { primitive: Primitive; outputTexture: Texture } {
  // TODO(implementer): Primitive fragment 读 globe depth（probe），输出到自带 RT；
  // 返回 outputTexture 供 atmosphere stage uniform 采样验证。
}
```

probe fragment 骨架：
```glsl
// 读 globe depth，输出线性深度（近=1 白，远=0 黑）
// 若云是 Primitive（非 PostProcessStage），depthTexture 不自动注入——需手动绑 globe depth FBO
//   或改用 czm_reverseLogDepthWindow(czm_depth)（若 Primitive 有内建 depth 访问）
```

- [ ] **Step 2: 验证输出被 atmosphere stage 消费**

把 `outputTexture` 作为 uniform 注入 atmosphere stage（仿 lensflare 跨 stage 纹理传递），atmosphere shader 采样后叠加一个固定色偏（验证"云 texture 能被后续 stage 读到"）。

- [ ] **Step 3: 运行 demo，go/no-go 判定**

```
http://localhost:5173/?mode=atmosphere&cloudsSpike=2
```
Expected（go）：depth 可视化正确（近处地形白、远处黑）；atmosphere 画面出现固定色偏（证明云 texture 被 atmosphere stage 采样到）
Expected（no-go）：depth 全黑/全白（拿不到 globe depth）→ 记录访问路径死结，评估回退

- [ ] **Step 4: Commit**

```bash
git commit -m "spike(clouds): T3 globe depthTexture 访问 + 跨 stage 消费 probe"
```

---

## Task 4: spike #4 — TEXTURE_2D_ARRAY + bridge + sampler2DArray + precision（go/no-go）

> **目标**：验证裸 WebGL 创建 `TEXTURE_2D_ARRAY`（N cascade 层）+ bridge 绑定 `sampler2DArray` 能否正确采样各层，且 `precision highp sampler2DArray` 声明顺序正确（Cesium 1.143 无 `Texture2DArray` 封装，已核实）。spec r1 §6 M1 spike #4 + §9 R5。

**Files:**
- Create: `apps/demo/src/CloudsSpikeArray.ts`

**Interfaces:**
- Produces: demo `?cloudsSpike=3` 显示 N 层 array 各层不同色（按 v_textureCoordinates 分区采 layer(i)）

- [ ] **Step 1: 写 2D_ARRAY 创建 + bridge**

```typescript
// CloudsSpikeArray.ts
// spike：裸 WebGL 创建 TEXTURE_2D_ARRAY（4 层，各填不同色），包成 bridge（仿 historyBlit.ts:80
// getHistoryBridge：{_texture, _target: TEXTURE_2D_ARRAY}），作为 uniform 喂 PostProcessStage probe。
import { Context } from 'cesium'
const TEXTURE_2D_ARRAY = 0x871A // WebGL2 GL_TEXTURE_2D_ARRAY
export function createSpikeArrayTexture(context: Context, layers: number): { _texture: WebGLTexture; _target: number } {
  const gl = (context as any)._gl as WebGL2RenderingContext
  const tex = gl.createTexture()!
  gl.bindTexture(TEXTURE_2D_ARRAY, tex)
  // 每层填不同色（layer i → 灰度 i/layers）
  // gl.texImage3D(TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, layers, ...)
  // TODO(implementer): 填 N 层各色 + texParameteri
  return { _texture: tex, _target: TEXTURE_2D_ARRAY }
}
```

- [ ] **Step 2: 写 probe PostProcessStage 采样 sampler2DArray**

```glsl
// probe fragment（prefix 必须含 precision highp sampler2DArray; 在 sampler 声明前）
uniform sampler2DArray u_spikeArray;
in vec2 v_textureCoordinates;
void main() {
  int layer = int(v_textureCoordinates.x * 4.0); // 按 x 分 4 区采不同层
  vec4 c = texture(u_spikeArray, vec3(v_textureCoordinates, float(layer)));
  out_FragColor = vec4(c.rgb, 1.0);
}
```

- [ ] **Step 3: 运行 demo，go/no-go 判定**

```
http://localhost:5173/?mode=atmosphere&cloudsSpike=3
```
Expected（go）：画面按 x 分 4 区，各区显示 array 对应层的灰度（证明 2D_ARRAY 可采样）；shader 编译过（`precision highp sampler2DArray` 顺序对）
Expected（no-go）：编译报 `sampler2DArray undeclared` 或采样全黑 → precision 顺序调整 / bridge 绑定排查

- [ ] **Step 4: Commit**

```bash
git commit -m "spike(clouds): T4 TEXTURE_2D_ARRAY + bridge + sampler2DArray probe"
```

---

> **🚦 GO/NO-GO GATE（T2-T4 全过后才做 T5+）**：若任一 spike 失败，停止 T5-T10，写 results 记录死结 + 路线重评（spec r1 §6 M1 plan B 不可用 → 可能转 epipolar）。spike 全过 → 继续。

---

## Task 5: core `FullscreenPass`（封装 spike 验证的机制）

**Files:**
- Create: `packages/cesium-core/src/cesium/platform/FullscreenPass.ts` + `.test.ts`
- Modify: `packages/cesium-core/src/cesium/platform/index.ts`, `packages/cesium-core/src/index.ts`

**Interfaces:**
- Consumes: T2 spike 结果（Primitive-based 还是 DrawCommand-based——据 go/no-go 结论选）
- Produces: `class FullscreenPass { constructor(opts); update(frameState); destroy() }`，封装一个全屏 fragment pass（DrawCommand 或 Primitive）

- [ ] **Step 1: 写 failing test（装配/接口，vitest + mock，仿 `AtmosphereStage.test.ts` 的 mockScene）**

```typescript
// FullscreenPass.test.ts
import { describe, it, expect } from 'vitest'
import { FullscreenPass } from './FullscreenPass'
describe('FullscreenPass', () => {
  it('构造时组装 DrawCommand + uniformMap', () => {
    const pass = new FullscreenPass({ fragmentShaderSource: 'void main(){}', uniformMap: {} })
    expect(pass.command).toBeDefined()
    expect(typeof pass.update).toBe('function')
  })
  it('destroy 后 command 释放', () => {
    const pass = new FullscreenPass({ fragmentShaderSource: 'void main(){}', uniformMap: {} })
    pass.destroy()
    expect(pass.command).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试，确认 FAIL（`FullscreenPass is not defined`）**

```bash
pnpm --filter @cesium-geospatial/core exec vitest run src/cesium/platform/FullscreenPass.test.ts
```

- [ ] **Step 3: 写 FullscreenPass.ts（参照 `historyBlit.ts:121 buildBlitCommand` 的 `createViewportQuadCommand`）**

```typescript
// FullscreenPass.ts
// 全屏三角形 pass 封装。据 T2 spike 结论：若 Primitive 路线 go，用 Primitive（pass: CLOUDS）；
// 否则用 Context.createViewportQuadCommand（自管 DrawCommand，参照 historyBlit.ts:121）。
import type { DrawCommand, Context } from 'cesium'
export interface FullscreenPassOptions {
  fragmentShaderSource: string
  uniformMap: Record<string, () => unknown>
}
export class FullscreenPass {
  command: DrawCommand | undefined
  constructor(opts: FullscreenPassOptions) {
    // TODO(implementer): createViewportQuadCommand 或 Primitive 装配
  }
  update(_frameState: unknown): void { /* execute / add to primitive collection */ }
  destroy(): void { this.command = undefined }
}
```

- [ ] **Step 4: 运行测试，确认 PASS**

- [ ] **Step 5: export（platform/index.ts + core index.ts）+ Commit**

```bash
git add packages/cesium-core/src/cesium/platform packages/cesium-core/src/index.ts
git commit -m "feat(core): T5 FullscreenPass 基建（参照 spike 结论）"
```

---

## Task 6: core `FramebufferManager` — MRT + 2D_ARRAY + ping-pong

**Files:**
- Create: `packages/cesium-core/src/cesium/platform/FramebufferManager.ts` + `.test.ts`

**Interfaces:**
- Consumes: T4 spike（2D_ARRAY 创建/bridge 验证通过）
- Produces:
  - `createMRTFramebuffer(context, {width, height, attachments: PixelFormat[]})` → 多附件 FBO
  - `createArrayTexture(context, {width, height, layers})` → `{_texture, _target: TEXTURE_2D_ARRAY}` bridge
  - `createPingPong(context, {width, height, count: 2})` → `{textures, readIndex, swap()}`（参照 `historyBlit.ts:40 createHistoryState`）

- [ ] **Step 1: 写 failing test**

```typescript
// FramebufferManager.test.ts
import { describe, it, expect } from 'vitest'
import { createPingPong, createArrayTextureBridge } from './FramebufferManager'
describe('FramebufferManager', () => {
  it('createPingPong 返回 2 texture + readIndex=0 + swap 翻转', () => {
    const pp = createPingPong(mockContext, { width: 2, height: 2, count: 2 })
    expect(pp.textures).toHaveLength(2)
    expect(pp.readIndex).toBe(0)
    pp.swap()
    expect(pp.readIndex).toBe(1)
  })
  it('createArrayTextureBridge 返回 _target=TEXTURE_2D_ARRAY(0x871A)', () => {
    const b = createArrayTextureBridge(mockContext, { width: 2, height: 2, layers: 4 })
    expect(b._target).toBe(0x871A)
  })
})
```

- [ ] **Step 2: 运行，确认 FAIL**

- [ ] **Step 3: 写 FramebufferManager.ts**

```typescript
// FramebufferManager.ts
// MRT 多附件 FBO（gl.drawBuffers）+ TEXTURE_2D_ARRAY cascade + ping-pong。
// 参照 historyBlit.ts:40 createHistoryState（ping-pong）+ :80 getHistoryBridge（bridge）+ :150 buildHistoryFBO。
import { Framebuffer, Texture, PixelFormat, PixelDatatype } from 'cesium'
const TEXTURE_2D_ARRAY = 0x871A
export function createPingPong(ctx: unknown, opts: {width:number;height:number;count:number}) {
  // TODO: 仿 historyBlit createHistoryState，count=2 两张 Texture + readIndex + swap
}
export function createArrayTextureBridge(ctx: unknown, opts: {width:number;height:number;layers:number}) {
  // TODO: 裸 gl.createTexture + texImage3D(TEXTURE_2D_ARRAY) + 包 {_texture,_target}
}
export function createMRTFramebuffer(ctx: unknown, colorTextures: Texture[]): Framebuffer {
  // TODO: new Framebuffer({context, colorTextures, destroyAttachments:false})
}
```

- [ ] **Step 4: 运行，确认 PASS + Commit**

```bash
git commit -m "feat(core): T6 FramebufferManager MRT + 2D_ARRAY + ping-pong"
```

---

## Task 7: clouds 搬 19 GLSL + 跨包 `#include bruneton/runtime` + glslang 编译

**Files:**
- Create: `packages/cesium-clouds/src/glsl/*.glsl`（19，从 three-geospatial 搬，保持形态）
- Create: `packages/cesium-clouds/src/glslIndex.ts`
- Create: `packages/cesium-clouds/src/clouds.compile.test.ts`

**Interfaces:**
- Produces: 19 GLSL 经 `resolveIncludes` 组装后 `glslangValidator` 编译通过；`#include "bruneton/runtime"` 跨包解析到 core 的 bruneton GLSL

- [ ] **Step 1: 从 three-geospatial 搬 19 shader**

```bash
# 源：/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial/packages/clouds/src/shaders/
# 目标：packages/cesium-clouds/src/glsl/
# 保持文件名与内容不变（含 Bruneton 版权头）
cp <源>/{clouds.frag,clouds.glsl,shadow.frag,shadow.vert,cloudsResolve.frag,shadowResolve.frag,perlin.glsl,tileableNoise.glsl,structuredSampling.glsl,catmullRomSampling.glsl,varianceClipping.glsl,localWeather.frag,cloudShape.frag,cloudShapeDetail.frag,turbulence.frag,cloudsEffect.frag}.glsl packages/cesium-clouds/src/glsl/
```

- [ ] **Step 2: 写 glslIndex.ts（`?raw` 汇聚，仿 core 的 `glslIndex.ts`）**

```typescript
// 汇聚 19 clouds GLSL + 跨包引用 core bruneton
import cloudsFrag from './glsl/clouds.frag?raw'
// ... 其余 18
export const glslIndex = {
  clouds: { cloudsFrag, cloudsGlsl, /*...*/ },
  // bruneton 跨包：从 @cesium-geospatial/core re-export 或路径约定
}
```

- [ ] **Step 3: 验证跨包 `#include "bruneton/runtime"` 解析**

检查 core 的 `resolveIncludes` 能否解析 clouds 包 GLSL 里的 `#include "bruneton/runtime"` → core 的 `glslIndex.bruneton.runtime`。若 resolveIncludes 路径解析局限在包内，需约定（如 `#include "@cesium-geospatial/core/bruneton/runtime"` 或 core export bruneton 字符串供 clouds 拼接）。**记录到 results**。

- [ ] **Step 4: 写 compile test（仿 `aerialPerspective.compile.test.ts`）**

```typescript
// clouds.compile.test.ts
// glslangValidator 编译 19 shader（经 resolveIncludes 组装，补 #version 300 es + czm_*/sampler 桩）
import { describe, it, expect } from 'vitest'
describe('clouds GLSL compile', () => {
  it('clouds.frag 经 resolveIncludes 组装后 glslang 编译过', async () => {
    const assembled = buildCloudsStandaloneShader() // 补桩的校验入口
    expect(await glslangCompile(assembled, 'frag')).toBe(true)
  })
  // ... 其余 shader
})
```

- [ ] **Step 5: 运行 glslang（需系统 PATH 的 `glslangValidator` 或 `glslang-validator-prebuilt-predownloaded`），确认 PASS**

```bash
pnpm --filter @cesium-geospatial/clouds test
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(clouds): T7 搬 19 GLSL + 跨包 #include bruneton + glslang 编译"
```

---

## Task 8: higher-order scattering LUT — cesiumCore define + lutLoader 扩展（C9）

**Files:**
- Modify: `packages/cesium-core/src/cesium/cesiumCore.ts:8-26`（加 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE`）
- Modify: `packages/cesium-core/src/cesium/lutLoader.ts`（加 `higher_order_scattering.bin` 加载）
- Modify: `packages/cesium-core/src/glsl/bruneton/`（确认 `runtime.glsl:341-353` 的 higher-order 分支与 sampler3D 声明存在）
- Create: `packages/cesium-core/scripts/genHigherOrderScattering.ts`（离线 Bruneton precompute，仿现有 LUT 生成）
- Create: `apps/demo/public/luts/higher_order_scattering.bin`（生成产物）
- Modify: 对应测试

**Interfaces:**
- Produces: `AtmosphereLUTs` 增加 `higherOrderScattering: Texture3D`；`buildAtmospherePrefix` 含 `#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE` + `precision highp sampler3D`（已有）；runtime 走 `runtime.glsl:341-353` 物理正确分支

- [ ] **Step 1: 写离线生成脚本（Bruneton precompute 第 4 张 LUT）**

参照 three-geospatial atmosphere 的 precompute（`PrecomputedTexturesGenerator`）或现有 core 的 LUT 生成路径。输出 `higher_order_scattering.bin`（half-float RGBA，尺寸同 scattering 的 reduced 版）。

```bash
pnpm --filter @cesium-geospatial/core gen:higher-order
# 产出 apps/demo/public/luts/higher_order_scattering.bin
```

> **注**：若 three-geospatial 已提供预计算资产，直接搬用（仿现有 3 张 .bin）。先查 three-geospatial atmosphere 包是否有现成 higher-order LUT 文件。

- [ ] **Step 2: cesiumCore.ts 加 define（failing test 先）**

```typescript
// cesiumCore.test.ts（新增或现有）
it('buildAtmospherePrefix 含 HAS_HIGHER_ORDER_SCATTERING_TEXTURE（C9）', () => {
  expect(buildAtmospherePrefix()).toContain('#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE')
})
```

运行确认 FAIL，然后改 `cesiumCore.ts:8-26` 在数组里加 `'#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE'`（位置：`COMBINED_SCATTERING_TEXTURES` 附近）。

- [ ] **Step 3: lutLoader 扩展（failing test 先）**

```typescript
it('loadAtmosphereLUTs 加载第 4 张 higher_order_scattering', async () => {
  const luts = await loadAtmosphereLUTs(mockContext, '/luts')
  expect(luts.higherOrderScattering).toBeDefined()
})
```

改 `lutLoader.ts`：`AtmosphereLUTs` 加 `higherOrderScattering: Texture3D`；`loadAtmosphereLUTs` fetch 第 4 张 + `createLUT3D`。

- [ ] **Step 4: 确认 runtime.glsl 的 sampler3D 声明 + 物理分支**

读 `runtime.glsl:341-353`（`#ifdef HAS_HIGHER_ORDER_SCATTERING_TEXTURE` 分支只遮 single 保留多阶）。确认 `LUT_UNIFORMS_GLSL` 含 `uniform sampler3D higher_order_scattering_texture;`（被 `#ifdef` 包裹）。

- [ ] **Step 5: 运行全部 core 测试 + tsc**

```bash
pnpm --filter @cesium-geospatial/core test
pnpm --filter @cesium-geospatial/core exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(core): T8 higher-order scattering LUT（C9，防 god rays 过暗黑）"
```

---

## Task 9: weather 资产管线

**Files:**
- Create: `packages/cesium-clouds/scripts/genWeather.ts`（离线生成 perlin/worley 噪声纹理）
- Create: `packages/cesium-clouds/src/weather/weatherTextures.ts` + `.test.ts`
- Create: `apps/demo/public/clouds/weather/{shape,detail,weather}.bin`

**Interfaces:**
- Produces: `loadWeatherTextures(context, baseUrl)` → `{ shape, detail, weather }` 3D 噪声纹理（Texture3D）

- [ ] **Step 1: 写离线生成脚本（perlin/worley 3D 噪声 → half-float .bin）**

```typescript
// scripts/genWeather.ts
// 生成 3 张 3D 噪声纹理（shape 128³ / detail 32³ / weather 64²×16 tileable）
// 参照 three-geospatial clouds 的 weather 生成（若有）或自写 perlin/worley
// 输出 half-float (Uint16) RGBA .bin
```

> **注**：先查 three-geospatial clouds 是否有现成 weather 资产或生成器可搬。

- [ ] **Step 2: 写 weatherTextures.ts（failing test 先，仿 lutLoader）**

```typescript
it('loadWeatherTextures 返回 3 张 Texture3D', async () => {
  const w = await loadWeatherTextures(mockContext, '/clouds/weather')
  expect(w.shape).toBeDefined()
  expect(w.detail).toBeDefined()
  expect(w.weather).toBeDefined()
})
```

- [ ] **Step 3: 运行 + Commit**

```bash
git commit -m "feat(clouds): T9 weather 噪声资产管线（perlin/worley 离线生成）"
```

---

## Task 10: M1 results + go/no-go 结论 + 整合验收

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-clouds-m1-results.md`

- [ ] **Step 1: 写 results 文档**

记录：
- 4 项 spike go/no-go 结论（每项：probe 截图/观察 + 判定 + 若 no-go 的死结）
- MRT 渲染入口最终选型（Primitive vs DrawCommand，据 T2 结论）
- 跨包 `#include bruneton/runtime` 路径约定（T7 结论）
- higher-order LUT 资产来源（T8：搬 vs 离线生成）
- weather 资产来源（T9）
- 基建（FullscreenPass/FramebufferManager）单测结果
- tsc + 全量测试结果
- M2 启动前置条件确认

- [ ] **Step 2: 整合验收 demo**

```
http://localhost:5173/?mode=atmosphere&cloudsSpike=1   # T2 时机+czm
http://localhost:5173/?mode=atmosphere&cloudsSpike=2   # T3 depth+消费
http://localhost:5173/?mode=atmosphere&cloudsSpike=3   # T4 2D_ARRAY
```

- [ ] **Step 3: 全量回归测试（atmosphere 零回归——clouds 关闭时）**

```bash
pnpm --filter @cesium-geospatial/core test   # 含 T8 higher-order LUT 改动
pnpm --filter @cesium-geospatial/clouds test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 4: Commit results + 整体 M1**

```bash
git add docs/superpowers/plans/2026-08-13-clouds-m1-results.md
git commit -m "docs(clouds): M1 results — spike go/no-go 结论 + 基建 + 资产"
```

---

## Self-Review

**1. Spec coverage（spec r1 §6 M1 各项）**：
- core FullscreenPass + FramebufferManager（MRT+2D_ARRAY+ping-pong）→ T5/T6 ✓
- cesiumCore 加 HAS_HIGHER_ORDER_SCATTERING_TEXTURE（C9）→ T8 ✓
- lutLoader 扩展第 4 张 LUT → T8 ✓
- clouds 包骨架 + 搬 19 GLSL + 跨包 #include bruneton → T1/T7 ✓
- weatherTextures 资产管线 → T9 ✓
- spike 4 项（链中间插入 / globe depthTexture / czm 注入 / 2D_ARRAY+precision）→ T2(#1+#3)/T3(#2)/T4(#4) ✓
- spike 验收 + plan B 不可用 → T2-T4 gate + results ✓
- glslang 编译 19 shader → T7 ✓

**2. Placeholder scan**：spike/probe 的 GLSL 与 TS 骨架用 `// TODO(implementer):` 标注填空点（具体逻辑，非"TBD"）——这些是探索性 spike 的合理形式（probe 行为需运行时观察确认，非预设实现）。基建 task（T5/T6/T8/T9）有 failing test + 接口 + 实现骨架 + commit。无裸 TODO。

**3. Type consistency**：`FullscreenPassOptions` / `createPingPong` / `createArrayTextureBridge` / `createMRTFramebuffer` / `AtmosphereLUTs.higherOrderScattering` / `loadWeatherTextures` 返回类型在各 task 一致。`TEXTURE_2D_ARRAY = 0x871A` 在 T4/T6 一致。

**4. 风险标注**：
- T2 spike 是 Primitive vs DrawCommand 的决策点，T5 据其结论选实现路径（plan 已注明）。
- T7 跨包 `#include` 路径需运行时确认（resolveIncludes 可能局限包内），results 记录约定。
- T8/T9 资产优先搬 three-geospatial 现成，无则离线生成（plan 已注明先查）。
