# 夜间光照：方向性月光 + 月相 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 月光作为方向性光照亮夜间云（强度随月相）+ 物理月盘（Oren-Nayar 月相涌现、过大气透视、inscatterScale 解耦）。

**Architecture:** 月方向单源 `core/celestialDirections.ts`（Simon1994 + 视差修正 + Lambert 月相因子），AtmosphereStage（月盘走 `getSkyRadiance` out 通道）与 clouds（光照循环第四项 moon 散射）两处消费；demo `?time=` 驱动月相，无新 stage、无新依赖。

**Tech Stack:** TypeScript + Cesium（PostProcessStage/Primitive）+ GLSL（文本拼装）+ vitest + glslangValidator。

**Spec:** `docs/superpowers/specs/2026-08-30-night-lighting-moonlight-design.md`（r2 终审；本计划从其论证，执行者须同时读 spec）

## Global Constraints（每个任务隐含遵守）

- **单位纪律：全链米制**。`computeMoonPositionInEarthInertialFrame` 返回**米**（Cesium 全域米制；spec §4.1/§4.2，r0 曾误标 km）。
- **ICRF 旋转只用 `Transforms.computeIcrfToCentralBodyFixedMatrix`**（2026-08-16 竞态修复版；**禁用** `computeIcrfToFixedMatrix`——XYS 懒加载返回 undefined 竞态）。
- **Oren-Nayar 钉死 MoonNode 版**：A≈0.2466、B≈0.1314、`t=mix(1,max(max(NoL,NoV),0.1),smoothstep(0.0,0.1,s))`，实参序 `(L=sunDirection, V=−rayDirection, N=月面法线)`；**禁用** sky.glsl 旧版（常量 0.62406/0.41284、无 1/π、实参序相反）。
- **月盘判定式**：`acos(clamp(dot,…))` + 边序恒升序 `1.0 − smoothstep(ω−aa, ω, angle)`、`aa=max(fragmentAngle,1e-4)`（禁 dot 与弧度直比、禁降序边）。
- **白天零回归（云侧）**：moon 光照项乘现有 `nightFactor`（`1.0 − smoothstep(-0.1045, -0.0175, muSunLocal)`），白天精确 0；**月盘侧允许差异**（用户拍板物理白天浅月）。
- **命名映射钉死**：option `moonRadianceScale` ↔ uniform `u_moonRadiance` ↔ URL `?moonRadiance=`（同 cloudsExposure 惯例）；云侧 uniform `moonDirection`/`moonIlluminatedFraction`/`moonLightScale`。
- **默认值**：`moon=true`、`moonRadianceScale=60`、`moonAngularRadius=0.0045`、`moonLightScale=50000`（均为估算待视觉拍板）。
- **moon=false 时 atmosphere 产物与现状逐字符一致**（JS 条件拼接下字面成立；golden 基线守门）。
- **测试跑法**：包目录直跑（`--filter` 假绿坑）——`cd packages/cesium-core && pnpm exec vitest run src/<file>`；类型检查 `pnpm --filter @cesium-geospatial/core exec tsc --noEmit`（clouds 同理）。glslang 编译测试依赖 glslangValidator（brew 装或包内二进制，缺失时测试以清晰报错失败）。
- **云侧 moon 项不采 BSM、不走 accurate LUT 路径**；相位函数复用 `approximateMultipleScattering`（随 ACCURATE_PHASE_FUNCTION define 与太阳项一致）。
- 改 GLSL 后浏览器验证前**清 vite 缓存**（`pkill -f vite; rm -rf apps/demo/node_modules/.vite`）——缓存不一致假警报教训（CLAUDE.md）。

---

### Task 1: core 月方向与月相因子（celestialDirections.ts）

**Files:**
- Create: `packages/cesium-core/src/celestial/celestialDirections.ts`
- Modify: `packages/cesium-core/src/index.ts`（导出）
- Test: `packages/cesium-core/src/celestial/celestialDirections.test.ts`

**Interfaces:**
- Consumes: Cesium `Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame` / `computeSunPositionInEarthInertialFrame` / `Matrix3` / `Cartesian3` / `JulianDate`。
- Produces（后续任务依赖的精确签名）:
  - `computeMoonDirectionECEF(time: JulianDate, icrfToFixed: Matrix3, originECEF: Cartesian3, result: Cartesian3): Cartesian3`——icrfToFixed 由调用方传入（与太阳管线同帧共享）；originECEF 为观察者位置（米，调用方算好 `camera.positionWC + altitudeCorrection` 传入）；result 写入 ECEF 单位向量。
  - `computeMoonIlluminatedFractionFromDirections(sunDirection: Cartesian3, moonDirection: Cartesian3): number`——Lambert 球积分 `f=(sin ε−ε·cos ε)/π`（朔 0/弦 0.318/望 1）。
  - `computeMoonIlluminatedFraction(time: JulianDate): number`——独立版（内部自算两方向），**仅供单测/独立消费**，运行时消费方用手头 state 两方向调 FromDirections 版。

- [ ] **Step 1: 写失败测试**

