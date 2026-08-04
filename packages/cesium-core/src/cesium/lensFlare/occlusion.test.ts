// Task 7 测试：occlusion.ts 三纯函数（spec §5.5）。
// 数学合约（spec §5.5）：
//   - computeSunScreenUV：sunEC = view * vec4(sunDirWC, 0.0)（w=0 无穷远，修 cesium-clouds-atmosphere 1e6 视差）；
//     sunClip = projection * vec4(sunEC.xyz, 1.0)；NDC = sunClip.xy/w；UV = NDC*0.5+0.5。
//     w<=0（背面）或 NDC 超出 [-1,1] → null。
//   - rayEllipsoidIntersect：WGS84 椭球二次方程 A t²+B t+C=0（spec §5.5 M9）；<0 或 t<0（背后）→ -1。
//   - generateSampleGrid36：6×6 网格 [-1,1]²，36 点（spec §5.5 I5：16 点 6.25% 步进台阶，提 36 点 ~2.7%）。
//
// Mock 矩阵约定（列主，对齐 Cesium Matrix4 / WebGL mat4）：
//   本测试用「相机看 +z」透视（简化 mock，非 Cesium/OpenCV -z 约定，只要 test 一致）：
//     fovy=90° aspect=1 near=0.1 far=1000 → f=1/tan(45°)=1
//     clip.w = z_eye（[3][2]=+1）；clip.z = A*z+B（[2][2]=(far+near)/(far-near), [2][3]=-2*near*far/(far-near)）
//     ⇒ sunDir=[0,0,1] → sunEC.z=1 → clip.w=1>0 → NDC=(0,0) → UV=(0.5,0.5)（屏幕中心）
//     ⇒ sunDir=[0,0,-1] → sunEC.z=-1 → clip.w=-1<0 → null（背面）
import { describe, expect, it } from 'vitest'
import { computeSunScreenUV, rayEllipsoidIntersect, generateSampleGrid36 } from './occlusion'

// 列主 4×4 单位 view（相机在原点无旋转）
const IDENTITY_VIEW = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]

// 列主 4×4 透视（forward-z mock：fovy=90° aspect=1 near=0.1 far=1000）
const PERSP_PROJ = [
  // column 0       1           2               3
  1, 0, 0, 0,       0, 1, 0, 0, 0, 0, 1.0002, 1, 0, 0, -0.20002, 0,
]

// WGS84 椭球半径平方（radiiSquared）：a≈6378km（赤道），b≈6356km（极）
const WGS84_RADII_SQUARED: [number, number, number] = [6378e3 ** 2, 6378e3 ** 2, 6356e3 ** 2]

describe('computeSunScreenUV', () => {
  it('sun 在视椎内正前方 [0,0,1] → UV 落在屏幕中心附近 [0,1]', () => {
    const uv = computeSunScreenUV([0, 0, 1], [0, 0, 0], IDENTITY_VIEW, PERSP_PROJ)
    expect(uv).not.toBeNull()
    expect(uv![0]).toBeGreaterThanOrEqual(0)
    expect(uv![0]).toBeLessThanOrEqual(1)
    expect(uv![1]).toBeGreaterThanOrEqual(0)
    expect(uv![1]).toBeLessThanOrEqual(1)
    // 正前方 → UV ≈ (0.5, 0.5)
    expect(uv![0]).toBeCloseTo(0.5, 3)
    expect(uv![1]).toBeCloseTo(0.5, 3)
  })

  it('sun 在背面 [0,0,-1]（w<=0）→ null', () => {
    expect(computeSunScreenUV([0, 0, -1], [0, 0, 0], IDENTITY_VIEW, PERSP_PROJ)).toBeNull()
  })

  it('sun 偏离视椎（NDC 超出 [-1,1]）→ null', () => {
    // 沿 x 方向（y=0）：sunEC=[1,0,0]，clip.x=1*w=1 不成立——
    // 实际 mat4*[1,0,0,1]: result.x = m[0]*1=1, result.w = m[3]*1=0 → w=0 ≤0 → null
    // 用 [1,0,1]：sunEC=[1,0,1]，clip = proj*[1,0,1,1]:
    //   clip.x = m[0]*1 + m[8]*1 = 1 + 0 = 1; clip.w = m[11]*1 = 1 → NDC.x = 1（边缘，未超）
    // 再大点 [10,0,1]：clip.x = 10, clip.w = 1 → NDC.x = 10 → 超 [-1,1] → null
    expect(computeSunScreenUV([10, 0, 1], [0, 0, 0], IDENTITY_VIEW, PERSP_PROJ)).toBeNull()
  })
})

describe('rayEllipsoidIntersect', () => {
  it('射线击中椭球（相机 7000km 朝地心）→ t>0', () => {
    const t = rayEllipsoidIntersect([0, 0, 7000e3], [0, 0, -1], WGS84_RADII_SQUARED)
    expect(t).toBeGreaterThan(0)
  })

  it('击中距离合理（约 7000-6356 ≈ 644km）', () => {
    const t = rayEllipsoidIntersect([0, 0, 7000e3], [0, 0, -1], WGS84_RADII_SQUARED)
    // 进入点 ≈ 7000e3 - 6356e3 = 644e3
    expect(t).toBeCloseTo(644e3, -3) // 1km 精度（千位取整）
  })

  it('射线背离椭球 [0,0,1] → -1', () => {
    expect(rayEllipsoidIntersect([0, 0, 7000e3], [0, 0, 1], WGS84_RADII_SQUARED)).toBe(-1)
  })

  it('射线不交椭球（z=20000km 沿 +x 远外侧）→ -1', () => {
    expect(rayEllipsoidIntersect([0, 0, 20000e3], [1, 0, 0], WGS84_RADII_SQUARED)).toBe(-1)
  })

  it('球而非椭球（各向同性 r²=1）：原点 (2,0,0) 朝原点 → t=1', () => {
    // 球 r=1：原点 (2,0,0)，rd=(-1,0,0) → 入口 (1,0,0)，t=1
    const t = rayEllipsoidIntersect([2, 0, 0], [-1, 0, 0], [1, 1, 1])
    expect(t).toBeCloseTo(1, 6)
  })
})

describe('generateSampleGrid36', () => {
  it('36 点（6×6）', () => {
    const pts = generateSampleGrid36()
    expect(pts).toHaveLength(36)
  })

  it('归一化 [-1,1]', () => {
    const pts = generateSampleGrid36()
    expect(pts.every(p => Math.abs(p[0]) <= 1.001 && Math.abs(p[1]) <= 1.001)).toBe(true)
  })

  it('含四角（-1,-1）/（1,-1）/（-1,1）/（1,1）', () => {
    const pts = generateSampleGrid36()
    const has = (x: number, y: number) => pts.some(p => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6)
    expect(has(-1, -1)).toBe(true)
    expect(has(1, -1)).toBe(true)
    expect(has(-1, 1)).toBe(true)
    expect(has(1, 1)).toBe(true)
  })
})
