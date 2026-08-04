// lf_bloom series composite get(0) threshold fragment（learnopengl 13-tap 加权软阈值）。
// 读 atmosphere（series input = colorTexture），textureScale 1.0 全分（无下采样），sampleMode
// NEAREST（spec §5.7）——保护 atmosphere 的 input dithering 逐像素直通，13-tap 作轻度低通抑制
// 单像素热点（非"抗锯齿"，全分无下采样，spec §5.1 textureScale=1.0 理由③）。
//
// learnopengl 13-tap **加权**（非均匀平均，归一化）：center 0.125 + 内角(±1,±1)×4 @0.125 +
// 边中(±2,0)/(0,±2)×4 @0.0625 + 外角(±2,±2)×4 @0.03125（权重和=1.0）。数值取自
// lensFlareConstants.ts::LEARNOGLY_DOWNSAMPLE_WEIGHTS，GLSL 内直接写数值常量（避免运行时注入）。
//
// luminance 空间 smoothstep 软阈值：scale = smoothstep(level, level+range, l)，spec §5.1。
// NaN 守护：half-float LUT / 极端 exposure 下 inscatter 可能产生 NaN，归零防止扩散污染下游 bloom。
//
// luminance/saturate 显式定义（Cesium 无 three.js <common> shader chunk，spec §5.1 注）；saturate
// 为 three.js <common> 标准配对 helper，当前 threshold 未用但忠实移植保留。

// three.js <common> 移植：luminance（Rec.709 加权）+ saturate。Cesium PostProcessStage 不注入这俩。
const DEFINES_GLSL = `
#define luminance(c) dot(c, vec3(0.2126, 0.7152, 0.0722))
#define saturate(x) clamp(x, 0.0, 1.0)
`

// 内建纹理 uniform（Cesium series input = atmosphere，shader 须显式声明）+ threshold 控制 uniform。
const UNIFORMS_GLSL = `
uniform sampler2D colorTexture;
uniform vec2 u_texelSize;        // 源 texture（atmosphere）的 1/w, 1/h
uniform float u_thresholdLevel;
uniform float u_thresholdRange;
`

const MAIN_GLSL = `
in vec2 v_textureCoordinates;

void main() {
  vec2 ts = u_texelSize;
  // learnopengl 13-tap 加权（LEARNOGLY_DOWNSAMPLE_WEIGHTS）：
  //   center(0,0) @0.125
  vec3 color = texture(colorTexture, v_textureCoordinates).rgb * 0.125;
  //   内角(±1,±1)×4 @0.125
  color += (texture(colorTexture, v_textureCoordinates + vec2(-1.0, -1.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(1.0, 1.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(-1.0, 1.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(1.0, -1.0) * ts).rgb) * 0.125;
  //   边中(±2,0)/(0,±2)×4 @0.0625
  color += (texture(colorTexture, v_textureCoordinates + vec2(-2.0, 0.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(2.0, 0.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(0.0, -2.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(0.0, 2.0) * ts).rgb) * 0.0625;
  //   外角(±2,±2)×4 @0.03125（以上权重和=1.0，归一化）
  color += (texture(colorTexture, v_textureCoordinates + vec2(-2.0, -2.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(2.0, 2.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(-2.0, 2.0) * ts).rgb
          + texture(colorTexture, v_textureCoordinates + vec2(2.0, -2.0) * ts).rgb) * 0.03125;
  // luminance 空间 smoothstep 软阈值（spec §5.1）。
  float l = luminance(color);
  float scale = smoothstep(u_thresholdLevel, u_thresholdLevel + u_thresholdRange, l);
  vec3 result = color * scale;
  // NaN 守护：half-float 灾消/极端 exposure 下归零，防扩散污染下游 bloom pyramid。
  if (any(isnan(result))) result = vec3(0.0);
  out_FragColor = vec4(result, 1.0);
}
`

// 供 Task 3 接线一致性测试：threshold stage 声明的 uniform（colorTexture 是 Cesium 内建白名单）。
export const THRESHOLD_UNIFORM_NAMES: string[] = ['u_texelSize', 'u_thresholdLevel', 'u_thresholdRange']

// 组装 PostProcessStage 用 fragment shader（供 Cesium 运行时；colorTexture/v_textureCoordinates
// 由 Cesium 注入值，shader 显式声明；out_FragColor 由 Cesium 注入声明）。
export function buildThresholdFragmentShader(): string {
  return [DEFINES_GLSL, UNIFORMS_GLSL, MAIN_GLSL].join('\n')
}

// 供 glslang 独立校验：补 #version 300 es + precision + out_FragColor 桩。
// luminance/saturate defines 已在主体 DEFINES_GLSL（Cesium 无 <common>，运行时也需），此处不重复。
// colorTexture/u_texelSize/u_thresholdLevel/u_thresholdRange/v_textureCoordinates 在主体声明。
const VALIDATION_STUBS_GLSL = `
out vec4 out_FragColor;
`

export function buildStandaloneShaderForValidation(): string {
  return [
    '#version 300 es',
    'precision highp float;',
    // GLSL ES 3.00 sampler 不继承 float precision，移动 GPU 严格需独立声明（对齐 tonemap.frag.ts
    // validation 桩）。threshold 无 sampler3D，不声明那条。
    'precision highp int;',
    'precision highp sampler2D;',
    VALIDATION_STUBS_GLSL,
    buildThresholdFragmentShader()
  ].join('\n')
}
