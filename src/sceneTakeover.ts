// 场景快照、接管与无条件还原（spec §7.6）。
//
// 零运行时依赖：不 import 任何 Cesium 值，只做 type-only import，因此可在 Node 里
// 用结构化假 scene 全量单测。调用方（install 层）在创建 stage 之前
// `captureSceneState` + `applySceneTakeover`，destroy/回滚时 `takeover.restore()`。
//
// 必须遵守的规则（spec §7.6，逐条对应下方实现）：
// 1. **无条件还原**：restore 按快照逐项写回，不做「值是否仍等于安装值」的归属判定。
//    宿主在安装期间改过的设置也会被还原——文档必须明示「安装期间不要改这些设置，
//    或 destroy 后重新应用」；完全不想被接管用 `takeOverScene: false`。
// 2. **按对象记录快照**：globe / skyAtmosphere / skyBox / sun / moon / fog 上的设置
//    在捕获时记录对象引用；宿主替换对象后，旧值只写回捕获时的旧对象，不落到新对象上。
// 3. **`takeOverScene: false` 仍快照并还原 `depthTestAgainstTerrain`**：底层
//    `createAtmosphereStage` 无条件把它置 true（PostProcessStage 的 depthTexture 需要
//    真实地形深度），与是否接管无关。
// 4. **还原 requestRenderMode 后补一帧**：恢复为 true 时调用 `scene.requestRender()`，
//    但必须先 `scene.isDestroyed()` 守卫——Cesium `destroyObject` 会把未保留的方法
//    （含 requestRender）替换为抛错版本。
//
// 备注：`scene.logarithmicDepthBuffer` 置 true 后的**读回校验**由 install 层执行
// （spec §8.1 步骤 3「读回校验 log-depth」），失败时先 restore 再抛错；本模块只负责写。

import type { Color, Scene } from 'cesium'

/**
 * 安装值 `scene.backgroundColor = Color.BLACK` 的结构等价体。
 * 本模块不 import Cesium 运行时值（保持零依赖、Node 可测）；Cesium 清屏只读取颜色的
 * red/green/blue/alpha 四个通道，结构等价的普通对象即可。冻结以防被就地改写。
 */
const BLACK: Color = Object.freeze({
  red: 0,
  green: 0,
  blue: 0,
  alpha: 1
}) as unknown as Color

/**
 * 安装前的场景快照。
 *
 * 对象级设置同时记录「捕获时的对象引用」和「被设置的值」；还原只写回捕获对象，
 * 宿主之后替换的新对象不受影响（规则 2）。可选的 Cesium 对象（天空/天空盒/太阳/
 * 月亮）在不存在时值为 undefined，apply/restore 均跳过。
 */
export interface SceneState {
  /** 捕获时的 scene.globe。Cesium 的 .d.ts 标为必填，但运行时可能为空，按可空处理。 */
  readonly globe: Scene['globe'] | undefined
  readonly skyAtmosphere: Scene['skyAtmosphere']
  readonly skyBox: Scene['skyBox']
  readonly sun: Scene['sun']
  readonly moon: Scene['moon']
  readonly fog: Scene['fog']
  /** 场景级 4 项。 */
  readonly logarithmicDepthBuffer: boolean
  readonly highDynamicRange: boolean
  readonly requestRenderMode: boolean
  readonly backgroundColor: Color
  /** globe 级 3 项（挂在 {@link globe} 记录的对象上）。 */
  readonly depthTestAgainstTerrain: boolean
  readonly showGroundAtmosphere: boolean
  readonly enableLighting: boolean
  /** 天空/天空盒/太阳/月亮/雾的可见性（对象不存在时为 undefined）。 */
  readonly skyAtmosphereShow: boolean | undefined
  readonly skyBoxShow: boolean | undefined
  readonly sunShow: boolean | undefined
  readonly moonShow: boolean | undefined
  readonly fogEnabled: boolean
}

export interface SceneTakeoverOptions {
  /** 是否执行 spec §7.6 完整接管表（对应产品参数 `takeOverScene`）。 */
  enabled: boolean
}

export interface SceneTakeover {
  /** 按快照无条件还原；幂等（第二次调用是 no-op）。 */
  restore(): void
  /** 完整接管表当前是否生效（`enabled` 且尚未 restore）。 */
  readonly applied: boolean
}

/** 捕获 scene 的 12 项设置与相关对象引用（不修改 scene）。 */
export function captureSceneState(scene: Scene): SceneState {
  const globe = scene.globe as Scene['globe'] | undefined
  return {
    globe,
    skyAtmosphere: scene.skyAtmosphere,
    skyBox: scene.skyBox,
    sun: scene.sun,
    moon: scene.moon,
    fog: scene.fog,
    logarithmicDepthBuffer: scene.logarithmicDepthBuffer,
    highDynamicRange: scene.highDynamicRange,
    requestRenderMode: scene.requestRenderMode,
    backgroundColor: scene.backgroundColor,
    depthTestAgainstTerrain: globe ? globe.depthTestAgainstTerrain : false,
    showGroundAtmosphere: globe ? globe.showGroundAtmosphere : false,
    enableLighting: globe ? globe.enableLighting : false,
    skyAtmosphereShow: scene.skyAtmosphere?.show,
    skyBoxShow: scene.skyBox?.show,
    sunShow: scene.sun?.show,
    moonShow: scene.moon?.show,
    fogEnabled: scene.fog.enabled
  }
}

