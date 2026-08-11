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
import { LOG_DEPTH_GLSL } from './logDepth'

// B 路径 options：无 lighting/法线/几何误差校正（A 路径残留已弃）。
export interface AerialPerspectiveFragOptions {
  sun?: boolean // SUN：天空分支日盘（默认 true）
  sky?: boolean // SKY：天空分支存在性（默认 true；false 时远平面直通 inputColor）
  hdrDepthTemporal?: boolean // Bug3：depthTemporal stage 装配（HDR）→ 读 colorTexture.a EMA smoothLogDepth（消水波纹）；否则读 raw globe depth
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
  'u_inscatterScale',
  'u_limbGlowIntensity',
  'u_limbGlowDecayKm'
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
uniform float u_limbGlowIntensity;  // limb outer glow 强度（太空视角大气边缘向外扩散辉光；0=关，~0.3-0.8 标定）
uniform float u_limbGlowDecayKm;  // limb glow 向外指数衰减距离（km；~20-40 控制扩散范围）
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
    finalColor = originalColor.rgb;
#ifdef DEPTH_TEMPORAL_EMA
    out_FragColor = vec4(finalColor * exposure, 1.0);  // Bug3：HDR .a=smoothLogDepth 不透传（专家1 M1）
#else
    out_FragColor = vec4(finalColor * exposure, originalColor.a);  // UNSIGNED_BYTE main 行为
#endif
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

  // —— 视线几何量前移（Phase 1.2）：5-tap 段的 muLook 门控需在 depth 采样前拿到视角量 ——
  // 相机位置：viewerPositionWC（ECEF 米）+ altitudeCorrection（米）→ km。camera 与后续 scenePos
  // 都用全量 altitudeCorrection，保证在同一密切球局部系（Bruneton 模型前提）。
  vec3 cameraPosition = (czm_viewerPositionWC + altitudeCorrection) * METER_TO_LENGTH_UNIT;
  vec3 rayDirection;
  reconstructRay(cameraPosition, rayDirection);
  vec3 radialOut = normalize(cameraPosition);
  // 视线与径向（天顶方向）余弦：垂直俯视 |muLook|→1，掠射 |muLook|→0。平滑、不读 depth、无循环依赖
  //（Phase 1.2 5-tap 视角自适应门控用；绝不用 mask/sceneDist 门控——判定信号本身在抖会造边界条纹）。
  float muLook = dot(rayDirection, radialOut);

