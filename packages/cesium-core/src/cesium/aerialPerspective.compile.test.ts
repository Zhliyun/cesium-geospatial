// Task 8：GLSL 真编译验证（评审 critical）。
//
// 单测只做字符串展开抓不到编译期错误（未声明标识符、类型不匹配、precision、
// 括号不匹配、宏组合残留调用点等）。本文件对 spec §4.2 全部合法宏组合调
// buildStandaloneShaderForValidation 生成完整 GLSL，喂给真实 glslangValidator
// （ESSL 3.20，等价 WebGL2 的 GLSL ES 3.00 编译器）做编译，断言退出码 0。
//
// 选型：devDep `glslang-validator-prebuilt-predownloaded@0.0.2`（brief Step 1）。
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

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'

import {
  buildStandaloneShaderForValidation,
  type AerialPerspectiveFragOptions
} from './aerialPerspective.frag'

// spec §4.2 合法宏组合枚举——A 路径 / B 路径 / 仅透射 / 仅内散射。
// options 形状与 brief 一致（未列字段走 buildAerialPerspectiveFragmentShader
// 的默认 true，覆盖宏裁剪与 uniform 接线的真实组合空间）。
const COMBOS: Array<[string, AerialPerspectiveFragOptions]> = [
  ['默认（SKY+SUN 全开）', {}],
  ['无日盘（SUN 关，SKY 开）', { sun: false }],
  ['无天空分支（SKY+SUN 关，远平面直通）', { sun: false, sky: false }]
]

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
// --stdin -S frag：从 stdin 读源码，按 fragment shader 解析；#version 300 es
// 自动激活 ESSL profile。
function compileFragment(src: string): { ok: boolean; output: string } {
  const bin = getGlslangValidatorPath()
  let output = ''
  let ok = false
  try {
    output = execFileSync(bin, ['--stdin', '-S', 'frag'], {
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

describe('GLSL 编译验证（glslangValidator，全合法宏组合）', () => {
  // 用 it.each 而非手写循环，保证失败时 vite 报告单个 combo 名。
  for (const [name, opts] of COMBOS) {
    it(`编译通过：${name}`, () => {
      const src = buildStandaloneShaderForValidation(opts)
      // 前置断言：输入确实是 #version 300 es 独立 shader（防 T5 回归）。
      expect(src.startsWith('#version 300 es')).toBe(true)

      const { ok, output } = compileFragment(src)
      if (!ok) {
        // 失败时把 glslang 全部 stderr 落到断言消息，便于定位行号。
        throw new Error(
          `glslangValidator 编译失败（${name}）:\n${output}\n` +
            `---- shader 前 40 行（行号 1-based）----\n${src
              .split('\n')
              .slice(0, 40)
              .map((l, i) => `${i + 1}: ${l}`)
              .join('\n')}`
        )
      }
      expect(ok).toBe(true)
    })
  }

  it('glslangValidator 真的会抓编译错误（防回归：测试本身不能哑过）', () => {
    // 注入未声明标识符，验证 glslang 非哑过——若这个测试失败说明编译器没在干活。
    const broken = `#version 300 es
precision highp float;
out vec4 out_FragColor;
void main() { out_FragColor = vec4(thisIdentifierDoesNotExist); }`
    const { ok, output } = compileFragment(broken)
    expect(ok).toBe(false)
    expect(output).toContain('ERROR')
  })
})
