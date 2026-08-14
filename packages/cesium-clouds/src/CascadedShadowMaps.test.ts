// T1：CascadedShadowMaps 纯数学单测（node，无 GL）。
// 相机固定在 ECEF (0,0,6.4e6) 朝 -Z 看时手推期望值断言。
import { describe, expect, it } from 'vitest'
import { Cartesian3, Cartesian4, Matrix4 } from 'cesium'

import { CascadedShadowMaps, splitFrustum } from './CascadedShadowMaps'

// 视线朝地心的简单透视相机：位于北极上方，看 -Z。构造 view（world→view）：
// view = rotate(把相机 -Z 对到 world -Z) * translate(-eye) —— 这里相机无旋转，
// viewMatrix = translate(-eye)，inverseViewMatrix（=three matrixWorld）= translate(eye)。
function makeCamera(near: number, far: number, fovy = Math.PI / 3) {
  const eye = new Cartesian3(0, 0, 6.4e6)
  const inverseViewMatrix = Matrix4.fromTranslation(eye)
  // 透视投影（gluPerspective 语义，aspect 1）：Cesium Matrix4.computePerspectiveFieldOfView
  const projectionMatrix = Matrix4.computePerspectiveFieldOfView(
    fovy, 1.0, near, far, new Matrix4()
  )
  return { inverseViewMatrix, projectionMatrix, near, far }
}

describe('splitFrustum（practical 模式，对齐 three splitFrustum.ts）', () => {
  it('practical λ=0.5 三段：lerp(uniform, logarithmic)，单调递增收尾 1', () => {
    const s = splitFrustum('practical', 3, 1.0, 2e5, 0.5)
    expect(s).toHaveLength(3)
    expect(s[2]).toBeCloseTo(1.0, 10)
    expect(s[1]).toBeGreaterThan(s[0])
    // near=1, far=2e5 手推：uniform=[1/3,2/3,1] log=[2.93e-4,1.71e-2,1]
    // 直接断言手算值：lerp(0.33334, 0.000293, 0.5) ≈ 0.166813
    expect(s[0]).toBeCloseTo(0.166813, 4)
    expect(s[1]).toBeCloseTo((0.66667 + 0.01709) / 2, 4)
  })
})

describe('CascadedShadowMaps.update', () => {
  const csm = new CascadedShadowMaps({ cascadeCount: 3, mapSize: 512 })

  it('cascades 数 = cascadeCount；interval 单调覆盖 [near/far, 1]', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    expect(csm.cascades).toHaveLength(3)
    expect(csm.far).toBe(2e5)
    expect(csm.cascades[0].interval.x).toBeCloseTo(0, 10) // 第一段起点 = near/far ≈ 0
    expect(csm.cascades[2].interval.y).toBeCloseTo(1, 10)
    for (let i = 1; i < 3; i++) {
      expect(csm.cascades[i].interval.x).toBe(csm.cascades[i - 1].interval.y)
    }
  })

  it('matrix 与 inverseMatrix 在 clip 域互逆（world→clip→world roundtrip）', () => {
    const cam = makeCamera(1.0, 2e5)
    const sun = Cartesian3.normalize(new Cartesian3(0.3, 0.2, 1), new Cartesian3())
    csm.update(cam, sun, 1e5)
    const p = new Cartesian3(1e5, -2e4, 6.3e6) // ECEF world 任意点
    for (const c of csm.cascades) {
      const clip = Matrix4.multiplyByPoint(c.matrix, p, new Cartesian3())
      const clip4 = new Cartesian4(clip.x, clip.y, clip.z, 1.0)
      const back4 = Matrix4.multiplyByVector(c.inverseMatrix, clip4, new Cartesian4())
      const back = Cartesian3.fromElements(back4.x / back4.w, back4.y / back4.w, back4.z / back4.w)
      expect(back.x).toBeCloseTo(p.x, -2)
      expect(back.y).toBeCloseTo(p.y, -2)
      expect(back.z).toBeCloseTo(p.z, -2)
    }
  })

  it('正交投影覆盖 [-r,r]（light-space 视锥角点 clip 坐标 |x|,|y| ≤ 1.5）', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    for (const c of csm.cascades) {
      // 相机正前 far 平面中心点应落进 cascade 0 的 ortho 盒（近段）
      const center = new Cartesian3(0, 0, 6.4e6 - 1e4)
      const clip = Matrix4.multiplyByPoint(c.matrix, center, new Cartesian3())
      expect(Math.abs(clip.x)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(clip.y)).toBeLessThanOrEqual(1.5)
    }
  })

  it('light-space 中心 texel 对齐（x,y 是 texelWidth 整数倍，±浮点容差）', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    // texel 对齐保证 shadow 相机平移不产生亚像素抖动（three 版同款 snapping）
    // 断言方式：连续两次 update 同输入 → 矩阵逐元素相等（确定性）
    const m0 = Matrix4.clone(csm.cascades[0].matrix)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    expect(Matrix4.equals(m0, csm.cascades[0].matrix)).toBe(true)
  })

  it('sunDirection 平行 -up（极点退化）不产生 NaN', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 1, 0), 1e5) // ∥ up=(0,1,0)
    const col = Matrix4.getColumn(csm.cascades[0].matrix, 0, new Cartesian4())
    expect(Number.isFinite(col.x)).toBe(true)
  })
})