  // depth 反演（Bug1）：czm_reverseLogDepthWindow 显式反演 log-depth → 线性 window depth（PostProcessStage
  // 无 LOG_DEPTH define，czm_readDepth 返回 raw logDepth → 4-arg 反投影错）。near/far 用 czm_currentFrustum。
  // Bug4：5-tap 邻域平均（log-depth 域 ≈ 几何平均距离）抗 depth 高频抖 → 消波纹（sceneDist 抖放大 inscatter
  //   等高线）。空间平滑替代 temporal EMA（Bug3 EMA reproject 错误，专家3 C3 验证失败已回退）。
  // Bug6：hasScene 判定用中心 tap（tapC）非 5-tap 平均 logDepth——5-tap far-plane 排除（tap<1.0）使地形边缘
  //   像素的平均 logDepth 从 far-plane 邻居混入降到 <0.5 → 错误过 depth<1.0 → 反演 → hasScene 翻转 → 地平线
  //   地形描边（debug=9 B 蓝边确认）。分离：hasScene 用 tapC（中心像素真实地形判定），sceneDist 用 5-tap 平均。
#ifdef DEPTH_TEMPORAL_EMA
  float logDepth = originalColor.a;  // depthTemporal[0] 输出 vec4(sceneColor.rgb, smoothLogDepth)（已平滑）
  float tapC = originalColor.a;  // Bug6：中心 tap 与平均一致（EMA 路径无 5-tap）
#else
  float tapC = texture(depthTexture, v_textureCoordinates).r;  // 中心 tap：hasScene 判定用（Bug6）
  float logDepth = 1.0;  // 默认 far-plane（tapC>=1.0 时跳过 4 邻域，省天空区 80% depth 采样，Phase 1.0）
  if (tapC < 1.0) {  // tapC 早退：仅地面像素才考虑空间平滑（天空/未渲染 4 邻域 fetch 对输出零影响）
    // Phase 1.2：垂直俯视（|muLook|→1）保留 5-tap（Bug4 有效场景，空间高频抖可空间平滑消）；
    // 掠射（|muLook|→0）降 tap 退中心 tap（5-tap 对掠射无效=depth 时序跳非空间高频，results:50）。
    // muLook 门控（平滑、不读 depth、无循环依赖——绝不用 mask/sceneDist 门控，那判定信号本身在抖会造边界条纹）；
    // smoothstep 连续过渡避免 tap 数硬切换分界线；掠射退中心 tap（对称，禁 3-tap 十字防方向性偏置 ×25）。
    // 过渡带 (0.15,0.3)：仅极掠射（|muLook|<0.3，如低空水平视线 bug6≈0.075）降 tap；中高空地球边缘
    // （|muLook|≈0.4-0.5，如 camera-high-graze≈0.36、高空俯视地球边缘≈0.5）保留 5-tap——后者是 inscatter
    // 阶梯敏感区（Bug5 圆圈阶梯），tap 切换会改 sceneDist → 阶梯回归（maxΔ=43 实证）。5-tap 对纯极掠射无效
    // （depth 时序跳非空间高频），但对地球边缘过渡带仍有空间平滑价值，故阈值收窄到极掠射。
    float useSpatial = smoothstep(0.15, 0.3, abs(muLook));
    if (useSpatial > 0.5) {  // 垂直俯视：5-tap 空间平滑（Bug4）
      vec2 depthTexel = 1.0 / vec2(textureSize(depthTexture, 0));
      float tapR = texture(depthTexture, v_textureCoordinates + vec2(depthTexel.x, 0.0)).r;
      float tapL = texture(depthTexture, v_textureCoordinates - vec2(depthTexel.x, 0.0)).r;
      float tapU = texture(depthTexture, v_textureCoordinates + vec2(0.0, depthTexel.y)).r;
      float tapD = texture(depthTexture, v_textureCoordinates - vec2(0.0, depthTexel.y)).r;
      float tapSum = tapC;  // tapC<1.0 必计入
      float tapCount = 1.0;
      if (tapR < 1.0) { tapSum += tapR; tapCount += 1.0; }
      if (tapL < 1.0) { tapSum += tapL; tapCount += 1.0; }
      if (tapU < 1.0) { tapSum += tapU; tapCount += 1.0; }
      if (tapD < 1.0) { tapSum += tapD; tapCount += 1.0; }
      logDepth = tapSum / tapCount;  // 5-tap 平均：sceneDist 距离用（tapCount>=1.0 必 >0.5，三元简化为除法）
    } else {  // 掠射：中心 tap（5-tap 无效，省 4 fetch）
      logDepth = tapC;
    }
  }
#endif
  float depth = czm_reverseLogDepthWindow(logDepth, czm_currentFrustum.x, czm_currentFrustum.y);
  // Bug6：hasSceneDepth 用 tapC（中心像素，真实地形判定）；depth 用 5-tap 平均（sceneDist 距离平滑）。
  float hasSceneDepth = czm_reverseLogDepthWindow(tapC, czm_currentFrustum.x, czm_currentFrustum.y);

  float bottomR = ATMOSPHERE.bottom_radius;
  float topR = ATMOSPHERE.top_radius;
  float camR = length(cameraPosition);

