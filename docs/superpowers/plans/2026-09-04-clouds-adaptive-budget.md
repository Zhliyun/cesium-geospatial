# 云预算自适应（A 太阳角影子预算 + B 视线仰角段长收紧）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 贴地掠射+黄昏场景下，按太阳仰角/视线仰角连续收缩云 march 预算（BSM 生成端 + 主 march 段长），显著降帧成本且域外逐位零回归。

**Architecture:** 方案 1「运行时 uniform 预算自适应」——A 在 JS 侧每帧算当地太阳仰角→连续乘数→BSM 生成端 `maxIterationCount` 闭包；B 在主 march GLSL 侧按逐像素视线仰角收紧局部段长（参数由 JS uniform 注入）。两者都是月光门控（7d525fc）的连续化推广，零 shader 编译分支。

**Tech Stack:** TypeScript (vitest) + GLSL ES 3.0（glslangValidator 校验）+ Cesium uniformMap 闭包模式。

**Spec:** docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md（r2——执行者须先读 spec，本计划从 spec 论证；两文档一起旅行）

## Global Constraints

- 零回归硬域：A——太阳当地仰角 ≥ A_SUN_ELEV_FULL（起草 20°，硬上限 30°）时 BSM 预算逐位原值；B——cameraHeight ≥ 2500m 或 |sinElev| ≥ elevHi 时段长逐位原值
- A_BUDGET_FLOOR ≥ 0.5 硬下界（可由覆盖约束推导更严值）；不达标**回用户重立项，不自动加深**
- B_K0 本计划只落起草值 0.5，二轮真机校准（spec §2.4 明说 Phase 0 不定 B_K0）
- 不碰：时域/分辨率降载、god rays 月光门控、大气 stage、qualityPresets 结构、BSM cascade/mapSize
- `params` 源对象永不被回写（A 的乘数只在 uniformMap 闭包返回值层求值——防复利污染）
- 测试纪律：包目录直跑（`cd packages/cesium-clouds && npx vitest run`）、`--filter` 假绿勿用；tsc 同目录 `npx tsc --noEmit`
- 提交纪律：中文 conventional commits；每任务独立提交
- 所有常数在代码中集中定义于 `shadowBudgetAdaptation.ts` 的 `ADAPTIVE_BUDGET_CONSTANTS`，注释标注「起草值，Phase 0 定稿」或「二轮校准」

---

### Task 1: Phase 0——基线复测、成本分账、B 有效性探针、常数定稿

**Files:**
- Create: `scripts/perf/measure-rotate.ts`（旋转突刺测量脚本入库，playwright 版）
- Modify: `docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md`（常数定稿回填）
- 临时（throwaway，测完还原）：`packages/cesium-clouds/src/glsl/clouds.frag`

**Interfaces:**
- Consumes: 无（首任务）
- Produces: ①常数定稿值（回填 spec §2 表与本计划 Task 2 的 `ADAPTIVE_BUDGET_CONSTANTS`——后续任务按此实现）；②帧率目标（回填 spec §7）；③`scripts/perf/measure-rotate.ts`（Task 6 验收复用）

**前置**：demo dev server（主 checkout `pnpm dev`，5173）+ headed 真机（ego-browser 或 playwright headed）。测量纪律见 spec §2（钉 time+play=0、N≥3 中位、冷却复测、p50 帧时间口径）。

- [ ] **Step 1: 测量脚本入库**

写入 `scripts/perf/measure-rotate.ts`（playwright 版，替代会话 tmp 的 ego 版——协议钉死可复现）：

