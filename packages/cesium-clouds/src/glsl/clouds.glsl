float getSTBN() {
  ivec3 size = textureSize(stbnTexture, 0);
  vec3 scale = 1.0 / vec3(size);
  return texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)) * scale).r;
}

// Straightforward spherical mapping
vec2 getSphericalUv(const vec3 position) {
  vec2 st = normalize(position.yx);
  float phi = atan(st.x, st.y);
  float theta = asin(normalize(position).z);
  return vec2(phi * RECIPROCAL_PI2 + 0.5, theta * RECIPROCAL_PI + 0.5);
}

// getCubeSphereUv 已移除（2026-09-03 face 缝根治，方案 A）——旧 cube-sphere face uv
// 实现见 git 历史（takram 上游 TODO "Tile and fix seams" 的遗留）。weather 采样域统一
// 走下方 getGlobeUv 经纬等距圆柱域。

vec2 getGlobeUv(const vec3 position) {
  // 经纬等距圆柱域（face 缝根治 2026-09-03，方案 A 用户拍板）：weather atlas 采样域从
  // cube-sphere face uv（takram 上游同位 TODO "Tile and fix seams" 未修，旧实现见 git）
  // 换成全球连续的经纬度。根治两症状（2026-09-03 用户复现 lon=-25/lat=42 恰在 +X/+Z
  // face 边界，?play&speed=60 下显形）：
  //  ① 边界两侧图案突变——face uv 跨界跳变 → 采样内容不连续；
  //  ② 平流方向不一致——u_windOffset 加在 uv 域，face 基向各异 → 地面方向不同，
  //     speed=60 时有效 480m/s 反向跑极显眼。
  // 经纬域下 uv 及导数（dFdx→getMipLevel 的 mip 跳变）全球连续；经度割缝（lon=±π）
  // x 两侧差 0.5×repeat.x，repeat.x 取偶数（默认 400）时 REPEAT wrap 两侧同点闭合。
  // 已知取舍（拍板记录）：等距圆柱失真——高纬瓦物理宽度 ×cos(lat)，云图横向压密
  // （内容随机，观感=高纬云横向更细碎）；极点收缩为线。repeat 语义随之更新：
  // x=经向瓦数（赤道瓦宽 40075/x km）、y=纬向瓦数（默认 x/2 保瓦物理方形）。
  vec3 n = normalize(position);
  float lon = atan(n.y, n.x);
  float lat = asin(clamp(n.z, -1.0, 1.0));
  return vec2(lon * 0.15915494309189535 + 0.5, 0.5 + lat * 0.3183098861837907); // 1/2π, 1/π
}

float getMipLevel(const vec2 uv) {
  const float mipLevelScale = 0.1;
  vec2 coord = uv * resolution;
  vec2 ddx = dFdx(coord);
  vec2 ddy = dFdy(coord);
  float deltaMaxSqr = max(dot(ddx, ddx), dot(ddy, ddy)) * mipLevelScale;
  return max(0.0, 0.5 * log2(max(1.0, deltaMaxSqr)));
}

bool insideLayerIntervals(const float height) {
  bvec3 gt = greaterThan(vec3(height), minIntervalHeights);
  bvec3 lt = lessThan(vec3(height), maxIntervalHeights);
  return any(bvec3(gt.x && lt.x, gt.y && lt.y, gt.z && lt.z));
}

struct WeatherSample {
  vec4 heightFraction; // Normalized height of each layer
  vec4 density;
};

vec4 shapeAlteringFunction(const vec4 heightFraction, const vec4 bias) {
  // Apply a semi-circle transform to round the clouds towards the top.
  vec4 biased = pow(heightFraction, bias);
  vec4 x = clamp(biased * 2.0 - 1.0, -1.0, 1.0);
  return 1.0 - x * x;
}