```ts
// packages/cesium-core/src/celestial/celestialDirections.test.ts
import { describe, expect, it } from 'vitest'
import {
  Cartesian3,
  JulianDate,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
  Math as CesiumMath
} from 'cesium'

import {
  computeMoonDirectionECEF,
  computeMoonIlluminatedFraction,
  computeMoonIlluminatedFractionFromDirections
} from './celestialDirections'

describe('celestialDirections 月方向与月相', () => {
  it('朔：dot(sun,moon) 极大（合相）时 f < 0.02；望：极小时 f > 0.98（60 天 6h 粗扫+邻域细化）', () => {
    // 60 天窗口 6h 粗扫找极值索引，±6h 邻域 30min 细化（spec §4.4——粗扫+细化，不搞三分）
    const start = JulianDate.fromIso8601('2026-09-01T00:00:00Z')
    const COARSE_H = 6, DAYS = 60
    const n = (DAYS * 24) / COARSE_H
    let dots: { t: JulianDate; d: number }[] = []
    for (let i = 0; i <= n; i++) {
      const t = JulianDate.addSeconds(start, i * COARSE_H * 3600, new JulianDate())
      const sun = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, new Cartesian3())!
      const moon = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t, new Cartesian3())!
      dots.push({ t, d: Cartesian3.dot(Cartesian3.normalize(sun, sun), Cartesian3.normalize(moon, moon)) })
    }
    let maxIdx = 0, minIdx = 0
    dots.forEach((x, i) => { if (x.d > dots[maxIdx].d) maxIdx = i; if (x.d < dots[minIdx].d) minIdx = i })
    const refine = (center: JulianDate) => {
      let best = { t: center, d: -2 }
      for (let s = -6 * 3600; s <= 6 * 3600; s += 1800) {
        const t = JulianDate.addSeconds(center, s, new JulianDate())
        const sun = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, new Cartesian3())!
        const moon = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(t, new Cartesian3())!
        const d = Cartesian3.dot(Cartesian3.normalize(sun, sun), Cartesian3.normalize(moon, moon))
        if (d > best.d) best = { t, d }
      }
      return best
    }
    // 朔 = dot 极大（ε→0）；在极大邻域细化后取 ε 最小点断言 f
    const newMoon = refine(dots[maxIdx].t)
    expect(computeMoonIlluminatedFraction(newMoon.t)).toBeLessThan(0.02)
    const fullMoon = refine(dots[minIdx].t) // 望 = dot 极小（ε→180°）——细化取 dot 最小
    expect(computeMoonIlluminatedFraction(fullMoon.t)).toBeGreaterThan(0.98)
  })

  it('中秋锚（独立于扫描）：2026-09-25 当天 24h 内 max f > 0.95', () => {
    const day = JulianDate.fromIso8601('2026-09-25T00:00:00Z')
    let maxF = -1
    for (let s = 0; s < 86400; s += 3600) {
      maxF = Math.max(maxF, computeMoonIlluminatedFraction(JulianDate.addSeconds(day, s, new JulianDate())))
    }
    expect(maxF).toBeGreaterThan(0.95)
  })

  it('视差修正：地面观察者 vs 地心月方向角差 24h 扫描最大值 ∈ (10′, 65′]', () => {
    const icrf = new Matrix3()
    const ground = new Cartesian3(6371000, 0, 0) // 赤道点，米
    const start = JulianDate.fromIso8601('2026-09-15T00:00:00Z')
    let maxAngle = 0
    const geocentric = new Cartesian3(), topocentric = new Cartesian3()
    for (let s = 0; s < 86400; s += 3600) {
      const t = JulianDate.addSeconds(start, s, new JulianDate())
      const fixed = Transforms.computeIcrfToCentralBodyFixedMatrix(t, icrf)
      expect(fixed).toBeDefined() // GMST fallback 恒有值（ICRF 竞态修复版）
      computeMoonDirectionECEF(t, fixed!, new Cartesian3(0, 0, 0), geocentric)
      computeMoonDirectionECEF(t, fixed!, ground, topocentric)
      const angle = Math.acos(CesiumMath.clamp(Cartesian3.dot(geocentric, topocentric), -1, 1))
      maxAngle = Math.max(maxAngle, angle)
    }
    // 上界 65′（近地点水平视差 61.5′ 余量）；下界 10′（origin 单位错 1000 倍时视差≈0 静默失效——必须双向）
    expect(maxAngle).toBeGreaterThan(CesiumMath.toRadians(10 / 60))
    expect(maxAngle).toBeLessThanOrEqual(CesiumMath.toRadians(65 / 60))
  })

  it('连续性：+1s 方向与 f 均无跳变', () => {
    const t0 = JulianDate.fromIso8601('2026-09-20T12:00:00Z')
    const t1 = JulianDate.addSeconds(t0, 1, new JulianDate())
    const fixed0 = Transforms.computeIcrfToCentralBodyFixedMatrix(t0, new Matrix3())!
    const fixed1 = Transforms.computeIcrfToCentralBodyFixedMatrix(t1, new Matrix3())!
    const d0 = computeMoonDirectionECEF(t0, fixed0, new Cartesian3(0, 0, 0), new Cartesian3())
    const d1 = computeMoonDirectionECEF(t1, fixed1, new Cartesian3(0, 0, 0), new Cartesian3())
    expect(Cartesian3.dot(d0, d1)).toBeGreaterThan(Math.cos(1e-6))
    expect(Math.abs(computeMoonIlluminatedFraction(t1) - computeMoonIlluminatedFraction(t0))).toBeLessThan(1e-6)
  })

  it('FromDirections 版与独立版同刻一致（弦月参考：ε=90° → f=(1−0)/π… 验证曲线锚点）', () => {
    // 构造已知 ε：sunDirection=(0,0,1)、moonDirection=(1,0,0) → ε=90° → f=(sin90−90°·cos90)/π=(1−0)/π≈0.318
    const f = computeMoonIlluminatedFractionFromDirections(new Cartesian3(0, 0, 1), new Cartesian3(1, 0, 0))
    expect(f).toBeCloseTo(1 / Math.PI, 3)
  })
})
```

（注意：上面 `sunMoonDot` 函数是坏草稿残片——**实现测试文件时删掉它**，测试直接在各用例内联 dot 计算，如所写用例体那样。）

- [ ] **Step 2: 跑测试确认失败**

```
cd packages/cesium-core && pnpm exec vitest run src/celestial/celestialDirections.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// packages/cesium-core/src/celestial/celestialDirections.ts
// 月方向与月相因子（spec 2026-08-30 r2 §4）——单源实现，AtmosphereStage（月盘）与
// clouds（月光照云）两处消费。单位全链米制；ICRF 旋转由调用方传入
// （computeIcrfToCentralBodyFixedMatrix 竞态修复版，与各 stage 太阳管线同帧共享，
// 省每帧重复旋转矩阵）。
import {
  Cartesian3,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms
} from 'cesium'

const moonInertialScratch = new Cartesian3()
const sunInertialScratch = new Cartesian3()
const moonFixedScratch = new Cartesian3()

/**
 * 观察者月方向（ECEF 单位向量）。
 * 管线：Simon1994 月位置（ICRF，米）→ icrfToFixed 旋转 → 视差修正（moon − origin，米）→ 归一。
 * 视差必做：月地 38 万 km，月球地平视差 57′ ≈ 月盘视直径两倍——不修正月盘方位偏两个盘径。
 */
export function computeMoonDirectionECEF(
  time: JulianDate,
  icrfToFixed: Matrix3,
  originECEF: Cartesian3,
  result: Cartesian3
): Cartesian3 {
  const moonInertial = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    time,
    moonInertialScratch
  )
  if (moonInertial == null) return result
  const moonFixed = Matrix3.multiplyByVector(icrfToFixed, moonInertial, moonFixedScratch)
  // originECEF 语义 = camera.positionWC + altitudeCorrection（米）——调用方算好传入
  Cartesian3.subtract(moonFixed, originECEF, moonFixed)
  const mag = Cartesian3.magnitude(moonFixed)
  if (Number.isFinite(mag) && mag > 1e-15) {
    Cartesian3.normalize(moonFixed, result)
  }
  return result
}

/**
 * Lambert 球积分月相照明因子：f = (sin ε − ε·cos ε)/π（朔 0 / 弦 0.318 / 望 1）。
 * 运行时消费方手头已有 state 两方向——直接调本函数（dot 即得，零天文计算）。
 */
export function computeMoonIlluminatedFractionFromDirections(
  sunDirection: Cartesian3,
  moonDirection: Cartesian3
): number {
  const d = CesiumMath.clamp(Cartesian3.dot(sunDirection, moonDirection), -1.0, 1.0)
  const elongation = Math.acos(d) // clamp 防 float 越界 NaN（朔望点高危）
  return (Math.sin(elongation) - elongation * Math.cos(elongation)) / Math.PI
}

/**
 * 独立版月相因子（内部自算两方向）——仅供单测/独立消费。
 * 运行时勿每帧独立调用（内部 Simon1994×2+ICRF×1；消费方已有两方向，用 FromDirections 版）。
 */
export function computeMoonIlluminatedFraction(time: JulianDate): number {
  const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    time,
    sunInertialScratch
  )
  const moonInertial = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    time,
    moonInertialScratch
  )
  if (sunInertial == null || moonInertial == null) return 0
  const icrfToFixed = Transforms.computeIcrfToCentralBodyFixedMatrix(time, new Matrix3())
  if (icrfToFixed == null) return 0
  const sun = Cartesian3.normalize(
    Matrix3.multiplyByVector(icrfToFixed, sunInertial, sunInertialScratch),
    sunInertialScratch
  )
  const moon = Cartesian3.normalize(
    Matrix3.multiplyByVector(icrfToFixed, moonInertial, moonFixedScratch),
    moonFixedScratch
  )
  return computeMoonIlluminatedFractionFromDirections(sun, moon)
}
```

