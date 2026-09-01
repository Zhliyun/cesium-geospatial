import { describe, expect, it } from 'vitest'
import {
  AERIAL_PERSPECTIVE_UNIFORM_NAMES,
  buildAerialPerspectiveFragmentShader,
  buildStandaloneShaderForValidation,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'

// B 路径宏组合（sun/sky 开关）
const COMBOS: Array<[string, AerialPerspectiveFragOptions]> = [
  ['默认（SKY+SUN）', {}],
  ['无日盘（SUN 关）', { sun: false }],
  ['无天空分支（SKY 关，远平面直通）', { sky: false }],
  ['全关（无 SKY/SUN）', { sun: false, sky: false }]
]

describe('buildAerialPerspectiveFragmentShader（B 路径，对齐 cesium-clouds-atmosphere）', () => {
  it('B 路径合成：originalColor·transmittance + inscatter·u_inscatterScale（方案 B 远处白雾浓）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // 2026-09-01 地面光色乘子：originalColor 与 transmittance 之间插入 groundLightColor
    expect(s).toContain(
      'originalColor.rgb * groundLightColor * transmittance * u_groundDim + inscatter * u_inscatterScale'
    )
  })

  it('u_inscatterScale uniform 声明 + 默认合成（方案 B，默认 1.0=phase1 物理，>1 远处白雾浓）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // uniform 声明（FRAME_UNIFORMS_GLSL）
    expect(s).toContain('uniform float u_inscatterScale')
    // finalColor 合成 inscatter × u_inscatterScale（DUAL 合成后总 inscatter，ground+sky 分支都 scale）
    expect(s).toContain('inscatter * u_inscatterScale')
  })

  it('末端输出线性 finalColor·exposure（不再内联 ACES，由链尾 tonemap stage 收尾）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('out_FragColor = vec4(finalColor * exposure, originalColor.a)')
    expect(s).not.toContain('tonemapDisplay(')
    expect(s).not.toContain('ACESFilmic(')
  })

  it('sky=false 分支也线性输出（否则 tonemapDisplay 移除后编译失败）', () => {
    const s = buildAerialPerspectiveFragmentShader({ sky: false })
    expect(s).toContain('finalColor = originalColor.rgb')
    expect(s).toContain('out_FragColor = vec4(finalColor * exposure, originalColor.a)')
    expect(s).not.toContain('tonemapDisplay(')
  })

  it('仍含 input dithering（打散 originalColor RGBA8 banding，留在 atmosphere）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('inDither')
    expect(s).toContain('interleavedGradientNoise')
  })

  it('debug 级联被 < 6.5 整体包裹：debug=7（>6.5）跳过所有可视化分支，走末端线性输出供 tonemap 归一化验证 HDR', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // 方案 B：整个级联被 if (u_debugMode < 6.5) 包裹，debug=7 直接落到末端线性输出
    expect(s).toContain('if (u_debugMode < 6.5)')
    // debug=6 分支不再单独带 < 6.5 上限（已被外层包裹，单分支上限是旧方案 A 残留）
    expect(s).not.toContain('u_debugMode > 5.5 && u_debugMode < 6.5')
    // 末端线性输出存在（debug=7 落点：finalColor*exposure，>1 原样写 HalfFloat）
    expect(s).toContain('out_FragColor = vec4(finalColor * exposure, originalColor.a)')
  })

  it('不含 A 路径残留（法线/lighting/几何误差校正/反伽马）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).not.toContain('getSunSkyIrradiance(')
    expect(s).not.toContain('albedoScale')
    expect(s).not.toContain('RECIPROCAL_PI')
    expect(s).not.toContain('sRGBToLinear(')
    expect(s).not.toContain('reconstructNormalECEF(')
    expect(s).not.toContain('correctGeometricError(')
    expect(s).not.toContain('ellipsoidRadii')
    expect(s).not.toContain('applyTransmittanceInscatter(')
    expect(s).not.toContain('geometricErrorCorrectionAmount')
    expect(s).not.toMatch(/^#define SUN_LIGHT$/m)
    expect(s).not.toMatch(/^#define SKY_LIGHT$/m)
    expect(s).not.toMatch(/^#define CORRECT_GEOMETRIC_ERROR$/m)
    expect(s).not.toMatch(/^#define RECONSTRUCT_NORMAL$/m)
  })

  it('GROUND define（runtime RayIntersectsGround 用）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toMatch(/^#define GROUND$/m)
  })

  it('sky/ground 主分类用视线方向 lookingAtGround（平滑，避免掠射硬翻转条纹）；depth 仅用于山峰 hasScene 保持山体不透明', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('brunetonIntersectsGround')
    expect(s).toContain('RayIntersectsGround(')
    expect(s).toContain('lookingAtGround')
    expect(s).toContain('muLook')
    // depth 反演出 hasScene/sceneDist，仅山峰分支（!lookingAtGround）消费；地平线分类不读 depth。
    // Bug1：用 czm_reverseLogDepthWindow 显式反演 log-depth（PostProcessStage 无 LOG_DEPTH define，
    // czm_readDepth 返回 raw logDepth 致 4-arg 反投影错）。
    expect(s).toContain('hasScene')
    expect(s).toContain('czm_reverseLogDepthWindow')
    // 亮度判定已弃（暗山体/森林/低 LOD 误判天空曾导致截断）：sceneLum 不再参与天空/地面判定
    expect(s).not.toContain('sceneLum')
  })

  it('视线重建：czm_windowToEyeCoordinates 近远差分', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('czm_windowToEyeCoordinates')
    expect(s).toContain('reconstructRay(')
  })

  it('u_distanceScale 散射距离缩放 wrapper（方案 A）：默认含 GetSkyRadianceToPointScaled + uniform 声明 + d 缩放', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // wrapper 函数已注入
    expect(s).toContain('GetSkyRadianceToPointScaled')
    // uniform 声明（FRAME_UNIFORMS_GLSL）
    expect(s).toContain('uniform float u_distanceScale')
    // wrapper 内 d = length(point - camera) * u_distanceScale（散射距离缩放，等效空气密度倍率）
    expect(s).toContain('length(point - camera) * u_distanceScale')
    // 地面基线 + foreInscatter 都走 wrapper（不再直调原 GetSkyRadianceToPoint）
    expect(s).toContain('GetSkyRadianceToPointScaled(')
    // 天空基线 getSkyRadiance 不缩放（距离到大气顶物理正确，不消费 distanceScale）
    expect(s).toContain('getSkyRadiance(')
    // 原始 GetSkyRadianceToPoint 直调在 main 内已替换为 wrapper（注释/定义除外：wrapper 定义是 Scaled 后缀）
    // main 内 main() 体不应再有未带 Scaled 的 GetSkyRadianceToPoint( 调用
    const mainBody = s.slice(s.indexOf('void main()'))
    expect(mainBody).not.toContain('= GetSkyRadianceToPoint(')
  })
})

