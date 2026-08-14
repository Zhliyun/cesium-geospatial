// M2 T1：three clouds.frag → Cesium 主 march fragment shader 桥接组装器。
//
// 核心挑战（plan T1）：clouds.frag 是完整 three.js fragment shader——
//   - 头部 1-99：precision + #include + three uniform（viewMatrix/cameraNear/Far/...）+ 7 个 in
//     varying（vUv/vCameraPosition/vCameraDirection/vRayDirection/vViewPosition/vGroundIrradiance/
//     vCloudsIrradiance，由 clouds.vert 算）+ MRT out layout（loc 0/1/2）
//   - main 100-1003：marchClouds 主循环 + shadow（BSM PCF）/haze/aerial perspective（bruneton
//     GetSkyRadianceToPoint）/temporal reprojection 交织，含多个 #ifdef DEBUG 分支
//
// M1 VolumetricPrimitive 用 createViewportQuadCommand（Cesium ViewportQuadVS 只输出
// v_textureCoordinates，不走 clouds.vert）。本组装器在编排层做文本手术 + 桥接 prefix，让
// clouds.frag 在 Cesium viewport quad 下跑（不动 clouds.frag 原文，保持 three 版形态便于上游 diff）。
//
// 桥接设计（方案 C：完整 clouds.frag + #define 占位 + dummy uniform）：
//   1. 剥离 3 个 three uniform（viewMatrix/cameraNear/cameraFar）→ #define 重定向到 czm_*
//   2. 剥离 7 个 in varying → 在 fragment 从 czm_viewerPositionWC / czm_inverseView /
//      czm_windowToEyeCoordinates + v_textureCoordinates 重建（clouds.vert 等价，但只在 fragment 跑）
//   3. 重命名 main → cloudsMainBody；wrapper main 先 cloudsBridge_reconstructVaryings() 再调用
//   4. M3/M4/M5 dummy：
//      - M3 BSM：不摘 shadowBuffer 声明（T2 提供 1×1×4 全 0 纹理）→ sampleShadowOpticalDepth 返 0
//        → Beer-Lambert 1（无自阴影，flat lighting）
//      - M4 temporal：不摘 reprojectionMatrix/viewReprojectionMatrix（T2 提供 identity）→ velocity
//        非 0 但 outputDepthVelocity 在 M2 未被消费（M4 resolve 接通）
//      - M5 god rays：不 define SHADOW_LENGTH → marchShadowLength/outputShadowLength(loc2) 不编译；
//        applyAerialPerspective 用 shadowLength=0 调 GetSkyRadianceToPoint（无 god rays）
//      - HAZE / GROUND_BOUNCE：不 define → 不编译
//      - ACCURATE_SUN_SKY_LIGHT：define → getCloudsSunSkyIrradiance 走 bruneton runtime 直算，
//        绕过 vGroundIrradiance/vCloudsIrradiance varying（fragment 重建下避免顶点预计算）
//      - getRayDistanceToScene：clouds.frag 原文读 depthBuffer（T2 提供 1×1 val=1.0 dummy →
//        depth<1.0-1e-7 false → 返 0.0 远截断；M6 接通真实 globe depthTexture + log-depth 转换）
//
// 双入口（仿 core aerialPerspective.frag.ts）：
//   - buildCloudsMainFragmentShader()：Cesium 运行时（无 #version；czm_* automatic uniform 由
//     ShaderProgram 自动注入）
//   - buildStandaloneCloudsShaderForValidation()：glslang 校验（补 #version 300 es + czm_* 桩）

import { ATMOSPHERE_DEFAULT_GLSL } from '@cesium-geospatial/core'
import { glslIndex } from './glslIndex'
import { resolveCloudsIncludes } from './resolveCloudsIncludes'

