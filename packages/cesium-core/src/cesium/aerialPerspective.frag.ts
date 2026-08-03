// B 路径大气透视 PostProcessStage fragment（完全参考 cesium-clouds-atmosphere）。
//
// 对照源库（/Users/zhangliyun/Documents/Ayvods/Web3D/cesium-clouds-atmosphere）：
// - src/AtmosphereFromThreeGeospatial/AtmospherePostProcess.js（天空 pass main + 天空判定 L375-437）
// - src/AtmosphereFromThreeGeospatial/Shaders/aerialPerspectiveEffect.frag（地面 pass + ACES + reconstructRay）
//
// 与原 A 路径的根本差异（T9 调试结论）：
// - A 路径（已弃）：getSunSkyIrradiance(albedo, normal) 重算照明 → 依赖屏幕法线重建 → 半球校正
//   临界翻转产生弧线；irradiance 是物理量需 exposure=15 → 放大 half-float LUT 灾消 → 山体透明。
// - B 路径（本文件）：finalColor = originalColor·transmittance + inscatter。不碰法线、不重算照明，
//   originalColor 是 Cesium 光照后的显示量级，exposure≈1.5 即可，灾消被压制 10×。
//   cesium-clouds-atmosphere 用同样 half-float LUT 但工作正常，证明问题在集成方式而非 LUT。
//
// 保留我的架构（比源库双 stage 更简洁）：单 PostProcessStage 合并天空+地面，末端 ACES tonemap。
// 源库双 stage（天空 HDR → 地面 ACES）是为云预留中间 HDR；我无云，单 stage 末端 ACES 逻辑等价。
//
// Cesium 地形适配（源库 demo 无地形，不需；我必需，保留）：
// - depthTestAgainstTerrain=true（AtmosphereStage 设）：PostProcess depthTexture 拿真实地形深度。
// - 对数深度：地形 z-fighting 必需。
// - 天空判定不单凭 rawDepth：Cesium 地平线出屏时 depth plane 写假 depth，用 brunetonIntersectsGround
//   + 亮度兜底（移植源库 L375-437）。
//
// 前提：WebGL2（sampler3D/dFdx/GLSL ES 3.00）。PostProcessStage 运行时 Cesium 自动注入
// czm_*/out_FragColor/v_textureCoordinates；独立 glslang 校验走 buildStandaloneShaderForValidation。

import { glslIndex } from '../glslIndex'
import { resolveIncludes } from '../resolveIncludes'
import { buildAtmospherePrefix } from './cesiumCore'

// B 路径 options：无 lighting/法线/几何误差校正（A 路径残留已弃）。
export interface AerialPerspectiveFragOptions {
  sun?: boolean // SUN：天空分支日盘（默认 true）
  sky?: boolean // SKY：天空分支存在性（默认 true；false 时远平面直通 inputColor）
}

type ResolvedOptions = Required<AerialPerspectiveFragOptions>

// 供 Task 6 接线一致性测试：本 shader 跨全部宏组合可能声明的 uniform 超集（命名对齐源仓库）。
export const AERIAL_PERSPECTIVE_UNIFORM_NAMES: string[] = [
  'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'transmittance_texture',
  'scattering_texture',
  'single_mie_scattering_texture',
  'irradiance_texture',
  'sunDirection',
  'altitudeCorrection',
  'exposure',
  'u_debugMode',
  'u_groundDim',
  'cosSunAngularRadius'
]

