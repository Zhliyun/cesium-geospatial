// 公共 API 面（spec §8）回归测试。
//
// 只断言入口导出的形状与「消费者能命名嵌套选项类型」；install 行为由 install.test.ts 覆盖。
// 内部编排接口（installWithDeps / disposeAllForHmr）不得出现在入口（spec §8 未列）。
import { describe, expect, it } from 'vitest'
import * as api from './index'
import type {
  InstallOptions,
  AtmosphereCloudsHandle,
  AtmosphereCloudsTarget,
  AtmosphereStageOptions,
  CloudsStageOptions,
  CloudsQualityPreset
} from './index'

describe('公共 API 面（spec §8）', () => {
  it('导出主入口函数、错误类型与版本号', () => {
    expect(typeof api.installAtmosphereClouds).toBe('function')
    expect(typeof api.isInstalled).toBe('function')
    expect(typeof api.InstallCancelledError).toBe('function')
    expect(typeof api.VERSION).toBe('string')
    expect(api.VERSION.length).toBeGreaterThan(0)
  })

  it('InstallCancelledError 可按类型判别', () => {
    const error = new api.InstallCancelledError()
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(api.InstallCancelledError)
    expect(error.name).toBe('InstallCancelledError')
  })

  it('不对外导出内部编排接口', () => {
    expect('disposeAllForHmr' in api).toBe(false)
    expect('installWithDeps' in api).toBe(false)
  })

  it('类型可被命名（编译期）', () => {
    const o: InstallOptions = {
      quality: 'high' as CloudsQualityPreset,
      atmosphere: {} as AtmosphereStageOptions,
      clouds: {} as CloudsStageOptions
    }
    // 让「类型可命名」同时带上运行时断言，避免用例体被优化掉
    expect(o.quality).toBe('high')
    expect(o.clouds).toEqual({})
  })

  it('句柄/目标类型可作为命名类型使用（编译期）', () => {
    const handle = {} as AtmosphereCloudsHandle
    const target = {} as AtmosphereCloudsTarget
    expect(handle).toBeDefined()
    expect(target).toBeDefined()
  })
})
