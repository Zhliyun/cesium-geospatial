// GLSL 离线编译共享 helper——本文件自 core/src/cesium/glslangUtil.ts 逐字拷贝
// （T7 不碰 core：core 未 export compileFragment，且 T8 并行改 core 避免冲突），
// 仅补 vertex stage 支持（clouds 有 4 个 .vert entry shader 需要 -S vert 编译）。
// 后续若 core 把 compileShader export 出来，clouds 可删本拷贝改 import（记入 T7 报告）。
//
// 选型：devDep `glslang-validator-prebuilt-predownloaded@0.0.2`。
// 原因：
// 1) 离线友好——npm tarball 已预下载 darwin/linux/win32 二进制（无 postinstall
//    网络下载），CI 不依赖外网；
// 2) 真编译——比 @shaderfrog/glsl-parser 仅做语法解析强，能抓类型/重载错误；
// 3) 版本 11.7.0 支持 ESSL 3.20（覆盖本 shader 的 #version 300 es）。
//
// 平台注意：包只发布了 x86_64 二进制；Apple Silicon (arm64) macOS 通过系统
// 自带的 Rosetta 2 透明执行 x86_64 二进制（已实测可用）。getGlslangValidatorPath
// 不使用包内 index.js（其 os.arch()!=='x64' 会误抛），而是直接拼二进制路径，
// 并在二进制丢失可执行位（npm 解包常发生）时补 chmod 0o755。
// 若环境既无 Rosetta 又无系统 glslangValidator，测试以清晰错误信息失败而非
// 哑过。

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'

// 平台 → 包内二进制后缀（与 glslang-validator-prebuilt-predownloaded/bin/ 一致）。
const PLATFORM_SUFFIX: Record<string, string> = {
  darwin: '.darwin',
  linux: '.linux',
  win32: '.exe'
}

// 解析 glslangValidator 可执行文件路径。
// 优先级：1) 系统 PATH 中的 glslangValidator（用户自装，e.g. brew install glslang）；
//         2) npm 包预下载二进制（透明支持 arm64 macOS via Rosetta）。
// 包内 index.js 的 getPath() 在 os.arch()!=='x64' 时误抛，故此处直接拼路径。
function getGlslangValidatorPath(): string {
  // 1) 系统安装（跨架构最稳）
  const system = whichSystem('glslangValidator')
  if (system) return system

  // 2) npm 预下载二进制
  const suffix = PLATFORM_SUFFIX[os.platform()]
  if (!suffix) {
    throw new Error(
      `[glslang] 不支持的平台 ${os.platform()}：请 brew install glslang 或手动提供 glslangValidator`
    )
  }
  const require = createRequire(import.meta.url)
  const pkgRoot = path.dirname(
    require.resolve(
      'glslang-validator-prebuilt-predownloaded/package.json'
    )
  )
  const binPath = path.join(pkgRoot, 'bin', `glslangValidator${suffix}`)
  if (!existsSync(binPath)) {
    throw new Error(
      `[glslang] 包内未找到二进制 ${binPath}；平台=${os.platform()} arch=${os.arch()}。` +
        'Apple Silicon 需 Rosetta 2；Linux arm64 需系统安装 glslangValidator。'
    )
  }
  // npm 解包常丢失可执行位——补上（幂等）。
  try {
    chmodSync(binPath, 0o755)
  } catch {
    // 只读挂载等场景忽略；执行时会以更清晰错误暴露。
  }
  return binPath
}

// 轻量 `which`：避开 child_process 同步 execFileSync 的额外开销与 shell 解析。
function whichSystem(cmd: string): string | undefined {
  const PATH = process.env.PATH ?? ''
  const ext = os.platform() === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue
    for (const e of ext) {
      const p = path.join(dir, cmd + e)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

// 跑一次 glslangValidator 编译，返回 { ok, stderr }。
// --stdin -S <stage>：从 stdin 读源码，按指定 stage 解析；#version 300 es
// 自动激活 ESSL profile。stage: 'frag' | 'vert'。
export function compileShader(
  src: string,
  stage: 'frag' | 'vert'
): { ok: boolean; output: string } {
  const bin = getGlslangValidatorPath()
  let output = ''
  let ok = false
  try {
    output = execFileSync(bin, ['--stdin', '-S', stage], {
      input: src,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8'
    }) as string
    ok = true
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string | Buffer
      stderr?: string | Buffer
      status?: number
    }
    output = [err.stdout, err.stderr].map(b => (b ? b.toString() : '')).join('\n')
    ok = false
  }
  return { ok, output }
}

// fragment 便捷封装（与 core glslangUtil.compileFragment 行为一致）。
export function compileFragment(src: string): { ok: boolean; output: string } {
  return compileShader(src, 'frag')
}

// vertex 便捷封装（clouds 新增：clouds.vert 等 4 个 .vert entry 编译用）。
export function compileVertex(src: string): { ok: boolean; output: string } {
  return compileShader(src, 'vert')
}
