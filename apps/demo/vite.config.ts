import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// 资产已迁到包根 assets/（产品分发源）。demo 仍用原 URL（/luts、/clouds、/atmosphere），
// 由 viteStaticCopy 从包根拷到站点根目录，保证消费方与 demo 的资产路径一致。
// 必须用绝对路径：相对路径会以 apps/demo 为 cwd 做 glob，实测匹配为空并抛
// “No file was found to copy”。moon 用 *.webp 且 dest=atmosphere，避免生成 /atmosphere/moon/…
const assetsDir = fileURLToPath(new URL('../../assets/', import.meta.url))

// Cesium 静态资源（Workers/Assets/ThirdParty/Widgets）由 viteStaticCopy 服务到 /cesium/。
// index.html 设 window.CESIUM_BASE_URL='/cesium/'。viteStaticCopy 2.x 在 dev/build 均服务。
export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'node_modules/cesium/Build/Cesium/Workers', dest: 'cesium' },
        { src: 'node_modules/cesium/Build/Cesium/Assets', dest: 'cesium' },
        { src: 'node_modules/cesium/Build/Cesium/ThirdParty', dest: 'cesium' },
        { src: 'node_modules/cesium/Build/Cesium/Widgets', dest: 'cesium' },
        { src: `${assetsDir}luts`, dest: '.' },
        { src: `${assetsDir}clouds`, dest: '.' },
        { src: `${assetsDir}moon/*.webp`, dest: 'atmosphere' }
      ]
    })
  ],
  server: {
    fs: { allow: ['..'] }
  }
})