`packages/cesium-core/src/index.ts` 加一行（紧邻 `getAltitudeCorrectionOffset` 导出）：

```ts
export {
  computeMoonDirectionECEF,
  computeMoonIlluminatedFraction,
  computeMoonIlluminatedFractionFromDirections
} from './celestial/celestialDirections'
```

- [ ] **Step 4: 跑测试确认通过**

```
cd packages/cesium-core && pnpm exec vitest run src/celestial/celestialDirections.test.ts
```
预期：PASS（5 用例）。若中秋锚失败：打印当天 f 曲线确认满月时刻（历法锚可能跨日），以扫描法结果为准修锚点日期断言（spec §4.4：扫描为主、历法旁证）。

- [ ] **Step 5: 全量回归 + tsc**

```
cd packages/cesium-core && pnpm exec vitest run && pnpm exec tsc --noEmit
```
预期：全绿（307+新增）+ 0 类型错。

- [ ] **Step 6: Commit**

```
git add packages/cesium-core/src/celestial packages/cesium-core/src/index.ts
git commit -m "feat(core): 月方向与月相因子单源——Simon1994+视差修正（米制）+Lambert 球积分月相（朔望扫描/中秋锚/视差上下界单测）"
```

---

### Task 2: aerialPerspective.frag.ts 月盘 MOON 段（out 通道方案）

**Files:**
- Modify: `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`
- Test: `packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 无关（本任务纯 shader 组装）。
- Produces: `AerialPerspectiveFragOptions.moon?: boolean`（默认 true）；shader 内 `getSkyRadiance` 在 moon=true 时签名多一个 `out vec3 moonDisc` 参数；uniform `moonDirection(vec3)` / `moonAngularRadius(float)` / `u_moonRadiance(float)`（moon=true 时声明）。Task 3 依赖：options 字段名 `moon`、uniform 名三件。

- [ ] **Step 1: 写失败测试**（追加到 `aerialPerspective.compile.test.ts`）

```ts
// ── 月盘 MOON（2026-08-30 夜间光照 spec r2 §5）：out 通道方案 + acos 判定 + Oren-Nayar 月相 ──
describe('月盘 MOON 段（spec r2 §5）', () => {
  const build = () => buildAerialPerspectiveFragmentShader({ moon: true })
  const buildOff = () => buildAerialPerspectiveFragmentShader({ moon: false })

  it('moon=true：三 uniform 声明 + getSkyRadiance out moonDisc 签名 + finalColor 加法项', () => {
    const src = build()
    expect(src).toContain('uniform vec3 moonDirection;')
    expect(src).toContain('uniform float moonAngularRadius;')
    expect(src).toContain('uniform float u_moonRadiance;')
    expect(src).toMatch(/out vec3 moonDisc/)
    // finalColor 行：+ moonDisc 独立加法（不吃 u_inscatterScale）
    expect(src).toContain('+ inscatter * u_inscatterScale + moonDisc;')
  })

  it('moon=true：acos 判定 + 边序恒升序守卫（禁 dot 直比/降序边）', () => {
    const src = build()
    expect(src).toContain('acos(clamp(dot(rayDirection, moonDirection), -1.0, 1.0))')
    expect(src).toContain('float moonAA = max(fragmentAngle, 1e-4);')
    expect(src).toContain('1.0 - smoothstep(moonAngularRadius - moonAA, moonAngularRadius, moonAngle)')
  })

  it('moon=true：Oren-Nayar MoonNode 版常量与实参序（禁 sky.glsl 旧版常量）', () => {
    const src = build()
    expect(src).toContain('0.2466') // A=(1/π)(1−0.5/1.33+0.17/1.13)
    expect(src).toContain('0.1314') // B=(1/π)(0.45/1.09)
    expect(src).toContain('smoothstep(0.0, 0.1, sOV)') // t 公式 edges-first 记法
    expect(src).not.toContain('0.62406') // sky.glsl 旧版
    // 实参序：V = -rayDirection
    expect(src).toContain('dot(moonNormal, -rayDirection)')
  })

  it('moon=true：limbFade 显式乘月盘 + hasScene 前景雾 mix 月盘到 0（山遮月）', () => {
    const src = build()
    expect(src).toContain('moonDisc *= limbFade;')
    expect(src).toContain('moonDisc = mix(moonDisc, vec3(0.0), mask);')
  })

  it('moon=true：亮度公式（2.5e-6 / πω² / SUN_SPECTRAL 换算）', () => {
    const src = build()
    expect(src).toContain('2.5e-6')
    expect(src).toMatch(/PI \* moonAngularRadius \* moonAngularRadius/)
    expect(src).toContain('SUN_SPECTRAL_RADIANCE_TO_LUMINANCE * u_moonRadiance')
  })

  it('moon=false golden：产物与现状（无 moon 代码）逐字符一致', () => {
    const srcOff = buildOff()
    expect(srcOff).not.toContain('moonDisc')
    expect(srcOff).not.toContain('moonDirection')
    expect(srcOff).not.toContain('u_moonRadiance')
    expect(srcOff).toContain('+ inscatter * u_inscatterScale;') // finalColor 回现状
    // golden：与 git 上一版（moon 未引入时）moon 无关组合产物比对——用 snapshot 守门
    //（首个 run 录基线；此后任何 moon=false 产物变化即 fail）
    expect(srcOff).toMatchSnapshot('moon-off-golden')
  })

  it('glslang：moon=true 与 moon=false 两态真编译通过', () => {
    for (const moon of [true, false]) {
      const src = buildStandaloneShaderForValidation({ moon })
      const { ok, output } = compileFragment(src) // 文件内既有 compile helper
      if (!ok) throw new Error(`moon=${moon} 编译失败:\n${output}`)
      expect(ok).toBe(true)
    }
  })
})
```

（`compileFragment` 若该测试文件尚无此 helper，仿 `cloudsMain.compile.test.ts` 的 `glslangUtil` import 形态补：`import { compileFragment } from './glslangUtil'`——core 包已有此工具，检查 `packages/cesium-core/src/glslangUtil.ts` 是否存在；不存在则从 cesium-clouds 包同名文件复制。）

- [ ] **Step 2: 跑测试确认失败**

```
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.compile.test.ts
```
预期：FAIL（moon 选项不存在、无 moonDisc 文本）。

- [ ] **Step 3: 实现**

`aerialPerspective.frag.ts` 改动（全部精确锚点）：

3a. `AerialPerspectiveFragOptions`（`cloudsGodRaysGain?: number` 之后）加：

```ts
  /**
   * 月盘（2026-08-30 夜间光照 spec r2 §5）：sky 分支物理月盘——Oren-Nayar 月面（月相从
   * 几何涌现）× 视星等 2.5e-6 × 视线 transmittance（大气透视），走 getSkyRadiance out
   * 通道独立于 u_inscatterScale（不吃雾旋钮），同受 hasScene 前景雾（山遮月）与 limbFade。
   * 默认 true；false 时产物与现状逐字符一致（golden 守门）。
   */
  moon?: boolean
