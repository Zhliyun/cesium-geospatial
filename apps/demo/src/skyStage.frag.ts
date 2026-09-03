import { glslIndex, resolveIncludes, buildAtmospherePrefix } from '@cesium-geospatial/core'

// 源仓库 sky.frag 主体适配：去掉 uniform AtmosphereParameters ATMOSPHERE（由 prefix 的 const 提供），
// 保留 LUT sampler 与 SUN/SKY_SPECTRAL uniform（runtime 末尾的 #define GetSkyRadiance
// GetSkyLuminance 便捷函数引用这些全局 uniform）。
// 射线重建（源仓库 sky.vert 的 inverseProj/inverseView 逻辑）合并进 fragment，用 czm_* 替代。
const skyFragBody = `
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler2D irradiance_texture;
// buildAtmospherePrefix 恒 define HAS_HIGHER_ORDER_SCATTERING_TEXTURE（云 god rays 防过暗，C9），
// runtime.glsl 的 GetSkyRadiance/GetSkyRadianceToPoint 在该分支引用此 uniform——漏声明即
// undeclared identifier 编译炸（渲染中止：tiles/云全部停摆，浏览器 A/B 实验全成死帧伪像；
// aerialPerspective/clouds 均各自声明，唯此文件遗漏）。绑定见 SkyStage uniforms。
uniform sampler3D higher_order_scattering_texture;

#include "bruneton/common"
#include "bruneton/runtime"

uniform vec3 sunDirection;
uniform vec3 altitudeCorrection;
uniform float u_debugMode; // 0=正常tone map 1=log(1+radiance) 2=太阳方向 3=相机位置量级

in vec2 v_textureCoordinates;

void main() {
  // —— 替代 sky.vert：从 v_textureCoordinates + czm 反投影重建相机射线 ——
  vec2 ndc = v_textureCoordinates * 2.0 - 1.0;
  vec4 viewCoord = czm_inverseProjection * vec4(ndc, -1.0, 1.0);
  vec3 viewRay = normalize(viewCoord.xyz);
  vec3 rayDirection = normalize((czm_inverseView * vec4(viewRay, 0.0)).xyz);

  // —— ECEF 桥接：Cesium world 即 ECEF，czm_viewerPositionWC 直接给相机 ECEF 米 ——
  vec3 cameraECEF = czm_viewerPositionWC;
  vec3 cameraPosition = (cameraECEF + altitudeCorrection) * METER_TO_LENGTH_UNIT;

  // —— GetSkyRadiance 被 runtime 末尾 #define 成 GetSkyLuminance（用全局 texture uniform）——
  vec3 transmittance;
  vec3 radiance = GetSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, transmittance);

  if (u_debugMode > 2.5) {
    // 模式3：相机位置量级。cameraPosition 单位是 length unit（km），应≈6371。
    // 显示 length/6420（top_radius），地表≈0.99（近白），过大/为0即桥接断。
    float r = length(cameraPosition) / 6420.0;
    out_FragColor = vec4(vec3(r), 1.0);
    return;
  }
  if (u_debugMode > 1.5) {
    // 模式2：太阳方向可视化（世界系）。红=+x 绿=+y 蓝=+z。
    out_FragColor = vec4(sunDirection * 0.5 + 0.5, 1.0);
    return;
  }
  if (u_debugMode > 0.5) {
    // 模式1：对数刻度看微弱 radiance。log10(1+radiance)/2，0→黑，~100→白。
    vec3 v = log(vec3(1.0) + max(radiance, vec3(0.0))) / log(100.0);
    out_FragColor = vec4(clamp(v, 0.0, 1.0), 1.0);
    return;
  }

  // tone map：debug=1 对数刻度定标，relative-luminance 下天空主体 radiance≈0.1~2、
  // 向阳亮弧峰值≈9。占位曝光 1.0 会整体压黑，提到 3.0 让主体落入敏感区，
  // Reinhard(x/(1+x)) 压缩峰值防亮弧过曝。
  radiance = radiance * 3.0;
  radiance = radiance / (vec3(1.0) + radiance);
  out_FragColor = vec4(radiance, 1.0);
}
`

export function buildSkyFragmentShader(): string {
  const assembled = resolveIncludes(skyFragBody, {
    bruneton: {
      common: glslIndex.bruneton.common,
      runtime: glslIndex.bruneton.runtime
    }
  })
  return buildAtmospherePrefix() + '\n' + assembled
}
