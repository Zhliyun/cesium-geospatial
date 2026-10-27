// Cesium 版本与能力自检（spec §8.3）。
//
// 纯函数：不 import 任何 Cesium 模块、不读全局、无副作用。Cesium 侧的探测
// （VERSION / Texture3D 构造器 / scene.context.webgl2 / fragmentDepth / depthTexture /
// scene.globe / scene.mode）由 install 层收集成 CompatInput 传入，这样本模块可在
// Node 里全量单测；是否把 errors 升级为异常由调用方决定（本函数从不抛错）。
//
// 版本判定分三档：超出 peer 范围（error）→ 范围内但未验证（warn）→ 已验证（静默）。

/** peer 依赖版本范围（主/次版本粒度；patch 不参与比较）。 */
export interface PeerRange {
  minMajor: number
  minMinor: number
  maxMajor: number
}

/** 自检输入：全部由调用方从 Cesium 运行时探测后填入。 */
export interface CompatInput {
  /** `Cesium.VERSION`。 */
  version: string
  /** peer 范围，缺省 `>=1.143.0 <2.0.0`（即 `{ minMajor: 1, minMinor: 143, maxMajor: 2 }`）。 */
  peerRange?: PeerRange
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

/** 缺省 peer 范围 `>=1.143.0 <2.0.0`（与根包 package.json 的 peerDependencies 一致）。 */
const DEFAULT_PEER_RANGE: PeerRange = Object.freeze({
  minMajor: 1,
  minMinor: 143,
  maxMajor: 2
})

/**
 * 解析版本号的主/次版本；无法解析（非 `major.minor…` 形式）返回 null。
 * patch 不参与 peer 范围比较。
 */
function parseVersion(version: string): { major: number; minor: number } | null {
  const m = /^(\d+)\.(\d+)/.exec(version)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

/**
 * 检查 Cesium 版本与渲染能力是否满足要求。
 *
 * - 版本超出 peer 范围：`errors`（消息含当前版本与范围 `>=1.143.0 <2.0.0`）。
 * - 在范围内但不在已验证表：`warnings`（不失败）。
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

  // peer 范围：低于下界或 major 达到上界即硬失败（版本号不可解析时无法比较，
  // 交由下面的「未验证版本」warning 兜底，不在此误报）。
  const range = input.peerRange ?? DEFAULT_PEER_RANGE
  const rangeText = `>=${range.minMajor}.${range.minMinor}.0 <${range.maxMajor}.0.0`
  const parsed = parseVersion(input.version)
  const outOfRange =
    parsed != null &&
    (parsed.major < range.minMajor ||
      (parsed.major === range.minMajor && parsed.minor < range.minMinor) ||
      parsed.major >= range.maxMajor)
  if (outOfRange) {
    errors.push(`Cesium ${input.version} 超出 peer 依赖范围（要求 ${rangeText}）${tail}`)
  }

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
