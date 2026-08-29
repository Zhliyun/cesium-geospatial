# 体积云质量档位（quality presets）设计

- 日期：2026-08-29
- 状态：v3（三专家复审通过框架：A/B v1 findings 全 RESOLVED、C 10/12 RESOLVED——复审新发现 7 条 MINOR/NIT 已全部裁决采纳）
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
| D5（v2 新增） | `accurateSunSkyLight=false` 路径**作为正式移植任务纳入**（见 §11.1），不再是退路 | 评审实证：移植版该分支 varying 被无条件零填充，现状不可用；它是参考库低配最大省耗开关（march 循环内 per-sample 直算 → per-pixel 一次预计算），不移植则 low/medium 档名不副实 |

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

| uniform 参数（shadowLength march） | 四档同值 |
|---|---|
| maxShadowLengthIterationCount / minShadowLengthStepSize / maxShadowLengthRayDistance | 500 / 50 / 2e5 |

> 表注：shadowLength 三项仅在 lightShafts=true 档（high/ultra）编译生效；low/medium 档该 march 整体裁剪，值不消费。

| BSM 结构 + 生成端 march | low | medium | high | ultra |
|---|---|---|---|---|
| cascadeCount | **2** | 3 | 3 | 3 |
| mapSize | **256** | **256** | 512 | **1024** |
| shadowMarch.maxIterationCount | 25 | 50 | 50 | 50 |
| shadowMarch.minStepSize / maxStepSize | 100 / 1000 | 100 / 1000 | 100 / 1000 | 100 / 1000 |
| shadowMarch.minDensity / minExtinction | 1e-4 / 1e-4 | 1e-4 / 1e-4 | 1e-5 / 1e-5 | 1e-5 / 1e-5 |
| shadowMarch.minTransmittance | 1e-2 | 1e-4 | 1e-4 | 1e-4 |
| shadowMarch.opticalDepthTailScale | 2 | 2 | 2 | 2 |

> 表注：`opticalDepthTailScale` 来源是参考库 `ShadowMaterial.ts:104` 的 `new Uniform(2)`（经 CloudsEffect 桥接消费）——**本仓库自有恒定量、非档位变量**，与现状 `defaultCloudsParameters().shadowMarch` 一致；qualityPresets.ts 中无此字段，勿去该文件找。

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
    | 'maxShadowLengthRayDistance' | 'shadowCascadeCount'>>
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
- **单一来源规则**：档位源是 `shadow.cascadeCount`/`shadow.mapSize`；`applyQualityPreset` 把 `shadow.cascadeCount` 投影到 `params.shadowCascadeCount`（消费点 = shader define `SHADOW_CASCADE_COUNT` 与 JS 结构 CascadedShadowMaps/ShadowPass——非 uniformMap 条目）。**不投影 `shadowTexelSize`**——其真消费点是 frame state（`state.shadow?.texelSize ?? params.shadowTexelSize`，CloudsPass.ts:454），params 侧保持现状 dummy (1,1) 不动，texel 尺寸单源于 frame state。
- 不设 `accuratePhaseFunction`/`haze`/`resolutionScale` 字段（未移植的能力，不造假接口）。
- `high` 档的 params/shadow 数值必须与 `defaultCloudsParameters()` 对应字段**全等**（`shadowCascadeCount` 恰好相等可不排除；快照测试机器证明，见 §9）。
- 档位表 fallback dummy（`shadowIntervals`/`shadowMatrices`）由 `applyQualityPreset` 按 cascadeCount 截断（防 cascadeCount=2 + cloudsShadow=0 诊断基线下给 define 2 的数组传 3 元素）。

## 5. 合并语义

`CloudsStageOptions` 新增 `quality?: CloudsQualityPreset`（缺省 `'high'`）。

覆盖顺序（低 → 高）：
1. 现状缺省（`defaultCloudsParameters()` / `CloudsMainOptions.DEFAULTS`）
2. 档位值（`cloudsQualityPresets[quality]` 三路展开）
3. 用户显式传参（见下方合并规则）