describe('宏组合生成（B 路径 sun/sky）', () => {
  it('默认含 SUN 日盘 + cosSunAngularRadius + getSkyRadiance', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toMatch(/^#define SUN$/m)
    expect(s).toMatch(/^#define SKY$/m)
    expect(s).toContain('cosSunAngularRadius')
    expect(s).toContain('getSkyRadiance(')
  })

  it('sky:false → 远平面直通，无天空分支/日盘', () => {
    const s = buildAerialPerspectiveFragmentShader({ sky: false })
    expect(s).not.toMatch(/^#define SKY$/m)
    expect(s).not.toContain('getSkyRadiance(')
    expect(s).not.toContain('cosSunAngularRadius')
    expect(s).toContain('finalColor = originalColor.rgb')
  })

  it('sun:false → 无 SUN 宏与 cosSunAngularRadius', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: false })
    expect(s).not.toMatch(/^#define SUN$/m)
    expect(s).not.toContain('cosSunAngularRadius')
  })

  it('altitudeCorrection 全量中心化（camera/scenePos 同系，对齐 cesium-clouds-atmosphere）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // cameraPosition 用全量 altitudeCorrection；scenePos 由 cameraPosition 派生（ray·tHitG），同系。
    expect(s).toContain('czm_viewerPositionWC + altitudeCorrection')
    // 旧的 (1-amount) 衰减已弃：曾使 camera（全量）与 point（衰减）坐标系错位 → 山体透出地平线
    expect(s).not.toContain('(1.0 - geometricErrorCorrectionAmount)')
  })
})