/**
 * 接管 scene（spec §7.6 全表）。`enabled: false` 时只强制
 * `depthTestAgainstTerrain = true`（规则 3），其余 11 项不动。
 *
 * 返回的 handle 提供幂等的 `restore()`；安装期间宿主替换的对象不会被写入旧值。
 */
export function applySceneTakeover(
  scene: Scene,
  state: SceneState,
  opts: SceneTakeoverOptions
): SceneTakeover {
  // 【第 2 项，不受 enabled 门控】createAtmosphereStage 内部无条件置
  // depthTestAgainstTerrain = true；这里必须同样保证，否则 takeOverScene:false 时
  // 快照/还原的语义与实际写入不一致。写在「当前」scene.globe 上（还原写在捕获对象上）。
  const globe = scene.globe as Scene['globe'] | undefined
  if (globe) {
    globe.depthTestAgainstTerrain = true
  }

  if (opts.enabled) {
    // —— spec §7.6 接管表（12 项）——
    // 1. 对数深度缓冲：多视锥合并的前提（读回校验由 install 层执行）。
    scene.logarithmicDepthBuffer = true
    // 2. depthTestAgainstTerrain 已在上方无条件设置。
    // 3. 关闭 HDR：否则 Cesium 会在我们的 stage 之前 tonemap。
    scene.highDynamicRange = false
    // 4. 关闭按需渲染：否则云/太阳在无输入时冻结。
    scene.requestRenderMode = false
    // 5-8. 隐藏 Cesium 自带天空/天空盒/太阳/月亮（由本库自己的大气与月盘渲染）。
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = false
    }
    if (scene.skyBox) {
      scene.skyBox.show = false
    }
    if (scene.sun) {
      scene.sun.show = false
    }
    // scene.moon 可能不存在（规则 5），跳过。
    if (scene.moon) {
      scene.moon.show = false
    }
    // 9. 关闭地平线雾（大气透视由我们的 stage 负责）。
    scene.fog.enabled = false
    // 10-11. 关闭 globe 自带地面大气与光照（后者同时丢掉 Cesium 地形阴影，文档明示）。
    if (globe) {
      globe.showGroundAtmosphere = false
      globe.enableLighting = false
    }
    // 12. 固定清屏色（天空由大气 stage 全屏覆盖）。
    scene.backgroundColor = BLACK
  }

  let restored = false
  return {
    get applied() {
      return opts.enabled && !restored
    },

    restore() {
      // 幂等：第二次调用是 no-op（规则：restore 重复调用不重复写回/请求渲染）。
      if (restored) return
      restored = true

      // 规则 1：无条件按快照写回，不做值相等/归属判定。
      // 1-4. scene 级
      scene.logarithmicDepthBuffer = state.logarithmicDepthBuffer
      scene.highDynamicRange = state.highDynamicRange
      scene.requestRenderMode = state.requestRenderMode
      scene.backgroundColor = state.backgroundColor

      // 5-9. 对象级：写捕获时的对象（规则 2）
      if (state.skyAtmosphere && state.skyAtmosphereShow !== undefined) {
        state.skyAtmosphere.show = state.skyAtmosphereShow
      }
      if (state.skyBox && state.skyBoxShow !== undefined) {
        state.skyBox.show = state.skyBoxShow
      }
      if (state.sun && state.sunShow !== undefined) {
        state.sun.show = state.sunShow
      }
      if (state.moon && state.moonShow !== undefined) {
        state.moon.show = state.moonShow
      }
      if (state.fog) {
        state.fog.enabled = state.fogEnabled
      }

      // 10-12. globe 级：写捕获时的 globe 对象（规则 2）——宿主替换后的新 globe
      // 保持自己的值，不会被写回旧值。
      if (state.globe) {
        state.globe.depthTestAgainstTerrain = state.depthTestAgainstTerrain
        state.globe.showGroundAtmosphere = state.showGroundAtmosphere
        state.globe.enableLighting = state.enableLighting
      }

      // 规则 4：requestRenderMode 恢复为 true 时补一帧（否则引擎不再自动渲染，
      // 画面可能停留在安装期间的最后一帧）。Cesium 销毁后 requestRender 是抛错版本，
      // 必须先 isDestroyed() 守卫。
      if (state.requestRenderMode && !scene.isDestroyed()) {
        scene.requestRender()
      }
    }
  }
}
