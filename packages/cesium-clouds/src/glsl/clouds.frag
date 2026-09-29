precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;

#include <common>
#include <packing>

#include "core/depth"
#include "core/math"
#include "core/turbo"
#include "core/generators"
#include "core/raySphereIntersection"
#include "core/cascadedShadowMaps"
#include "core/interleavedGradientNoise"
#include "core/vogelDisk"

#include "atmosphere/bruneton/definitions"

uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;

uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;

#include "atmosphere/bruneton/common"
#include "atmosphere/bruneton/runtime"

#include "types"
#include "parameters"
#include "clouds"

#if !defined(RECIPROCAL_PI4)
#define RECIPROCAL_PI4 0.07957747154594767
#endif // !defined(RECIPROCAL_PI4)

uniform sampler2D depthBuffer;
uniform mat4 viewMatrix;
uniform mat4 reprojectionMatrix;
uniform mat4 viewReprojectionMatrix;
uniform float cameraNear;
uniform float cameraFar;
uniform float cameraHeight;
uniform vec2 temporalJitter;
uniform vec2 targetUvScale;
uniform float mipLevelScale;

// Scattering
const vec2 scatterAnisotropy = vec2(SCATTER_ANISOTROPY_1, SCATTER_ANISOTROPY_2);
const float scatterAnisotropyMix = SCATTER_ANISOTROPY_MIX;
uniform float skyLightScale;
uniform float groundBounceScale;
uniform float powderScale;
uniform float powderExponent;
// 夜间环境底光（2026-08-29 方向 B）：irradiance LUT 在当地太阳仰角沉没 ~5° 后精确归零，
// 云自体辐射 = 0，厚云海在 overlay 混成纯黑黑洞（吞星空底光）。物理世界夜间云由月光/
// 气辉/城市光照亮——本项为艺术近似地板（非物理光源，方向性月光见后续迭代）。
// 取值标定（2026-09-02 重标 0.12→0.03）：原 0.12 的「≈18/255 display」按线性值×255 直推，
// 漏算 ACES+gamma 1/2.2 暗部放大（实际显示 ~86/255，云顶带 150-200）；且月光（方向 C）落地后
// 两项叠加从未整体验收——深夜云带 avg 147、47% 画面 >120，而夜空底光实测仅 ~5/255（差 30 倍）。
// headed 逐档扫描定标 0.03：无月夜云带 avg 61、>120 清零（形体保留不回摆黑洞）；满月夜月光
// 主导叠加后 91（含 tonemap 饱和）——月光强时地板退让（moonFactor 联动）为后续候选。
// 冷蓝色调（2026-08-31 夜间天际线泛红修复）：applyAerialPerspective 的 transmittance 在远距
// 视线（天际线几百 km 大气路径）Rayleigh 滤蓝存红——中性白底光乘红化透射率 → 远处云泛橙红
// （实测 R/G=1.23，近景不红 0.99；moon=0 隔离排月光、nightAmbient=0 隔离定根因）。
// 底光本身给冷蓝（模拟夜空散射的蓝移谱），中距对冲红化、远景残余暖色大幅减弱。
uniform float nightAmbient;
// 月光地板退让上限（2026-09-21，nightAmbient 注 L65 遗留候选落地）：底光乘
// mix(1, 本值, moonFactor)——moonFactor=月相×月高度门（0 新月/月落，1 满月+月高）。
// 1=关（零回归域：新月/月落/白天）；<1=月光强时底光让位（非物理底光不该在月光
// 主导时还全额叠加）。URL ?cloudsNightRetreat= 即调；缺省见 cloudsDefaultParameters。
uniform float u_nightAmbientRetreat;
// 夜间云色调乘子（线性域；乘底光+月光两项）。uniform 化（2026-09-01 云偏蓝二轮反馈——
// 每轮改常量成本高，?cloudsTint= URL 即调）。沿革：冷蓝 (0.72,1,1.32)（2026-08-31 泛红修复
// 对冲远景 transmittance 红化）→ B 1.32→1.15（「偏蓝」一轮）→ 三档拍板后定稿。
uniform vec3 u_nightTint;
// 暮光天光补偿倍率（2026-09-01 黄昏云过黑拍板 A 案）：太阳 [+2°,-1.5°] 窗内 skyLightScale
// 有效倍数 1→boost。根因：天光项 crude 单次近似（无云内多次散射增强，源库自认
// "Crude approximation"）+ 云 overlay 不乘动态曝光（黄昏 atmo≈0.63 只压天空，源库云走
// 全画面后处理吃曝光——移植 overlay 架构差异）→ 暮光云线性辐射仅天空 ~28%（物理应≈90%，
// 云反照率 0.9 被天空照明应近天空亮度）。白天（>+2°）精确 1 零回归；<-6° LUT 天光归零后
// 补偿自然无效（nightAmbient 接管）。?cloudsTwilightBoost= URL 即调（1=关）；默认 6=用户
// 拍板物理档（2026-09-01，云/天空显示比 80%；档位 3 温和=51%）。
uniform float u_twilightSkyBoost;
// 层内雾化（2026-09-28 方案 A，用户拍板）：相机在云层带内（1500-2150 等层带）时 march
// 退化为「首样本即早退的单点辐射平刷」（ext≥0.1/m → exp(-0.1×50)=0.0067<minTransmittance
// 一步断；且 minStepSize=50m 地板阻止细化）→ 整下半球被近相机体素辐射平刷（稠密柱=白/蓝
// 板、帄区黑楔暗纱——1692 蓝板/1536 白板两例同机制不同天气纹素形态）。本开关启用层内
// 专用路径：步长细化铺满段长 + 早退抑制全段积分（多步积累=加权平均光照）+ radiance
// 去饱和提亮（治深部蓝 ambient）+ 出口 alpha 软化（浓雾透底=雾感非墙感）。
// 0=整路径逐位回退（门控 uniform 全屏一致，mix 恒等）。?cloudsInLayerFog= 即调。
uniform float u_inLayerFog;

// 月光方向性照明（2026-08-30 方向 C）：夜间云的第四光照项。moonDirection 为观察者月方向
// （ECEF，含视差修正）；moonIlluminatedFraction 为 Lambert 球积分月相因子（朔 0/弦 0.318/
// 望 1，JS 侧按 sun/moon 两方向 dot 算）；moonLightScale=50000 艺术放大（物理 2.5e-6 不可见，
// 满月贡献 ≈nightAmbient×1.5 主导；视觉拍板可调）。
uniform vec3 moonDirection;
uniform float moonIlluminatedFraction;
uniform float moonLightScale;

// Primary raymarch
uniform int maxIterationCount;
uniform float minStepSize;
uniform float maxStepSize;
uniform float maxRayDistance;
uniform float perspectiveStepScale;
// 【2026-09-04 甲内近水平 march LOD】云内步 mip 调制倍率（缺省 1=空区步同款调制；
// >1 更激进——远云步长更快吃满 maxStepSize，换 FPS 但中景云变稀；demo ?cloudsHitMipBoost=）
uniform float u_hitStepMipBoost;

// Secondary raymarch
uniform int maxIterationCountToSun;
uniform int maxIterationCountToGround;
uniform float minSecondaryStepSize;
uniform float secondaryStepScale;

// Beer shadow map
uniform sampler2DArray shadowBuffer;
uniform vec2 shadowTexelSize;
uniform vec2 shadowIntervals[SHADOW_CASCADE_COUNT];
uniform mat4 shadowMatrices[SHADOW_CASCADE_COUNT];
uniform float shadowFar;
uniform float maxShadowFilterRadius;

// Shadow length
#ifdef SHADOW_LENGTH
uniform int maxShadowLengthIterationCount;
uniform float minShadowLengthStepSize;
uniform float maxShadowLengthRayDistance;
// 【2026-09-05 兜底 march 大步幅 / 2026-09-21 P4 太阳角自适应】!hitClouds 像素（云 miss
// 天空/打地）的 marchShadowLength 是全屏成本大头（实测白天贴地 6.6ms，与画面云量无关）。
// 该分支的 shadowLength 只调制云前大气散射（GetSkyRadianceToPoint higher-order 只遮
// single）。倍率定标（真机 A/B）：×4 白天逐位零差，但朝太阳日落场景海面散射显著发灰
// （meanΔ13/超差 48%——低太阳角视线云影光深大，粗步幅积分系统性偏差）→ P3 定稿 ×2。
// P4：兜底成本 ∝ 无云像素占比，随时刻/天气漂移（2026-09-21 实测同机位某时刻兜底
// ~10ms vs 09-05 定标 ~3.3ms）→ JS 按太阳仰角自适应 2→4（elev≤5°=P3 定稿 2 零回归域；
// ≥20°=4 白天零差域；smoothstep 中间带，A 预算同曲线）——低角端与 P3 define 逐位一致。
uniform float u_shadowFallbackStepScale;
// 【2026-09-21 P5 运动帧光柱降载】相机运动时光柱 march 步幅再乘此系数（JS 每帧按
// 运动标量算，静止精确 1=零回归）。旋转卡顿排查（2026-09-21）：光柱是旋转最大单项
// （关断 -6ms p50），25-68ms 帧时在 60Hz vsync 下呈现段不均=周期性卡顿体感；运动中
// temporal rejection 高、光柱形态本在抖，粗化低感。hitClouds/兜底两调用同乘。
uniform float u_shaftMotionScale;
#endif // SHADOW_LENGTH