describe('uniform 声明与 AERIAL_PERSPECTIVE_UNIFORM_NAMES 一致性（供 T6 接线）', () => {
  for (const [name, opts] of COMBOS) {
    it(`${name}：声明的 uniform 均被 NAMES 覆盖（czm_*/colorTexture/depthTexture 白名单）`, () => {
      const s = buildAerialPerspectiveFragmentShader(opts)
      const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(m => m[1])
      const whitelist = new Set(['colorTexture', 'depthTexture'])
      const missing = declared.filter(
        n =>
          !n.startsWith('czm_') &&
          !whitelist.has(n) &&
          !AERIAL_PERSPECTIVE_UNIFORM_NAMES.includes(n)
      )
      expect(missing).toEqual([])
    })
  }

  it('NAMES 每个条目在默认（全量）组合里都被声明', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    for (const n of AERIAL_PERSPECTIVE_UNIFORM_NAMES) {
      expect(s, n).toContain(n)
    }
  })
})

describe('buildStandaloneShaderForValidation（T8 glslang 用）', () => {
  it('以 #version 300 es 开头', () => {
    expect(buildStandaloneShaderForValidation({}).startsWith('#version 300 es')).toBe(true)
  })

  it('补 czm_* 桩 + colorTexture/depthTexture + out_FragColor + czm_readDepth/czm_windowToEyeCoordinates 桩', () => {
    const s = buildStandaloneShaderForValidation({})
    expect(s).toContain('uniform mat4 czm_inverseView;')
    expect(s).toContain('uniform vec3 czm_viewerPositionWC;')
    expect(s).toContain('uniform sampler2D colorTexture;')
    expect(s).toContain('uniform sampler2D depthTexture;')
    expect(s).toContain('out vec4 out_FragColor;')
    expect(s).toContain('czm_readDepth')
    expect(s).toContain('czm_windowToEyeCoordinates')
  })
})

describe('Bug3：DEPTH_TEMPORAL_EMA 双变体（HDR 读 depthTemporal .a 消水波纹 / UNSIGNED_BYTE 读 raw depth）', () => {
  it('HDR 变体（hdrDepthTemporal=true）含 #define DEPTH_TEMPORAL_EMA', () => {
    const s = buildAerialPerspectiveFragmentShader({ hdrDepthTemporal: true })
    expect(s).toMatch(/^#define DEPTH_TEMPORAL_EMA$/m)
  })

  it('UNSIGNED_BYTE 变体（默认）无 #define DEPTH_TEMPORAL_EMA', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).not.toMatch(/^#define DEPTH_TEMPORAL_EMA$/m)
  })

  it('两变体都含 #ifdef DEPTH_TEMPORAL_EMA 双分支（depth 来源 originalColor.a / texture(depthTexture).r）+ 末端 .a 双分支', () => {
    for (const hdr of [true, false] as const) {
      const s = buildAerialPerspectiveFragmentShader({ hdrDepthTemporal: hdr })
      // depth 来源双分支
      expect(s).toContain('#ifdef DEPTH_TEMPORAL_EMA')
      expect(s).toContain('float logDepth = originalColor.a;') // HDR：depthTemporal EMA smoothLogDepth
      expect(s).toContain('float tapC = texture(depthTexture, v_textureCoordinates).r;') // UNSIGNED_BYTE：5-tap raw（Bug4）
      // 末端 .a 双分支（专家1 M1：HDR .a=1.0 不透传 smoothLogDepth）
      expect(s).toContain('vec4(finalColor * exposure, 1.0)')
      expect(s).toContain('vec4(finalColor * exposure, originalColor.a)')
      // 两变体都用 czm_reverseLogDepthWindow 反演（Bug1）
      expect(s).toContain('czm_reverseLogDepthWindow(logDepth, czm_currentFrustum.x, czm_currentFrustum.y)')
    }
  })
})