// clouds.glsl —— 在 sampleWeather 前插入气候带包络（spec §5.4）
// latSin = normalize(position).z（ECEF z=极轴，地心纬度正弦；密切球系偏差 ≤0.4° 不可见）
float getClimateBandFactor(const float latSin) {
  float latAbs = abs(latSin);
  // ITCZ 峰：中心 u_itczCenterSin、半宽 ±10°（sin 域 0.174），cos 窗
  float d = abs(latSin - u_itczCenterSin);
  float itcz = 1.0 - smoothstep(0.0, 0.174, d);
  // 副热带高压谷（|latSin| 0.42-0.50）
  float subtropicsDip = smoothstep(0.32, 0.42, latAbs) * (1.0 - smoothstep(0.50, 0.60, latAbs));
  // 中纬度风暴带峰（|latSin| 0.707-0.866 = 45-60°，r2 修正 r1 笔误 0.66-0.77）
  float midlatPeak = smoothstep(0.62, 0.707, latAbs) * (1.0 - smoothstep(0.866, 0.94, latAbs));
  // 极地衰减（>72°，sin 0.951）
  float polarDry = smoothstep(0.951, 0.995, latAbs);
  float band = 1.0
    + 0.45 * itcz
    - 0.45 * subtropicsDip
    + 0.30 * midlatPeak
    - 0.35 * polarDry;
  band = clamp(band, u_climateBandsFloor, 1.3); // 上界 1.3 防「实心白环」（spec §5.4）；下限 uniform 化（T6）——预设激活 0.6（「阴天」×副热带谷不退化为近晴空）、缺省 0.2（原字面量，零回归）
  return mix(1.0, band, u_climateBands); // u_climateBands=0 → 恒 1（纯随机分布）
}

WeatherSample sampleWeather(const vec2 uv, const vec3 position, const float height, const float mipLevel) {
  WeatherSample weather;
  weather.heightFraction = remapClamped(vec4(height), minLayerHeights, maxLayerHeights);

  // 3D atlas 采样（spec §4）：z=u_atlasT 相邻切片 LINEAR 插值；平流 tile 单位 mod 1
  vec3 weatherCoord = vec3(uv * localWeatherRepeat + localWeatherOffset + u_windOffset, u_atlasT);
  vec4 localWeather = pow(
    textureLod(weatherAtlasTexture, weatherCoord, mipLevel).LOCAL_WEATHER_CHANNELS,
    weatherExponents
  );
  // 纬度气候带（spec §5.4，采样侧——march 手上有真实 position）
  localWeather *= getClimateBandFactor(normalize(position).z);
  #ifdef SHADOW
  localWeather *= shadowLayerMask;
  #endif // SHADOW

  vec4 heightScale = shapeAlteringFunction(weather.heightFraction, shapeAlteringBiases);
  // 顶面蓬松化（u_topPuffWeights，2026-09-29 密度分布专项）：半圆包络在顶段单调衰减
  // （bias=0.35 时 hf=0.8 → hs=0.28、hf≥0.95 → hs≈0）→ coverage factor→1 → 密度归零带
  // 覆盖顶部 ~25-30% 层厚，3D shape/detail 噪声在零密度区全部失效 → 俯视顶面=天气图案
  // 直投影（3035/3199/3187「一层一层二维」实测）。max 合成：底/中段原半圆主导（平台为
  // 0），顶段平台接管。两段 smoothstep 连续无阶跃（层内雾化连续化教训：分支域拼贴）。
  // 云顶高度场（二轮修正 d4a19ad 后用户复测等高线仍在）：归零带起点若为常数 hf，顶面
  // 仍是同一等高面——平面切 3D detail 噪声=等值线环纹（真·等高线，俯视切片本性）。
  // 改为云顶高度 ∝ localWeather 低频天气场（clamp 防气候带 >1 外推）：云团核心长到近
  // 层顶（0.97 起 3% 归零封口）、边缘矮（0.78 起缓归零）→ 圆丘群取代平台海。
  // 三轮补中频（真机复测网纹仍在的根因）：weather 频率 ~100km 级，几 km 视距内其调制
  // 的顶面高度近恒定 → 近中景顶面仍是平面切片。shape 噪声降频 16× 提供 1-10km 中频
  // 谷脊（mix 0.6-1.0 深谷权重），与 weather 圆丘包络相乘——顶面高度场跨三个频率层级
  // （weather 十 km+ 包络 / shape 中频谷脊 / detail 高频侵蚀），平面切片被彻底打破。
  float puffMid = texture(shapeTexture, position * shapeRepeat * 0.0625 + shapeOffset).r;
  vec4 puffTop = mix(vec4(0.74), vec4(0.97),
    clamp(localWeather, 0.0, 1.0) * mix(0.6, 1.0, puffMid));
  vec4 puffPlateau = smoothstep(vec4(0.70), vec4(0.85), weather.heightFraction)
    * (1.0 - smoothstep(puffTop, vec4(1.0), weather.heightFraction))
    * vec4(0.85);
  heightScale = max(heightScale, puffPlateau * u_topPuffWeights);

  // Modulation to control weather by coverage parameter.
  // Reference: https://github.com/Prograda/Skybolt/blob/master/Assets/Core/Shaders/Clouds.h#L63
  vec4 factor = 1.0 - coverage * heightScale;
  weather.density = remapClamped(
    mix(localWeather, vec4(1.0), coverageFilterWidths),
    factor,
    factor + coverageFilterWidths
  );

  return weather;
}

