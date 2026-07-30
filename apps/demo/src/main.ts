// Phase 1 Task 7：demo 接线——把 createAtmosphereStage 接到 ?mode=atmosphere，
// 接 ion 影像+地形，A 路径场景开关（对数深度/关地面大气/关雾），URL 参数化验收。
// 保留 ?mode=sky|depth 旧分支作回归对照。
import {
  Viewer,
  SceneMode,
  Ion,
  Cartesian3,
  JulianDate,
  Math as CesiumMath,
  createWorldImageryAsync,
  createWorldTerrainAsync
} from 'cesium'
import {
  loadAtmosphereLUTs,
  createAtmosphereStage,
  type AtmosphereStageOptions
} from '@cesium-geospatial/core'
import { createSkyStage } from './SkyStage'
import { createDepthDebugStage } from './DepthDebugStage'

// ---- URL 参数解析（评审 critical：可复现验收）----
const params = new URLSearchParams(location.search)

function getString(key: string): string | null {
  return params.get(key)
}

function getNumber(key: string): number | null {
  const raw = params.get(key)
  if (raw == null || raw.length === 0) return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/**
 * ion token 解析：优先 vite 环境变量 VITE_ION_TOKEN，次选 URL ?ionToken=，再否则空。
 * token 不入库（不写死在代码里）。
 */
function resolveIonToken(): string {
  const envToken = import.meta.env.VITE_ION_TOKEN
  if (typeof envToken === 'string' && envToken.length > 0) return envToken
  const urlToken = getString('ionToken')
  if (urlToken != null && urlToken.length > 0) return urlToken
  return ''
}

/**
 * 接 ion 全球影像+地形。失败（无 token / 网络 / 资产无权）→ fallback 裸 globe，
 * console.warn 不阻断（atmosphere 后处理不依赖底图，仍可验收天空/大气）。
 */
async function setupIonImageryTerrain(viewer: Viewer, token: string): Promise<void> {
  if (token.length === 0) {
    console.warn('[phase1] ion 不可用，用裸 globe')
    return
  }
  // 影像
  try {
    const imagery = await createWorldImageryAsync()
    viewer.imageryLayers.removeAll()
    viewer.imageryLayers.addImageryProvider(imagery)
  } catch (err) {
    console.warn('[phase1] ion 影像加载失败，fallback 裸 globe', err)
  }
  // 地形
  try {
    viewer.terrainProvider = await createWorldTerrainAsync()
  } catch (err) {
    console.warn('[phase1] ion 地形加载失败，fallback 椭球地形', err)
  }
}

async function main(): Promise<void> {
  // ion token 早设（Viewer 构造前；虽 baseLayer:false 不触发默认 Bing，terrain 仍需）
  const ionToken = resolveIonToken()
  if (ionToken.length > 0) {
    Ion.defaultAccessToken = ionToken
  }

  const viewer = new Viewer('cesium', {
    baseLayer: false, // 不走默认 Bing 影像（需 token 早设）；atmosphere 模式异步 add
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

  // 通用：隐藏 Cesium 自带天空盒/大气/日/月（atmosphere 模式由后处理接管；
  // sky/depth 分支延续 Phase 0 行为）
  if (scene.skyBox != null) scene.skyBox.show = false
  if (scene.skyAtmosphere != null) scene.skyAtmosphere.show = false
  if (scene.sun != null) scene.sun.show = false
  if (scene.moon != null) scene.moon.show = false

  const mode = getString('mode') ?? 'sky'

  if (mode === 'atmosphere') {
    // 【A 路径场景开关，评审 critical——缺一双重大气】
    // - logarithmicDepthBuffer=true：T1/T5 深度重建依赖对数深度（Phase 0 的 false 是
    //   临时回避多视锥，Phase 1 全球地形必须用对数深度，否则高空 z-fighting/深度重建失真）。
    // - globe.showGroundAtmosphere=false：默认 true 会与后处理大气叠加成双重大气。
    // - fog.enabled=false：避免 Cesium 内置雾额外罩一层。
    // - A 路径 globe.enableLighting=false（光照由 atmosphere shader 负责）；
    //   B 路径=true 作 ground truth 对照（同时关 sunLight/skyLight）。
    const ab = (getString('ab') ?? 'a').toLowerCase()
    const isBPath = ab === 'b'

    scene.logarithmicDepthBuffer = true
    scene.globe.enableLighting = isBPath
    scene.globe.showGroundAtmosphere = false
    scene.fog.enabled = false

    // URL time：固定 JulianDate（决定太阳方向——preRender 据此算 sunDirection）
    const time = getString('time')
    if (time != null && time.length > 0) {
      viewer.clock.currentTime = JulianDate.fromIso8601(time)
    }

    // URL camera：lon,lat,height,heading,pitch（角度制，人类可读）；heading/pitch 可省略
    const cameraStr = getString('camera')
    if (cameraStr != null && cameraStr.length > 0) {
      const parts = cameraStr.split(',').map(s => Number(s.trim()))
      const lon = parts[0]
      const lat = parts[1]
      const height = parts[2]
      const heading = Number.isFinite(parts[3]) ? parts[3] : 0
      const pitch = Number.isFinite(parts[4]) ? parts[4] : -90
      if ([lon, lat, height].every(Number.isFinite)) {
        viewer.camera.setView({
          destination: Cartesian3.fromDegrees(lon, lat, height),
          orientation: {
            heading: CesiumMath.toRadians(heading),
            pitch: CesiumMath.toRadians(pitch),
            roll: 0
          }
        })
      }
    }

    // LUT 加载（context 从 scene 取，与 Phase 0 同）+ AtmosphereStage
    // 注意：createAtmosphereStage 自行 add 到 postProcessStages，返回 handle，勿重复 add。
    const context = (scene as unknown as { context: unknown }).context
    const luts = await loadAtmosphereLUTs(
      context as Parameters<typeof loadAtmosphereLUTs>[0],
      '/luts'
    )
    const options: AtmosphereStageOptions = {
      albedoScale: getNumber('albedoScale') ?? 1,
      exposure: getNumber('exposure') ?? 3.0,
      debugMode: getNumber('debug') ?? 0,
      // B 路径：关 sunLight/skyLight（与 enableLighting=true 配合作 Cesium 原生光照对照）
      ...(isBPath ? { sunLight: false, skyLight: false } : {})
    }
    createAtmosphereStage(scene, luts, options)

    // ion 影像+地形（失败 fallback，不阻断）
    await setupIonImageryTerrain(viewer, ionToken)
  } else if (mode === 'sky') {
    // 回归对照：Phase 0 SkyStage（对数深度保持 false）
    scene.logarithmicDepthBuffer = false
    const context = (scene as unknown as { context: unknown }).context
    const luts = await loadAtmosphereLUTs(
      context as Parameters<typeof loadAtmosphereLUTs>[0],
      '/luts'
    )
    const debug = getNumber('debug') ?? 0
    scene.postProcessStages.add(createSkyStage(scene, luts, debug))
  } else {
    // depth 调试分支（mode==='depth' 或其他）
    scene.logarithmicDepthBuffer = false
    scene.postProcessStages.add(createDepthDebugStage())
  }
}

main().catch(err => console.error('[phase1]', err))
