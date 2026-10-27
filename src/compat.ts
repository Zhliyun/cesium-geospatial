// Cesium 版本与能力自检（spec §8.3）。
//
// 纯函数：不 import 任何 Cesium 模块、不读全局、无副作用。Cesium 侧的探测
// （VERSION / Texture3D 构造器 / scene.context.webgl2 / fragmentDepth / depthTexture /
// scene.globe / scene.mode）由 install 层收集成 CompatInput 传入，这样本模块可在
// Node 里全量单测；是否把 errors 升级为异常由调用方决定（本函数从不抛错）。

/** 自检输入：全部由调用方从 Cesium 运行时探测后填入。 */
export interface CompatInput {
  /** `Cesium.VERSION`。 */
  version: string
  /** `Cesium.Texture3D` 构造器是否存在（3D 散射 LUT 必需）。 */
  hasTexture3D: boolean
  /** `scene.context.webgl2 === true`。 */
  webgl2: boolean
  /** `scene.context.fragmentDepth`：后处理能否写/读片元深度。 */
  fragmentDepth: boolean
  /** `scene.context.depthTexture`：深度纹理可用性。 */
  depthTexture: boolean
  /** `scene.globe` 是否存在（大气 stage 强制 `depthTestAgainstTerrain`）。 */
  hasGlobe: boolean
  /** `scene.mode` 当前值。 */
  mode: number
  /** `SceneMode.SCENE3D` 的值（由调用方传入，避免本模块 import Cesium）。 */
  scene3dMode: number
}

/** 自检结果：`ok` 与 `errors.length === 0` 等价；warning 不影响 `ok`。 */
export interface CompatResult {
  ok: boolean
  warnings: string[]
  errors: string[]
}

/** 已验证的 Cesium 版本表（spec §8.3；升版验收后在此追加）。 */
export const TESTED_CESIUM_VERSIONS: readonly string[] = Object.freeze(['1.143.0'])

/**
 * 检查 Cesium 版本与渲染能力是否满足要求。
 *
 * - 版本不在已验证表：`warnings`（不失败）。
 * - `Texture3D` 缺失、非 WebGL2、`fragmentDepth`/`depthTexture` 不可用、无 globe、
 *   非 SCENE3D：`errors`。每条错误消息都带当前版本与已验证版本表，便于用户直接上报。
 *
 * @param input Cesium 运行时探测结果
 * @param testedVersions 已验证版本表，缺省 {@link TESTED_CESIUM_VERSIONS}
 */
export function checkCompat(
  input: CompatInput,
  testedVersions: readonly string[] = TESTED_CESIUM_VERSIONS
): CompatResult {
  const warnings: string[] = []
  const errors: string[] = []
  const tested = testedVersions.join(', ')
  const tail = `（当前版本 ${input.version}，已验证版本：${tested}）`

  if (!testedVersions.includes(input.version)) {
    warnings.push(
      `Cesium 版本 ${input.version} 不在已验证版本表（${tested}）内，可能出现未预期的渲染差异`
    )
  }

  if (!input.hasTexture3D) {
    errors.push(`Cesium ${input.version} 缺少 Texture3D 构造器（3D 散射 LUT 必需）${tail}`)
  }
  if (!input.webgl2) {
    errors.push(`Cesium ${input.version} 运行环境不是 WebGL2（scene.context.webgl2 非 true）${tail}`)
  }
  if (!input.fragmentDepth) {
    errors.push(`Cesium ${input.version} 不支持 fragmentDepth（后处理无法读回片元深度）${tail}`)
  }
  if (!input.depthTexture) {
    errors.push(`Cesium ${input.version} 的 depthTexture 不可用（大气与云后处理必需）${tail}`)
  }
  if (!input.hasGlobe) {
    errors.push(
      `Cesium ${input.version} 场景没有 globe（大气 stage 依赖 globe.depthTestAgainstTerrain）${tail}`
    )
  }
  if (input.mode !== input.scene3dMode) {
    errors.push(
      `Cesium ${input.version} 当前场景不是 3D/SCENE3D（mode=${input.mode}，SCENE3D=${input.scene3dMode}），` +
        `本库仅支持 3D 模式${tail}`
    )
  }

  return { ok: errors.length === 0, warnings, errors }
}
