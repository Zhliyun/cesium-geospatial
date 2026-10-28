import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// IIFE/UMD 构建目标：给没有 ESM 注入机制的宿主（如 Playwright 注入 window.Cesium 的远端渲染节点）。
// - external cesium → 全局 `Cesium`（避免页面里同时存在 UMD 全局与 ESM 两份 Cesium）
// - 单入口 + inlineDynamicImports：IIFE 不支持代码分割
// - 产物挂到 window.CesiumGeospatial，入口是 installAtmosphereClouds 等公共导出
export default defineConfig({
  resolve: {
    alias: {
      '@cesium-geospatial/core': resolve(__dirname, 'packages/cesium-core/src/index.ts'),
      '@cesium-geospatial/clouds': resolve(__dirname, 'packages/cesium-clouds/src/index.ts')
    }
  },
  build: {
    outDir: 'dist-iife',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      name: 'CesiumGeospatial',
      formats: ['iife'],
      fileName: () => 'cesium-geospatial.iife.js'
    },
    rollupOptions: {
      external: ['cesium'],
      output: {
        globals: { cesium: 'Cesium' },
        inlineDynamicImports: true,
        exports: 'named'
      }
    }
  }
})