in vec2 vUv;
in vec3 vCameraPosition;
in vec3 vCameraDirection; // Direction to the center of screen
in vec3 vRayDirection; // Direction to the texel
in vec3 vViewPosition;
in GroundIrradiance vGroundIrradiance;
in CloudsIrradiance vCloudsIrradiance;

layout(location = 0) out vec4 outputColor;
layout(location = 1) out vec3 outputDepthVelocity;
#ifdef SHADOW_LENGTH
layout(location = 2) out float outputShadowLength;
#endif // SHADOW_LENGTH

float getViewZ(const float depth) {
  #ifdef PERSPECTIVE_CAMERA
  return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
  #else // PERSPECTIVE_CAMERA
  return orthographicDepthToViewZ(depth, cameraNear, cameraFar);
  #endif // PERSPECTIVE_CAMERA
}

vec3 ecefToWorld(const vec3 positionECEF) {
  return (ecefToWorldMatrix * vec4(positionECEF - altitudeCorrection, 1.0)).xyz;
}

vec2 getShadowUv(const vec3 worldPosition, const int cascadeIndex) {
  vec4 clip = shadowMatrices[cascadeIndex] * vec4(worldPosition, 1.0);
  clip /= clip.w;
  return clip.xy * 0.5 + 0.5;
}

float getDistanceToShadowTop(const vec3 rayPosition) {
  // Distance to the top of the shadows along the sun direction, which matches
  // the ray origin of BSM.
  return raySphereSecondIntersection(
    rayPosition,
    sunDirection,
    vec3(0.0),
    bottomRadius + shadowTopHeight
  );
}

#ifdef DEBUG_SHOW_CASCADES

const vec3 cascadeColors[4] = vec3[4](
  vec3(1.0, 0.0, 0.0),
  vec3(0.0, 1.0, 0.0),
  vec3(0.0, 0.0, 1.0),
  vec3(1.0, 1.0, 0.0)
);

vec3 getCascadeColor(const vec3 rayPosition) {
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar
  );
  // getCascadeIndex 可能返回 -1（超出 shadowFar 远端上界，2026-08-28 修复引入）→ 白色
  if (cascadeIndex < 0) {
    return vec3(1.0);
  }
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec3(1.0);
  }
  return cascadeColors[cascadeIndex];
}

vec3 getFadedCascadeColor(const vec3 rayPosition, const float jitter) {
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? cascadeColors[cascadeIndex]
    : vec3(1.0);
}

#endif // DEBUG_SHOW_CASCADES

float readShadowOpticalDepth(
  const vec2 uv,
  const float distanceToTop,
  const float distanceOffset,
  const int cascadeIndex
) {
  // r: frontDepth, g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail
  // Also see the discussion here: https://x.com/shotamatsuda/status/1885322308908442106
  vec4 shadow = texture(shadowBuffer, vec3(uv, float(cascadeIndex)));
  float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);
  return min(shadow.b + shadow.a, shadow.g * distanceToFront);
}

float sampleShadowOpticalDepthPCF(
  const vec3 worldPosition,
  const float distanceToTop,
  const float distanceOffset,
  const float radius,
  const int cascadeIndex
) {
  vec2 uv = getShadowUv(worldPosition, cascadeIndex);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 0.0;
  }
  if (radius < 0.1) {
    return readShadowOpticalDepth(uv, distanceToTop, distanceOffset, cascadeIndex);
  }
  float sum = 0.0;
  vec2 offset;
  // 【2026-09-28 层内黑楔】原 three #pragma unroll_loop 文本展开（16 次循环，SHADOW_SAMPLE_COUNT=16
  // 时 #if 全真=纯展开无裁剪）与 AMS 同款构造型；一并改恒定边界普通循环（数学逐位等价）。
  for (int i = 0; i < SHADOW_SAMPLE_COUNT; ++i) {
    offset = vogelDisk(
      i,
      SHADOW_SAMPLE_COUNT,
      interleavedGradientNoise(gl_FragCoord.xy + temporalJitter * resolution) * PI2
    );
    sum += readShadowOpticalDepth(
      uv + offset * radius * shadowTexelSize,
      distanceToTop,
      distanceOffset,
      cascadeIndex
    );
  }
  return sum / float(SHADOW_SAMPLE_COUNT);
}

float sampleShadowOpticalDepth(
  const vec3 rayPosition,
  const float distanceOffset,
  const float radius,
  const float jitter
) {
  float distanceToTop = getDistanceToShadowTop(rayPosition);
  if (distanceToTop <= 0.0) {
    return 0.0;
  }
  vec3 worldPosition = ecefToWorld(rayPosition);
  int cascadeIndex = getFadedCascadeIndex(
    viewMatrix,
    worldPosition,
    shadowIntervals,
    cameraNear,
    shadowFar,
    jitter
  );
  return cascadeIndex >= 0
    ? sampleShadowOpticalDepthPCF(
      worldPosition,
      distanceToTop,
      distanceOffset,
      radius,
      cascadeIndex
    )
    : 0.0;
}

#ifdef DEBUG_SHOW_SHADOW_MAP
vec4 getCascadedShadowMaps(vec2 uv) {
  vec4 coord = vec4(vUv, vUv - 0.5) * 2.0;
  vec4 shadow = vec4(0.0);
  if (uv.y > 0.5) {
    if (uv.x < 0.5) {
      shadow = texture(shadowBuffer, vec3(coord.xw, 0.0));
    } else {
      #if SHADOW_CASCADE_COUNT > 1
      shadow = texture(shadowBuffer, vec3(coord.zw, 1.0));
      #endif // SHADOW_CASCADE_COUNT > 1
    }
  } else {
    if (uv.x < 0.5) {
      #if SHADOW_CASCADE_COUNT > 2
      shadow = texture(shadowBuffer, vec3(coord.xy, 2.0));
      #endif // SHADOW_CASCADE_COUNT > 2
    } else {
      #if SHADOW_CASCADE_COUNT > 3
      shadow = texture(shadowBuffer, vec3(coord.zy, 3.0));
      #endif // SHADOW_CASCADE_COUNT > 3
    }
  }

  #if !defined(DEBUG_SHOW_SHADOW_MAP_TYPE)
  #define DEBUG_SHOW_SHADOW_MAP_TYPE 0
  #endif // !defined(DEBUG_SHOW_SHADOW_MAP_TYPE

  const float frontDepthScale = 1e-5;
  const float meanExtinctionScale = 10.0;
  const float maxOpticalDepthScale = 0.01;
  vec3 color;
  #if DEBUG_SHOW_SHADOW_MAP_TYPE == 1
  color = vec3(shadow.r * frontDepthScale);
  #elif DEBUG_SHOW_SHADOW_MAP_TYPE == 2
  color = vec3(shadow.g * meanExtinctionScale);
  #elif DEBUG_SHOW_SHADOW_MAP_TYPE == 3
  color = vec3((shadow.b + shadow.a) * maxOpticalDepthScale);
  #else // DEBUG_SHOW_SHADOW_MAP_TYPE
  color =
    (shadow.rgb + vec3(0.0, 0.0, shadow.a)) *
    vec3(frontDepthScale, meanExtinctionScale, maxOpticalDepthScale);
  #endif // DEBUG_SHOW_SHADOW_MAP_TYPE
  return vec4(color, 1.0);
}
#endif // DEBUG_SHOW_SHADOW_MAP

vec2 henyeyGreenstein(const vec2 g, const float cosTheta) {
  vec2 g2 = g * g;
  // prettier-ignore
  return RECIPROCAL_PI4 *
    ((1.0 - g2) / max(vec2(1e-7), pow(1.0 + g2 - 2.0 * g * cosTheta, vec2(1.5))));
}

#ifdef ACCURATE_PHASE_FUNCTION