合并规则（v2 明确，v3 收紧）：
- **`parameters` 类型落点（v3 定死）**：`CloudsStageOptions = Omit<CloudsPassOptions, 'parameters'> & { parameters?: Partial<CloudsParameters> }`——Partial 仅是入口类型；`CloudsPassOptions.parameters` 保持全量契约不变（`createCloudsPass` 的 `?? defaultCloudsParameters()` 整体替换语义不动，`createCloudsStage` 在 resolve 层产出全量对象后下传），CloudsPass.ts **零改动**。
- **字段级浅合并**：档位 params 与用户 parameters 逐字段以用户为准（`!== undefined`）。
- **`shadowCascadeCount` 例外（v3 裁决）**：quality 在场时用户显式 `shadowCascadeCount` **忽略 + console.warn**——结构侧（CascadedShadowMaps/ShadowPass/worldIntervals 截断）单源于 `preset.shadow.cascadeCount`，若允许用户覆盖 define 侧会造成 define/结构双源漂移（§4 单一来源规则要防的正是此）。仅 `quality` 未传（=high 缺省路径也显式传了）时用户值生效。
- **嵌套对象 `shadowMarch` 仅支持整对象覆盖**（不做字段级深合并）：用户要改其一个字段须提供全部 7 字段，JSDoc 写明。
- `CloudsMainOptions` 其余显式字段（shapeDetail/turbulence/lightShafts/accurateSunSkyLight）覆盖档位同名字段。
- **clone 规则**：`applyQualityPreset` 的合并产物必须 deep-clone（用户对象与档位常量都不回写、不共享引用）——现状 preRender 逐帧改写 params（frame++、reprojection 覆写），沿用共享引用会把旧帧状态带进新档、双 stage 互踩。
- 与参考库 setter 语义**有意不同**：参考库 `qualityPreset` setter 是 Object.assign 直接覆盖实例（档位 > 用户微调、微调丢失）；我们选择「用户显式 > 档位」，§7 setQuality 换档时保留用户显式参数。

## 6. cascadeCount 参数化（low 档 2 级联前置）

- `CloudsMainOptions` 新增 `shadowCascadeCount?: number`（默认 3）；`CloudsMaterial.ts` 的 `CLOUDS_MAIN_DEFINES` 硬编码 `'#define SHADOW_CASCADE_COUNT 3'`（:119）改为按它生成。
- **`ShadowMaterial.ts` 同步参数化（v2 新增，评审 BLOCKER）**：`SHADOW_DEFINES_BASE` 的 `'#define CASCADE_COUNT 3'`（:58）现状硬编码、`ShadowMainOptions`（:35-49）无对应选项。cascadeCount=2 时 shadow.frag 的 `inverseShadowMatrices[CASCADE_COUNT]` 声明与 uniformMap 供元数不一致 → 生成端 BSM 直接坏。`ShadowMainOptions` 增 `cascadeCount`（或 ShadowPass 从选项透传进 define），§9 补 shadowMain 编译组合。
- shader 侧（clouds.frag）无需改动：`uniform mat4 shadowMatrices[SHADOW_CASCADE_COUNT]` 数组声明与 cascade 选择的 `#if SHADOW_CASCADE_COUNT > 1/2/3` 条件编译已天然兼容任意级联数（clouds.frag:75-76/263-275，双专家核查为真）；cascadedShadowMaps.glsl 消费端 unroll 同样 COUNT 无关。
- world 锚定联动（cascadeCount=2）：
  - `WORLD_RADII_DEFAULT` 取前 2 = [16, 33.6]km；`worldIntervals` 取前 3 = [0,10,21]km。
  - **不变式（v2 写死，评审 MAJOR）**：world 模式 `shadowState.far ≡ worldIntervals[cascadeCount]`（截断后末段；cascadeCount=2 即 21km）。现状 `far = min(maxRayDistance, SHADOW_FAR_LIMIT) = 60km` 与 3 级联 intervals 末段 60km 相等纯属设计值巧合；两处归一化域分叉（生成端 updateWorld 按 intervals[cascadeCount] 归一化，消费端 getFadedCascadeIndex 按 shadowState.far 归一化）会导致级联选择整体错位。**该分支废除 SHADOW_FAR_LIMIT 的独立参与**（far 赋值点改与 `cascades.far` 同源）。frustum 模式语义不变。
  - 自阴影覆盖随档缩水属预期降级：low 档 BSM 覆盖 0-21km（21km 外云无自阴影），§10 验收明示。
- `createCloudsStage.ts` 现状 `mapSize = 512` 硬编码（:259）改为读 `resolved.shadow.mapSize`。
- **ShadowPass shaderOptions 消费点（v2 点名，评审 MINOR）**：`options.shapeDetail ?? true`（:352-355）等必须改读 resolved 后的值——否则 low 档（preset shapeDetail=false、用户未传）会给生成端 true，密度分支与主 march 错位 → 阴影与云形错位。buildImpl(resolvedOptions) 结构天然覆盖，实现时以此消费点为验收锚。