```ts
// 旋转卡顿量化（spec 2026-09-04 §6.6 协议）：40s 窗口、t=5s 起 CDP 级拖拽 30s、
// 分窗统计帧间隔（pre/rotate/post）。协议钉死：拖拽=左键 25 步×24px 步间 40ms、
// 5 轮来回；>1000ms 帧单列（瓦片突发流送）不混入 long100。
// 用法：pnpm exec tsx scripts/perf/measure-rotate.ts "<url>" [out.json]
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const url = process.argv[2]
const out = process.argv[3] ?? 'scripts/perf/out/measure-rotate.json'
if (!url) throw new Error('用法: measure-rotate.ts <url> [out.json]')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(url, { waitUntil: 'load', timeout: 120000 })
await page.waitForFunction(() => {
  const v = (window as any).__viewer
  return !!v?.scene?.globe?.tilesLoaded
}, undefined, { timeout: 120000 }).catch(() => console.warn('tilesLoaded 超时，继续'))
await page.waitForTimeout(5000)

await page.evaluate(() => {
  ;(window as any).__samples = []
  const loop = () => { (window as any).__samples.push(performance.now()); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
})
await page.evaluate(() => { (window as any).__t0 = performance.now() })
const cx = 640, cy = 360
const dragStart = Date.now()
for (let round = 0; round < 5; round++) {
  const dir = round % 2 === 0 ? 1 : -1
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 25; i++) {
    await page.mouse.move(cx + dir * i * 24, cy)
    await page.waitForTimeout(40)
  }
  await page.mouse.up()
}
const dragEnd = Date.now()
await page.waitForTimeout(5000)
const samples = (await page.evaluate(() => (window as any).__samples)) as number[]
const t0 = (await page.evaluate(() => (window as any).__t0)) as number
await browser.close()

const stats = (arr: number[]) => {
  if (arr.length < 2) return null
  const gaps = arr.slice(1).map((t, i) => t - arr[i]).sort((a, b) => a - b)
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return { n: gaps.length, fps: +(1000 / avg).toFixed(1), p50: +gaps[Math.floor(gaps.length * 0.5)].toFixed(1),
    p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), maxGap: +gaps[gaps.length - 1].toFixed(1),
    long100: gaps.filter(g => g > 100 && g <= 1000).length, tileStall: gaps.filter(g => g > 1000).length }
}
const rel = samples.map(t => t - t0)
// 分窗：采样注入后 5s 内=静止（pre），拖拽历时=旋转（rotate），其后=恢复（post）
const result = { url, pre: stats(rel.filter(t => t < 5000)), rotate: stats(rel.filter(t => t >= 5000 && t <= 5000 + (dragEnd - dragStart))), post: stats(rel.filter(t => t > 5000 + (dragEnd - dragStart))) }
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
```

注意：t0 页面时钟与 node 时钟的换算在 `pre/rotate/post` 分窗用「5s 预热 + 拖拽历时」近似即可（分窗目的=对比静止/旋转，锚点误差 ±1 帧不影响结论）。跑一次验证脚本能出数：`pnpm exec tsx scripts/perf/measure-rotate.ts "http://localhost:5173/?mode=atmosphere&time=2026-09-04T10:00:00Z&play=0&camera=108.2465,34.3312,19,52.0,-2.6"`。

- [ ] **Step 2: 三级阶梯 + 逐 stage 分账 + 仰角扫描（目标机位，全部钉 play=0）**

按 spec §2 数据清单执行并记录（每项 N≥3 取中位）：
1. 阶梯：`atmo=0` / `clouds=0` / 默认 × 静止/旋转（10:00Z）。
2. 分账：默认档加 `&profile=1` **仅静止**测（[profile] 行 console JSON，取 BSM 生成端/主 march/resolve 各 stage 中位 ms）。
3. 仰角扫描：钉 `04:00Z / 08:00Z / 09:30Z / 10:00Z / 10:30Z` 各测静止 p50 帧时间。
4. 预算响应代理：钉 10:00Z 下 `cloudsQuality=low/medium/high` 静止 p50。

- [ ] **Step 3: B 有效性探针（throwaway）**

临时改 `packages/cesium-clouds/src/glsl/clouds.frag` L527（`float maxRayDistance = rayNearFar.y - rayNearFar.x;`）之后加一行：

```glsl
  maxRayDistance *= 0.25; // 【Phase 0 探针，测完删除】B 有效性：段长×0.25 的 FPS 响应
```

清 vite 缓存（`rm -rf apps/demo/node_modules/.vite`）后测目标机位静止 p50 vs 无探针基线。**判据：帧时间下降 ≥15% 即「步数∝段长」前提成立，B 立项；否则 B 弃案（只做 A），spec §4 标记弃案**。测完删除该行、再清缓存确认还原。

- [ ] **Step 4: A 撞线仰角计算（纯数学，写进 spec）**

high 档 shadow.march：maxIter=50、maxStep=1000 → 覆盖半径 50km；FLOOR=0.5 → 25km。影子光线段长 ≈ 云厚/sin(太阳仰角)（云厚取低云甲总厚 1700m，加保守系数 2）：仰角 5° 时 ≈39km、11.3° 时 ≈17.4km。算出 FLOOR=0.5 下的撞线仰角并回填 spec §3（若撞线仰角 > A_SUN_ELEV_FLOOR=5°，需收窄 FLOOR 域或降 FLOOR_DOMAIN，红线=FLOOR≥0.5 不破）。

- [ ] **Step 5: 常数定稿回填 spec**

据 Step 2-4 数据：定稿 `A_SUN_ELEV_FULL`（≤30°）、`A_SUN_ELEV_FLOOR`、`A_BUDGET_FLOOR`（≥0.5）、`B_ELEV_LO/HI`、帧率目标（spec §7 回填）；`B_K0=0.5` 保持起草（二轮校准）。commit：

```bash
git add scripts/perf/measure-rotate.ts docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md
git commit -m "docs(specs): Phase 0 基线数据回填——常数定稿+帧率目标+测量脚本入库"
```

---

### Task 2: A/B 曲线纯函数模块（TDD）