// M2 T1 桥接选项。
export interface CloudsMainOptions {
  /**
   * SHAPE_DETAIL 分支开关（clouds.glsl sampleMedia 走 shapeDetailTexture 细节修饰）。
   * 默认 true（M1 已搬 cloudShapeDetail 烘焙 + weather shape_detail 资产）。
   */
  shapeDetail?: boolean
  /**
   * TURBULENCE 分支开关（sampleMedia 走 turbulenceTexture 卷曲位移）。
   * 默认 true。
   */
  turbulence?: boolean
  /**
   * ACCURATE_SUN_SKY_LIGHT 开关（getCloudsSunSkyIrradiance 走 bruneton runtime
   * GetSunAndSkyScalarIrradiance 直算，绕过 vGroundIrradiance/vCloudsIrradiance varying）。
   * 默认 true（fragment 重建下避免顶点 irradiance 预计算；M2 clouds.vert 不走）。
   */
  accurateSunSkyLight?: boolean
}

type ResolvedCloudsMainOptions = Required<CloudsMainOptions>

const DEFAULTS: ResolvedCloudsMainOptions = {
  shapeDetail: true,
  turbulence: true,
  accurateSunSkyLight: true
}

// Bruneton 大气 LUT 纹理尺寸 + 单位换算 + 多阶散射开关——clouds.frag 经 #include
// "atmosphere/bruneton/runtime" 引用这些（runtime 末尾 GetSkyRadianceToPoint 用）。
// 值逐字对齐 clouds.compile.test.ts BRUNETON_DEFINES（源自 core/cesium/cesiumCore.ts
// buildAtmospherePrefix）。T2 运行时 assembler 复用同一组。
const BRUNETON_DEFINES = [
  '#define TRANSMITTANCE_TEXTURE_WIDTH 256',
  '#define TRANSMITTANCE_TEXTURE_HEIGHT 64',
  '#define SCATTERING_TEXTURE_R_SIZE 32',
  '#define SCATTERING_TEXTURE_MU_SIZE 128',
  '#define SCATTERING_TEXTURE_MU_S_SIZE 32',
  '#define SCATTERING_TEXTURE_NU_SIZE 8',
  '#define IRRADIANCE_TEXTURE_WIDTH 64',
  '#define IRRADIANCE_TEXTURE_HEIGHT 16',
  '#define METER_TO_LENGTH_UNIT 0.001',
  '#define COMBINED_SCATTERING_TEXTURES',
  '#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE'
]

// clouds.frag 主 pipeline 额外 define（对齐 clouds.compile.test.ts CLOUDS_FRAG_DEFINES）。
// unroll 循环上界（SHADOW_CASCADE_COUNT/SHADOW_SAMPLE_COUNT/MULTI_SCATTERING_OCTAVES）+
// sampleWeather swizzle 宏 + DEPTH_PACKING（readDepthValue 走 texture().r 分支）。
const CLOUDS_MAIN_DEFINES = [
  ...BRUNETON_DEFINES,
  '#define SCATTER_ANISOTROPY_1 0.5',
  '#define SCATTER_ANISOTROPY_2 -0.5',
  '#define SCATTER_ANISOTROPY_MIX 0.35',
  '#define SHADOW_CASCADE_COUNT 4',
  '#define SHADOW_SAMPLE_COUNT 16',
  '#define MULTI_SCATTERING_OCTAVES 6',
  '#define LOCAL_WEATHER_CHANNELS rgba',
  '#define DEPTH_PACKING 0'
]

// 构造 M2 运行期 define 集（基础 clouds.frag 编译分支 + M2 桥接分支开关）。
function buildM2Defines(o: ResolvedCloudsMainOptions): string[] {
  return [
    ...CLOUDS_MAIN_DEFINES,
    '#define PERSPECTIVE_CAMERA', // getViewZ perspectiveDepthToViewZ 分支（Cesium 相机恒透视）
    o.accurateSunSkyLight ? '#define ACCURATE_SUN_SKY_LIGHT' : '',
    o.shapeDetail ? '#define SHAPE_DETAIL' : '',
    o.turbulence ? '#define TURBULENCE' : ''
  ].filter(s => s.length > 0)
}

