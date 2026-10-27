#!/usr/bin/env node
// 资产复制与构建一致性校验。纯 Node ESM：不得 import dist 或任何构建产物
// （CLI 在消费方未构建、或本包尚未 build 时都要能运行）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashSources } from './lib/hash.mjs'

// 包根：以本文件位置解析，不依赖 process.cwd()，保证在 submodule / file: 副本里同样可用
const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

// 三类运行期资产：来源固定为 <包根>/assets/<kind>，复制到 <out>/<kind>（文件名原样保留）
const ASSET_KINDS = ['luts', 'clouds', 'moon']

const USAGE = `用法:
  cesium-geospatial copy-assets --out <dir>
      复制 assets/{${ASSET_KINDS.join(',')}} 到 <dir>（建议 public/cesium-geospatial-assets）

  cesium-geospatial check --root <dir> [--copy <dir>]
      重算 <dir> 的源码哈希并与 <dir>/dist/build-stamp.json 比对；
      给了 --copy 时再要求 <copy>/dist/build-stamp.json 的 sourceHash 与 <root> 一致。
      任一不一致以退出码 1 结束。`

/** 参数用法错误：打印用法并退出码 1 */
class UsageError extends Error {}

/**
 * 解析 `--flag value` 形式参数，并校验只出现允许的 flag。
 * @param {string[]} argv 子命令之后的参数
 * @param {string[]} allowed 允许的 flag 名（不含 `--`）
 * @returns {Record<string, string>}
 */
function parseFlags(argv, allowed) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new UsageError(`未知参数：${arg}`)
    const name = arg.slice(2)
    if (!allowed.includes(name)) throw new UsageError(`未知参数：${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`参数 ${arg} 缺少取值`)
    if (flags[name] !== undefined) throw new UsageError(`参数 ${arg} 重复`)
    flags[name] = value
    i++
  }
  return flags
}

/**
 * 复制三类资产到 outDir，逐个覆盖（消费方 predev/prebuild 反复调用是安全的）。
 * @param {string} outDir 目标目录（不存在则创建）
 */
function copyAssets(outDir) {
  mkdirSync(outDir, { recursive: true })
  let fileCount = 0
  for (const kind of ASSET_KINDS) {
    const src = join(pkgRoot, 'assets', kind)
    if (!existsSync(src)) throw new Error(`缺少资产目录：${src}`)
    cpSync(src, join(outDir, kind), { recursive: true })
    fileCount += readdirSync(src).length
  }
  console.log(`[copy-assets] 完成：${ASSET_KINDS.length} 个目录 / ${fileCount} 个文件 → ${outDir}`)
}

/**
 * 读取并解析目录里的构建戳。
 * @param {string} dir 包目录
 * @returns {{ sourceHash: string }}
 */
function readStamp(dir) {
  const stampPath = join(dir, 'dist', 'build-stamp.json')
  if (!existsSync(stampPath)) {
    throw new Error(`缺少构建戳 ${stampPath}：请先在该目录执行构建（构建成功后必须能看到该文件）`)
  }
  let stamp
  try {
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
  } catch {
    throw new Error(`构建戳不是合法 JSON：${stampPath}`)
  }
  if (typeof stamp.sourceHash !== 'string') {
    throw new Error(`构建戳缺少 sourceHash 字段：${stampPath}`)
  }
  return stamp
}

/**
 * 校验 root 的构建戳未过期；给了 copyDir 时再校验副本与 root 来自同一份源码。
 * @param {{ root?: string, copy?: string }} flags
 * @returns {number} 退出码
 */
function checkBuild(flags) {
  if (flags.root === undefined) throw new UsageError('check 缺少 --root <dir>')
  const rootStamp = readStamp(flags.root)
  const actualHash = hashSources(flags.root)
  if (actualHash !== rootStamp.sourceHash) {
    console.error(`[check] 失败：${flags.root} 的源码已变更但未重新构建`)
    console.error(`  戳内 sourceHash = ${rootStamp.sourceHash}`)
    console.error(`  实际 sourceHash = ${actualHash}`)
    console.error('  修复：重新运行构建（pnpm run build），再重新 copy-assets')
    return 1
  }

  if (flags.copy !== undefined) {
    const copyStamp = readStamp(flags.copy)
    if (copyStamp.sourceHash !== rootStamp.sourceHash) {
      console.error(`[check] 失败：副本 ${flags.copy} 与根 ${flags.root} 的构建不一致（副本陈旧）`)
      console.error(`  根   sourceHash = ${rootStamp.sourceHash}`)
      console.error(`  副本 sourceHash = ${copyStamp.sourceHash}`)
      console.error('  修复：重新 copy-assets 覆盖副本')
      return 1
    }
  }

  console.log(`[check] 通过：${flags.root}（sourceHash=${rootStamp.sourceHash}）`)
  return 0
}

/**
 * CLI 入口。
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {number} 退出码
 */
function main(argv) {
  const [command, ...rest] = argv
  if (command === 'copy-assets') {
    const flags = parseFlags(rest, ['out'])
    if (flags.out === undefined) throw new UsageError('copy-assets 缺少 --out <dir>')
    copyAssets(flags.out)
    return 0
  }
  if (command === 'check') {
    return checkBuild(parseFlags(rest, ['root', 'copy']))
  }
  throw new UsageError(command === undefined ? '缺少子命令' : `未知子命令：${command}`)
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  console.error(`[cesium-geospatial] ${err instanceof Error ? err.message : String(err)}`)
  if (err instanceof UsageError) console.error(`\n${USAGE}`)
  process.exitCode = 1
}
