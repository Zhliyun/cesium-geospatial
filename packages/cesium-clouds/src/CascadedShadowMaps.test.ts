// T1：CascadedShadowMaps 纯数学单测（node，无 GL）。
// 相机固定在 ECEF (0,0,6.4e6) 朝 -Z 看时手推期望值断言。
import { describe, expect, it } from 'vitest'
import { Cartesian3, Cartesian4, Matrix4, Transforms } from 'cesium'

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

  it('末段 cascade ortho 半径 ≥ far 面对角线半径真值（far 截断按视深 |z|，不收窄）', () => {
    // far 截断必须按视深 |z|（three：multiplyScalar(min(far/absZ, 1))），不能按欧氏范数——
    // 范数截断会把对角射线角点拉近到 cos(对角半张角)·far（fovy 60° 约 0.82·far），
    // radius 随之收窄 22%+，远处云影系统性缺失。盒永远「自洽罩住自己的锥」（角点收窄盒也收窄），
    // 故对角点盒内断言无区分度；真正的信号是 ortho 半径绝对值 ≥ far 面对角线半径真值
    // （three getFrustumRadius 的 diagonal 含 max(far 面对角, …) 项，radius = diagonal/2 ≥ 下界）。
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    // far 面对角线半径真值（aspect=1）：√2·tan(fovy/2)·far
    const diagonalRadiusTrue = Math.SQRT2 * Math.tan(Math.PI / 6) * 2e5 // ≈163299
    // computeOrthographicOffCenter(l=-r, r)：projectionMatrix 第 0 列 x 分量 = 2/(r-l) = 1/r
    const m00 = Matrix4.getColumn(csm.cascades[2].projectionMatrix, 0, new Cartesian4()).x
    expect(1 / m00).toBeGreaterThanOrEqual(diagonalRadiusTrue)
    // 护栏：NDC (1,1) 角的 far 面真角点（视深恰为 far）仍落盒内
    const corner = new Cartesian3(
      Math.tan(Math.PI / 6) * 2e5, Math.tan(Math.PI / 6) * 2e5, 6.4e6 - 2e5
    )
    const clip = Matrix4.multiplyByPoint(
      csm.cascades[2].matrix, corner, new Cartesian3()
    )
    expect(Math.abs(clip.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(clip.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(clip.z)).toBeLessThanOrEqual(1)
  })

  it('texel 对齐（含 Math.round snapping）：同输入连续 update 矩阵逐位一致', () => {
    const cam = makeCamera(1.0, 2e5)
    csm.update(cam, new Cartesian3(0, 0, 1), 1e5)
    // texel 对齐保证 shadow 相机平移不产生亚像素抖动（three 版同款 snapping）；
    // snap 含 Math.round，黑盒下可测的是确定性（逐位一致、无亚像素随机性）。
    // 真正的「落在 texel 网格上」断言需要非对称 bbox 场景，由 T6 视觉验收（平移相机无阴影闪烁）覆盖。
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

  // 回归（2026-08-18 BSM 光深排查）：生产朝向（非轴对齐）下级联盒必须罩住主视锥——
  // 用户验收机位（-30°,45° 海面 500m，heading 176.7° pitch 20°）实测级联 0 盒中心偏 189km、
  // 相机/探针点 UV=[1.35,3.4] 全越界 → marchShadowLength 采样 od≈0 → god rays 不可见。
  // 旧用例全是轴对齐相机（极点朝 -Z），旋转路径缺陷被掩盖。
  it('生产朝向（ECEF 任意机位+任意太阳方向）：级联 0 盒罩住视锥前段采样点', () => {    // 相机：-30,45 海上 500m，heading≈南、pitch=20° 仰视
    const eye = Cartesian3.fromDegrees(-30, 45, 500)
    const heading = (176.7 * Math.PI) / 180
    const pitch = (20 * Math.PI) / 180
    // ENU 局部系视线方向（Cesium heading 从北顺时针、pitch 仰角）：
    // dir_ENU = (sin h·cos p, cos h·cos p, sin p)
    const dirENU = new Cartesian3(
      Math.sin(heading) * Math.cos(pitch),
      Math.cos(heading) * Math.cos(pitch),
      Math.sin(pitch)
    )
    // ENU→ECEF 旋转 + 视线方向转 ECEF
    const enuToEcef = Transforms.eastNorthUpToFixedFrame(eye)
    const dirECEF = Matrix4.multiplyByPointAsVector(enuToEcef, dirENU, new Cartesian3())
    Cartesian3.normalize(dirECEF, dirECEF)
    // view = lookAt(eye, eye+dir, up=ENU 的 z)
    const upECEF = Matrix4.multiplyByPointAsVector(
      enuToEcef, new Cartesian3(0, 0, 1), new Cartesian3()
    )
    const target = Cartesian3.add(
      eye, Cartesian3.multiplyByScalar(dirECEF, 1000, new Cartesian3()), new Cartesian3()
    )
    void target
    // inverseViewMatrix（cam→ECEF，= three matrixWorld）：列 = (right, up, back, eye)
    const back = Cartesian3.negate(dirECEF, new Cartesian3())
    const right = Cartesian3.normalize(
      Cartesian3.cross(dirECEF, upECEF, new Cartesian3()), new Cartesian3()
    )
    const trueUp = Cartesian3.cross(back, right, new Cartesian3())
    const inverseViewMatrix = new Matrix4(
      right.x, trueUp.x, back.x, eye.x,
      right.y, trueUp.y, back.y, eye.y,
      right.z, trueUp.z, back.z, eye.z,
      0, 0, 0, 1
    )
    const projectionMatrix = Matrix4.computePerspectiveFieldOfView(
      (29.2 * Math.PI) / 180, 1280 / 577, 0.1, 1e10, new Matrix4()
    )
    const cam = { inverseViewMatrix, projectionMatrix, near: 0.1, far: 2e5 }
    // 任意非轴对齐太阳方向（下午偏南西）
    const sun = Cartesian3.normalize(new Cartesian3(-0.35, -0.55, 0.76), new Cartesian3())
    // distance 用生产公式值（lerp(1e6,1e3,zenith≈0.8)≈2e5）——小 distance 会掩盖旋转路径缺陷
    csm.update(cam, sun, 2e5)
    // 视线上 2.5km / 10km 两个采样点（云下空间——god rays march 域）代入级联 0 矩阵
    for (const dist of [2500, 10000]) {
      const p = Cartesian3.add(
        eye, Cartesian3.multiplyByScalar(dirECEF, dist, new Cartesian3()), new Cartesian3()
      )
      const clip = Matrix4.multiplyByPoint(csm.cascades[0].matrix, p, new Cartesian3())
      // ortho clip：|x|,|y| ≤ 1 才在盒内（允许 ≤1.05 的边界余量）
      expect(Math.abs(clip.x), `dist=${dist} clip.x`).toBeLessThanOrEqual(1.05)
      expect(Math.abs(clip.y), `dist=${dist} clip.y`).toBeLessThanOrEqual(1.05)
    }
  })

  it('中间量一致性：手工重算 centerWorld（three 语义）与 csm 内部一致', () => {
    const eye = Cartesian3.fromDegrees(-30, 45, 500)
    const heading = (176.7 * Math.PI) / 180
    const pitch = (20 * Math.PI) / 180
    const dirENU = new Cartesian3(
      Math.sin(heading) * Math.cos(pitch),
      Math.cos(heading) * Math.cos(pitch),
      Math.sin(pitch)
    )
    const enuToEcef = Transforms.eastNorthUpToFixedFrame(eye)
    const dirECEF = Matrix4.multiplyByPointAsVector(enuToEcef, dirENU, new Cartesian3())
    Cartesian3.normalize(dirECEF, dirECEF)
    const upECEF = Matrix4.multiplyByPointAsVector(enuToEcef, new Cartesian3(0, 0, 1), new Cartesian3())
    const back = Cartesian3.negate(dirECEF, new Cartesian3())
    const right = Cartesian3.normalize(Cartesian3.cross(dirECEF, upECEF, new Cartesian3()), new Cartesian3())
    const trueUp = Cartesian3.cross(back, right, new Cartesian3())
    const inverseViewMatrix = new Matrix4(
      right.x, trueUp.x, back.x, eye.x,
      right.y, trueUp.y, back.y, eye.y,
      right.z, trueUp.z, back.z, eye.z,
      0, 0, 0, 1
    )
    const projectionMatrix = Matrix4.computePerspectiveFieldOfView(
      (29.2 * Math.PI) / 180, 1280 / 577, 0.1, 1e10, new Matrix4()
    )
    const cam = { inverseViewMatrix, projectionMatrix, near: 0.1, far: 2e5 }
    const sun = Cartesian3.normalize(new Cartesian3(-0.35, -0.55, 0.76), new Cartesian3())
    const distance = 2e5
    csm.update(cam, sun, distance)

    // ── 手工重算（three 语义）──
    const UP = new Cartesian3(0, 1, 0)
    const zAxis = Cartesian3.clone(sun, new Cartesian3()) // lightOrientation zAxis=+sunDir
    const xAxis = Cartesian3.normalize(Cartesian3.cross(UP, zAxis, new Cartesian3()), new Cartesian3())
    const yAxis = Cartesian3.cross(zAxis, xAxis, new Cartesian3())
    // lightOrientation：列=(xAxis,yAxis,zAxis)、平移=0
    const lightOrientation = new Matrix4(
      xAxis.x, yAxis.x, zAxis.x, 0,
      xAxis.y, yAxis.y, zAxis.y, 0,
      xAxis.z, yAxis.z, zAxis.z, 0,
      0, 0, 0, 1
    )
    const invLO = Matrix4.inverse(lightOrientation, new Matrix4())
    const cameraToLight = Matrix4.multiply(invLO, inverseViewMatrix, new Matrix4())
    const frusta0 = (csm as unknown as { frusta: { near: Cartesian3[]; far: Cartesian3[] }[] }).frusta[0]
    const pts = [...frusta0.near, ...frusta0.far].map(p =>
      Matrix4.multiplyByPoint(cameraToLight, p, new Cartesian3())
    )
    const min = new Cartesian3(Infinity, Infinity, Infinity)
    const max = new Cartesian3(-Infinity, -Infinity, -Infinity)
    for (const p of pts) {
      min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z)
      max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z)
    }
    const center = new Cartesian3((min.x + max.x) / 2, (min.y + max.y) / 2, max.z) // margin=0
    const centerWorldMine = Matrix4.multiplyByPoint(lightOrientation, center, new Cartesian3())
    const csmPos = Matrix4.getColumn(csm.cascades[0].inverseViewMatrix, 3, new Cartesian4())
    const centerWorldCsm = new Cartesian3(
      csmPos.x - sun.x * distance, csmPos.y - sun.y * distance, csmPos.z - sun.z * distance
    )
    const gap = Cartesian3.distance(centerWorldMine, centerWorldCsm)
    expect(gap).toBeLessThan(1000)
  })
})