vec4 getLayerDensity(const vec4 heightFraction) {
  // prettier-ignore
  return densityProfile.expTerms * exp(densityProfile.exponents * heightFraction) +
    densityProfile.linearTerms * heightFraction +
    densityProfile.constantTerms;
}

struct MediaSample {
  float density;
  vec4 weight;
  float scattering;
  float extinction;
};

MediaSample sampleMedia(
  const WeatherSample weather,
  const vec3 position,
  const vec2 uv,
  const float mipLevel,
  const float jitter,
  out ivec3 sampleCount
) {
  vec4 density = weather.density;

  vec3 turbulence = vec3(0.0);
  #ifdef TURBULENCE
  vec2 turbulenceUv = uv * localWeatherRepeat * turbulenceRepeat;
  turbulence =
    turbulenceDisplacement *
    (texture(turbulenceTexture, turbulenceUv).rgb * 2.0 - 1.0) *
    dot(density, remapClamped(weather.heightFraction, vec4(0.3), vec4(0.0)));
  #endif // TURBULENCE

  // P1：+u_shapeWindOffset——云团 coverage 平流（u_windOffset）时内部三维结构跟随漂移
  //（此前 shape 纹理完全静态：轮廓动而内部花纹焊死）。纹理域 mod 1，CPU 侧算好。
  vec3 shapePosition = (position + turbulence) * shapeRepeat + shapeOffset + u_shapeWindOffset;
  float shape = texture(shapeTexture, shapePosition).r;
  density = remapClamped(density, vec4(1.0 - shape) * shapeAmounts, vec4(1.0));

  #ifdef DEBUG_SHOW_SAMPLE_COUNT
  ++sampleCount.y;
  #endif // DEBUG_SHOW_SAMPLE_COUNT

  #ifdef SHAPE_DETAIL
  if (mipLevel * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {
    vec3 detailPosition = (position + turbulence) * shapeDetailRepeat + shapeDetailOffset + u_detailWindOffset;
    float detail = texture(shapeDetailTexture, detailPosition).r;
    // Fluffy at the top and whippy at the bottom.
    vec4 modifier = mix(
      vec4(pow(detail, 6.0)),
      vec4(1.0 - detail),
      remapClamped(weather.heightFraction, vec4(0.2), vec4(0.4))
    );
    modifier = mix(vec4(0.0), modifier, shapeDetailAmounts);
    density = remapClamped(density * 2.0, vec4(modifier * 0.5), vec4(1.0));

    #ifdef DEBUG_SHOW_SAMPLE_COUNT
    ++sampleCount.z;
    #endif // DEBUG_SHOW_SAMPLE_COUNT
  }
  #endif // SHAPE_DETAIL

  // Apply the density profiles.
  density = saturate(density * densityScales * getLayerDensity(weather.heightFraction));

  MediaSample media;
  float densitySum = density.x + density.y + density.z + density.w;
  media.weight = density / densitySum;
  media.scattering = densitySum * scatteringCoefficient;
  media.extinction = densitySum * absorptionCoefficient + media.scattering;
  return media;
}

MediaSample sampleMedia(
  const WeatherSample weather,
  const vec3 position,
  const vec2 uv,
  const float mipLevel,
  const float jitter
) {
  ivec3 sampleCount;
  return sampleMedia(weather, position, uv, mipLevel, jitter, sampleCount);
}