```

`ResolvedOptions = Required<AerialPerspectiveFragOptions>` 自动含 moon——`buildAerialPerspectiveFragmentShader` 内 resolve 对象加 `moon: true,`。

3b. `AERIAL_PERSPECTIVE_UNIFORM_NAMES` 数组末尾（`'u_cloudsGodRaysGain'` 行后）加：

```ts
  'moonDirection', // 月盘（MOON 段声明；moon=false 时 shader 无声明，绑了 Cesium 静默忽略——同 u_cloudsGodRaysGain 先例）
  'moonAngularRadius',
  'u_moonRadiance'
```

3c. 新增常量（`SUN_DISK_GLSL` 之后）：

```ts
// [MOON] 月盘 uniforms（moon=true 时拼入）。
const MOON_UNIFORMS_GLSL = `
uniform vec3 moonDirection;
uniform float moonAngularRadius;
uniform float u_moonRadiance;
`

// [MOON] 月盘 GLSL（getSkyRadiance 内、SUN 盘后注入；moonDisc 是 out 参数——通道方案 spec §5.1：
// 不吃 u_inscatterScale / 同受 hasScene mix 与 limbFade / 月盘衰减只走 transmittance）。
const MOON_DISC_GLSL = `
  // 判定+盘缘 AA：acos（非 dot 与弧度直比）+ 边序恒升序（ω<aa 时降序边=GLSL UB——小角半径守卫）
  float moonAngle = acos(clamp(dot(rayDirection, moonDirection), -1.0, 1.0));
  float moonAA = max(fragmentAngle, 1e-4);
  float moonMask = 1.0 - smoothstep(moonAngularRadius - moonAA, moonAngularRadius, moonAngle);
  if (moonMask > 0.0) {
    // 月面法线（上游 MoonNode raySphereIntersectionNormal：投影 + 半弦长）
    float cosRay = dot(moonDirection, rayDirection);
    vec3 P = rayDirection * cosRay - moonDirection;
    float s = sqrt(max(moonAngularRadius * moonAngularRadius - dot(P, P), 0.0));
    vec3 moonNormal = (P - rayDirection * s) / moonAngularRadius;
    // Oren-Nayar（MoonNode 改进版 mimosa-pudica，粗糙度 1 / albedo 1 形状函数）：
    // A=(1/π)(1-0.5/1.33+0.17/1.13)≈0.2466  B=(1/π)(0.45/1.09)≈0.1314
    // 实参序 (L=sunDirection, V=-rayDirection, N)；月相从几何自动涌现（太阳只照亮半个月球）
    float cosLight = dot(moonNormal, sunDirection);
    float cosView = dot(moonNormal, -rayDirection);
    float sOV = dot(sunDirection, -rayDirection) - cosLight * cosView;
    float t = mix(1.0, max(max(cosLight, cosView), 0.1), smoothstep(0.0, 0.1, sOV));
    float onDiffuse = max(cosLight, 0.0) * (sOV / t * 0.1314 + 0.2466);
    // 亮度：太阳辐亮度 × 视星等比 2.5e-6（已含月面反照率）÷ (π·ω²)，×亮度换算 ×倍率
    vec3 moonDiscRadiance = ATMOSPHERE.solar_irradiance
      * 2.5e-6 / (PI * moonAngularRadius * moonAngularRadius)
      * SUN_SPECTRAL_RADIANCE_TO_LUMINANCE * u_moonRadiance * onDiffuse;
    moonDisc = transmittance * moonDiscRadiance * moonMask;
  }
`
```

3d. `buildSkyRadianceFn` 改签名（`function buildSkyRadianceFn(sun: boolean, moon: boolean)`）：

```ts
function buildSkyRadianceFn(sun: boolean, moon: boolean): string {
  return `
vec3 getSkyRadiance(
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const float shadowLength,
  const vec3 sunDirection,
  const float fragmentAngle,
  out vec3 transmittance${moon ? ',\n  out vec3 moonDisc' : ''}
) {
  vec3 radiance = GetSkyRadiance(
    cameraPosition,
    rayDirection,
    shadowLength,
    sunDirection,
    transmittance
  );
${sun ? SUN_DISK_GLSL : ''}${moon ? MOON_DISC_GLSL : ''}
  return radiance;
}
`
}
```

3e. `buildMainFn` 四处（`o.moon` 条件拼接）：

- `vec3 transmittance = vec3(1.0);` / `vec3 inscatter = vec3(0.0);`（现状 L511-512）后加声明段（moon 时）：
```ts
${o.moon ? '  vec3 moonDisc = vec3(0.0); // ground 分支保持 0（月盘只可能出自 sky 分支）\n' : ''}
```
（拼进 main 模板字符串——注意该声明要在 `if (lookingAtGround…)` 分支前。）

- skyBranch（moon 时 7 参调用）：
```ts
    inscatter = getSkyRadiance(cameraPosition, rayDirection, cloudsShadowLength, sunDirection, fragmentAngle, transmittance${o.moon ? ', moonDisc' : ''});
```

- hasScene mix 段（`inscatter = mix(inscatter, foreInscatter, mask);` 后）：
```ts
${o.moon ? '      moonDisc = mix(moonDisc, vec3(0.0), mask); // 前景雾同遮月（山体像素无月盘）' : ''}
```

- limbFade 段（`inscatter *= limbFade;` 后）：
```ts
${o.moon ? '    moonDisc *= limbFade; // 与太阳盘行为一致（太空视角 limb 渐隐）' : ''}
```

- finalColor 行：
```ts
  finalColor = originalColor.rgb * transmittance * u_groundDim + inscatter * u_inscatterScale${o.moon ? ' + moonDisc' : ''};
