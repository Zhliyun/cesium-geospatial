// 消费方视角的 d.ts 断言：在临时目录用 strict + moduleResolution: bundler、
// 且 skipLibCheck: false（默认）编译一段 import 三个入口的代码。
// 目的：证明 dist/*.d.ts 里的 Cesium 私有类型（Context/Texture3D/...）可由
// dist/cesium-augment.d.ts 解析，而不是靠 skipLibCheck 掩盖 TS2305。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const tscBin = join(rootDir, 'node_modules/typescript/bin/tsc')
const distDir = join(rootDir, 'dist').split(sep).join('/')

const tempDir = mkdtempSync(join(tmpdir(), 'cg-consumer-types-'))

const tsconfig = {
  compilerOptions: {
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: []
  },
  include: ['check.ts']
}

const checkTs = `import { VERSION } from '${distDir}/index'
import { createAtmosphereStage, type AtmosphereLUTs, type AtmosphereStageOptions } from '${distDir}/core'
import { createCloudsStage, type CloudsStageOptions, type WeatherTextures } from '${distDir}/clouds'

declare const luts: AtmosphereLUTs
declare const atmosphereOptions: AtmosphereStageOptions
declare const weather: WeatherTextures
declare const cloudsOptions: CloudsStageOptions
const version: string = VERSION

void createAtmosphereStage
void createCloudsStage
void luts
void atmosphereOptions
void weather
void cloudsOptions
void version
`

try {
  writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))
  writeFileSync(join(tempDir, 'check.ts'), checkTs)

  try {
    execFileSync(process.execPath, [tscBin, '-p', join(tempDir, 'tsconfig.json')], {
      cwd: tempDir,
      encoding: 'utf8',
      stdio: 'pipe'
    })
  } catch (error) {
    process.stderr.write(error.stdout ?? '')
    process.stderr.write(error.stderr ?? '')
    console.error('[assert-consumer-types] 消费方 tsc 失败（strict + skipLibCheck:false）')
    process.exit(1)
  }
  console.log('[assert-consumer-types] OK：消费方 tsc（strict, skipLibCheck:false）0 错误')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
