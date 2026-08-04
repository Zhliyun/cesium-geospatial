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
// 架构（phase2a HDR 管线）：本 stage 合并天空+地面，末端输出线性 finalColor·exposure（HalfFloat RT）；
// ACES+gamma+dithering 已拆到链尾独立 tonemap stage（tonemap.frag.ts）收尾。源库双 stage（天空 HDR →
// 地面 ACES）是为云预留中间 HDR；我无云，单 atmosphere stage 末端线性 + 链尾 tonemap 逻辑等价，
// 且支持 tonemap debug=7 HDR 归一化验证。
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
  'cosSunAngularRadius',
  'u_distanceScale',
  'u_inscatterScale'
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
// u_debugMode：0=正常 1=log(1+finalColor) 2=太阳方向 3=相机 r 量级 5=depth/r 6=透传 inputColor 7=线性输出（HDR 链验证，由 tonemap 归一化）。
// u_groundDim：地面反射衰减（分离 exposure——exposure 管 inscatter/天空，groundDim 单独压地面过曝）。
const FRAME_UNIFORMS_GLSL = `
uniform vec3 sunDirection;
uniform vec3 altitudeCorrection;
uniform float exposure;
uniform float u_debugMode;
uniform float u_groundDim;
uniform float u_distanceScale;  // 散射距离缩放（方案 A，等效空气密度倍率；1.0=phase1 物理，>1 中近距散射强）
uniform float u_inscatterScale;  // inscatter 放大（方案 B 远处白雾浓；1.0=phase1 物理，>1 远处雾浓，可超物理饱和）
`

// [SKY && SUN] cos(SUN_ANGULAR_RADIUS)，SUN 日盘角半径阈值。
const COS_SUN_ANGULAR_RADIUS_UNIFORM_GLSL = `
uniform float cosSunAngularRadius;
`

