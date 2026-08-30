// 月方向与月相因子（spec 2026-08-30 r2 §4）——单源实现，AtmosphereStage（月盘）与
// clouds（月光照云）两处消费。单位全链米制；ICRF 旋转由调用方传入
// （computeIcrfToCentralBodyFixedMatrix 竞态修复版，与各 stage 太阳管线同帧共享，
// 省每帧重复旋转矩阵）。
import {
  Cartesian3,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms
} from 'cesium'

const moonInertialScratch = new Cartesian3()
const sunInertialScratch = new Cartesian3()
const moonFixedScratch = new Cartesian3()

/**
 * 观察者月方向（ECEF 单位向量）。
 * 管线：Simon1994 月位置（ICRF，米）→ icrfToFixed 旋转 → 视差修正（moon − origin，米）→ 归一。
 * 视差必做：月地 38 万 km，月球地平视差 57′ ≈ 月盘视直径两倍——不修正月盘方位偏两个盘径。
 */
export function computeMoonDirectionECEF(
  time: JulianDate,
  icrfToFixed: Matrix3,
  originECEF: Cartesian3,
  result: Cartesian3
): Cartesian3 {
  const moonInertial = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    time,
    moonInertialScratch
  )
  if (moonInertial == null) return result
  const moonFixed = Matrix3.multiplyByVector(icrfToFixed, moonInertial, moonFixedScratch)
  // originECEF 语义 = camera.positionWC + altitudeCorrection（米）——调用方算好传入
  Cartesian3.subtract(moonFixed, originECEF, moonFixed)
  const mag = Cartesian3.magnitude(moonFixed)
  if (Number.isFinite(mag) && mag > 1e-15) {
    Cartesian3.normalize(moonFixed, result)
  }
  return result
}

/**
 * Lambert 球积分月相照明因子：f = (sin ε − ε·cos ε)/π（朔 0 / 弦 0.318 / 望 1）。
 * 运行时消费方手头已有 state 两方向——直接调本函数（dot 即得，零天文计算）。
 */
export function computeMoonIlluminatedFractionFromDirections(
  sunDirection: Cartesian3,
  moonDirection: Cartesian3
): number {
  const d = CesiumMath.clamp(Cartesian3.dot(sunDirection, moonDirection), -1.0, 1.0)
  const elongation = Math.acos(d) // clamp 防 float 越界 NaN（朔望点高危）
  return (Math.sin(elongation) - elongation * Math.cos(elongation)) / Math.PI
}

/**
 * 独立版月相因子（内部自算两方向）——仅供单测/独立消费。
 * 运行时勿每帧独立调用（内部 Simon1994×2+ICRF×1；消费方已有两方向，用 FromDirections 版）。
 */
export function computeMoonIlluminatedFraction(time: JulianDate): number {
  const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    time,
    sunInertialScratch
  )
  const moonInertial = Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    time,
    moonInertialScratch
  )
  if (sunInertial == null || moonInertial == null) return 0
  const icrfToFixed = Transforms.computeIcrfToCentralBodyFixedMatrix(time, new Matrix3())
  if (icrfToFixed == null) return 0
  const sun = Cartesian3.normalize(
    Matrix3.multiplyByVector(icrfToFixed, sunInertial, sunInertialScratch),
    sunInertialScratch
  )
  const moon = Cartesian3.normalize(
    Matrix3.multiplyByVector(icrfToFixed, moonInertial, moonFixedScratch),
    moonFixedScratch
  )
  return computeMoonIlluminatedFractionFromDirections(sun, moon)
}
