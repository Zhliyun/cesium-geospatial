// temporalMath.test.ts
//
// M4 T1：temporal 数学单测——bayer 表逐字对齐 three bayer.ts；jitter 量纲（低分 UV）；
// reprojection 矩阵三性质（jitter 进 prevP 的 column2.xy、首帧 fallback 当前、
// viewReprojection = (jitteredPrevP*prevV)*inverseView）。

import { describe, expect, it } from 'vitest'
import { Cartesian2, Cartesian3, Cartesian4, Matrix3, Matrix4 } from 'cesium'

import {
  bayerIndices,
  bayerOffsets,
  computeTemporalJitter,
  buildReprojectionMatrices,
  type TemporalCameraSnapshot
} from './temporalMath'

// 测试 helper：透视投影矩阵（near/far 域，标准列主序）——避免依赖 Cesium PerspectiveFrustum
// （它有额外 getter 行为）。列主序：col0=(f/aspect,0,0,0) col1=(0,f,0,0)
// col2=(0,0,(far+near)/(near-far),-1) col3=(0,0,2*far*near/(near-far),0)
class PerspectiveFrustumP {
  readonly m: Matrix4
  constructor(fovY: number, aspect: number, near: number, far: number) {
    const f = 1 / Math.tan(fovY / 2)
    this.m = new Matrix4(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0
    )
  }
  get projectionMatrix(): Matrix4 {
    return this.m
  }
}

describe('M4 T1 temporalMath', () => {
  it('bayerIndices 逐字对齐 three bayer.ts（4×4 序列）', () => {
    expect(bayerIndices).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5])
  })

  it('bayerOffsets：index i 的 offset = 值为 i 的格中心（three 同款反查）', () => {
    expect(bayerOffsets).toHaveLength(16)
    // bayerIndices[5] = 4 → offset[4] 在格 (5%4, floor(5/4)) = (1,1) 中心 →
    // ((1+0.5)/4, (1+0.5)/4) = (0.375, 0.375)
    expect(bayerOffsets[4].x).toBeCloseTo(0.375)
    expect(bayerOffsets[4].y).toBeCloseTo(0.375)
    // bayerIndices[0] = 0 → 格 (0,0) 中心 (0.125, 0.125)
    expect(bayerOffsets[0].x).toBeCloseTo(0.125)
    expect(bayerOffsets[0].y).toBeCloseTo(0.125)
  })

  it('computeTemporalJitter：frame 0 低分 480×270 → ±半低分 texel 内（three CloudsMaterial:342-344 等价）', () => {
    const j = computeTemporalJitter(0, 480, 270, new Cartesian2())
    // offset[0]=(0.125,0.125) → dx=(0.125-0.5)/480
    expect(j.x).toBeCloseTo(-0.375 / 480)
    expect(j.y).toBeCloseTo(-0.375 / 270)
  })

  it('buildReprojectionMatrices：jitter 写入 prevP column2.xy（×2，NDC 域 [-1,1]）且 viewReprojection 链式正确', () => {
    const prevV = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationZ(0.3),
      new Cartesian3(100, 200, 300)
    )
    const prevP = new PerspectiveFrustumP(0.5, 1.5, 10, 1e6).projectionMatrix
    const prev: TemporalCameraSnapshot = { viewMatrix: prevV, projectionMatrix: prevP }

    const curV = Matrix4.fromRotationTranslation(
      Matrix3.fromRotationZ(0.31),
      new Cartesian3(110, 205, 299)
    )
    const curInvV = Matrix4.inverse(curV, new Matrix4())
    const curP = Matrix4.clone(prevP)

    const jitter = new Cartesian2(0.001, -0.002)
    const reprojectionMatrix = new Matrix4()
    const viewReprojectionMatrix = new Matrix4()
    buildReprojectionMatrices(prev, curV, curP, curInvV, jitter, {
      reprojectionMatrix,
      viewReprojectionMatrix
    })

    // 性质 1：reprojection = (prevP + jitter) * prevV —— 用列分量验证 jitter 已进 column2
    const expected = Matrix4.clone(prevP)
    const col = Matrix4.getColumn(expected, 2, new Cartesian4())
    col.x += jitter.x * 2
    col.y += jitter.y * 2
    Matrix4.setColumn(expected, 2, col, expected)
    Matrix4.multiply(expected, prevV, expected)
    expect(reprojectionMatrix).toEqual(expected)

    // 性质 2：viewReprojection = reprojection * currentInverseView
    const expected2 = Matrix4.multiply(
      reprojectionMatrix,
      curInvV,
      new Matrix4()
    )
    expect(viewReprojectionMatrix).toEqual(expected2)
  })

  it('buildReprojectionMatrices：首帧 previous=undefined → fallback 当前 P/V（velocity=0，three 同款）', () => {
    const curV = Matrix4.fromRotationTranslation(
      Matrix3.IDENTITY,
      new Cartesian3(0, 0, 0)
    )
    const curInvV = Matrix4.inverse(curV, new Matrix4())
    const curP = new PerspectiveFrustumP(0.5, 1.5, 10, 1e6).projectionMatrix
    const jitter = new Cartesian2(0.01, 0.01)
    const reprojectionMatrix = new Matrix4()
    const viewReprojectionMatrix = new Matrix4()
    buildReprojectionMatrices(undefined, curV, curP, curInvV, jitter, {
      reprojectionMatrix,
      viewReprojectionMatrix
    })
    // jittered curP * curV
    const expected = Matrix4.clone(curP)
    const col = Matrix4.getColumn(expected, 2, new Cartesian4())
    col.x += jitter.x * 2
    col.y += jitter.y * 2
    Matrix4.setColumn(expected, 2, col, expected)
    Matrix4.multiply(expected, curV, expected)
    expect(reprojectionMatrix).toEqual(expected)
  })
})