float draine(float u, float g, float a) {
  float g2 = g * g;
  // prettier-ignore
  return (1.0 - g2) *
    (1.0 + a * u * u) /
    (4.0 * (1.0 + a * (1.0 + 2.0 * g2) / 3.0) * PI * pow(1.0 + g2 - 2.0 * g * u, 1.5));
}

// Numerically-fitted large particles (d=10) phase function It won't be
// plausible without a more precise multiple scattering.
// Reference: https://research.nvidia.com/labs/rtr/approximate-mie/
float phaseFunction(const float cosTheta, const float attenuation) {
  const float gHG = 0.988176691700256; // exp(-0.0990567/(d-1.67154))
  const float gD = 0.5556712547839497; // exp(-2.20679/(d+3.91029) - 0.428934)
  const float alpha = 21.995520856274638; // exp(3.62489 - 8.29288/(d+5.52825))
  const float weight = 0.4819554318404214; // exp(-0.599085/(d-0.641583)-0.665888)
  return mix(
    henyeyGreenstein(vec2(gHG) * attenuation, cosTheta).x,
    draine(cosTheta, gD * attenuation, alpha),
    weight
  );
}

#else // ACCURATE_PHASE_FUNCTION

float phaseFunction(const float cosTheta, const float attenuation) {
  const vec2 g = scatterAnisotropy;
  const vec2 weights = vec2(1.0 - scatterAnisotropyMix, scatterAnisotropyMix);
  // A similar approximation is described in the Frostbite's paper, where phase
  // angle is attenuated instead of anisotropy.
  return dot(henyeyGreenstein(g * attenuation, cosTheta), weights);
}

#endif // ACCURATE_PHASE_FUNCTION

float phaseFunction(const float cosTheta) {
  return phaseFunction(cosTheta, 1.0);
}

float marchOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const int maxIterationCount,
  const float mipLevel,
  const float jitter,
  out float rayDistance
) {
  int iterationCount = int(
    max(0.0, remap(mipLevel, 0.0, 1.0, float(maxIterationCount + 1), 1.0) - jitter)
  );
  if (iterationCount == 0) {
    // Fudge factor to approximate the mean optical depth.
    // TODO: Remove it.
    return 0.5;
  }
  float stepSize = minSecondaryStepSize / float(iterationCount);
  float nextDistance = stepSize * jitter;
  float opticalDepth = 0.0;
  for (int i = 0; i < iterationCount; ++i) {
    rayDistance = nextDistance;
    vec3 position = rayDistance * rayDirection + rayOrigin;
    vec2 uv = getGlobeUv(position);
    float height = length(position) - bottomRadius;
    WeatherSample weather = sampleWeather(uv, position, height, mipLevel);
    MediaSample media = sampleMedia(weather, position, uv, mipLevel, jitter);
    opticalDepth += media.extinction * stepSize;
    nextDistance += stepSize;
    stepSize *= secondaryStepScale;
  }
  return opticalDepth;
}

float marchOpticalDepth(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const int maxIterationCount,
  const float mipLevel,
  const float jitter
) {
  float rayDistance;
  return marchOpticalDepth(
    rayOrigin,
    rayDirection,
    maxIterationCount,
    mipLevel,
    jitter,
    rayDistance
  );
}

float approximateMultipleScattering(const float opticalDepth, const float cosTheta) {
  // Multiple scattering approximation
  // See: https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf
  // a: attenuation, b: contribution, c: phase attenuation
  vec3 coeffs = vec3(1.0); // [a, b, c]
  const vec3 attenuation = vec3(0.5, 0.5, 0.5); // Should satisfy a <= b
  float scattering = 0.0;
  // 【2026-09-28 层内黑楔】原 three #pragma unroll_loop 文本展开（12 次循环
  // #if UNROLLED_LOOP_INDEX < MULTI_SCATTERING_OCTAVES 裁剪留 6）在 Mac ANGLE→Metal
  // 下疑似触发方向相关误编译（层内陡视角黑楔；代码扰动敏感实证见排查记录：
  // 插入惰性全局即消失/换档位移动边界/与 20+ uniform 无关）。改恒定边界普通循环——
  // 数学逐位等价（coeffs 几何递推与求和次序不变，仅去掉文本展开与 #if 死分支）。
  for (int i = 0; i < MULTI_SCATTERING_OCTAVES; ++i) {
    scattering += coeffs.x * exp(-opticalDepth * coeffs.y) * phaseFunction(cosTheta, coeffs.z);
    coeffs *= attenuation;
  }
  return scattering;
}

// TODO: Construct spherical harmonics of degree 2 using 2 sample points
// positioned near the horizon occlusion points on the sun direction plane.
vec3 getGroundSunSkyIrradiance(
  const vec3 position,
  const vec3 surfaceNormal,
  const float height,
  out vec3 skyIrradiance
) {
  #ifdef ACCURATE_SUN_SKY_LIGHT
  return GetSunAndSkyIrradiance(
    (position - surfaceNormal * height) * METER_TO_LENGTH_UNIT,
    surfaceNormal,
    sunDirection,
    skyIrradiance
  );
  #else // ACCURATE_SUN_SKY_LIGHT
  skyIrradiance = vGroundIrradiance.sky;
  return vGroundIrradiance.sun;
  #endif // ACCURATE_SUN_SKY_LIGHT
}

vec3 getCloudsSunSkyIrradiance(const vec3 position, const float height, out vec3 skyIrradiance) {
  #ifdef ACCURATE_SUN_SKY_LIGHT
  return GetSunAndSkyScalarIrradiance(position * METER_TO_LENGTH_UNIT, sunDirection, skyIrradiance);
  #else // ACCURATE_SUN_SKY_LIGHT
  float alpha = remapClamped(height, minHeight, maxHeight);
  skyIrradiance = mix(vCloudsIrradiance.minSky, vCloudsIrradiance.maxSky, alpha);
  return mix(vCloudsIrradiance.minSun, vCloudsIrradiance.maxSun, alpha);
  #endif // ACCURATE_SUN_SKY_LIGHT
}

#ifdef GROUND_BOUNCE
vec3 approximateRadianceFromGround(
  const vec3 position,
  const vec3 surfaceNormal,
  const float height,
  const float mipLevel,
  const float jitter
) {
  float opticalDepthToGround = marchOpticalDepth(
    position,
    -surfaceNormal,
    maxIterationCountToGround,
    mipLevel,
    jitter
  );
  vec3 skyIrradiance;
  vec3 sunIrradiance = getGroundSunSkyIrradiance(position, surfaceNormal, height, skyIrradiance);
  const float groundAlbedo = 0.3;
  vec3 groundIrradiance = skyIrradiance + (1.0 - coverage) * sunIrradiance;
  vec3 bouncedRadiance = groundAlbedo * RECIPROCAL_PI * groundIrradiance;
  return bouncedRadiance * exp(-opticalDepthToGround);
}
#endif // GROUND_BOUNCE

// 【2026-09-28 层内黑楔排查探针】marchClouds 末次 media 采样量的直读全局（仅
// DEBUG_SHOW_PROBE_* 块消费；正常渲染路径零消费零成本）。默认 -1/0 区分「无 media 采样」。
vec3 g_probeSunSky = vec3(0.0); // sun+sky irradiance（末次 media 采样点）
float g_probeExt = 0.0;         // media.extinction
float g_probeOD = -1.0;         // to-sun 光深（marchOpticalDepth+BSM）
float g_probeRad = -1.0;        // 局部 radiance 标量 dot(radiance, 1/3)（powder 后）
float g_probeT = 1.0;           // transmittanceIntegral（末次采样后）
vec3 g_probePreAerial = vec3(0.0); // aerial 前的 march 出口 rgb
// 【2026-09-29 2022m 黑斑机理钉死】fogDebug 探针：门控值 + 受照样本计数
float g_fogInLayer = 0.0;
float g_fogLit = 0.0;

