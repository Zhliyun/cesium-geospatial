import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Cesium 运行时静态资源（Workers/Assets/ThirdParty/Widgets）由 viteStaticCopy 服务到
// /cesium/（dev 与 build 都生效），index.html 里的 window.CESIUM_BASE_URL 与之对应。
// src 相对本示例根目录解析：node_modules/cesium 就是本示例自己安装的那份（与示例目录
// 内的 node_modules 布局绑定，不依赖仓库其他位置）。
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
  ]
})
