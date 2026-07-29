import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Cesium 静态资源（Workers/Assets/ThirdParty/Widgets）由 viteStaticCopy 服务到 /cesium/。
// index.html 设 window.CESIUM_BASE_URL='/cesium/'。viteStaticCopy 2.x 在 dev/build 均服务。
export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'node_modules/cesium/Build/Cesium/Workers', dest: 'cesium' },
        { src: 'node_modules/cesium/Build/Cesium/Assets', dest: 'cesium' },
        { src: 'node_modules/cesium/Build/Cesium/ThirdParty', dest: 'cesium' },
        { src: 'node_modules/cesium/Build/Cesium/Widgets', dest: 'cesium' }
      ]
    })
  ],
  server: {
    fs: { allow: ['..'] }
  }
})