vec4 marchClouds(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float cosTheta,
  const float jitter,
  const float rayStartTexelsPerPixel,
  out float frontDepth,
  out ivec3 sampleCount
) {
  vec3 radianceIntegral = vec3(0.0);
  float transmittanceIntegral = 1.0;
  float weightedDistanceSum = 0.0;
  float transmittanceSum = 0.0;

  float maxRayDistance = rayNearFar.y - rayNearFar.x;
  float stepSize = minStepSize + (perspectiveStepScale - 1.0) * rayNearFar.x;
  // 【太空俯视步长 clamp（2026-09-03）】透视步长公式在相机远离云甲时崩溃：near≫段长
  // （太空 16136km → near≈16128km → stepSize≈161km），云甲段 1 步跨完 →
  // exp(-extinction·stepSize) 归零 alpha 全饱和（全白球）+ 甲顶单样本天气场欠采样
  // 摩尔环带。clamp 到段长/8 保 ≥8 步采样；minStepSize 地板使近地验收域（公式值
  // < 段长/8）与贴甲底薄段（地板域）行为与旧版逐位一致，startJitter 守卫语义自洽。
  stepSize = min(stepSize, max(maxRayDistance * 0.125, minStepSize));
  // I don't understand why spatial aliasing remains unless doubling the jitter.
  // 【2026-09-03 穿云黑块修复（761m 贴甲底旋转视角）】起点 jitter 仅在段长足够（≥8 步）时
  // 启用：贴云甲底（minHeight）掠射视角的 march 段可短至十余米（≈2-3 步），±2 步起点抖动
  // 使相位帧间「整段跳过（sampleCount=0 → vec4(0)）/命中」翻转 → resolve 对暗 scene 收敛出
  // alpha 中间稳态 → 扩散黑块（temporal=0 即 jitter=0 时 0/36 黑帧的 A/B 实证）。
  // 【2026-09-28 层内运动闪屏】上守卫的完整化：短段（<8 步）时【整条 march 全部抖动归零】
  // （起点+逐样本 STBN相位），不止起点——层内 1-2 采样下逐样本 jitter 逐帧翻转 detail 分支
  // 门与采样相位 → veil alpha 二值跳变 → 拖拽视角全屏闪动（白板↔见地逐帧翻转，同机位
  // 冻结时间下密度场静止、物理上不该变——真机连拍实证）。短段本无空间抖动收益
  // （采样数不足以铺开噪声），确定性优先。
  float shortSegment = maxRayDistance < stepSize * 8.0 ? 1.0 : 0.0;
  float marchJitter = mix(jitter, 0.0, shortSegment);
  float startJitter = maxRayDistance < stepSize * 8.0 ? 0.0 : jitter;
  // 【2026-09-28 层内雾化（方案 A，用户拍板）】门控=相机在层带内（带外逐位不受影响——
  // 1450 层下 / 2500+ 层上 / 太空全部 inLayerCam=0 走原路径）。1692 蓝板/1536 白板两例
  // 排查实证：层内相机段被 minStepSize=50m 地板钉死步长 + 首样本 ext≥0.1/m 即
  // exp(-5)≤minTransmittance 早退 → 单点辐射平刷整下半球。三处修正：
  // ① 步长细化：段长/12 铺满（1692 段 ~590m 细化后 ≈49m 与原 50m 几乎同——关键在 ③；
  //    1536 薄段 ~117m 细化到 ~10m，从 2-3 步变 12 步）；
  // ② 起点 jitter 与逐样本相位归零（确定性延续 f49589b 语义，段短抖动无收益只有闪动）；
  // ③ 早退抑制见循环内（多步积分=加权平均光照，治首样本单点蓝 ambient）。
  // 相机在任一云层带内（层带=minLayerHeights/maxLayerHeights 各层 [altitude, altitude+height]，
  // L0 [1500,2150]/L1 [2000,3200]/L2 卷云带——椭球高语义，与 cameraHeight 同系）。
  // 【坑 2026-09-28】insideLayerIntervals 是「层间空隙」判定（packIntervalHeights 产出
  // [0,1500]/[3200,7500] 空域，march 快速跳跃用）——语义=「在空隙里」，与「在云层里」
  // 恰好相反；首版误用导致门控恒 false（三实验定位）。
  float camHeightLocal = length(rayOrigin) - bottomRadius;
  bvec4 camInLayer = bvec4(
    camHeightLocal > minLayerHeights.x && camHeightLocal < maxLayerHeights.x,
    camHeightLocal > minLayerHeights.y && camHeightLocal < maxLayerHeights.y,
    camHeightLocal > minLayerHeights.z && camHeightLocal < maxLayerHeights.z,
    camHeightLocal > minLayerHeights.w && camHeightLocal < maxLayerHeights.w);
  // 【段长上限 2026-09-28 用户反馈 3187m 近水平云变平面】雾化语义=「扎在云里的近场短段」
  // （步长=段长/12 保证 12 步铺满）；层带内近水平视角段长可达几 km-几十 km（L1 带内 3187m
  // -4.6° 俯角段 ~21km → 步长 1.75km，12 个采样点跨 21km → 体积结构完全欠采样=平面云）。
  // 长段=「在云层高度看远处云墙」应走原路径（mip LOD 大步+早退，体积感由几十步采样呈现，
  // 实测正常）。阈值 1000m（v2，2026-09-29 2214m 白扇形实测收敛）：2214m（L0 顶上方 64m、
  // L1 带内）向下段长 ~2km 落在旧阈值 2000 临界——底部陡视线段<2000 误触发雾化→纯白无
  // 结构扇形（原路径同机位整屏云海完美，雾化 floor 常量色毁结构）。1000m=步长上限 ~84m
  // （1692 段 590m/1536 薄段 117m 不受影响；2022 黑斑机位段 1-2km 部分退出雾化——该机位
  // 黑斑已定性为 scene 侧帧污染与雾化无关，见 d71fb01）。
  float shortInLayer = any(camInLayer) && maxRayDistance < 1000.0 ? 1.0 : 0.0;
  float inLayerCam = u_inLayerFog * shortInLayer;
  g_fogInLayer = inLayerCam; // 【2026-09-29 fogDebug 探针】
  g_fogLit = 0.0;
  stepSize = mix(stepSize, max(maxRayDistance * 0.0833333, 1.0), inLayerCam);
  marchJitter = mix(marchJitter, 0.0, inLayerCam);
  startJitter = mix(startJitter, 0.0, inLayerCam);
  float rayDistance = stepSize * startJitter * 2.0;

  for (int i = 0; i < maxIterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }

    vec3 position = rayDistance * rayDirection + rayOrigin;
    float height = length(position) - bottomRadius;
    float mipLevel = log2(max(1.0, rayStartTexelsPerPixel + rayDistance * 1e-5));

    #if !defined(DEBUG_MARCH_INTERVALS)
    if (insideLayerIntervals(height)) {
      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;
    }
    #endif // !defined(DEBUG_MARCH_INTERVALS)

    // Sample rough weather.
    vec2 uv = getGlobeUv(position);
    WeatherSample weather = sampleWeather(uv, position, height, mipLevel);

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    ++sampleCount.x;
    #endif // DEBUG_SHOW_SAMPLE_COUNT

    if (!any(greaterThan(weather.density, vec4(minDensity)))) {
      // Step longer in empty space.
      // TODO: This produces banding artifacts.
      // Possible improvement: Binary search refinement
      stepSize *= perspectiveStepScale;
      rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
      continue;
    }

    // Sample detailed participating media.
    MediaSample media = sampleMedia(weather, position, uv, mipLevel, marchJitter, sampleCount);

    if (media.extinction > minExtinction) {
      vec3 skyIrradiance;
      vec3 sunIrradiance = getCloudsSunSkyIrradiance(position, height, skyIrradiance);
      vec3 surfaceNormal = normalize(position);
      g_probeSunSky = sunIrradiance + skyIrradiance;
      g_probeExt = media.extinction;

      // 夜间环境底光（方向 B）：抬 skyIrradiance 地板，随现有 skyGradient × scattering ×
      // 能量守恒积分传播 → 夜间云保有形体梯度（深灰云海而非黑洞）。淡入区间 = 当地太阳
      // 仰角 -1° → -6°——2026-08-30 二次收窄提前（-5°/-12° → -3°/-10° → 本版）：用户实拍
      // 105.7E/17.5N 4815m 太阳 ~-6° 揭示亮度沿太阳高度呈 V 形反常（昼亮→晨昏带最黑→深夜
      // 反而微亮）——晨昏带是双光低谷（LUT 已在 -5° 归零 + 底光才淡入），比深夜还黑。物理
      // 上应单调变暗：淡入提前到 -1°~-6° 填平低谷（-2°→26% / -4°→72% / -5.8°→≈满值=与
      // 深夜同亮不再更黑）；白天（>-1°）nightFactor=0 零回归。「晨昏带比深夜亮一档」需晨光
      // 散射模型（方向 C 范畴）。muSunLocal 用采样点当地天顶（surfaceNormal），与
      // GetSunAndSkyIrradiance 内 mu_s 同源。
      float muSunLocal = dot(surfaceNormal, sunDirection);
      float nightFactor = 1.0 - smoothstep(-0.1045, -0.0175, muSunLocal);
      // 月光门 2：月升落（spec §6.2）——月落后 moonDirection 在地平线下，无此门云被
      // 「地下来的光」照亮、云底亮反转（弦月下半夜必现）。窗口 -0.05..0.02 ≈
      // sin(-2.87°)..sin(+1.15°)：下沿 ≈8km 云层顶的地平俯角。门 1（昼夜分账）复用
      // 上方 nightFactor——白天精确 0（云侧零回归）、晨昏带与底光同曲线淡入。
      // 【2026-09-21 上移】月光地板退让（原 L611）——地板项先算 retreat 需要它。
      float moonFactor = moonIlluminatedFraction
        * smoothstep(-0.05, 0.02, dot(surfaceNormal, moonDirection));
      // 【2026-09-21 月光地板退让】nightAmbient 是非物理环境底光（防纯黑，0.03 定稿）——
      // 月光照明主导时（满月 ≈地板×1.5）底光叠加上仍偏亮（满月夜 >120 像素 24%，84f3306）。
      // 地板按 moonFactor 线性退让到 u_nightAmbientRetreat（1=关=零回归；新月 moonFactor=0
      // 逐位回归；白天 nightFactor=0 本就无地板）。物理语义：底光让位给真实月光照明。
      skyIrradiance += u_nightTint * (nightAmbient * nightFactor
        * mix(1.0, u_nightAmbientRetreat, moonFactor));

      // March optical depth to the sun for finer details, which BSM lacks.
      // 【2026-09-05 P0 夜晚太阳侧门控】sunIrradiance 三通道全 0 时（ACCURATE LUT / 桥接
      // varying 两路径在太阳当地沉没 >5° 后均精确归零——夜间环境底光调查实证），下方
      // toSun march（≤maxIterationCountToSun 次 3D 采样）+ BSM 光深采样的结果只被乘 0：
      // 0×AMS(OD)=0×AMS(0)=+0（AMS 对有限 OD 恒有限；唯一语义差异=病态 NaN 输入被
      // 消毒为 0，nan-probe 已证全链 NaN=0 不可达）——跳过与原式逐位等价。晨昏带
      //（任意小的非零分量）照跑=A1 月光门控同款纪律；夜间全零/白天全非零 → 分支取向
      // 全屏一致无 warp 发散（晨昏过渡带内可能逐像素分叉，仅影响该带收益不影响结果）。
      // 甲内夜实测这两项白烧 ~15-20ms/33ms（2026-09-05 性能台账）。
      float sunRayDistance = 0.0;
      float opticalDepth = 0.0;
      if (any(notEqual(sunIrradiance, vec3(0.0)))) {
        opticalDepth = marchOpticalDepth(
          position,
          sunDirection,
          maxIterationCountToSun,
          mipLevel,
          marchJitter,
          sunRayDistance
        );

        if (height < shadowTopHeight) {
          // Obtain the optical depth from BSM at the ray position.
          opticalDepth += sampleShadowOpticalDepth(
            position,
            // Take account of only positions further than the marched ray
            // distance.
            sunRayDistance,
            // Apply PCF only when the sun is close to the horizon.
            maxShadowFilterRadius * remapClamped(dot(sunDirection, surfaceNormal), 0.1, 0.0),
            marchJitter
          );
        }
      }

      g_probeOD = opticalDepth;
      vec3 radiance = sunIrradiance * approximateMultipleScattering(opticalDepth, cosTheta);

      // 月光散射项（spec §6.1）：独立构造 moonIrradiance（非 sun 项乘系数——夜间 LUT 太阳
      // 项已归零）；朝月独立 march 光深（复用太阳方向会杀死「云顶被月光照亮」主视觉——
      // 夜间太阳在地平下方向反了；maxIterationCountToSun=2 同预算，成本 +2 采样/受照样本）；
      // 不采 BSM（月光无云影）、不走 accurate LUT 路径；相位函数复用
      // approximateMultipleScattering（随 ACCURATE_PHASE_FUNCTION define 与太阳项一致）。
      // 同构并列于 sun 项——随后自然走 ×scattering/powder/能量积分，形体感与太阳光照一致。
      // 【2026-09-04 月光 march 白天门控（专家组 A1）】moonIrradiance 乘 nightFactor（昼夜门）
      // ×moonFactor（月升落门），两项为 0 时下方 marchOpticalDepth 纯白跑——白天每个受照
      // 云样本白付 ≤maxIterationCountToSun 次 3D 采样（专家实测白天受照样本占比高，省
      // 30-40% 次级采样）。门控条件严格取乘积 >0：非零任意小值（晨昏带 smoothstep 过渡带）
      // 仍照跑，光照数学与无条件版逐位等价；sun/moon 方向全屏一致 → warp 内分支一致无发散。
      if (nightFactor * moonFactor > 0.0) {
        float moonRayDistance = 0.0;
        float moonOpticalDepth = marchOpticalDepth(
          position,
          moonDirection,
          maxIterationCountToSun,
          mipLevel,
          marchJitter,
          moonRayDistance
        );
        float cosThetaMoon = dot(moonDirection, rayDirection);
        // 月光谱色：solar_irradiance 是暖白光谱，月光物理上经月面反射（中性偏暖）+ 无大气透射
        // （月球无大气）——但视觉基准带冷蓝（u_nightTint 同源），与底光色调一致防夜间
        // 云面混色（2026-08-31 天际线泛红修复配套）。
        vec3 moonIrradiance = ATMOSPHERE.solar_irradiance
          * 2.5e-6 * moonLightScale * nightFactor * moonFactor * u_nightTint;
        radiance += moonIrradiance * approximateMultipleScattering(moonOpticalDepth, cosThetaMoon);
      }

      #ifdef GROUND_BOUNCE
      // Fudge factor for the irradiance from ground.
      if (height < shadowTopHeight && mipLevel < 0.5) {
        vec3 groundRadiance = approximateRadianceFromGround(
          position,
          surfaceNormal,
          height,
          mipLevel,
          jitter
        );
        radiance += groundRadiance * RECIPROCAL_PI4 * groundBounceScale;
      }
      #endif // GROUND_BOUNCE

      // Crude approximation of sky gradient. Better than none in the shadows.
      float skyGradient = dot(weather.heightFraction * 0.5 + 0.5, media.weight);
      // 暮光天光补偿（2026-09-01）：窗 [sin(+2°)=0.0349, sin(-1.5°)=-0.0262]，锚 =
      // muSunLocal（采样点当地太阳角，与 nightFactor 同源——远云曲率太阳角差已含）。
      // 白天精确 1 零回归；直射/月光/地面反照不动，只补天光项。
      // 【2026-09-28 层内黑楔排查】原 smoothstep(0.0349, -0.0262, x) 边界反转（e0>e1）为
      // GLSL 规范 UB——驱动实现可产出非良定值（实测 Mac ANGLE→Metal 在层内陡视角产出
      // 方向相关黑楔区，rgb 归零/NaN、alpha 实值）。手工展开为数值逐位等价的递减 ramp：
      // t = clamp((0.0349 - x) / 0.0611) 恒等于负分母式的 clamp 结果。
      float twilightT = clamp((0.0349 - muSunLocal) / 0.0611, 0.0, 1.0);
      float twilightBoost = mix(1.0, u_twilightSkyBoost, twilightT * twilightT * (3.0 - 2.0 * twilightT));
      radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale * twilightBoost;

      // Finally multiply by scattering.
      radiance *= media.scattering;

      #ifdef POWDER
      radiance *= 1.0 - powderScale * exp(-media.extinction * powderExponent);
      #endif // POWDER
      // 【层内雾化 ④】radiance 去饱和提亮（1692 蓝板实测观感修正）：层内深部样本直射被
      // 上方云柱遮断（AMS(深 OD)≈0），只剩天光 ambient——Rayleigh 蓝主导 → 平刷呈饱和蓝。
      // 真实阴天云雾=白灰：45% 向亮度去饱和 + 15% 提亮（只在层内相机路径生效，带外恒等）。
      // 【2026-09-28 云底地板（2022m 用户实测黑斑）】重叠带深部（L0∩L1 内深 500m+、段
      // 1-2km 全浓云）样本 radiance 近黑（直射 0 + skyGradient 底部≈0）——去饱和救不了
      // 黑（黑 luma=0）→ 输出纯黑斑块。物理依据：真实云底有地面反照+云内多次散射，
      // 不会纯黑（阴天云底反照 ~0.3-0.6）。地板=天光的 50%（v2：0.06 经 45% 混合等效
      // ~2.7% 仍黑——2022 成对 A/B 实测无效提档；旁路 skyGradient——底部 gradient≈0
      // 正是黑因）。浅部（1692 白雾）luma 远高于地板，max 取 luma 不受影响。
      vec3 inLayerLuma = vec3(dot(radiance, vec3(0.33333333)));
      vec3 inLayerFloor = skyIrradiance * (RECIPROCAL_PI4 * skyLightScale * 0.5);
      radiance = mix(radiance, max(inLayerLuma * 1.15, inLayerFloor), 0.45 * inLayerCam);
      // 【2026-09-28 2022m 黑斑止血】NaN 样本免疫：2022m（L0∩L1 重叠带深部）雾化路径
      // readPixels 实证黑斑像素 rgb=NaN（α=0.88 雾化签名、全图 ~29 万 NaN 分量）→
      // overlay 消毒 → 黑斑。NaN 源头未钉（BSM=0/AMS 简单版/shapeDetail=0/turbulence=0
      // 四路排除均无效；黑斑区 frontDepth=0.1km + 速度 -1.7 每帧 rejection）。isnan
      // 防御：NaN 样本按空气步跳过（不进能量积分），53e8bc6 history 消毒同款 defense。
      // 注意不可写在白化前——NaN 会经 max/mix 传播（Metal max(NaN,x) 未定义）。
      if (isnan(radiance.x) || isnan(radiance.y) || isnan(radiance.z)) {
        stepSize *= perspectiveStepScale;
        rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));
        continue;
      }
      // 【2026-09-29 编译扰动锚（2022m 黑斑压制实验）】Mac ANGLE→Metal fast-math 在本函数
      // 的特定调度下于重叠带深部像素产出错误值（黑斑家族=层内黑楔同族：对代码扰动敏感、
      // 探针/哨兵插入即消失、isnan/自比较检测被折叠——两次独立排查同结论）。此恒假分支
      // 强制保留调度节点、改变指令调度——实测若压制黑斑则确证编译器层，锚永久保留并注释。
      if (u_inLayerFog < 0.0) {
        radiance = mix(radiance, vec3(0.0), g_fogLit * 0.0);
      }
      g_probeRad = dot(radiance, vec3(0.33333333));

      #ifdef DEBUG_SHOW_CASCADES
      if (height < shadowTopHeight) {
        radiance = 1e-3 * getFadedCascadeColor(position, jitter);
      }
      #endif // DEBUG_SHOW_CASCADES

      // Energy-conserving analytical integration of scattered light
      // See 5.6.3 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
      float transmittance = exp(-media.extinction * stepSize);
      float clampedExtinction = max(media.extinction, 1e-7);
      vec3 scatteringIntegral = (radiance - radiance * transmittance) / clampedExtinction;
      radianceIntegral += transmittanceIntegral * scatteringIntegral;
      transmittanceIntegral *= transmittance;
      g_probeT = transmittanceIntegral;
      ++g_fogLit; // 【2026-09-29 fogDebug 探针】受照样本计数

      // Aerial perspective affecting clouds
      // See 5.9.1 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
      weightedDistanceSum += rayDistance * transmittanceIntegral;
      transmittanceSum += transmittanceIntegral;
    }

    // 【层内雾化 ③】层内相机禁早退：段长有限（≤层厚/sinθ，最长 ~650m），全段积分成本
    // 有界；收益=多步密度变化进入积分（云隙/浓柱过渡有层次）+ 辐射沿段平均（非首样本
    // 单点）。带外早退语义原样（maxIterationCount 500 步长段成本无界，不可禁）。
    if (transmittanceIntegral <= minTransmittance && inLayerCam < 0.5) {
      break; // Early termination
    }

    // Take a shorter step because we've already hit the clouds.
    // 【2026-09-04 甲内近水平 march LOD】云内步补 mip 调制（对齐上方空区步 L570 同一公式）：
    // 上游设计域=云外视角斜穿云层（云内路径=厚度/sinθ，短），云内步只 ×perspectiveStepScale
    // （+1%/步，50m 起步走 100km 需 ~486 步）；甲内近水平「沿云飞」几十 km 时 500 步打满
    // （sampleCount 直显实测天空区 300-500 步/像素，28 FPS；low 档 50 步上限同机位满帧旁证）。
    // mip 随距离增长（log2(1+d·1e-5)：50km≈0.59 / 100km=1.0）→ 远云大步（LOD 语义与空区步
    // 一致，mip 糊化采样与大步误差自洽）；近景 <2km mip≈0 步长不变逐位保真。大步加速
    // transmittance 衰减 → early termination 更早，协同收益。
    stepSize *= perspectiveStepScale;
    // 【getHitStepMipModulation】
    rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel * u_hitStepMipBoost));
  }

  // The final product of 5.9.1 and we'll evaluate this in aerial perspective.
  frontDepth = transmittanceSum > 0.0 ? weightedDistanceSum / transmittanceSum : -1.0;

  // 【层内雾化 ⑤】出口 alpha 软化：全段积分后稠密柱 T≈0 → alpha=1 纯墙（透射 0.7% 以下
  // 全被 remap 钳死）。×0.88 给地面留 12% 可见度=「浓雾」观感而非「墙」。带外恒等。
  float outAlpha = remapClamped(transmittanceIntegral, 1.0, minTransmittance);
  // 【2026-09-28 2022m 黑斑出口兜底】readPixels 实证黑斑像素 rgb=NaN（样本级 isnan 拦截
  // 无效——NaN 产生于能量积分自身/0×NaN 传播，样本级检测点在传播前）。RT 写入前终检：
  // NaN 像素按无云处理（rgb=0、α=0 透出地面），NaN 源头（重叠带深部雾化路径、区域随
  // 瓦片/天气状态波动）留专项调查。
  if (isnan(radianceIntegral.r) || isnan(radianceIntegral.g) || isnan(radianceIntegral.b)) {
    radianceIntegral = vec3(0.0);
    outAlpha = 0.0;
  }
  return vec4(radianceIntegral, mix(outAlpha, outAlpha * 0.88, inLayerCam));
}

