import { describe, it, expect } from 'vitest'
import { checkCompat } from './compat'

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
    expect(checkCompat({ ...base, webgl2: false }, ['1.143.0']).ok).toBe(false)
    expect(checkCompat({ ...base, fragmentDepth: false }, ['1.143.0']).ok).toBe(false)
  })

  it('非 SCENE3D 时 error', () => {
    expect(checkCompat({ ...base, mode: 2 }, ['1.143.0']).ok).toBe(false)
  })

  it('缺 depthTexture 或缺 globe 时 error', () => {
    const noDepth = checkCompat({ ...base, depthTexture: false }, ['1.143.0'])
    expect(noDepth.ok).toBe(false)
    expect(noDepth.errors.join()).toMatch(/depthTexture/)

    const noGlobe = checkCompat({ ...base, hasGlobe: false }, ['1.143.0'])
    expect(noGlobe.ok).toBe(false)
    expect(noGlobe.errors.join()).toMatch(/globe/i)
  })

  it('错误与非 3D 消息含当前版本与已验证版本表', () => {
    const r = checkCompat(
      { ...base, version: '1.150.0', hasTexture3D: false, mode: 2 },
      ['1.143.0', '1.144.0']
    )
    expect(r.errors).toHaveLength(2)
    for (const msg of r.errors) {
      expect(msg).toContain('1.150.0')
      expect(msg).toContain('1.143.0, 1.144.0')
    }
    expect(r.errors.join()).toMatch(/3D/)
  })

  it('全部满足时 ok 且 warnings/errors 均为空（缺省已验证表含 1.143.0）', () => {
    expect(checkCompat(base)).toEqual({ ok: true, warnings: [], errors: [] })
  })
})
