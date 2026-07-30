import { describe, expect, it } from 'vitest'
import {
  AERIAL_PERSPECTIVE_UNIFORM_NAMES,
  buildAerialPerspectiveFragmentShader,
  buildStandaloneShaderForValidation,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'

// spec §4.2 合法宏组合枚举：A 路径 / B 路径 / 调试：仅透射 / 调试：仅内散射
const COMBOS: Array<[string, AerialPerspectiveFragOptions]> = [
  ['A 路径（默认全量）', {}],
  ['B 路径（无 SUN_LIGHT/SKY_LIGHT）', { sunLight: false, skyLight: false }],
  [
    '调试：仅透射',
    {
      sunLight: false,
      skyLight: false,
      inscatter: false,
      sun: false,
      ground: false,
      correctGeometricError: false,
      sky: false
    }
  ],
  [
    '调试：仅内散射',
    {
      sunLight: false,
      skyLight: false,
      transmittance: false,
      sun: false,
      ground: false,
      correctGeometricError: false,
      sky: false
    }
  ]
]

// 断言调用点（评审 critical），不断言 bruneton 固有签名（恒真、测的是错误的东西）
describe('buildAerialPerspectiveFragmentShader（brief Step 1）', () => {
  it('A 路径含 getSunSkyIrradiance 调用', () => {
    const s = buildAerialPerspectiveFragmentShader({
      sunLight: true,
      skyLight: true
    })
    expect(s).toContain('getSunSkyIrradiance(')
  })

  it('B 路径（无 SUN_LIGHT/SKY_LIGHT）不含 getSunSkyIrradiance 调用', () => {
    const s = buildAerialPerspectiveFragmentShader({
      sunLight: false,
      skyLight: false
    })
    expect(s).not.toContain('getSunSkyIrradiance(')
    expect(s).not.toMatch(/^#define SUN_LIGHT$/m)
    expect(s).not.toMatch(/^#define SKY_LIGHT$/m)
  })

  it('含 RECIPROCAL_PI 定义与反伽马输入（调用点级）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('#define RECIPROCAL_PI 0.3183098861837907')
    // diffuse = albedo * albedoScale * RECIPROCAL_PI（移植规则 4）
    expect(s).toContain('albedoScale * RECIPROCAL_PI')
    // A 路径 albedo = sRGBToLinear(inputColor.rgb)（移植规则 3）
    expect(s).toContain('sRGBToLinear(inputColor.rgb)')
  })

  it('含 GROUND 与 SUN 日盘（默认开）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('#define GROUND')
    expect(s).toMatch(/^#define SUN$/m)
    expect(s).toContain('cosSunAngularRadius')
  })
})

describe('宏组合生成（尽量不含未声明标识符/残留调用点）', () => {
  it('天空判定用原始深度，先于任何深度反演（§5.1）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    const skyCheck = s.indexOf('rawDepth >= 1.0 - 1e-8')
    const reverse = s.indexOf('czm_reverseLogDepthWindow(rawDepth')
    expect(skyCheck).toBeGreaterThan(-1)
    expect(reverse).toBeGreaterThan(-1)
    expect(skyCheck).toBeLessThan(reverse)
  })

  it('sky:false → 远平面直通 inputColor，无天空包装与日盘', () => {
    const s = buildAerialPerspectiveFragmentShader({ sky: false })
    expect(s).not.toMatch(/^#define SKY$/m)
    expect(s).not.toContain('getSkyRadiance(')
    expect(s).not.toContain('cosSunAngularRadius')
    expect(s).toContain('out_FragColor = inputColor;')
  })

  it('sun:false → 无 SUN 宏与 cosSunAngularRadius', () => {
    const s = buildAerialPerspectiveFragmentShader({ sun: false })
    expect(s).not.toMatch(/^#define SUN$/m)
    expect(s).not.toContain('cosSunAngularRadius')
  })

  it('transmittance/inscatter 全关 → 无 applyTransmittanceInscatter 调用点', () => {
    const s = buildAerialPerspectiveFragmentShader({
      transmittance: false,
      inscatter: false
    })
    expect(s).not.toContain('applyTransmittanceInscatter(')
  })

  it('correctGeometricError:false → 无 correctGeometricError( 与 ellipsoidRadii', () => {
    const s = buildAerialPerspectiveFragmentShader({
      correctGeometricError: false
    })
    expect(s).not.toContain('correctGeometricError(')
    expect(s).not.toContain('ellipsoidRadii')
  })

  it('仅透射/仅内散射：无光照/法线/日盘/天空标识符残留', () => {
    for (const [name, opts] of COMBOS.slice(2)) {
      const s = buildAerialPerspectiveFragmentShader(opts)
      expect(s, name).toContain('applyTransmittanceInscatter(')
      expect(s, name).not.toContain('getSunSkyIrradiance(')
      expect(s, name).not.toContain('reconstructNormalECEF(')
      expect(s, name).not.toContain('correctGeometricError(')
      expect(s, name).not.toContain('ellipsoidRadii')
      expect(s, name).not.toContain('albedoScale')
      expect(s, name).not.toContain('cosSunAngularRadius')
      expect(s, name).not.toContain('getSkyRadiance(')
      expect(s, name).not.toMatch(/^#define RECONSTRUCT_NORMAL$/m)
    }
  })

  it('色彩闭环：输出端 Reinhard 内联 + linearToSRGB（§3.2/§3.5）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain('radiance / (vec3(1.0) + radiance)')
    expect(s).toContain('linearToSRGB(radiance)')
  })

  it('几何侧再中心化：altitudeCorrection 预乘 (1 - amount)（§5.3）', () => {
    const s = buildAerialPerspectiveFragmentShader({})
    expect(s).toContain(
      'altitudeCorrection * METER_TO_LENGTH_UNIT * (1.0 - geometricErrorCorrectionAmount)'
    )
  })
})

describe('uniform 声明与 AERIAL_PERSPECTIVE_UNIFORM_NAMES 一致性（供 T6 接线）', () => {
  for (const [name, opts] of COMBOS) {
    it(`${name}：声明的 uniform 均被 NAMES 覆盖（czm_*/colorTexture/depthTexture 白名单）`, () => {
      const s = buildAerialPerspectiveFragmentShader(opts)
      const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(
        m => m[1]
      )
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
    expect(
      buildStandaloneShaderForValidation({}).startsWith('#version 300 es')
    ).toBe(true)
  })

  it('补 czm_* 桩 + colorTexture/depthTexture + out_FragColor 声明', () => {
    const s = buildStandaloneShaderForValidation({})
    expect(s).toContain('uniform mat4 czm_inverseProjection;')
    expect(s).toContain('uniform mat4 czm_inverseView;')
    expect(s).toContain('uniform vec3 czm_viewerPositionWC;')
    expect(s).toContain('uniform sampler2D colorTexture;')
    expect(s).toContain('uniform sampler2D depthTexture;')
    expect(s).toContain('out vec4 out_FragColor;')
  })

  for (const [name, opts] of COMBOS) {
    it(`${name}：引用的 czm_ automatic uniform 都有桩声明`, () => {
      // 先剥离注释（LOG_DEPTH_GLSL 注释提及 czm_writeLogDepth 等非引用标识符）
      const code = buildStandaloneShaderForValidation(opts)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      const used = new Set(
        [...code.matchAll(/\bczm_\w+/g)]
          .map(m => m[0])
          // 排除本 shader 自定义函数（czm_reverseLogDepth*，T1 命名沿用 czm_ 前缀）
          .filter(n => !new RegExp(`\\b${n}\\s*\\(`).test(code))
      )
      expect(used.size).toBeGreaterThan(0)
      for (const n of used) {
        expect(code, n).toMatch(new RegExp(`uniform\\s+\\w+\\s+${n}\\s*;`))
      }
    })
  }
})