#ifdef SHADOW_LENGTH

float marchShadowLength(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const vec2 rayNearFar,
  const float jitter,
  const float startStepSize
) {
  float shadowLength = 0.0;
  float maxRayDistance = rayNearFar.y - rayNearFar.x;
  float stepSize = startStepSize;
  float rayDistance = stepSize * jitter;
  const float attenuationFactor = 1.0 - 5e-4;
  float attenuation = 1.0;

  // TODO: This march is closed, and sample resolution can be much lower.
  // Refining the termination by binary search will make it much more efficient.
  for (int i = 0; i < maxShadowLengthIterationCount; ++i) {
    if (rayDistance > maxRayDistance) {
      break; // Termination
    }
    vec3 position = rayDistance * rayDirection + rayOrigin;
    float opticalDepth = sampleShadowOpticalDepth(position, 0.0, 0.0, jitter);
    shadowLength += (1.0 - exp(-opticalDepth)) * stepSize * attenuation;
    stepSize *= perspectiveStepScale;
    // 【2026-09-04 god rays march 改造（专家组 A2）】步长封顶对齐主 march（maxStepSize
    // 共用 uniform）：原版 ×1.01 无封顶，200km 段 ~378 步打满 500 上限；封顶后
    // minShadowLengthStepSize(50)×1.01^n→1000m，配合段长 clamp（maxShadowLengthRayDistance
    // 2e5→16000）146 步走满 16km < 150 步预算——远段不再逐 50m 级爬行。
    rayDistance += min(stepSize, maxStepSize);
  }
  return shadowLength;
}

