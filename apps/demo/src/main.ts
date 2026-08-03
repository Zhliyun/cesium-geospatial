// Phase 1 Task 7：demo 接线——把 createAtmosphereStage 接到 ?mode=atmosphere，
// 接 ion 影像+地形，A 路径场景开关（对数深度/关地面大气/关雾），URL 参数化验收。
// 保留 ?mode=sky|depth 旧分支作回归对照。
import {
  Viewer,
  SceneMode,
  Ion,
  Cartesian3,
  Color,
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

  // URL time / camera：所有 mode 共享（time 决定太阳方向，camera 决定初始视角）。
  // 此前只在 atmosphere 分支解析，导致 sky/depth 对照时相机不到目标位置。
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

  // 视角实时写入 URL hash（复现/分享视角用）：相机停稳后地址栏 #camera= 自动更新为当前
  // lon,lat,height,heading,pitch。排查 artifact 时转到问题视角停一下，复制地址栏即可精确复现。
  viewer.camera.moveEnd.addEventListener(() => {
    const pos = viewer.camera.positionCartographic
    const lon = CesiumMath.toDegrees(pos.longitude).toFixed(4)
    const lat = CesiumMath.toDegrees(pos.latitude).toFixed(4)
    const h = pos.height.toFixed(0)
    const heading = CesiumMath.toDegrees(viewer.camera.heading).toFixed(1)
    const pitch = CesiumMath.toDegrees(viewer.camera.pitch).toFixed(1)
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search}#camera=${lon},${lat},${h},${heading},${pitch}`
    )
  })

  // 瓦片缓存诊断（用户假设：黑带/透明与 ion 影像地形瓦片回收相关）。
  // Cesium 按需加载 + LRU 回收瓦片；被回收/未加载的区域 depthTexture 是低 LOD 或椭球面
  // 深度，大气 shader 用错误深度反演 positionECEF → transmittance/inscatter 崩 → 黑带/透明。
  // 调大 tileCacheSize（默认 ~100）减少回收，preloadAncestors 让低 LOD 祖先兜底。
  // URL ?tileCache=N 可调，默认调大到 2000 观察黑带是否消失。
  const tileCache = getNumber('tileCache')
  if (tileCache != null && tileCache > 0) {
    scene.globe.tileCacheSize = tileCache
  } else {
    scene.globe.tileCacheSize = 5000
  }
  scene.globe.preloadAncestors = true
  scene.globe.preloadSiblings = true

  if (mode === 'atmosphere') {
    // B 路径场景开关（完全参考 cesium-clouds-atmosphere）：
    // - logarithmicDepthBuffer=true：地形 z-fighting/深度必需。
    // - globe.enableLighting：B 路径用 Cesium 原生光照（大气只叠加透射/内散射，不重算 lighting）。
    //   代价：太空视角下昼夜分界线（terminator）+ 地形 LOD 边界法向 discontinuity 显现为弧线/多条
    //   「水波纹」（非大气 artifact）。URL ?lighting=0 可关（地表全亮无 terminator，大气 inscatter 仍
    //   提供昼夜感）；默认开（地表昼夜自然，代价是太空视角 terminator 明显）。
    // - showGroundAtmosphere=false / fog.enabled=false：避免与后处理大气双重叠加。
    // - depthTestAgainstTerrain：createAtmosphereStage 内部强制（PostProcess depthTexture 拿真实地形深度）。
    scene.logarithmicDepthBuffer = true
    scene.globe.enableLighting = getString('lighting') !== '0'
    scene.globe.showGroundAtmosphere = false
    scene.fog.enabled = false
    // 低 LOD 占位色：globe 对「地形几何已加载（depth<1，走 B 路径）但影像未贴图」的瓦片渲染 baseColor。
    // 中性深灰，影像加载完被覆盖。depthTestAgainstTerrain=true 下完全未加载瓦片不渲染（depth=1，
    // shader 用视线方向判未渲染地面并透传清屏色 fallback）。
    scene.globe.baseColor = Color.fromCssColorString('#3a3a3a')
    // 清屏黑：depthTestAgainstTerrain=true 时天空与未渲染瓦片 globe 都不渲染，colorTexture=清屏色
    // （scene.backgroundColor，Cesium 默认白）。设黑：天空像素黑→getSkyRadiance 覆盖（黑底不影响最终
    // 天空色）；未渲染地面（depth=1+视线朝地球）透传原色=黑（未加载占位）。天空/地面判定用视线方向
    // （不依赖亮度），黑清屏不参与判定。
    scene.backgroundColor = Color.BLACK

    // LUT 加载 + AtmosphereStage（B 路径合成 + 动态曝光，createAtmosphereStage 自行 add）。
    const context = (scene as unknown as { context: unknown }).context
    const luts = await loadAtmosphereLUTs(
      context as Parameters<typeof loadAtmosphereLUTs>[0],
      '/luts'
    )
    const options: AtmosphereStageOptions = {
      debugMode: getNumber('debug') ?? 0,
      // 动态曝光可 URL 微调（默认 day=1.2 / night=0.1 / twilight±6°，按相机当地太阳高度角自动）
      ...(getNumber('exposureDay') != null ? { exposureDay: getNumber('exposureDay')! } : {}),
      ...(getNumber('exposureNight') != null ? { exposureNight: getNumber('exposureNight')! } : {}),
      // 地面反射衰减（默认 0.5 压地面过曝；URL ?groundDim=N 微调，1.0=不衰减）
      ...(getNumber('groundDim') != null ? { groundDim: getNumber('groundDim')! } : {})
    }
    // 诊断基线：atmo=0 完全跳过大气后处理，画面=纯 Cesium globe（含原生光照）。
    const skipAtmosphere =
      getString('atmo') === '0' || getString('atmo') === 'false'
    if (skipAtmosphere) {
      scene.logarithmicDepthBuffer = false
    } else {
      createAtmosphereStage(scene, luts, options)
    }

    // ion 影像+地形（失败 fallback，不阻断——无 token/网络/资产无权时 console.warn 裸 globe）。
    await setupIonImageryTerrain(viewer, ionToken)
  } else if (mode === 'sky') {
    // 回归对照：Phase 0 SkyStage（对数深度保持 false）
    scene.logarithmicDepthBuffer = false
    // ion 影像+地形（对比 atmosphere mode 的 globe artifact：sky mode log depth=false、
    // 无 depthTestAgainstTerrain；若 artifact 消失即 atmosphere 引入，若仍在则是 ion 资产本身）
    await setupIonImageryTerrain(viewer, ionToken)
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
