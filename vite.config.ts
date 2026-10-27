import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// package.json 是 type: module，ESM 配置里没有 __dirname，用 import.meta.url 换算
const root = fileURLToPath(new URL('.', import.meta.url))

const alias = {
  '@cesium-geospatial/core': resolve(root, 'packages/cesium-core/src/index.ts'),
  '@cesium-geospatial/clouds': resolve(root, 'packages/cesium-clouds/src/index.ts')
}

// d.ts 由 scripts/build-dts.mjs 顺序生成（见该文件头注释：vite-plugin-dts 多入口
// bundleTypes 会并发跑 api-extractor 而互相破坏）
export default defineConfig({
  resolve: { alias },
  build: {
    lib: {
      entry: { index: 'src/index.ts', core: 'src/core.ts', clouds: 'src/clouds.ts' },
      formats: ['es']
    },
    rollupOptions: {
      external: ['cesium'],
      output: { entryFileNames: '[name].js' }
    }
  }
})
