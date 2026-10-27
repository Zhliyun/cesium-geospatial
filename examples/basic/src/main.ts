// 最小接入示例：一个 Cesium Viewer + 一行 installAtmosphereClouds。
// 示例只演示产品入口，不碰任何 stage 顺序 / LUT / 云插入点细节。
import { Viewer } from 'cesium'
import { installAtmosphereClouds } from 'cesium-geospatial'

// 示例不携带 ion token：baseLayer: false 不加载底图，baseLayerPicker/geocoder 也关掉
// （两者会在启动时请求 ion 列表，无 token 时控制台报 401）；剩余默认部件对最小示例没用，一并关闭。
// 裸 globe 同样能看到大气与体积云。
const viewer = new Viewer('cesiumContainer', {
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false
})

// 顶层 await 需要 es2022 以上的构建目标，而 Vite 缺省 target 更低（chrome87/es2020）；
// 用 async 函数包一层，示例在缺省配置下也能构建。
async function main(): Promise<void> {
  // 资产（luts 4 + clouds 4 + moon 2，共 10 个文件）由 predev/prebuild 的 copy-assets
  // 拷到 public/cesium-geospatial-assets/；install 缺省相对 document.baseURI 解析该目录。
  // 场景接管（对数深度/关天空盒/天空大气等）由 install 内部完成。
  const handle = await installAtmosphereClouds(viewer, { quality: 'high' })

  // 释放由 handle 内部排序（云 → 宿主 stage → 大气 → 纹理）；幂等。
  window.addEventListener('beforeunload', () => handle.destroy())
}

void main().catch((err: unknown) => {
  console.error('[basic example] 安装大气/云失败：', err)
})
