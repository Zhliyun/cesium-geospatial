# 体积云质量档位（quality presets）设计

- 日期：2026-08-29
- 状态：v1（待三专家评审）
- 范围：`@cesium-geospatial/clouds` 库 + demo 接入
- 主参考：`three-geospatial/packages/clouds/src/qualityPresets.ts`（值逐字对齐源）

## 1. 背景与目标

体积云（phase3 M1-M6）当前只有单一质量配置：所有 march/BSM 参数取 `defaultCloudsParameters()` 缺省值（= three-geospatial qualityPresets 的 **high 档**逐字移植，代码注释多处预留「M6 qualityPresets 用」）。低配设备跑不动、也没有快捷的画质-性能台阶供 demo/验收/将来产品化选用。

目标：给 `createCloudsStage` 增加静态四档质量预设（low/medium/high/ultra）+ 句柄 `setQuality()` 换档，档位值与参考库逐字对齐，`high` 档 ≡ 现状缺省（零回归）。

## 2. 决策记录（用户已拍板）

| # | 决策 | 备选及放弃理由 |
|---|---|---|
| D1 | **静态四档预设**，显式选档（option + demo URL） | 帧率自适应升降档：复杂度高（性能采样+迟滞+热切），后续独立迭代 |
| D2 | `setQuality()` **统一内部重建**（销毁→重编译→重建资源→换实现引用），句柄稳定 | diff 分级热切：参考库档位表下相邻档全跨编译开关/结构参数，纯 uniform 热切路径几乎不可达，白付 diff 逻辑 |
| D3 | **temporalUpscale 不纳入档位** | 它有已知静止抖动问题（2026-08-17 验收未过、等 STBN 世界域索引裁决）；塞进 low 档 = low 档自带缺陷 |
| D4 | 档位值**逐字对齐参考库** qualityPresets.ts | 自行调参：脱离主参考库，对齐成本反噬 |

换档代价说明：跨档必触及 shader `#define` 裁剪（编译开关）或 mapSize/cascadeCount（纹理重建），统一重建有一帧 shader 编译卡顿（数百 ms）。换档不频繁，可接受。

## 3. 档位表（唯一事实源，逐字对齐参考库）

参考库四档中相邻档位的编译开关矩阵（✓开 ✗关）：

| 编译开关 | low | medium | high | ultra |
|---|---|---|---|---|
| lightShafts（god rays） | ✗ | ✗ | ✓ | ✓ |
| shapeDetail | ✗ | ✓ | ✓ | ✓ |
| turbulence | ✗ | ✗ | ✓ | ✓ |
| accurateSunSkyLight | ✗ | ✗ | ✓ | ✓ |

| uniform 参数（主 march） | low | medium | high | ultra |
|---|---|---|---|---|
| maxIterationCount | 200 | 500 | 500 | 500 |
| minStepSize | 100 | 50 | 50 | **10** |
| maxStepSize | 1000 | 1000 | 1000 | 1000 |
| maxRayDistance | 1e5 | 2e5 | 2e5 | 2e5 |
| perspectiveStepScale | 1.01 | 1.01 | 1.01 | 1.01 |
| minDensity | 1e-4 | 1e-4 | 1e-5 | 1e-5 |
| minExtinction | 1e-4 | 1e-4 | 1e-5 | 1e-5 |
| minTransmittance | 1e-1 | 1e-2 | 1e-2 | 1e-2 |

| uniform 参数（次 march） | low | medium | high | ultra |
|---|---|---|---|---|
| maxIterationCountToSun | 1 | 2 | 2 | 2 |
| maxIterationCountToGround | 0 | 1 | 3 | 3 |
| minSecondaryStepSize | 100 | 100 | 100 | 100 |
| secondaryStepScale | 2 | 2 | 2 | 2 |

