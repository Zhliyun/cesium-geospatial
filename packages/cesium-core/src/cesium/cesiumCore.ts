import { ATMOSPHERE_DEFAULT_GLSL } from '../math/atmosphereParameters'

// 所有大气 shader 的公共前缀：纹理尺寸 #define + METER_TO_LENGTH_UNIT +
// COMBINED_SCATTERING_TEXTURES（默认合并编码）+ const ATMOSPHERE。
// 这些值逐字取自 three-geospatial atmosphere/constants.ts 与
// AtmosphereMaterialBase.defines。
export function buildAtmospherePrefix(): string {
  return [
    '#define PI 3.14159265358979323846',
    '#define TRANSMITTANCE_TEXTURE_WIDTH 256',
    '#define TRANSMITTANCE_TEXTURE_HEIGHT 64',
    '#define SCATTERING_TEXTURE_R_SIZE 32',
    '#define SCATTERING_TEXTURE_MU_SIZE 128',
    '#define SCATTERING_TEXTURE_MU_S_SIZE 32',
    '#define SCATTERING_TEXTURE_NU_SIZE 8',
    '#define IRRADIANCE_TEXTURE_WIDTH 64',
    '#define IRRADIANCE_TEXTURE_HEIGHT 16',
    '#define METER_TO_LENGTH_UNIT 0.0010000',
    '#define COMBINED_SCATTERING_TEXTURES',
    ATMOSPHERE_DEFAULT_GLSL
  ].join('\n')
}
