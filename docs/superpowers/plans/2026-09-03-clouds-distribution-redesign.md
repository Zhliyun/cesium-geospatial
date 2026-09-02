# 体积云分布重设计（时间切片 3D 云图）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用运行时 GPU 烘焙的时间切片 3D 云图替换静态 local_weather.png，实现云分布去规律化、时间演化、纬度气候带、密度/高度全局控制与同机多 Viewer 确定性。

**Architecture:** 新增 WeatherAtlas 模块（无 source 构造 Texture3D 256²×64 + 裸 FBO 逐层烘焙 + 3D mip 链 + 三级降级链）；烘焙 shader 用噪声时间维扫掠产生云单体生消演化；sampleWeather 改 3D 采样并叠加采样侧纬度气候带与风平流；参数经现成 options.parameters 管线透传。

**Tech Stack:** TypeScript + Cesium（Texture3D/裸 GL framebufferTextureLayer）+ GLSL ES 3.0 + vitest（glslangValidator 编译测试）+ playwright（验收）

**Spec:** `docs/superpowers/specs/2026-09-03-clouds-distribution-redesign-design.md`（r2，四专家评审+用户终审通过）

## Global Constraints

- 烘焙纹理：256×256×64 RGBA UNSIGNED_BYTE，REPEAT wrap，无 `source` 构造（immutable texStorage3D 会锁死 mip）→ 逐层烘焙 → `generateMipmap()` → `getError()` 验证；VRAM 含 mip ≈22.4MB
- 时间轴：`tNorm = mod(tSec, period)/period`、`windOffset(tile 单位, mod 1) = speed×tSec/(tileKm×1000)`——**全部 CPU 侧 float64 mod 后传 uniform**（JulianDate 绝对秒 ~8.4e8，float32 ULP=64s，GPU 侧禁止 mod 原始秒）
- 种子：`WEATHER_BAKE_SEED = 1337` 硬编码常量（weatherTime.ts 导出），`?cloudsSeed=` 可覆盖
- 烘焙域周期化铁律：一切噪声（基底/warp/演化偏移后）以烘焙域为周期——只许周期 Worley（整频）与 periodic perlin；时间维行程取整数（Z_CYCLES=4、W_CYCLES=2）
- 复合顺序钉死：`F(p + warp(p) + evolve_i)`——warp 作用于未平移 p，演化偏移加在 warp 之后（反向=纯平移零形变，禁止）
- 气候带 clamp [0.2, 1.3]（上界 1.3 防「实心白环」）；预设激活时 band 下限 clamp ≥0.6
- ITCZ 中心 `latC = 5° + 7.5°·cos(2π(doy−215)/365.25)`，CPU 算 `u_itczCenterSin = sin(latC)` 传 uniform；锚点 doy=227→max、doy=47→min
- 默认值：演化环周期 5.3h、风速 8 m/s 对角、evolveRadius 0.25 tile、repeat 100、coverage 0.3、altitudeOffset 0
- RGBA 第 4 通道（a）烘焙恒 1（现状死值语义，不激活）
- 删除 evolution hack（clouds.glsl `evolution = -surfaceNormal * localWeatherSpeed * 2e4` 两行）
- 逃生门：`?cloudsAtlas=0` → PNG 包装单层语义 3D 纹理（sampler LINEAR，无演化有平流）
- 验收环境铁律：三层清 vite 缓存（`pkill -f vite && rm -rf apps/demo/node_modules/.vite`）+ 等 tilesLoaded + 像素量化 + headless 画面不可信（读回数值可信）
- 测试命令：`pnpm --filter @cesium-geospatial/cesium-clouds test`（云包全套）；编译单测：`npx vitest run src/cloudsMain.compile.test.ts`（在 packages/cesium-clouds 下）
- 每 task 结束跑云包全套测试绿后 commit；golden snapshot 失配随主动 shader 变更 `vitest run -u`

---

### Task 1: weatherTime.ts——时间轴与 ITCZ 纯函数

**Files:**
- Create: `packages/cesium-clouds/src/weatherTime.ts`
- Test: `packages/cesium-clouds/src/weatherTime.test.ts`

**Interfaces:**
- Consumes: 无（纯函数模块，仅 Cesium Cartesian2 类型）
- Produces: `WEATHER_BAKE_SEED`、`WEATHER_EVOLUTION_PERIOD_S = 19080`（5.3h）、`WEATHER_WIND_SPEED_MPS = 8`、`computeEvolutionTNorm(tSec: number, periodS: number): number`、`computeWindOffsetTiles(tSec: number, speedMps: number, tileKm: number): Cartesian2`、`computeDayOfYear(month: number, day: number): number`、`computeItczCenterLatDeg(dayOfYear: number): number`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/cesium-clouds/src/weatherTime.test.ts
import { describe, expect, it } from 'vitest'
import { Cartesian2 } from 'cesium'
import {
  WEATHER_BAKE_SEED,
  WEATHER_EVOLUTION_PERIOD_S,
  WEATHER_WIND_SPEED_MPS,
  computeDayOfYear,
  computeEvolutionTNorm,
  computeItczCenterLatDeg,
  computeWindOffsetTiles
} from './weatherTime'

