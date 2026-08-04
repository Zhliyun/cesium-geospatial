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
  it('B 路径合成：finalColor = originalColor·trans·groundDim + inscatter（base/fore 量级一致 ×1；fogEnhance 末端衰减 + sky ×scale）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // finalColor 不再含全局 inscatter * u_inscatterScale（弧线波纹根因：全局放大含 fore depth 抖动）
    expect(s).toContain('originalColor.rgb * transmittance * u_groundDim + inscatter;')
    expect(s).not.toContain('inscatter * u_inscatterScale')
  })

  it('u_inscatterScale 末端 fogEnhance 衰减 + sky 放大；base/fore 量级一致 ×1（修弧线/圆形波纹）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // uniform 声明（FRAME_UNIFORMS_GLSL）
    expect(s).toContain('uniform float u_inscatterScale')
    // ground 基线 base ×1（赋值点不再 ×scale，量级与 fore 一致 → mix 过渡带无 25:1 跳变 → 无可见圆/弧）
    expect(s).not.toContain('transmittance\n    ) * u_inscatterScale')
    // sky 基线（赋值点）×scale（天空亮度维持，fogEnhance 只作用 ground 分支）
    expect(s).toContain('fragmentAngle, transmittance) * u_inscatterScale')
    // DUAL mix 保留：base（×1）↔ fore（×1）。量级一致，过渡带无圆/弧
    expect(s).toContain('inscatter = mix(inscatter, foreInscatter, mask)')
    // fore 赋值不放大（×1）：foreInscatter = GetSkyRadianceToPointScaled(...) 直接收尾，无 ×scale
    expect(s).toContain('foreTrans\n      );')
    // 末端 fogEnhance：远处雾浓由基于距离的 fog 衰减补回（近 ×1 山体清晰，远 ×scale 雾浓）
    expect(s).toContain('inscatter *= fog')
    expect(s).toContain('mix(1.0, u_inscatterScale, smoothstep(CLOSE_KM, horizonKm, fogDist))')
    // 全局 scale 模式彻底移除（旧 finalColor 的 inscatter * u_inscatterScale）
    expect(s).not.toContain('inscatter * u_inscatterScale')
  })

  it('sceneDist 5-tap 邻域平均抗 depthTexture 高频抖动（消弧线/圆形波纹逐像素抖）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // textureSize 求 texel 尺寸（GLSL ES 3.00 内建，不需桩）
    expect(s).toContain('textureSize(depthTexture, 0)')
    // 中心 + 4 邻域 depth 平均
    expect(s).toContain('float dC = depth;')
    expect(s).toContain('czm_readDepth(depthTexture, v_textureCoordinates + vec2(texel.x, 0.0))')
    expect(s).toContain('czm_readDepth(depthTexture, v_textureCoordinates - vec2(texel.x, 0.0))')
    expect(s).toContain('czm_readDepth(depthTexture, v_textureCoordinates + vec2(0.0, texel.y))')
    expect(s).toContain('czm_readDepth(depthTexture, v_textureCoordinates - vec2(0.0, texel.y))')
    expect(s).toContain('float depthAvg = (dC + dR + dL + dU + dD) * 0.2;')
    // 用 depthAvg 反演（不再用单点 depth）
    expect(s).toContain('czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, depthAvg, 1.0))')
  })

  it('smoothstep UB 修正：1.0 - smoothstep(CLOSE_KM, horizonKm)（edge0<edge1，无 UB）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    // 旧写法 smoothstep(horizonKm, CLOSE_KM) 中 edge0(horizonKm≈138) > edge1(CLOSE_KM=20) → GLSL UB，已移除
    //（断言带 float mask 前缀只匹配代码语句，注释里说明性提及不算）
    expect(s).not.toContain('float mask = smoothstep(horizonKm, CLOSE_KM')
    // 新写法 edge0<edge1，近处 mask=1 走 fore 山体，远处 mask=0 走 base 平滑
    expect(s).toContain('1.0 - smoothstep(CLOSE_KM, horizonKm, sceneDist)')
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

  it('仍含 input dithering（打散 originalColor RGBA8 banding，留在 atmosphere）+ u_ditherScale 强度倍率', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('inDither')
    expect(s).toContain('interleavedGradientNoise')
    // input dithering 系数 × u_ditherScale（1.0=phase1 默认 ±1.5/255；URL ?ditherScale= 放大打散 banding）
    expect(s).toContain('uniform float u_ditherScale')
    expect(s).toContain('inDither * 1.5 / 255.0 * u_ditherScale')
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
    expect(s).not.toContain('czm_reverseLogDepthWindow')
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
    // depth 反演出 hasScene/sceneDist，仅山峰分支（!lookingAtGround）消费；地平线分类不读 depth
    expect(s).toContain('hasScene')
    expect(s).toContain('czm_readDepth(')
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