describe('tapC 早退（Phase 1.0，评审遗漏 1，零视觉风险）', () => {
  it('非 EMA 分支 tapC>=1.0 时跳过 4 邻域 depth fetch（天空区零开销）', () => {
    const s = buildAerialPerspectiveFragmentShader({ hdrDepthTemporal: false })
    // 4 邻域 tap 的「声明」（float tapX = texture）在 if (tapC < 1.0) 块内（早退）——天空/未渲染像素不 fetch
    expect(s).toMatch(
      /if \(tapC < 1\.0\) \{[\s\S]*?float tapR = texture[\s\S]*?float tapL = texture[\s\S]*?float tapU = texture[\s\S]*?float tapD = texture/
    )
    // tapC 提到 if 外（hasSceneDepth 用，Bug6 不变）；logDepth 默认 far-plane 1.0
    expect(s).toContain('float tapC = texture(depthTexture, v_textureCoordinates).r;')
    expect(s).toContain('float logDepth = 1.0;')
  })
})

describe('5-tap 视角自适应（Phase 1.2，评审 C1/M3）', () => {
  it('muLook 门控：垂直俯视保留 5-tap / 掠射降 tap 退中心 tap（smoothstep 连续过渡，非 mask/sceneDist——无循环依赖）', () => {
    const s = buildAerialPerspectiveFragmentShader({ hdrDepthTemporal: false })
    // muLook 门控（smoothstep 连续过渡，绝不用 mask/sceneDist——判定信号本身在抖会造边界条纹）
    expect(s).toMatch(/smoothstep\([^)]*abs\(muLook\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5 atmosphere 路径（CLOUDS_SHADOW_LENGTH）：天空 inscatter 云影调制
// ─────────────────────────────────────────────────────────────────────────────
describe('M5 atmosphere 路径（cloudsShadowLength 编译分支）', () => {
  it('开：#define + uniform 声明 + 天空分支采样（shadow_length 非 0 字面量）', () => {
    const src = buildAerialPerspectiveFragmentShader({ cloudsShadowLength: true })
    expect(src).toContain('#define CLOUDS_SHADOW_LENGTH')
    expect(src).toContain('uniform sampler2D u_cloudsShadowLength;')
    expect(src).toContain('texture(u_cloudsShadowLength, v_textureCoordinates).r')
    // 只钉前 6 参：月盘 MOON 段（spec r2 §5）默认给调用追加第 7 参 out moonDisc（golden 逐字符守门
    // 只保 moon=false；默认 moon=true 的调用文本变化属预期，由 compile test 的 MOON 段用例守门）
    expect(src).toContain(
      'getSkyRadiance(cameraPosition, rayDirection, cloudsShadowLength, sunDirection, fragmentAngle, transmittance'
    )
  })

  it('关（默认）：无 define，天空 shadow_length=0（零回归）', () => {
    const src = buildAerialPerspectiveFragmentShader({})
    expect(src).not.toContain('#define CLOUDS_SHADOW_LENGTH')
    // 只钉前 6 参（同上：默认 moon=true 时调用多第 7 参 out moonDisc；moon=false 零回归由 golden snapshot 守门）
    expect(src).toContain(
      'getSkyRadiance(cameraPosition, rayDirection, cloudsShadowLength, sunDirection, fragmentAngle, transmittance'
    )
    expect(src).toContain('const float cloudsShadowLength = 0.0;')
  })

  it('god rays 增益：CLOUDS_SHADOW_LENGTH 开时声明 u_cloudsGodRaysGain 且采样值相乘（默认 1 物理精确）', () => {
    const src = buildAerialPerspectiveFragmentShader({ cloudsShadowLength: true })
    expect(src).toContain('uniform float u_cloudsGodRaysGain;')
    expect(src).toContain('cloudsShadowLength *= u_cloudsGodRaysGain;')
  })

  it('god rays 增益：CLOUDS_SHADOW_LENGTH 关时不声明 u_cloudsGodRaysGain（分支外无残留）', () => {
    const src = buildAerialPerspectiveFragmentShader({})
    expect(src).not.toContain('uniform float u_cloudsGodRaysGain;')
  })
})
