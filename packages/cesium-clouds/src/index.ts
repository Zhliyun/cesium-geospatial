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

// M2 T1：three clouds.frag → Cesium 主 march fragment shader 桥接组装器（双入口：运行时 + glslang 校验）
export {
  buildCloudsMainFragmentShader,
  buildStandaloneCloudsShaderForValidation,
  type CloudsMainOptions
} from './CloudsMaterial'

// M2 T2：CloudsPass（custom Primitive pass=VOXELS + 3-attachment MRT + 全 business uniform 注入）
export {
  createCloudsPass,
  type CloudsPass,
  type CloudsFrameState,
  type CloudsPassOptions
} from './CloudsPass'
export {
  defaultCloudsParameters,
  type CloudsParameters
} from './cloudsDefaultParameters'
