// Phase 1 核心：移植 three-geospatial aerialPerspectiveEffect.frag 的地表主流程
// + 天空分支（sky.glsl getSkyRadiance 的 SUN-only 裁剪版）到 Cesium PostProcessStage。
//
// 对照源文件：
// - packages/atmosphere/src/shaders/aerialPerspectiveEffect.frag
//   （correctGeometricError:89-100、getSunSkyIrradiance:104-127、
//     applyTransmittanceInscatter:133-148、mainImage:271-390）
// - packages/atmosphere/src/shaders/sky.glsl（getSkyRadiance:26-81，MOON/PERSPECTIVE_CAMERA 裁剪）
//
// 移植规则（评审确认硬伤，错则全错）：
// 1. 天空判定用原始深度 rawDepth >= 1.0 - 1e-8，先于任何深度反演（spec §5.1）。
// 2. 法线用 T2 reconstructNormalECEF（view 空间求导，绝不在 ECEF 求导）。
// 3. 色彩闭环（§3.2）：A 路径 albedo = sRGBToLinear(inputColor.rgb)；输出
//    linearToSRGB(Reinhard(radiance * exposure))。B 路径 inputColor 直通进同一输出端
//    （§3.3 对照路径的已知近似）。
// 4. RECIPROCAL_PI 头部 #define（buildAtmospherePrefix 与 glsl/math.glsl 均无，§3.1）。
// 5. 宏组合按 spec §4.2：SUN_LIGHT/SKY_LIGHT/TRANSMITTANCE/INSCATTER/SUN/GROUND/
//    CORRECT_GEOMETRIC_ERROR/SKY 由 options 控制（默认全开）；RECONSTRUCT_NORMAL 在
//    correctGeometricError || sunLight || skyLight 时生成（只有这些路径消费法线）。
// 6. 几何侧再中心化（§5.3）：
//    positionECEF = worldECEF * METER_TO_LENGTH_UNIT
//                 + altitudeCorrection * METER_TO_LENGTH_UNIT * (1 - amount)。
// 7. czm_currentFrustum 禁用（§5.1：post 阶段只反映最后渲染的视锥），log 深度反演的
//    near/far 走 cameraNear/cameraFar uniform（CPU 每帧传 scene.camera.frustum）。
//
// 前提：WebGL2（texture()/dFdx/GLSL ES 3.00）。PostProcessStage 运行时 Cesium 自动补
// #version 与 out_FragColor；独立 glslang 校验走 buildStandaloneShaderForValidation。
//
// 宏裁剪策略：凡本文件自有的函数/调用点，按 options 在 TS 层整体生成或剔除
// （保证"宏关 → 标识符零残留"，T6 接线测试可文本断言）；函数内部对源仓库的
// #if/#ifdef 保留 GLSL 层裁剪（SUN_LIGHT/SKY_LIGHT、TRANSMITTANCE/INSCATTER），
// 因对应 #define 与 options 一一对应发射，两种裁剪永远一致。

import { glslIndex } from '../glslIndex'
import { resolveIncludes } from '../resolveIncludes'
import { buildAtmospherePrefix } from './cesiumCore'
import { COLOR_SPACE_GLSL } from './colorSpace'
import { LOG_DEPTH_GLSL } from './logDepth'
import { RECONSTRUCT_NORMAL_GLSL } from './normalReconstruction'

// spec §4.2 options 形状，全部默认 true（A 路径全量大气）。
export interface AerialPerspectiveFragOptions {
  sunLight?: boolean // SUN_LIGHT：A 路径太阳直射照明（默认 true）
  skyLight?: boolean // SKY_LIGHT：A 路径天空漫射照明（默认 true）
  transmittance?: boolean // TRANSMITTANCE：透射衰减（默认 true）
  inscatter?: boolean // INSCATTER：路径内散射（默认 true）
  sun?: boolean // SUN：日盘（默认 true，需 SKY 才生效）
  ground?: boolean // GROUND：天空穿地判定（默认 true，bruneton/runtime 消费）
  correctGeometricError?: boolean // CORRECT_GEOMETRIC_ERROR（默认 true）
  sky?: boolean // SKY：天空分支存在性（默认 true；false 时远平面直通 inputColor）
}

type ResolvedOptions = Required<AerialPerspectiveFragOptions>

