import { describe, it, expect, vi } from 'vitest'
import type { Scene } from 'cesium'
import { applySceneTakeover, captureSceneState } from './sceneTakeover'

// 结构化假 scene：不构造任何真实 Cesium 对象。本模块零运行时依赖，
// 只依赖 scene.* 的属性读写与 isDestroyed()/requestRender() 两个方法。
type FakeColor = { red: number; green: number; blue: number; alpha: number }
interface FakeGlobe {
  depthTestAgainstTerrain: boolean
  showGroundAtmosphere: boolean
  enableLighting: boolean
}
interface FakeScene {
  globe: FakeGlobe
  skyAtmosphere?: { show: boolean }
  skyBox?: { show: boolean }
  sun?: { show: boolean }
  moon?: { show: boolean }
  fog: { enabled: boolean }
  backgroundColor: FakeColor
  logarithmicDepthBuffer: boolean
  highDynamicRange: boolean
  requestRenderMode: boolean
  requestRender: () => void
  isDestroyed: () => boolean
}

const toScene = (fake: FakeScene): Scene => fake as unknown as Scene

const ORIGINAL_BACKGROUND: FakeColor = { red: 0.1, green: 0.2, blue: 0.3, alpha: 1 }
const BLACK: FakeColor = { red: 0, green: 0, blue: 0, alpha: 1 }

function makeGlobe(overrides: Partial<FakeGlobe> = {}): FakeGlobe {
  return {
    depthTestAgainstTerrain: false,
    showGroundAtmosphere: true,
    enableLighting: true,
    ...overrides
  }
}

function makeScene(): FakeScene {
  return {
    globe: makeGlobe(),
    skyAtmosphere: { show: true },
    skyBox: { show: true },
    sun: { show: true },
    moon: { show: true },
    fog: { enabled: true },
    backgroundColor: { ...ORIGINAL_BACKGROUND },
    logarithmicDepthBuffer: false,
    highDynamicRange: true,
    requestRenderMode: true,
    requestRender: vi.fn(),
    isDestroyed: () => false
  }
}

/** 捕获 + 接管（enabled 由用例决定），返回 handle。 */
function takeOver(scene: FakeScene, enabled = true) {
  return applySceneTakeover(toScene(scene), captureSceneState(toScene(scene)), { enabled })
}

