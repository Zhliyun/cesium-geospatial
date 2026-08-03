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
  it('B 路径合成：originalColor·transmittance + inscatter', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('originalColor.rgb * transmittance + inscatter')
  })

  it('ACES tonemap（替换 Reinhard）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('ACESFilmic(')
    expect(s).toContain('pow(c, vec3(1.0 / 2.2))')
    // 旧 Reinhard 已弃
    expect(s).not.toContain('radiance / (vec3(1.0) + radiance)')
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

  it('天空判定：depth<1 走 B 路径；depth=1 用视线方向（lookingAtGround）区分未渲染地面/天空', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('czm_readDepth(')
    expect(s).toContain('brunetonIntersectsGround')
    expect(s).toContain('RayIntersectsGround(')
    expect(s).toContain('lookingAtGround')
    expect(s).toContain('muLook')
    // 亮度判定已弃（暗山体/森林/低 LOD 误判天空曾导致截断）：sceneLum 不再参与天空/地面判定
    expect(s).not.toContain('sceneLum')
  })

  it('视线重建：czm_windowToEyeCoordinates 近远差分', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('czm_windowToEyeCoordinates')
    expect(s).toContain('reconstructRay(')
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
    expect(s).toContain('altitudeCorrection * METER_TO_LENGTH_UNIT')
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