// czm_* automatic uniform / 函数桩（仅 glslang 校验用）。
// Cesium 运行时由 ShaderProgram._automaticUniforms 自动注入（spec 附录 F6 R10 已确认 Primitive
// 走 ShaderProgram 必注入）。校验入口补类型匹配的桩声明 + 桩函数。
const CZM_STUBS_GLSL = `
// czm_* automatic uniform 桩（Cesium 运行时注入；glslang 校验需手写声明）
uniform vec3 czm_viewerPositionWC;
uniform mat4 czm_view;
uniform mat4 czm_inverseView;
uniform mat4 czm_inverseProjection;
uniform vec2 czm_currentFrustum;
// czm_windowToEyeCoordinates 桩：实际 Cesium 函数把 window 坐标（含 log-depth）反演到 eye space。
// 校验只需类型签名匹配（vec4 → vec4），不执行真反演。
vec4 czm_windowToEyeCoordinates(vec4 windowCoord) { return windowCoord; }
`

// 桥接 #define：clouds.frag three.js 命名 uniform → Cesium automatic uniform 重定向。
// 必须放在 clouds.frag 文本之前（预处理期替换所有使用点）。剥离 clouds.frag 原 three 声明后，
// 这是 viewMatrix/cameraNear/cameraFar 的唯一定义来源。
//
// 注：GLSL 预处理器 #define IDENT REPL 是 token 级替换——`inverseViewMatrix`/`viewReprojectionMatrix`
// 是不同 token，不会被 `#define viewMatrix czm_view` 误伤。
const BRIDGE_DEFINES_GLSL = `
// —— Cesium → three 桥接：uniform #define 重定向 ——
// clouds.frag 原声明 uniform mat4 viewMatrix / float cameraNear / float cameraFar（three.js 命名）。
// 剥离原声明后用 #define 重定向到 Cesium automatic uniform；使用点（getViewZ / getRayNearFar /
// sampleShadowOpticalDepth 内 getFadedCascadeIndex / marchShadowLength）自动跟随。
// inverseViewMatrix / cameraPosition / worldToECEFMatrix 只在 clouds.vert 用（M2 不走 vert，N/A）。
#define viewMatrix czm_view
#define cameraNear czm_currentFrustum.x
#define cameraFar czm_currentFrustum.y
`

