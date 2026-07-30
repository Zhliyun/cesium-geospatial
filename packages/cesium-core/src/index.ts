/// <reference path="./cesium/cesium-augment.d.ts" />

export { resolveIncludes } from './resolveIncludes'
export { unrollLoops } from './unrollLoops'
export { glslIndex } from './glslIndex'
export {
  ATMOSPHERE_DEFAULT_GLSL,
  ATMOSPHERE_BOTTOM_RADIUS_M,
  ATMOSPHERE_TOP_RADIUS_M,
  SUN_ANGULAR_RADIUS
} from './math/atmosphereParameters'
export { getAltitudeCorrectionOffset } from './math/altitudeCorrection'
export { buildAtmospherePrefix } from './cesium/cesiumCore'
export { DEPTH_RECONSTRUCTION_GLSL } from './cesium/depthReconstruction'
export { RECONSTRUCT_NORMAL_GLSL } from './cesium/normalReconstruction'
export { COLOR_SPACE_GLSL } from './cesium/colorSpace'
export { loadAtmosphereLUTs, parseHalfFloatBin } from './cesium/lutLoader'
export type { AtmosphereLUTs } from './cesium/lutLoader'
export {
  computeGeometricErrorCorrectionAmount,
  remapClamp,
  GEO_ERROR_CORRECTION_NEAR,
  GEO_ERROR_CORRECTION_FAR
} from './cesium/geometricErrorCorrection'
export {
  buildAerialPerspectiveFragmentShader,
  buildStandaloneShaderForValidation,
  AERIAL_PERSPECTIVE_UNIFORM_NAMES
} from './cesium/aerialPerspective.frag'
export type { AerialPerspectiveFragOptions } from './cesium/aerialPerspective.frag'