// 供 Task 6 接线一致性测试：本 shader 跨全部宏组合可能声明的 uniform 超集
// （命名对齐源仓库，spec §4.1）。bottomRadius 为 Phase 2 阴影预留，本 Phase 不声明。
export const AERIAL_PERSPECTIVE_UNIFORM_NAMES: string[] = [
  'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'transmittance_texture',
  'scattering_texture',
  'single_mie_scattering_texture',
  'irradiance_texture',
  'sunDirection',
  'altitudeCorrection',
  'cameraNear',
  'cameraFar',
  'geometricErrorCorrectionAmount',
  'exposure',
  'u_debugMode',
  'ellipsoidRadii',
  'albedoScale',
  'cosSunAngularRadius'
]

// RECIPROCAL_PI：getSunSkyIrradiance 的 Lambertian diffuse 用（移植规则 4）。
const RECIPROCAL_PI_GLSL = '#define RECIPROCAL_PI 0.3183098861837907'

// LUT sampler + 光谱换算 uniform：bruneton/runtime 末尾 #define 的便捷函数
// （GetSkyLuminance/GetSunAndSkyIlluminance 等）引用这些全局（Phase 0 G3 沿用模式）。
const LUT_UNIFORMS_GLSL = `
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler2D irradiance_texture;
`

// 每帧 uniform（命名对齐源仓库，spec §4.1）。
// cameraNear/cameraFar：写深度的视锥 near/far（米），CPU 每帧传入（移植规则 7）。
// u_debugMode：0=正常 1=log(1+radiance) 定标 2=太阳方向 3=相机位置量级（延续 Phase 0 诊断）。
const FRAME_UNIFORMS_GLSL = `
uniform vec3 sunDirection;
uniform vec3 altitudeCorrection;
uniform float cameraNear;
uniform float cameraFar;
uniform float geometricErrorCorrectionAmount;
uniform float exposure;
uniform float u_debugMode;
`

// [CORRECT_GEOMETRIC_ERROR] 椭球半径（长度单位 km），sphereNormal 用。
const ELLIPSOID_RADII_UNIFORM_GLSL = `
uniform vec3 ellipsoidRadii;
`

// [SUN_LIGHT || SKY_LIGHT] 反照率缩放。
const ALBEDO_SCALE_UNIFORM_GLSL = `
uniform float albedoScale;
`

// [SKY && SUN] cos(SUN_ANGULAR_RADIUS)，SUN 日盘角半径阈值。
const COS_SUN_ANGULAR_RADIUS_UNIFORM_GLSL = `
uniform float cosSunAngularRadius;
`

// 源 aerialPerspectiveEffect.frag:89-100。法线与位置同时 mix（§5.2-3：位置变化影响后续
// irradiance/transmittance 查询，两个量都必须 mix）。
// 源 vEllipsoidRadiiSquared varying → ellipsoidRadii uniform（长度单位），平方在 shader 内算。
const CORRECT_GEOMETRIC_ERROR_GLSL = `
void correctGeometricError(inout vec3 positionECEF, inout vec3 normalECEF) {
  vec3 ellipsoidRadiiSquared = ellipsoidRadii * ellipsoidRadii;
  vec3 sphereNormal = normalize(positionECEF / ellipsoidRadiiSquared);
  vec3 spherePosition = ATMOSPHERE.bottom_radius * sphereNormal;
  normalECEF = mix(normalECEF, sphereNormal, geometricErrorCorrectionAmount);
  positionECEF = mix(positionECEF, spherePosition, geometricErrorCorrectionAmount);
}
`

// 源 aerialPerspectiveEffect.frag:104-127。HAS_SHADOW 裁剪（Phase 1 无 CSM 阴影，
// 调用点 sunTransmittance 恒 1.0；参数保留待 Phase 2 接入）。
// 内部 SUN_LIGHT/SKY_LIGHT 的 GLSL #if 与源一致（#define 随 options 发射，恒一致）。
const GET_SUN_SKY_IRRADIANCE_GLSL = `
vec3 getSunSkyIrradiance(
  const vec3 positionECEF,
  const vec3 normal,
  const vec3 inputColor,
  const float sunTransmittance
) {
  // 假定 Lambertian BRDF。SUN_LIGHT/SKY_LIGHT 都不定义时本函数不生成，
  // 调用方把 inputColor 直接当 radiance（B 路径）。
  vec3 diffuse = inputColor * albedoScale * RECIPROCAL_PI;
  vec3 skyIrradiance;
  vec3 sunIrradiance = GetSunAndSkyIrradiance(positionECEF, normal, sunDirection, skyIrradiance);
  #if defined(SUN_LIGHT) && defined(SKY_LIGHT)
  return diffuse * (sunIrradiance + skyIrradiance);
  #elif defined(SUN_LIGHT)
  return diffuse * sunIrradiance;
  #elif defined(SKY_LIGHT)
  return diffuse * skyIrradiance;
  #endif // defined(SUN_LIGHT) && defined(SKY_LIGHT)
}
`