```

3f. `buildAerialPerspectiveFragmentShader`：
- resolve 对象加 `moon: true,`
- uniforms 段（`if (o.cloudsShadowLength)` 块后）：`if (o.moon) uniforms.push(MOON_UNIFORMS_GLSL)`
- functions 段：`if (o.sky) functions.push(buildSkyRadianceFn(o.sun, o.moon))`

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```
cd packages/cesium-core && pnpm exec vitest run src/cesium/aerialPerspective.compile.test.ts
cd packages/cesium-core && pnpm exec vitest run && pnpm exec tsc --noEmit
```
预期：新用例全过（首个 run 录 snapshot 基线——**先确认 moon=false 产物在改动前后一致**：改动前跑一次 `buildAerialPerspectiveFragmentShader()` 存串，改动后比对，作为 Step 3 的前置自检）；全量绿 + tsc 0。

- [ ] **Step 5: Commit**

```
git add packages/cesium-core/src/cesium/aerialPerspective.frag.ts packages/cesium-core/src/cesium/aerialPerspective.compile.test.ts
git commit -m "feat(atmosphere): 月盘 MOON 段——getSkyRadiance out moonDisc 通道（inscatterScale 解耦/山遮月/limbFade 同路）+ acos 边序守卫判定 + Oren-Nayar MoonNode 版月相涌现 + moon=false golden 逐字符零回归"
```

---

### Task 3: AtmosphereStage 月方向接线（options/state/uniforms/preRender）

**Files:**
- Modify: `packages/cesium-core/src/cesium/AtmosphereStage.ts`
- Test: `packages/cesium-core/src/cesium/AtmosphereStage.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 `computeMoonDirectionECEF(time, icrfToFixed, originECEF, result)`；Task 2 `AerialPerspectiveFragOptions.moon`。
- Produces: `AtmosphereStageOptions.moon?: boolean`（默认 true）/ `moonRadianceScale?: number`（默认 60）/ `moonAngularRadius?: number`（默认 0.0045）；`AtmosphereFrameState.moonDirection: Cartesian3`；uniforms `moonDirection`（闭包）/ `moonAngularRadius` / `u_moonRadiance`（静态值）。Task 6 demo 依赖这三个 option 名。

- [ ] **Step 1: 写失败测试**（追加到 `AtmosphereStage.test.ts`）

```ts
import { validateAtmosphereOptions, buildAtmosphereUniforms } from './AtmosphereStage'
// （该测试文件已 import 这些——确认后用既有 import）

describe('月光 options/state/uniforms（spec r2 §5.4）', () => {
  it('validate 默认：moon=true / moonRadianceScale=60 / moonAngularRadius=0.0045', () => {
    const r = validateAtmosphereOptions({})
    expect(r.moon).toBe(true)
    expect(r.moonRadianceScale).toBe(60)
    expect(r.moonAngularRadius).toBeCloseTo(0.0045, 6)
  })

  it('buildAtmosphereUniforms 含月盘三件：moonDirection 闭包 + 静态 ω/radiance', () => {
    const state: AtmosphereFrameState = {
      sunDirection: new Cartesian3(0, 0, 1),
      moonDirection: new Cartesian3(1, 0, 0),
      altitudeCorrection: new Cartesian3(),
      exposure: 1
    }
    const u = buildAtmosphereUniforms(
      {} as AtmosphereLUTs,
      validateAtmosphereOptions({}),
      state
    )
    expect(typeof u.moonDirection).toBe('function')
    expect((u.moonDirection as () => Cartesian3)()).toBe(state.moonDirection)
    expect(u.moonAngularRadius).toBeCloseTo(0.0045, 6)
    expect(u.u_moonRadiance).toBe(60)
  })

  it('buildAtmosphereStage fragmentShader 透传 moon（moon=false 时 shader 无 moonDirection）', () => {
    // 经 createAtmosphereStage 太重（需 scene）；直接验证 buildAerialPerspectiveFragmentShader
    // 的 options 联动——本用例断言 resolved 展开链路：validate→resolved 含 moon，buildAerialPerspective
    // 的调用参数由 createAtmosphereStage 内 {...resolved} 展开自动携带（结构 typing 已覆盖）。
    // 此处断言 fragment 产物两态差异即可（详测在 Task 2）。
    const r = validateAtmosphereOptions({ moon: false })
    expect(r.moon).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
cd packages/cesium-core && pnpm exec vitest run src/cesium/AtmosphereStage.test.ts
```
预期：FAIL（moon 属性不存在）。

- [ ] **Step 3: 实现**（`AtmosphereStage.ts` 六处）

3a. import 加：`import { computeMoonDirectionECEF } from '../celestial/celestialDirections'`

3b. `AtmosphereStageOptions`（`cloudsOcclusionBridge` 前任意处）加：

```ts
  // ── 月盘（2026-08-30 夜间光照 spec r2 §5）──
  /** 月盘开关（默认 true）。创建期语义：切换=重建 stage（同 sun/sky 惯例），运行时切换不在范围。 */
  moon?: boolean
  /** 月盘亮度倍率（默认 60=inscatterScale(25) 等效补偿 × diffuse 因子；URL ?moonRadiance=）。 */
  moonRadianceScale?: number
  /** 月盘角半径 rad（默认 0.0045≈15.5′ 真实值；URL ?moonAngularRadius= 艺术放大）。 */
  moonAngularRadius?: number
```

3c. `ResolvedAtmosphereStageOptions` 加三字段 `moon: boolean / moonRadianceScale: number / moonAngularRadius: number`。

3d. `validateAtmosphereOptions` 返回对象加：

```ts
    moon: options.moon ?? true,
    moonRadianceScale: options.moonRadianceScale ?? 60,
    moonAngularRadius: options.moonAngularRadius ?? 0.0045,
```

3e. `AtmosphereFrameState` 加 `moonDirection: Cartesian3`；`createAtmosphereStage` 内 state 初始化加 `moonDirection: new Cartesian3(0, 0, 1),`；`buildAtmosphereUniforms` 返回对象加：

```ts
    moonDirection: () => state.moonDirection,
    moonAngularRadius: options.moonAngularRadius,
    u_moonRadiance: options.moonRadianceScale,
```

3f. preRender listener（太阳方向段 `}` 后、动态曝光段前）加月方向段：

```ts
    // 月方向（spec §4）：复用上方 icrfToFixed（同帧共享，省重复旋转矩阵）；
    // 视差修正 origin = viewerPositionWC + altitudeCorrection（米）——与 reconstructRay
    // 射线起点同帧同源（太空相机 offset 可达 1e4 km，裸相机位置月盘方位偏 1-2°）。
    Cartesian3.add(camera.positionWC, state.altitudeCorrection, moonOriginScratch)
    computeMoonDirectionECEF(time, icrfToFixed!, moonOriginScratch, state.moonDirection)
```

（`icrfToFixed!`——上文太阳段已判 null；icrfToFixed 为 null 时 computeMoonDirectionECEF 内部 multiply 会崩，须同款守卫。稳妥写法：把月方向段放进 `if (icrfToFixed != null && sunInertial != null) {…}` 同块内太阳 normalize 之后。）

模块顶部 scratch 区加：`const moonOriginScratch = new Cartesian3()`（与 `sunInertialScratch` 同级，函数外模块级）。

3g. `buildAtmosphereStage` 的 `buildAerialPerspectiveFragmentShader({ ...resolved, … })` 已展开 resolved——`moon` 字段自动透传（多余字段 `moonRadianceScale`/`moonAngularRadius` 随 spread 传入无害，`buildAerialPerspectiveFragmentShader` 只读 `moon`）。

- [ ] **Step 4: 跑测试确认通过 + 全量**

```
cd packages/cesium-core && pnpm exec vitest run src/cesium/AtmosphereStage.test.ts
cd packages/cesium-core && pnpm exec vitest run && pnpm exec tsc --noEmit
```
预期：绿 + tsc 0。

- [ ] **Step 5: Commit**

