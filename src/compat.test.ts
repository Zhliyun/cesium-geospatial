import { describe, it, expect } from 'vitest'
import { checkCompat, TESTED_CESIUM_VERSIONS } from './compat'

// 基线：全部能力齐备、命中已验证版本表。
const base = { version: '1.143.0', hasTexture3D: true, webgl2: true, fragmentDepth: true, depthTexture: true, hasGlobe: true, mode: 3, scene3dMode: 3 }

describe('checkCompat', () => {
  it('未验证版本只 warn', () => {
    const r = checkCompat({ ...base, version: '1.144.2' }, ['1.143.0'])
    expect(r.ok).toBe(true)
    expect(r.warnings.join()).toMatch(/1\.144\.2/)
  })

  it('缺 Texture3D 时 error', () => {
    const r = checkCompat({ ...base, hasTexture3D: false }, ['1.143.0'])
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/Texture3D/)
  })

  it('非 WebGL2 或缺 fragmentDepth 时 error', () => {
    const noWebgl2 = checkCompat({ ...base, webgl2: false }, ['1.143.0'])
    expect(noWebgl2.ok).toBe(false)
    expect(noWebgl2.errors.join()).toMatch(/WebGL2/)

    const noFragDepth = checkCompat({ ...base, fragmentDepth: false }, ['1.143.0'])
    expect(noFragDepth.ok).toBe(false)
    expect(noFragDepth.errors.join()).toMatch(/fragmentDepth/)
  })

  it('缺 depthTexture 或缺 globe 时 error', () => {
    const noDepth = checkCompat({ ...base, depthTexture: false }, ['1.143.0'])
    expect(noDepth.ok).toBe(false)
    expect(noDepth.errors.join()).toMatch(/depthTexture/)

    const noGlobe = checkCompat({ ...base, hasGlobe: false }, ['1.143.0'])
    expect(noGlobe.ok).toBe(false)
    expect(noGlobe.errors.join()).toMatch(/globe/i)
  })

  it('非 SCENE3D 时 error，消息明确 mode / SCENE3D / 仅支持 3D', () => {
    const r = checkCompat({ ...base, mode: 2 }, ['1.143.0'])
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('mode=2')
    expect(r.errors[0]).toContain('SCENE3D=3')
    expect(r.errors[0]).toContain('仅支持 3D')
  })

  it('六种能力缺失的 error 消息都含当前版本与已验证版本表', () => {
    const patches = [
      { hasTexture3D: false },
      { webgl2: false },
      { fragmentDepth: false },
      { depthTexture: false },
      { hasGlobe: false },
      { mode: 2 }
    ]
    for (const patch of patches) {
      const r = checkCompat({ ...base, ...patch }, ['1.143.0'])
      expect(r.ok).toBe(false)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toContain('1.143.0')
      expect(r.errors[0]).toContain('已验证版本')
    }
  })

  it('多条 error 时每条都带当前版本与完整已验证版本表', () => {
    const r = checkCompat(
      { ...base, version: '1.150.0', hasTexture3D: false, mode: 2 },
      ['1.143.0', '1.144.0']
    )
    expect(r.errors).toHaveLength(2)
    for (const msg of r.errors) {
      expect(msg).toContain('1.150.0')
      expect(msg).toContain('1.143.0, 1.144.0')
    }
  })

  it('低于 peer 下界（1.100.0）或 major 达上界（2.0.0）时 error，消息带范围', () => {
    for (const version of ['1.100.0', '2.0.0']) {
      const r = checkCompat({ ...base, version }, ['1.143.0'])
      expect(r.ok).toBe(false)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toContain(version)
      expect(r.errors[0]).toContain('>=1.143.0 <2.0.0')
      expect(r.errors[0]).toContain('已验证版本')
    }
  })

  it('范围内未验证版本（1.144.0）ok + warn；已验证版本（1.143.0）ok 无 warn', () => {
    const untested = checkCompat({ ...base, version: '1.144.0' }, ['1.143.0'])
    expect(untested.ok).toBe(true)
    expect(untested.errors).toEqual([])
    expect(untested.warnings).toHaveLength(1)
    expect(untested.warnings[0]).toContain('1.144.0')

    expect(checkCompat(base)).toEqual({ ok: true, warnings: [], errors: [] })
    expect(TESTED_CESIUM_VERSIONS).toEqual(['1.143.0'])
  })

  it('自定义 peerRange 生效（抬高上界后 2.0.0 回到范围内，3.0.0 仍 error）', () => {
    const relaxed = { minMajor: 1, minMinor: 143, maxMajor: 3 }
    const inRange = checkCompat({ ...base, version: '2.0.0', peerRange: relaxed }, ['1.143.0'])
    expect(inRange.ok).toBe(true)
    expect(inRange.warnings[0]).toContain('2.0.0')

    const outOfRange = checkCompat({ ...base, version: '3.0.0', peerRange: relaxed }, ['1.143.0'])
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.errors[0]).toContain('>=1.143.0 <3.0.0')
  })
})