| uniform 参数（shadowLength march，lightShafts=true 时生效） | 四档同值 |
|---|---|
| maxShadowLengthIterationCount / minShadowLengthStepSize / maxShadowLengthRayDistance | 500 / 50 / 2e5 |

| BSM 结构 + 生成端 march | low | medium | high | ultra |
|---|---|---|---|---|
| cascadeCount | **2** | 3 | 3 | 3 |
| mapSize | **256** | **256** | 512 | **1024** |
| shadowMarch.maxIterationCount | 25 | 50 | 50 | 50 |
| shadowMarch.minStepSize / maxStepSize | 100 / 1000 | 100 / 1000 | 100 / 1000 | 100 / 1000 |
| shadowMarch.minDensity / minExtinction | 1e-4 / 1e-4 | 1e-4 / 1e-4 | 1e-5 / 1e-5 | 1e-5 / 1e-5 |
| shadowMarch.minTransmittance | 1e-2 | 1e-4 | 1e-4 | 1e-4 |
| shadowMarch.opticalDepthTailScale | 2 | 2 | 2 | 2 |

参考库明确**不做**、我们同样不做：multi-scattering octaves 降档（参考库 TODO：会丢失高频散射整体变暗、需补偿系数，未解决）。

## 4. 数据结构

新文件 `packages/cesium-clouds/src/qualityPresets.ts`：

```ts
export type CloudsQualityPreset = 'low' | 'medium' | 'high' | 'ultra'

/** 单档解析后的三路配置（编译开关 / uniform / BSM 结构）。 */
export interface ResolvedCloudsQuality {
  /** CloudsMainOptions 编译开关子集。 */
  main: {
    lightShafts: boolean
    shapeDetail: boolean
    turbulence: boolean
    accurateSunSkyLight: boolean
  }
  /** CloudsParameters uniform 覆盖子集（仅 §3 表中列出的字段）。 */
  params: Partial<Pick<CloudsParameters,
    | 'maxIterationCount' | 'minStepSize' | 'maxStepSize' | 'maxRayDistance'
    | 'perspectiveStepScale' | 'minDensity' | 'minExtinction' | 'minTransmittance'
    | 'maxIterationCountToSun' | 'maxIterationCountToGround'
    | 'minSecondaryStepSize' | 'secondaryStepScale'
    | 'maxShadowLengthIterationCount' | 'minShadowLengthStepSize'
    | 'maxShadowLengthRayDistance' | 'shadowCascadeCount' | 'shadowTexelSize'>>
  /** BSM 结构 + 生成端 march。 */
  shadow: {
    cascadeCount: number
    mapSize: number
    march: CloudsShadowMarchParameters
  }
}

export const cloudsQualityPresets: Record<CloudsQualityPreset, ResolvedCloudsQuality>
```

要点：
- **单一来源规则**：档位源是 `shadow.cascadeCount`/`shadow.mapSize`；`applyQualityPreset` 把它们投影到 `params.shadowCascadeCount`（消费端 shader 数组长度，uniformMap 沿用现状读取点）与 `params.shadowTexelSize = 1/mapSize`——避免同值双源漂移。
- 不设 `accuratePhaseFunction`/`haze`/`resolutionScale` 字段（未移植的能力，不造假接口）。
- `high` 档的 params 数值必须与 `defaultCloudsParameters()` 对应字段**全等**（快照测试机器证明，见 §9）。

## 5. 合并语义

`CloudsStageOptions` 新增 `quality?: CloudsQualityPreset`（缺省 `'high'`）。

覆盖顺序（低 → 高）：
1. 现状缺省（`defaultCloudsParameters()` / `CloudsMainOptions.DEFAULTS`）
2. 档位值（`cloudsQualityPresets[quality]` 三路展开）
3. 用户显式传参（`options.parameters` 同名字段浅覆盖；`CloudsMainOptions` 显式字段覆盖）

即「档位是基线、显式微调优先」。实现为一个纯函数 `applyQualityPreset(quality, options)` 供创建与 setQuality 复用。

