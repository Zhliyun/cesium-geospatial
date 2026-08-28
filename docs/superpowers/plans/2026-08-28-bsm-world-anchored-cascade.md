# BSM 世界锚定 Cascade 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 BSM cascade 矩阵从「视锥锚定重建」改为「世界锚定固定网格」，消除相机移动时云影/天空闪动（轨道场景 BSM 增量 1.55% → <0.3%）。

**Architecture:** `CascadedShadowMaps.update()` 加 `world` 分支（固定 radii + 相机位置 texel snap + 局部相对式 zNear + 常数 interval + 单源矩阵构造），`frustum` 旧路径 bit 级保留做 AB 基线；编排层加 `shadowAnchor` 开关（默认 world）、太阳向量量化（仅矩阵输入）、静止跳过（语义键）。shader 文本零改动。

**Tech Stack:** TypeScript + Cesium 数学类（float64）+ vitest 单测（GLSL 文本锚点 + 矩阵数学仿真）+ demo 录屏帧间差分验收。

**Spec:** `docs/superpowers/specs/2026-08-28-bsm-world-anchored-cascade-design.md`（v3 终审版——本计划从 spec 立论，执行者须先读 spec）

## Global Constraints

- 分支 `bsm-world-anchored`（已存在），每任务一 commit。
- 全部代码注释/文档用中文（项目惯例）。
- 设计值逐字取自 spec §3.1/§5：radii `{16e3, 33.6e3, 96e3}`m、interval `{0, 10e3, 21e3, 60e3}`m、margin ≤ 3e4m、太阳量化步长 8.7e-4 rad（0.05°）、shellTopRadius = 6,360,000 + 2,200 = 6,362,200m。
- **frustum 分支 bit 级保留现状**（含已知 distance 入壳 bug 与视锥 far 参与——spec §3.1.5 AB 基线完整性）。
- shader 文本（`cascadedShadowMaps.glsl`/`clouds.frag`/`shadow.frag`）与 `ShadowPass.ts` **零改动**。
- 单测命令：`pnpm --filter @cesium-geospatial/clouds exec vitest run src/<file>`；类型检查 `pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit`。
- GPU float32 仿真断言：矩阵 16 元素与坐标逐 `Math.fround` 后计算（f64 域断言会平凡通过，测不出风险——spec §6）。
- Cesium `Matrix3/Matrix4` 构造参数 row-major（「列=basis」矩阵必须逐行写各 basis 分量——69ee488 转置历史坑，CascadedShadowMaps.ts:172-180 有先例注释）。

---

### Task 1: world 矩阵核心（构造选项 + 相机 snap + 单源构造 + 常数 interval）

**Files:**
- Modify: `packages/cesium-clouds/src/CascadedShadowMaps.ts`
- Test: `packages/cesium-clouds/src/CascadedShadowMaps.test.ts`

**Interfaces:**
- Consumes: 现有 `CascadeCameraInput`、`lookAtMatrix` 同款 light 基数学。
- Produces: `CascadedShadowMapsOptions` 新字段 `anchor/worldRadii/worldIntervals/shellTopRadius/worldMargin/zSnapGrid`；`update(camera, sunDirection, distance?)` world 分支行为（本任务 z 盒用解析 zNear 完整实现；Task 2 补极端角测试）；`Cascade` 现有七矩阵字段照常填充。

- [ ] **Step 1: 写失败测试——world 模式构造与 interval 常数**

在 `CascadedShadowMaps.test.ts` 追加（沿用文件头部 `makeCamera` 构造）：

```ts
// ── world 锚定模式（spec v3 §3.1）──
const WORLD_RADII = [16e3, 33.6e3, 96e3]
const WORLD_INTERVALS = [0, 10e3, 21e3, 60e3]

function makeWorldCSM() {
  return new CascadedShadowMaps({
    cascadeCount: 3, mapSize: 512,
    anchor: 'world', worldRadii: WORLD_RADII, worldIntervals: WORLD_INTERVALS
  })
}

describe('CascadedShadowMaps world 锚定', () => {
  const sun = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())

  it('interval 常数区间：无 NaN、单调、覆盖 [0,1]（near=0 不喂 splitFrustum，spec §3.1.4）', () => {
    const csm = makeWorldCSM()
    const cam = makeCamera(0, 6e4) // near=0 传 world 分支必须安全
    csm.update(cam, sun, 1e5)
    expect(csm.cascades[0].interval.x).toBe(0)
    expect(csm.cascades[2].interval.y).toBeCloseTo(1, 10)
    for (let i = 0; i < 3; i++) {
      const iv = csm.cascades[i].interval
      expect(Number.isFinite(iv.x)).toBe(true)
      expect(Number.isFinite(iv.y)).toBe(true)
      expect(iv.y).toBeGreaterThan(iv.x)
      if (i > 0) expect(iv.x).toBeCloseTo(csm.cascades[i - 1].interval.y, 10)
    }
  })

  it('radius/texel 恒定：任意相机变化下 ortho 半径 = worldRadii（spec §3.1.1）', () => {
    const csm = makeWorldCSM()
    csm.update(makeCamera(0.1, 6e4), sun, 1e5)
    for (let i = 0; i < 3; i++) {
      const r = 1 / csm.cascades[i].projectionMatrix[0]
      expect(r).toBeCloseTo(WORLD_RADII[i], 6)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts`
Expected: FAIL——`anchor` 选项不存在（TS 类型报错或 update 仍走 frustum 路径，interval 值不符）。

