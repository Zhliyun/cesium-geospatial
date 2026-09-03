// WeatherAtlas 单测（T5）——纯逻辑部分。
// GL 路径（无 source Texture3D 构造/裸 FBO 逐层烘焙/mip 链）不可 node 单测，
// 留 T8 playwright 冒烟覆盖（不写假 GL mock）。
import { describe, expect, it } from 'vitest'
import {
  ATLAS_SIZE,
  ATLAS_SLICES,
  bakeSeedToOffset,
  createWeatherAtlas,
  resolveWeatherAtlasPlan,
  tilePngLayers,
  type WeatherAtlas,
  type WeatherAtlasDispatchDeps,
  type WeatherPngFallback
} from './WeatherAtlas'

describe('WeatherAtlas 计划解析（spec §4/§6.2）', () => {
  it('尺寸常量：256²×64', () => {
    expect(ATLAS_SIZE).toBe(256)
    expect(ATLAS_SLICES).toBe(64)
  })

  it('默认计划：5.3h/8mps/seed1337/repeat400/非 fallback', () => {
    const plan = resolveWeatherAtlasPlan({})
    expect(plan.evolutionPeriodS).toBeCloseTo(5.3 * 3600, 0)
    expect(plan.windMps).toBe(8)
    expect(plan.seed).toBe(1337)
    expect(plan.weatherRepeat).toBe(400)
    expect(plan.usePngFallback).toBe(false)
  })

  it('pngFallback 仅兜底材料——不触发分派开关（T8 CRITICAL 回归锁定）', () => {
    const plan = resolveWeatherAtlasPlan({
      pngFallback: { width: 1, height: 1, data: new Uint8Array(4) }
    })
    // 旧语义 usePngFallback=true 使 T6 无条件传参时 bakeAtlas 死代码（demo 恒旧静态图）；
    // 新语义（spec §4.4「烘焙异常时才降级」）：pngFallback=兜底材料，分派开关只有 usePngFallback。
    expect(plan.usePngFallback).toBe(false)
  })

  it('usePngFallback 显式 escape 开关透传', () => {
    expect(resolveWeatherAtlasPlan({ usePngFallback: true }).usePngFallback).toBe(true)
    expect(resolveWeatherAtlasPlan({}).usePngFallback).toBe(false)
  })

  it('tileKm = 赤道周长 / 经向 repeat（经纬域语义，方案 A 2026-09-03）', () => {
    expect(resolveWeatherAtlasPlan({ weatherRepeat: 400 }).tileKm).toBeCloseTo(
      40075.017 / 400,
      3
    )
  })

  it('显式覆盖：evolutionHours/windMps/seed/weatherRepeat 透传', () => {
    const plan = resolveWeatherAtlasPlan({
      evolutionHours: 2,
      windMps: 3,
      seed: 42,
      weatherRepeat: 50
    })
    expect(plan.evolutionPeriodS).toBe(2 * 3600)
    expect(plan.windMps).toBe(3)
    expect(plan.seed).toBe(42)
    expect(plan.weatherRepeat).toBe(50)
    expect(plan.tileKm).toBeCloseTo(40075.017 / 50, 3)
  })
})

describe('bakeSeedToOffset（u_seedOffset 确定性，spec §4.5）', () => {
  it('确定性：同 seed 同偏移、[0,1) 域', () => {
    const a = bakeSeedToOffset(1337)
    const b = bakeSeedToOffset(1337)
    expect(a.x).toBe(b.x)
    expect(a.y).toBe(b.y)
    expect(a.x).toBeGreaterThanOrEqual(0)
    expect(a.x).toBeLessThan(1)
    expect(a.y).toBeGreaterThanOrEqual(0)
    expect(a.y).toBeLessThan(1)
    expect(bakeSeedToOffset(1338).x).not.toBe(a.x) // 不同 seed 不同图
  })

  it('默认 seed 1337 避开频率网格点与整数平移（评审交接注记）', () => {
    const o = bakeSeedToOffset(1337)
    // 烘焙域 Worley 整频 freq∈{8,16,32,64,128}：格点为 1/freq——1/8=16/128、1/16=8/128、
    // 1/32=4/128、1/64=2/128、1/128=1/128，全部是 1/128 的整数倍 ⇒ x*128∉ℤ 一条断言
    // 覆盖 freq≤128 全部格点（×16 探不到 1/32、1/64、1/128 的奇数格点，如 x=1/32 时
    // x*16=0.5 非整）。偏移落在格点上会使 p+seedOffset 与未偏移域逐位对齐（偏移失效、
    // 种子不可分辨）。
    expect((o.x * 128) % 1).not.toBe(0)
    expect((o.y * 128) % 1).not.toBe(0)
    // 非整数：排除 bakePoint.z 的整数平移（z 向整数平移对整频域不可见）
    expect(o.x % 1).not.toBe(0)
    expect(o.y % 1).not.toBe(0)
  })

  it('多 seed 抽查均避开网格点（覆盖用户可传任意 seed 的鲁棒性）', () => {
    for (const seed of [1338, 1, 42, 99991]) {
      const o = bakeSeedToOffset(seed)
      expect((o.x * 128) % 1).not.toBe(0)
      expect((o.y * 128) % 1).not.toBe(0)
    }
  })
})

