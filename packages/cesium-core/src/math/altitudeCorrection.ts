import { Cartesian3, Ellipsoid } from 'cesium'

const normalScratch = new Cartesian3()
const surfaceScratch = new Cartesian3()

// 源仓库算法（getAltitudeCorrectionOffset + Ellipsoid.getOsculatingSphereCenter）：
//   surfacePosition = projectOnSurface(camera)
//   osculatingSphereCenter = surfacePosition - bottomRadius * surfaceNormal
//   return -center
// 加到相机 ECEF 上即把相机平移到"以密切球中心为原点"的局部系，使坐标量级 ≈
// bottomRadius，满足 Bruneton 模型的局部球假设（领域首要风险 R1 的对策）。
// 类型用 Cesium 原生（Cesium world 即 ECEF，故 worldToECEFMatrix 退化为单位矩阵）。
export function getAltitudeCorrectionOffset(
  cameraECEF: Cartesian3,
  bottomRadius: number,
  ellipsoid: Ellipsoid,
  result: Cartesian3
): Cartesian3 {
  const surface = ellipsoid.scaleToGeodeticSurface(cameraECEF, surfaceScratch)
  if (surface == null) {
    return Cartesian3.clone(Cartesian3.ZERO, result)
  }
  // geodetic surface normal（球近似下与密切球法线一致；WGS84 椭球下差异 < 密切球
  // 半径量级，G3 验证时确认是否需精确椭球法线）。
  const normal = Cartesian3.normalize(surface, normalScratch)
  // center = surface - bottomRadius * normal；offset = -center = bottomRadius*normal - surface
  result = Cartesian3.multiplyByScalar(normal, bottomRadius, result)
  result = Cartesian3.subtract(result, surface, result)
  return result
}