- [ ] **Step 3: 实现——构造选项与 updateWorld**

`CascadedShadowMapsOptions` 追加字段（带中文注释说明 spec 出处）：

```ts
export interface CascadedShadowMapsOptions {
  cascadeCount: number
  mapSize: number
  splitLambda?: number
  fade?: boolean
  margin?: number
  /**
   * 矩阵锚定模式（spec v3 §3.1）：'frustum'（缺省）= 现实现视锥拟合；
   * 'world' = 固定 radii + 相机位置 texel snap（世界锚定，消移动闪动）。
   */
  anchor?: 'frustum' | 'world'
  /** world 模式：每层固定半径 m（spec §3.1.1 = 1.6×d 覆盖最坏取向）。缺省 [16e3, 33.6e3, 96e3]。 */
  worldRadii?: number[]
  /** world 模式：分层区间绝对距离 m（长度 cascadeCount+1；spec §3.1.4 常数区间）。缺省 [0, 10e3, 21e3, 60e3]。 */
  worldIntervals?: number[]
  /** world 模式：壳顶球半径 m（zNear 解析式用，spec §3.1.3）。缺省 6362200（bottomRadius 6360000 + shadowTopHeight 2200）。 */
  shellTopRadius?: number
  /** world 模式：near 面裕量 m（spec §3.1.3 约束 ≤30km）。缺省 3e4。 */
  worldMargin?: number
  /** world 模式：center.z snap 粗网格 m（spec §3.1.3）。缺省 1e3。 */
  zSnapGrid?: number
}
```

类构造器保存选项；`update()` 顶部加分支：

```ts
update(camera: CascadeCameraInput, sunDirection: Cartesian3, distance = 1): void {
  if (this.anchor === 'world') {
    this.updateWorld(camera, sunDirection)
    return
  }
  // ……现实现整体不动（frustum 分支 bit 级保留，spec §3.1.5）
}
```

私有方法 `updateWorld`（核心数学，单源构造——不调 lookAtMatrix，spec §3.1.9）：

```ts
/**
 * world 锚定分支（spec v3 §3.1）：
 * - interval 常数（不复用 splitFrustum——near=0 产 NaN，§3.1.4）
 * - center = 相机 light 投影 snap 到固定 texel 网格（原点=地心；§3.1.2）
 * - zNear 局部相对式（盘内壳顶之上 + margin；§3.1.3）+ 光心域→相机相对域换算
 * - 单源矩阵构造（light 基一次求出，§3.1.9）
 */
private updateWorld(camera: CascadeCameraInput, sunDirection: Cartesian3): void {
  const intervals = this.worldIntervals!
  const radii = this.worldRadii!
  const far = intervals[this.cascadeCount]
  this.far = far

  // 1) 常数 interval（归一化域）
  for (let i = 0; i < this.cascadeCount; i++) {
    this.cascades[i].interval.x = intervals[i] / far
    this.cascades[i].interval.y = intervals[i + 1] / far
  }
  this.cascades[0].interval.x = 0

  // 2) light 基（单源；z=+sunDirection 指向太阳，与现实现 lookAtMatrix(0,-sun) 同基）
  const zAxis = Cartesian3.normalize(sunDirection, new Cartesian3())
  let xAxis = Cartesian3.cross(UP, zAxis, new Cartesian3())
  if (Cartesian3.magnitude(xAxis) < 1e-9) {
    xAxis = Cartesian3.cross(new Cartesian3(1, 0, 0), zAxis, new Cartesian3())
  }
  Cartesian3.normalize(xAxis, xAxis)
  const yAxis = Cartesian3.cross(zAxis, xAxis, new Cartesian3())
  // ⚠️ row-major 参数序（69ee488 坑）：「列=basis」须逐行写各 basis 分量
  const rot = new Matrix3(
    xAxis.x, yAxis.x, zAxis.x,
    xAxis.y, yAxis.y, zAxis.y,
    xAxis.z, yAxis.z, zAxis.z
  )
  const invRot = Matrix3.transpose(rot, new Matrix3())

  // 3) 相机位置 → light 系（纯旋转，原点=地心）
  const camPos = Matrix4.getTranslation(camera.inverseViewMatrix, new Cartesian3())
  const camLight = Matrix3.multiplyByVector(invRot, camPos, new Cartesian3())

  for (let i = 0; i < this.cascadeCount; i++) {
    const radius = radii[i]
    const texel = (radius * 2) / this.mapSize
    const cascade = this.cascades[i]

    // center.xy snap 到固定 texel 网格；center.z snap 到粗网格（z 无消费语义，§3.1.3）
    const center = new Cartesian3(
      Math.round(camLight.x / texel) * texel,
      Math.round(camLight.y / texel) * texel,
      Math.round(camLight.z / this.zSnapGrid) * this.zSnapGrid
    )

    // zNear 局部相对式（光心域，spec §3.1.3）：盘内壳顶最大 z + margin
    const rhoC = Math.hypot(center.x, center.y)          // 盘心距日轴
    const rhoMin = Math.max(0, rhoC - radius)             // 盘缘最近距日轴
    const Rtop = this.shellTopRadius
    const zNearGeo = Math.sqrt(Rtop * Rtop - rhoMin * rhoMin) + this.worldMargin
    // 域换算：光心域 z → light 相机相对域（相机原点=centerWorld，其 light z=center.z）
    const orthoNear = zNearGeo - center.z
    const orthoFar = orthoNear + 2e5 // far 随意给足（clip.z 全管线无消费，spec §3.1.3）

    // ortho（非对称绕 snap 后 center；Cesium 参数序 (l,r,bottom,top,near,far)）
    Matrix4.computeOrthographicOffCenter(
      center.x - radius, center.x + radius,
      center.y - radius, center.y + radius,
      orthoNear, orthoFar,
      cascade.projectionMatrix
    )

    // 单源 light 相机：rotation=rot、translation=centerWorld（§3.1.9，不走 lookAtMatrix）
    const centerWorld = Matrix3.multiplyByVector(rot, center, new Cartesian3())
    Matrix4.fromRotationTranslation(rot, centerWorld, cascade.inverseViewMatrix)

    Matrix4.inverse(cascade.projectionMatrix, cascade.inverseProjectionMatrix)
    Matrix4.inverse(cascade.inverseViewMatrix, cascade.viewMatrix)
    Matrix4.multiply(cascade.projectionMatrix, cascade.viewMatrix, cascade.matrix)
    Matrix4.multiply(cascade.inverseViewMatrix, cascade.inverseProjectionMatrix, cascade.inverseMatrix)
  }
}
```