describe('tilePngLayers（PNG fallback 平铺纯逻辑）', () => {
  it('slices 层 z-major 连续，每层逐字节等于源图', () => {
    const data = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
    ]) // 2×2 RGBA
    const out = tilePngLayers({ width: 2, height: 2, data }, 3)
    expect(out).toHaveLength(2 * 2 * 3 * 4)
    const layerBytes = 2 * 2 * 4
    for (let i = 0; i < 3; i++) {
      expect(Array.from(out.slice(i * layerBytes, (i + 1) * layerBytes))).toEqual(
        Array.from(data)
      )
    }
  })

  it('64 层产出独立缓冲，不改源 data（texImage3D 源安全）', () => {
    const data = new Uint8Array([7, 7, 7, 255])
    const out = tilePngLayers({ width: 1, height: 1, data }, 64)
    expect(out).toHaveLength(64 * 4)
    expect(out[63 * 4]).toBe(7)
    expect(Array.from(data)).toEqual([7, 7, 7, 255])
  })

  it('data 长度与 width×height×4 不符时抛错（防御坏 PNG）', () => {
    expect(() =>
      tilePngLayers({ width: 2, height: 2, data: new Uint8Array(3) }, 64)
    ).toThrow()
  })
})

describe('createWeatherAtlas 分派双语义（T8 CRITICAL 修复回归锁定）', () => {
  // 注入层 stub（ShadowPass createDrawPass 注入同款模式）——分派逻辑 node 可测，
  // 真实现（bakeAtlas/createPngFallbackAtlas）不触碰 fakeContext。
  const PNG: WeatherPngFallback = { width: 1, height: 1, data: new Uint8Array(4) }
  const fakeContext = {} as never
  const fakeAtlas = (mode: WeatherAtlas['mode']): WeatherAtlas => ({
    atlasTexture: {} as never,
    mode,
    plan: resolveWeatherAtlasPlan({}),
    dispose: () => {}
  })

  it('pngFallback 提供不再短路分派：先尝试烘焙，成功 → baked', () => {
    let bakeCalls = 0
    const atlas = createWeatherAtlas(
      { context: fakeContext, pngFallback: PNG },
      {
        bake: () => {
          bakeCalls++
          return fakeAtlas('baked')
        },
        createFallback: () => {
          throw new Error('烘焙成功不应走兜底')
        }
      }
    )
    // 旧 bug 分派下 bakeCalls=0（pngFallback 短路 → 恒 fallback）——本断言即死代码探测器
    expect(bakeCalls).toBe(1)
    expect(atlas.mode).toBe('baked')
  })

  it('烘焙失败 → pngFallback 兜底（spec §4.4「烘焙异常时才降级」）', () => {
    const atlas = createWeatherAtlas(
      { context: fakeContext, pngFallback: PNG },
      {
        bake: () => {
          throw new Error('GLSL 编译失败')
        },
        createFallback: (_ctx, png) => {
          expect(png).toBe(PNG)
          return fakeAtlas('pngFallback')
        }
      }
    )
    expect(atlas.mode).toBe('pngFallback')
  })

  it('烘焙失败且无 pngFallback → rethrow 原异常', () => {
    expect(() =>
      createWeatherAtlas(
        { context: fakeContext },
        {
          bake: () => {
            throw new Error('烘焙原异常')
          },
          createFallback: () => {
            throw new Error('无兜底材料不应走 fallback')
          }
        } satisfies WeatherAtlasDispatchDeps
      )
    ).toThrow('烘焙原异常')
  })

  it('usePngFallback 显式 escape（?cloudsAtlas=0）：跳过烘焙直接包装', () => {
    let fallbackCalls = 0
    const atlas = createWeatherAtlas(
      { context: fakeContext, usePngFallback: true, pngFallback: PNG },
      {
        bake: () => {
          throw new Error('escape 路径不应烘焙')
        },
        createFallback: () => {
          fallbackCalls++
          return fakeAtlas('pngFallback')
        }
      }
    )
    expect(fallbackCalls).toBe(1)
    expect(atlas.mode).toBe('pngFallback')
  })
})