## 7. setQuality 内部重建

- **buildImpl 产出（v2 明确）**：`buildImpl(resolvedOptions, scene)` 返回 impl 对象 = { onPreRender 函数, cloudsPass, overlayStage, cascades, shadowPass?, resolvePass?, shadowTurbulenceDummy?, shadowState, params, destroy() }。**buildImpl 不挂 listener**——preRender listener 由 createCloudsStage 顶层挂一次，每帧逻辑经 `handle.impl` 间接调用 impl.onPreRender。
- **listener 零直捕约束（v2 写死，评审 MAJOR）**：顶层 listener 体内**零直捕局部量、一切经 impl 取**（现状直捕约 15 个局部量：params/state/shadowPass/cascades/resolvePass/options/temporal/matricesFrozen/prevCamera…）。任何漏网直捕会静默驱动已销毁 impl（frame 计数分叉、矩阵停更）。per-impl 可复位状态（`matricesFrozen`/`prevCamera`/`prevMatrices`）随 impl 重建自然归零——`?cloudsShadowFreeze=1` + 换档后 freeze 语义重新从新 impl 起算。
- **完整销毁清单（v2 修正，评审 MAJOR）**：impl.destroy 复用 handle.destroy 的完整清单——CloudsPass + overlay PostProcessStage + **CloudsResolvePass（temporal=true 时；其 primitive 挂 scene.primitives、持 resolveTex/historyTex、每帧读 cloudsPass MRT 纹理——漏销毁会持续采样已删纹理 → WebGL 报错刷屏）** + ShadowPass + **shadowTurbulenceDummy** + 摘除自身资源。preRender listener 顶层持有，impl 换引用即切换。
- `handle.setQuality(next: CloudsQualityPreset): void`：
  1. `next === 当前档` → no-op（浅比较）。`handle` 已 destroyed → no-op + console.warn（对齐 destroy 幂等的宽容风格；JSDoc 写明）。
  2. 以「创建时用户显式 options + 新 quality」重新 resolve（保留微调，§5 合并规则 + clone）。
  3. `impl.destroy()` → `buildImpl` 重建 → 换 `handle.impl` 引用。**原子性（v3）**：`buildImpl` 抛错（GL 资源创建失败等）时 catch → 置 `destroyed = true` → rethrow——旧 impl 已销毁、句柄半死不可自愈，作废是唯一安全语义（JSDoc 声明「重建失败即句柄作废，须重建 stage」）。
  4. overlay PostProcessStage destroy 旧的、add 新的到 `scene.postProcessStages` 末尾。**已知限制**：若消费者在 clouds 之后又 add 了别的 stage，重建会改变相对顺序（JSDoc 记录，不处理——当前无此用法）。
- **调用时机约束（JSDoc）**：仅帧间调用（事件回调外）。帧内（preUpdate/preRender 等渲染事件回调中）调用不安全——primitives.remove 发生在 commandList 已建后。demo keydown 在帧间，安全。
- `CloudsStageHandle` 对外形状不变：公开字段改为 getter 委托内部 `impl` 引用（`cloudsPass`/`overlayStage`/`shadowPass`/`shadowState`/`cascades`/`destroy`），对外仍只读语义。
- 重建期间 overlay shader 源不变可命中 Cesium ShaderCache；新 BSM 零初始化 + Beer=1 + overlay 读零纹理 α=0——切换首帧优雅降级无黑闪（评审核查为真）。

## 8. Demo 接入

- URL 参数 `?cloudsQuality=low|medium|high|ultra`（缺省 high）→ 创建时传 `quality`。
- 键盘快捷键 **1/2/3/4**（仅 clouds=1 时生效）→ `handle.setQuality('low'/'medium'/'high'/'ultra')`，console.log 提示当前档——setQuality 的运行时视觉验证入口。
- README 参数表补 `cloudsQuality` 一行 + 快捷键说明。

## 9. 测试计划（packages/cesium-clouds，vitest）