**Files:**
- Create: `packages/cesium-clouds/src/shadowBudgetAdaptation.ts`
- Test: `packages/cesium-clouds/src/shadowBudgetAdaptation.test.ts`

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `ADAPTIVE_BUDGET_CONSTANTS`（对象，字段见下）
  - `localSunElevationDeg(sunDirection: Cartesian3, cameraPositionWC: Cartesian3): number`（度）
  - `shadowBudgetMultiplier(sunElevDeg: number, fullDeg: number, floorDeg: number, budgetFloor: number): number`
  - `scaledShadowMaxIterations(baseMaxIterations: number, mult: number): number`
  - `grazingGate(cameraHeightM: number, gateLoM: number, gateHiM: number): number`
  - `grazingK(sinElev: number, k0: number, elevLoSin: number, elevHiSin: number): number`

- [ ] **Step 1: 写失败测试**

`packages/cesium-clouds/src/shadowBudgetAdaptation.test.ts`：

```ts
// shadowBudgetAdaptation.test.ts —— spec 2026-09-04 §3/§4 自适应预算曲线（常数=起草值）
import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import {
  ADAPTIVE_BUDGET_CONSTANTS, grazingGate, grazingK,
  localSunElevationDeg, scaledShadowMaxIterations, shadowBudgetMultiplier
} from './shadowBudgetAdaptation'

const C = ADAPTIVE_BUDGET_CONSTANTS

describe('shadowBudgetMultiplier（spec §3：高角=1 零回归、低角=FLOOR、过渡平滑）', () => {
  it('边界与域内三点（期望值按文字语义写——r1 方向反错误正是此类测试抓的）', () => {
    expect(shadowBudgetMultiplier(30, 20, 5, 0.5)).toBe(1)      // ≥FULL 零回归域
    expect(shadowBudgetMultiplier(20, 20, 5, 0.5)).toBe(1)      // =FULL
    expect(shadowBudgetMultiplier(5, 20, 5, 0.5)).toBeCloseTo(0.5, 6)  // ≤FLOOR
    expect(shadowBudgetMultiplier(0, 20, 5, 0.5)).toBeCloseTo(0.5, 6)
    const m12 = shadowBudgetMultiplier(12.5, 20, 5, 0.5)
    expect(m12).toBeGreaterThan(0.5)
    expect(m12).toBeLessThan(1)
    expect(shadowBudgetMultiplier(16, 20, 5, 0.5)).toBeGreaterThan(m12) // 单调升
  })
})

describe('localSunElevationDeg（spec §3：当地径向，非赤纬——r1 C1 修正）', () => {
  const R = 6378137
  it('相机在 (R,0,0)、太阳 x 向偏 30° → 仰角 30°', () => {
    const s30 = Math.PI / 6
    const sun = new Cartesian3(Math.cos(s30), Math.sin(s30), 0)
    const elev = localSunElevationDeg(sun, new Cartesian3(R, 0, 0))
    expect(elev).toBeCloseTo(30, 4)
  })
  it('黄昏 10° 场景', () => {
    const s10 = Math.PI / 18
    const sun = new Cartesian3(Math.cos(s10), Math.sin(s10), 0)
    expect(localSunElevationDeg(sun, new Cartesian3(R, 0, 0))).toBeCloseTo(10, 4)
  })
  it('太阳在地平下 → 负仰角', () => {
    const s10 = Math.PI / 18
    const sun = new Cartesian3(Math.cos(s10), -Math.sin(s10), 0)
    expect(localSunElevationDeg(sun, new Cartesian3(R, 0, 0))).toBeCloseTo(-10, 4)
  })
})

describe('scaledShadowMaxIterations（spec §3：闭包返回值层，源对象不回写）', () => {
  it('乘数 1 → 原值；0.5 → 四舍五入；钳 1 下防 0 循环空转', () => {
    expect(scaledShadowMaxIterations(50, 1)).toBe(50)
    expect(scaledShadowMaxIterations(25, 0.5)).toBe(13)  // Math.round(12.5)=13（half-up）
    expect(scaledShadowMaxIterations(1, 0.1)).toBe(1)
  })
})

describe('grazingGate（spec §4：1500-2500m 平滑门，红队攻击 2 连续化）', () => {
  it('门两端与中点', () => {
    expect(grazingGate(1000, 1500, 2500)).toBe(1)
    expect(grazingGate(1500, 1500, 2500)).toBe(1)
    expect(grazingGate(2000, 1500, 2500)).toBeCloseTo(0.5, 6)
    expect(grazingGate(2500, 1500, 2500)).toBe(0)
    expect(grazingGate(3000, 1500, 2500)).toBe(0)
  })
})

describe('grazingK（spec §4：|sinElev| 双向对称——自审修正项）', () => {
  it('仰角高=原值、水平=K0、正负对称', () => {
    const lo = Math.sin((2 * Math.PI) / 180), hi = Math.sin((10 * Math.PI) / 180)
    expect(grazingK(Math.sin((30 * Math.PI) / 180), 0.5, lo, hi)).toBe(1)
    expect(grazingK(0, 0.5, lo, hi)).toBeCloseTo(0.5, 6)
    expect(grazingK(-0.5, 0.5, lo, hi)).toBeCloseTo(0.5, 6)  // 俯视掠射对称
    const mid = grazingK(Math.sin((6 * Math.PI) / 180), 0.5, lo, hi)
    expect(mid).toBeGreaterThan(0.5)
    expect(mid).toBeLessThan(1)
  })
})

describe('ADAPTIVE_BUDGET_CONSTANTS 红线（spec §3/§8 硬规则）', () => {
  it('FLOOR≥0.5 硬下界、FULL≤30° 硬上界、门序 1500<2500', () => {
    expect(C.BUDGET_FLOOR).toBeGreaterThanOrEqual(0.5)
    expect(C.SUN_ELEV_FULL_DEG).toBeLessThanOrEqual(30)
    expect(C.SUN_ELEV_FLOOR_DEG).toBeLessThan(C.SUN_ELEV_FULL_DEG)
    expect(C.GRAZING_GATE_LO_M).toBeLessThan(C.GRAZING_GATE_HI_M)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cesium-clouds && npx vitest run src/shadowBudgetAdaptation.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`packages/cesium-clouds/src/shadowBudgetAdaptation.ts`：

```ts
// shadowBudgetAdaptation.ts
//
// 云预算自适应曲线（spec 2026-09-04 §3/§4——月光门控的连续化推广，方案 1 开环确定性）。
// 纯函数模块：A 太阳角影子预算 + B 视线仰角段长收紧的全部 JS 侧数学。
// 常数=起草值（Phase 0 定稿回填；B_K0 二轮真机校准——spec §2.4）。
import { Cartesian3 } from 'cesium'

