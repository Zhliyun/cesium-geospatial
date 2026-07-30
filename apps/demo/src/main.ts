import { Viewer, SceneMode } from 'cesium'
import { loadAtmosphereLUTs } from '@cesium-geospatial/core'
import { createSkyStage } from './SkyStage'
import { createDepthDebugStage } from './DepthDebugStage'

async function main(): Promise<void> {
  const viewer = new Viewer('cesium', {
    baseLayer: false, // Phase 0 无需底图（globe 地形即可验证，且免 ion token）
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    sceneMode: SceneMode.SCENE3D
  })
  const scene = viewer.scene
  scene.logarithmicDepthBuffer = false // MVP 回避对数深度
  if (scene.skyBox != null) scene.skyBox.show = false
  if (scene.skyAtmosphere != null) scene.skyAtmosphere.show = false
  if (scene.sun != null) scene.sun.show = false
  if (scene.moon != null) scene.moon.show = false

  const mode = new URLSearchParams(location.search).get('mode') ?? 'sky'
  if (mode === 'sky') {
    // scene.context 类型未在 cesium .d.ts 公开，运行时存在
    const context = (scene as unknown as { context: unknown }).context
    const luts = await loadAtmosphereLUTs(
      context as Parameters<typeof loadAtmosphereLUTs>[0],
      '/luts'
    )
    // debug: 0=正常 1=log(1+radiance) 2=太阳方向 3=相机位置量级
    const debug = Number(
      new URLSearchParams(location.search).get('debug') ?? '0'
    )
    scene.postProcessStages.add(createSkyStage(scene, luts, debug))
  } else {
    scene.postProcessStages.add(createDepthDebugStage())
  }
}

main().catch(err => console.error('[phase0]', err))
