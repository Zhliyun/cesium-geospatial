// weatherBake.frag 独立组装器——`#version` 头 + precision + #include 解析。
//
// 消费方（必须共用本函数，防两处组装漂移）：
//  - weatherBake.compile.test.ts（glslangValidator 离线编译验证）
//  - Task 5 WeatherAtlas 烘焙 pass（运行时真烘焙）
//
// include 解析复用 clouds 包统一管线 resolveCloudsIncludes（core resolveIncludes
// + 尖括号 compat + unrollLoops），嵌套索引树由调用方传入（默认 glslIndex）。

import { glslIndex } from './glslIndex'
import { resolveCloudsIncludes } from './resolveCloudsIncludes'

export function buildStandaloneWeatherBakeShader(
  index: typeof glslIndex = glslIndex
): string {
  // 烘焙 shader 是独立 entry（含 in varying vUv + MRT loc0 out），不经
  // CloudsMaterial 桥接手术——include 解析后直接可喂 glslangValidator 与运行时 pass。
  return `#version 300 es\nprecision highp float;\n${resolveCloudsIncludes(index.weatherBakeFrag, index)}`
}