#endif // SHADOW_LENGTH

#ifdef HAZE

vec4 approximateHaze(
  const vec3 rayOrigin,
  const vec3 rayDirection,
  const float maxRayDistance,
  const float cosTheta,
  const float shadowLength
) {
  float modulation = remapClamped(coverage, 0.2, 0.4);
  if (cameraHeight * modulation < 0.0) {
    return vec4(0.0);
  }
  float density = modulation * hazeDensityScale * exp(-cameraHeight * hazeExponent);
  if (density < 1e-7) {
    return vec4(0.0); // Prevent artifact in views from space
  }

  // Blend two normals by the difference in angle so that normal near the
  // ground becomes that of the origin, and in the sky that of the horizon.
  vec3 normalAtOrigin = normalize(rayOrigin);
  vec3 normalAtHorizon = (rayOrigin - dot(rayOrigin, rayDirection) * rayDirection) / bottomRadius;
  float alpha = remapClamped(dot(normalAtOrigin, normalAtHorizon), 0.9, 1.0);
  vec3 normal = mix(normalAtOrigin, normalAtHorizon, alpha);

  // Analytical optical depth where density exponentially decreases with height.
  // Based on: https://iquilezles.org/articles/fog/
  float angle = max(dot(normal, rayDirection), 1e-5);
  float exponent = angle * hazeExponent;
  float linearTerm = density / hazeExponent / angle;

  // Derive the optical depths separately for with and without shadow length.
  float expTerm = 1.0 - exp(-maxRayDistance * exponent);
  float shadowExpTerm = 1.0 - exp(-min(maxRayDistance, shadowLength) * exponent);
  float opticalDepth = expTerm * linearTerm;
  float shadowOpticalDepth = max((expTerm - shadowExpTerm) * linearTerm, 0.0);
  float transmittance = saturate(1.0 - exp(-opticalDepth));
  float shadowTransmittance = saturate(1.0 - exp(-shadowOpticalDepth));

  vec3 skyIrradiance = vGroundIrradiance.sky;
  vec3 sunIrradiance = vGroundIrradiance.sun;
  vec3 inscatter = sunIrradiance * phaseFunction(cosTheta) * shadowTransmittance;
  inscatter += skyIrradiance * RECIPROCAL_PI4 * skyLightScale * transmittance;
  inscatter *= hazeScatteringCoefficient / (hazeAbsorptionCoefficient + hazeScatteringCoefficient);
  return vec4(inscatter, transmittance);
}

