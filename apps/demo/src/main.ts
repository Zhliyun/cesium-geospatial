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
  StageGpuTimer,
  INTENSITY_DEFAULT,
  THRESHOLD_LEVEL_DEFAULT,
  GHOST_AMOUNT_DEFAULT,
  HALO_AMOUNT_DEFAULT,
  TEMPORAL_QUALITY_PRESETS,
  type AtmosphereStageOptions,
  type AtmosphereStageHandle
} from '@cesium-geospatial/core'
import {
  loadWeatherTextures,
  createCloudsStage,
  WORLD_RADII_DEFAULT
} from '@cesium-geospatial/clouds'
import { createSkyStage } from './SkyStage'
import { createDepthDebugStage } from './DepthDebugStage'
import { createCloudsSpike } from './CloudsSpikeMRT'

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

  // perf harness（scripts/perf/capture.ts）脚本化等待用：暴露 viewer 供 headless 轮询
  // scene.globe.tilesLoaded / 触发截帧。不改任何渲染行为，仅挂全局引用。
  ;(window as unknown as { __viewer?: Viewer }).__viewer = viewer

  // FPS 显示（性能优化 Phase 0 基线工具）：默认开启，画面左下角实时帧率（ms/帧）。
  // 覆盖所有 mode（大气/sky/depth 通用）。URL ?fps=0 关闭。
  // 注意：只给整体帧率；各 PostProcessStage（atmosphere/tonemap/lensflare/depthTemporal）
  // 的 GPU 细分计时需 Chrome DevTools Performance 面板或 EXT_disjoint_timer_query_webgl2。
  scene.debugShowFramesPerSecond = getString('fps') !== '0'

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

  // LOD 切换阈值（Cesium 默认 2）：调高（如 4-6）→ 瓦片更晚细化、LOD 切换频率/幅度降 → depthTexture
  // 时序抖减（缓解相机移动/俯仰时瓦片 LOD 过渡导致的 inscatter 同心波纹）。代价：地形/影像更粗糙。
  // 波纹根因是 fore/mask 读 depthTexture 的时序抖（瓦片异步加载），降 SSE 是治标首层（廉价）；
  // 不够再上时域 EMA（中等工程）。URL ?sse=N 可调，诊断波纹与 LOD 抖动关系。
  const sse = getNumber('sse')
  if (sse != null && sse > 0) {
    scene.globe.maximumScreenSpaceError = sse
  }

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
    // depthTemporal EMA 参数化（Task 12）：?temporalQuality=low|high 选 preset alpha，?depthThreshold=N
    // 调阈值，?temporalEma=0 关闭 EMA（depthTemporal 走透传，回退 czm_readDepth 等效行为；HDR 时 stage 仍创建）。
    // low（默认）=强平滑 0.05/0.5；high=弱平滑 0.1/0.8（快速操作减拖影）。
    const temporalPreset =
      getString('temporalQuality') === 'high'
        ? TEMPORAL_QUALITY_PRESETS.high
        : TEMPORAL_QUALITY_PRESETS.low
    const temporalDepthThreshold = getNumber('depthThreshold')

    const options: AtmosphereStageOptions = {
      debugMode: getNumber('debug') ?? 0,
      // 动态曝光可 URL 微调（默认 day=1.2 / night=0.1 / twilight±6°，按相机当地太阳高度角自动）
      ...(getNumber('exposureDay') != null ? { exposureDay: getNumber('exposureDay')! } : {}),
      ...(getNumber('exposureNight') != null ? { exposureNight: getNumber('exposureNight')! } : {}),
      // 地面反射衰减（默认 0.5 压地面过曝；URL ?groundDim=N 微调，1.0=不衰减）
      ...(getNumber('groundDim') != null ? { groundDim: getNumber('groundDim')! } : {}),
      // URL ?hdr=0 强制 RGBA8 兜底（跳过 HalfFloat 检测，用于在 HalfFloat 设备上对比验证兜底路径）
      ...(getString('hdr') === '0' ? { disableHalfFloat: true } : {}),
      // phase2b LensFlare（spec §5.10）：默认全开，?lensflare=0 关闭回退 phase2a 行为。
      // 调参 ?lfIntensity=/?lfThreshold=/?lfGhost=/?lfHalo= 用于实测标定（默认值来自 lensFlareConstants）。
      lensFlare: getString('lensflare') !== '0',
      lensFlareIntensity: getNumber('lfIntensity') ?? INTENSITY_DEFAULT,
      lensFlareThreshold: getNumber('lfThreshold') ?? THRESHOLD_LEVEL_DEFAULT,
      lensFlareGhost: getNumber('lfGhost') ?? GHOST_AMOUNT_DEFAULT,
      lensFlareHalo: getNumber('lfHalo') ?? HALO_AMOUNT_DEFAULT,
      // ghost/halo 模糊半径（preBlur 软化核偏移倍数）：默认 1.0；?lfPreBlur=N 增大模糊效果与半径
      ...(getNumber('lfPreBlur') != null ? { lensFlarePreBlur: getNumber('lfPreBlur')! } : {}),
      // 散射距离缩放（方案 A，等效空气密度倍率）：默认 1.0=phase1 物理，?distanceScale=N 中近距散射增强
      ...(getNumber('distanceScale') != null ? { distanceScale: getNumber('distanceScale')! } : {}),
      // inscatter 放大（方案 B 远处白雾浓）：默认 25（用户验收固化），?inscatterScale=1 回退 phase1 物理量级
      ...(getNumber('inscatterScale') != null ? { inscatterScale: getNumber('inscatterScale')! } : {}),
      // dithering 强度倍率：默认 1.0=phase1；?ditherScale=N 放大 input+display dithering 打散 inscatterScale 放大 ACES 输入暴露的弧线波纹
      ...(getNumber('ditherScale') != null ? { ditherScale: getNumber('ditherScale')! } : {}),
      // limb outer glow（太空视角大气边缘向外扩散辉光）：默认 intensity=0.3 / decay=30km；
      // ?limbGlow=N 调强度（0=关），?limbDecay=N 调扩散范围 km。验收视角：camera=93.9439,31.6997,61883,89.2,-19.0
      ...(getNumber('limbGlow') != null ? { limbGlowIntensity: getNumber('limbGlow')! } : {}),
      ...(getNumber('limbDecay') != null ? { limbGlowDecayKm: getNumber('limbDecay')! } : {}),
      // M5 云 god rays 光柱增益：默认 1 物理精确（subtle 对齐 three）；?cloudsGodRays=20 艺术放大出可见光柱
      ...(getNumber('cloudsGodRays') != null ? { cloudsGodRaysGain: getNumber('cloudsGodRays')! } : {}),
      // 月光（2026-08-30 方向 C）：?moon=0 全关（月盘不编入+云月光乘 0）——诊断基线；
      // ?moonRadiance= 月盘倍率（默认 1440）；?moonAngularRadius= 月盘角半径 rad（默认 0.0135=物理×3，
      // 偏离默认时自动 ×k² 补偿显示亮度——spec §5.2 耦合纪律）；?moonLightScale= 云月光倍率（默认 50000）。
      ...(getString('moon') === '0' ? { moon: false } : {}),
      ...(getNumber('moonRadiance') != null ? { moonRadianceScale: getNumber('moonRadiance')! } : {}),
      ...(getNumber('moonAngularRadius') != null
        ? (() => {
            const omega = getNumber('moonAngularRadius')!
            const k = omega / 0.0135 // 库默认比（0.0135=物理 0.0045×3，用户拍板）
            // ω 可调时倍率**默认值**同步 ×k²（同式下每像素 radiance ∝ 1/ω²，保持显示亮度——
            // spec §5.2）。仅未显式传 ?moonRadiance= 时补偿；显式值用户自理不补偿（brief 行内
            // 注释/全局约束/spec 三处一致；守卫式而非 spread 顺序——两参同传语义不随顺序漂移）。
            // 1440 = 库内 moonRadianceScale 默认（AtmosphereStage.ts）。
            return getNumber('moonRadiance') != null
              ? { moonAngularRadius: omega }
              : { moonAngularRadius: omega, moonRadianceScale: 1440 * k * k }
          })()
        : {}),
      // depthTemporal EMA（Task 12）：默认 EMA 开 + low preset；?temporalEma=0 关闭，?temporalQuality=high 弱平滑
      temporalEma: getString('temporalEma') !== '0',
      temporalLowAlpha: temporalPreset.lowAlpha,
      temporalHighAlpha: temporalPreset.highAlpha,
      ...(temporalDepthThreshold != null ? { temporalDepthThreshold } : {}),
      // depthTemporal stage 创建开关（Phase 1.1 升级）：默认不创建（省 1 全屏 pass+blit+3 HF RT；
      // 真实 GPU profile 实测 ≈2-6ms/帧）。?depthTemporal=1 显式创建（恢复旧行为，occlusion 用 smoothDepth）
      depthTemporal: getString('depthTemporal') === '1'
    }
    // 诊断基线：atmo=0 完全跳过大气后处理，画面=纯 Cesium globe（含原生光照）。
    const skipAtmosphere =
      getString('atmo') === '0' || getString('atmo') === 'false'
    // M5 云 god rays atmosphere 路径：clouds march 的视线 shadowLength bridge（cloudsHandle 在
    // 下方后创建——闭包惰性求值，云未开/关光柱时返回 undefined → 天空 shadow_length=0 零回归）。
    let cloudsShadowBridge:
      | (() => { _texture: unknown; _target: number } | undefined)
      | undefined = undefined
    // lf×云交互 #1（2026-08-30）：云覆盖率 bridge（march att0 premultiplied，.a=覆盖率）→ lf
    // occlusion 36 点采样叠加云遮挡（太阳被云挡时 halo/ghost 按覆盖率衰减）。同 cloudsShadowBridge
    // 模式：外层声明、clouds 块赋值、闭包惰性求值（云未开=undefined → occlusion 不编译云采样零回归）。
    let cloudsOcclusionBridge:
      | (() => { _texture: unknown; _target: number } | undefined)
      | undefined = undefined
    // #3 profile 可重入 wrap（lf×云 2026-08-30）：clouds 块 insertStageBeforeLensFlare 会 remove→重建
    // lf→re-add tm——新实例若不补 wrap，?profile=1 输出缺 lf*/tonemap 键。启动 wrap 后 clouds 块
    // insert 成功调 rewrapStages?.() 补 wrap（WeakSet 防重；同名 wrap 覆盖 timer query，旧实例已
    // remove 不再 execute，残留 read 停旧值无害）。
    let rewrapStages: (() => void) | undefined = undefined
    // atmosphereHandle 作用域提升（v2 spec §7）：else 块创建、下方 clouds 块 insert
    // overlayStage 到 atmosphere 与 lensFlare 之间——两块平级，需在外层声明共享。
    let atmosphereHandle: AtmosphereStageHandle | undefined
    if (skipAtmosphere) {
      scene.logarithmicDepthBuffer = false
    } else {
      atmosphereHandle = createAtmosphereStage(scene, luts, {
        ...options,
        cloudsShadowLengthBridge: () => cloudsShadowBridge?.(),
        cloudsOcclusionBridge: () => cloudsOcclusionBridge?.()
      })

      // 性能 profiling（Phase 0）：?profile=1 逐 stage GPU 计时（EXT_disjoint_timer_query_webgl2）。
      // 评审 M2：lensflare 取外层 composite（TIME_ELAPSED 不可嵌套，同帧一层粒度）；
      // 评审 M7：depthTemporal 的每帧 postRender blit 在 stage.execute 之外，单独包 query 归入 depthTemporal。
      // StageGpuTimer 无 tickFrame（已删）；read 就绪门是轮询 QUERY_RESULT_AVAILABLE（非阻塞）。
      if (getString('profile') === '1') {
        const gl = (scene as unknown as { context: { _gl: WebGL2RenderingContext } }).context._gl
        const timer = new StageGpuTimer(gl)
        if (!timer.supported) {
          console.warn('[profile] EXT_disjoint_timer_query_webgl2 不可用，fallback toggle-diff（需 --disable-gpu-vsync）')
        }
        const stages = scene.postProcessStages
        const wrapped: Array<{ name: string }> = []
        const wrappedSet = new WeakSet<object>() // #3 防重 wrap（同实例二次 wrap 会计时嵌套错）
        // 评审 Critical：PostProcessStageComposite 没有 execute 方法（集合内部对 composite 递归逐子
        // stage 调 execute），直接 st.execute.bind 会在 lensflare composite 上抛 TypeError。
        // 有 execute → 包之；否则按 composite 公开 API（length + get(i)，子 stage 在私有 _stages，
        // 无 stages 属性）递归包子 stage——lensflare 内嵌套 bloomComposite 也是 composite，递归到底。
        // 子 stage 顺序执行互不嵌套，不违反 TIME_ELAPSED 单活跃 query 约束，
        // 且得到逐子 stage 计时（lf_threshold/lf_down*/lf_up*/lf_preBlur/lf_occlusion/lf_features/
        // lf_composite）——Task 7 需要的粒度。两分支都不匹配时 warn 兜底（防未来再静默跳过）。
        type WrappableStage = {
          name?: string
          execute?: unknown
          get?: (i: number) => unknown
          length?: number
        }
        const wrapStage = (st: WrappableStage): void => {
          if (typeof st.execute === 'function') {
            if (wrappedSet.has(st)) return // #3 已 wrap 跳过（可重入）
            wrappedSet.add(st)
            const name = st.name ?? 'unnamed'
            const orig = (st.execute as (...a: unknown[]) => void).bind(st)
            ;(st as { execute: unknown }).execute = timer.wrap(name, orig as (...a: unknown[]) => void)
            wrapped.push({ name })
          } else if (typeof st.get === 'function' && typeof st.length === 'number') {
            for (let j = 0; j < st.length; j++) {
              wrapStage(st.get(j) as WrappableStage)
            }
          } else {
            console.warn('[profile] 无法 wrap stage', st.name)
          }
        }
        // #3 可重入 wrap 入口：遍历当前 postProcessStages 全量（WeakSet 保证已 wrap 实例跳过、
        // 新实例补 wrap）。启动调一次；clouds 块 insertStageBeforeLensFlare 成功后再调（重建的
        // lf/tm 新实例补 wrap——否则输出缺 lf*/tonemap 键）。
        const wrapAllStages = (): void => {
          for (let i = 0; i < stages.length; i++) {
            wrapStage(stages.get(i) as unknown as WrappableStage)
          }
        }
        wrapAllStages()
        rewrapStages = wrapAllStages
        // blit 计时归入 depthTemporal（评审 M7）。depthTemporal 默认 off（Phase 1.1 升级）时 stage 不存在、
        // 无 blit lifecycle → 不注册 hook、snap 也不写 depthTemporal_blit（避免 null 占位混淆）
        if (atmosphereHandle.depthTemporalStage) {
          atmosphereHandle.setBlitTimerHook(fn => {
            timer.begin('depthTemporal_blit')
            fn()
            timer.end('depthTemporal_blit')
          })
        }
        let frame = 0
        scene.postRender.addEventListener(() => {
          frame++
          if (frame % 60 === 0) {
            const snap: Record<string, number | null> = {}
            for (const { name } of wrapped) snap[name] = timer.read(name)
            // atmosphereHandle 是外层 let——闭包内 TS 不保持非空窄化，此处可选链（demo 不回退
            // undefined，行为等价；与 :334 直流的窄化检查同源）。
            if (atmosphereHandle?.depthTemporalStage) {
              snap['depthTemporal_blit'] = timer.read('depthTemporal_blit')
            }
            console.log('[profile]', JSON.stringify(snap))
          }
        })
      }
    }

    // phase3 体积云 M2 主 raymarch：?clouds=1 → loadWeatherTextures + createCloudsStage
    // （CloudsPass custom Primitive pass=VOXELS + MRT + cloudsBuffer overlay 接 atmosphere 链尾）。
    // 验收 URL：?mode=atmosphere&clouds=1（天空有云形 flat lighting；相机移动稳定 ECEF 密切球；
    // 零回归——?clouds 不传时 createCloudsStage 返 undefined，atmosphere 链完全不变）。
    // 失败不阻断（weather .bin fetch 失败 → console.warn 跳过，atmosphere 照常）。
    if (!skipAtmosphere && getString('clouds') === '1') {
      try {
        const weather = await loadWeatherTextures(
          context as Parameters<typeof loadWeatherTextures>[0],
          '/clouds'
        )
        // M2 视觉调试（棕色同心圆排查）：?cloudsDebug=N → DEBUG_SHOW_*（1=globeUv 映射 /
        // 2=云前深度 turbo / 3=march 采样数 / 4=BSM）；?cloudsShapeDetail=0 / ?cloudsTurbulence=0 /
        // ?cloudsAccurate=0 关对应分支（隔离 pattern / 颜色来源）。
        const cloudsDebug = getNumber('cloudsDebug')
        const cloudsDebugShow =
          cloudsDebug === 1 ? ('uv' as const)
          : cloudsDebug === 2 ? ('frontDepth' as const)
          : cloudsDebug === 3 ? ('sampleCount' as const)
          : cloudsDebug === 4 ? ('shadowMap' as const)
          : cloudsDebug === 5 ? ('cascades' as const)
          : undefined
        // 质量档位白名单解析（controller 裁决 Ruling 4）：?cloudsQuality 非法值（如 foo）
        // → undefined 走库内缺省 high，而非 as 直传踩 Record 键 undefined
        const cloudsQualityRaw = getString('cloudsQuality')
        const cloudsQuality =
          cloudsQualityRaw === 'low' || cloudsQualityRaw === 'medium'
          || cloudsQualityRaw === 'high' || cloudsQualityRaw === 'ultra'
            ? cloudsQualityRaw
            : undefined
        const cloudsHandle = createCloudsStage(scene, luts, weather, {
          clouds: true,
          // 质量档位（spec 2026-08-29）：?cloudsQuality=low|medium|high|ultra（缺省 high=现状；
          // 白名单守卫——非法值忽略，防 Record 键 undefined 崩创建。局部 const 收窄使
          // getString 的 string|null 收敛到字面量联合，无需 as 断言）
          ...(cloudsQuality != null ? { quality: cloudsQuality } : {}),
          ...(cloudsDebugShow != null ? { debugShow: cloudsDebugShow } : {}),
          ...(getString('cloudsShapeDetail') === '0' ? { shapeDetail: false } : {}),
          ...(getString('cloudsTurbulence') === '0' ? { turbulence: false } : {}),
          ...(getString('cloudsAccurate') === '0' ? { accurateSunSkyLight: false } : {}),
          // M3 BSM 云自阴影诊断基线：?cloudsShadow=0 跳过 ShadowPass（主 march fallback
          // 全 0 dummy → Beer=1 无自阴影；开/关对比云体积感用）
          ...(getString('cloudsShadow') === '0' ? { shadowPass: false } : {}),
          // M4 temporal 开关（默认关——云端 resolve 收敛抖动待修，见 createCloudsStage 注释；
          // ?cloudsTemporal=1 显式开启体验 1/4 分 march + Bayer 重建的帧率优势）
          ...(getString('cloudsTemporal') === '1' ? { temporal: true } : {}),
          ...(getString('cloudsShadowTemporal') === '1' ? { shadowTemporal: true } : {}),
          // 噪声分解诊断（评审门禁实验）：冻结 cascade 矩阵（首帧后不更新）——「冻结+移动」
          // 录屏差分 = 非矩阵噪声地板（层切换/jitter/消费端），与不冻结对照相减得矩阵分量
          ...(getString('cloudsShadowFreeze') === '1' ? { shadowFreeze: true } : {}),
          // BSM 矩阵锚定模式（spec v3）：默认 world 世界锚定固定网格（消移动闪动）；
          // ?cloudsShadowAnchor=frustum 回退视锥拟合（AB 对照基线，含已知缺陷的现实现）
          ...(getString('cloudsShadowAnchor') === 'frustum' ? { shadowAnchor: 'frustum' as const } : {}),
          // world 模式 radii×N（E1' 归因实验）：?cloudsShadowScale=5 → {80,168,480}km
          // 膨胀层覆盖全程航迹（缺省 WORLD_RADII_DEFAULT {16,33.6,96}km 单源于 clouds 包）
          ...(getNumber('cloudsShadowScale') != null
            ? { worldRadii: WORLD_RADII_DEFAULT.map(r => r * getNumber('cloudsShadowScale')!) }
            : {}),
          // M5 云 god rays 开关（默认开）：?cloudsLightShafts=0 诊断基线（无云间体积光柱）
          ...(getString('cloudsLightShafts') === '0' ? { lightShafts: false } : {}),
          // 云 overlay 曝光（默认 12 线性域缩放，2026-08-29 V2 验收定稿；偏灰调大/过曝调小）
          ...(getNumber('cloudsExposure') != null ? { cloudsOverlayExposure: getNumber('cloudsExposure')! } : {}),
          // 夜间环境底光（方向 B，2026-08-29）：夜间云照明地板（默认 0.12 标定夜空底光量级；
          // 0 = 关闭回退纯黑夜间云）——调参验收用；?moonLightScale= 云月光倍率（T5
          // parameters.moonLightScale，默认 50000）；?moon=0 全关诊断基线 → 云月光强制乘 0
          // （排在显式 moonLightScale 之后，全关语义优先盖过）
          ...(getNumber('cloudsNightAmbient') != null || getNumber('moonLightScale') != null || getString('moon') === '0'
            ? {
                parameters: {
                  ...(getNumber('cloudsNightAmbient') != null
                    ? { nightAmbient: getNumber('cloudsNightAmbient')! }
                    : {}),
                  ...(getNumber('moonLightScale') != null
                    ? { moonLightScale: getNumber('moonLightScale')! }
                    : {}),
                  ...(getString('moon') === '0' ? { moonLightScale: 0 } : {})
                }
              }
            : {})
        })
        // 暴露 window.__cloudsStage（调试/控制台 destroy 用，同 __cloudsSpike 模式）
        cloudsShadowBridge = cloudsHandle != null
          ? () => cloudsHandle.cloudsPass.getShadowLengthBridge()
          : undefined
        // lf×云 #1：云覆盖率 bridge（march att0 premultiplied，.a=覆盖率）→ lf occlusion
        cloudsOcclusionBridge = cloudsHandle != null
          ? () => cloudsHandle.cloudsPass.getColorBridge()
          : undefined
        ;(window as unknown as { __cloudsStage?: unknown }).__cloudsStage =
          cloudsHandle
        if (cloudsHandle != null) {
          // v2 spec §7：云 overlay 编排——插入 atmosphere 与 lensFlare 之间（halo 画在云上）。
          // insert 失败处置（spec §6.3）：console.error（区别 weather 失败的 warn）+ 回收
          // cloudsHandle（march primitive 不白跑）+ 清 shadow bridge（防读已销毁 cloudsPass）。
          if (atmosphereHandle != null) {
            try {
              atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)
              // #3 profile 补 wrap：insert 重建了 lf/tm（新实例）——不补则 ?profile=1 输出缺
              // lf*/tonemap 键（旧实例已 remove 不再 execute，计时永 not-available）。
              rewrapStages?.()
            } catch (e) {
              console.error('[clouds] 后处理链插入失败，云已回收', e)
              cloudsHandle.destroy()
              cloudsShadowBridge = undefined
              cloudsOcclusionBridge = undefined
            }
          } else {
            scene.postProcessStages.add(cloudsHandle.overlayStage) // 独立消费者 fallback（demo 不可达，防御）
          }
          console.info(
            '[phase3-clouds] 体积云已接线（M3 稳定行为 + M5 云 god rays；?cloudsLightShafts=0 关光柱对比；?cloudsTemporal=1 开 Bayer 重建——帧率↑但有抖动；?cloudsShadow=0 无自阴影；?cloudsShadowAnchor=frustum 回退视锥锚定 AB 基线；?cloudsQuality=N 初始档/按键 1-4 切档）'
          )
          // 质量档位快捷键（setQuality 运行时验证入口，spec §8）：1/2/3/4 = low/medium/high/ultra。
          // 仅帧间触发（keydown 在 rAF 外，spec §7 调用时机约束天然满足）。
          const QUALITY_KEYS: Record<string, 'low' | 'medium' | 'high' | 'ultra'> = {
            '1': 'low', '2': 'medium', '3': 'high', '4': 'ultra'
          }
          window.addEventListener('keydown', (ev) => {
            const next = QUALITY_KEYS[ev.key]
            if (next != null) {
              cloudsHandle.setQuality(next)
              console.info(`[phase3-clouds] quality → ${next}（setQuality 内部重建）`)
            }
          })
          // 平移探针（噪声分解实验）：每帧 moveForward N 米（直线平移，激发 BSM texel 跳变
          // 通道——rotateLeft 是轨道移动，模式单一）。preRender 里持续驱动，录屏窗口截取。
          const probeMove = getNumber('cloudsProbeMove')
          if (probeMove != null && probeMove > 0) {
            let probeFrame = 0
            scene.preRender.addEventListener(() => {
              probeFrame++
              if (probeFrame > 30) {
                // 前 30 帧等场景稳定（瓦片/BSM 首帧），之后匀速前进
                viewer.camera.moveForward(probeMove)
              }
            })
            console.info(`[probe] 平移探针激活：每帧前进 ${probeMove}m（第 30 帧起）`)
          }
          // 轨道探针（spec §6 主战场）：每帧 rotateLeft N 弧度（绕焦点，位姿耦合移动——
          // position 与 orientation 同时变，激发与平移不同的矩阵扰动通道）。前 30 帧等
          // 场景稳定后启动，与 probeMove 同模式（互斥使用：同 URL 同时传时各自独立驱动）。
          const probeOrbit = getNumber('cloudsProbeOrbit')
          if (probeOrbit != null && probeOrbit > 0) {
            let orbitFrame = 0
            scene.preRender.addEventListener(() => {
              if (++orbitFrame > 30) viewer.camera.rotateLeft(probeOrbit)
            })
            console.info(`[probe] 轨道探针激活：每帧 rotateLeft ${probeOrbit}rad（第 30 帧起）`)
          }
          // dolly 缩放探针（spec §6 第四探针）：每帧 zoomIn N 米（沿视线缩放 = 滚轮语义，
          // 相机-焦点距离变 → 级联层选择/视锥比例变化通道）。手动滚轮不可脚本化，
          // 用相机 API 等价驱动（与 probeMove/probeOrbit 同 preRender 域同 30 帧延迟）。
          const probeZoom = getNumber('cloudsProbeZoom')
          if (probeZoom != null && probeZoom > 0) {
            let zoomFrame = 0
            scene.preRender.addEventListener(() => {
              if (++zoomFrame > 30) viewer.camera.zoomIn(probeZoom)
            })
            console.info(`[probe] dolly 探针激活：每帧 zoomIn ${probeZoom}m（第 30 帧起）`)
          }
        }
      } catch (err) {
        console.warn('[phase3-clouds] weather 纹理加载失败，跳过体积云', err)
      }
    }

    // ion 影像+地形（失败 fallback，不阻断——无 token/网络/资产无权时 console.warn 裸 globe）。
    await setupIonImageryTerrain(viewer, ionToken)

    // phase3 体积云 M1 spike probe：?cloudsSpike=1/2/3 验证 custom Primitive pass=VOXELS + 自管 MRT FBO
    // 可行性（4 项 go/no-go，详见 CloudsSpikeMRT.ts 头注）。不传时不加 primitive/stage，atmosphere mode
    // 完全不变（零回归）。1=overlay 读 att0(color) 验 #1/#2/#3；2=att1(depthVel) / 3=att2(shadowLen) 验 #4 MRT 多 out。
    const cloudsSpike = getNumber('cloudsSpike')
    if (cloudsSpike != null && cloudsSpike > 0) {
      const spike = createCloudsSpike(scene, cloudsSpike)
      ;(window as unknown as { __cloudsSpike?: unknown }).__cloudsSpike = spike
    }
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
