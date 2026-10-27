// 源码哈希：纯 Node ESM，不得 import dist 或任何构建产物（CLI 在未构建时也要能跑）
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIR = '__snapshots__'
const SKIP_FILE = /\.test\.(ts|tsx)$/

/**
 * 遍历目录，收集 `{ 相对路径（posix 分隔符）, 绝对路径 }`。
 * 相对路径以 rootDir 为基准，保证不同机器/工作树下哈希一致。
 */
function collectFiles(absDir, rootDir, files) {
  for (const dirent of readdirSync(absDir, { withFileTypes: true })) {
    const absPath = join(absDir, dirent.name)
    if (dirent.isDirectory()) {
      if (dirent.name === SKIP_DIR) continue
      collectFiles(absPath, rootDir, files)
      continue
    }
    if (!dirent.isFile()) continue
    if (SKIP_FILE.test(dirent.name)) continue
    // 用 path.relative 而不是 slice：调用方传入的 rootDir 可能带尾斜杠
    const relPath = relative(rootDir, absPath).split('\\').join('/')
    files.push({ relPath, absPath })
  }
}

/**
 * 计算源码哈希：`src/**` 与 `packages/*\/src/**`，跳过测试与快照，
 * 按相对路径排序后对 `路径\0内容` 逐项喂给 sha256。
 *
 * @param {string} rootDir 仓库根目录绝对路径
 * @returns {string} 64 位十六进制摘要
 */
export function hashSources(rootDir) {
  // 归一化尾斜杠，保证同一目录的不同写法得到同一哈希
  rootDir = rootDir.replace(/[\\/]+$/, '')
  const srcDir = join(rootDir, 'src')
  if (!existsSync(srcDir)) {
    throw new Error(`hashSources: 缺少源码目录 ${srcDir}`)
  }

  const files = []
  collectFiles(srcDir, rootDir, files)

  const packagesDir = join(rootDir, 'packages')
  if (existsSync(packagesDir)) {
    for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const pkgSrcDir = join(packagesDir, dirent.name, 'src')
      if (!existsSync(pkgSrcDir)) continue
      collectFiles(pkgSrcDir, rootDir, files)
    }
  }

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  const hash = createHash('sha256')
  for (const { relPath, absPath } of files) {
    hash.update(relPath)
    hash.update('\0')
    hash.update(readFileSync(absPath))
  }
  return hash.digest('hex')
}