#endif // HAZE

void applyAerialPerspective(
  const vec3 cameraPosition,
  const vec3 frontPosition,
  const float shadowLength,
  inout vec4 color
) {
  vec3 transmittance;
  vec3 inscatter = GetSkyRadianceToPoint(
    cameraPosition * METER_TO_LENGTH_UNIT,
    frontPosition * METER_TO_LENGTH_UNIT,
    shadowLength * METER_TO_LENGTH_UNIT,
    sunDirection,
    transmittance
  );
  // 夜间淡出+去色（2026-08-31 地平线泛红三轮）：云内大气透视独立于 atmosphere 主 shader
  // （二轮只修了主 shader）。**红带主源=transmittance 距离红化**：u_nightTint 冷蓝的
  // 云本体光 × 贴地平线几百 km 路径的 Rayleigh 滤蓝存红透射（中距离对冲后 0.98，贴线极远云
  // 仍 1.4-1.96；云关后同区纯黑定位到本链路）。修法=夜门内 transmittance 去色保亮度
  // （mix 到灰度——夜间 Purkinje 低色觉，远处云变暗不偏色）；inscatter 同窗口归零
  // （LUT 高阶项太阳深潜不归零残余）。窗口 [-12°,-6°] 与 atmosphere skyNightFade 同款
  // （民用暮光零回归/航海渐消/天文暮光归零）。
  // **锚点=frontPosition（云前表面，四轮修正）**：首版用相机径向法线——太空夜侧上空相机
  // muSunSky≈-1→fade 满门，把昼侧云的 aerial perspective 全灭（用户实测晨昏线消失被驳回，
  // 与 atmosphere 三轮同因）。按每像素云前表面自身位置判定：昼侧云 el>0 不衰减、夜侧远云深负归零。
  float muSunSky = dot(normalize(frontPosition), sunDirection);
  float skyNightFade = 1.0 - smoothstep(-0.2079, -0.1045, muSunSky);
  inscatter *= 1.0 - skyNightFade;
  float transmittanceLuminance = dot(transmittance, vec3(0.2126, 0.7152, 0.0722));
  transmittance = mix(transmittance, vec3(transmittanceLuminance), skyNightFade);
  color.rgb = color.rgb * transmittance + inscatter * color.a;
}

bool rayIntersectsGround(const vec3 cameraPosition, const vec3 rayDirection) {
  float r = length(cameraPosition);
  float mu = dot(cameraPosition, rayDirection) / r;
  return mu < 0.0 && r * r * (mu * mu - 1.0) + bottomRadius * bottomRadius >= 0.0;
}

struct IntersectionResult {
  bool ground;
  vec4 first;
  vec4 second;
};

IntersectionResult getIntersections(const vec3 cameraPosition, const vec3 rayDirection) {
  IntersectionResult intersections;
  intersections.ground = rayIntersectsGround(cameraPosition, rayDirection);
  raySphereIntersections(
    cameraPosition,
    rayDirection,
    bottomRadius + vec4(0.0, minHeight, maxHeight, shadowTopHeight),
    intersections.first,
    intersections.second
  );
  return intersections;
}

vec2 getRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (cameraHeight < minHeight) {
    // View below the clouds
    if (intersections.ground) {
      nearFar = vec2(-1.0); // No clouds to the ground
    } else {
      nearFar = vec2(intersections.second.y, intersections.second.z);
      nearFar.y = min(nearFar.y, maxRayDistance);
    }
  } else if (cameraHeight < maxHeight) {
    // View inside the total cloud layer
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.y);
    } else {
      nearFar = vec2(cameraNear, intersections.second.z);
    }
    // 【2026-09-03 coverage=1 云甲内盐粒修复】甲下分支有 maxRayDistance 截断、甲内分支
    // 没有（three 上游固有遗漏）：甲内近水平视线与甲顶球远端求交段长可达数百 km（几何
    // 弦长 ~560km）→ march 步长预算爆炸（中后段数十 km/步跨天气瓦）+ frontDepth/
    // depthVelocity 场极端值 → resolve 3×3 最近深度跨界借 velocity → history 错位，
    // coverage=1 下 rejection 失效成满屏盐粒。同款截断（200km，超远云被消光/大气淹没，
    // 能见度语义下视觉无贡献）。
    // 【getRayNearFarInsideLayerMaxDistanceGuard】
    nearFar.y = min(nearFar.y, maxRayDistance);
  } else {
    // View above the clouds
    nearFar = vec2(intersections.first.z, intersections.second.z);
    if (intersections.ground) {
      // Clamp the ray at the min height.
      nearFar.y = intersections.first.y;
    }
  }
  return nearFar;
}

#ifdef SHADOW_LENGTH
vec2 getShadowRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (cameraHeight < shadowTopHeight) {
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.x);
    } else {
      nearFar = vec2(cameraNear, intersections.second.w);
    }
  } else {
    nearFar = vec2(intersections.first.w, intersections.second.w);
    if (intersections.ground) {
      // Clamp the ray at the ground.
      nearFar.y = intersections.first.x;
    }
  }
  nearFar.y = min(nearFar.y, maxShadowLengthRayDistance);
  return nearFar;
}
#endif // SHADOW_LENGTH

#ifdef HAZE
vec2 getHazeRayNearFar(const IntersectionResult intersections) {
  vec2 nearFar;
  if (cameraHeight < maxHeight) {
    if (intersections.ground) {
      nearFar = vec2(cameraNear, intersections.first.x);
    } else {
      nearFar = vec2(cameraNear, intersections.second.z);
    }
  } else {
    nearFar = vec2(cameraNear, intersections.second.z);
    if (intersections.ground) {
      // Clamp the ray at the ground.
      nearFar.y = intersections.first.x;
    }
  }
  return nearFar;
}
#endif // HAZE

float getRayDistanceToScene(const vec3 rayDirection, out float viewZ) {
  float depth = readDepthValue(depthBuffer, vUv * targetUvScale + temporalJitter);
  if (depth < 1.0 - 1e-7) {
    depth = reverseLogDepth(depth, cameraNear, cameraFar);
    viewZ = getViewZ(depth);
    return -viewZ / dot(rayDirection, vCameraDirection);
  }
  viewZ = 0.0;
  return 0.0;
}

