import { describe, it, expect } from 'vitest'
import { buildAtmospherePrefix } from './cesiumCore'

describe('buildAtmospherePrefix', () => {
  it('含 HAS_HIGHER_ORDER_SCATTERING_TEXTURE（C9：云 god rays 走物理正确分支防过暗黑）', () => {
    expect(buildAtmospherePrefix()).toContain(
      '#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE'
    )
  })

  it('含 COMBINED_SCATTERING_TEXTURES + 纹理尺寸 define + precision highp sampler3D', () => {
    const prefix = buildAtmospherePrefix()
    expect(prefix).toContain('#define COMBINED_SCATTERING_TEXTURES')
    expect(prefix).toContain('#define TRANSMITTANCE_TEXTURE_WIDTH 256')
    expect(prefix).toContain('#define SCATTERING_TEXTURE_R_SIZE 32')
    expect(prefix).toContain('precision highp sampler3D;')
  })
})