// 源 aerialPerspectiveEffect.frag:133-148。vCameraPosition varying 改为显式 cameraPosition
// 参数（Cesium 无自定义顶点 shader）；TRANSMITTANCE/INSCATTER 内部 #ifdef 与源一致。
const APPLY_TRANSMITTANCE_INSCATTER_GLSL = `
void applyTransmittanceInscatter(
  const vec3 cameraPosition,
  const vec3 positionECEF,
  const float shadowLength,
  const vec3 sunDirection,
  inout vec3 radiance
) {
  vec3 transmittance;
  vec3 inscatter = GetSkyRadianceToPoint(
    cameraPosition,
    positionECEF,
    shadowLength,
    sunDirection,
    transmittance
  );
  #ifdef TRANSMITTANCE
  radiance = radiance * transmittance;
  #endif // TRANSMITTANCE
  #ifdef INSCATTER
  radiance = radiance + inscatter;
  #endif // INSCATTER
}
`

// SUN 日盘（源 sky.glsl:48-59）：viewDotSun 越过 cosSunAngularRadius 时叠加太阳辐射，
// smoothstep 按 fragmentAngle 做边缘抗锯齿。
const SUN_DISK_GLSL = `
  float viewDotSun = dot(rayDirection, sunDirection);
  if (viewDotSun > cosSunAngularRadius) {
    float angle = acos(clamp(viewDotSun, -1.0, 1.0));
    float antialias = smoothstep(
      ATMOSPHERE.sun_angular_radius,
      ATMOSPHERE.sun_angular_radius - fragmentAngle,
      angle
    );
    radiance += transmittance * GetSolarRadiance() * antialias;
  }
`

// 源 sky.glsl:26-81 的 SUN-only 裁剪版（MOON 月盘排除；PERSPECTIVE_CAMERA 恒真移除——
// Phase 1 只支持透视相机）。
function buildSkyRadianceFn(sun: boolean): string {
  return `
vec3 getSkyRadiance(
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const float shadowLength,
  const vec3 sunDirection,
  const float fragmentAngle
) {
  vec3 transmittance;
  vec3 radiance = GetSkyRadiance(
    cameraPosition,
    rayDirection,
    shadowLength,
    sunDirection,
    transmittance
  );
${sun ? SUN_DISK_GLSL : ''}
  return radiance;
}
`
}