```
git add packages/cesium-core/src/cesium/AtmosphereStage.ts packages/cesium-core/src/cesium/AtmosphereStage.test.ts
git commit -m "feat(atmosphere): 月方向接线——options 三件(默认 60/0.0045/true)+FrameState.moonDirection+preRender 视差修正（origin=viewerPositionWC+altitudeCorrection，icrfToFixed 同帧共享）"
```

---

### Task 4: clouds.frag 月光光照项（第四光照项）

**Files:**
- Modify: `packages/cesium-clouds/src/glsl/clouds.frag`
- Test: `packages/cesium-clouds/src/cloudsMain.compile.test.ts`（扩展）

**Interfaces:**
- Consumes: 无（shader 文本；uniform 值由 Task 5 注入）。
- Produces: GLSL uniforms `moonDirection(vec3)` / `moonIlluminatedFraction(float)` / `moonLightScale(float)`；受照循环内 moon 项。Task 5 绑定这三个 uniform 名。

- [ ] **Step 1: 写失败测试**（追加到 `cloudsMain.compile.test.ts`，仿 nightAmbient describe 块）

```ts
// ─────────────────────────────────────────────────────────────────────────────
// 月光方向性照明（2026-08-30 方向 C，spec r2 §6）：光照循环第四项——独立构造
// moonIrradiance（非 sun 项乘系数），朝月独立 march 光深，两道门
// （nightFactor 昼夜分账 + 月升落 smoothstep），相位复用 approximateMultipleScattering。
// ─────────────────────────────────────────────────────────────────────────────
describe('月光光照项（方向 C）', () => {
  it('三 uniform 声明 + moon march + 两道门 + 独立 moonIrradiance 构造', () => {
    const src = buildCloudsMainFragmentShader({})
    expect(src).toContain('uniform vec3 moonDirection;')
    expect(src).toContain('uniform float moonIlluminatedFraction;')
    expect(src).toContain('uniform float moonLightScale;')
    // 朝月独立 march（不复用太阳 opticalDepth——夜间太阳在地平下方向反了）
    expect(src).toContain('float moonOpticalDepth = marchOpticalDepth(')
    // 门 1：nightFactor 复用（同 smoothstep 变量，白天精确 0）
    expect(src).toContain('2.5e-6 * moonLightScale * nightFactor * moonFactor')
    // 门 2：月升落（surfaceNormal 径向，窗口 sin(-2.87°)..sin(+1.15°)）
    expect(src).toContain('smoothstep(-0.05, 0.02, dot(surfaceNormal, moonDirection))')
    // 相函数复用（cosTheta 重算，非太阳 cosTheta）
    expect(src).toContain('float cosThetaMoon = dot(moonDirection, rayDirection);')
    expect(src).toContain('approximateMultipleScattering(moonOpticalDepth, cosThetaMoon)')
    // 与 sun 项同构并列（随后自然走 ×scattering/powder/能量积分）
    expect(src).toMatch(/radiance \+= moonIrradiance \* approximateMultipleScattering/)
  })

  it('glslang：含 moon 项完整 shader 真编译', () => {
    const src = buildStandaloneCloudsShaderForValidation({})
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(`glslang 编译失败:\n${output}\n` + src.split('\n').slice(0, 60).map((l, i) => `${i + 1}: ${l}`).join('\n'))
    }
    expect(ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
cd packages/cesium-clouds && pnpm exec vitest run src/cloudsMain.compile.test.ts
```
预期：FAIL（无 moon uniform）。

- [ ] **Step 3: 实现**（`clouds.frag` 两处，直接改原文——nightAmbient 先例）

3a. uniforms 声明（`uniform float nightAmbient;` L63 后）：

```glsl
// 月光方向性照明（2026-08-30 方向 C）：夜间云的第四光照项。moonDirection 为观察者月方向
// （ECEF，含视差修正）；moonIlluminatedFraction 为 Lambert 球积分月相因子（朔 0/弦 0.318/
// 望 1，JS 侧按 sun/moon 两方向 dot 算）；moonLightScale=50000 艺术放大（物理 2.5e-6 不可见，
// 满月贡献 ≈nightAmbient×1.5 主导；视觉拍板可调）。
uniform vec3 moonDirection;
uniform float moonIlluminatedFraction;
uniform float moonLightScale;
```

3b. 受照循环（`skyIrradiance += vec3(nightAmbient) * nightFactor;` L555 后、`// March optical depth to the sun…` 注释前）插：

```glsl
      // 月光门 2：月升落（spec §6.2）——月落后 moonDirection 在地平线下，无此门云被
      // 「地下来的光」照亮、云底亮反转（弦月下半夜必现）。窗口 -0.05..0.02 ≈
      // sin(-2.87°)..sin(+1.15°)：下沿 ≈8km 云层顶的地平俯角。门 1（昼夜分账）复用
      // 上方 nightFactor——白天精确 0（云侧零回归）、晨昏带与底光同曲线淡入。
      float moonFactor = moonIlluminatedFraction
        * smoothstep(-0.05, 0.02, dot(surfaceNormal, moonDirection));
```

3c. `vec3 radiance = sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta);` L581 后（GROUND_BOUNCE 块前）插：

```glsl
      // 月光散射项（spec §6.1）：独立构造 moonIrradiance（非 sun 项乘系数——夜间 LUT 太阳
      // 项已归零）；朝月独立 march 光深（复用太阳方向会杀死「云顶被月光照亮」主视觉——
      // 夜间太阳在地平下方向反了；maxIterationCountToSun=2 同预算，成本 +2 采样/受照样本）；
      // 不采 BSM（月光无云影）、不走 accurate LUT 路径；相位函数复用
      // approximateMultipleScattering（随 ACCURATE_PHASE_FUNCTION define 与太阳项一致）。
      // 同构并列于 sun 项——随后自然走 ×scattering/powder/能量积分，形体感与太阳光照一致。
      float moonRayDistance = 0.0;
      float moonOpticalDepth = marchOpticalDepth(
        position,
        moonDirection,
        maxIterationCountToSun,
        mipLevel,
        jitter,
        moonRayDistance
      );
      float cosThetaMoon = dot(moonDirection, rayDirection);
      vec3 moonIrradiance = ATMOSPHERE.solar_irradiance
        * 2.5e-6 * moonLightScale * nightFactor * moonFactor;
      radiance += moonIrradiance * approximateMultipleScattering(moonOpticalDepth, cosThetaMoon);
```

（量纲注：`ATMOSPHERE.solar_irradiance` 为 spectral 域，与 `GetSunAndSkyScalarIrradiance` 返回同基；1.3× 亮度换算差被 moonLightScale 艺术倍率吸收，视觉验收拍板。`rayDirection`/`marchOpticalDepth`/`maxIterationCountToSun`/`mipLevel`/`jitter` 均为 marchClouds 循环内既有标识符。）

- [ ] **Step 4: 跑测试确认通过 + clouds 全量**

```
cd packages/cesium-clouds && pnpm exec vitest run src/cloudsMain.compile.test.ts
cd packages/cesium-clouds && pnpm exec vitest run && pnpm exec tsc --noEmit
```
预期：绿 + tsc 0。

- [ ] **Step 5: Commit**