describe('weatherTime 时间轴纯函数（spec §4.1/§5.4）', () => {
  it('种子/周期/风速常量符合 spec 定值', () => {
    expect(WEATHER_BAKE_SEED).toBe(1337)
    expect(WEATHER_EVOLUTION_PERIOD_S).toBeCloseTo(5.3 * 3600, 0)
    expect(WEATHER_WIND_SPEED_MPS).toBe(8)
  })

  it('tNorm：tSec=0 → 0；tSec=period/2 → 0.5；环回绕', () => {
    expect(computeEvolutionTNorm(0, 100)).toBe(0)
    expect(computeEvolutionTNorm(50, 100)).toBe(0.5)
    expect(computeEvolutionTNorm(100, 100)).toBe(0)
    expect(computeEvolutionTNorm(137.5, 100)).toBeCloseTo(0.375, 12)
  })

  it('tNorm：负时间安全（时间回退云图回退，spec §4.1）', () => {
    expect(computeEvolutionTNorm(-50, 100)).toBe(0.5)
    expect(computeEvolutionTNorm(-1e9, 19080)).toBeGreaterThanOrEqual(0)
    expect(computeEvolutionTNorm(-1e9, 19080)).toBeLessThan(1)
  })

  it('tNorm：大数精度——1e9 秒量级 mod 后无 float32 损耗（CPU float64 铁律）', () => {
    // JulianDate 2026 年 ~8.4e8 s；float32 ULP=64s，若在 float32 域 mod 会丢分钟级精度。
    // float64 下两次相邻秒采样结果差恒为 1/period。
    const t0 = computeEvolutionTNorm(8.4e8, 19080)
    const t1 = computeEvolutionTNorm(8.4e8 + 1, 19080)
    expect(Math.abs(t1 - t0)).toBeCloseTo(1 / 19080, 9)
  })

  it('windOffset：tile 单位、mod 1、方向对角', () => {
    // tileKm=100.075（repeat=100），speed=8 → 1s 位移 = 8/100075 tile
    const o = computeWindOffsetTiles(100075, 8, 100.075)
    expect(o.x).toBeCloseTo(0, 12) // 恰好 1 tile，mod 1 → 0
    // 负时间 mod 1 后仍在 [0,1)
    const o2 = computeWindOffsetTiles(-1000, 8, 100.075)
    expect(o2.x).toBeGreaterThanOrEqual(0)
    expect(o2.x).toBeLessThan(1)
    expect(o2.y).toBeGreaterThanOrEqual(0)
  })

  it('windOffset 返回 Cartesian2 且 x/y 分量相等（对角风向）', () => {
    const o = computeWindOffsetTiles(12345, 8, 100.075)
    expect(o).toBeInstanceOf(Cartesian2)
    expect(o.x).toBe(o.y)
  })

  it('computeDayOfYear：月日累加表（平年）', () => {
    expect(computeDayOfYear(1, 1)).toBe(1)
    expect(computeDayOfYear(2, 1)).toBe(32)
    expect(computeDayOfYear(8, 15)).toBe(227) // ITCZ 最北锚点
    expect(computeDayOfYear(2, 16)).toBe(47) // ITCZ 最南锚点
    expect(computeDayOfYear(12, 31)).toBe(365)
  })

  it('ITCZ 中心：doy=227 最北 ≈12.5°N、doy=47 最南 ≈−2.5°（spec §5.4 公式）', () => {
    expect(computeItczCenterLatDeg(227)).toBeCloseTo(12.5, 6)
    expect(computeItczCenterLatDeg(47)).toBeCloseTo(-2.5, 6)
    // 年均 ~5°N（中心偏北，非 0）
    expect(computeItczCenterLatDeg(227 + 182)).toBeCloseTo(5 - 2.5, 1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cesium-clouds && npx vitest run src/weatherTime.test.ts`
Expected: FAIL（weatherTime 模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// packages/cesium-clouds/src/weatherTime.ts
//
// 云图时间轴纯函数（spec §4.1/§5.4）——全部 CPU 侧 float64 计算。
// 铁律：JulianDate 绝对秒 ~8.4e8，float32 ULP=64s——tNorm/windOffset 必须
// 在 CPU mod 完再传 uniform，GPU 侧禁止对原始秒 mod（spec §4.1 精度陷阱）。
import { Cartesian2 } from 'cesium'

/** 烘焙种子（硬编码常量——两个 Viewer 各自烘焙结果逐位相同的前提，spec §4.5）。 */
export const WEATHER_BAKE_SEED = 1337
/** 演化环周期（秒）——64 切片 × 5min = 5.3h，?cloudsEvolutionHours= 可覆盖。 */
export const WEATHER_EVOLUTION_PERIOD_S = 5.3 * 3600
/** 平流风速 m/s（≈30km/h，信风/中纬地面风量级，spec §5.3）。 */
export const WEATHER_WIND_SPEED_MPS = 8
/** cube-sphere 每 face 赤道向弧长（km）：赤道周长 40075.017/4。 */
export const CUBE_FACE_WIDTH_KM = 40075.017 / 4

/** 正安全 mod（负时间回退时结果仍 ∈[0,mod)）。 */
function posMod(a: number, m: number): number {
  return ((a % m) + m) % m
}

/**
 * 演化归一化相位 tNorm ∈ [0,1)——3D 云图 z 采样坐标。
 * 纯函数：clock 同刻 ⇒ 同 tNorm（同机多 Viewer 确定性的时间轴半边）。
 */
export function computeEvolutionTNorm(tSec: number, periodS: number): number {
  return posMod(tSec, periodS) / periodS
}

/**
 * 平流偏移（tile 单位，mod 1）——加在 `uv × localWeatherRepeat` 之后（spec §5.3，
 * 与 repeat 语义解耦；tileKm = CUBE_FACE_WIDTH_KM / repeat）。
 * 风向固定对角（x=y），v1 不暴露风向（spec §9）。
 */
export function computeWindOffsetTiles(
  tSec: number,
  speedMps: number,
  tileKm: number
): Cartesian2 {
  const offsetTiles = (speedMps * tSec) / (tileKm * 1000)
  const o = posMod(offsetTiles, 1)
  return new Cartesian2(o, o)
}

const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]

/** 年内天序（1-based，平年；ITCZ 相位容差 ≫ 闰日 1 天，不修闰年）。 */
export function computeDayOfYear(month: number, day: number): number {
  return DAYS_BEFORE_MONTH[month - 1] + day
}

/**
 * ITCZ 中心纬度（度，spec §5.4）：年均 ~5°N（海陆不对称北偏），不对称漂移
 * 北移 ~12°/南移 ~3°；最北 8 月上旬（doy≈227）、最南 2 月（doy≈47）。
 * 相位锚点由 weatherTime.test.ts 断言（spec §8）。
 */
export function computeItczCenterLatDeg(dayOfYear: number): number {
  return 5 + 7.5 * Math.cos((2 * Math.PI * (dayOfYear - 215)) / 365.25)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/cesium-clouds && npx vitest run src/weatherTime.test.ts`
Expected: PASS（9 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/weatherTime.ts packages/cesium-clouds/src/weatherTime.test.ts
git commit -m "feat(clouds): weatherTime 时间轴纯函数——tNorm/windOffset CPU float64 mod（float32 ULP 64s 铁律）+ITCZ 相位锚点"
```

---

### Task 2: cloudLayersPacking.ts——层参数 packed 派生移植 + 高度偏移

**Files:**
- Create: `packages/cesium-clouds/src/cloudLayersPacking.ts`
- Test: `packages/cesium-clouds/src/cloudLayersPacking.test.ts`
- Modify: `packages/cesium-clouds/src/index.ts`（导出新模块）

**Interfaces:**
- Consumes: 无（纯数据模块）
- Produces: `CloudLayerParams`（interface）、`DEFAULT_CLOUD_LAYERS: CloudLayerParams[]`（4 层，值=cloudsDefaultParameters.ts 注释里的 L0-L3）、`applyAltitudeOffset(layers, offsetM): CloudLayerParams[]`、`packLayerUniforms(layers): PackedLayerUniforms`（15 个字段，名与 CloudsParameters 里同名）

- [ ] **Step 1: 写失败测试**

```typescript
// packages/cesium-clouds/src/cloudLayersPacking.test.ts
import { describe, expect, it } from 'vitest'
import { Cartesian3, Cartesian4 } from 'cesium'
import { applyAltitudeOffset, DEFAULT_CLOUD_LAYERS, packLayerUniforms } from './cloudLayersPacking'
import { defaultCloudsParameters } from './cloudsDefaultParameters'

describe('cloudLayersPacking（spec §6.3——three pack 派生移植）', () => {
  it('默认层输入 → packed 输出逐项等于写死默认值表（最强回归锚）', () => {
    const p = packLayerUniforms(DEFAULT_CLOUD_LAYERS)
    const d = defaultCloudsParameters()
    expect(p.minLayerHeights).toEqual(new Cartesian4(750, 1000, 7500, 0))
    expect(p.maxLayerHeights).toEqual(new Cartesian4(1400, 2200, 8000, 0))
    expect(p.minIntervalHeights).toEqual(new Cartesian3(0, 2200, 0))
    expect(p.maxIntervalHeights).toEqual(new Cartesian3(750, 7500, 0))
    expect(p.densityScales).toEqual(new Cartesian4(0.2, 0.2, 0.003, 0.2))
    expect(p.shapeAmounts).toEqual(new Cartesian4(1, 1, 0.4, 1))
    expect(p.shapeDetailAmounts).toEqual(new Cartesian4(1, 1, 0, 1))
    expect(p.weatherExponents).toEqual(new Cartesian4(1, 1, 1, 1))
    expect(p.shapeAlteringBiases).toEqual(new Cartesian4(0.35, 0.35, 0.35, 0.35))
    expect(p.coverageFilterWidths).toEqual(new Cartesian4(0.6, 0.6, 0.5, 0.6))
    expect(p.minHeight).toBe(750)
    expect(p.maxHeight).toBe(8000)
    expect(p.shadowTopHeight).toBe(2200)
    expect(p.shadowBottomHeight).toBe(750)
    expect(p.shadowLayerMask).toEqual(new Cartesian4(1, 1, 0, 0))
  })

  it('applyAltitudeOffset(+500)：仅 L0/L1 抬升，packed 全项联动（spec §6.3 清单）', () => {
    const p = packLayerUniforms(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, 500))
    expect(p.minLayerHeights).toEqual(new Cartesian4(1250, 1500, 7500, 0))
    expect(p.maxLayerHeights).toEqual(new Cartesian4(1900, 2700, 8000, 0))
    expect(p.minHeight).toBe(1250) // march 入射壳消费（clouds.frag:835）
    expect(p.maxHeight).toBe(8000)
    expect(p.shadowBottomHeight).toBe(1250)
    expect(p.shadowTopHeight).toBe(2700)
  })

  it('applyAltitudeOffset 负偏移：minHeight 同步下移（红队 BLOCKER-4 回归项）', () => {
    const p = packLayerUniforms(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, -500))
    expect(p.minHeight).toBe(250)
    expect(p.shadowBottomHeight).toBe(250)
  })

  it('applyAltitudeOffset clamp [-500,+3000]（spec §6.1）', () => {
    expect(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, 9999)[0].altitude).toBe(750 + 3000)
    expect(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, -9999)[0].altitude).toBe(750 - 500)
  })

  it('applyAltitudeOffset 不改 L2/L3（高卷云不动，spec §6.1 低云带语义）', () => {
    const layers = applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, 3000)
    expect(layers[2].altitude).toBe(7500)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cesium-clouds && npx vitest run src/cloudLayersPacking.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// packages/cesium-clouds/src/cloudLayersPacking.ts
//
// 云层参数 → packed uniforms 派生（spec §6.3）。对齐 three-geospatial
// uniforms.ts packValues/packSums/packIntervalHeights 语义——此前本项目把
// packed 写死在 cloudsDefaultParameters.ts，云高度偏移（?cloudsAltitudeOffset=）
// 需要「改层参数 → 全部派生项重算」的纯函数链。
//
// ⚠️ 重算清单完整版（红队 BLOCKER-4 教训）：packed 4 向量 + minHeight/maxHeight
// 标量（march 入射壳 clouds.frag:835 直接消费）+ shadowTop/BottomHeight（BSM 域）。
// shadowLayerMask 只记层成员，不随高度变。
import { Cartesian2, Cartesian3, Cartesian4 } from 'cesium'

export interface CloudLayerParams {
  altitude: number
  height: number
  densityScale: number
  shapeAmount: number
  shapeDetailAmount: number
  weatherExponent: number
  shapeAlteringBias: number
  coverageFilterWidth: number
  shadow: boolean
}

/** 三层云默认值（=CloudLayers.DEFAULT，cloudsDefaultParameters.ts 注释 L229-233 逐字）。 */
export const DEFAULT_CLOUD_LAYERS: CloudLayerParams[] = [
  { altitude: 750, height: 650, densityScale: 0.2, shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1, shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: true },
  { altitude: 1000, height: 1200, densityScale: 0.2, shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1, shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: true },
  { altitude: 7500, height: 500, densityScale: 0.003, shapeAmount: 0.4, shapeDetailAmount: 0, weatherExponent: 1, shapeAlteringBias: 0.35, coverageFilterWidth: 0.5, shadow: false },
  { altitude: 0, height: 0, densityScale: 0.2, shapeAmount: 1, shapeDetailAmount: 1, weatherExponent: 1, shapeAlteringBias: 0.35, coverageFilterWidth: 0.6, shadow: false }
]

/** 低云带高度偏移 clamp（spec §6.1）。 */
export const ALTITUDE_OFFSET_RANGE: Cartesian2 = new Cartesian2(-500, 3000)

/** 仅低云带 L0/L1 加偏移（clamp；L2 高卷云/L3 不动）。 */
export function applyAltitudeOffset(layers: CloudLayerParams[], offsetM: number): CloudLayerParams[] {
  const clamped = Math.min(Math.max(offsetM, ALTITUDE_OFFSET_RANGE.x), ALTITUDE_OFFSET_RANGE.y)
  return layers.map((l, i) =>
    i <= 1 ? { ...l, altitude: l.altitude + clamped } : { ...l }
  )
}

export interface PackedLayerUniforms {
  minLayerHeights: Cartesian4
  maxLayerHeights: Cartesian4
  minIntervalHeights: Cartesian3
  maxIntervalHeights: Cartesian3
  densityScales: Cartesian4
  shapeAmounts: Cartesian4
  shapeDetailAmounts: Cartesian4
  weatherExponents: Cartesian4
  shapeAlteringBiases: Cartesian4
  coverageFilterWidths: Cartesian4
  minHeight: number
  maxHeight: number
  shadowTopHeight: number
  shadowBottomHeight: number
  shadowLayerMask: Cartesian4
}

// packIntervalHeights（three uniforms.ts:141-180 语义）：所有层的 (min,open)/(max,close)
// 端点排序，balance 从 0 递增扫描，balance 回落到 0 处闭合当前区间——得到「层间隙区间」
// （无任何层覆盖的高度段），用于 march 空域快速跳跃。默认三层 → 区间 [0,750] [2200,7500]
// （第三区间 [0,0] 为 L3 空层产物，保留 three 行为）。
function packIntervalHeights(layers: CloudLayerParams[]): { min: Cartesian3; max: Cartesian3 } {
  const entries: Array<{ h: number; delta: number }> = []
  for (const l of layers) {
    if (l.height <= 0) continue
    entries.push({ h: l.altitude, delta: 1 })
    entries.push({ h: l.altitude + l.height, delta: -1 })
  }
  entries.sort((a, b) => a.h - b.h || b.delta - a.delta)
  const mins: number[] = []
  const maxs: number[] = []
  let balance = 0
  let open = 0
  for (const e of entries) {
    if (balance === 0 && e.delta === 1) open = e.h
    balance += e.delta
    if (balance === 0 && e.delta === -1) {
      mins.push(open)
      maxs.push(e.h)
    }
  }
  // three 行为：固定 3 槽，不足补 [0,0]
  while (mins.length < 3) {
    mins.push(0)
    maxs.push(0)
  }
  return { min: new Cartesian3(mins[0], mins[1], mins[2]), max: new Cartesian3(maxs[0], maxs[1], maxs[2]) }
}

/** 层参数 → 全部 packed uniforms（cloudsDefaultParameters.ts 同名字段语义）。 */
export function packLayerUniforms(layers: CloudLayerParams[]): PackedLayerUniforms {
  const shadowed = layers.filter((l) => l.shadow && l.height > 0)
  const intervals = packIntervalHeights(layers)
  return {
    minLayerHeights: new Cartesian4(layers[0].altitude, layers[1].altitude, layers[2].altitude, layers[3].altitude),
    maxLayerHeights: new Cartesian4(
      layers[0].altitude + layers[0].height,
      layers[1].altitude + layers[1].height,
      layers[2].altitude + layers[2].height,
      layers[3].altitude + layers[3].height
    ),
    minIntervalHeights: intervals.min,
    maxIntervalHeights: intervals.max,
    densityScales: new Cartesian4(layers[0].densityScale, layers[1].densityScale, layers[2].densityScale, layers[3].densityScale),
    shapeAmounts: new Cartesian4(layers[0].shapeAmount, layers[1].shapeAmount, layers[2].shapeAmount, layers[3].shapeAmount),
    shapeDetailAmounts: new Cartesian4(layers[0].shapeDetailAmount, layers[1].shapeDetailAmount, layers[2].shapeDetailAmount, layers[3].shapeDetailAmount),
    weatherExponents: new Cartesian4(layers[0].weatherExponent, layers[1].weatherExponent, layers[2].weatherExponent, layers[3].weatherExponent),
    shapeAlteringBiases: new Cartesian4(layers[0].shapeAlteringBias, layers[1].shapeAlteringBias, layers[2].shapeAlteringBias, layers[3].shapeAlteringBias),
    coverageFilterWidths: new Cartesian4(layers[0].coverageFilterWidth, layers[1].coverageFilterWidth, layers[2].coverageFilterWidth, layers[3].coverageFilterWidth),
    minHeight: Math.min(...layers.map((l) => l.altitude)),
    maxHeight: Math.max(...layers.map((l) => l.altitude + l.height)),
    shadowTopHeight: Math.max(...shadowed.map((l) => l.altitude + l.height)),
    shadowBottomHeight: Math.min(...shadowed.map((l) => l.altitude)),
    shadowLayerMask: new Cartesian4(
      layers[0].shadow ? 1 : 0,
      layers[1].shadow ? 1 : 0,
      layers[2].shadow ? 1 : 0,
      layers[3].shadow ? 1 : 0
    )
  }
}
```

注意：`packIntervalHeights` 的排序 tie-break（同高度端点 open 先于 close？）必须让默认输入产出 `[0,750] [2200,7500] [0,0]`——若 Step 4 断言失败，检查 tie-break：`b.delta - a.delta` 使同高度时 delta 大者（open=1）在前；L3 height=0 被 skip。若产出仍不符，改用 three 源语义（balance===0 时遇 close 直接产生 [prev,0] 空区间——保持首测为锚，修实现至绿）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/cesium-clouds && npx vitest run src/cloudLayersPacking.test.ts`
Expected: PASS。**关键**：第一用例（默认输入→写死值）是 three 语义回归锚，红即实现语义错，修实现不是修测试。

- [ ] **Step 5: index.ts 导出 + 全套件回归 + Commit**

```bash
# packages/cesium-clouds/src/index.ts 增加：
# export * from './cloudLayersPacking'
cd packages/cesium-clouds && npx vitest run && cd ../..
git add packages/cesium-clouds/src/cloudLayersPacking.ts packages/cesium-clouds/src/cloudLayersPacking.test.ts packages/cesium-clouds/src/index.ts
git commit -m "feat(clouds): cloudLayersPacking 派生移植——packed 4 向量+minHeight/maxHeight+BSM 域全项重算（红队 BLOCKER-4 补漏）"
```

---

### Task 3: weatherBake.frag.glsl——烘焙 shader

**Files:**
- Create: `packages/cesium-clouds/src/glsl/weatherBake.frag.glsl`
- Modify: `packages/cesium-clouds/src/glslIndex.ts`（注册 `weatherBakeFrag`）
- Test: `packages/cesium-clouds/src/weatherBake.compile.test.ts`

**Interfaces:**
- Consumes: `#include "perlin"`（`perlin(vec4, vec4)`）、`#include "tileableNoise"`（`getWorleyNoise(vec3, float)`）
- Produces: 完整 fragment（顶点侧复用 viewport quad 的 vUv）；uniforms：`u_slice`（i/N∈[0,1)）、`u_seedOffset`（vec2，由 seed 派生）；输出 RGBA（r=low、g=mid、b=high、a=1 恒）

- [ ] **Step 1: 写编译失败测试**

```typescript
// packages/cesium-clouds/src/weatherBake.compile.test.ts
import { describe, expect, it } from 'vitest'
import { compileFragment } from './glslangUtil'

// 与 weatherBake.frag.glsl 的 include 结构一致的最小 assembly（真实组装器在 Task 6
// 的 WeatherAtlas 内；本测试独立组装验证 GLSL 合法性——防 include 漏 name）。
function buildStandaloneBakeShader(): string {
  const { glslIndex } = await import('./glslIndex') // 顶层静态 import 即可
  const resolve = (name: string): string => {
    const parts = name.split('/')
    let src: string = (glslIndex as Record<string, unknown>)[parts[0]] as string
    return src
  }
  const body = resolve('weatherBakeFrag')
  const includes = ['perlin', 'tileableNoise']
    .map((n) => resolve(n))
    .join('\n')
  return `#version 300 es\nprecision highp float;\n${includes}\n${body}`
}

describe('weatherBake.frag 编译（spec §5.1/§5.2）', () => {
  it('glslangValidator 编译通过', async () => {
    const src = `#version 300 es\nprecision highp float;\n${['perlin', 'tileableNoise'].join('\n')}\n${(await import('./glslIndex')).glslIndex.weatherBakeFrag}`
    const { ok, output } = compileFragment(src)
    if (!ok) {
      throw new Error(`烘焙 shader 编译失败:\n${output}`)
    }
    expect(ok).toBe(true)
  })

  it('含周期化铁律要素：u_slice 时间维、圆环演化、a 通道恒 1', async () => {
    const { glslIndex } = await import('./glslIndex')
    const src = glslIndex.weatherBakeFrag
    expect(src).toContain('u_slice')
    expect(src).toContain('Z_CYCLES')
    expect(src).toContain('W_CYCLES')
    expect(src).toContain('outputColor.a = 1.0')
    // 复合顺序钉死（spec §5.2）：演化偏移在 warp 之后
    expect(src).toContain('vec3 bakePoint = vec3(p + pw + ringOffset')
  })
})
```

（写测试时把第一个用例改成同步 import——上面 async 写法仅示意；以项目 vitest ESM 惯例为准，参照 `cloudsMain.compile.test.ts` 的静态 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/cesium-clouds && npx vitest run src/weatherBake.compile.test.ts`
Expected: FAIL（glslIndex.weatherBakeFrag undefined）

- [ ] **Step 3: 写烘焙 shader**

```glsl
// packages/cesium-clouds/src/glsl/weatherBake.frag.glsl
//
// WeatherAtlas 烘焙 shader（spec §5）：256²×64 切片中第 floor(u_slice×64) 层。
// 设计：
//  - 周期化铁律（spec §5.1）：全部噪声以烘焙域为周期——Worley 整频（p 空间周期 1）、
//    perlin periodic 版（rep=frequency）。
//  - 时间维扫掠（spec §5.2 主方案）：Worley 采 z=u_slice×Z_CYCLES（平面扫过 3D 特征点
//    → 云单体原生长大/缩小/消亡）；perlin 采 w=u_slice×W_CYCLES（4D 第 4 维）。
//    Z_CYCLES/W_CYCLES 必须整数——演化闭合铁律（环回绕 u_slice=0 与 1 同点）。
//  - 圆环漂移（辅助低频分量）：ringOffset = R×(cos,sin)(2π·u_slice)。
//  - 复合顺序钉死：F(p + warp(p) + ringOffset)——warp 作用于未平移 p（反向复合=纯
//    刚体平移零形变，spec BLOCKER 修订）。
//  - 第 4 通道恒 1（现状 local_weather.png 死值语义，spec §4.6）。
precision highp float;
precision highp int;

#include "perlin"
#include "tileableNoise"

in vec2 vUv;

layout(location = 0) out vec4 outputColor;

uniform float u_slice;      // i/N ∈ [0,1)
uniform vec2 u_seedOffset;  // WEATHER_BAKE_SEED 派生的固定偏移（确定性，spec §4.5）

// 演化闭合整数行程（spec §5.2 铁律）
#define Z_CYCLES 4.0
#define W_CYCLES 2.0
#define EVOLVE_RADIUS 0.25
// 域扭曲：整数频率（周期化铁律）、互质防共振；warpAmp 以低云基频 cell 数标定
#define WARP_F1 3
#define WARP_F2 5
#define WARP_AMP 0.06

// vec3 特征点修正版 Worley FBM（spec §1 根因 4：tileableNoise:56 标量 hash 把特征点
// 钉在 cell 对角线——三路相位错开标量噪声合成 vec3 偏移打散，turbulence.frag 手法）。
float worleyFeatureOffset(const vec3 tp, const float cellCount, const float seed) {
  vec3 o = vec3(
    noise(mod(tp + seed, cellCount)),
    noise(mod(tp + seed + 17.31, cellCount)),
    noise(mod(tp + seed + 43.7, cellCount))
  );
  return o.x + o.y + o.z;
}

float getWorleyNoiseV3(const vec3 p, const float cellCount, const float seed) {
  vec3 cell = p * cellCount;
  float d = 1.0e10;
  for (int x = -1; x <= 1; ++x) {
    for (int y = -1; y <= 1; ++y) {
      for (int z = -1; z <= 1; ++z) {
        vec3 tp = floor(cell) + vec3(x, y, z);
        vec3 tpo = cell - tp - worleyFeatureOffset(tp, cellCount, seed);
        d = min(d, dot(tpo, tpo));
      }
    }
  }
  return clamp(d, 0.0, 1.0);
}

float getWorleyFbmV3(const vec3 p, const float freq, const float seed) {
  float amp = 0.4;
  float f = freq;
  float sum = 0.0;
  for (int i = 0; i < 4; ++i) {
    sum += amp * (1.0 - getWorleyNoiseV3(p, f, seed + float(i) * 11.3));
    f *= 2.0;
    amp *= 0.95;
  }
  return sum;
}

void main() {
  vec2 p = vUv;
  float zPhase = u_slice * Z_CYCLES;
  float wPhase = u_slice * W_CYCLES;
  float ringAngle = 6.28318530718 * u_slice;
  vec2 ringOffset = EVOLVE_RADIUS * vec2(cos(ringAngle), sin(ringAngle));

  // 周期化域扭曲（perlin 4D，w=wPhase 使扭曲场本身随时间演化——形变局部化）
  vec2 warpA = vec2(
    perlin(vec4(p * float(WARP_F1), 0.0, wPhase), vec4(float(WARP_F1), float(WARP_F1), 1.0, W_CYCLES)),
    perlin(vec4(p * float(WARP_F2), 0.0, wPhase), vec4(float(WARP_F2), float(WARP_F2), 1.0, W_CYCLES))
  );
  vec2 pw = p + WARP_AMP * warpA;         // warp 作用于未平移 p
  vec3 bakePoint = vec3(pw + ringOffset + u_seedOffset, zPhase + u_seedOffset.x);

  // Low clouds（对齐 localWeather.frag low 路线：freq 16 → smoothstep(0.8,1.4)）
  float low = getWorleyFbmV3(bakePoint, 16.0, 1.7);
  low = smoothstep(0.8, 1.4, low);

  // Mid clouds（freq 8 + vec3(0.5) 相位，smoothstep(1.0,1.4)）
  float mid = getWorleyFbmV3(bakePoint + vec3(0.5, 0.5, 0.0), 8.0, 9.2);
  mid = smoothstep(1.0, 1.4, mid);
  mid = max(mid, low); // 与旧图语义一致：low 是 mid 去除后的余量——旧图 r = saturate(worley-g)；
  // 此处烘焙为独立通道（采样端 clouds.glsl:96 remap 链按通道独立），保持低/中云视觉分层。

  // High clouds（perlin 4D w 维扫掠，对齐 high 路线 freq vec3(6,12,1)）
  float high = perlin(
    vec4(bakePoint.xy * vec2(6.0, 12.0), 0.0, wPhase + 0.3),
    vec4(6.0, 12.0, 1.0, W_CYCLES)
  );
  high = smoothstep(-0.5, 0.5, high * 2.2); // perlin 输出约 ±0.45（perlin.glsl:210 语义）

  outputColor = vec4(low, mid, high, 1.0);
}
```

`glslIndex.ts` 注册：`import _weatherBakeFrag from './glsl/weatherBake.frag?raw'` + 顶层 key `weatherBakeFrag: _weatherBakeFrag`。

- [ ] **Step 4: 跑编译测试确认通过**

Run: `cd packages/cesium-clouds && npx vitest run src/weatherBake.compile.test.ts`
Expected: PASS（glslangValidator 绿）。编译错按行号修（多为类型/重声明）。

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/glsl/weatherBake.frag.glsl packages/cesium-clouds/src/glslIndex.ts packages/cesium-clouds/src/weatherBake.compile.test.ts
git commit -m "feat(clouds): weatherBake 烘焙 shader——时间维扫掠生消演化+vec3 特征点修正（根因4）+周期化铁律"
```

---

### Task 4: sampleWeather 3D 改造 + 气候带 + 平流

**Files:**
- Modify: `packages/cesium-clouds/src/glsl/parameters.glsl:22-24`（uniform 改型+新增）
- Modify: `packages/cesium-clouds/src/glsl/clouds.glsl:75-103`（sampleWeather）、`:119-143`（sampleMedia 删 evolution hack）
- Modify: `packages/cesium-clouds/src/glsl/clouds.frag:407`、`:547`（调用点传 position）
- Modify: `packages/cesium-clouds/src/glsl/shadow.frag:89`（调用点传 position）
- Modify: `packages/cesium-clouds/src/glsl/clouds.frag:973`（DEBUG_SHOW_UV checker 引用 localWeatherRepeat 不变，确认无需改）
- Test: `packages/cesium-clouds/src/cloudsMain.compile.test.ts`、`packages/cesium-clouds/src/clouds.compile.test.ts`、`packages/cesium-clouds/src/shadowMain.compile.test.ts`（golden 随 -u 更新）

**Interfaces:**
- Consumes: Task 3 的 atlas 纹理（sampler3D）
- Produces: 新 uniform `weatherAtlasTexture`（sampler3D）、`u_windOffset`（vec2，tile 单位）、`u_atlasT`（float，tNorm）、`u_itczCenterSin`（float）、`u_climateBands`（float，0=关 1=默认）；`sampleWeather(const vec2 uv, const vec3 position, const float height, const float mipLevel)` 新签名

- [ ] **Step 1: 改 parameters.glsl（uniform 改型+新增）**

```glsl
// Shape and weather（spec §4/§5.3：2D PNG → 时间切片 3D atlas）
uniform sampler3D weatherAtlasTexture;
uniform vec2 localWeatherRepeat;
uniform vec2 localWeatherOffset;
uniform float coverage;
// WeatherAtlas 运行时调制（CPU float64 mod 后传入，spec §4.1 精度陷阱）
uniform vec2 u_windOffset;      // 平流偏移，tile 单位 mod 1，加在 uv×repeat 后
uniform float u_atlasT;         // 演化相位 tNorm ∈[0,1)，3D 纹理 z 坐标
uniform float u_itczCenterSin;  // ITCZ 中心纬度正弦（CPU 按 doy 公式算）
uniform float u_climateBands;   // 气候带强度 0=关 1=默认（spec §6.1）
uniform sampler3D shapeTexture;
```

（`uniform sampler3D shapeTexture;` 及后续行原样保留，此处仅示意插入位置。）

- [ ] **Step 2: 改 clouds.glsl sampleWeather + 气候带函数 + 删 evolution hack**

```glsl
// clouds.glsl —— 在 sampleWeather 前插入气候带包络（spec §5.4）
// latSin = normalize(position).z（ECEF z=极轴，地心纬度正弦；密切球系偏差 ≤0.4° 不可见）
float getClimateBandFactor(const float latSin) {
  float latAbs = abs(latSin);
  // ITCZ 峰：中心 u_itczCenterSin、半宽 ±10°（sin 域 0.174），cos 窗
  float d = abs(latSin - u_itczCenterSin);
  float itcz = 1.0 - smoothstep(0.0, 0.174, d);
  // 副热带高压谷（|latSin| 0.42-0.50）
  float subtropicsDip = smoothstep(0.32, 0.42, latAbs) * (1.0 - smoothstep(0.50, 0.60, latAbs));
  // 中纬度风暴带峰（|latSin| 0.707-0.866 = 45-60°，r2 修正 r1 笔误 0.66-0.77）
  float midlatPeak = smoothstep(0.62, 0.707, latAbs) * (1.0 - smoothstep(0.866, 0.94, latAbs));
  // 极地衰减（>72°，sin 0.951）
  float polarDry = smoothstep(0.951, 0.995, latAbs);
  float band = 1.0
    + 0.45 * itcz
    - 0.45 * subtropicsDip
    + 0.30 * midlatPeak
    - 0.35 * polarDry;
  band = clamp(band, 0.2, 1.3); // 上界 1.3 防「实心白环」（spec §5.4）
  return mix(1.0, band, u_climateBands); // u_climateBands=0 → 恒 1（纯随机分布）
}

WeatherSample sampleWeather(const vec2 uv, const vec3 position, const float height, const float mipLevel) {
  WeatherSample weather;
  weather.heightFraction = remapClamped(vec4(height), minLayerHeights, maxLayerHeights);

  // 3D atlas 采样（spec §4）：z=u_atlasT 相邻切片 LINEAR 插值；平流 tile 单位 mod 1
  vec3 weatherCoord = vec3(uv * localWeatherRepeat + localWeatherOffset + u_windOffset, u_atlasT);
  vec4 localWeather = pow(
    textureLod(weatherAtlasTexture, weatherCoord, mipLevel).LOCAL_WEATHER_CHANNELS,
    weatherExponents
  );
  // 纬度气候带（spec §5.4，采样侧——march 手上有真实 position）
  localWeather *= getClimateBandFactor(normalize(position).z);
  #ifdef SHADOW
  localWeather *= shadowLayerMask;
  #endif // SHADOW

  // ……（heightScale/factor/remapClamped 调制链原样保留，clouds.glsl:91-102 不动）
```

sampleMedia 内删除两行（clouds.glsl:131-132）：
```glsl
  float localWeatherSpeed = length(localWeatherOffset);   // ← 删
  vec3 evolution = -surfaceNormal * localWeatherSpeed * 2e4; // ← 删
```
并把 `:143` 的 `vec3 shapePosition = (position + evolution + turbulence) * shapeRepeat + shapeOffset;` 改为 `vec3 shapePosition = (position + turbulence) * shapeRepeat + shapeOffset;`

- [ ] **Step 3: 改三处调用点**

clouds.frag:407（次 raymarch 循环内）与 :547（主 march）：
```glsl
    vec2 uv = getGlobeUv(position);
    float height = length(position) - bottomRadius;
    WeatherSample weather = sampleWeather(uv, position, height, mipLevel);  // +position
```
shadow.frag:89 同款（bsm march 内 `sampleWeather(uv, position, height, mipLevel)`——position 为射线上的密切球系世界坐标，与主 march 同系，气候带自动生效 spec §7.1）。

- [ ] **Step 4: 编译测试更新**

- `surgeryCloudsFrag`（CloudsMaterial.ts）若含 `localWeatherTexture` 剥离/重定向逻辑，同步改 `weatherAtlasTexture`（grep 确认：`grep -n "localWeatherTexture" packages/cesium-clouds/src/CloudsMaterial.ts packages/cesium-clouds/src/glsl/*.frag`）
- 运行 `cd packages/cesium-clouds && npx vitest run src/cloudsMain.compile.test.ts src/clouds.compile.test.ts src/shadowMain.compile.test.ts src/cloudsShaderAssembler` 相关套件——golden snapshot 失配属预期（主动 shader 变更），`npx vitest run -u` 更新后全绿
- 断言补强（cloudsMain.compile.test.ts 增一用例）：

```typescript
it('sampleWeather 为 3D atlas 采样+气候带（spec §4）', () => {
  const src = buildCloudsMainFragmentShader(M2_OPTIONS)
  expect(src).toContain('weatherAtlasTexture')
  expect(src).toContain('u_atlasT')
  expect(src).toContain('getClimateBandFactor')
  expect(src).not.toContain('localWeatherSpeed') // evolution hack 已删
})
```

- [ ] **Step 5: 全套件 + Commit**

```bash
cd packages/cesium-clouds && npx vitest run -u && cd ../..
git add -A packages/cesium-clouds
git commit -m "feat(clouds): sampleWeather 3D atlas 采样+纬度气候带+风平流——删 evolution hack，三调用点传 position（BSM 云影自动跟随）"
```

---

### Task 5: WeatherAtlas.ts——烘焙模块

**Files:**
- Create: `packages/cesium-clouds/src/WeatherAtlas.ts`
- Test: `packages/cesium-clouds/src/WeatherAtlas.test.ts`

**Interfaces:**
- Consumes: Task 3 shader（经 buildWeatherBakeFragmentShader 组装）、Task 1 常量
- Produces:
  - `interface WeatherAtlasOptions { context: Context; evolutionHours?: number; windMps?: number; seed?: number; weatherRepeat?: number; pngFallback?: { width; height; data: Uint8Array } | undefined }`
  - `createWeatherAtlas(options): WeatherAtlas`
  - `interface WeatherAtlas { atlasTexture: Texture3D; mode: 'baked' | 'pngFallback'; dispose(): void }`
  - 纯逻辑导出（单测目标）：`resolveWeatherAtlasPlan(options): { evolutionPeriodS; windMps; seed; weatherRepeat; tileKm; usePngFallback }`、`bakeSeedToOffset(seed: number): Cartesian2`（hash 派生 u_seedOffset）、`ATLAS_SIZE = 256`、`ATLAS_SLICES = 64`
  - 烘焙执行 `bakeAtlas(...)`（GL 路径，playwright 冒烟覆盖）

- [ ] **Step 1: 写失败测试（纯逻辑部分）**

```typescript
// packages/cesium-clouds/src/WeatherAtlas.test.ts
import { describe, expect, it } from 'vitest'
import {
  ATLAS_SIZE,
  ATLAS_SLICES,
  bakeSeedToOffset,
  resolveWeatherAtlasPlan
} from './WeatherAtlas'

describe('WeatherAtlas 计划解析（spec §4/§6.2）', () => {
  it('尺寸常量：256²×64', () => {
    expect(ATLAS_SIZE).toBe(256)
    expect(ATLAS_SLICES).toBe(64)
  })

  it('默认计划：5.3h/8mps/seed1337/repeat100/非 fallback', () => {
    const plan = resolveWeatherAtlasPlan({})
    expect(plan.evolutionPeriodS).toBeCloseTo(5.3 * 3600, 0)
    expect(plan.windMps).toBe(8)
    expect(plan.seed).toBe(1337)
    expect(plan.weatherRepeat).toBe(100)
    expect(plan.usePngFallback).toBe(false)
  })

  it('pngFallback 提供时 usePngFallback=true', () => {
    const plan = resolveWeatherAtlasPlan({ pngFallback: { width: 1, height: 1, data: new Uint8Array(4) } })
    expect(plan.usePngFallback).toBe(true)
  })

  it('tileKm = CUBE_FACE_WIDTH_KM / repeat', () => {
    expect(resolveWeatherAtlasPlan({ weatherRepeat: 100 }).tileKm).toBeCloseTo(40075.017 / 4 / 100, 3)
  })

  it('bakeSeedToOffset 确定性：同 seed 同偏移、[0,1) 域', () => {
    const a = bakeSeedToOffset(1337)
    const b = bakeSeedToOffset(1337)
    expect(a.x).toBe(b.x)
    expect(a.y).toBe(b.y)
    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.x).toBeLessThan(1)
    expect(bakeSeedToOffset(1338).x).not.toBe(a.x) // 不同 seed 不同图
  })
})
```

- [ ] **Step 2: 跑测试确认失败** → Run: `cd packages/cesium-clouds && npx vitest run src/WeatherAtlas.test.ts`，Expected: FAIL

- [ ] **Step 3: 写实现（GL 路径照抄 ShadowPass 防御模式）**

核心结构（GL 段落要点——完整实现按此展开）：

```typescript
// packages/cesium-clouds/src/WeatherAtlas.ts 关键段
import { Cartesian2, PixelFormat, PixelDatatype, Sampler, Texture3D,
         TextureWrap, TextureMinificationFilter, TextureMagnificationFilter } from 'cesium'
import { CUBE_FACE_WIDTH_KM, WEATHER_BAKE_SEED, WEATHER_EVOLUTION_PERIOD_S, WEATHER_WIND_SPEED_MPS } from './weatherTime'

export const ATLAS_SIZE = 256
export const ATLAS_SLICES = 64

export interface WeatherAtlasPlan {
  evolutionPeriodS: number
  windMps: number
  seed: number
  weatherRepeat: number
  tileKm: number
  usePngFallback: boolean
}

export function resolveWeatherAtlasPlan(options: {
  evolutionHours?: number
  windMps?: number
  seed?: number
  weatherRepeat?: number
  pngFallback?: { width: number; height: number; data: Uint8Array } | undefined
}): WeatherAtlasPlan {
  const weatherRepeat = options.weatherRepeat ?? 100
  return {
    evolutionPeriodS: (options.evolutionHours ?? 5.3) * 3600,
    windMps: options.windMps ?? WEATHER_WIND_SPEED_MPS,
    seed: options.seed ?? WEATHER_BAKE_SEED,
    weatherRepeat,
    tileKm: CUBE_FACE_WIDTH_KM / weatherRepeat,
    usePngFallback: options.pngFallback != null
  }
}

/** seed → 固定采样偏移（u_seedOffset，确定性——同 seed 两次烘焙逐位同图的前提之一）。 */
export function bakeSeedToOffset(seed: number): Cartesian2 {
  const f = (n: number): number => {
    const x = Math.sin(n + 1.951) * 43758.5453
    return x - Math.floor(x)
  }
  return new Cartesian2(f(seed), f(seed * 0.731 + 17.7))
}

export function createWeatherAtlas(options: WeatherAtlasOptions): WeatherAtlas {
  const plan = resolveWeatherAtlasPlan(options)
  if (plan.usePngFallback || options.pngFallback != null) {
    return createPngFallbackAtlas(options.context, options.pngFallback!)
  }
  return bakeAtlas(options.context, plan)
}
```

GL 路径要点（`bakeAtlas`，照抄 `ShadowPass.ts:237-356` 防御）：

1. **无 source 构造**（spec §4.3 BLOCKER 修订——带 source 走 texStorage3D immutable levels=1，generateMipmap 报错）：
```typescript
const atlasTexture = new Texture3D({
  context,                                   // 无 source 字段 → loadNull 可变存储路径
  width: ATLAS_SIZE, height: ATLAS_SIZE, depth: ATLAS_SLICES,
  pixelFormat: PixelFormat.RGBA, pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
  sampler: new Sampler({                     // 先 LINEAR，mip 成功后换 mipmap filter
    wrapS: TextureWrap.REPEAT, wrapT: TextureWrap.REPEAT, wrapR: TextureWrap.REPEAT,
    minificationFilter: TextureMinificationFilter.LINEAR,
    magnificationFilter: TextureMagnificationFilter.LINEAR
  }),
  flipY: false
})
```
   **实现前置验证步**：读 `node_modules/.pnpm/@cesium+engine@*/node_modules/@cesium/engine/Source/Renderer/Texture3D.js` 确认无 source 构造的可行形态（构造签名是否要求 source；若必须 source，则改用 `texImage3D` 手动填充：构造后取 `_texture` 用裸 GL `gl.texImage3D(TEXTURE_3D, 0, RGBA8, 256,256,64, 0, RGBA, UNSIGNED_BYTE, null)` 分配可变存储——两路径都在计划内，以引擎实际 API 为准，验证结论写进代码注释）。
2. 裸 FBO + 逐层渲染：`gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, rawTex, 0, i)`，**每次 attach 前重绑 FBO**（ShadowPass:330-334 同款防御）+ `i===0` 查 `checkFramebufferStatus` + 每次 `drawPass.execute` 前 `syncCesiumFramebufferTracker(context)`。
3. drawPass：全屏 quad（viewport quad 尺寸 256²）+ weatherBake.frag（uniforms：`u_slice = i/64`、`u_seedOffset = bakeSeedToOffset(seed)`）——复用 ShadowPass 的 `defaultCreateDrawPass` 模式（`packages/cesium-clouds/src/ShadowPass.ts` 顶部 import 处可见其来源）。
4. 烘焙完 `gl.generateMipmap(gl.TEXTURE_3D)` → `gl.getError()`：
   - `NO_ERROR` → sampler 换 `LINEAR_MIPMAP_LINEAR`（`atlasTexture.sampler = new Sampler({...})` 或重建 sampler 引用）
   - 非 NO_ERROR → console.warn 降级：sampler 保持 LINEAR（textureLod clamp lod0，spec §4.3 中间档）
5. `dispose()`：destroy Texture3D + `gl.deleteFramebuffer`。
6. `createPngFallbackAtlas`：PNG RGBA data 重复 64 层拼接 `Uint8Array(256*256*64*4)` → **带 source 构造**（immutable 也可，escape 路径 sampler=LINEAR——textureLod 对非 mipmap filter 纹理 clamp 到 lod0，WebGL2 规范行为；注释说明）。

- [ ] **Step 4: 跑测试确认通过 + 全套件回归**

Run: `cd packages/cesium-clouds && npx vitest run src/WeatherAtlas.test.ts && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cesium-clouds/src/WeatherAtlas.ts packages/cesium-clouds/src/WeatherAtlas.test.ts
git commit -m "feat(clouds): WeatherAtlas——无 source 构造 Texture3D+裸 FBO 逐层烘焙+3D mip 降级链+PNG-3D 包装（红队 BLOCKER-3 修订）"
```

---

### Task 6: CloudsPass / createCloudsStage 集成

**Files:**
- Modify: `packages/cesium-clouds/src/CloudsPass.ts`（uniformMap + options）
- Modify: `packages/cesium-clouds/src/createCloudsStage.ts`（Atlas 创建接入 + 烘焙输入 options + altitudeOffset 应用 + 预设热切）
- Modify: `packages/cesium-clouds/src/cloudsDefaultParameters.ts`（新增 `u_windOffset` 等 state 字段说明——值经 preRender 每帧覆写）
- Test: `packages/cesium-clouds/src/createCloudsStage.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 2 `packLayerUniforms/applyAltitudeOffset`、Task 5 `createWeatherAtlas/resolveWeatherAtlasPlan`
- Produces:
  - `CloudsStageOptions` 新字段：`altitudeOffsetM?: number`（默认 0）、`weatherBake?: { evolutionHours?: number; windMps?: number; seed?: number; weatherRepeat?: number }`、`atlasDisabled?: boolean`（escape）
  - `CloudsPassFrameState` 新字段：`windOffset: Cartesian2`、`atlasT: number`、`itczCenterSin: number`、`climateBands: number`（preRender 每帧按 scene.time 覆写——Task 1 函数）
  - uniformMap 新增：`weatherAtlasTexture / u_windOffset / u_atlasT / u_itczCenterSin / u_climateBands`

- [ ] **Step 1: 写失败测试（options 合并与 state 覆写逻辑）**

```typescript
// createCloudsStage.test.ts 增用例（文件已有 mock 模式，跟随现有 fake scene/context 写法）
describe('WeatherAtlas 集成（spec §6）', () => {
  it('altitudeOffsetM 经 packLayerUniforms 应用到 params（红队 BLOCKER-4 链路）', () => {
    // 以 buildImpl 可观察行为断言：params.minHeight = 750+offset
    // 具体断言形态跟随本文件现有 uniformMap 检查模式（读取传入 createCloudsPass 的参数对象）
  })
  it('atlasDisabled=true 时不创建 Atlas、走 pngFallback 包装路径', () => { /* 同上模式 */ })
  it('preRender 覆写 state.atlasT/windOffset（scene.time 驱动）', () => { /* 以 fake time 断言闭包值 */ })
})
```

（断言实体在实施时对齐 `createCloudsStage.test.ts` 既有 fake 基建——该文件已 mock scene/PostProcessStage，有取 uniformMap 闭包现值的手法。）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现集成**

`createCloudsStage.ts` buildImpl 内：

```typescript
// ── WeatherAtlas（spec §4）：烘焙或 PNG 包装；escape= atlasDisabled ──
const bakePlanOptions = options.atlasDisabled
  ? { pngFallback: weatherPngForFallback }          // escape：旧静态图包装
  : { ...options.weatherBake, pngFallback: weatherPngForFallback }
const atlas = createWeatherAtlas({ context: scene.context as any, ...bakePlanOptions })
```

`weatherPngForFallback` 来自 `weather.localWeather`——`loadWeatherTextures` 已产出 2D Texture；为取像素拼 3D 包装，`loadWeatherTextures` 增加可选返回原始 decode 数据：签名扩展 `loadWeatherTextures(context, baseUrl): Promise<WeatherTextures & { localWeatherRaw?: { width; height; data: Uint8Array } }>`（decode 成功时带上原始 RGBA，供 Atlas fallback 包装；2D Texture 字段保留不动——shadow 等其他消费端零改动）。

`preRender` 监听器内（已有 sunDirection 更新处）：

```typescript
// ── 云图时间轴（spec §4.1）：CPU float64 mod 后传 uniform ──
const tSec = JulianDate.secondsDifference(time, JulianDate.fromIso8601('2000-01-01T12:00:00Z'))
const g = JulianDate.toGregorianDate(time)
state.dayOfYear = computeDayOfYear(g.month, g.day)
state.atlasT = computeEvolutionTNorm(tSec + evolutionPhaseOverride, atlas.plan.evolutionPeriodS)
state.windOffset = computeWindOffsetTiles(tSec + evolutionPhaseOverride, atlas.plan.windMps, atlas.plan.tileKm)
state.itczCenterSin = Math.sin((computeItczCenterLatDeg(state.dayOfYear) * Math.PI) / 180)
// evolutionPhaseOverride = options 调试钩子（?cloudsEvolutionPhase=，秒偏移，仅影响演化/平流不动太阳）
```

`CloudsPass.ts` uniformMap（`:439` 处 map 里加）：

```typescript
weatherAtlasTexture: () => state.atlasTexture,   // Atlas 创建时注入（pngFallback 同型）
u_windOffset: () => state.windOffset,
u_atlasT: () => state.atlasT,
u_itczCenterSin: () => state.itczCenterSin,
u_climateBands: () => params.climateBands,       // 热切：预设激活时 clamp 逻辑在 setter
```

altitudeOffset 应用（buildImpl 内，替换 defaults 里写死的层 packed）：

```typescript
import { applyAltitudeOffset, packLayerUniforms, DEFAULT_CLOUD_LAYERS } from './cloudLayersPacking'
const layerUniforms = packLayerUniforms(applyAltitudeOffset(DEFAULT_CLOUD_LAYERS, options.altitudeOffsetM ?? 0))
// merge 进 params：minLayerHeights/maxLayerHeights/min/maxIntervalHeights/minHeight/maxHeight/
// shadowTop/BottomHeight/shadowLayerMask/densityScales/...（15 项——Task 2 PackedLayerUniforms 全集）
```

预设热切（`handle` 上新增）：

```typescript
setWeatherPreset(preset: 'clear' | 'fair' | 'cloudy' | 'overcast' | undefined): void {
  const PRESETS = {
    clear:    { coverage: 0.08, filterScale: 1.0 },
    fair:     { coverage: 0.2,  filterScale: 1.0 },
    cloudy:   { coverage: 0.45, filterScale: 1.0 },
    overcast: { coverage: 0.65, filterScale: 0.6 }  // filterScale 收窄 coverageFilterWidths→连片
  } as const
  // 写 state.params（闭包引用改值即生效，nightAmbient 同款）；
  // 激活时 climateBandsFloor=0.6（spec §5.4 组合语义：shader 侧 band 下限 clamp 由
  // u_climateBands 配对实现——改传 u_climateBandsFloor 或 CPU 侧折算，二选一在实现时定，
  // 单测断言预设后 params.coverage 值与 floor 生效）
}
```

- [ ] **Step 4: 跑测试 + 全套件** → PASS 后 Commit

```bash
git add -A packages/cesium-clouds
git commit -m "feat(clouds): createCloudsStage/CloudsPass 集成 WeatherAtlas——时间轴 preRender 驱动+altitudeOffset 派生链+天气预设热切+escape 开关"
```

---

### Task 7: demo URL 参数 + 时钟 + README

**Files:**
- Modify: `apps/demo/src/main.ts`（URL 参数注入 + `?play`/`?speed` 时钟 + 预设解析）
- Modify: `README.md`（参数表）

**Interfaces:**
- Consumes: Task 6 全部 options/state
- Produces: URL 参数全集（见 spec §6）

- [ ] **Step 1: main.ts 时钟段（viewer 创建后）**

```typescript
// ?play=1 → clock.shouldAnimate + multiplier=?speed=（默认 60；spec §6.1——默认态时钟
// 冻结属 Cesium 现状语义，演化演示经此开关；确定性验收用 ?time= 钉死不受影响）
if (getBool('play')) {
  viewer.clock.shouldAnimate = true
  viewer.clock.multiplier = getNumber('speed') ?? 60
}
```

- [ ] **Step 2: clouds options 注入段（:557 createCloudsStage 调用处）**

```typescript
const cloudsWeatherPreset = getString('cloudsWeather') as 'clear'|'fair'|'cloudy'|'overcast'|null
const cloudsHandle = createCloudsStage(scene, luts, weather, {
  clouds: true,
  // …现有参数透传不动…
  // ── 云分布重设计（spec §6）──
  ...(getNumber('cloudsCoverage') != null ? { /* 走 parameters.coverage */ } : {}),
  ...(getNumber('cloudsAltitudeOffset') != null
    ? { altitudeOffsetM: getNumber('cloudsAltitudeOffset')! } : {}),
  ...(cloudsWeatherPreset != null ? { weatherPreset: cloudsWeatherPreset } : {}),
  ...(getNumber('cloudsClimateBands') != null
    ? { parameters: { climateBands: getNumber('cloudsClimateBands')! } } : {}),
  ...(getNumber('cloudsEvolutionHours') != null || getNumber('cloudsWind') != null
      || getNumber('cloudsSeed') != null || getNumber('cloudsWeatherRepeat') != null
    ? { weatherBake: {
        ...(getNumber('cloudsEvolutionHours') != null ? { evolutionHours: getNumber('cloudsEvolutionHours')! } : {}),
        ...(getNumber('cloudsWind') != null ? { windMps: getNumber('cloudsWind')! } : {}),
        ...(getNumber('cloudsSeed') != null ? { seed: getNumber('cloudsSeed')! } : {}),
        ...(getNumber('cloudsWeatherRepeat') != null ? { weatherRepeat: getNumber('cloudsWeatherRepeat')! } : {})
      } } : {}),
  ...(getNumber('cloudsEvolutionPhase') != null
    ? { evolutionPhaseS: getNumber('cloudsEvolutionPhase')! } : {}),
  ...(getString('cloudsAtlas') === '0' ? { atlasDisabled: true } : {})
})
// 预设在创建后热切（创建时统一走 setWeatherPreset，保证 band floor 逻辑单一路径）
if (cloudsWeatherPreset != null) cloudsHandle.setWeatherPreset(cloudsWeatherPreset)
```

（注意 `weatherPreset` 需加进 CloudsStageOptions 并在 buildImpl 末尾等价调用 setWeatherPreset——与 handle 方法共用同一函数；具体形态以 Task 6 实现为准，保持一条代码路径。）

- [ ] **Step 3: README 参数表追加**（在现有 clouds 参数块后）：

```markdown
| `?cloudsCoverage=` | 云密度 0-1（默认 0.3） |
| `?cloudsAltitudeOffset=` | 低云带升降（米，clamp -500..+3000，默认 0） |
| `?cloudsWeather=` | 天气预设 clear\|fair\|cloudy\|overcast |
| `?cloudsClimateBands=` | 纬度气候带强度（0=关，默认 1） |
| `?cloudsEvolutionHours=` | 云图演化环周期（小时，默认 5.3） |
| `?cloudsWind=` | 平流风速 m/s（默认 8） |
| `?cloudsSeed=` | 烘焙种子（默认 1337） |
| `?cloudsWeatherRepeat=` | 云图平铺（默认 100） |
| `?cloudsEvolutionPhase=` | 演化相位偏移秒（调试，不动太阳） |
| `?cloudsAtlas=0` | 逃生门：旧静态云图 |
| `?play=1&speed=N` | 时钟走动（默认冻结；speed 默认 60） |
```

- [ ] **Step 4: demo tsc + 全套件 + Commit**

```bash
cd apps/demo && npx tsc --noEmit && cd ../..
pnpm --filter @cesium-geospatial/cesium-clouds test
git add -A && git commit -m "feat(demo): 云分布参数 URL 全集+?play 时钟开关+README"
```

---

### Task 8: 验收（playwright headed + 像素量化）

**Files:**
- Create: `apps/demo/scripts/verify-clouds-distribution.mjs`（模式参照 memory `fade-verify.mjs`：pngjs 十段 rows diff）

**Interfaces:**
- Consumes: Task 7 全部 URL
- Produces: 验收记录（写入 commit message 与最终报告）

- [ ] **Step 1: 清缓存起服务**

```bash
pkill -f vite; rm -rf apps/demo/node_modules/.vite; cd <worktree 根> && pnpm dev &  # 后台
```

- [ ] **Step 2: 冒烟组（headless GL 读回可信）**

- 烘焙冒烟：headless 打开 `?clouds=1&time=2026-09-03T06:00:00Z`，console 无 GL 报错、mip 降级 warn（若有）记录——**画面不判**（SwiftShader 不可信铁律）
- 编译/加载错误零容忍

- [ ] **Step 3: headed 对照组（每项同批成对、agent-browser 每组 close 重开）**

| 项 | URL 对 |
|----|--------|
| 默认态演化 | `?clouds=1&play=1` 静置 0/5min 截图 diff——云形可见变化 |
| 演化归因 | `?clouds=1&time=T&cloudsEvolutionPhase=0` vs `=1800`——云形变化且太阳不动 |
| 回绕 | evolutionPhase=0 vs =19070（近环尾）vs =19080(=0) 无跳变 |
| 确定性 | 同 URL 双 tab（钉 ?time）各截 3 帧 diff≈0（FPS mask） |
| 去壁纸 | `?cloudsAtlas=0` vs 默认，全球远观（camera 远距）对照 |
| 气候带 | 赤道/25°/50° 三视角 + `cloudsClimateBands=0` 对照；7 月 vs 2 月 ITCZ |
| 白环防护 | 50° 视角 `cloudsClimateBands=1.5` 极限档非云像素占比读数 |
| 预设 | 四档 `cloudsWeather=` 各截图；overcast×副热带（band floor） |
| 高度 | `cloudsAltitudeOffset=-500/0/+3000` 三档（侧面视角看云底） |
| 逃生门 | `cloudsAtlas=0` 可用、行为=旧图 |
| 帧率 | 既有基线场景 + 运动中（BSM re-march）+ low/ultra，成对录制 |

- [ ] **Step 4: 发现问题回修**（调 band 权重/evolveRadius 等——改 GPU uniform 常量走热切组不重烘；改烘焙常量重烘验证）

- [ ] **Step 5: 验收记录 Commit**

```bash
git add apps/demo/scripts/verify-clouds-distribution.mjs
git commit -m "test(clouds): 云分布重设计验收脚本+记录（逐项结果入 message）"
```

---

### Task 9: 收尾——memory + 最终全套件

- [ ] 全套件：`pnpm -r test`（core+clouds+demo 全绿）+ `tsc --noEmit` 全仓
- [ ] memory 更新 `clouds-distribution-redesign.md`：实现完成 commit 列表、验收数据、调参终值（band 权重/evolveRadius/预设值实测拍板记录）
- [ ] 最终报告（合并哪些 commit、遗留项）

## Self-Review 记录

- **Spec 覆盖**：§4.1→T1/T6、§4.3→T5、§4.4→T5/T6、§4.5→T1/T5、§5.1→T3、§5.2→T3、§5.3→T1/T4、§5.4→T4/T1、§6.1→T6/T7、§6.2→T6/T7、§6.3→T2/T6、§7→T4/T8、§8→T8、§9 决策已体现在各处常量。无缺口。
- **占位符扫描**：T6 Step1 测试代码标注「断言实体在实施时对齐既有 fake 基建」——这是对既有测试基建的引用而非逻辑占位（fake 基建是该文件已有代码，实施者 Read 即得）；T5 Texture3D 无 source 构造标注「两条路径以引擎实际 API 为准」——已给双路径与裁决规则，非 TBD。
- **类型一致性**：`computeEvolutionTNorm/computeWindOffsetTiles/computeDayOfYear/computeItczCenterLatDeg`（T1 定义=T4/T6 消费）；`packLayerUniforms/applyAltitudeOffset/DEFAULT_CLOUD_LAYERS`（T2=T6）；`resolveWeatherAtlasPlan/bakeSeedToOffset/ATLAS_SIZE/ATLAS_SLICES`（T5=T6）；`sampleWeather(uv, position, height, mipLevel)`（T4 三调用点一致）。