// 主流程（对照源 mainImage:271-390；HAS_SHADOW/HAS_OVERLAY/lightingMask/MOON 均排除）。
function buildMainFn(o: ResolvedOptions, normalNeeded: boolean): string {
  // 像素角宽度（源 frag:292-294），天空分支 SUN 日盘抗锯齿用；天空判定前计算，
  // 保持 quad 内均匀控制流（dFdx/dFdy 在分叉中行为未定义）。仅 SKY 开时需要。
  const fragmentAngleLine = o.sky
    ? `
  float fragmentAngle = length(dFdx(rayDirection) + dFdy(rayDirection)) / length(rayDirection);
`
    : ''

  const skyBranch = o.sky
    ? `
    radiance = getSkyRadiance(cameraPos_km, rayDirection, 0.0, sunDirection, fragmentAngle);
    alpha = 1.0; // §4.2 alpha 语义：天空分支恒 1
`
    : `
    // SKY 关闭：远平面直通（§4.2）
    out_FragColor = inputColor;
    return;
`

  const normalLine = normalNeeded
    ? `
    // 法线：view 空间求导重建（移植规则 2），T2 含深度间断退化回退
    vec3 normalECEF = reconstructNormalECEF(viewPosition, positionECEF);
`
    : ''

  const correctLine = o.correctGeometricError
    ? `
    correctGeometricError(positionECEF, normalECEF);
`
    : ''

  const lightingLine =
    o.sunLight || o.skyLight
      ? `
    // A 路径：反伽马后的 inputColor 当线性 albedo，大气重算照明（§3.1/§3.2）
    vec3 albedoLinear = sRGBToLinear(inputColor.rgb);
    radiance = getSunSkyIrradiance(positionECEF, normalECEF, albedoLinear, 1.0);
`
      : `
    // B 路径：保留 Cesium 颜色（已含光照），只套透射/内散射（§3.3）
    radiance = inputColor.rgb;
`

  const transmittanceLine =
    o.transmittance || o.inscatter
      ? `
    applyTransmittanceInscatter(cameraPos_km, positionECEF, 0.0, sunDirection, radiance);
`
      : ''

  return `
in vec2 v_textureCoordinates;

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 inputColor = texture(colorTexture, uv);
  float rawDepth = texture(depthTexture, uv).r;

  // 相机位置：czm_viewerPositionWC 即相机 ECEF（米）→ 大气局部坐标（§5.3 相机侧，G3 已验证）
  vec3 cameraPos_km = (czm_viewerPositionWC + altitudeCorrection) * METER_TO_LENGTH_UNIT;

  // 视线方向：ndc → czm_inverseProjection → czm_inverseView（G3 已验证模式，
  // 替代源 vRayDirection varying；Cesium 无自定义顶点 shader）
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 viewCoord = czm_inverseProjection * vec4(ndc, -1.0, 1.0);
  vec3 viewRay = normalize(viewCoord.xyz);
  vec3 rayDirection = normalize((czm_inverseView * vec4(viewRay, 0.0)).xyz);
${fragmentAngleLine}
  vec3 radiance;
  float alpha;

  // 天空判定：对原始深度判定，先于任何深度反演（移植规则 1；log 深度下 depth=1
  // 反演成远平面有限 windowZ，先反演再判会引入边界误差）
  if (rawDepth >= 1.0 - 1e-8) {
${skyBranch}
  } else {
    // —— 地表分支：log 深度反演 → 位置/法线重建 → 大气光照 → 透射/内散射 ——
    float windowZ = czm_reverseLogDepthWindow(rawDepth, cameraNear, cameraFar);
    vec3 viewPosition = reconstructViewPosition(uv, windowZ);
    vec3 worldECEF = (czm_inverseView * vec4(viewPosition, 1.0)).xyz;
    // 几何侧再中心化（移植规则 6）：altitudeCorrection 预乘 (1 - amount)
    //（源 vert:48-55 PR#23 衰减；Cesium 无自定义顶点 shader，移入 fragment）
    vec3 positionECEF = worldECEF * METER_TO_LENGTH_UNIT
      + altitudeCorrection * METER_TO_LENGTH_UNIT * (1.0 - geometricErrorCorrectionAmount);
${normalLine}${correctLine}${lightingLine}${transmittanceLine}
    alpha = inputColor.a;
  }

  // —— 诊断模式（延续 Phase 0，§4.1 u_debugMode）——
  if (u_debugMode > 2.5) {
    // 相机位置量级：length(cameraPos_km)/top_radius，地表≈0.99（近白），过大/为 0 即桥接断
    float r = length(cameraPos_km) / 6420.0;
    out_FragColor = vec4(vec3(r), 1.0);
    return;
  }
  if (u_debugMode > 1.5) {
    // 太阳方向可视化（世界系）：红=+x 绿=+y 蓝=+z
    out_FragColor = vec4(sunDirection * 0.5 + 0.5, 1.0);
    return;
  }
  if (u_debugMode > 0.5) {
    // 对数刻度看微弱 radiance：0→黑，~100→白（曝光重新定标用，§3.5）
    vec3 v = log(vec3(1.0) + max(radiance, vec3(0.0))) / log(100.0);
    out_FragColor = vec4(clamp(v, 0.0, 1.0), 1.0);
    return;
  }

  // 色调映射（内联 Reinhard，§3.5）→ 显示编码（§3.2 输出端；postProcess 末端无 gamma 编码）。
  // B 路径走同一输出端是 §3.3 对照路径的已知近似（inputColor 为 display-referred sRGB）。
  radiance = radiance * exposure;
  radiance = radiance / (vec3(1.0) + radiance);
  out_FragColor = vec4(linearToSRGB(radiance), alpha);
}
`
}

