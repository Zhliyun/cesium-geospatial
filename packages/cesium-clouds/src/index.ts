// @cesium-geospatial/clouds — 体积云（Phase 3）
// spec: docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md（r1）
// 依赖 @cesium-geospatial/core（Bruneton runtime + 基建 platform 层）
export { CLOUDS_DEFAULT_QUALITY, CLOUDS_LAYER_ALTITUDES_M } from './cloudsConstants'

// GLSL 资产 + 跨包 #include 解析（T7）
export { glslIndex } from './glslIndex'
export { resolveCloudsIncludes } from './resolveCloudsIncludes'
export {
  buildStandaloneCloudsShader,
  type CloudsStage,
  type CloudsDefineValue,
  type CloudsDefines,
  type CloudsStandaloneOptions
} from './cloudsShaderAssembler'

// weather 噪声纹理加载（T9）
export { loadWeatherTextures, type WeatherTextures } from './weatherTextures'
