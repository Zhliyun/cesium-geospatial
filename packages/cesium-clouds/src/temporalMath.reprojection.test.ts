import { describe, it, expect } from 'vitest'
import { Cartesian2, Cartesian4, Matrix4 } from 'cesium'
import { buildReprojectionMatrices } from './temporalMath'

// 【2026-10-25 回归测试】重投影矩阵数值验证。
// 覆盖两件事：① 纯 yaw 下 prevUv 精确回到上一帧屏幕坐标（X/Y 都精确）；
// ② 带 jitter 时 prevUv 必须等于「上一帧真实屏幕位置 − 上帧 jitter」。
// ② 曾写反符号（-= 而非 +=，列 2 经 w=−z 除法后 NDC 反号），导致历史每帧偏移
// 2×jitter（最多 1 个低分 texel）——拖动时的错位/漂移来源之一。
function persp(fovY: number, aspect: number, near: number, far: number): Matrix4 {
  const f = 1 / Math.tan(fovY / 2)
  // 列主序
  return Matrix4.fromArray([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ])
}

function yawMatrix(a: number): Matrix4 {
  const c = Math.cos(a), s = Math.sin(a)
  return Matrix4.fromArray([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1
  ])
}

const proj = (m: Matrix4, p: Cartesian4): [number, number] => {
  const v = Matrix4.multiplyByVector(m, p, new Cartesian4())
  return [(v.x / v.w) * 0.5 + 0.5, (v.y / v.w) * 0.5 + 0.5]
}

describe('reprojection Y sanity', () => {
  it('pure yaw: prevUv 精确回到上一帧屏幕坐标（X/Y 都精确）', () => {
    const P = persp(Math.PI / 3, 16 / 9, 1, 1e6)
    const V0 = Matrix4.clone(Matrix4.IDENTITY)
    const X = new Cartesian4(1, 2, -10, 1)

    const prevSnapshot = { viewMatrix: V0, projectionMatrix: P }
    const V1 = yawMatrix((1 * Math.PI) / 180)
    const invV1 = Matrix4.inverse(V1, new Matrix4())

    const res = { reprojectionMatrix: new Matrix4(), viewReprojectionMatrix: new Matrix4() }
    buildReprojectionMatrices(
      prevSnapshot, V1, P, invV1, new Cartesian2(0, 0), res, new Cartesian2(0, 0)
    )

    const prevPV = Matrix4.multiply(P, V0, new Matrix4())
    const curPV = Matrix4.multiply(P, V1, new Matrix4())
    const uvPrev = proj(prevPV, X)
    const uvCur = proj(curPV, X)
    const uvRepro = proj(res.reprojectionMatrix, X)

    console.log('uvPrev', uvPrev.map((v) => v.toFixed(5)), 'uvCur', uvCur.map((v) => v.toFixed(5)), 'uvRepro', uvRepro.map((v) => v.toFixed(5)))

    expect(Math.abs(uvRepro[0] - uvPrev[0])).toBeLessThan(1e-5)
    // 带 jitter：正确的 prevUv 应等于「上一帧真实屏幕位置 − 上帧 jitter」
    const jPrev = new Cartesian2(0.0007, -0.0004)
    const jCur = new Cartesian2(-0.0002, 0.0006)
    const resJ = { reprojectionMatrix: new Matrix4(), viewReprojectionMatrix: new Matrix4() }
    buildReprojectionMatrices(prevSnapshot, V1, P, invV1, jCur, resJ, jPrev)
    const uvReproJ = proj(resJ.reprojectionMatrix, X)
    console.log('uvReproJ', uvReproJ.map((v) => v.toFixed(6)),
      'expect', [uvPrev[0] - jPrev.x, uvPrev[1] - jPrev.y].map((v) => v.toFixed(6)))
    expect(Math.abs(uvReproJ[0] - (uvPrev[0] - jPrev.x))).toBeLessThan(1e-5)
    expect(Math.abs(uvReproJ[1] - (uvPrev[1] - jPrev.y))).toBeLessThan(1e-5)
    expect(Math.abs(uvRepro[1] - uvPrev[1])).toBeLessThan(1e-5)
    // 水平旋转下，垂直屏幕坐标应基本不变
    expect(Math.abs(uvCur[1] - uvPrev[1])).toBeLessThan(0.01)
  })
})
