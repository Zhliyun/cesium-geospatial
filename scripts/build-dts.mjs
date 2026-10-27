// 生成三个入口的扁平 d.ts。
//
// 为什么不用 vite-plugin-dts 的 bundleTypes：它用 availableParallelism() 并发跑
// api-extractor，多个入口同时 bundle 时会互相破坏（报 Unable to follow symbol for
// "const"，任意两个入口同跑必现、单入口正常）。这里改为顺序调用 api-extractor。
//
// 步骤：
// 1. 内部包各自 tsc --emitDeclarationOnly → packages/*/dist/index.d.ts
// 2. 根入口 tsc -p tsconfig.dts.json（paths 指向内部包 dist）→ 临时目录
// 3. api-extractor 逐入口把 @cesium-geospatial/* 的类型内联进 dist/<entry>.d.ts
// 4. 复制 Cesium 私有类型 augment 到 dist/，并在三个入口顶部加 triple-slash 引用
//    （否则消费方 skipLibCheck:false 时 Context/Texture3D 等报 TS2305）
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const tscBin = join(rootDir, 'node_modules/typescript/bin/tsc')
// 中间声明不能放 node_modules 下：api-extractor 会把其中的文件当外部包，
// 只留 `import { VERSION } from './version'` 而不内联。放 dist 内（vite build 之后跑）。
const tempTypesDir = join(rootDir, 'dist/.types')

const INTERNAL_PACKAGES = ['cesium-core', 'cesium-clouds']
const ENTRY_NAMES = ['index', 'core', 'clouds']

const AUGMENT_SOURCE = join(
  rootDir,
  'packages/cesium-core/src/cesium/cesium-augment.d.ts'
)
const AUGMENT_FILENAME = 'cesium-augment.d.ts'
const AUGMENT_REFERENCE = `/// <reference path="./${AUGMENT_FILENAME}" />\n`

function runTsc(args) {
  execFileSync(process.execPath, [tscBin, ...args], { cwd: rootDir, stdio: 'inherit' })
}

// 1. 内部包声明（根 package.json 的 d.ts 会以此为准，避免指向 packages/*/src）
for (const pkg of INTERNAL_PACKAGES) {
  rmSync(join(rootDir, 'packages', pkg, 'dist'), { recursive: true, force: true })
  runTsc(['-p', join(rootDir, 'packages', pkg, 'tsconfig.json'), '--emitDeclarationOnly'])
}

// 2. 根入口未打包声明（core/clouds 只是 `export * from '@cesium-geospatial/core'`）
rmSync(tempTypesDir, { recursive: true, force: true })
runTsc([
  '-p',
  join(rootDir, 'tsconfig.dts.json'),
  '--noEmit',
  'false',
  '--emitDeclarationOnly',
  '--outDir',
  tempTypesDir
])

// 3. 逐入口 bundle（顺序执行，绝不并发）
const { Extractor, ExtractorConfig } = await import('@microsoft/api-extractor')

function bundleEntry(name) {
  const entryPath = join(tempTypesDir, 'src', `${name}.d.ts`)
  if (!existsSync(entryPath)) {
    throw new Error(`[build-dts] 缺少中间声明 ${entryPath}`)
  }

  const configObject = {
    projectFolder: rootDir,
    mainEntryPointFilePath: entryPath,
    compiler: { tsconfigFilePath: join(rootDir, 'tsconfig.dts.json') },
    apiReport: { enabled: false },
    docModel: { enabled: false },
    dtsRollup: {
      enabled: true,
      // 用 untrimmed：库没有 release tag，publicTrimmed 依赖 @public 标注
      untrimmedFilePath: join(rootDir, 'dist', `${name}.d.ts`)
    },
    tsdocMetadata: { enabled: false },
    messages: {
      compilerMessageReporting: { default: { logLevel: 'none' } },
      extractorMessageReporting: { default: { logLevel: 'none' } }
    }
  }

  const config = ExtractorConfig.prepare({
    configObject,
    configObjectFullPath: join(rootDir, 'api-extractor.json'),
    packageJsonFullPath: join(rootDir, 'package.json')
  })
  const result = Extractor.invoke(config, {
    localBuild: true,
    showVerboseMessages: false,
    showDiagnostics: false
  })
  if (!result.succeeded) {
    throw new Error(
      `[build-dts] api-extractor 处理 ${name}.d.ts 失败（错误 ${result.errorCount} 条）`
    )
  }
}

try {
  for (const name of ENTRY_NAMES) bundleEntry(name)

  // Cesium 私有类型（Context/Texture3D/...）靠本地 module augment 补齐；
  // 消费方需要它也在 dist 里，并由入口声明显式引用。
  copyFileSync(AUGMENT_SOURCE, join(rootDir, 'dist', AUGMENT_FILENAME))
  for (const name of ENTRY_NAMES) {
    const dtsPath = join(rootDir, 'dist', `${name}.d.ts`)
    const content = readFileSync(dtsPath, 'utf8')
    if (!content.startsWith(AUGMENT_REFERENCE)) {
      writeFileSync(dtsPath, AUGMENT_REFERENCE + content)
    }
  }
} finally {
  rmSync(tempTypesDir, { recursive: true, force: true })
}

console.log(
  `[build-dts] OK：dist/index.d.ts、dist/core.d.ts、dist/clouds.d.ts、dist/${AUGMENT_FILENAME}`
)