/** 自适应预算常数（spec §2 起草常数表；定稿后回填并删「起草」注）。 */
export const ADAPTIVE_BUDGET_CONSTANTS = {
  /** A：乘数=1 的太阳仰角下界（零回归域边界；硬上限 30°——spec §8）。 */
  SUN_ELEV_FULL_DEG: 20, // 起草值，Phase 0 定稿
  /** A：乘数=FLOOR 的太阳仰角上界。 */
  SUN_ELEV_FLOOR_DEG: 5,
  /** A：影子预算乘数下限（硬下界 0.5——spec §3 覆盖约束+§8 红线）。 */
  BUDGET_FLOOR: 0.5,
  /** B：高度门平滑域（红队攻击 2 连续化；≥HI 逐位原值）。 */
  GRAZING_GATE_LO_M: 1500,
  GRAZING_GATE_HI_M: 2500,
  /** B：水平掠射段长乘数（起草；二轮真机校准——spec §2.4）。 */
  GRAZING_K0: 0.5,
  /** B：段长收紧曲线的视线仰角域（度；GLSL 侧消费 sin 值）。 */
  GRAZING_ELEV_LO_DEG: 2,
  GRAZING_ELEV_HI_DEG: 10
} as const

/** GLSL smoothstep 同式（edge0<edge1 前提由调用方保证——勿反向，r1 C2 教训）。 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const DEG = 180 / Math.PI

/**
 * 当地太阳仰角（度）。r1 C1 修正：dot(sunDir, ECEF z)=赤纬（全球恒值），必须点
 * 相机当地径向——与 clouds.frag:594 muSunLocal=dot(surfaceNormal,sunDirection) 同语义。
 * 贴地机位与云域 up 差 <0.1°，由校准吸收（spec §3）。
 */
export function localSunElevationDeg(sunDirection: Cartesian3, cameraPositionWC: Cartesian3): number {
  const r = Math.sqrt(
    cameraPositionWC.x * cameraPositionWC.x +
    cameraPositionWC.y * cameraPositionWC.y +
    cameraPositionWC.z * cameraPositionWC.z
  )
  const mu =
    (cameraPositionWC.x * sunDirection.x +
      cameraPositionWC.y * sunDirection.y +
      cameraPositionWC.z * sunDirection.z) / r
  return Math.asin(Math.min(1, Math.max(-1, mu))) * DEG
}

/**
 * A 影子预算乘数：elev≥full → 1（零回归域）；elev≤floor → budgetFloor；中间 smoothstep。
 * r1 C2 修正：high=1/low=FLOOR 的方向（r1 公式 smoothstep 边序写反双向失败）。
 */
export function shadowBudgetMultiplier(
  sunElevDeg: number, fullDeg: number, floorDeg: number, budgetFloor: number
): number {
  const s = smoothstep(floorDeg, fullDeg, sunElevDeg)
  return budgetFloor + (1 - budgetFloor) * s
}

/** BSM 生成端步数缩放（钳 1 下防 for 空转 sampleCount=0 无影——渲染专家 m6）。 */
export function scaledShadowMaxIterations(baseMaxIterations: number, mult: number): number {
  return Math.max(1, Math.round(baseMaxIterations * mult))
}