// Cesium PostProcessStage 内建纹理 uniform——必须由 shader 显式声明（Cesium 仅提供 uniform 值，
// 不自动注入声明；见 @cesium/engine Scene/PostProcessStage.js）。
const POST_PROCESS_TEXTURES_GLSL = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
`

// LUT sampler + 光谱换算 uniform：bruneton/runtime 末尾 #define 的便捷函数引用这些全局。
const LUT_UNIFORMS_GLSL = `
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler2D irradiance_texture;
`

// 每帧 uniform（命名对齐源仓库）。altitudeCorrection 单位米（shader 内 *METER_TO_LENGTH_UNIT 转 km）。
// u_debugMode：0=正常 1=log(1+finalColor) 2=太阳方向 3=相机 r 量级 5=depth/r 6=透传 inputColor。
// u_groundDim：地面反射衰减（分离 exposure——exposure 管 inscatter/天空，groundDim 单独压地面过曝）。
const FRAME_UNIFORMS_GLSL = `
uniform vec3 sunDirection;
uniform vec3 altitudeCorrection;
uniform float exposure;
uniform float u_debugMode;
uniform float u_groundDim;
`

// [SKY && SUN] cos(SUN_ANGULAR_RADIUS)，SUN 日盘角半径阈值。
const COS_SUN_ANGULAR_RADIUS_UNIFORM_GLSL = `
uniform float cosSunAngularRadius;
`

// 辅助函数（移植源库 aerialPerspectiveEffect.frag + AtmospherePostProcess）。
const HELPERS_GLSL = `
// ACES filmic tonemap（源库 aerialPerspectiveEffect.frag:37-44）。
vec3 ACESFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// interleaved gradient noise（屏幕空间低频噪声，dithering 用，无纹理依赖）。
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
// 线性 HDR → 显示：ACES + gamma 1/2.2 + dithering。单次 OETF，B 路径末端统一（对齐源库 tonemapDisplay）。
// dithering：display 空间加 ±0.5/255 噪声，打破 8-bit framebuffer 量化阶梯。ACES 在中间调拉伸输入会
// 放大 8-bit 量化 → 远处渐变 banding（「水波纹」）；源库用 float HDR render target 无此问题，Cesium
// globe 只到 RGBA8，故需 dithering。
vec4 tonemapDisplay(vec3 linearHdr, float a) {
  // ACES filmic + gamma 1/2.2（对齐源库 tonemapDisplay，对比度强、太阳盘自然；Reinhard 偏灰白弃用）。
  // display triangular dithering ±1.5 LSB 打散 8-bit output 量化；ACES 暗部放大 input 的 banding 由
  // main 入口的 input dithering 在源头（originalColor）打散。
  vec3 c = ACESFilmic(linearHdr);
  c = pow(c, vec3(1.0 / 2.2));
  float dither = interleavedGradientNoise(gl_FragCoord.xy)
    + interleavedGradientNoise(gl_FragCoord.xy + vec2(7.11, 5.17)) - 1.0;  // [-1,1] triangular
  c += dither * 1.5 / 255.0;
  return vec4(c, a);
}
// 视线重建：czm_windowToEyeCoordinates 近/远平面差分（源库 reconstructRay）。
// 避免 ndc + inverseProjection 在仰视净空 / log-depth / 多视锥下方向退化。
void reconstructRay(const vec3 cameraPosition, out vec3 rd) {
  vec4 eyeNear = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, 0.0, 1.0));
  vec4 eyeFar = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, 1.0, 1.0));
  if (abs(eyeNear.w) > 1e-10) eyeNear /= eyeNear.w;
  if (abs(eyeFar.w) > 1e-10) eyeFar /= eyeFar.w;
  vec3 dirEC = eyeFar.xyz - eyeNear.xyz;
  if (dot(dirEC, dirEC) < 1e-20) dirEC = eyeFar.xyz;
  rd = normalize((czm_inverseView * vec4(normalize(dirEC), 0.0)).xyz);
}
// 射线 o+t·d 与半径 R 的球是否存在 t>eps 的前向交点（源库 rayForwardHitsSphere）。
bool rayForwardHitsSphere(vec3 o, vec3 d, float R) {
  float b = dot(o, d);
  float c = dot(o, o) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  return (-b - s > 1e-6) || (-b + s > 1e-6);
}
// 相机是否在大气壳层（bottom < r < top），源库 cameraInAtmosphereShell。
bool cameraInAtmosphereShell(vec3 o, float bottomR, float topR) {
  float r = length(o);
  return r > bottomR + 1e-5 && r < topR - 1e-5;
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

// 天空 inscatter getSkyRadiance（SUN-only 裁剪版，MOON/PERSPECTIVE_CAMERA 排除）。
// transmittance 经 out 参数输出，供统一合成（originalColor·trans·groundDim + inscatter）复用——
// 天空像素 originalColor=clearColor 黑，trans 不影响其最终色；山峰（视线判天空）靠 trans 衰减地形色。
function buildSkyRadianceFn(sun: boolean): string {
  return `
vec3 getSkyRadiance(
  const vec3 cameraPosition,
  const vec3 rayDirection,
  const float shadowLength,
  const vec3 sunDirection,
  const float fragmentAngle,
  out vec3 transmittance
) {
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

// 主流程（合并天空+地面单 stage；移植源库天空判定 + B 路径合成 + ACES）。
function buildMainFn(o: ResolvedOptions): string {
  const skyBranch = o.sky
    ? `
    inscatter = getSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, fragmentAngle, transmittance);
`
    : `
    finalColor = originalColor.rgb;
    out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
    return;
`

  return `
in vec2 v_textureCoordinates;

void main() {
  vec4 originalColor = texture(colorTexture, v_textureCoordinates);
  // input dithering：8-bit originalColor 是 ACES banding 的源头（ACES 中间调放大 2-3 倍 → 远处渐变
  // 「水波纹」）。在源头加 triangular 噪声 ±0.5 LSB，经 ACES+gamma 映射到 display 自然打散阶梯
  //（比纯 display 空间 dithering 更高效——display dithering 只盖 output 量化，盖不住被 ACES 放大的
  // input 阶梯）。
  float inDither = interleavedGradientNoise(gl_FragCoord.xy)
    + interleavedGradientNoise(gl_FragCoord.xy + vec2(7.11, 5.17)) - 1.0;  // [-1,1] triangular
  originalColor.rgb += inDither * 1.5 / 255.0;
  float depth = czm_readDepth(depthTexture, v_textureCoordinates);

  // 相机位置：viewerPositionWC（ECEF 米）+ altitudeCorrection（米）→ km。camera 与后续 scenePos
  // 都用全量 altitudeCorrection，保证在同一密切球局部系（Bruneton 模型前提）。
  vec3 cameraPosition = (czm_viewerPositionWC + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vec3 rayDirection;
  reconstructRay(cameraPosition, rayDirection);

  float bottomR = ATMOSPHERE.bottom_radius;
  float topR = ATMOSPHERE.top_radius;
  float camR = length(cameraPosition);

  // —— depth 反演：为近处地形（含地平线上方山峰）提供真实 sceneDist，算前景雾、保持山体不透明。**不参与
  // sky/ground 主分类**——分类用 lookingAtGround（平滑），避免 depthTexture 不抗锯齿在掠射地平线处逐像素
  // 硬翻转的条纹。hasScene/sceneDist 只在 foreInscatter（近处 mask>0）被消费；远处/掠射 sceneDist 大
  // → mask=0 不读它 → 无条纹。
  bool hasScene = false;
  float sceneDist = 0.0;
  if (depth < 1.0) {
    vec4 eyePos = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, depth, 1.0));
    if (abs(eyePos.w) > 1e-6) {
      eyePos /= eyePos.w;
      if (eyePos.z < -1e-4) {
        vec4 worldPos4 = czm_inverseView * eyePos;
        vec3 sceneWorldPosKm = worldPos4.xyz * METER_TO_LENGTH_UNIT
          + altitudeCorrection * METER_TO_LENGTH_UNIT;
        float sceneR = length(sceneWorldPosKm);
        // 反演点在大气层内（容 5km 反演误差）= 真实地形；far plane 反演点 r 巨大被排除。
        if (sceneR < topR + 5.0 && sceneR > bottomR - 5.0) {
          hasScene = true;
          sceneDist = length(sceneWorldPosKm - cameraPosition);
        }
      }
    }
  }

  // —— 几何判定（视线方向，平滑）——
  bool hitBottom = rayForwardHitsSphere(cameraPosition, rayDirection, bottomR);
  vec3 radialOut = normalize(cameraPosition);
  float muLook = dot(rayDirection, radialOut);
  bool brunetonIntersectsGround = RayIntersectsGround(ATMOSPHERE, camR, muLook);
  // 视线是否指向地球（与地表前向相交）—— sky/ground inscatter 函数选择的主判据（平滑，不读 depth）。
  bool lookingAtGround = brunetonIntersectsGround || hitBottom;

  // SUN 日盘抗锯齿每像素角宽度（dFdx/dFdy 必须在分叉前算，quad 内控制流一致）
  float fragmentAngle = length(dFdx(rayDirection) + dFdy(rayDirection)) / length(rayDirection);

  // 椭球面交点判别（ground inscatter 距离 tHitG 用，所有地面像素统一）。
  float bG = dot(cameraPosition, rayDirection);
  float cG = dot(cameraPosition, cameraPosition) - bottomR * bottomR;
  float discG = bG * bG - cG;

  // —— DUAL inscatter：平滑基线 + depth 前景雾，mask 过渡带终点在地平线 → 分界线与地平线重合 ——
  // baseInscatter（平滑、不读 depth → 无掠射条纹）：地面→椭球面 tHitG，天空→getSkyRadiance。
  // foreInscatter（depth 真实距离 sceneDist → 山体不透明、前景雾正确）：hasScene 且 mask>0 时叠加。
  // mask = smoothstep(horizonKm, CLOSE_KM, sceneDist)：近=1（depth）、地平线 sceneDist≈horizonKm → mask=0（基线）。
  // horizonKm = 相机到椭球面切线距离（随高度自适应 √(camR²-bottomR²)）→ 过渡带终点在地平线，分界线与地平线
  // 重合。wide band → 渐变无硬弧。曾试 mask 用 tHitG 消除地平线轮廓残余闪动，但 tHitG>sceneDist → ground 过早
  // 全基线 → 分界线内移、闪动更明显，已回退用 sceneDist（残余小幅闪动为可接受代价）。
  const float CLOSE_KM = 20.0;
  float horizonKm = sqrt(max(0.0, camR * camR - bottomR * bottomR));
  // 椭球面交点 tHitG（ground 基线距离 + mask 距离用）。
  float tHitG = -1.0;
  if (discG > 0.0) {
    float sG = sqrt(discG);
    tHitG = -bG - sG;
    if (tHitG <= 1e-6) tHitG = -bG + sG;
  }
  vec3 transmittance = vec3(1.0);
  vec3 inscatter = vec3(0.0);
  vec3 finalColor;
  if (lookingAtGround && discG > 0.0) {
    // 地面基线：椭球面 tHitG（平滑）。
    vec3 scenePosKm = cameraPosition + rayDirection * tHitG;
    inscatter = GetSkyRadianceToPoint(
      cameraPosition,
      scenePosKm,
      0.0,
      sunDirection,
      transmittance
    );
  } else {
    // 天空基线（sky:false 在 skyBranch 内透传 return）。
${skyBranch}  }
  // 近处地形按 mask 叠加 depth 前景雾 → 山体不透明。mask 用 sceneDist，地平线处 mask=0 走基线（分界线与地平线
  // 重合）。mask>0 才算 foreInscatter（远处省 LUT）。
  if (hasScene) {
    float mask = smoothstep(horizonKm, CLOSE_KM, sceneDist);
    if (mask > 0.0) {
      vec3 scenePosKm = cameraPosition + rayDirection * sceneDist;
      vec3 foreTrans;
      vec3 foreInscatter = GetSkyRadianceToPoint(
        cameraPosition,
        scenePosKm,
        0.0,
        sunDirection,
        foreTrans
      );
      transmittance = mix(transmittance, foreTrans, mask);
      inscatter = mix(inscatter, foreInscatter, mask);
    }
  }
  finalColor = originalColor.rgb * transmittance * u_groundDim + inscatter;

  // —— 诊断（1=log finalColor 2=太阳方向 3=相机 r 量级 5=depth/r 6=透传 inputColor）——
  if (u_debugMode > 5.5) {
    out_FragColor = originalColor;
    return;
  }
  if (u_debugMode > 4.5) {
    out_FragColor = vec4(depth, 0.0, length(cameraPosition) / 6420.0, 1.0);
    return;
  }
  if (u_debugMode > 2.5) {
    float r = length(cameraPosition) / 6420.0;
    out_FragColor = vec4(vec3(r), 1.0);
    return;
  }
  if (u_debugMode > 1.5) {
    out_FragColor = vec4(sunDirection * 0.5 + 0.5, 1.0);
    return;
  }
  if (u_debugMode > 0.5) {
    vec3 v = log(vec3(1.0) + max(finalColor, vec3(0.0))) / log(100.0);
    out_FragColor = vec4(clamp(v, 0.0, 1.0), 1.0);
    return;
  }

  out_FragColor = tonemapDisplay(finalColor * exposure, originalColor.a);
}
`
}

// 组装 PostProcessStage 用 fragment shader（含 czm_* automatic uniform 引用，仅供 Cesium 运行时）。
// 结构：prefix + RECIPROCAL_PI + 宏 defines（须在 bruneton/runtime 前，GROUND 被其消费）
// + uniforms + bruneton common/runtime + 辅助函数 + 天空函数 + main。
export function buildAerialPerspectiveFragmentShader(
  options: AerialPerspectiveFragOptions = {}
): string {
  const o: ResolvedOptions = {
    sun: true,
    sky: true,
    ...options
  }

  const defines: string[] = ['#define GROUND'] // runtime RayIntersectsGround 用
  if (o.sun) defines.push('#define SUN')
  if (o.sky) defines.push('#define SKY')

  const uniforms: string[] = [POST_PROCESS_TEXTURES_GLSL, LUT_UNIFORMS_GLSL, FRAME_UNIFORMS_GLSL]
  if (o.sky && o.sun) uniforms.push(COS_SUN_ANGULAR_RADIUS_UNIFORM_GLSL)

  const functions: string[] = [HELPERS_GLSL]
  if (o.sky) functions.push(buildSkyRadianceFn(o.sun))

  const body = resolveIncludes(
    [
      ...uniforms,
      '#include "bruneton/common"\n#include "bruneton/runtime"',
      ...functions,
      buildMainFn(o)
    ].join('\n'),
    {
      bruneton: {
        common: glslIndex.bruneton.common,
        runtime: glslIndex.bruneton.runtime
      }
    }
  )

  return [buildAtmospherePrefix(), defines.join('\n'), body].filter(s => s.length > 0).join('\n')
}

// 供 Task 8 glslang 独立校验：补 #version 300 es + precision + Cesium 自动注入符号的桩。
// colorTexture/depthTexture 在主体 POST_PROCESS_TEXTURES_GLSL 声明；此处补 czm_* automatic uniform
// 桩 + czm_readDepth/czm_windowToEyeCoordinates 函数桩 + out_FragColor 桩。
const VALIDATION_STUBS_GLSL = `
uniform mat4 czm_inverseView;
uniform mat4 czm_inverseProjection;
uniform vec3 czm_viewerPositionWC;
vec4 czm_windowToEyeCoordinates(vec4 p) { return p; }
float czm_readDepth(sampler2D t, vec2 uv) { return 0.5; }
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
