import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 包根：src/cli.test.ts 的上一级即仓库根（产品包根）
const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'bin/cli.mjs')
// 测试里不 import hash.mjs（它是 .mjs，tsc 会找不到声明），改用子进程调用真实实现
const hashModuleUrl = new URL('../bin/lib/hash.mjs', import.meta.url).href

let out: string
const extraDirs: string[] = []
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'cg-assets-'))
})
afterEach(() => {
  rmSync(out, { recursive: true, force: true })
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 子进程跑 CLI，返回退出码与输出（失败用例需要拿退出码，execFileSync 会抛错） */
function runCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
}

/** 用真实的 hashSources 计算目录源码哈希（与 CLI/盖章脚本同一实现） */
function hashOf(dir: string): string {
  const code = `import(${JSON.stringify(hashModuleUrl)}).then((m) => process.stdout.write(m.hashSources(${JSON.stringify(dir)})))`
  return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }).trim()
}

/** 造一个「已构建」的假包根：src 有源码，dist 有与源码自洽的 build-stamp.json */
function makeBuiltRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-root-'))
  extraDirs.push(dir)
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(
    join(dir, 'dist', 'build-stamp.json'),
    JSON.stringify({
      version: '0.1.0',
      sourceHash: hashOf(dir),
      entries: ['index.js'],
      builtAt: '2026-10-27T00:00:00.000Z'
    })
  )
  return dir
}

describe('cli copy-assets', () => {
  it('复制三类资产并保持固定文件名与字节数', () => {
    execFileSync(process.execPath, [join(root, 'bin/cli.mjs'), 'copy-assets', '--out', out])
    expect(statSync(join(out, 'luts/transmittance.bin')).size).toBe(131072)
    expect(statSync(join(out, 'luts/scattering.bin')).size).toBe(8388608)
    expect(existsSync(join(out, 'clouds/shape.bin'))).toBe(true)
    expect(existsSync(join(out, 'moon/moon-surface.webp'))).toBe(true)
  })

  it('三类资产的文件名集合与字节数逐一一致', () => {
    execFileSync(process.execPath, [cli, 'copy-assets', '--out', out])
    for (const kind of ['luts', 'clouds', 'moon']) {
      const names = readdirSync(join(root, 'assets', kind)).sort()
      expect(readdirSync(join(out, kind)).sort()).toEqual(names)
      for (const name of names) {
        expect(statSync(join(out, kind, name)).size).toBe(statSync(join(root, 'assets', kind, name)).size)
      }
    }
  })

  it('缺少 --out 时退出码 1 并打印用法', () => {
    const r = runCli(['copy-assets'])
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('copy-assets --out')
  })
})

describe('cli 参数解析', () => {
  it('缺子命令时退出码 1 并打印用法', () => {
    const r = runCli([])
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('用法')
  })

  it('未知子命令时退出码 1 并打印用法', () => {
    const r = runCli(['frobnicate'])
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('用法')
  })

  it('未知参数时退出码 1', () => {
    const r = runCli(['copy-assets', '--out', out, '--bogus', 'x'])
    expect(r.status).toBe(1)
  })
})

describe('cli check', () => {
  it('构建戳与源码一致时退出码 0', () => {
    const dir = makeBuiltRoot()
    const r = runCli(['check', '--root', dir])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[check] 通过')
  })

  it('源码变更但未重新构建时退出码 1', () => {
    const dir = makeBuiltRoot()
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 2\n')
    const r = runCli(['check', '--root', dir])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('重新构建')
  })

  it('副本构建戳与根不一致时退出码 1', () => {
    const dir = makeBuiltRoot()
    const copy = makeBuiltRoot()
    writeFileSync(join(copy, 'src', 'index.ts'), 'export const a = 3\n')
    // 重新给副本盖章：副本自洽但来自不同源码 → 与根不一致
    const stampPath = join(copy, 'dist', 'build-stamp.json')
    writeFileSync(stampPath, JSON.stringify({ version: '0.1.0', sourceHash: hashOf(copy), entries: [], builtAt: 'x' }))
    const r = runCli(['check', '--root', dir, '--copy', copy])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('副本')
  })

  it('缺少 build-stamp.json 时退出码 1 并提示构建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-root-'))
    extraDirs.push(dir)
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
    const r = runCli(['check', '--root', dir])
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('build-stamp.json')
  })

  it('缺少 --root 时退出码 1 并打印用法', () => {
    const r = runCli(['check'])
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('check --root')
  })
})
