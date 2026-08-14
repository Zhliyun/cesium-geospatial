import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', globals: true },
  // clouds shader 三种扩展名（?raw 显式导入时 assetsInclude 不影响 raw 行为，
  // 此处列出仅为无 ?raw 时的资产语义清晰，与 core 一致）
  assetsInclude: ['**/*.glsl', '**/*.frag', '**/*.vert']
})