  // —— depth 反演：为近处地形（含地平线上方山峰）提供真实 sceneDist，算前景雾、保持山体不透明。**不参与
  // sky/ground 主分类**——分类用 lookingAtGround（平滑），避免 depthTexture 不抗锯齿在掠射地平线处逐像素
  // 硬翻转的条纹。hasScene/sceneDist 只在 foreInscatter（近处 mask>0）被消费；远处/掠射 sceneDist 大
  // → mask=0 不读它 → 无条纹。
  bool hasScene = false;
  float sceneDist = 0.0;
  if (hasSceneDepth < 1.0) {  // Bug6：中心 tap 判定（防 5-tap far-plane 排除翻转边缘 hasScene）
    vec4 eyePos = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, depth, 1.0));  // sceneDist 用 5-tap 平均 depth
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
  // radialOut/muLook 已前移到 depth 采样前（Phase 1.2 门控用）；此处直接用前移的 muLook。
  bool hitBottom = rayForwardHitsSphere(cameraPosition, rayDirection, bottomR);
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
  // Bug5：mask 改用正向窄过渡 smoothstep(CLOSE_KM*2, CLOSE_KM, sceneDist)（原 horizonKm 反向已弃，详见 Bug5 注释）。
  const float CLOSE_KM = 20.0;
  // 椭球面交点 tHitG（ground 基线距离用）。
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
  // 近处地形按 mask 叠加 depth 前景雾 → 山体不透明。mask>0 才算 foreInscatter（远处省 LUT）。
  // Bug5：mask 改正向窄过渡 smoothstep(CLOSE_KM, CLOSE_KM*2, sceneDist)——原 smoothstep(horizonKm, CLOSE_KM)
  // 在 camera 高（horizonKm=905km > CLOSE_KM=20km）反向 + 过渡带 885km 太宽 → fore/base inscatter 在
  // sceneDist 同心圆缓慢变化 → 圆圈内外大气散射阶梯（等高线）。正向窄过渡（20~40km）让 fore 快速衰减到
  // base 基线，圆圈消失。近处 sceneDist<CLOSE_KM mask=1（山体不透明）；远处 mask→0 走基线。
  if (hasScene) {
    float mask = smoothstep(CLOSE_KM * 2.0, CLOSE_KM, sceneDist);  // 近=1 远=0，过渡带 20km
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

  // —— limb soft fade（用户需求：limb 边缘蓝白 inscatter 缓慢渐隐到黑太空，消除硬切边缘）。
  // 根因：Bruneton GetSkyRadiance 在视线错过大气顶层(topR)时 return 0，但视线与 topR 相切(limb)时
  // inscatter = LUT(topR, 切线) 非零（切线路径穿过大气整层）→ limb 内侧非零硬切到外侧 0，明显边缘。
  // 修复：内侧 inscatter 在 over→0 时 smoothstep fade 到 0（蓝白过渡平滑收尾到黑太空）。
  // 几何：b=|cross(camera,ray)|=视线到地心最近距离(impact parameter, km)；over=b-topR。
  // over<=-decay: inscatter 不变（满）；over∈[-decay,0]: 平滑 fade 到 0；over>0: 本就 0（太空）。
  // 首版用外侧 additive glow 形成独立亮带（双边缘更差），改为内侧 fade 无额外带——本质是让 limb 处
  // 原本硬切到 0 的非零 inscatter 提前平滑渐隐（"缓慢减弱"），代价 limb 处稍暗（物理 limb 辉光由内侧已含）。
  if (u_limbGlowIntensity > 0.0) {
    float limbB = length(cross(cameraPosition, rayDirection));  // impact parameter (km)
    float limbOver = limbB - topR;
    // 1 - smoothstep(-decay, 0, over)：over<=-decay→1（内侧远处 inscatter 不变，保留大气）；
    // over∈[-decay,0]→1..0（limb 附近渐隐）；over>=0→0（与外侧黑太空连续，无硬切边缘）。
    float limbFade = 1.0 - smoothstep(-u_limbGlowDecayKm, 0.0, limbOver);
    inscatter *= limbFade;
  }

  finalColor = originalColor.rgb * transmittance * u_groundDim + inscatter * u_inscatterScale;

  // —— 诊断（1=log finalColor 2=太阳方向 3=相机 r 量级 5=depth/r 6=透传 inputColor；
  //    7=线性输出 HDR 链验证，由链尾 tonemap 归一化）——
  // 整个级联被 if (u_debugMode < 6.5) 包裹：debug=7（>6.5）跳过所有可视化分支，直接落到末端线性输出
  //（finalColor*exposure，>1 原样写 HalfFloat），由链尾 tonemap stage 的 >6.5 分支做 clamp(/5,0,1)
  // 归一化验证 HDR 承载 >1（spec §5.2/§6.3）。曾因降序级联无统一上限，debug=7 被 >4.5 分支截断输出
  // depth 可视化 → HDR 验证假阴性，现已用外层包裹修复。
  if (u_debugMode < 6.5) {
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
  }

#ifdef DEPTH_TEMPORAL_EMA
  out_FragColor = vec4(finalColor * exposure, 1.0);  // Bug3：HDR .a=smoothLogDepth 不透传（专家1 M1：display alpha）
#else
  out_FragColor = vec4(finalColor * exposure, originalColor.a);  // UNSIGNED_BYTE main 行为
#endif
  // 线性 HDR，由链尾 tonemap stage 收尾
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
    hdrDepthTemporal: false,
    ...options
  }

  const defines: string[] = ['#define GROUND'] // runtime RayIntersectsGround 用
  if (o.sun) defines.push('#define SUN')
  if (o.sky) defines.push('#define SKY')
  if (o.hdrDepthTemporal) defines.push('#define DEPTH_TEMPORAL_EMA') // Bug3：HDR 读 depthTemporal .a

  const uniforms: string[] = [POST_PROCESS_TEXTURES_GLSL, LUT_UNIFORMS_GLSL, FRAME_UNIFORMS_GLSL]
  if (o.sky && o.sun) uniforms.push(COS_SUN_ANGULAR_RADIUS_UNIFORM_GLSL)

  // LOG_DEPTH_GLSL：czm_reverseLogDepthWindow（main depth 反演用）+ 配套反演辅助（logDepth.ts）。
  const functions: string[] = [HELPERS_GLSL, LOG_DEPTH_GLSL]
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
uniform vec2 czm_currentFrustum;  // near(.x)/far(.y)，czm_reverseLogDepthWindow 用
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
