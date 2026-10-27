// 产品入口（spec §8）：只做导出与 HMR 清理，不含逻辑。
//
// 公共 API 面 = 主入口函数 + 错误类型 + VERSION + 可命名的嵌套选项类型；
// installWithDeps（测试注入）与 disposeAllForHmr（HMR 钩子）不对外导出。
import { disposeAllForHmr } from './install'

export { installAtmosphereClouds, isInstalled, InstallCancelledError } from './install'
export type {
  InstallOptions,
  AtmosphereCloudsHandle,
  AtmosphereCloudsTarget,
  AtmosphereStageOptions,
  CloudsStageOptions,
  CloudsQualityPreset
} from './install'
export { VERSION } from './version'

// 只用到的 `import.meta.hot` 子集：避免为一行钩子引入 vite/client 全局类型。
interface HotContext {
  dispose(callback: () => void): void
}

// Vite/vitest 下 `import.meta.hot` 可能不存在（vitest 普通 run 下为 undefined）：
// 可选判断保证非 Vite 环境（Node / 消费者打包产物）是 no-op。
// 本模块被 HMR 替换时销毁全部已安装 handle 并恢复被包装的 destroy（spec §8.2）。
const hot = (import.meta as ImportMeta & { readonly hot?: HotContext }).hot
if (hot != null) {
  hot.dispose(() => disposeAllForHmr())
}
