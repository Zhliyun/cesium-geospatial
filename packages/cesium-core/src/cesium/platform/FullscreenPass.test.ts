// FullscreenPass.test.ts
//
// 通用全屏 pass 封装单测（参照 historyBlit.test.ts 的 mock Context 范式）。
// node 环境无 WebGL，FullscreenPass 只测装配/接口/生命周期——不跑真实 GL。
// 仅类型导入 cesium（DrawCommand/Context），无运行时 cesium 依赖，故不需 vi.mock('cesium')。
import { describe, it, expect, vi } from 'vitest'
import { FullscreenPass } from './FullscreenPass'

// mock Context：仅 createViewportQuadCommand（fragmentShaderSource, overrides）→ 假 DrawCommand。
// 参照 historyBlit.test.ts:87 createMockContext。透传 overrides 字段便于断言装配。
function createMockContext(): any {
  return {
    createViewportQuadCommand: (fragmentShaderSource: string, overrides: any) => ({
      fragmentShaderSource, // shader 串透传（断言用）
      uniformMap: overrides?.uniformMap,
      framebuffer: overrides?.framebuffer,
      renderState: overrides?.renderState,
      pass: overrides?.pass,
      // execute spy：手动 execute 路径（postRender blit）调用计数验证
      execute: vi.fn(),
    }),
  }
}

describe('FullscreenPass', () => {
  it('构造：组装 DrawCommand（createViewportQuadCommand）+ 透传 uniformMap/shader', () => {
    const ctx = createMockContext()
    const um = { u_color: () => 1.0 }
    const pass = new FullscreenPass(ctx, {
      fragmentShaderSource: 'void main(){}',
      uniformMap: um,
    })
    expect(pass.command).toBeDefined()
    // shader 串透传到 command
    expect((pass.command as any).fragmentShaderSource).toBe('void main(){}')
    // uniformMap 透传（闭包绑定）
    expect((pass.command as any).uniformMap).toBe(um)
  })

  it('可选 framebuffer/renderState/pass 透传到 command（进 pass 调度场景）', () => {
    const ctx = createMockContext()
    const fbo = { tag: 'fbo' } as any
    const rs = { id: 42 } as any
    const pass = new FullscreenPass(ctx, {
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
      framebuffer: fbo,
      renderState: rs,
      pass: 10,
    })
    expect((pass.command as any).framebuffer).toBe(fbo)
    expect((pass.command as any).renderState).toBe(rs)
    expect((pass.command as any).pass).toBe(10)
  })

  it('execute(context) 调 command.execute（手动 postRender 场景，如 history blit）', () => {
    const ctx = createMockContext()
    const pass = new FullscreenPass(ctx, {
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
    })
    pass.execute(ctx)
    expect((pass.command as any).execute).toHaveBeenCalledTimes(1)
  })

  it('destroy：释放 command（command 变 undefined，幂等）', () => {
    const ctx = createMockContext()
    const pass = new FullscreenPass(ctx, {
      fragmentShaderSource: 'void main(){}',
      uniformMap: {},
    })
    expect(pass.command).toBeDefined()
    pass.destroy()
    expect(pass.command).toBeUndefined()
    // 幂等：二次 destroy 不抛
    expect(() => pass.destroy()).not.toThrow()
  })
})
