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
export { loadAtmosphereLUTs, parseHalfFloatBin } from './cesium/lutLoader'
export type { AtmosphereLUTs } from './cesium/lutLoader'
export {
  buildAerialPerspectiveFragmentShader,
  buildStandaloneShaderForValidation,
  AERIAL_PERSPECTIVE_UNIFORM_NAMES
} from './cesium/aerialPerspective.frag'
export type { AerialPerspectiveFragOptions } from './cesium/aerialPerspective.frag'
export {
  createAtmosphereStage,
  validateAtmosphereOptions,
  buildAtmosphereUniforms,
  getEffectiveAtmosphereExposure
} from './cesium/AtmosphereStage'
export type {
  AtmosphereStageOptions,
  ResolvedAtmosphereStageOptions,
  AtmosphereStageHandle,
  AtmosphereFrameState
} from './cesium/AtmosphereStage'
