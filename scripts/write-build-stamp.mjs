// 构建盖章：六个产物齐全才写 dist/build-stamp.json（原子写入）
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashSources } from '../bin/lib/hash.mjs'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(rootDir, 'dist')

// 三入口 JS + 各自 d.ts
const ENTRY_ARTIFACTS = [
  'index.js',
  'core.js',
  'clouds.js',
  'index.d.ts',
  'core.d.ts',
  'clouds.d.ts'
]

const missing = ENTRY_ARTIFACTS.filter((name) => !existsSync(join(distDir, name)))
if (missing.length > 0) {
  console.error(`[write-build-stamp] 产物缺失，拒绝盖章：${missing.join(', ')}`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
const stamp = {
  version,
  sourceHash: hashSources(rootDir),
  entries: ENTRY_ARTIFACTS,
  builtAt: new Date().toISOString()
}

const stampPath = join(distDir, 'build-stamp.json')
const tmpPath = `${stampPath}.tmp`
writeFileSync(tmpPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
renameSync(tmpPath, stampPath)
console.log(`[write-build-stamp] ${stampPath}`)