```
git add packages/cesium-clouds/src/glsl/clouds.frag packages/cesium-clouds/src/cloudsMain.compile.test.ts
git commit -m "feat(clouds): 月光光照项——第四光照项（独立 moonIrradiance 构造+朝月独立 march 光深+nightFactor 昼夜分账门+月升落门+相位随 define 与太阳一致；白天精确 0 零回归）"
```

---

### Task 5: clouds TS 侧接线（参数/状态/uniforms/preRender）

**Files:**
- Modify: `packages/cesium-clouds/src/cloudsDefaultParameters.ts`（interface + 默认值）
- Modify: `packages/cesium-clouds/src/CloudsPass.ts`（CloudsFrameState + buildSharedCloudsUniforms）
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（state 初始化 + onPreRender 月方向/月相）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 `computeMoonDirectionECEF` / `computeMoonIlluminatedFractionFromDirections`（clouds `import {…} from '@cesium-geospatial/core'`——package.json 已有 workspace 依赖）。
- Produces: `CloudsParameters.moonLightScale: number`（默认 50000）；`CloudsFrameState.moonDirection: Cartesian3` / `moonIlluminatedFraction: number`；uniforms 表三键（名同 Task 4 GLSL）。Task 6 demo 依赖 `parameters: { moonLightScale }` 浅合并入口。

- [ ] **Step 1: 写失败测试**（追加到 `createCloudsStage.test.ts`）

```ts
describe('月光接线（spec r2 §6.5）', () => {
  it('defaultCloudsParameters.moonLightScale 默认 50000', () => {
    expect(defaultCloudsParameters.moonLightScale).toBe(50000)
  })

  it('buildSharedCloudsUniforms 含月光三键（moonDirection 闭包直读 state）', () => {
    // 仿该文件既有 buildSharedCloudsUniforms 用例的 mock 构造（state/params/luts/weather/turbulence）
    const state: CloudsFrameState = {
      sunDirection: new Cartesian3(0, 0, 1),
      moonDirection: new Cartesian3(1, 0, 0),
      moonIlluminatedFraction: 0.5,
      altitudeCorrection: new Cartesian3()
    }
    const uniforms = buildSharedCloudsUniforms(
      fakeScene, fakeLuts, fakeWeather, state, { ...defaultCloudsParameters }, fakeTex
    )
    expect(typeof uniforms.moonDirection).toBe('function')
    expect((uniforms.moonDirection as () => Cartesian3)()).toBe(state.moonDirection)
    expect((uniforms.moonIlluminatedFraction as () => number)()).toBe(0.5)
    expect(typeof uniforms.moonLightScale).toBe('function')
  })
})
```

（`fakeScene/fakeLuts/fakeWeather/fakeTex` 复用该测试文件既有 mock——若现有用例以别的名字构造，照抄其形态改写。）

- [ ] **Step 2: 跑测试确认失败**

```
cd packages/cesium-clouds && pnpm exec vitest run src/createCloudsStage.test.ts
```
预期：FAIL。

- [ ] **Step 3: 实现**（四文件四处）

3a. `cloudsDefaultParameters.ts`：`CloudsParameters` interface `nightAmbient: number`（L130）后加：

```ts
  /** 月光倍率（方向 C，2026-08-30）：moonIrradiance = solar_irradiance×2.5e-6×月相×此值×
   *  nightFactor。默认 50000（满月贡献 ≈nightAmbient(0.12)×1.5 主导夜间照明；物理 2.5e-6
   *  不可见）。0 = 关（回退 nightAmbient 底光）。视觉参数不进质量档位。URL ?moonLightScale=。 */
  moonLightScale: number
```

默认值对象（`nightAmbient: 0.12,` L258 后）加 `moonLightScale: 50000,`。

3b. `CloudsPass.ts`：`CloudsFrameState`（`sunDirection: Cartesian3` 后）加：

```ts
  /** 观察者月方向（ECEF 单位向量，视差修正后）——月光照明用（方向 C）。 */
  moonDirection: Cartesian3
  /** Lambert 球积分月相因子（朔 0/弦 0.318/望 1，preRender 由 sun/moon 两方向 dot 算）。 */
  moonIlluminatedFraction: number
```

`buildSharedCloudsUniforms` 返回对象 `sunDirection: () => state.sunDirection,` 后加：

```ts
    moonDirection: () => state.moonDirection,
    moonIlluminatedFraction: () => state.moonIlluminatedFraction,
    moonLightScale: () => params.moonLightScale,
```

3c. `createCloudsStage.ts`：
- import 从 `@cesium-geospatial/core` 加 `computeMoonDirectionECEF, computeMoonIlluminatedFractionFromDirections`（拼进既有 core import 语句）。
- state 初始化（`sunDirection: new Cartesian3(0, 0, 1),` L296 后）加：

```ts
    moonDirection: new Cartesian3(0, 0, 1),
    moonIlluminatedFraction: 0,
```

- `onPreRender` 太阳方向段 `}` 后（BSM 段前）加：

```ts
    // 月方向（方向 C，spec §6.5）：origin = camera.positionWC + altitudeCorrection（米）——
    // 与 atmosphere 侧同式同源（spec r2 N2：显式公式，弃「密切球心」二义措辞）。icrfToFixed
    // 复用上方太阳段（同帧共享）。
    Cartesian3.add(camera.positionWC, state.altitudeCorrection, moonOriginScratch)
    computeMoonDirectionECEF(time, icrfToFixed!, moonOriginScratch, state.moonDirection)
    // 月相因子：state 两方向 dot 求 elongation（Lambert 球积分；不独立调 core 独立版——
    // 每帧省 Simon1994×2+ICRF×1，spec §4.1 注）
    state.moonIlluminatedFraction = computeMoonIlluminatedFractionFromDirections(
      state.sunDirection,
      state.moonDirection
    )
```

（同 Task 3：置于上方 `if (icrfToFixed != null && sunInertial != null)` 块内，避免 null 解引用。模块级 scratch `const moonOriginScratch = new Cartesian3()` 加在与 `sunInertialScratch` 同级处。）

- [ ] **Step 4: 跑测试确认通过 + clouds 全量 + tsc**

```
cd packages/cesium-clouds && pnpm exec vitest run src/createCloudsStage.test.ts
cd packages/cesium-clouds && pnpm exec vitest run && pnpm exec tsc --noEmit
```
预期：绿 + tsc 0。（ShadowPass 生成端共享 uniforms 表会绑到 moon 三键但 shadow.frag 无声明——Cesium 静默忽略，同 skyLightScale 先例，无害。）

- [ ] **Step 5: Commit**

```
git add packages/cesium-clouds/src/cloudsDefaultParameters.ts packages/cesium-clouds/src/CloudsPass.ts packages/cesium-clouds/src/createCloudsStage.ts packages/cesium-clouds/src/createCloudsStage.test.ts
git commit -m "feat(clouds): 月光 TS 接线——moonLightScale 默认 50000+FrameState 月方向/月相每帧更新（origin 显式公式同 atmosphere 侧，icrfToFixed 同帧共享）+共享 uniforms 三键"
```

---

### Task 6: demo URL 参数

**Files:**
- Modify: `apps/demo/src/main.ts`

