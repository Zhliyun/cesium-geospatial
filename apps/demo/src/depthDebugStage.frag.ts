import { DEPTH_RECONSTRUCTION_GLSL } from '@cesium-geospatial/core'

export function buildDepthDebugFragmentShader(): string {
  return `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
${DEPTH_RECONSTRUCTION_GLSL}
void main() {
  // 重建 ECEF 世界坐标，分量归一化可视化（每 1000km 一个色环）
  vec3 worldPos = reconstructWorldPositionECEF(depthTexture, v_textureCoordinates);
  vec3 vis = fract(worldPos / 1000000.0);
  float linDepth = linearDepth01(depthTexture, v_textureCoordinates);
  float rawDepth = texture(depthTexture, v_textureCoordinates).r;
  // 天空（无几何，rawDepth≈1）显示线性深度；地物显示世界坐标彩虹分量
  out_FragColor = vec4(mix(vis, vec3(linDepth), step(0.999, rawDepth)), 1.0);
}
`
}