| 文件 | 用例 |
|---|---|
| `qualityPresets.test.ts`（新） | ① 四档全字段快照：期望值硬编码并**注释钉死参考源文件与行号**（three-geospatial qualityPresets.ts，参考库在另一 repo 不可 import，对齐本身靠本 spec §3 评审背书）；② high 档 params/shadow 与 `defaultCloudsParameters()` 对应字段全等（零回归机器证明；不含 shadowTexelSize——该字段不投影，见 §4）；③ `shadowCascadeCount` 投影 = shadow.cascadeCount；④ fallback dummy 按 cascadeCount 截断 |
| `createCloudsStage.test.ts`（增） | ① `quality` 缺省 high = 不传时装配传参与 shader 源逐字一致（零回归）；② low 档：cascadeCount=2、mapSize=256、worldRadii/intervals 截断、**shadowState.far = 21km（§6 不变式）**；③ 用户显式 `parameters.maxIterationCount` 覆盖 low 档 200（字段级合并）；④ `setQuality`：同档 no-op、destroyed 后 no-op+warn、换档断言**完整销毁清单**（含 resolvePass/shadowTurbulenceDummy，temporal=true 组合下）、换档后 shader define 含 `SHADOW_CASCADE_COUNT 2`、**旧 impl 全部 destroy 均被调且 listener 推动新 impl**（§7 零直捕约束）、换档后 params 无共享引用（clone 生效） |
| `cloudsMain.compile.test.ts`（增） | glslang 编译四档实际 define 组合（含 `SHADOW_CASCADE_COUNT 2` + lightShafts/shapeDetail/turbulence/accurate 全关组合） |
| `shadowMain.compile.test.ts`（增补用例，文件已存在，v3 校准） | shadow 生成端编译组合：`CASCADE_COUNT 2` × shapeDetail/turbulence 双关 × **temporalPass=true（velocity 层 `reprojectionMatrices[CASCADE_COUNT]` unroll 恰是 §11.2 风险 1 的隐性假设，v3 补维度）** |
| `CloudsMaterial.test.ts`（增） | `shadowCascadeCount` define 生成正确（默认 3 / 传 2） |

> 措辞校准（v2）：createCloudsStage.test.ts 为 mock 装配层（vi.mock CloudsPass/ShadowPass），断言粒度是「装配传参 + shader 源串」——不称「bit 级」。
> **退路同步修订机制（v2 预声明）**：§11 任何退路触发时，档位表（§3）与测试 ① 期望值**同源修订**（同一 commit 内 spec + 档位常量 + 测试期望三处同步），不留「附注偏差」的悬空状态。

## 10. 验收（人工 + agent-browser）

1. **四档视觉对比**：基准云海 URL（`mode=atmosphere&clouds=1`，README 推荐视角）`cloudsQuality` 四值各截图。项目已知低对比画面目测不可靠 → medium/high 追加 `?cloudsDebug=2`（frontDepth）/`?cloudsDebug=5`（cascades）debug 视图截图作客观佐证（minDensity=1e-4 砍薄云、mapSize=256 的 artifact 目测易漏）。low 档无 god rays/细节修饰、**自阴影覆盖仅 0-21km** 属预期降级，云本体不破。
2. **帧率台阶**（措辞校准：`?fps` 是 `debugShowFramesPerSecond` 显示帧率开关）：四档**帧时间 low ≤ medium ≤ high ≤ ultra（即显示 FPS low ≥ medium ≥ high ≥ ultra，v3 修正方向）**，**前提至少一档跌破 vsync 上限**（验收机 M 系列 + 高分辨率下 high/ultra 应跌破；若四档全 vsync 锁帧则判据无区分度，须放大负载重测）；换档瞬间出现 shader 编译长帧 = 档位真切换的旁证。
3. **热切换健壮性**：基准 URL 连按 1→4→2→3→1 多轮，无崩溃、无 WebGL 报错；**追加 `?cloudsTemporal=1` 组合轮次**（resolvePass 销毁重建路径）；切档后稳定帧率与对应档 URL 直开一致（**排除切换当帧**；无资源泄漏）。

## 11. 风险与任务

### 11.1 `accurateSunSkyLight=false` 接线移植（D5，正式任务）

评审实证（2026-08-29）：移植版桥接 `BRIDGE_VARYINGS_GLSL`（CloudsMaterial.ts:259-262）把 `vCloudsIrradiance.minSun/maxSun/minSky/maxSky` 四个 varying **无条件零填充**（原注释「ACCURATE define 下不被读」）——`accurateSunSkyLight=false` 分支（clouds.frag:442-449 `#else`）读到的 irradiance 恒 0 → **云全黑**。glslang 编译对此无检出力（变量已声明、编译必过）。