## 6. cascadeCount 参数化（low 档 2 级联前置）

- `CloudsMainOptions` 新增 `shadowCascadeCount?: number`（默认 3）；`CloudsMaterial.ts` 的 `CLOUDS_MAIN_DEFINES` 硬编码 `'#define SHADOW_CASCADE_COUNT 3'` 改为按它生成。
- shader 侧无需改动：`clouds.frag` 数组声明 `uniform mat4 shadowMatrices[SHADOW_CASCADE_COUNT]` 与 cascade 选择的 `#if SHADOW_CASCADE_COUNT > 1/2/3` 条件编译**已天然兼容任意级联数**（核查于 2026-08-29，clouds.frag:75-76/263-275）。
- world 锚定联动：`cascadeCount=2` 时 `WORLD_RADII_DEFAULT` 取前 2、`worldIntervals` 取前 3（[0,10,21]km，SHADOW_FAR_LIMIT 联动远端上界仍取末段值）；frustum 模式本就按 cascadeCount 切分。
- `createCloudsStage.ts` 现状 `mapSize = 512` 硬编码（:259）改为读 `resolved.shadow.mapSize`。
- 消费端 uniformMap `shadowMatrices`/`shadowIntervals` 数组长度按 cascadeCount 生成（现状 `params.shadowCascadeCount` 已是单一来源，沿用它）。

## 7. setQuality 内部重建

- `createCloudsStage` 内部装配逻辑提取为 `buildImpl(resolvedOptions)`（CloudsPass + overlay stage + CascadedShadowMaps + ShadowPass + preRender 绑定），返回 impl 对象。
- `CloudsStageHandle` 对外形状不变：公开字段改为 getter 委托内部 `impl` 引用（`cloudsPass`/`overlayStage`/`shadowPass`/`shadowState`/`cascades`/`destroy`），对外仍只读语义。
- `handle.setQuality(next: CloudsQualityPreset): void`：
  1. `next === 当前档` → no-op（浅比较）。
  2. 以「创建时用户显式 options + 新 quality」重新 resolve（保留微调）。
  3. 销毁 impl：CloudsPass.destroy + overlay stage destroy + ShadowPass destroy（均已有幂等实现）；preRender listener **不重挂**（闭包读 `handle.impl`，换引用即生效）。
  4. `buildImpl` 重建 → 换 `impl` 引用。
- overlay PostProcessStage destroy 旧的、add 新的到 `scene.postProcessStages` 末尾。**已知限制**：若消费者在 clouds 之后又 add 了别的 stage，重建会改变相对顺序（记录在 JSDoc，不处理——当前无此用法）。
- `scene` 销毁竞态：demo 不涉及（页面级生命周期），JSDoc 注明「scene.destroy 前须 handle.destroy」现状语义不变。

## 8. Demo 接入

- URL 参数 `?cloudsQuality=low|medium|high|ultra`（缺省 high）→ 创建时传 `quality`。
- 键盘快捷键 **1/2/3/4**（仅 clouds=1 时生效）→ `handle.setQuality('low'/'medium'/'high'/'ultra')`，console.log 提示当前档——setQuality 的运行时视觉验证入口。
- README 参数表补 `cloudsQuality` 一行 + 快捷键说明。

## 9. 测试计划（packages/cesium-clouds，vitest）

