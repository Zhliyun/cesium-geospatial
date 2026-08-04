// depthTemporal fragment shader 组装器 + glslang 编译校验（Task 2，方案 A 单 stage 打包透传）。
// 断言对齐 spec v2 critical：
// - EMA raw log-depth 域（禁 czm_readDepth = window-depth）
// - reproject 纯 ECEF 米（禁 altitudeCorrection / METER_TO_LENGTH_UNIT）
// - 2-arg czm_windowToEyeCoordinates（LOG_DEPTH 分支，禁 /=w）
// - 打包输出 vec4(sceneColor, smoothDepth)
import { describe, it, expect } from 'vitest'
import {
  buildDepthTemporalFragmentShader,
  buildDepthTemporalStandaloneShaderForValidation
} from './depthTemporal.frag'
import { compileFragment } from '../glslangUtil'

describe('buildDepthTemporalFragmentShader', () => {
  const s = buildDepthTemporalFragmentShader()

  it('打包透传：读 colorTexture.rgb 透传 + depthTexture.r（log-depth，禁 czm_readDepth）', () => {
    expect(s).toContain('texture(colorTexture, v_textureCoordinates).rgb')
    expect(s).toContain('texture(depthTexture, v_textureCoordinates).r')
    expect(s).not.toContain('czm_readDepth') // 评审 critical #2：禁 czm_readDepth（window-depth）
  })

  it('reproject 纯 ECEF 米（禁 altitudeCorrection / METER_TO_LENGTH_UNIT）', () => {
    expect(s).toContain('czm_inverseView *')
    expect(s).not.toContain('altitudeCorrection')
    expect(s).not.toContain('METER_TO_LENGTH_UNIT')
  })

  it('2-arg czm_windowToEyeCoordinates（LOG_DEPTH 分支，禁 /=w）', () => {
    expect(s).toContain('#define LOG_DEPTH')
    // 2-arg 形式（vec2 + float），非 4-arg vec4
    expect(s).toMatch(/czm_windowToEyeCoordinates\(vec2\(gl_FragCoord\.xy\),\s*curLogDepth\)/)
  })

  it('disocclusion：log-depth 相对阈值 + 远平面特殊 + prevUV 边界', () => {
    expect(s).toContain('relDiff')
    expect(s).toContain('u_depthThreshold')
    expect(s).toContain('farPlane')
    expect(s).toContain('prevClip.w > 0.0')
  })

  it('打包输出 vec4(sceneColor, smoothDepth)', () => {
    expect(s).toContain('out_FragColor = vec4(sceneColor, smoothDepth)')
  })

  it('glslang 编译通过（含 2-arg czm_windowToEyeCoordinates + czm_inverseView 桩 + LOG_DEPTH define）', () => {
    const standalone = buildDepthTemporalStandaloneShaderForValidation()
    const result = compileFragment(standalone) // 1-arg，返回 { ok, output }（见 glslangUtil.ts:88）
    // 第二参作失败消息：glslang 报错时直接看到错误位置，省 rerun
    expect(result.ok, `glslang 编译失败:\n${result.output}`).toBe(true)
  })
})

describe('debug=8 raw globe depth（Task 11，抖动源/EMA 对比诊断）', () => {
  it('enabled=true 始终 emit u_debugMode + debug=8 分支（runtime resolved.debugMode 控制，对齐 atmosphere pattern）', () => {
    const s = buildDepthTemporalFragmentShader({ enabled: true })
    // u_debugMode uniform 始常驻（无 compile-time debugMode option，与 atmosphere 一致）
    expect(s).toContain('uniform float u_debugMode')
    expect(s).toMatch(/debugMode.*8[\s\S]*out_FragColor\s*=\s*vec4\(.*texture\(depthTexture.*\)\.r/)
  })

  it('enabled=false 不 emit u_debugMode（透传兜底最小化）', () => {
    const s = buildDepthTemporalFragmentShader({ enabled: false })
    expect(s).not.toContain('u_debugMode')
  })

  it('debug=8 glslang 编译通过（u_debugMode 声明在 shader body 内，无需额外桩）', () => {
    const standalone = buildDepthTemporalStandaloneShaderForValidation({ enabled: true })
    const result = compileFragment(standalone)
    expect(result.ok, `glslang 编译失败:\n${result.output}`).toBe(true)
  })
})
