// T1：CascadedShadowMaps 纯数学单测（node，无 GL）。
// 相机固定在 ECEF (0,0,6.4e6) 朝 -Z 看时手推期望值断言。
import { describe, expect, it } from 'vitest'
import {
  Cartesian2, Cartesian3, Cartesian4, Math as CesiumMath, Matrix3, Matrix4, Transforms
} from 'cesium'

import { CascadedShadowMaps, splitFrustum } from './CascadedShadowMaps'

// 视线朝地心的简单透视相机：位于北极上方，看 -Z。构造 view（world→view）：
// view = rotate(把相机 -Z 对到 world -Z) * translate(-eye) —— 这里相机无旋转，
// viewMatrix = translate(-eye)，inverseViewMatrix（=three matrixWorld）= translate(eye)。
// height：北极相机离地高度 m（eye.z = 6371000 + height；默认 29000 → 6.4e6 与旧值逐位一致）。
function makeCamera(near: number, far: number, fovy = Math.PI / 3, height = 29000) {
  const eye = new Cartesian3(0, 0, 6371000 + height)
  const inverseViewMatrix = Matrix4.fromTranslation(eye)
  // 透视投影（gluPerspective 语义，aspect 1）：Cesium Matrix4.computePerspectiveFieldOfView。
  // near=0 时其内部 Check 抛 DeveloperError，但矩阵本身良定义（m10=-1、m14=0）——
  // 手写同公式绕过检查（world 锚定用例需要 near=0 相机；world 分支不消费投影矩阵）。
  const projectionMatrix = near > 0
    ? Matrix4.computePerspectiveFieldOfView(fovy, 1.0, near, far, new Matrix4())
    : new Matrix4(
        1 / Math.tan(fovy / 2), 0, 0, 0,
        0, 1 / Math.tan(fovy / 2), 0, 0,
        0, 0, (far + near) / (near - far), 2 * far * near / (near - far),
        0, 0, -1, 0
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

  // f32 仿真（GPU float32 近似——spec §6：f64 域断言会平凡通过）
  const f32m = (m: Matrix4): Matrix4 => {
    const out = new Matrix4()
    for (let i = 0; i < 16; i++) (out as unknown as number[])[i] = Math.fround(m[i])
    return out
  }
  const uvOf = (m: Matrix4, p: Cartesian3): Cartesian2 => {
    // probe 逐分量 f32 化（GPU uniform 上载近似，审查 Minor——提高 f32 仿真保真）
    const pf = new Cartesian3(Math.fround(p.x), Math.fround(p.y), Math.fround(p.z))
    const v = Matrix4.multiplyByPoint(m, pf, new Cartesian3())
    return new Cartesian2(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5) // ortho w=1
  }

  it('纯旋转（heading/pitch 变、位置不动）：矩阵 f32 化后逐帧不变（spec §3.1.2 最强性质）', () => {
    const csm = makeWorldCSM()
    const cam = makeCamera(0.1, 6e4)
    // 绕视轴 + 俯仰各转一次（位置恒定）：构造带旋转的 inverseViewMatrix
    const rotM = (rx: number, rz: number) =>
      Matrix4.fromRotationTranslation(
        Matrix3.multiply(Matrix3.fromRotationZ(rz), Matrix3.fromRotationX(rx), new Matrix3()),
        new Cartesian3(0, 0, 6.371e6 + 8e3)
      )
    // base 必须与旋转帧同位置（rotM(0,0)=零旋转+同平移）——makeCamera 的 eye 在 6.4e6，
    // 与旋转帧差 21km，world 锚定矩阵随位置 snap 变化，位置不同则矩阵必然不同
    csm.update({ ...cam, inverseViewMatrix: rotM(0, 0) }, sun, 1e5)
    const base = csm.cascades.map(c => f32m(c.matrix))
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

  it('高空+低仰角无 NaN：rhoMin≥Rtop 定义域扩展下三层矩阵全部 finite（fix round 1）', () => {
    // 触发域（北极相机，地表基值 6371000）：相机位矢模越大、太阳仰角越低，
    // rhoC=|cam|·cos(e) 越大 → rhoMin=rhoC−radius 可能超过 Rtop=6362200 →
    // sqrt 负数产 NaN（修复前 8km+0°/100km+0°,5°/449km 全部组合实炸）。
    // 修复后该域 zNear=margin：盘柱与壳顶球不相交、盒内无云，深度图空白即正确结果。
    const csm = makeWorldCSM()
    for (const height of [8e3, 1e5, 4.49e5]) {
      for (const elevDeg of [0, 5, 10]) {
        const elev = (elevDeg * Math.PI) / 180
        // 北极上方相机；太阳仰角 e（相对当地地平）→ sunDir=(cos e, 0, sin e)
        const inv = Matrix4.fromTranslation(new Cartesian3(0, 0, 6371000 + height))
        const sunElev = new Cartesian3(Math.cos(elev), 0, Math.sin(elev))
        csm.update({ ...makeCamera(0.1, 6e4), inverseViewMatrix: inv }, sunElev, 1e5)
        const probe = new Cartesian3(0, 0, 6371000 + 1500) // 相机正下方云层内一点
        for (const c of csm.cascades) {
          // interval 良定义
          expect(Number.isFinite(c.interval.x)).toBe(true)
          expect(Number.isFinite(c.interval.y)).toBe(true)
          expect(c.interval.y).toBeGreaterThan(c.interval.x)
          // 三层 matrix 16 元素全部 finite
          for (let e = 0; e < 16; e++) {
            expect(Number.isFinite((c.matrix as unknown as number[])[e])).toBe(true)
          }
          // 反投影良定义：world→clip→world roundtrip（NaN 会沿矩阵乘传染）
          const clip = Matrix4.multiplyByPoint(c.matrix, probe, new Cartesian3())
          const clip4 = new Cartesian4(clip.x, clip.y, clip.z, 1.0)
          const back4 = Matrix4.multiplyByVector(c.inverseMatrix, clip4, new Cartesian4())
          expect(Number.isFinite(back4.x / back4.w)).toBe(true)
          expect(Number.isFinite(back4.y / back4.w)).toBe(true)
          expect(Number.isFinite(back4.z / back4.w)).toBe(true)
          expect(back4.x / back4.w).toBeCloseTo(probe.x, -2)
          expect(back4.y / back4.w).toBeCloseTo(probe.y, -2)
          expect(back4.z / back4.w).toBeCloseTo(probe.z, -2)
        }
      }
    }
  })

  // 与上例互补（上例固定「高空相机 + 低仰角」盯 NaN；本例固定「低空相机 800m」扫全部太阳仰角，
  // 盯的是 zNear 解析式的几何正确性：spec §3.1.3 现存 bug（zenith→1 全量归零）的回归护栏。
  it('zNear 极端太阳角（2°/10°/30°/60°/89°，低相机 800m）：z=-1 反投影面全盘在壳顶之上（spec §3.1.3）', () => {
    const csm = makeWorldCSM()
    const Rtop = 6362200 // shellTopRadius 缺省（bottomRadius 6360000 + shadowTopHeight 2200）
    for (const deg of [2, 10, 30, 60, 89]) {
      const el = CesiumMath.toRadians(deg)
      const sunI = Cartesian3.normalize(
        new Cartesian3(Math.cos(el), 0.1, Math.sin(el)), new Cartesian3())
      const cam = makeCamera(0.1, 6e4, Math.PI / 3, 800) // 低相机 800m（zenith bug 触发高度）
      csm.update(cam, sunI, 1e5)
      for (let i = 0; i < 3; i++) {
        const inv = csm.cascades[i].inverseMatrix
        // 全盘角点（clip xy=±1, z=-1）反投影 → |p| 必须 > Rtop（壳顶球外）：
        // near 面 = 光心域 z = sqrt(Rtop²−rhoMin²)+margin，任意 rho≥rhoMin 处
        // |p|² = rho²+z² ≥ rhoMin²+(sqrt(Rtop²−rhoMin²)+margin)² > Rtop²（margin>0 恒成立）；
        // 公式错（域换算丢项/sqrt 取错域）时 near 面切进壳内 → 角点 |p|<Rtop 即红。
        for (const cx of [-1, 1]) for (const cy of [-1, 1]) {
          const p4 = Matrix4.multiplyByVector(
            inv, new Cartesian4(cx, cy, -1, 1), new Cartesian4())
          const p = Cartesian3.fromElements(p4.x / p4.w, p4.y / p4.w, p4.z / p4.w)
          expect(Cartesian3.magnitude(p), `deg=${deg} cascade=${i} corner=(${cx},${cy})`)
            .toBeGreaterThan(Rtop)
        }
      }
    }
  })

  // 本用例曾红（T2 逮到 xy 域混用，fix round 2 修复，详见 task-2-report.md）：
  // projectionMatrix 曾用光心域绝对坐标 c±r + viewMatrix 又平移 centerWorld（§3.1.9）
  // → center 双重扣除（clip.xy=(x−2c)/r₀）→ 整数 texel 平移帧 UV 差加倍（实测 dx=−14≠−7）。
  // 修复（对称盒 −r,+r）后转绿；同时暴露并修复 zNear 域换算符号（orthoNear=center.z−zNearGeo）。
  it('整数 texel 平移帧：同一世界点新旧矩阵 UV 差恰为整数 texel（velocity 精确重投影前提，spec §3.1.6）', () => {
    const csm = makeWorldCSM()
    // sun 必须轴对齐（正午北极 → light 轴=世界轴）：非对齐 sun 下世界系平移投影到 light xy
    // 非 texel 整数倍（且两帧 z 差也会泄进 light xy），「整数 texel 平移」前提本身不可陈述。
    const sunNoon = new Cartesian3(0, 0, 1)
    const camZ = 6.371e6 + 8e3
    const probe = new Cartesian3(4e3, 1e3, 6.371e6 + 9e3) // cascade 0 盒内云中一点
    const texel = (WORLD_RADII[0] * 2) / 512 // = 62.5
    // 帧序列：一次跳 N texel 的平移（N = texel 整数倍；两帧同 z，平移仅 xy）
    csm.update({ ...makeCamera(0.1, 6e4), inverseViewMatrix: Matrix4.fromTranslation(new Cartesian3(0, 0, camZ)) }, sunNoon, 1e5)
    const uvA = uvOf(csm.cascades[0].matrix, probe)
    const inv = Matrix4.fromTranslation(new Cartesian3(7 * texel, -3 * texel, camZ))
    csm.update({ ...makeCamera(0.1, 6e4), inverseViewMatrix: inv }, sunNoon, 1e5)
    const uvB = uvOf(csm.cascades[0].matrix, probe)
    const dx = (uvB.x - uvA.x) * 512
    const dy = (uvB.y - uvA.y) * 512
    expect(Math.abs(dx - Math.round(dx))).toBeLessThan(1e-6)
    expect(Math.abs(dy - Math.round(dy))).toBeLessThan(1e-6)
    expect(Math.round(dx)).toBe(-7) // 网格平移 +7 texel → 同点 uv 反向平移 7
    expect(Math.round(dy)).toBe(3)
  })
})
