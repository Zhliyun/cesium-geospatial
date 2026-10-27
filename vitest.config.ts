import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

// 只跑根包自己的用例：不设 include 会扫到 packages/** 的全量用例，
// 既缺 clouds 的 assetsInclude 又与外层 workspace 测试重复。
export default defineConfig({
  resolve: {
    alias: {
      '@cesium-geospatial/core': `${root}packages/cesium-core/src/index.ts`,
      '@cesium-geospatial/clouds': `${root}packages/cesium-clouds/src/index.ts`
    }
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    // 骨架阶段还没有用例；没有它 vitest run 会以“No test files found”退出 1，
    // 导致 package.json 的 test/verify 脚本不可用（Task 2 起有用例）
    passWithNoTests: true
  }
})
