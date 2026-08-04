// Task 8 测试：occlusion.frag（sun 投影 w=0 + ray-ellipsoid + 36 点 depth 覆盖率，spec §5.5）。
// 关键纪律（spec §5.5）：
//   - sunEC = czm_view * vec4(u_sunDirectionWC, 0.0)（w=0 无穷远方向，修 cesium-clouds-atmosphere 1e6 视差）；
//     sunClip = czm_projection * vec4(sunEC.xyz, 1.0)（w=1 点投影）。
//   - ray-ellipsoid（WGS84 椭球，M9 非球）：相机在椭球外，tHit>0 = 太阳在地球背面 → visibility=0。
//   - 36 点 depth 覆盖率（I5：16 点 6.25% 步进台阶，提 36 点 ~2.7%）：sun 屏幕位置周围 sunAngularRadius
//     投影圆内 6×6 网格采 czm_readDepth，sceneDepth < 1.0 - DEPTH_EPSILON(1e-6) = 被挡。
//   - visibility = 1 - coverage，写 out_FragColor.r；colorTexture/depthTexture 白名单（Cesium 内建）。
import { describe, expect, it } from 'vitest'
import {
  buildOcclusionFragmentShader,
  buildStandaloneShaderForValidation,
  OCCLUSION_UNIFORM_NAMES
} from './occlusion.frag'

describe('buildOcclusionFragmentShader', () => {
  it('含 czm_readDepth + depthTexture 36 点采样', () => {
    const s = buildOcclusionFragmentShader()
    expect(s).toContain('czm_readDepth')
    expect(s).toContain('depthTexture')
    // 36 点循环或 const array（至少其一存在）
    const loopMatch = s.match(/for\s*\(\s*int\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*36/g)
    expect(loopMatch || s.match(/SAMPLE_GRID_36|\[36\]/)).toBeTruthy()
  })

  it('含 1e-6（DEPTH_EPSILON 值，log 域 epsilon，spec §5.5/I10）', () => {
    const s = buildOcclusionFragmentShader()
    expect(s).toContain('1e-6')
  })

  it('含 sun 投影 w=0（czm_view * vec4(u_sunDirectionWC, 0.0)）+ w=1 点投影', () => {
    const s = buildOcclusionFragmentShader()
    expect(s).toContain('czm_view')
    expect(s).toContain('czm_projection')
    expect(s).toContain('vec4(u_sunDirectionWC, 0.0)')
  })

  it('含 ray-ellipsoid GLSL（从 T7 纯函数移植）', () => {
    const s = buildOcclusionFragmentShader()
    expect(s).toContain('rayEllipsoid')
  })

  it('声明 depthTexture + sun uniforms（vec3 椭球，非 mat3 笔误）', () => {
    const s = buildOcclusionFragmentShader()
    expect(s).toContain('uniform sampler2D depthTexture')
    expect(s).toContain('uniform vec3 u_sunDirectionWC')
    expect(s).toContain('uniform vec3 u_ellipsoidRadiiSquared')
  })

  it('visibility 写 out_FragColor.r（0=全挡，1=全可见）', () => {
    const s = buildOcclusionFragmentShader()
    expect(s).toContain('out_FragColor')
    // 1.0 - coverage 形态（被挡比例 → 可见度）
    expect(s).toMatch(/1\.0\s*-\s*coverage|visibility/)
  })
})

describe('OCCLUSION_UNIFORM_NAMES', () => {
  it('与 shader 声明一致（colorTexture/depthTexture 白名单 + czm_* 内建白名单）', () => {
    const s = buildOcclusionFragmentShader()
    const declared = [...s.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1])
    // colorTexture/depthTexture 是 Cesium 内建纹理（PostProcessStage 自动提供值），不列入
    const whitelist = new Set(['colorTexture', 'depthTexture'])
    expect(OCCLUSION_UNIFORM_NAMES).toEqual(declared.filter((n) => !whitelist.has(n)))
  })
})

describe('buildStandaloneShaderForValidation', () => {
  it('#version 300 es + czm_* + czm_readDepth 函数桩', () => {
    const s = buildStandaloneShaderForValidation()
    expect(s.startsWith('#version 300 es')).toBe(true)
    expect(s).toContain('out vec4 out_FragColor;')
    // czm_* 桩：mat4 czm_view/czm_projection；float czm_readDepth 函数
    expect(s).toContain('czm_view')
    expect(s).toContain('czm_projection')
    expect(s).toContain('czm_readDepth')
  })
})