/** B 高度门：1−smoothstep(LO,HI,h)——相机穿越门限平滑过渡（红队攻击 2 连续化）。 */
export function grazingGate(cameraHeightM: number, gateLoM: number, gateHiM: number): number {
  return 1 - smoothstep(gateLoM, gateHiM, cameraHeightM)
}

/** B 段长乘数：|sinElev|≥elevHi → 1；≤elevLo → K0（自审修正：abs 双向对称）。 */
export function grazingK(sinElev: number, k0: number, elevLoSin: number, elevHiSin: number): number {
  const s = smoothstep(elevLoSin, elevHiSin, Math.abs(sinElev))
  return k0 + (1 - k0) * s
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/cesium-clouds && npx vitest run src/shadowBudgetAdaptation.test.ts && npx tsc --noEmit`
Expected: PASS + tsc clean

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/shadowBudgetAdaptation.ts packages/cesium-clouds/src/shadowBudgetAdaptation.test.ts
git commit -m "feat(clouds): 自适应预算曲线纯函数——A 太阳角乘数/B 掠射门与段长乘数（TDD）"
```

---

### Task 3: A 接入 createCloudsStage（state+preRender+闭包）+ options/逃生门

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（state、preRender、shadowUniformMap L697、options 接口 L236 区、透传 L517 区）
- Modify: `apps/demo/src/main.ts`（逃生门参数解析，云 options 对象 ~L578）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `localSunElevationDeg`/`shadowBudgetMultiplier`/`scaledShadowMaxIterations`/`ADAPTIVE_BUDGET_CONSTANTS`
- Produces: `CloudsStageOptions.shadowAdaptive?: boolean`（缺省 true，`false`=乘数恒 1）；frame state 新字段 `shadowBudgetMult: number`（缺省 1，preRender 更新）；`grazingClamp?: boolean`（Task 4 消费）

- [ ] **Step 1: 写失败测试（createCloudsStage.test.ts 追加）**

```ts
describe('T-adaptive A：太阳角影子预算（spec 2026-09-04 §3）', () => {
  it('params 源对象永不被回写（红队攻击 7/渲染 M4：复利污染防线）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), { clouds: true })
    const before = paramsOf(handle!).shadowMarch.maxIterationCount
    // 模拟 preRender 低太阳角更新（直接调内部 state 更新路径或重渲一帧）
    // —— 经 handle.preRender?.() 或既有测试的渲染驱动方式触发
    ;(handle as any).preRender?.()
    expect(paramsOf(handle!).shadowMarch.maxIterationCount).toBe(before)
    handle!.destroy()
  })
  it('options.shadowAdaptive=false → 预算恒原值（逃生门）', () => {
    const scene = createMockScene()
    const handle = createCloudsStage(scene, createMockLuts(), createMockWeather(), {
      clouds: true, shadowAdaptive: false
    })
    expect(paramsOf(handle!).shadowBudgetMult).toBe(1)
    handle!.destroy()
  })
})
```

（注：`paramsOf` 为该文件既有助手 L921；preRender 驱动方式按该文件既有用例的渲染驱动写法对齐——文件内已有 mock scene 渲染循环用例可仿。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cesium-clouds && npx vitest run src/createCloudsStage.test.ts -t "T-adaptive"`
Expected: FAIL（shadowAdaptive 不存在）

- [ ] **Step 3: 实现**

`createCloudsStage.ts` 三处：

① options 接口（L236 `shadowTemporal` 附近）加：

```ts
  /**
   * A 太阳角自适应影子预算（spec 2026-09-04 §3，缺省 true）：每帧按当地太阳仰角
   * 连续缩放 BSM 生成端 maxIterationCount（闭包返回值层，params 源不回写）。
   * false=乘数恒 1（?cloudsShadowAdaptive=0 逃生门，逐位回退）。
   */
  shadowAdaptive?: boolean
  /** B 掠射段长收紧（spec §4，缺省 true；false=?cloudsGrazingClamp=0 逃生门）。 */
  grazingClamp?: boolean
```

② frame state（L528 `sunDirection: new Cartesian3(0, 0, 1)` 同对象）加：

```ts
    shadowBudgetMult: 1, // A 乘数（preRender 每帧更新；Task 4 的 grazingGate 同模式）
```

③ preRender（L818 `Cartesian3.normalize(sunFixed, state.sunDirection)` 之后）加：

```ts
          // A 太阳角自适应（spec §3）：乘数在 preRender 算好存 state，uniformMap 闭包读取
          state.shadowBudgetMult =
            options.shadowAdaptive === false
              ? 1
              : shadowBudgetMultiplier(
                  localSunElevationDeg(state.sunDirection, camera.positionWC),
                  ADAPTIVE_BUDGET_CONSTANTS.SUN_ELEV_FULL_DEG,
                  ADAPTIVE_BUDGET_CONSTANTS.SUN_ELEV_FLOOR_DEG,
                  ADAPTIVE_BUDGET_CONSTANTS.BUDGET_FLOOR
                )
```

④ shadowUniformMap（L697）改一行：

```ts
      maxIterationCount: () =>
        scaledShadowMaxIterations(params.shadowMarch.maxIterationCount, state.shadowBudgetMult),
```

（其余 shadowMarch 字段闭包不动——r2 砍掉 minStepSize/mult 杠杆。）文件头 import：

```ts
import {
  ADAPTIVE_BUDGET_CONSTANTS, localSunElevationDeg,
  scaledShadowMaxIterations, shadowBudgetMultiplier
} from './shadowBudgetAdaptation'
```

⑤ demo 逃生门（`apps/demo/src/main.ts` 云 options 对象 ~L578，`clouds: true` 之后）：

```ts
          // 自适应预算逃生门（spec 2026-09-04 §3/§4）：缺省启用，=0 显式关（红队攻击 5 接线项）
          ...(getString('cloudsShadowAdaptive') === '0' ? { shadowAdaptive: false } : {}),
          ...(getString('cloudsGrazingClamp') === '0' ? { grazingClamp: false } : {}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/cesium-clouds && npx vitest run src/createCloudsStage.test.ts && npx tsc --noEmit`
Expected: PASS + tsc clean

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts apps/demo/src/main.ts
git commit -m "feat(clouds): A 太阳角影子预算接入——preRender 乘数+BSM 闭包缩放+逃生门接线"
```

---

### Task 4: B 参数 uniforms（CloudsPass 闭包 + options 透传）

**Files:**
- Modify: `packages/cesium-clouds/src/CloudsPass.ts`（uniformMap L497 区加 4 闭包；options 透传）
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（CloudsPass 创建处透传 `grazingClamp`）
- Test: `packages/cesium-clouds/src/CloudsPass.test.ts`

**Interfaces:**
- Consumes: Task 2 `grazingGate`/`ADAPTIVE_BUDGET_CONSTANTS`；Task 3 的 `CloudsStageOptions.grazingClamp`
- Produces: 主 march uniformMap 新键 `u_grazingGate`/`u_grazingK0`/`u_grazingElevLo`/`u_grazingElevHi`（Task 5 GLSL 消费；ElevLo/Hi 为 **sin 值域**——JS 注入前 sin 换算，性能专家 m1）

- [ ] **Step 1: 写失败测试（CloudsPass.test.ts 追加，仿既有 `um.minHeight()` 模式）**

```ts
it('B 掠射参数 uniforms（spec 2026-09-04 §4）：门随相机高度平滑、逃生门恒 0、Elev 为 sin 值域', () => {
  // 仿既有 createVolumetricPrimitive mock 路径取 uniformMap；相机高度经 scene mock 注入
  const um = (createVolumetricPrimitive as any).mock.calls[0][0].uniformMap
  expect(um.u_grazingK0()).toBe(0.5)
  expect(um.u_grazingElevLo()).toBeCloseTo(Math.sin((2 * Math.PI) / 180), 6)
  expect(um.u_grazingElevHi()).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 6)
  // gate 数值特性（门本体单测在 shadowBudgetAdaptation.test；此处验证闭包接线）
  expect(typeof um.u_grazingGate()).toBe('number')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cesium-clouds && npx vitest run src/CloudsPass.test.ts -t "掠射参数"`
Expected: FAIL（u_grazingK0 未定义）

- [ ] **Step 3: 实现**

`CloudsPass.ts` uniformMap（L497 区，`cameraHeight` 闭包 L475 之后加辅助）：

```ts
  // B 掠射段长参数（spec 2026-09-04 §4）：Elev 以 sin 值域注入（GLSL 消费 abs(sinElev)，
  // 勿在 shader 内再 sin——性能 m1 防镜像 fixture 漂移）；gate 随相机测地高度平滑
  //（红队攻击 2 连续化：1500-2500m smoothstep，无阶跃）。
  const grazingGateUniform = (): number => grazingGate(cameraHeight(), C.GRAZING_GATE_LO_M, C.GRAZING_GATE_HI_M)
  const SIN = (deg: number) => Math.sin((deg * Math.PI) / 180)
```

uniformMap 对象内（L498 spread 之后）加：

```ts
    // B 掠射参数（grazingClamp=false → gate 恒 0，IEEE 逐位回退——spec §4 逃生门）
    u_grazingGate: () => (grazingClamp ? grazingGateUniform() : 0),
    u_grazingK0: () => C.GRAZING_K0,
    u_grazingElevLo: () => SIN(C.GRAZING_ELEV_LO_DEG),
    u_grazingElevHi: () => SIN(C.GRAZING_ELEV_HI_DEG),
```

（`C = ADAPTIVE_BUDGET_CONSTANTS`、`grazingGate` 从 `./shadowBudgetAdaptation` import；`grazingClamp` 为 CloudsPass 新 option，构造参数缺省 `true`。）

`createCloudsStage.ts` CloudsPass 创建 options 透传处（grep `createCloudsPass(` 定位，与 `temporalUpscale`/`upscaleDivisor` 透传同点）加：

```ts
      grazingClamp: options.grazingClamp !== false,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/cesium-clouds && npx vitest run src/CloudsPass.test.ts && npx tsc --noEmit`
Expected: PASS + tsc clean

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/CloudsPass.ts packages/cesium-clouds/src/CloudsPass.test.ts packages/cesium-clouds/src/createCloudsStage.ts
git commit -m "feat(clouds): B 掠射参数 uniforms——高度平滑门+sin 值域常数+逃生门透传"
```

---

### Task 5: B GLSL 公式（clouds.frag）+ glslang 编译测试

**Files:**
- Modify: `packages/cesium-clouds/src/glsl/clouds.frag`（uniforms 声明区 L96 附近 + marchClouds L527 后）
- Test: `packages/cesium-clouds/src/cloudsMain.compile.test.ts`（既有编译测试自动覆盖；如该文件枚举 uniforms 清单则同步）

**Interfaces:**
- Consumes: Task 4 的四个 uniform（名字逐字：`u_grazingGate`/`u_grazingK0`/`u_grazingElevLo`/`u_grazingElevHi`）
- Produces: marchClouds 内收紧后的局部 `maxRayDistance`（下游 段长/8 clamp、startJitter 守卫、march 终止三处自动一致——渲染专家 M3 落点）

- [ ] **Step 1: uniforms 声明（clouds.frag L96 `uniform float maxRayDistance;` 之后）**

```glsl
uniform float u_grazingGate;    // B 高度平滑门 0..1（JS 注入；0=逃生门/域外=逐位原值）
uniform float u_grazingK0;      // 水平掠射段长乘数（JS 注入，起草 0.5 二轮校准）
uniform float u_grazingElevLo;  // 收紧曲线下界（sin 值域，JS 已换算）
uniform float u_grazingElevHi;  // 收紧曲线上界（sin 值域）
```

- [ ] **Step 2: marchClouds 段长收紧（L527 `float maxRayDistance = ...` 之后、L528 stepSize 之前——渲染专家 M3：替换局部变量本身，下游三处自动一致）**

```glsl
  // 【贴地掠射段长收紧（2026-09-04 自适应预算 spec §4）】相机近地（u_grazingGate 平滑门）
  // 且视线接近水平（|sinElev| 小，双向对称——俯/仰掠射同产生长穿越）时光线斜穿云甲路径
  // 最长，段长按曲线收紧省步数。参数全 JS 注入；gate=0 或 |sinElev|≥ElevHi 时
  // mix=1.0/min(x,x) 逐位原值（IEEE——spec §4 逃生门论证）。落点=局部变量替换：
  // 下游 段长/8 步长 clamp、startJitter 守卫（53e8bc6 黑块修复）、march 终止三处
  // 消费同一收紧值（若只喂终止条件，jitter 守卫用旧段长误判→黑块复发，渲染 M3）。
  float sinElev = dot(rayDirection, normalize(rayOrigin));
  float grazingK = mix(u_grazingK0, 1.0, smoothstep(u_grazingElevLo, u_grazingElevHi, abs(sinElev)));
  maxRayDistance = min(maxRayDistance * mix(1.0, grazingK, u_grazingGate), maxRayDistance);
```

- [ ] **Step 3: 编译测试确认**

Run: `cd packages/cesium-clouds && npx vitest run src/cloudsMain.compile.test.ts`
Expected: PASS（既有 glslang 双入口校验自动覆盖新 uniform；若该测试有 uniforms 快照/枚举清单，同步补 4 个键）

- [ ] **Step 4: 全量回归**

Run: `cd packages/cesium-clouds && npx vitest run && npx tsc --noEmit`
Expected: 全绿（既有断言不破——B 域外逐位原值的 GLSL 论证在此回归验证）

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/glsl/clouds.frag
git commit -m "feat(clouds): B 掠射段长收紧 GLSL——逐像素|sinElev|曲线+平滑高度门（落点=局部段长替换）"
```

---

### Task 6: 消费域枚举守卫 + 真机验收准备

**Files:**
- Test: `packages/cesium-clouds/src/adaptiveBudgetCompatibility.test.ts`（新建）
- Modify: `docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md`（§7 帧率目标核对——Task 1 已回填则此处只校对）

**Interfaces:**
- Consumes: Task 2 `localSunElevationDeg`/`ADAPTIVE_BUDGET_CONSTANTS`

- [ ] **Step 1: 写守卫测试**

`adaptiveBudgetCompatibility.test.ts`：

```ts
// 消费域枚举守卫（spec §6.5，r2 改——原 CI 枚举是空保护：CI 门禁 clouds=0 不渲染云）。
// 场景集=真机验收场景+云专项工具场景；太阳仰角 hardcode 自 celestialDirections 同源
// 实算（红队手算交叉验证），单测断言 hardcode 与实算一致防漂移。
import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import { ADAPTIVE_BUDGET_CONSTANTS, localSunElevationDeg, shadowBudgetMultiplier } from './shadowBudgetAdaptation'

// ECEF 太阳方向构造器：给定经度、仰角、方位正南近似（测试用途）
function sunDirAt(lonDeg: number, elevDeg: number): Cartesian3 {
  const lon = (lonDeg * Math.PI) / 180
  const e = (elevDeg * Math.PI) / 180
  // 站心东北天 → ECEF（经度圈近似，仰角断言 5° 量级足够）
  const up = new Cartesian3(Math.cos(lon), Math.sin(lon), 0)
  const east = new Cartesian3(-Math.sin(lon), Math.cos(lon), 0)
  const d = new Cartesian3(
    up.x * Math.sin(e) + east.x * Math.cos(e),
    up.y * Math.sin(e) + east.y * Math.cos(e),
    up.z * Math.sin(e)  // 站心 z 分量近似并入
  )
  const n = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
  return new Cartesian3(d.x / n, d.y / n, d.z / n)
}
function camAt(lonDeg: number, latDeg: number): Cartesian3 {
  const lon = (lonDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180
  const R = 6378137
  return new Cartesian3(R * Math.cos(lat) * Math.cos(lon), R * Math.cos(lat) * Math.sin(lon), R * Math.sin(lat))
}

// 场景表（仰角=Phase 0 实算 hardcode；漏填新场景时此表是唯一需要同步的点）
const SCENES = [
  { name: '目标机位 108（钉 10:00Z）', lon: 108.2465, lat: 34.3312, elevDeg: 11.3, heightM: 490, inTargetDomain: true },
  { name: '日本 500m 云海（钉 03:00Z≈当地正午）', lon: 139.2399, lat: 34.8752, elevDeg: 68, heightM: 500, inTargetDomain: false }
]

describe('自适应预算消费域守卫（spec §6.5）', () => {
  it('hardcode 仰角与实算一致（±1.5°——红队手算精度口径）', () => {
    for (const s of SCENES) {
      const elev = localSunElevationDeg(sunDirAt(s.lon, s.elevDeg), camAt(s.lon, s.lat))
      expect(Math.abs(elev - s.elevDeg)).toBeLessThan(1.5)
    }
  })
  it('目标域场景乘数 <1（A 生效）；非目标场景乘数 =1（零回归域）', () => {
    for (const s of SCENES) {
      const m = shadowBudgetMultiplier(
        s.elevDeg, C.SUN_ELEV_FULL_DEG, C.SUN_ELEV_FLOOR_DEG, C.BUDGET_FLOOR
      )
      if (s.inTargetDomain) expect(m).toBeLessThan(1)
      else expect(m).toBe(1)
    }
  })
})

const C = ADAPTIVE_BUDGET_CONSTANTS
```

（注：`const C` 声明提升到使用前——实现时移到文件头部 import 之后。场景表 Phase 0 扩充。）

- [ ] **Step 2: 跑测试**

Run: `cd packages/cesium-clouds && npx vitest run src/adaptiveBudgetCompatibility.test.ts`
Expected: PASS

- [ ] **Step 3: 全量回归 + tsc**

Run: `cd packages/cesium-clouds && npx vitest run && npx tsc --noEmit`
Expected: 全绿

- [ ] **Step 4: 真机验收材料准备（交用户，非代码步骤）**

- 验收 URL 组（108 机位钉 `time=2026-09-04T10:00:00Z&play=0`）：默认 / `&cloudsShadowAdaptive=0` / `&cloudsGrazingClamp=0` / 双关 四组成对
- 日本 500m 云海回归 URL + 黄昏地平线云带目验场景（太阳 <10° 时段，实时钟）
- `pnpm exec tsx scripts/perf/measure-rotate.ts` 按四组各跑一遍，帧率/突刺对照表

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/adaptiveBudgetCompatibility.test.ts docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md
git commit -m "test(clouds): 消费域枚举守卫+真机验收材料——自适应预算收尾"
```

---

## 任务依赖与执行顺序

Task 1（Phase 0 测量，定常数）→ Task 2（纯函数）→ Task 3（A 接入）→ Task 4（B uniforms）→ Task 5（B GLSL）→ Task 6（守卫+验收）。Task 3/4/5 相互独立度低（同文件交叉），按序执行。Task 1 的 B 探针若弃案 B：Task 4/5 跳过，Task 6 只做 A 侧，spec §4 标注弃案。

## 真机验收清单（用户执行，spec §6.6）

1. 108 机位四组逃生门成对（帧率/突刺/影子与远云画质）
2. 黄昏地平线云带目验（B 域内最显眼内容——红队攻击 6 必过项）
3. 日本 500m 云海回归目验
4. 傍晚实时时钟原场景复测