void main() {
  #ifdef DEBUG_SHOW_SHADOW_MAP
  outputColor = getCascadedShadowMaps(vUv);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_SHADOW_MAP

  vec3 cameraPosition = vCameraPosition + altitudeCorrection;
  vec3 rayDirection = normalize(vRayDirection);
  float cosTheta = dot(sunDirection, rayDirection);

  IntersectionResult intersections = getIntersections(cameraPosition, rayDirection);
  vec2 rayNearFar = getRayNearFar(intersections);
  #ifdef SHADOW_LENGTH
  vec2 shadowRayNearFar = getShadowRayNearFar(intersections);
  #endif // SHADOW_LENGTH
  #ifdef HAZE
  vec2 hazeRayNearFar = getHazeRayNearFar(intersections);
  #endif // HAZE

  float sceneViewZ;
  float rayDistanceToScene = getRayDistanceToScene(rayDirection, sceneViewZ);
  if (rayDistanceToScene > 0.0) {
    rayNearFar.y = min(rayNearFar.y, rayDistanceToScene);
    #ifdef SHADOW_LENGTH
    shadowRayNearFar.y = min(shadowRayNearFar.y, rayDistanceToScene);
    #endif // SHADOW_LENGTH
    #ifdef HAZE
    hazeRayNearFar.y = min(hazeRayNearFar.y, rayDistanceToScene);
    #endif // HAZE
  }

  bool intersectsGround = any(lessThan(rayNearFar, vec2(0.0)));
  bool intersectsScene = rayNearFar.y < rayNearFar.x;

  float stbn = getSTBN();

  vec4 color = vec4(0.0);
  float frontDepth = rayNearFar.y;
  vec3 depthVelocity = vec3(0.0);
  float shadowLength = 0.0;
  bool hitClouds = false;

  if (!intersectsGround && !intersectsScene) {
    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;

    vec2 globeUv = getGlobeUv(rayOrigin);
    #ifdef DEBUG_SHOW_UV
    outputColor = vec4(vec3(checker(globeUv, localWeatherRepeat + localWeatherOffset)), 1.0);
    outputDepthVelocity = vec3(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_UV

    float mipLevel = getMipLevel(globeUv * localWeatherRepeat) * mipLevelScale;
    mipLevel = mix(0.0, mipLevel, min(1.0, 0.2 * cameraHeight / maxHeight));

    float marchedFrontDepth;
    ivec3 sampleCount = ivec3(0);
    color = marchClouds(
      rayOrigin,
      rayDirection,
      rayNearFar,
      cosTheta,
      stbn,
      pow(2.0, mipLevel),
      marchedFrontDepth,
      sampleCount
    );

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    outputColor = vec4(vec3(sampleCount) / vec3(500.0, 5.0, 5.0), 1.0);
    outputDepthVelocity = vec3(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_SAMPLE_COUNT

    // 【2026-09-29 2022m 黑斑机理钉死】fogDebug：R=门控 inLayerCam / G=受照样本比(÷12) /
    // B=出口 rgb 亮度×3。黑斑区读数组合区分：「R=1 G=0」（雾化门开但零受照——rgb=0 因无
    // 散射且 α=0.88 来自 T 积累？矛盾点）vs「R=1 G>0 B=0」（受照但 rad 积累 0——白化/地板
    // 未生效实锤）vs「R=0」（门控关——黑斑另有来源）。
    #ifdef DEBUG_SHOW_FOG_DEBUG
    outputColor = vec4(g_fogInLayer, g_fogLit / 12.0, dot(color.rgb, vec3(0.33333333)) * 3.0, 1.0);
    outputDepthVelocity = vec3(0.0);
    #ifdef SHADOW_LENGTH
    outputShadowLength = 0.0;
    #endif // SHADOW_LENGTH
    return;
    #endif // DEBUG_SHOW_FOG_DEBUG

    // Front depth will be -1.0 when no samples are accumulated.
    hitClouds = marchedFrontDepth >= 0.0;
    if (hitClouds) {
      frontDepth = rayNearFar.x + marchedFrontDepth;

      #ifdef SHADOW_LENGTH
      // Clamp the shadow length ray at the clouds.
      shadowRayNearFar.y = mix(
        shadowRayNearFar.y,
        min(frontDepth, shadowRayNearFar.y),
        color.a // Interpolate by the alpha for smoother edges.
      );

      // Shadow length must be computed before applying aerial perspective.
      if (all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {
        shadowLength = marchShadowLength(
          shadowRayNearFar.x * rayDirection + cameraPosition,
          rayDirection,
          shadowRayNearFar,
          stbn,
          // 【2026-09-21 P5】运动帧粗化（u_shaftMotionScale 静止=1 逐位）
          minShadowLengthStepSize * u_shaftMotionScale
        );
      }
      #endif // SHADOW_LENGTH

      #ifdef HAZE
      // Clamp the haze ray at the clouds.
      hazeRayNearFar.y = mix(
        hazeRayNearFar.y,
        min(frontDepth, hazeRayNearFar.y),
        color.a // Interpolate by the alpha for smoother edges.
      );
      #endif // HAZE

      // Apply aerial perspective.
      vec3 frontPosition = cameraPosition + frontDepth * rayDirection;
      g_probePreAerial = color.rgb;
      applyAerialPerspective(cameraPosition, frontPosition, shadowLength, color);

      // Velocity for temporal resolution.
      vec3 frontPositionWorld = ecefToWorld(frontPosition);
      vec4 prevClip = reprojectionMatrix * vec4(frontPositionWorld, 1.0);
      prevClip /= prevClip.w;
      vec2 prevUv = prevClip.xy * 0.5 + 0.5;
      vec2 velocity = vUv - prevUv;
      depthVelocity = vec3(frontDepth, velocity);
    }
  }

  if (!hitClouds) {
    #ifdef SHADOW_LENGTH
    if (all(greaterThanEqual(shadowRayNearFar, vec2(0.0)))) {
      // 【2026-09-05 兜底大步幅 / 09-21 P4 自适应】无云像素的满段 march=全屏成本大头
      // （白天贴地实测 6.6ms；且 ∝ 无云像素占比随时随天气漂移）；调制项为 km 级云影
      // 特征，大步幅画质保真（白天 ×4 逐位零差、低角守 ×2——见 uniform 处注）。
      shadowLength = marchShadowLength(
        shadowRayNearFar.x * rayDirection + cameraPosition,
        rayDirection,
        shadowRayNearFar,
        stbn,
        minShadowLengthStepSize * u_shadowFallbackStepScale * u_shaftMotionScale
      );
    }
    #endif // SHADOW_LENGTH

    // Velocity for temporal resolution. Here reproject in the view space for
    // greatly reducing the precision errors.
    frontDepth = sceneViewZ < 0.0 ? -sceneViewZ : cameraFar;
    vec3 frontView = vViewPosition * frontDepth;
    vec4 prevClip = viewReprojectionMatrix * vec4(frontView, 1.0);
    prevClip /= prevClip.w;
    vec2 prevUv = prevClip.xy * 0.5 + 0.5;
    vec2 velocity = vUv - prevUv;
    depthVelocity = vec3(frontDepth, velocity);
  }

  #ifdef DEBUG_SHOW_MARCH_RADIANCE
  // 【2026-09-03 穿云黑块探针】march 线性 rgb ×50 放大直显（a 钉 1 防 overlay alpha 混淆）——
  // 分辨「黑块区=暗云帧（rgb 低非零）」还是「无云帧（rgb=0）」。
  outputColor = vec4(color.rgb * 50.0, 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_MARCH_RADIANCE

  #ifdef DEBUG_SHOW_MARCH_ALPHA
  // 【2026-09-03 穿云黑块探针】march alpha 直显——黑块区 alpha 高 = overlay 在画暗云帧。
  outputColor = vec4(vec3(color.a), 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_MARCH_ALPHA

  #ifdef DEBUG_SHOW_PROBE_LIGHT
  // 【2026-09-28 层内黑楔排查】末次 media 采样点 sun+sky irradiance ×0.1 直显——
  // 黑楔区读数 0（黑）=光照项归零/NaN（LUT 或路径问题）、非 0=光照正常（NaN 在别处）。
  outputColor = vec4(g_probeSunSky * 0.1, 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_PROBE_LIGHT

  #ifdef DEBUG_SHOW_PROBE_OD
  // R=extinction×10 / G=to-sun 光深×0.1 / B=局部 radiance 标量——区分「extinction 积累但
  // radiance 为 0/NaN」（黑楔特征：R 亮 G/B 黑）与全零（无 media 采样：R=G=B=0）。
  outputColor = vec4(g_probeExt * 10.0, g_probeOD * 0.1, g_probeRad, 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_PROBE_OD

  #ifdef DEBUG_SHOW_PROBE_PREAERIAL
  // march 出口 rgb（aerial 前）×50——与 cloudsDebug=6（aerial 后）对照：pre 正常 post 黑
  // = NaN 诞生于 applyAerialPerspective；pre 黑 = NaN 诞生于 march 本体。
  outputColor = vec4(g_probePreAerial * 50.0, 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_PROBE_PREAERIAL

  #ifdef DEBUG_SHOW_FRONT_DEPTH
  outputColor = vec4(turbo(frontDepth / maxRayDistance), 1.0);
  outputDepthVelocity = vec3(0.0);
  #ifdef SHADOW_LENGTH
  outputShadowLength = 0.0;
  #endif // SHADOW_LENGTH
  return;
  #endif // DEBUG_SHOW_FRONT_DEPTH

  #ifdef HAZE
  vec4 haze = approximateHaze(
    cameraNear * rayDirection + cameraPosition,
    rayDirection,
    hazeRayNearFar.y - hazeRayNearFar.x,
    cosTheta,
    shadowLength
  );
  color.rgb = mix(color.rgb, haze.rgb, haze.a);
  color.a = color.a * (1.0 - haze.a) + haze.a;
  #endif // HAZE

  outputColor = color;
  outputDepthVelocity = depthVelocity;
  #ifdef SHADOW_LENGTH
  outputShadowLength = shadowLength * METER_TO_LENGTH_UNIT;
  #endif // SHADOW_LENGTH
}