// 辅助函数（移植源库 aerialPerspectiveEffect.frag + AtmospherePostProcess）。
const HELPERS_GLSL = `
// interleaved gradient noise（屏幕空间低频噪声，input dithering 用，无纹理依赖）。
// ACESFilmic + tonemapDisplay 已迁到链尾 tonemap.frag.ts（atmosphere 末端输出线性 HalfFloat，
// 由独立 tonemap stage 做 ACES+gamma+dithering 收尾；此处仅留 input dithering 用的噪声函数）。
float interleavedGradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
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
// GetSkyRadianceToPointScaled：散射距离缩放 wrapper（方案 A，等效空气密度倍率）。
//
// 本函数是 bruneton/runtime.glsl GetSkyRadianceToPoint（9 参，L253-371）+ GetSkyLuminanceToPoint
// （L427-434，光谱→亮度换算）的合并 5 参 drop-in——main 现有 GetSkyRadianceToPoint(5 参) 因 runtime 末尾
// #define GetSkyRadianceToPoint GetSkyLuminanceToPoint 实际命中 GetSkyLuminanceToPoint，故 wrapper 须同样
// 5 参 + 末端 ×SKY_SPECTRAL_RADIANCE_TO_LUMINANCE 才等效。
//
// **唯一物理改动**：Length d = length(point - camera) * u_distanceScale（散射距离缩放，等效空气密度倍率）。
// u_distanceScale=1.0 时 d×1=d，与原 GetSkyRadianceToPoint→GetSkyLuminanceToPoint 链路 bit 等价（phase1 零回归）。
// 其余 r_p/mu_p/mu_s_p/GetTransmittance/GetCombinedScattering/shadow_transmittance 全部用缩放后的 d 自动跟随。
//
// atmosphere/transmittance_texture/scattering_texture/single_mie_scattering_texture 用 bruneton runtime
// #include 的全局（const ATMOSPHERE + LUT_UNIFORMS_GLSL sampler）；helper（ClipAtBottomAtmosphere/
// GetTransmittance/GetCombinedScattering/GetScattering/RayleighPhaseFunction/MiePhaseFunction/
// GetExtrapolatedSingleMieScattering 等）同在 runtime #include，不重复声明。
vec3 GetSkyRadianceToPointScaled(
    Position camera, Position point, const Length shadow_length,
    const Direction sun_direction, out vec3 transmittance) {
  // @shotamatsuda: Avoid artifacts when the ray does not intersect the top
  // atmosphere boundary.
  if (length(ClosestPointOnRay(camera, point)) > ATMOSPHERE.top_radius) {
    transmittance = vec3(1.0);
    return vec3(0.0);
  }

  Direction view_ray = normalize(point - camera);
  if (ClipAtBottomAtmosphere(ATMOSPHERE, view_ray, camera, point)) {
    transmittance = vec3(1.0);
    return vec3(0.0);
  }

  // Compute the distance to the top atmosphere boundary along the view ray,
  // assuming the viewer is in space (or NaN if the view ray does not intersect
  // the atmosphere).
  Length r = length(camera);
  Length rmu = dot(camera, view_ray);
  // @shotamatsuda: Use SafeSqrt instead.
  // See: https://github.com/takram-design-engineering/three-geospatial/pull/26
  Length distance_to_top_atmosphere_boundary = -rmu -
      SafeSqrt(rmu * rmu - r * r +
          ATMOSPHERE.top_radius * ATMOSPHERE.top_radius);
  // If the viewer is in space and the view ray intersects the atmosphere, move
  // the viewer to the top atmosphere boundary (along the view ray):
  if (distance_to_top_atmosphere_boundary > 0.0 * m) {
    camera = camera + view_ray * distance_to_top_atmosphere_boundary;
    r = ATMOSPHERE.top_radius;
    rmu += distance_to_top_atmosphere_boundary;
  }

  // Compute the r, mu, mu_s and nu parameters for the first texture lookup.
  Number mu = rmu / r;
  Number mu_s = dot(camera, sun_direction) / r;
  Number nu = dot(view_ray, sun_direction);
  // 散射距离缩放（方案 A，等效空气密度倍率）：u_distanceScale=1.0 时与原 GetSkyRadianceToPoint 等价。
  Length d = length(point - camera) * u_distanceScale;
  bool ray_r_mu_intersects_ground = RayIntersectsGround(ATMOSPHERE, r, mu);

  // @shotamatsuda: Hack to avoid rendering artifacts near the horizon, due to
  // finite atmosphere texture resolution and finite floating point precision.
  // See: https://github.com/ebruneton/precomputed_atmospheric_scattering/pull/32
  if (!ray_r_mu_intersects_ground) {
    Number mu_horizon = -SafeSqrt(1.0 -
        (ATMOSPHERE.bottom_radius * ATMOSPHERE.bottom_radius) / (r * r));
    const Number eps = 0.004;
    mu = max(mu, mu_horizon + eps);
  }

  transmittance = GetTransmittance(ATMOSPHERE, transmittance_texture,
      r, mu, d, ray_r_mu_intersects_ground);

  IrradianceSpectrum single_mie_scattering;
  IrradianceSpectrum scattering = GetCombinedScattering(
      ATMOSPHERE, scattering_texture, single_mie_scattering_texture,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground,
      single_mie_scattering);

  // Compute the r, mu, mu_s and nu parameters for the second texture lookup.
  // If shadow_length is not 0 (case of light shafts), we want to ignore the
  // scattering along the last shadow_length meters of the view ray, which we
  // do by subtracting shadow_length from d (this way scattering_p is equal to
  // the S|x_s=x_0-lv term in Eq. (17) of our paper).
  d = max(d - shadow_length, 0.0 * m);
  Length r_p = ClampRadius(ATMOSPHERE, sqrt(d * d + 2.0 * r * mu * d + r * r));
  Number mu_p = (r * mu + d) / r_p;
  Number mu_s_p = (r * mu_s + d * nu) / r_p;

  IrradianceSpectrum single_mie_scattering_p;
  IrradianceSpectrum scattering_p = GetCombinedScattering(
      ATMOSPHERE, scattering_texture, single_mie_scattering_texture,
      r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground,
      single_mie_scattering_p);

  // Combine the lookup results to get the scattering between camera and point.
  DimensionlessSpectrum shadow_transmittance = transmittance;
  if (shadow_length > 0.0 * m) {
    // This is the T(x,x_s) term in Eq. (17) of our paper, for light shafts.
    shadow_transmittance = GetTransmittance(ATMOSPHERE, transmittance_texture,
        r, mu, d, ray_r_mu_intersects_ground);
  }
  // @shotamatsuda: Occlude only single Rayleigh scattering by the shadow.
#ifdef HAS_HIGHER_ORDER_SCATTERING_TEXTURE
  IrradianceSpectrum higher_order_scattering = GetScattering(
      ATMOSPHERE, higher_order_scattering_texture,
      r, mu, mu_s, nu, ray_r_mu_intersects_ground);
  IrradianceSpectrum single_scattering = scattering - higher_order_scattering;
  IrradianceSpectrum higher_order_scattering_p = GetScattering(
      ATMOSPHERE, higher_order_scattering_texture,
      r_p, mu_p, mu_s_p, nu, ray_r_mu_intersects_ground);
  IrradianceSpectrum single_scattering_p =
      scattering_p - higher_order_scattering_p;
  scattering =
      single_scattering - shadow_transmittance * single_scattering_p +
      higher_order_scattering - transmittance * higher_order_scattering_p;
#else // HAS_HIGHER_ORDER_SCATTERING_TEXTURE
  scattering = scattering - shadow_transmittance * scattering_p;
#endif // HAS_HIGHER_ORDER_SCATTERING_TEXTURE

  single_mie_scattering =
      single_mie_scattering - shadow_transmittance * single_mie_scattering_p;
#ifdef COMBINED_SCATTERING_TEXTURES
  single_mie_scattering = GetExtrapolatedSingleMieScattering(
      ATMOSPHERE, vec4(scattering, single_mie_scattering.r));
#endif // COMBINED_SCATTERING_TEXTURES

  // Hack to avoid rendering artifacts when the sun is below the horizon.
  single_mie_scattering = single_mie_scattering *
      smoothstep(Number(0.0), Number(0.01), mu_s);

  // 末端 ×SKY_SPECTRAL_RADIANCE_TO_LUMINANCE：对齐 GetSkyLuminanceToPoint（5 参 drop-in 必需，
  // 否则 inscatter 是辐射度量级 ~1000× 小于亮度量级 → 散射不可见）。
  return (scattering * RayleighPhaseFunction(nu) + single_mie_scattering *
      MiePhaseFunction(ATMOSPHERE.mie_phase_function_g, nu)) *
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
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

// 主流程（合并天空+地面单 stage；移植源库天空判定 + B 路径合成 + 末端线性输出）。
function buildMainFn(o: ResolvedOptions): string {
  const skyBranch = o.sky
    ? `
    inscatter = getSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, fragmentAngle, transmittance);