describe('场景接管（spec §7.6）', () => {
  it('接管后 12 项均为安装值，restore 后逐项回到原值', () => {
    const scene = makeScene()
    const originalBackground = scene.backgroundColor
    const t = takeOver(scene)
    expect(t.applied).toBe(true)

    // 1-4 scene 级
    expect(scene.logarithmicDepthBuffer).toBe(true)
    expect(scene.highDynamicRange).toBe(false)
    expect(scene.requestRenderMode).toBe(false)
    expect(scene.backgroundColor).toEqual(BLACK)
    // 5-9 天空/太阳/月/雾
    expect(scene.skyAtmosphere?.show).toBe(false)
    expect(scene.skyBox?.show).toBe(false)
    expect(scene.sun?.show).toBe(false)
    expect(scene.moon?.show).toBe(false)
    expect(scene.fog.enabled).toBe(false)
    // 10-12 globe（按当前 globe 对象写）
    expect(scene.globe.depthTestAgainstTerrain).toBe(true)
    expect(scene.globe.showGroundAtmosphere).toBe(false)
    expect(scene.globe.enableLighting).toBe(false)

    t.restore()
    expect(t.applied).toBe(false)
    // 1-4 scene 级
    expect(scene.logarithmicDepthBuffer).toBe(false)
    expect(scene.highDynamicRange).toBe(true)
    expect(scene.requestRenderMode).toBe(true)
    expect(scene.backgroundColor).toBe(originalBackground)
    // 5-9
    expect(scene.skyAtmosphere?.show).toBe(true)
    expect(scene.skyBox?.show).toBe(true)
    expect(scene.sun?.show).toBe(true)
    expect(scene.moon?.show).toBe(true)
    expect(scene.fog.enabled).toBe(true)
    // 10-12
    expect(scene.globe.depthTestAgainstTerrain).toBe(false)
    expect(scene.globe.showGroundAtmosphere).toBe(true)
    expect(scene.globe.enableLighting).toBe(true)
  })

  it('takeOverScene=false 时只快照并强制 depthTestAgainstTerrain，restore 可还原', () => {
    const scene = makeScene()
    const t = takeOver(scene, false)
    expect(t.applied).toBe(false)

    // 底层 createAtmosphereStage 无条件置 true：即使不接管也必须生效
    expect(scene.globe.depthTestAgainstTerrain).toBe(true)
    // 其余 11 项保持原值
    expect(scene.logarithmicDepthBuffer).toBe(false)
    expect(scene.highDynamicRange).toBe(true)
    expect(scene.requestRenderMode).toBe(true)
    expect(scene.backgroundColor).toEqual(ORIGINAL_BACKGROUND)
    expect(scene.skyAtmosphere?.show).toBe(true)
    expect(scene.skyBox?.show).toBe(true)
    expect(scene.sun?.show).toBe(true)
    expect(scene.moon?.show).toBe(true)
    expect(scene.fog.enabled).toBe(true)
    expect(scene.globe.showGroundAtmosphere).toBe(true)
    expect(scene.globe.enableLighting).toBe(true)
    expect(scene.requestRender).not.toHaveBeenCalled()

    t.restore()
    expect(scene.globe.depthTestAgainstTerrain).toBe(false)
  })

  it('宿主替换 globe 后不向新 globe 写旧值（按捕获对象还原）', () => {
    const scene = makeScene()
    const originalGlobe = scene.globe
    const t = takeOver(scene)
    expect(originalGlobe.depthTestAgainstTerrain).toBe(true)
    expect(originalGlobe.showGroundAtmosphere).toBe(false)
    expect(originalGlobe.enableLighting).toBe(false)

    // 宿主在安装期间替换 globe：新对象保持自己的值
    const replacement = makeGlobe({
      depthTestAgainstTerrain: true,
      showGroundAtmosphere: false,
      enableLighting: false
    })
    scene.globe = replacement

    t.restore()
    expect(scene.globe).toBe(replacement)
    expect(replacement.depthTestAgainstTerrain).toBe(true)
    expect(replacement.showGroundAtmosphere).toBe(false)
    expect(replacement.enableLighting).toBe(false)
    // 旧 globe（快照记录的对象）被还原
    expect(originalGlobe.depthTestAgainstTerrain).toBe(false)
    expect(originalGlobe.showGroundAtmosphere).toBe(true)
    expect(originalGlobe.enableLighting).toBe(true)
  })

  it('restore 后 requestRenderMode 恢复 true 时调用 requestRender 补一帧', () => {
    const scene = makeScene()
    const t = takeOver(scene)
    expect(scene.requestRenderMode).toBe(false)
    expect(scene.requestRender).not.toHaveBeenCalled()

    t.restore()
    expect(scene.requestRenderMode).toBe(true)
    expect(scene.requestRender).toHaveBeenCalledTimes(1)
  })

  it('scene 已销毁时 restore 不抛（requestRender 已被 Cesium 换成抛错版本）', () => {
    const scene = makeScene()
    const t = takeOver(scene)
    scene.isDestroyed = () => true
    // 模拟 Cesium destroyObject 后的抛错版本；用计数断言「一次都没调」
    let requestRenderCalls = 0
    scene.requestRender = () => {
      requestRenderCalls += 1
      throw new Error('requestRender called on destroyed scene')
    }

    expect(() => t.restore()).not.toThrow()
    expect(requestRenderCalls).toBe(0)
    // 其余字段仍按快照还原
    expect(scene.logarithmicDepthBuffer).toBe(false)
    expect(scene.requestRenderMode).toBe(true)
  })

  it('restore 幂等：第二次调用不再写回、不再请求渲染', () => {
    const scene = makeScene()
    const t = takeOver(scene)
    t.restore()
    expect(scene.requestRender).toHaveBeenCalledTimes(1)

    // 宿主在 destroy 之后重新应用了自己的设置
    scene.logarithmicDepthBuffer = true
    scene.highDynamicRange = false
    const afterRestoreBackground: FakeColor = { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 }
    scene.backgroundColor = afterRestoreBackground

    t.restore()
    expect(scene.logarithmicDepthBuffer).toBe(true)
    expect(scene.highDynamicRange).toBe(false)
    expect(scene.backgroundColor).toBe(afterRestoreBackground)
    expect(scene.requestRender).toHaveBeenCalledTimes(1)
    expect(t.applied).toBe(false)
  })

  it('scene.moon 不存在时跳过（apply/restore 都不抛）', () => {
    const scene = makeScene()
    delete scene.moon
    const t = takeOver(scene)
    expect(scene.sun?.show).toBe(false)

    t.restore()
    expect(scene.sun?.show).toBe(true)
    expect(scene.logarithmicDepthBuffer).toBe(false)
  })
})