| 文件 | 用例 |
|---|---|
| `qualityPresets.test.ts`（新） | ① 四档全字段与参考库值逐字对齐（硬编码期望值快照）；② high 档 params/shadow 与 `defaultCloudsParameters()` 对应字段全等（零回归机器证明）；③ `shadowTexelSize = 1/mapSize` 联动 |
| `createCloudsStage.test.ts`（增） | ① `quality` 缺省 high = 不传时行为 bit 级一致；② low 档：CascadedShadowMaps cascadeCount=2、mapSize=256、worldRadii/intervals 截断；③ 用户显式 `parameters.maxIterationCount` 覆盖 low 档 200；④ `setQuality`：同档 no-op、换档断言销毁+重建调用序、换档后 shader define 含 `SHADOW_CASCADE_COUNT 2` |
| `cloudsMain.compile.test.ts`（增） | glslang 编译四档实际 define 组合（含 `SHADOW_CASCADE_COUNT 2` + lightShafts/shapeDetail/turbulence/accurate 全关组合） |
| `CloudsMaterial.test.ts`（增） | `shadowCascadeCount` define 生成正确（默认 3 / 传 2） |

## 10. 验收（人工 + agent-browser）

1. **四档视觉对比**：基准云海 URL（`mode=atmosphere&clouds=1`，README 推荐视角）`cloudsQuality` 四值各截图，降质逐档可辨、无灾难 artifact（low 档无 god rays/细节修饰属预期，云本体不破）。
2. **帧率单调**：`?fps=1` 下四档帧时间 low ≤ medium ≤ high ≤ ultra。
3. **热切换健壮性**：基准 URL 连按 1→4→2→3→1 多轮，无崩溃、无 WebGL 报错；切档后帧率与对应档 URL 直开一致（无资源泄漏）。

## 11. 风险与实现前验证点

| 风险 | 验证方式 | 不可用时的退路 |
|---|---|---|
| `accurateSunSkyLight=false` 分支（vGroundIrradiance/vCloudsIrradiance varying 路径）在移植版 clouds.frag 中是否完整接线 | 实现 Task 1 先跑 glslang 编译（accurate 关）+ demo 视觉冒烟 | low/medium 该开关保持 `true`，性能缺口由主 march 步数再降补（如 low 档 maxIterationCount 200→150），spec 附注偏差 |
| `SHADOW_CASCADE_COUNT=2` 的 unroll/数组在 resolve pass、velocity 层等处的隐性假设 | §9 glslang 组合编译 + demo low 档 `cloudsShadowAnchor=world` 冒烟 | cascadeCount 不降档（low 也用 3），仅 mapSize 256——性能损失小、记偏差 |
| ultra 档 mapSize 1024 的 Texture3D 内存（1024²×(cascadeCount+velocity层)×RGBA16F） | demo ultra 档跑通 + 内存目测 | 维持 512 并记录（参考库 ultra 的 1024 需求主要面向桌面独显） |

## 12. 不做的事（YAGNI）

- 帧率自适应升降档。
- temporalUpscale 纳入档位（等 STBN 世界域索引裁决后另议）。
- multi-scattering octaves 降档（参考库 TODO 未解决）。
- uniform 运行时分支替代 `#define` 裁剪（偏离参考库结构、损失裁剪收益）。
- setQuality 返回 Promise/帧同步语义（重建同步完成，当前无需求）。

## 13. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/cesium-clouds/src/qualityPresets.ts` | 新建（档位表 + applyQualityPreset） |
| `packages/cesium-clouds/src/CloudsMaterial.ts` | `shadowCascadeCount` define 参数化 |
| `packages/cesium-clouds/src/createCloudsStage.ts` | `quality` 选项、buildImpl 提取、setQuality、mapSize 去硬编码 |
| `packages/cesium-clouds/src/index.ts` | 导出 `CloudsQualityPreset`/`cloudsQualityPresets` |
| `packages/cesium-clouds/src/qualityPresets.test.ts` | 新建 |
| `packages/cesium-clouds/src/createCloudsStage.test.ts` | 增补 |
| `packages/cesium-clouds/src/cloudsMain.compile.test.ts` | 增补 |
| `packages/cesium-clouds/src/CloudsMaterial.test.ts` | 增补（若该文件存在；否则并入 compile.test） |
| `apps/demo/src/main.ts` | `cloudsQuality` URL 参数 + 1/2/3/4 快捷键 |
| `README.md` | 参数表补一行 |
