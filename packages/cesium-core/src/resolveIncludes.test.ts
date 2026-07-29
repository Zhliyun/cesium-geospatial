import { describe, it, expect } from 'vitest'
import { resolveIncludes } from './resolveIncludes'

describe('resolveIncludes', () => {
  it('递归展开 #include 路径', () => {
    const includes = {
      core: { raySphereIntersection: 'float rsi() { return 0.0; }' }
    }
    const source = '#include "core/raySphereIntersection"\nvoid main(){}'
    expect(resolveIncludes(source, includes)).toBe(
      'float rsi() { return 0.0; }\nvoid main(){}'
    )
  })

  it('找不到 include 时抛错', () => {
    expect(() => resolveIncludes('#include "missing"', {})).toThrow(
      /Could not find include for missing/
    )
  })

  it('支持多级路径', () => {
    const includes = {
      bruneton: { common: '// common code', runtime: '// runtime code' }
    }
    const source = '#include "bruneton/common"\n#include "bruneton/runtime"'
    expect(resolveIncludes(source, includes)).toBe(
      '// common code\n// runtime code'
    )
  })
})