任务：把参考库 clouds.vert 的 `sampleSunSkyIrradiance`（shaders/clouds.vert:46-65，纯每调用解析计算、无顶点插值语义依赖，fragment 重建移植直接可行——评审核实）移植进 `cloudsBridge_reconstructVaryings`：**min/max 云高 2 次调用（每次返 sun+sky 双值 = 4 分量），预计算块须 `#ifndef ACCURATE_SUN_SKY_LIGHT` 条件编译**（high/ultra 档不编译，v3）——一次性成本，远廉于 per-sample 直算 GetSunAndSkyScalarIrradiance（后者在 march 循环体内逐采样调用，clouds.frag:535）。
**ground 2 分量暂不移植（v3 裁决）**：`vGroundIrradiance` 的全部 `#else` 读取路径（getGroundSunSkyIrradiance，clouds.frag:437/468）都在本仓库永不 `#define` 的 HAZE/GROUND_BOUNCE 分支内（复审三方核实为死代码）——完整移植 6 分量违背 YAGNI。**遗留注记**：未来若开启 GROUND_BOUNCE/HAZE，须同步补移植 ground 分量，否则云底 bounce 恒 0。
验收：low 档云照明正常 + `?cloudsDebug` 冒烟。

若实现复杂度显著超预期（v3 勘误：原「插值语义失真」顾虑不成立——参考实现是纯解析计算无插值依赖，退路仅剩复杂度维度）：降级为「low/medium 该开关保持 `true` 为既定决策」（spec §3 表 + §9① 期望值同源修订，见 §9 退路机制），low 档性能缺口由主 march 步数再降补。

### 11.2 其余风险

| 风险 | 验证方式 | 退路 |
|---|---|---|
| `SHADOW_CASCADE_COUNT=2` 的 unroll/数组在 resolve pass、velocity 层等处的隐性假设 | §9 glslang 组合编译 + demo low 档 `cloudsShadowAnchor=world` 冒烟（§6 不变式已把 far 域错位设计层面消除） | cascadeCount 不降档（low 也用 3），仅 mapSize 256——性能损失小、按 §9 退路机制同步修订 |
| ultra 档 mapSize 1024 内存：非 temporal BSM ≈ 25MB GPU（构造期另有 ≈50MB CPU 清零同步上传，一次性）；**temporal=true 时 ping-pong ≈ 100MB GPU** | demo ultra 档跑通 + 内存目测 | 维持 512 并按 §9 退路机制同步修订（参考库 ultra 的 1024 需求主要面向桌面独显） |

## 12. 不做的事（YAGNI）

- 帧率自适应升降档。
- temporalUpscale 纳入档位（等 STBN 世界域索引裁决后另议）。
- multi-scattering octaves 降档（参考库 TODO 未解决）。
- uniform 运行时分支替代 `#define` 裁剪（偏离参考库结构、损失裁剪收益）。
- setQuality 返回 Promise/帧同步语义（重建同步完成，当前无需求）。
- `shadowMarch` 字段级深合并（整对象覆盖语义已够用）。

## 13. 涉及文件

| 文件 | 动作 |
|---|---|
| `packages/cesium-clouds/src/qualityPresets.ts` | 新建（档位表 + applyQualityPreset） |
| `packages/cesium-clouds/src/CloudsMaterial.ts` | `shadowCascadeCount` define 参数化 + **accurate=false 分桥接线（§11.1，BRIDGE_VARYINGS_GLSL 移植 irradiance 预计算）** |
| `packages/cesium-clouds/src/ShadowMaterial.ts` | **`ShadowMainOptions.cascadeCount` 参数化（CASCADE_COUNT define，v2 新增）** |
| `packages/cesium-clouds/src/createCloudsStage.ts` | `quality` 选项、buildImpl 提取（零直捕 listener + 完整销毁清单）、setQuality、mapSize 去硬编码、**shadowState.far 不变式（§6）** |
| `packages/cesium-clouds/src/index.ts` | 导出 `CloudsQualityPreset`/`cloudsQualityPresets`/`ResolvedCloudsQuality` |
| `packages/cesium-clouds/src/qualityPresets.test.ts` | 新建 |
| `packages/cesium-clouds/src/createCloudsStage.test.ts` | 增补 |
| `packages/cesium-clouds/src/cloudsMain.compile.test.ts` | 增补 |
| `packages/cesium-clouds/src/shadowMain.compile.test.ts` | 增补用例（文件已存在，v3 校准） |
| `packages/cesium-clouds/src/CloudsMaterial.test.ts` | 增补（若该文件存在；否则并入 compile.test） |
| `apps/demo/src/main.ts` | `cloudsQuality` URL 参数 + 1/2/3/4 快捷键 |
| `README.md` | 参数表补一行 |
