import { describe, it, expect } from 'vitest'
import { modulateMoonPixels } from './moonTexture'

// 月面合成的纯函数部分：只在 Node 里跑像素数组，不碰 canvas/Cesium 值类型。
// 算法照搬 demo 内联合成（apps/demo/src/main.ts 2026-08-30 月面纹理任务）：
// 以位移图亮度均值为中心做对比度拉伸 mod = clamp(1 + (dispLum − dispMean)·s·K, 0.05, 2)。

describe('modulateMoonPixels', () => {
  it('以位移亮度均值为中心调制，均值处不变', () => {
    const base = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255])
    const disp = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255])
    const { mean } = modulateMoonPixels(base, disp, 1, 4)
    expect([...base]).toEqual([100, 100, 100, 255, 100, 100, 100, 255])
    expect(mean).toBeCloseTo(100 / 255, 10)
  })

  it('正偏差变亮、负偏差变暗（位移均值 0.5，s=1、K=4）', () => {
    // 位移两像素 255 与 0 → dmean = 0.5
    // 正偏差：mod = 1 + (1−0.5)·4 = 3 → 钳到 2 → 100×2 = 200
    // 负偏差：mod = 1 + (0−0.5)·4 = −1 → 钳到 0.05 → 100×0.05 = 5
    const base = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255])
    const disp = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255])
    modulateMoonPixels(base, disp, 1, 4)
    expect(base[0]).toBe(200)
    expect(base[1]).toBe(200)
    expect(base[2]).toBe(200)
    expect(base[4]).toBe(5)
    expect(base[5]).toBe(5)
    expect(base[6]).toBe(5)
  })

  it('调制倍率钳制在 [0.05, 2]（对比度拉伸无低高程爆负）', () => {
    // s=100 极端放大：正偏差仍只能 ×2（255×2 再按通道钳到 255）；
    // 负偏差只能 ×0.05（255×0.05 = 12.75 → Uint8ClampedArray 取整 13）。
    const base = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255])
    const disp = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255])
    modulateMoonPixels(base, disp, 100, 4)
    expect(base[0]).toBe(255)
    expect(base[4]).toBe(13)
  })

  it('scale 为 0 时跳过调制，但仍返回 base 均值', () => {
    const base = new Uint8ClampedArray([10, 20, 30, 255])
    const disp = new Uint8ClampedArray([255, 255, 255, 255])
    const { mean } = modulateMoonPixels(base, disp, 0)
    expect([...base]).toEqual([10, 20, 30, 255])
    expect(mean).toBeCloseTo(20 / 255, 10)
  })

  it('只改 RGB，alpha 原样保留', () => {
    const base = new Uint8ClampedArray([100, 100, 100, 17, 100, 100, 100, 99])
    const disp = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255])
    modulateMoonPixels(base, disp, 1, 4)
    expect(base[3]).toBe(17)
    expect(base[7]).toBe(99)
  })

  it('返回合成后均值（0–1，RGB 平均 / 255）', () => {
    const base = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    const disp = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255])
    const { mean } = modulateMoonPixels(base, disp, 1, 4)
    expect(mean).toBeCloseTo(0.5, 10)
  })

  it('位移图与颜色图像素长度不一致时抛 RangeError（避免静默 NaN）', () => {
    const base = new Uint8ClampedArray([100, 100, 100, 255])
    const disp = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255])
    expect(() => modulateMoonPixels(base, disp, 1, 4)).toThrow(RangeError)
  })
})