// 桥接 varying 重建块（替代 clouds.frag 原 7 个 in varying；clouds.vert 算 → fragment 重建）。
//
// 必须出现在 clouds.frag `#include "types"` 之后（GroundIrradiance/CloudsIrradiance 类型可见），
// 故接到 clouds.frag 文本末尾（surgery 后 main 已改名为 cloudsMainBody），wrapper main 之前。
//
// 重建几何（clouds.vert 等价，Cesium 自动 uniform 替代 three uniform）：
//   - vUv = v_textureCoordinates（Cesium ViewportQuadVS position.xy*0.5+0.5 == clouds.vert L68）
//   - vCameraPosition = czm_viewerPositionWC（ECEF 相机，米；clouds.frag main L833 + altitudeCorrection
//     得密切球局部系坐标——worldToECEFMatrix 在 Cesium 退化为单位，故无需变换）
//   - vRayDirection = czm_windowToEyeCoordinates 近/远平面差分 → czm_inverseView 转 ECEF
//     （仿 core aerialPerspective.frag.ts reconstructRay，避免 ndc + inverseProjection 在仰视
//     净空 / log-depth 下退化）
//   - vCameraDirection = czm_inverseView * vec4(0,0,-1,0)（相机正前方向 ECEF，clouds.vert L72 等价；
//     getRayDistanceToScene L817 用，M6 depth 接通时生效）
//   - vViewPosition = view-space 单位视线方向（M2 reprojection dummy；M4 temporal 接通时按 three
//     inverseProjection*ndc 量纲精修——见 clouds.vert L70）
//   - vGroundIrradiance/vCloudsIrradiance = 零（ACCURATE_SUN_SKY_LIGHT define 绕过 varying 读取）
const BRIDGE_VARYINGS_GLSL = `
// —— Cesium → three 桥接：varying 重建（替代 clouds.frag 原 7 个 in，clouds.vert 算）——
// M1 VolumetricPrimitive 用 createViewportQuadCommand（Cesium ViewportQuadVS 只输出
// v_textureCoordinates），不走 clouds.vert。在 fragment 从 czm_* + v_textureCoordinates 重建。
in vec2 v_textureCoordinates;  // Cesium ViewportQuadVS 注入

// 替代 clouds.frag 原 in varying（clouds.vert 本应输出）——声明为普通全局，由
// cloudsBridge_reconstructVaryings() 在 main 起始处填充。clouds.frag main（已改名 cloudsMainBody）
// 像原 three 版一样直接读这些变量。
vec2 vUv;
vec3 vCameraPosition;
vec3 vCameraDirection;
vec3 vRayDirection;
vec3 vViewPosition;
GroundIrradiance vGroundIrradiance;
CloudsIrradiance vCloudsIrradiance;

// 桥接：从 czm_* 重建 clouds.vert 本应输出的 varying。wrapper main 调用一次后 cloudsMainBody
// 接管，原 clouds.frag main 体不变。
void cloudsBridge_reconstructVaryings() {
  vUv = v_textureCoordinates;
  // ECEF 相机（米）——clouds.frag main L833 「+ altitudeCorrection」得密切球局部系坐标。
  vCameraPosition = czm_viewerPositionWC;

  // 视线方向（view space）：czm_windowToEyeCoordinates 近/远平面差分（仿 core reconstructRay）。
  vec4 eyeNear = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, 0.0, 1.0));
  vec4 eyeFar = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, 1.0, 1.0));
  if (abs(eyeNear.w) > 1e-10) eyeNear /= eyeNear.w;
  if (abs(eyeFar.w) > 1e-10) eyeFar /= eyeFar.w;
  vec3 dirEC = eyeFar.xyz - eyeNear.xyz;
  if (dot(dirEC, dirEC) < 1e-20) dirEC = eyeFar.xyz;
  vViewPosition = normalize(dirEC);  // view-space 单位方向（M2 reprojection dummy；M4 量纲精修）
  vRayDirection = (czm_inverseView * vec4(dirEC, 0.0)).xyz;  // ECEF 视线方向

  // 相机正前方向（view -Z → ECEF）——clouds.vert L72 等价。getRayDistanceToScene 用（M6 接通）。
  vCameraDirection = (czm_inverseView * vec4(0.0, 0.0, -1.0, 0.0)).xyz;

  // ACCURATE_SUN_SKY_LIGHT define → getCloudsSunSkyIrradiance 走 GetSunAndSkyScalarIrradiance
  // 直算，vGroundIrradiance/vCloudsIrradiance 不被读；零初始化避免未定义读（GLSL 全局默认零，
  // 此处显式注释意图，便于关闭 ACCURATE_SUN_SKY_LIGHT 时排查）。
  vGroundIrradiance.sun = vec3(0.0);
  vGroundIrradiance.sky = vec3(0.0);
  vCloudsIrradiance.minSun = vec3(0.0);
  vCloudsIrradiance.minSky = vec3(0.0);
  vCloudsIrradiance.maxSun = vec3(0.0);
  vCloudsIrradiance.maxSky = vec3(0.0);
}
`

// wrapper main：重建桥接 varying 后调用 clouds.frag 原 main（cloudsMainBody）。
// cloudsMainBody 内 `return;`（DEBUG 分支，M2 默认 #ifdef 掉）只 return 出 cloudsMainBody，
// wrapper 顺势结束 main。MRT outputColor/outputDepthVelocity 在 cloudsMainBody 体内写入。
const WRAPPER_MAIN_GLSL = `
// M2 T1 wrapper main：先重建桥接 varying，再跑 clouds.frag 原 main 体（cloudsMainBody）。
void main() {
  cloudsBridge_reconstructVaryings();
  cloudsMainBody();
}
`