构造器保存字段（缺省值按 Global Constraints 设计值）；`zAxis` 的 normalize 注意 sunDirection 调用方已单位化（仍防御 normalize）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts`
Expected: PASS（新用例 + 旧用例全绿——旧用例走 frustum 缺省分支不变）。

- [ ] **Step 5: 写失败测试——时序稳定性（f32 仿真）**

追加测试组：

```ts
// f32 仿真（GPU float32 近似——spec §6：f64 域断言会平凡通过）
const f32m = (m: Matrix4): Matrix4 => {
  const out = new Matrix4()
  for (let i = 0; i < 16; i++) (out as unknown as number[])[i] = Math.fround(m[i])
  return out
}
const uvOf = (m: Matrix4, p: Cartesian3): Cartesian2 => {
  const v = Matrix4.multiplyByPoint(m, p, new Cartesian3())
  return new Cartesian2(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5) // ortho w=1
}

it('纯旋转（heading/pitch 变、位置不动）：矩阵 f32 化后逐帧不变（spec §3.1.2 最强性质）', () => {
  const csm = makeWorldCSM()
  const cam = makeCamera(0.1, 6e4)
  csm.update(cam, sun, 1e5)
  const base = csm.cascades.map(c => f32m(c.matrix))
  // 绕视轴 + 俯仰各转一次（位置恒定）：构造带旋转的 inverseViewMatrix
  const rotM = (rx: number, rz: number) =>
    Matrix4.fromRotationTranslation(
      Matrix3.multiply(Matrix3.fromRotationZ(rz), Matrix3.fromRotationX(rx), new Matrix3()),
      new Cartesian3(0, 0, 6.371e6 + 8e3)
    )
  for (const [rx, rz] of [[0.2, 0], [-0.15, 0.4], [0, 0.7]]) {
    csm.update({ ...cam, inverseViewMatrix: rotM(rx, rz) }, sun, 1e5)
    for (let i = 0; i < 3; i++) {
      const now = f32m(csm.cascades[i].matrix)
      for (let e = 0; e < 16; e++) {
        expect((now as unknown as number[])[e]).toBe((base[i] as unknown as number[])[e])
      }
    }
  }
})

it('平移：同一世界点 UV 相位稳定（f32 仿真 |Δuv·mapSize − round| < 0.1 texel，spec §3.1.7）', () => {
  const csm = makeWorldCSM()
  const cam = makeCamera(0.1, 6e4)
  const probe = new Cartesian3(5e3, -2e3, 6.371e6 + 8.5e3) // 云内一点
  let prevUv: Cartesian2 | undefined
  for (let s = 0; s < 8; s++) {
    const inv = Matrix4.fromTranslation(new Cartesian3(s * 30, 0, 6.371e6 + 8e3))
    csm.update({ ...cam, inverseViewMatrix: inv }, sun, 1e5)
    const uv = uvOf(f32m(csm.cascades[0].matrix), probe)
    if (prevUv != null) {
      const dx = (uv.x - prevUv.x) * 512
      const dy = (uv.y - prevUv.y) * 512
      expect(Math.abs(dx - Math.round(dx))).toBeLessThan(0.1)
      expect(Math.abs(dy - Math.round(dy))).toBeLessThan(0.1)
    }
    prevUv = uv
  }
})

it('缩放（near/far 大变）：矩阵不变（spec §3.1.5 far 不随视锥）', () => {
  const csm = makeWorldCSM()
  csm.update(makeCamera(0.1, 6e4), sun, 1e5)
  const base = csm.cascades.map(c => Matrix4.clone(c.matrix))
  csm.update(makeCamera(0.1, 2e4), sun, 1e5) // far 6e4→2e4（multi-frustum 分段态）
  csm.update(makeCamera(5, 1.2e5), sun, 1e5)
  for (let i = 0; i < 3; i++) {
    expect(csm.cascades[i].matrix).toEqual(base[i])
  }
})
```

注意：`await_import_placeholder` 处直接在文件顶 import `Matrix3`（现有 import 已含 `Matrix4, Cartesian3`，补 `Matrix3`）。`f32m` 用 `as unknown as number[]` 访问 Matrix4 内部列主序数组（Cesium Matrix4 是 length=16 的类数组）。

- [ ] **Step 6: 跑测试**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts`
Expected: 三个时序用例 PASS（若平移相位用例失败：检查 snap 公式 `Math.round(camLight.x/texel)*texel` 与消费矩阵链是否同源——生成/消费共用同一 `cascade.matrix`，理论自洽；失败超 0.1 texel 则按 spec §3.1.7 兜底预案记录并停下汇报）。