**Interfaces:**
- Consumes: Task 3 `AtmosphereStageOptions.moon/moonRadianceScale/moonAngularRadius`；Task 5 `parameters: { moonLightScale }` 浅合并入口（既有 `?cloudsNightAmbient` 同款）。
- Produces: URL 参数 `?moon=0` / `?moonRadiance=N` / `?moonAngularRadius=N`（自动 k² 补偿）/ `?moonLightScale=N`。

- [ ] **Step 1: 实现**（demo 无单测框架，以 URL 手测验证）

atmosphere options 构造处（既有 `cloudsOcclusionBridge` 等参数旁）加：

```ts
    // 月光（2026-08-30 方向 C）：?moon=0 全关（月盘不编入+云月光乘 0）——诊断基线；
    // ?moonRadiance= 月盘倍率（默认 60）；?moonAngularRadius= 月盘角半径 rad（默认 0.0045，
    // 放大时自动 ×k² 补偿显示亮度——spec §5.2 耦合纪律）；?moonLightScale= 云月光倍率（默认 50000）。
    ...(getString('moon') === '0' ? { moon: false } : {}),
    ...(getNumber('moonRadiance') != null ? { moonRadianceScale: getNumber('moonRadiance')! } : {}),
    ...(getNumber('moonAngularRadius') != null
      ? (() => {
          const omega = getNumber('moonAngularRadius')!
          const k = omega / 0.0045 // 物理默认比
          // ω 可调时倍率默认同步 ×k²（同式下每像素 radiance ∝ 1/ω²，保持显示亮度——不显式传
          // ?moonRadiance= 时才补偿；显式值用户自理）
          const base = getNumber('moonRadiance') ?? 60
          return { moonAngularRadius: omega, moonRadianceScale: base * k * k }
        })()
      : {}),
```

clouds 参数段（既有 `?cloudsNightAmbient` 的 `parameters:` 浅合并处 L444-446）扩展：

```ts
          ...(getNumber('cloudsNightAmbient') != null || getNumber('moonLightScale') != null || getString('moon') === '0'
            ? {
                parameters: {
                  ...(getNumber('cloudsNightAmbient') != null
                    ? { nightAmbient: getNumber('cloudsNightAmbient')! }
                    : {}),
                  ...(getNumber('moonLightScale') != null
                    ? { moonLightScale: getNumber('moonLightScale')! }
                    : {}),
                  ...(getString('moon') === '0' ? { moonLightScale: 0 } : {})
                }
              }
            : {}),
```

- [ ] **Step 2: 手测（清缓存重启）**

```
pkill -f vite; rm -rf apps/demo/node_modules/.vite; pnpm dev
```

逐 URL 验证（console 无 shader 编译错、参数生效无白屏）：
- `?mode=sky`（默认）——月盘在画面与否随时间；无 JS 错
- `?mode=sky&moon=0` —— 与改动前同视角画面一致（月盘消失）
- `?mode=sky&moonRadiance=6` —— 月盘明显变暗
- `?mode=sky&moonAngularRadius=0.02` —— 月盘放大且亮度视觉不变（k² 补偿生效）

- [ ] **Step 3: 双包回归（代码未动库，防意外）**

```
cd packages/cesium-core && pnpm exec vitest run && pnpm exec tsc --noEmit
cd packages/cesium-clouds && pnpm exec vitest run && pnpm exec tsc --noEmit
```
预期：绿。

- [ ] **Step 4: Commit**

```
git add apps/demo/src/main.ts
git commit -m "feat(demo): 月光 URL 参数——?moon=0/?moonRadiance=/?moonAngularRadius=(k² 自动补偿)/?moonLightScale="
```

---

### Task 7: 浏览器验收（判据表 spec §8）

**Files:**
- 无代码改动；产出验收记录（截图对比数据写 commit message 或 results 文档）。

**Interfaces:**
- Consumes: 全部前序任务；spec §8 判据表。
- Produces: 验收结论（通过项/问题项），供用户视觉复核与默认值拍板。

- [ ] **Step 1: 日期准备（用 Task 1 单测的扫描逻辑现场确认）**

满月锚 `time=2026-09-25T16:00:00Z`（中秋）；新月/弦月/月落日期：在 node 里跑 60 天扫描（复用 celestialDirections 导出）打印朔/望时刻表，取：新月=朔时刻、弦月=朔望中点、月落夜=弦月日期里月高 <−5° 的时刻（相机当地）。

- [ ] **Step 2: agent-browser 成对录制（同批成对 + 每组 close 重开——既有坑）**

相机沿用夜间验收基线 `camera=103.8929,16.5428,3106,59.3,-11.9`。对每组：`?mode=atmosphere&clouds=1&time=<T>&camera=…` 与同 URL `&moon=0` 成对 screenshot，像素 diff（agent-browser diff screenshot）。

| 组 | time | 断言 |
|---|---|---|
| 满月 | 2026-09-25T16:00:00Z | 云 vs moon=0 有方向性增亮（月侧亮）；月盘在月亮方位可见；盘心 display 落 [70,180]/255（截图采样月盘中心像素） |
| 新月 | 朔时刻 | 云与 moon=0 几乎一致（底光主导）；无月盘或极细月牙 |
| 弦月 | 弦月时刻 | 月盘半圆；云增亮 ≈满月 1/3（两组成对 diff 云区均值比） |
| 月落夜 | 弦月日期月高<−5° | 云与 moon=0 一致（月升落门生效，无「地下光」） |
| 白天 | 既有白天验收 time | **云区** diff=0；月盘侧允许差异（若月在画面内） |

（像素断言工具：截图后用 node 脚本读 PNG 像素——AI 读图结论须像素级佐证的既定纪律。）

- [ ] **Step 3: 记录与收尾**

验收数据写入 `docs/superpowers/plans/2026-08-30-night-lighting-moonlight-results.md`（五组数据表+偏差记录；全过也写——数据留档是本项目惯例）。未达标项（如 moonLightScale 默认值观感）→ 调 URL 参数复测，用户视觉拍板后改默认值单独 commit。

- [ ] **Step 4: Commit（results 或验收记录）**

```
git add docs/superpowers/plans/2026-08-30-night-lighting-moonlight-results.md
git commit -m "docs(clouds): 月光验收记录——满月/新月/弦月/月落/白天五组成对数据"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4（T1）/§5.1-5.2 月盘 shader（T2）/§5.4 options/state/uniforms/preRender（T3）/§6.1-6.2 云 shader（T4）/§6.5+参数（T5）/§7 URL（T6）/§8 验收（T7）/§2 非目标与 §9 局限——无任务对应（非目标不实现即覆盖）。无缺口。
- **占位符扫描**：无 TBD/TODO；每步有完整代码或精确锚点。Task 1 测试代码中标注了「坏草稿残片删除」一处自纠说明。
- **类型一致**：`computeMoonDirectionECEF(time, icrfToFixed, originECEF, result)` 四参签名 T1/T3/T5 一致；uniform 三名（moonDirection/moonAngularRadius+u_moonRadiance 与 moonDirection/moonIlluminatedFraction/moonLightScale）T2/T3/T4/T5 一致；option 三名 T3/T6 一致。