// 文本手术：剥离 + 改名 clouds.frag 源（不改原 .glsl 文件）。
// 锚点唯一性已核实（grep 验证）：viewMatrix/cameraNear/cameraFar 各一处；in vUv...in CloudsIrradiance
// vCloudsIrradiance 一段连续；void main() 一处。
//
// 关键：桥接 varying 声明必须 IN-PLACE 替换 clouds.frag 原 `in` 块（L87-93，位于所有使用 vUv 等
// 的函数之前）。若追加到文件末尾，getRayDistanceToScene / getCloudsSunSkyIrradiance 等函数会在
// 声明前使用 vUv/vGroundIrradiance → GLSL undeclared identifier。
function surgeryCloudsFrag(source: string): string {
  let src = source

  // 1) 剥离 3 个桥接 uniform 声明（与 BRIDGE_DEFINES_GLSL #define 重定向配套；防双重声明冲突）
  src = src.replace(/uniform mat4 viewMatrix;\n/, '')
  src = src.replace(/uniform float cameraNear;\n/, '')
  src = src.replace(/uniform float cameraFar;\n/, '')

  // 1b) 剥离 uniform AtmosphereParameters ATMOSPHERE; → 原地替换为 const ATMOSPHERE 构造。
  //     原因（同 core cesiumCore.ts 注释）：Cesium uniformMap（ShaderProgram 自动 uniform 派发）
  //     不支持嵌套 struct / struct 数组——AtmosphereParameters 含 DensityProfile（内嵌
  //     DensityProfileLayer[2] 数组），无法经 uniformMap 注入。core 已验证的方案是 GLSL
  //     `const` 构造注入（ATMOSPHERE_DEFAULT_GLSL，逐字取自 three-geospatial
  //     AtmosphereParameters.DEFAULT）。此 uniform 声明位于 clouds.frag L19（紧跟 L17
  //     #include "atmosphere/bruneton/definitions" 之后），原地替换保证 const 在 struct 定义之后。
  src = src.replace(
    /uniform AtmosphereParameters ATMOSPHERE;\n/,
    `${ATMOSPHERE_DEFAULT_GLSL}\n`
  )

  // 2) IN-PLACE 替换 7 个 in varying 块（L87-93）为桥接块（in v_textureCoordinates + 变量声明 +
  //    reconstruct 函数）。非贪婪 [\s\S]*? 匹配 vUv...vCloudsIrradiance 最短块（grep 验证锚点唯一）。
  //    替换后桥接块位于 clouds.frag 原 in 块位置——所有使用 vUv/vCameraPosition/vGroundIrradiance
  //    的函数（getRayDistanceToScene L812 / getCloudsSunSkyIrradiance L438 / main L823）均在之后。
  src = src.replace(
    /in vec2 vUv;\n[\s\S]*?in CloudsIrradiance vCloudsIrradiance;\n/,
    BRIDGE_VARYINGS_GLSL
  )

  // 3) 重命名 main → cloudsMainBody（clouds.frag L823 唯一处 void main()）
  src = src.replace(/\bvoid\s+main\s*\(\s*\)\s*\{/, 'void cloudsMainBody() {')

  // 4) shadowBuffer: sampler2DArray → sampler3D。Cesium createUniform 不认 sampler2DArray
  //    （type 36289，createUniform.js:31-35 仅 SAMPLER_2D/3D/CUBE/UNSIGNED_INT_SAMPLER_2D）→
  //    shader bind 炸 "Unrecognized uniform type: 36289"。M2 dummy 全 0（Texture3D），
  //    texture(sampler3D, vec3) 与 sampler2DArray 调用兼容（vec3）；
  //    M3 真实 BSM 时决定 sampler3D 模拟 cascade 离散化 或 augment createUniform 支持 2D_ARRAY。
  src = src.replace(
    /uniform sampler2DArray shadowBuffer;/,
    'uniform sampler3D shadowBuffer;'
  )

  return src
}

/**
 * 组装 Cesium 运行时 clouds 主 march fragment shader（three clouds.frag → Cesium 桥接）。
 *
 * 结构（拼接顺序关键）：
 *   1. defines（Bruneton LUT 尺寸 + M2 编译分支 + 桥接开关）
 *   2. BRIDGE_DEFINES_GLSL（viewMatrix/cameraNear/cameraFar → czm_* #define 重定向）
 *   3. clouds.frag 文本（surgery 后：3 uniform 剥离 + 7 in 块 IN-PLACE 替换为桥接块 +
 *      main 改名 cloudsMainBody）——桥接块在 clouds.frag 原 in 块位置（L87），所有使用
 *      vUv/vCameraPosition/vGroundIrradiance 的函数均在之后（GLSL 声明先于使用）
 *   4. WRAPPER_MAIN_GLSL（新 main：重建 varying → 调用 cloudsMainBody）
 *
 * 不写 #version / precision 兜底——clouds.frag 原文 L1-3 已含 precision；#version 由 Cesium
 * ShaderProgram 注入。czm_* automatic uniform 由 ShaderProgram._automaticUniforms 注入。
 */
export function buildCloudsMainFragmentShader(
  options: CloudsMainOptions = {}
): string {
  const o: ResolvedCloudsMainOptions = { ...DEFAULTS, ...options }

  const defines = buildM2Defines(o).join('\n')
  const surg = surgeryCloudsFrag(glslIndex.cloudsFrag)

  const merged = [defines, BRIDGE_DEFINES_GLSL, surg, WRAPPER_MAIN_GLSL].join(
    '\n\n'
  )

  // resolveCloudsIncludes：Three <chunk> 兼容桩 + 跨包 core/* + atmosphere/bruneton/* + clouds 本地
  // + unrollLoops。桥接 #define / 全局变量声明 / wrapper main 不含 #include，原样穿透。
  let resolved = resolveCloudsIncludes(merged)

  // densityProfile struct uniform → const 注入（同 ATMOSPHERE 理由：Cesium uniformMap 不支持
  // struct 注入；CloudDensityProfile 是 flat struct 4×vec4，构造简单）。声明在 parameters.glsl
  // （经 #include "parameters" 展开进入 resolved），此处后处理替换。
  // 值 = CloudLayers.DEFAULT packDensityProfiles 结果（每层 CloudLayer 默认 densityProfile
  // (expTerm=0, exponent=0, linearTerm=0.75, constantTerm=0.25) → 四层 pack 后 vec4 标量）。
  // M2 固定 CloudLayers.DEFAULT；M6 qualityPresets 可在此参数化或改 uniform struct（若 Cesium 验证支持）。
  resolved = resolved.replace(
    /uniform CloudDensityProfile densityProfile;\n/,
    `const CloudDensityProfile densityProfile = CloudDensityProfile(\n` +
      `  vec4(0.0), vec4(0.0), vec4(0.75), vec4(0.25));\n`
  )

  return resolved
}

/**
 * glslang 校验入口：补 #version 300 es + precision + czm_* 桩 + 运行时 shader。
 *
 * 校验桩（CZM_STUBS_GLSL）：czm_viewerPositionWC / czm_view / czm_inverseView /
 * czm_inverseProjection / czm_currentFrustum / czm_windowToEyeCoordinates 函数。
 * clouds.frag 自声明的 business uniforms（sampler2D/3D/2DArray、ATMOSPHERE、sun/scatter 参数）
 * 经 #include 链全部自洽，glslang 只编译不链接，无需绑定。
 */
export function buildStandaloneCloudsShaderForValidation(
  options: CloudsMainOptions = {}
): string {
  const runtime = buildCloudsMainFragmentShader(options)
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp sampler3D;',
    'precision highp sampler2DArray;',
    CZM_STUBS_GLSL,
    runtime
  ].join('\n')
}