- [ ] **Step 7: 类型检查 + 全量回归**

Run: `pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit && pnpm --filter @cesium-geospatial/clouds exec vitest run`
Expected: 无类型错误，全绿。

- [ ] **Step 8: Commit**

```bash
git add packages/cesium-clouds/src/CascadedShadowMaps.ts packages/cesium-clouds/src/CascadedShadowMaps.test.ts
git commit -m "feat(clouds): BSM world 锚定矩阵核心——固定 radii/相机 snap/常数 interval/单源构造/zNear 解析式"
```

---

### Task 2: zNear 极端太阳角回归 + velocity 整数平移不变量

**Files:**
- Modify: `packages/cesium-clouds/src/CascadedShadowMaps.test.ts`（只加测试——Task 1 实现已完整）

**Interfaces:**
- Consumes: Task 1 的 `updateWorld`（shellTopRadius/worldMargin 选项）。
- Produces: 回归测试组（防 §3.1.3 现存 bug 复发——zenith→1 全量归零）。

- [ ] **Step 1: 写极端太阳角测试（near 面在盘内壳顶之上）**

```ts
it('zNear 极端太阳角（2°/10°/30°/60°/正午低相机）：z=-1 反投影面全盘在壳顶之上（spec §3.1.3）', () => {
  const csm = makeWorldCSM()
  const Rtop = 6362200
  // 各太阳角：sun 从近水平（2°）到正午
  for (const deg of [2, 10, 30, 60, 89]) {
    const el = CesiumMath.toRadians(deg)
    const sunI = Cartesian3.normalize(
      new Cartesian3(Math.cos(el), 0.1, Math.sin(el)), new Cartesian3())
    const cam = makeCamera(0.1, 6e4, Math.PI / 3, 800) // 低相机 800m（zenith bug 触发高度）
    csm.update(cam, sunI, 1e5)
    for (let i = 0; i < 3; i++) {
      const inv = csm.cascades[i].inverseMatrix
      // 全盘角点（clip xy=±1, z=-1）反投影 → |p| 必须 > Rtop（壳顶球外）
      for (const cx of [-1, 1]) for (const cy of [-1, 1]) {
        const p4 = Matrix4.multiplyByVector(
          inv, new Cartesian4(cx, cy, -1, 1), new Cartesian4())
        const p = Cartesian3.fromElements(p4.x / p4.w, p4.y / p4.w, p4.z / p4.w)
        expect(Cartesian3.magnitude(p)).toBeGreaterThan(Rtop)
      }
    }
  }
})
```

文件顶 import 补 `Cartesian4, Math as CesiumMath`（若未有）。

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts -t "zNear"`
Expected: PASS（Task 1 的解析式已正确；若 FAIL——margin 不足或 ρ_min 公式错——修 Task 1 实现的公式，不改测试）。

- [ ] **Step 3: 写 velocity 整数平移不变量测试（resolve 重投影精确性，spec §3.1.6）**

```ts
it('整数 texel 平移帧：同一世界点新旧矩阵 UV 差恰为整数 texel（velocity 精确重投影前提）', () => {
  const csm = makeWorldCSM()
  const cam = makeCamera(0.1, 6e4)
  const probe = new Cartesian3(4e3, 1e3, 6.371e6 + 9e3)
  // 帧序列：一次跳 N texel 的平移（N = texel 整数倍）
  csm.update(cam, sun, 1e5)
  const uvA = uvOf(csm.cascades[0].matrix, probe)
  const texel = (WORLD_RADII[0] * 2) / 512
  const inv = Matrix4.fromTranslation(new Cartesian3(7 * texel, -3 * texel, 6.371e6 + 8e3))
  csm.update({ ...cam, inverseViewMatrix: inv }, sun, 1e5)
  const uvB = uvOf(csm.cascades[0].matrix, probe)
  const dx = (uvB.x - uvA.x) * 512
  const dy = (uvB.y - uvA.y) * 512
  expect(Math.abs(dx - Math.round(dx))).toBeLessThan(1e-6)
  expect(Math.abs(dy - Math.round(dy))).toBeLessThan(1e-6)
  expect(Math.round(dx)).toBe(-7) // 网格平移 +7 texel → 同点 uv 反向平移 7
  expect(Math.round(dy)).toBe(3)
})
```

- [ ] **Step 4: 跑全量 + Commit**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts`
Expected: PASS。

```bash
git add packages/cesium-clouds/src/CascadedShadowMaps.test.ts
git commit -m "test(clouds): world 锚定 zNear 极端太阳角回归 + velocity 整数平移不变量用例"
```

---

### Task 3: 太阳向量量化工具

**Files:**
- Create: `packages/cesium-clouds/src/sunQuantization.ts`
- Test: `packages/cesium-clouds/src/sunQuantization.test.ts`

**Interfaces:**
- Produces: `quantizeSunDirection(direction: Cartesian3, step: number, result: Cartesian3): Cartesian3`（ECEF 单位球网格量化——球坐标 theta/phi 各 snap 到 step 网格后重建归一化；spec §3.1.8）。`SUN_QUANT_STEP = 8.7e-4`（0.05°）常量导出。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import { quantizeSunDirection, SUN_QUANT_STEP } from './sunQuantization'