// 组装 PostProcessStage 用 fragment shader（含 czm_* automatic uniform 引用，仅供 Cesium 运行时）。
// 结构：prefix + RECIPROCAL_PI + 宏 defines（须在 bruneton/runtime 前，GROUND 被其消费）
// + T1/T2/T3 GLSL 片段 + uniforms + bruneton common/runtime + 自有函数 + main。
export function buildAerialPerspectiveFragmentShader(
  options: AerialPerspectiveFragOptions = {}
): string {
  const o: ResolvedOptions = {
    sunLight: true,
    skyLight: true,
    transmittance: true,
    inscatter: true,
    sun: true,
    ground: true,
    correctGeometricError: true,
    sky: true,
    ...options
  }
  // 只有 correctGeometricError / SUN_LIGHT / SKY_LIGHT 消费 normalECEF（移植规则 5）
  const normalNeeded = o.correctGeometricError || o.sunLight || o.skyLight

  const defines: string[] = []
  if (o.sunLight) defines.push('#define SUN_LIGHT')
  if (o.skyLight) defines.push('#define SKY_LIGHT')
  if (o.transmittance) defines.push('#define TRANSMITTANCE')
  if (o.inscatter) defines.push('#define INSCATTER')
  if (o.sun) defines.push('#define SUN')
  if (o.ground) defines.push('#define GROUND')
  if (o.correctGeometricError) defines.push('#define CORRECT_GEOMETRIC_ERROR')
  if (o.sky) defines.push('#define SKY')
  if (normalNeeded) defines.push('#define RECONSTRUCT_NORMAL')

  const uniforms: string[] = [LUT_UNIFORMS_GLSL, FRAME_UNIFORMS_GLSL]
  if (o.correctGeometricError) uniforms.push(ELLIPSOID_RADII_UNIFORM_GLSL)
  if (o.sunLight || o.skyLight) uniforms.push(ALBEDO_SCALE_UNIFORM_GLSL)
  if (o.sky && o.sun) uniforms.push(COS_SUN_ANGULAR_RADIUS_UNIFORM_GLSL)

  const functions: string[] = []
  if (o.correctGeometricError) functions.push(CORRECT_GEOMETRIC_ERROR_GLSL)
  if (o.sunLight || o.skyLight) functions.push(GET_SUN_SKY_IRRADIANCE_GLSL)
  if (o.transmittance || o.inscatter)
    functions.push(APPLY_TRANSMITTANCE_INSCATTER_GLSL)
  if (o.sky) functions.push(buildSkyRadianceFn(o.sun))

  const body = resolveIncludes(
    [
      ...uniforms,
      '#include "bruneton/common"\n#include "bruneton/runtime"',
      ...functions,
      buildMainFn(o, normalNeeded)
    ].join('\n'),
    {
      bruneton: {
        common: glslIndex.bruneton.common,
        runtime: glslIndex.bruneton.runtime
      }
    }
  )

  return [
    buildAtmospherePrefix(),
    RECIPROCAL_PI_GLSL,
    defines.join('\n'),
    LOG_DEPTH_GLSL,
    normalNeeded ? RECONSTRUCT_NORMAL_GLSL : '',
    COLOR_SPACE_GLSL,
    body
  ]
    .filter(s => s.length > 0)
    .join('\n')
}

// 供 Task 8 glslang 独立校验：补 #version 300 es + precision + Cesium 自动注入符号的桩。
// LUT sampler/光谱 uniform 已在主体中声明（PostProcessStage 运行时也需要），不重复打桩。
const VALIDATION_STUBS_GLSL = `
// —— czm_* automatic uniform 桩（运行时由 Cesium 注入）——
uniform mat4 czm_inverseProjection;
uniform mat4 czm_inverseView;
uniform vec3 czm_viewerPositionWC;
// —— PostProcessStage 内建纹理/输出桩（运行时由 Cesium 注入）——
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
out vec4 out_FragColor;
`

export function buildStandaloneShaderForValidation(
  options: AerialPerspectiveFragOptions = {}
): string {
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp sampler3D;',
    VALIDATION_STUBS_GLSL,
    buildAerialPerspectiveFragmentShader(options)
  ].join('\n')
}