`
    : `
    finalColor = originalColor;
    out_FragColor = vec4(finalColor * exposure, 1.0);  // 线性，链尾 tonemap 收尾
    return;
`

  return `
in vec2 v_textureCoordinates;

void main() {
  // Task 9：originalColor 读 .rgb（vec3）；colorTexture.a 是 depthTemporal 输出的 smoothDepth
  //（raw log-depth EMA 后），供下方 sceneDist 反演用。不再 .rgba（alpha 不再是 scene color）。
  vec3 originalColor = texture(colorTexture, v_textureCoordinates).rgb;
  // input dithering：8-bit originalColor 是 ACES banding 的源头（ACES 中间调放大 2-3 倍 → 远处渐变
  // 「水波纹」）。在源头加 triangular 噪声 ±0.5 LSB，经 ACES+gamma 映射到 display 自然打散阶梯
  //（比纯 display 空间 dithering 更高效——display dithering 只盖 output 量化，盖不住被 ACES 放大的
  // input 阶梯）。
  float inDither = interleavedGradientNoise(gl_FragCoord.xy)
    + interleavedGradientNoise(gl_FragCoord.xy + vec2(7.11, 5.17)) - 1.0;  // [-1,1] triangular
  originalColor += inDither * 1.5 / 255.0;

  // 相机位置：viewerPositionWC（ECEF 米）+ altitudeCorrection（米）→ km。camera 与后续 scenePos
  // 都用全量 altitudeCorrection，保证在同一密切球局部系（Bruneton 模型前提）。
  vec3 cameraPosition = (czm_viewerPositionWC + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vec3 rayDirection;
  reconstructRay(cameraPosition, rayDirection);

  float bottomR = ATMOSPHERE.bottom_radius;
  float topR = ATMOSPHERE.top_radius;
  float camR = length(cameraPosition);

  // —— smoothDepth 反演：为近处地形（含地平线上方山峰）提供真实 sceneDist，算前景雾、保持山体不透明。
  // **不参与 sky/ground 主分类**——分类用 lookingAtGround（平滑），避免 depthTexture 不抗锯齿在掠射地平线
  // 处逐像素硬翻转的条纹。hasScene/sceneDist 只在 foreInscatter（近处 mask>0）被消费；远处/掠射 sceneDist
  // 大 → mask=0 不读它 → 无条纹。Task 9：smoothDepth 来自 depthTemporal stage（colorTexture.a，
  // raw log-depth EMA 后），替代旧的单点 depth 读取——EMA 抑制亚像素 flicker，2-arg
  // czm_windowToEyeCoordinates 走 LOG_DEPTH 分支直接反演 log-depth（精度优于 4-arg + reverseLogDepth 两步）。
  float smoothDepth = texture(colorTexture, v_textureCoordinates).a;
  bool hasScene = false;
  float sceneDist = 0.0;
  if (smoothDepth < 1.0 - 1e-4) {  // 远平面/未加载 depth≈1 排除
    // 2-arg czm_windowToEyeCoordinates（LOG_DEPTH 分支，接收 log-depth，返回 .xyz 真眼坐标，禁 /=w）。
    vec4 eyePos = czm_windowToEyeCoordinates(vec2(gl_FragCoord.xy), smoothDepth);
    if (eyePos.z < -1e-4) {
      vec4 worldPos4 = czm_inverseView * vec4(eyePos.xyz, 1.0);
      // atmosphere 这里用 altitudeCorrection/METER_TO_LENGTH_UNIT（Bruneton 密切球 km 系，
      // sceneDist 喂 GetSkyRadianceToPoint）——与 depthTemporal reproject（纯 ECEF 米）不同！
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
  // mask = 1.0 - smoothstep(CLOSE_KM, horizonKm, sceneDist)：近 sceneDist<CLOSE_KM → mask=1（depth 前景雾）、
  // 地平线 sceneDist≈horizonKm → mask=0（基线）。edge0=CLOSE_KM < edge1=horizonKm（无 GLSL UB）。
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
    inscatter = GetSkyRadianceToPointScaled(
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
    float mask = 1.0 - smoothstep(CLOSE_KM, horizonKm, sceneDist);
    if (mask > 0.0) {
      vec3 scenePosKm = cameraPosition + rayDirection * sceneDist;
      vec3 foreTrans;
      vec3 foreInscatter = GetSkyRadianceToPointScaled(
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
  finalColor = originalColor * transmittance * u_groundDim + inscatter * u_inscatterScale;

  // —— 诊断（1=log finalColor 2=太阳方向 3=相机 r 量级 5=depth/r 6=透传 inputColor；
  //    7=线性输出 HDR 链验证，由链尾 tonemap 归一化）——
  // 整个级联被 if (u_debugMode < 6.5) 包裹：debug=7（>6.5）跳过所有可视化分支，直接落到末端线性输出
  //（finalColor*exposure，>1 原样写 HalfFloat），由链尾 tonemap stage 的 >6.5 分支做 clamp(/5,0,1)
  // 归一化验证 HDR 承载 >1（spec §5.2/§6.3）。曾因降序级联无统一上限，debug=7 被 >4.5 分支截断输出
  // depth 可视化 → HDR 验证假阴性，现已用外层包裹修复。
  if (u_debugMode < 6.5) {
    if (u_debugMode > 5.5) {
      out_FragColor = vec4(originalColor, 1.0);
      return;
    }
    if (u_debugMode > 4.5) {
      // Task 9：depth 变量已移除，debug=5 改可视化 smoothDepth（depthTemporal EMA 后的 raw log-depth）。
      out_FragColor = vec4(smoothDepth, 0.0, length(cameraPosition) / 6420.0, 1.0);
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
  }

  out_FragColor = vec4(finalColor * exposure, 1.0);  // 线性 HDR，由链尾 tonemap stage 收尾
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
  // Task 9：LOG_DEPTH 让 2-arg czm_windowToEyeCoordinates(vec2, float) 走 LOG_DEPTH 分支
  //（接收 raw log-depth，返回 .xyz 真眼坐标，.w=1/depthFromCamera 非透视 w）。
  // 4-arg czm_windowToEyeCoordinates(vec4)（reconstructRay 用）不经 LOG_DEPTH 分支，行为不变。
  defines.push('#define LOG_DEPTH')
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
// 桩 + czm_windowToEyeCoordinates 函数桩（4-arg reconstructRay 用 + 2-arg sceneDist LOG_DEPTH 用）
// + out_FragColor 桩。Task 9 移除 czm_readDepth 桩（atmosphere 改读 colorTexture.a smoothDepth）。
const VALIDATION_STUBS_GLSL = `
uniform mat4 czm_inverseView;
uniform mat4 czm_inverseProjection;
uniform vec3 czm_viewerPositionWC;
vec4 czm_windowToEyeCoordinates(vec4 p) { return p; }                      // 4-arg（reconstructRay 用）
vec4 czm_windowToEyeCoordinates(vec2 xy, float d) { return vec4(xy, -1.0, 1.0); }  // 2-arg LOG_DEPTH（sceneDist 用）
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