describe('quantizeSunDirection（spec §3.1.8 太阳向量量化）', () => {
  it('幂等：量化结果再量化不变', () => {
    const d = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())
    const q1 = quantizeSunDirection(d, SUN_QUANT_STEP, new Cartesian3())
    const q2 = quantizeSunDirection(q1, SUN_QUANT_STEP, new Cartesian3())
    expect(q2).toEqual(q1)
  })
  it('步进边界：输入微动 (<step/4) 不跨格；跨格跳变角 ≤ step', () => {
    const d = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())
    const q = quantizeSunDirection(d, SUN_QUANT_STEP, new Cartesian3())
    const angle = Math.acos(Math.min(1, Math.max(-1, Cartesian3.dot(d, q))))
    expect(angle).toBeLessThanOrEqual(SUN_QUANT_STEP * 1.5)
    // 微动 1e-6 rad：量化结果不变（同格）
    const d2 = Cartesian3.normalize(
      Cartesian3.add(d, new Cartesian3(1e-6, 0, 0), new Cartesian3()), new Cartesian3())
    const q2 = quantizeSunDirection(d2, SUN_QUANT_STEP, new Cartesian3())
    expect(Cartesian3.dot(q, q2)).toBeCloseTo(1, 12)
  })
  it('输出恒单位向量', () => {
    for (const d of [
      new Cartesian3(0, 0, 1), new Cartesian3(1, 0, 0),
      Cartesian3.normalize(new Cartesian3(-0.5, 0.8, 0.3), new Cartesian3())
    ]) {
      const q = quantizeSunDirection(d, SUN_QUANT_STEP, new Cartesian3())
      expect(Math.abs(Cartesian3.magnitude(q) - 1)).toBeLessThan(1e-9)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/sunQuantization.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

```ts
// sunQuantization.ts
//
// 太阳方向量化（spec v3 §3.1.8）：仅作用于 BSM 矩阵构造输入（light 基/snap/跳过判据），
// march 与消费端保持精确 sunDirection。ECEF 单位球网格量化（球坐标 theta/phi 各 snap），
// 跨 ICRF/GMST-fallback 分支一致（比量化时间直接）。demo 时钟静止时 sunDirection 恒定
// → 量化零触发；跑钟跨步频率 ≈ 0.05°/(15°/h) ≈ 每 12s 一次。
import { Cartesian3 } from 'cesium'

/** 量化步长 rad（0.05°，spec §3.1.8）。 */
export const SUN_QUANT_STEP = 8.7e-4

/**
 * ECEF 单位球网格量化：theta = acos(z)、phi = atan2(y,x) 各 snap 到 step 网格后重建。
 * 太阳赤纬带 |dec|<23.4° 不经极区（theta≈0 处 phi 退化无害——向量连续）。
 */
export function quantizeSunDirection(
  direction: Cartesian3,
  step: number,
  result: Cartesian3
): Cartesian3 {
  const theta = Math.acos(Math.min(1, Math.max(-1, direction.z)))
  const phi = Math.atan2(direction.y, direction.x)
  const qTheta = Math.round(theta / step) * step
  const qPhi = Math.round(phi / step) * step
  const sinT = Math.sin(qTheta)
  return Cartesian3.fromElements(
    sinT * Math.cos(qPhi),
    sinT * Math.sin(qPhi),
    Math.cos(qTheta),
    result
  )
}
```

- [ ] **Step 4: 跑测试通过 + Commit**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/sunQuantization.test.ts`
Expected: PASS。

```bash
git add packages/cesium-clouds/src/sunQuantization.ts packages/cesium-clouds/src/sunQuantization.test.ts
git commit -m "feat(clouds): 太阳向量量化工具——ECEF 单位球网格量化（BSM 矩阵输入专用）"
```

---

### Task 4: 编排接线（shadowAnchor 开关 + 量化输入 + far/near 固定 + demo URL）

**Files:**
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`
- Modify: `packages/cesium-clouds/src/createCloudsStage.test.ts`
- Modify: `apps/demo/src/main.ts`
- Test: `packages/cesium-core/src/cascadedShadowMaps.glsl.test.ts`（锚点更新——若 world 模式不改 GLSL 则补「u_shadowCameraNear 注入 0」JS 侧断言于 createCloudsStage.test.ts）

**Interfaces:**
- Consumes: Task 1 `anchor:'world'` 选项；Task 3 `quantizeSunDirection`。
- Produces: `CloudsStageOptions.shadowAnchor?: 'world' | 'frustum'`（缺省 **world**）；demo `?cloudsShadowAnchor=frustum`。

- [ ] **Step 1: 写失败测试（createCloudsStage.test.ts 追加）**

```ts
it('world 锚定缺省：shadowState.far 恒 6e4（不随 camera.far）、cameraNear=0（spec §3.1.5）', async () => {
  // 用现有测试的 stage 构造 helper（该文件已有 createCloudsStage 测试基建——沿用其
  // stub scene/context 模式；world 模式不创建 GL 资源路径按现有用例）
  const handle = makeStage({ clouds: true }) as NonNullable<ReturnType<typeof createCloudsStage>>
  // 模拟 preRender：camera.far=2e4（multi-frustum 分段态）
  firePreRender({ far: 2e4, near: 5 })
  expect(handle.shadowState.far).toBe(6e4)
  expect(handle.shadowState.cameraNear).toBe(0)
})

it('shadowAnchor=frustum 回退：far 含 camera.far 参与（bit 级现行为）', async () => {
  const handle = makeStage({ clouds: true, shadowAnchor: 'frustum' })
  firePreRender({ far: 2e4, near: 5 })
  expect(handle.shadowState.far).toBe(2e4)
  expect(handle.shadowState.cameraNear).toBe(5)
})
```

（`makeStage`/`firePreRender` 沿用该测试文件**已有的** stub scene/preRender 触发模式——文件里已有 cascades.update 编排用例，复用其基建；若 helper 名不同以现有为准，不新造轮子。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/createCloudsStage.test.ts`
Expected: FAIL——shadowAnchor 选项不存在。

- [ ] **Step 3: 实现 createCloudsStage**

`CloudsStageOptions` 追加：

```ts
/**
 * BSM 矩阵锚定模式（spec v3）：'world'（缺省）= 世界锚定固定网格；
 * 'frustum' = 现实现视锥拟合（AB 对照基线，bit 级保留含已知缺陷）。
 * demo `?cloudsShadowAnchor=frustum`。
 */
shadowAnchor?: 'world' | 'frustum'
```

preRender 内 BSM 段改造（对照现 L433-476 结构，保留 `shadowFreeze` 诊断块）：

```ts
if (shadowPass != null) {
  const worldAnchor = (options.shadowAnchor ?? 'world') === 'world'
  // 太阳量化（仅矩阵输入；march/消费端 state.sunDirection 精确——spec §3.1.8）
  const qSun = worldAnchor
    ? quantizeSunDirection(state.sunDirection, SUN_QUANT_STEP, qSunScratch)
    : state.sunDirection
  // far/near：world 固定（不随视锥）；frustum bit 级现行为（spec §3.1.5）
  const far = worldAnchor
    ? Math.min(params.maxRayDistance, SHADOW_FAR_LIMIT)
    : Math.min(camera.frustum.far, params.maxRayDistance, SHADOW_FAR_LIMIT)
  const near = worldAnchor ? 0 : camera.frustum.near
  if (!options.shadowFreeze || !matricesFrozen) {
    cascades.update(
      {
        inverseViewMatrix: camera.inverseViewMatrix,
        projectionMatrix: (camera.frustum as unknown as { projectionMatrix: Matrix4 })
          .projectionMatrix,
        near, far
      },
      qSun
      // world 分支 distance 参数无消费（z 盒解析，spec §3.2 distance 常数化）；
      // frustum 分支保留 zenith lerp distance：
      , worldAnchor ? undefined : 1e6 + (1e3 - 1e6) * zenith
    )
    // zenith 仅 frustum 分支需要（world 不用 distance）——把现 zenith 计算移进 else 分支
    ...
  }
  shadowState.cameraNear = near
  shadowState.far = far
  ...
}
```

实现要点（写码时落实，以上为骨架）：
- `qSunScratch` 模块级 `new Cartesian3()` scratch。
- 现有 `normal/zenith/distance` 计算段移入 `!worldAnchor` 分支（world 不需要）。
- `cascades` 构造处加 `anchor` 与设计值选项：`new CascadedShadowMaps({ cascadeCount, mapSize, ...(worldAnchor ? { anchor: 'world' as const } : {}) })`（worldRadii/worldIntervals 用类内缺省值——Global Constraints 设计值）。
- `update()` 第三参缺省 `distance = 1`——frustum 现调用传原 lerp 值；world 传 `undefined` 走缺省（updateWorld 不读它）。

- [ ] **Step 4: demo main.ts 接线**

```ts
// cloudsShadowAnchor（spec v3）：默认 world 世界锚定；?cloudsShadowAnchor=frustum 回退
// 视锥拟合（AB 对照基线）
...(getString('cloudsShadowAnchor') === 'frustum' ? { shadowAnchor: 'frustum' as const } : {}),
```

console.info 接线提示（L399 附近）补 `?cloudsShadowAnchor=frustum 回退视锥锚定`。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit`
Expected: 全绿（含旧 22 用例——`shadowState.far` 旧断言 `toBe(6e4)` 在 world 缺省下语义不变；`createCloudsStage.test.ts` 现有 far 断言若以 frustum 语义写需按用例意图归到 frustum 分支或更新期望——逐个核对）。

- [ ] **Step 6: Commit**

```bash
git add packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts apps/demo/src/main.ts
git commit -m "feat(clouds): shadowAnchor 编排接线——world 缺省/量化太阳喂矩阵/far+cameraNear 固定/frustum 回退"
```

---

### Task 5: 静止跳过（语义键 + render 跳过）

**Files:**
- Modify: `packages/cesium-clouds/src/CascadedShadowMaps.ts`
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`
- Test: `packages/cesium-clouds/src/CascadedShadowMaps.test.ts`、`packages/cesium-clouds/src/createCloudsStage.test.ts`

**Interfaces:**
- Consumes: Task 1 `updateWorld` 内部 snap 值。
- Produces: `update(...): boolean`（矩阵是否变化——world 分支语义键比较；frustum 恒 `true`）；编排「键相同跳过整个 `shadowPass.render()`」。

- [ ] **Step 1: 写失败测试（CascadedShadowMaps.test.ts）**

```ts
it('update 返回值：world 下矩阵不变帧返回 false（同相机+同太阳+同 A 档），变化帧 true（spec §3.2）', () => {
  const csm = makeWorldCSM()
  const cam = makeCamera(0.1, 6e4)
  expect(csm.update(cam, sun, 1e5)).toBe(true)   // 首帧
  expect(csm.update(cam, sun, 1e5)).toBe(false)  // 同输入
  expect(csm.update(makeCamera(0.1, 2e4), sun, 1e5)).toBe(false) // 缩放不变
  const inv = Matrix4.fromTranslation(new Cartesian3(2e4, 0, 6.371e6 + 8e3))
  expect(csm.update({ ...cam, inverseViewMatrix: inv }, sun, 1e5)).toBe(true) // 大平移跨格
  const sun2 = Cartesian3.normalize(new Cartesian3(0.31, 0.2, 1), new Cartesian3())
  expect(csm.update({ ...cam, inverseViewMatrix: inv }, sun2, 1e5)).toBe(true) // 太阳跨格
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run src/CascadedShadowMaps.test.ts -t "update 返回值"`
Expected: FAIL——update 返回 void。

- [ ] **Step 3: 实现——updateWorld 内语义键**

`updateWorld` 末尾：构造键字符串（各层 snap 后 `center` 三分量 + 量化太阳两角格点序号），与 `this._lastWorldKey` 比较；不同则存新键返回 true。键含：

```ts
const key = cascades.map(c => c.centerKey).join('|') + `|${thetaGrid},${phiGrid}`
// centerKey 在每层循环里拼：`${cx},${cy},${cz}`（snap 后确定值）
```

（`_lastWorldKey` 私有字段，构造时 undefined；frustum 分支 return true。）`update()` 签名 `update(...): boolean`，frustum 路径末尾 `return true`。

- [ ] **Step 4: 编排接入跳过**

createCloudsStage preRender（Task 4 结构上）：

```ts
const changed = cascades.update({...}, qSun, ...)
if (!options.shadowFreeze || !matricesFrozen) { /* 上面的 update 在此块内 */ }
if (changed || matricesFrozen === false) {
  // clone 矩阵 + setCurrentMatrices + shadowPass.render()
}
matricesFrozen = true
```

实现时理顺 freeze 与 skip 的组合：freeze 诊断（跳过 update）与本任务 skip（update 照跑、跳过 render）正交——freeze 时 update 首帧后不跑，render 也跳过（与 freeze 语义一致，保留现有行为）。skip 判据 = `update()` 返回 false。

- [ ] **Step 5: 写编排测试（createCloudsStage.test.ts）**

```ts
it('静止跳过：矩阵不变帧不调 shadowPass.render（spec §3.2 白赚）', async () => {
  const handle = makeStage({ clouds: true })
  const renderCalls = [] // 经 stub ShadowPass 计数（现有 createDrawPass stub 模式）
  firePreRender({ far: 6e4, near: 0.1 })
  firePreRender({ far: 6e4, near: 0.1 }) // 同输入
  expect(renderCalls.length).toBe(1)
  firePreRender({ far: 6e4, near: 0.1, move: [2e4, 0, 0] }) // 跨格平移
  expect(renderCalls.length).toBe(2)
})
```

（stub 计数方式沿用该文件已有 `createDrawPass` 注入模式——ShadowPass 构造选项 `createDrawPass` 已支持测试注入。）

- [ ] **Step 6: 全量测试 + 类型检查 + Commit**

Run: `pnpm --filter @cesium-geospatial/clouds exec vitest run && pnpm --filter @cesium-geospatial/clouds exec tsc --noEmit`
Expected: 全绿。

```bash
git add packages/cesium-clouds/src/CascadedShadowMaps.ts packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/CascadedShadowMaps.test.ts packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "feat(clouds): BSM 静止跳过——语义键判矩阵变化，静止帧零 render 成本"
```

---

### Task 6: 端到端验收（四探针 AB + E1' + 静态截图 + 跑钟 + 低太阳角 + results）

**Files:**
- Modify: `apps/demo/src/main.ts`（补 `?cloudsProbeOrbit=N`、`?cloudsShadowScale=N` 诊断参数）
- Create: `docs/superpowers/plans/2026-08-28-bsm-world-anchored-cascade-results.md`

**Interfaces:**
- Consumes: Task 1-5 全部；spec §6 验收清单。
- Produces: 验收数据表 + results 文档 + 修复迭代（若不达标按 spec §7 风险表归因路径走）。

- [ ] **Step 1: demo 补两个探针参数**

```ts
// 轨道探针（spec §6 主战场）：每帧 rotateLeft N 弧度（绕焦点，位姿耦合移动）
const probeOrbit = getNumber('cloudsProbeOrbit')
if (probeOrbit != null && probeOrbit > 0) {
  let orbitFrame = 0
  scene.preRender.addEventListener(() => {
    if (++orbitFrame > 30) viewer.camera.rotateLeft(probeOrbit)
  })
}
// worldRadii 缩放（E1' 归因实验用）：world 模式 radii×N（膨胀覆盖全程航迹）
// ——CloudsStageOptions 透传 worldRadii 覆盖（Task 4 选项已支持 worldRadii 注入）
```

`cloudsShadowScale` 实现：`worldRadii: WORLD_RADII_DEFAULT.map(r => r * scale)`——需在 clouds 包导出缺省 radii 常量（`WORLD_RADII_DEFAULT`/`WORLD_INTERVALS_DEFAULT` 从 CascadedShadowMaps.ts export）并透传选项。

- [ ] **Step 2: 构建 + 清缓存起服务**

Run: `pkill -f vite; rm -rf apps/demo/node_modules/.vite; nohup pnpm dev > /tmp/vite-bsm.log 2>&1 &`（日志路径换 `$CLAUDE_JOB_DIR/tmp` 若在 bg job 内）
验证：`grep -m1 Local: <log>` 得端口。

- [ ] **Step 3: 四探针 AB 录屏差分（spec §6 核心验收）**

每组 = 同 URL 仅 `cloudsShadow` 开/关 AB（world 模式另测 `?cloudsShadowAnchor=frustum` 对照复现旧值）。基准视角 `camera=-80.6057,64.5197,7852,68.8,-17.8`、`time=2026-08-28T17:30:00Z`：

| 探针 | URL 参数 | 指标 |
|---|---|---|
| 慢速轨道 | `cloudsProbeOrbit=0.0008` | 增量<0.3%（旧 1.55%） |
| 慢速平移 | `cloudsProbeMove=3` | 增量<0.3%（旧 0.17%） |
| 快速平移 | `cloudsProbeMove=12` | 增量<0.3%（旧 0.69%） |
| dolly 缩放 | 手动滚轮录屏（或后续脚本） | 增量<0.3% |

流程每组：`agent-browser open <url>` → wait networkidle → sleep 4 → `record start/stop 10s` → `ffmpeg -i x.webm -vf fps=10 f-%02d.png` → PIL 帧差分（复用 `$CLAUDE_JOB_DIR/tmp/analyze_gate.py` 模式：`pct>20` 均值）。**每组 BSM 关基线必须同速重测**（增量=开−关）。

- [ ] **Step 4: E1' 归因实验（若轨道/快速平移不达标）**

`?cloudsShadowFreeze=1&cloudsShadowScale=5&cloudsProbeMove=12`（radii×5={80,168,480}km 覆盖全程航迹）+ BSM 关对照 → 非 snap 噪声地板。归因决策按 spec §7 首要风险行。

- [ ] **Step 5: 静态 AB 截图 + 跑钟 + 低太阳角 + 静止跳过计数**

- 静态截图：world vs `cloudsShadowAnchor=frustum` 同视角 PNG → `agent-browser diff screenshot --baseline` 或目测对比（覆盖/精度回归；正午低相机差异=「world 修 bug」非回归，spec §6 注记）。
- 跑钟：URL 加 `&ionToken=...`（无则跳过）+ Cesium clock 流动需 demo 手动开启——**demo 未接跑钟参数，本项按 spec §6 降级为「跑钟场景暂不验收，太阳静止已覆盖主验收」记录到 results**（跑钟专项留待用户需要时加 `?cloudsClock=1` 再验）。
- 低太阳角近景：`time` 取日落时刻 + `camera` 低高度近景，目测 PCF 软化（texel 62.5m×6=375m 半影）；过软记录到 results（分档 radii 是预案不在本计划）。
- 静止跳过计数：console 加一次性输出（或 DevTools network/任务管理器 GPU 占用对比）——`?cloudsShadowFreeze=0` 静止 10s，确认 render 调用次数 ≈1（Task 5 单测已覆盖逻辑，此处端到端 sanity）。

- [ ] **Step 6: 全量测试 + 写 results 文档**

`pnpm test` 全绿后，写 `docs/superpowers/plans/2026-08-28-bsm-world-anchored-cascade-results.md`：验收数据表（四探针 AB 数值）、E1' 结果（若做）、静态截图结论、已知项（跑钟未验、低太阳角软化观察）、spec §7 风险表对照结论。

- [ ] **Step 7: Commit + 汇报**

```bash
git add apps/demo/src/main.ts docs/superpowers/plans/2026-08-28-bsm-world-anchored-cascade-results.md
git commit -m "feat(clouds): BSM 世界锚定端到端验收——四探针 AB 差分+results 文档"
git push
```

汇报用户：验收数值 vs 目标、遗留项、验收 URL。

---

## Self-Review 记录

- **Spec 覆盖**：§3.1.1（Task 1 radii/interval）、§3.1.2（Task 1 snap）、§3.1.3（Task 1 zNear + Task 2 极端角回归）、§3.1.4（Task 1 常数区间+NaN）、§3.1.5（Task 4 far/near 固定+frustum 保留）、§3.1.6（Task 2 velocity 不变量；机理重述进代码注释）、§3.1.7（Task 1 f32 测试）、§3.1.8（Task 3 量化+Task 4 接线）、§3.1.9（Task 1 单源构造）、§3.2（Task 4/5 编排+跳过）、§5 设计值（Global Constraints）、§6 验收（Task 6）✓。跑钟专项按 Step 5 明示降级（demo 无时钟参数，非本计划范围）。
- **占位符扫描**：Task 4 Step 3 的「`...` 省略」段已注明为实现骨架+要点清单（zenith 计算移分支等），执行者需按要点补全——非 TBD，有明确行为定义。Task 5 Step 4 同理给出逻辑条件。可接受。
- **类型一致性**：`anchor/worldRadii/worldIntervals/shellTopRadius/worldMargin/zSnapGrid`（Task 1 定义，Task 4/5 消费）；`quantizeSunDirection/SUN_QUANT_STEP`（Task 3 定义，Task 4 消费）；`update(): boolean`（Task 5 定义并消费）✓。
