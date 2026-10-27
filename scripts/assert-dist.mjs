// 产物断言：入口文件齐全、d.ts 非空声明、build-stamp 可解析
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(rootDir, 'dist')

const ENTRY_ARTIFACTS = [
  'index.js',
  'core.js',
  'clouds.js',
  'index.d.ts',
  'core.d.ts',
  'clouds.d.ts'
]

const errors = []

for (const name of ENTRY_ARTIFACTS) {
  if (!existsSync(join(distDir, name))) errors.push(`缺少产物 dist/${name}`)
}

// 空声明 `export {}` 也满足“有导出”，必须查实际符号
const indexDts = join(distDir, 'index.d.ts')
if (existsSync(indexDts) && !readFileSync(indexDts, 'utf8').includes('VERSION')) {
  errors.push('dist/index.d.ts 不含 VERSION（疑似空声明 export {}）')
}

const stampPath = join(distDir, 'build-stamp.json')
if (!existsSync(stampPath)) {
  errors.push('缺少 dist/build-stamp.json')
} else {
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    if (!Array.isArray(stamp.entries) || stamp.entries.length !== 6) {
      errors.push(`build-stamp.json 的 entries 应为长度 6 的数组，实际 ${JSON.stringify(stamp.entries)}`)
    }
  } catch (error) {
    errors.push(`build-stamp.json 解析失败：${error.message}`)
  }
}

if (errors.length > 0) {
  for (const message of errors) console.error(`[assert-dist] ${message}`)
  process.exit(1)
}

console.log('[assert-dist] OK：六个产物齐全，d.ts 含 VERSION，build-stamp 有效')
