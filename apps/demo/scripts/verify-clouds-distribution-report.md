# 云分布重设计 T8 验收报告

- 日期：2026-09-03
- 执行：T8 implementer（验收+顺手修）
- 工具链：`apps/demo/scripts/verify-clouds-distribution.mjs`（playwright+pngjs，模式同 `scripts/perf/capture.ts` 惯例）；headed=真实 GPU（headless SwiftShader 画面不判铁律遵守）
- 截图留档：`apps/demo/verify-artifacts/`（gitignore，本机可查；文件名见各节）
- 环境注记：dev server 由 controller 持有（未动 vite/缓存）；本环境 ion 无 token（console `[phase1] ion 不可用，用裸 globe`）——地面为裸球，不影响云侧判定；唯一 console error 为 favicon.ico 404（良性）。

---

## 0. CRITICAL 发现（先于一切判定）：atlas 分派 bug——烘焙路径在 demo 不可达

**现象**：`?clouds=1`（默认）与 `?clouds=1&cloudsAtlas=0`（逃生门=旧静态图）两个 URL 的渲染**逐位相同**：

| 对照机位 | diff |
|---|---|
| lat50 8km 俯角 -8（`b2-phase0.png` vs `b10-atlas0-near.png`） | meanAbs=0, fracChanged=0, maxDelta=0 |
| lat20 62km limb（`b5-62km-atlas1.png` vs `b5-62km-atlas0.png`） | meanAbs≈0.0001, maxDelta=1 |

烘焙纹理（T3 程序化烘焙+ mip 链）与 png 包装纹理（旧静态图 64 层、无 mip、LINEAR）是不同 GPU 内容，逐位同图只可能两者走了同一纹理源。

**根因（代码证据）**：
- `WeatherAtlas.ts:143`：`usePngFallback: options.pngFallback != null`（语义=「提供了 pngFallback 即走 fallback」，T5 注释「T8 对照开关」）；
- `WeatherAtlas.ts:247-249`：`createWeatherAtlas` 开头 `if (plan.usePngFallback && options.pngFallback != null) return createPngFallbackAtlas(...)`；
- `createCloudsStage.ts:459`：**正常路径也无条件传** `pngFallback: weatherPngForFallback`（T6 注释：「烘焙异常兜底 + escape 静态图包装两用」）。

⇒ png 解码成功（实际恒成功）时 `usePngFallback` 恒 true → 恒走 fallback，`bakeAtlas` 死代码。三级降级链的「烘焙异常降级」分支永不触发（fallback 先赢了），且全程零 warn（smoke 的「无 warn=baked」推断因此失效）。

**连锁影响**：`tilePngLayers`（WeatherAtlas.ts:181-184）把同一张 png 复制进全部 64 切片 ⇒ z 采样恒定 ⇒ **`u_atlasT` 演化在 fallback 下空转**；`evolutionPhaseS` 只剩 windOffset 分量有效。T1-T5 的核心交付（时间切片演化烘焙 atlas）从未在 demo 出现过。

**修法建议（库侧 1-2 处小改 + 单测，供裁决）**：
- 方案 A（T5 侧）：`createWeatherAtlas` 分派键改显式 `options.atlasDisabled === true`（escape 专用），`resolveWeatherAtlasPlan.usePngFallback` 同步改语义；正常路径 bake，catch 内按现有三级降级走 fallback。
- 方案 B（T6 侧）：正常路径不传 `pngFallback`，改为 catch 后二次调用 `createWeatherAtlas({context, pngFallback})` 兜底。
- 单测锁定：默认 options（带 pngFallback）→ `mode === 'baked'`；`atlasDisabled` → `mode === 'pngFallback'`。
- 该修复属功能 bug 非调参，按 controller 规则未自行改动（T5/T6 已评审代码），记录上报待 dispatch。

---

## A. headless 冒烟（GL 读回可信、画面不判）

| 项 | 预期 | 实测 | 判定 |
|---|---|---|---|
| GL/编译报错 | 0 | 0（`errors: []`；favicon 404 除外） | PASS |
| mip 降级 warn | 无则记录 | 无（注：bug 下 fallback 无 mip 链是「正常」形态，warn 不可判） | 记录 |
| atlas mode | baked 预期 | **unknown——实为 pngFallback（见 §0）** | FAIL（根因 §0） |
| 天空区像素 | 非全黑非全白+有云内容 | meanLum 208.0（范围 176.7-248.4）、cloudFrac 0.4385 | PASS |
| tilesLoaded | true | 偶发超时（裸 globe 环境时序） | 记录 |

（冒烟默认 URL：lat0 ITCZ 8000m 俯角 -30。首跑曾用无 camera 默认机位——夜半球 meanLum 4.3 判据失真；二跑 lat32 平掠——亮霾带被亮度阈值误判 cloudFrac 0.27 假阳性。两次机位教训已写进脚本注释。）

## B1. 默认态演化（`?play=1&speed=60`，lat50 主机位）

| 对 | fracChanged | meanAbs |
|---|---|---|
| Δ5 sim-min（`b1-evo-t0/t5m`） | 0.3681 | 9.07 |
| Δ30 sim-min（`b1-evo-t0/t30m`） | 0.5494 | 10.40 |

十段归因（Δ5min 对）：天空 band0/1 **0.0000**、band2 0.034、地平带 0.274、云甲带 0.35-0.67——变化全部集中云甲，太阳/大气稳定。
判定：**PASS**（云形可见变化、非太阳漂移）。⚠️ bug 注记：当前变化实为风平流分量（演化空转），烘焙修复后需复测归因。

## B2. 演化归因（`cloudsEvolutionPhase=0` vs `=1800`，太阳钉死）

- diff：fracChanged 0.5663 / meanAbs 10.63（`b2-phase0/phase1800`）
- 天顶区亮度差：**1.857% < 2%**（`suncheck`）
- 判定：**PASS**（phase 不动太阳 ✓）。同 B1 注记：云侧差异当前主要来自 windOffset 相位（`tSec+phase` 线性），演化分量待修复后复测。

## B3. 回绕（evolutionPeriodS=5.3h=19080s）

| 对 | fracChanged | meanAbs |
|---|---|---|
| 19070 vs 0（近环尾） | 0.3698 | 9.27 |
| 19070 vs 19080（Δ10s 连续性） | 0.1125 | 2.35 |
| 19080 vs 0（纯回绕位差） | 0.3683 | 9.23 |

分析：**wind 平流线性、不随演化周期回绕**——19080s×8m/s=152.6km=1.523 tile（非整数）⇒「19080≡0」前提对 wind 分量不成立。这是设计语义（演化环周期 ≠ 全场周期；live 时间线上 wind 线性推进无跳变，19070→19080 的 Δ10s diff 11.3% 远小于跨 152km 位差的 36.8% 也佐证）。
判定：**记录（设计确认项）**——若产品要求整场周期无缝循环，需 windMps×evolutionHours ≡ tileKm 整数倍（调参拍板项，列给用户）。演化本身的环回绕连续性在 fallback 下不可测（空转），待修复后复测。

## B4. 确定性（同 URL 双实例×3 帧，`?time` 钉死、fps=0）

- 跨实例 3 对：全部 **meanAbs=0 / fracChanged=0 / maxDelta=0**（逐位相同）
- 实例内 a-1 vs a-3：0（静止冻结逐位稳定）
- 判定：**PASS**。FPS 角标经 `fps=0` 排除（等同 mask 效果）。

## B5. 去壁纸（全球远观对照）

- 2500km 高轨（`b5-atlas1/atlas0`）：逐位相同——**远轨云不参与渲染**（march maxRayDistance 200km 上限+长程大气淹没），新旧路径一致，属管线既有行为非回归；「壁纸」场景在远轨本就不复现。
- 62km limb（`b5-62km-*`）：maxDelta=1/255（实质相同）。
- 同机位 8km 对照（`b5-wallpaper-side-by-side.png`）：逐位相同——**即 §0 bug 的实证**（两 URL 本应是不同纹理源）。
- 判定：**FAIL（对照无效）**——修复分派后需重拍「新烘焙 atlas vs 旧 png」的甲面周期性对照（十段 rows 量具已备好：`diff --rows` / `rows`）。

## B6. 纬度气候带（deck 带 0.45-1.0 云占比，uniform 侧判定——不依赖 atlas 内容，fallback 下仍有效）

| 视角 | bands=1 | bands=0 | 差异 |
|---|---|---|---|
| lat12（ITCZ 窗内） | **0.5846** | 0.2671 | +119%（diff fracChanged 0.745） |
| lat28（副热带谷） | **0.0027** | 0.1068 | −97% |
| lat50（中纬峰） | **0.3181** | 0.1698 | +87% |
| lat0 | 0.1959 | 0.1959 | **0（逐位相同，见下）** |

- lat0 不变量解析：doy=227 → ITCZ 中心 12.3°N、cos 窗半宽 ±10°（sin 域 0.174）→ lat0 恰在窗外，`getClimateBandFactor` 各项=0 → band≡1.0 → `mix(1.0,1.0,·)` 恒等（clouds.glsl:76-94）。**数学必然非 bug**。
- bands=1 纬度梯度：0.20(0°)→0.58(12°)→0.003(28°)→0.32(50°)——ITCZ/副热带谷/中纬峰结构正确显形（`diag-lat*.png` 全剖面存档）。
- 判定：**PASS**。

## B7. 白环防护（lat50 `cloudsClimateBands=1.5` 极限档）

- cloudFrac 0.4288 / **nonCloudFrac 0.5712 > 0**（非实心白）/ maxLum 254（有亮云但画面有结构）。
- 判定：**PASS**（上界 clamp 1.3 生效）。

## B8. 预设四档（lat20 俯角，deck 带 0.3-1.0）

| 档 | 蓝隙占比（B-R>50） | 白占比（亮度法） |
|---|---|---|
| clear | 0.9933 | 0.0000 |
| fair | 0.9410 | 0.0307 |
| cloudy | 0.3263 | 0.4400 |
| overcast | **0.3476** | **0.4175** |

- clear/fair/cloudy 单调严格成立；**overcast 两度量均微反序**（TH=30/40/50 扫描稳定，非阈值噪声）：疑 `filterScale=0.6` 收窄 coverageFilterWidths 使 field 碎化（小而密的隙），与「连片」意图相反；但视觉上 overcast 边缘更软、隙内雾化、连续感仍强（`b8-*.png` 并排可目验）。
- 判定：**PASS with caveat**——排序参数由 T6 单测锁定（0.08/0.2/0.45/0.65+0.6），渲染侧 overcast/cloudy 观感分辨是**调参拍板项**（上报，不动）。

## B9. 高度三档（`cloudsAltitudeOffset=-500/0/+3000`）

- 侧视（300m 平掠，地平带度量）：0.310/0.304/0.311——**不敏感**（甲在眼平上下两侧都投影近地平线；`b9-off*.png` 存档）。
- 改 6000m 俯角 -30（`b9b-off*.png`，deck 带云占比）：**-500: 0.1158 < 0: 0.1294 < +3000: 0.4599**——+3000 档甲面抬升贴近相机、显著变大，单调成立。
- 判定：**PASS**（推荐量化视角=俯角；云底几何可辨）。

## B10. 逃生门（`?cloudsAtlas=0`）

- console 零 GL 错、wired、云内容正常（cloudFrac 0.4387）。
- 但与默认渲染逐位相同（§0）——**开关当前无差异化效果**（两侧同为旧图）。
- 判定：**FAIL（同根因 §0）**。修复后本项+「行为=旧图」才有判定意义。

## B11. 帧率（headed 10s rAF 采样，真实 GPU，lat50 主机位）

| 场景 | avg FPS |
|---|---|
| 默认（atlas 现行=fallback） | 37.91 |
| `cloudsAtlas=0`（同纹理，成本对照基线） | 37.90 |
| 默认+运动（`cloudsProbeMove=2` 每帧 2m，BSM re-march） | 36.66 |

- 新分布参数化相对旧图运行时成本 **±0.01fps（零差异）**；运动 +BSM re-march 代价 1.25fps。
- 判定：**PASS（记录）**。注：烘焙纹理修复后此项应复测（预期不变——atlas 内容不影响 march 步数；烘焙只增加载期一次性成本，本机无感）。

---

## FAIL/上报汇总

| # | 级别 | 项 | 处置建议 |
|---|---|---|---|
| 1 | **CRITICAL** | atlas 分派 bug（T5「pngFallback 提供即 fallback」× T6 无条件喂兜底源）→ 烘焙不可达、演化空转、escape 开关无差异 | dispatch 修复（方案 A/B 见 §0）+ 单测锁 mode；修复后复测 B1/B2/B3/B5/B10/B11-加载 |
| 2 | tuning | B8 overcast vs cloudy 微反序（稳定） | 用户目验 `b8-cloudy/overcast.png` 拍板 filterScale/coverage |
| 3 | design | B3 回绕：wind 分量不随演化周期回绕（数学必然） | 用户确认是否要求整场周期循环（若要：windMps×evolutionHours≡tileKm 整数倍） |

## 意外发现（记录）

1. agent-browser CLI page-targeting 分裂：`open` 确认标题/URL 正确，`wait --fn`/`tab list`/`screenshot` 却指向 about:blank（全命令统一 `--headed` 亦复现）——headed 组改用 playwright（capture.ts 惯例），每组 launch→shot→close 仍满足「同批成对+close 重开」。
2. 远轨（≥62km）云不可见为管线既有行为（march 200km 上限+大气淹没）——「壁纸」问题域只在低轨/近景存在。
3. 纬度扫描时确认气候带视觉结构正确（ITCZ 密云带→副热带近无云→中纬云带，`diag-lat*.png`），T4 分布实机成立。
4. 本环境 ion 无 token（裸 globe）+ tilesLoaded 偶发不置位——环境性，不影响云侧判定。
5. 首版冒烟机位两连误（默认机位在夜半球、lat32 平掠踩副热带谷+霾带阈值假阳性）——量化视角选择教训写入脚本注释。

## 顺手修复（第一部分交付）

- commit `0682c76`：①buildImpl atlas 创建后主体包 try/catch（catch 内 `atlas?.dispose(); atlasFallbackDummy?.destroy(); throw e`，防中段抛错 ~16MB GPU 悬挂）②evolutionPhaseS 太阳断言补强为与无 phase 基线 `toEqual`。cesium-clouds 287 tests 全绿 + tsc 干净（+2 新用例锁外圈 catch 正常/dummy 两路径）。

---

# 复测（dbdcea8 分派修复后，2026-09-03）

dispatch 修复（方案 A：`usePngFallback` 显式 escape × `pngFallback` 纯兜底材料，T5 fix round 2，16/16 分派单测）已落地。本段为六项复测结果 + **复测新发现的 CRITICAL #2**。

## 复测判定一行式

| 项 | 判定 | 核心数据 |
|---|---|---|
| 1 冒烟 | **PASS** | GL 零错、wired、无 `[clouds]` warn（烘焙静默成功）、cloudFrac 0.64、有云内容；escape 组同过（0.4388 与第一轮 wrap 完全一致=旧静态图行为精确复原） |
| 2 烘焙耗时 | **PASS（记录）** | `__cloudsStage` 就绪时刻对照：baked 1374/1225ms vs 包装 1272/1237ms——两轮 delta **+102/−12ms**（±16ms 轮询粒度+帧调度抖动内）——烘焙增量亚百毫秒、首帧一次性、用户无感；spec 预估 15-40ms 与实测兼容 |
| 3 B5 去壁纸 | **PASS（纹理源切换）/ FAIL（内容质量）** | baked vs escape 8km：meanAbs 10.27 / fracChanged **35%** / maxDelta 86（修复前逐位 0）✓ 壁纸源已换；62km：2.53 / 11.8% ✓；rows 形态分化（baked 1.36 平坦 vs wrap 3.91 中下带陡增）。**但 baked 画面=近均匀白雾，云单体结构丢失**（见 CRITICAL #2），「去壁纸」目的达成而「云形正常」不成立 |
| 4 B1 演化 | **弱响应（记录）** | play=1 Δ5min fracChanged 0.045%（maxDelta 82）、Δ30min 0.11%——随时间增长方向正确，但修复前 wind-only 版为 0.37/0.55——量级缩水 ~300×，肉眼难感知，与 CRITICAL #2 饱和压制一致 |
| 5 B2 归因 | **PASS（太阳钉死）/ 弱响应（云）** | phase 0 vs 1800：天顶亮度差 **0.020%**（<2% 门禁 100×余量）✓ 太阳不动；云侧 diff 0.11%——演化输入生效但被饱和压制。（操作注记：URL 键为 `cloudsEvolutionPhase`，首轮误写 `cloudsEvolutionPhaseS` 得逐位 0 假象） |
| 6 B3 回绕 | **PASS（闭合）** | phase 19070 vs 0：fracChanged **0.019%**（正常 10s 步长 0.004% 的 ~4.5×，远低于跨环位差量级）——演化 z 维闭合铁律成立；wind 分量不回绕的设计确认项仍在（见第一轮 #3），但当前被 #5 windOffset 失效掩盖 |
| 7 B10 逃生门 | **PASS** | escape 零 GL 错、cloudFrac 0.4388（=第一轮 wrap 0.4387）、B5 差异证明其与 baked 内容级分离——`?cloudsAtlas=0` 现为真差异开关 ✓ |

（B11 帧率见下；B4 确定性同 URL 双加载逐位 0 在修复后复验成立。）

## CRITICAL #2（复测新发现）：baked 内容渲染为饱和白雾，云单体结构丢失

**现象**（8km lat50 主机位，headed 真 GPU）：baked 渲染近均匀白雾+固定淡斑（`r2-b5-baked-8k.png`）；escape（旧静态图）渲染清晰积云群+蓝隙（`r2-b5-wrap-8k.png`）。B5 的 35% 差异本质即「白雾 vs 有结构云」。

**失配定位**：烘焙输出通道语义为「独立 + max(mid,low)」（T3 计划内改动，weatherBake.frag:98），而采样端 coverage/coverageFilterWidths 是按旧图「挖除互斥」语义标定的（第一轮 B8 反序已预警同族问题）。`smoothstep(0.8,1.4,FBM)+smoothstep(1.0,1.4)` 输出大面积高值 → mix(localWeather,1,filterWidths) 进一步推向 1 → Skybolt remap 压不住 → density 处处饱和。

**量化佐证**：
- coverage=0.1（近晴）画面几乎不变（cloudFrac 0.30，暗斑布局全同 `r2-baked-cov01.png`）——暗斑非云结构，调制链压不动饱和内容；
- 性能反证：baked 60.04fps vs escape 44.94fps（同参数同相机）——饱和云透射率快速衰减 → march early-exit 反而减负；修复前两者同图同 37.9；
- baked rows 粗糙度 1.36 vs wrap 3.91——高频结构缺失。

**处置建议（用户拍板项）**：①烘焙端重标定（smoothstep 阈值/FBM 增益，让输出分布对齐旧图统计）或 ②采样端重标定（coverage 默认/coverageFilterWidths 按新语义适配）。此项不修，演化/平流/种子的一切「弱响应」都无法排除饱和压制干扰。

## FAIL/上报汇总（复测轮）

| # | 级别 | 项 | 证据 | 处置建议 |
|---|---|---|---|---|
| 1 | **CRITICAL** | baked 内容饱和白雾、云单体结构丢失（见上节） | `r2-b5-baked-8k.png` vs `r2-b5-wrap-8k.png`；coverage 0.1 失敏；fps 60 vs 45 | 烘焙端或采样端重标定（用户拍板哪端） |
| 2 | **CRITICAL（疑，受 #1 干扰）** | `cloudsSeed` 重烘无实际效果：seed=1 vs 默认 1337 云形态**逐斑相同**（`r2-seed1.png` vs `r2-b5-baked-8k.png` 肉眼同图；diff 0.093%） | 饱和可压制「幅度」但不能解释「饱和区布局不变」——疑 `u_seedOffset` 未实际进入烘焙（FullscreenPass uniformMap 键匹配/闭包时序）或 bakeSeedToOffset 值退化 | T5 复查 u_seedOffset 注入链；修 #1 后重测 |
| 3 | **CRITICAL（疑，受 #1 干扰）** | `u_windOffset` 平流无实机响应：phase 0→9000（wind 应位移 72km≈0.72 tile≈184texel）diff 仅 0.14%；phase 0→19070（52km）0.019%——远低于第一轮 wind-only 版同参数 0.37/0.57 | `cloudsWind=1000` 放大档 12.5s 位移 12.5km diff 2.9%（非零）——uniform 链可能活但被饱和压制；无法在 #1 存在下判定 | 修 #1 后重测 phase 系列；仍无响应则查 march uniformMap |
| 4 | Important | `cloudsWeatherRepeat` 不影响 march 采样端 `localWeatherRepeat`（uv×repeat 恒默认 100）：repeat=1 vs 100 渲染几乎同图（rows 1.368 vs 1.360） | T7 参数只进烘焙 plan（tileKm→wind 换算），march 端 repeat 是独立 params 字段未同步——「降 repeat 去壁纸」参数化（spec §5.1 升级路径）当前实际无效 | T6/T7 补 params 联动或文档注明该键当前语义=wind 换算 only |
| 5 | tuning（沿用第一轮） | B8 overcast vs cloudy 微反序 | 同第一轮 | 用户拍板 |
| 6 | design（沿用第一轮） | wind 不随演化环回绕 | 同第一轮；当前被 #3 掩盖，#3 排除后需重测 B3 | 用户确认整场循环需求 |

## 意外发现（复测轮）

1. **URL 键笔误教训**：`cloudsEvolutionPhaseS`（带 S）静默无效（demo 读 `cloudsEvolutionPhase`）——得逐位 0 假象。URL 参数解析无未知键告警，验收/调试时先核对键名（T9 可考虑未知 `clouds*` 键 console.warn）。
2. **性能侧饱和探针**：同参数 fps 差（60 vs 45）可作内容饱和的廉价旁证——march early-exit 使 fps 与云结构复杂度负相关。
3. atlas mode 运行时探针仍缺位（handle 未暴露 atlas.mode）——复测用「console 静默 + B5 内容级差异」双证据替代；smoke 脚本对 escape URL 加显式标注。
4. headless SwiftShader 冒烟在真烘焙路径下零 GL 错——**Texture3D 逐层 FBO 烘焙+generateMipmap 在 SwiftShader 可用**（spec §4.3 冒烟项关闭）。

## 复测产物

- 截图：`apps/demo/verify-artifacts/r2-*.png`（baked/wrap 8km+62km 对照、side 并排×2、phase 系列、wind1000 系列、repeat1、seed1、cov01、noshadow 对照）
- 脚本：`verify-clouds-distribution.mjs` 新增 `bake` 命令（headed 烘焙耗时，16ms 轮询 `__cloudsStage` 就绪时刻对照）+ smoke atlasMode 推断更新

---

# 终测（dd6ef21 挖除语义 + f0926b0 repeat 联动后，2026-09-03）

## 六项判定一行式

| 项 | 判定 | 核心数据 |
|---|---|---|
| 1 B5 白雾消除 | **FAIL（修复未触达主源）** | r3-baked 与 r2-baked **逐斑同雾**（diff 2.3% maxDelta 20=环境噪声级；rows 1.359 vs 1.360）。挖除修复只改 R 通道，雾源在 B/A——见「白雾终局定位」 |
| 2 B8 预设单调性 | **FAIL（崩坏为全档无差异）** | clear/fair/cloudy cloudFrac **逐位同 0.3020**（meanLum 差<0.02）、overcast 反而最低 0.1139。雾底支配一切预设调制，反序判定已无意义 |
| 3 seed 疑点 | **实锤真 bug（JS 传递链断）** | 独立 WebGL2 环境（同组装管线、真实 bakeSeedToOffset）：seed 1 vs 1337 产物 **99.6% 去相关**（meanAbs 144、maxDelta 255）——烘焙数学正常；实机 cloudsSeed=1 vs 1337 渲染 diff 仅 0.086% 逐斑同图（r3-seed1 复测维持）→ demo→stage→atlas 的 seed 传递或 u_seedOffset uniform 注入断 |
| 4 windOffset 疑点 | **无法终判（雾压制维持）** | phase 0 vs 9000 diff 0.13%（与上轮 0.14% 一致）；独立读回证明层间内容真实波动（B 通道层均 0.35-0.60）——演化层差存在但实机不可见 |
| 5 repeat 联动 | **接线有迹象、无法终判（雾压制）** | cloudsWeatherRepeat=20 vs 100 diff 1.48%、rows 1.385 vs 1.359（上轮 repeat=1 时 2%/1.368 几乎无感——f0926b0 联动有变化但远小于「云团尺度 5×」应有的画面级差异，雾底不随 uv×repeat 变化稀释了差值） |
| 6 全套件 | **PASS** | vitest 294/294（19 文件）+ tsc 干净（四轮修复后总状态） |

## 白雾终局定位（独立 WebGL2 读回实锤，雾源=烘焙 B/A 通道）

方法：playwright 裸 WebGL2 + dev server 真实组装管线（`buildStandaloneWeatherBakeShader`，含 unrollLoops/compat 完整变换）独立渲染烘焙 shader → readPixels 逐通道直方图，对照 `local_weather.png`（escape 旧图，同一采样链下有清晰云结构）：

| 通道 | 旧 png mean / hiFrac(>0.9) | 烘焙 mean / hiFrac | 结论 |
|---|---|---|---|
| R=L0 low | 0.278 / 1.2% | 0.208 / 0% | 挖除修复生效、分布健康（更低更稀疏） |
| G=L1 mid | 0.160 / 0.4% | 0.094 / 0.1% | 健康 |
| **B=L2 high** | **0.500 / 2.1%** | **0.598 / 40.7%** | **雾源①：smoothstep(-0.5,0.5,perlin×2.2) 输出近半像素饱和 → 卷云层满格白雾** |
| **A=L3** | **0.415（真实分布，loFrac 8.6%）** | **1.000 恒定** | **雾源②：烘焙 A 恒 1 → L3 恒满格** |

**排除项（重要）**：白雾≠march/coverage/气候带 bug——同一采样调制链旧图有结构；也≠烘焙整体饱和——R/G 通道分布健康。**64 层内容真实独立**（B 通道层均 0.35↔0.60 波动；slice 0 vs 63 相近=闭合铁律成立）。

**spec §4.6 事实修正**：「localWeather.frag:82 无条件 =1.0 死值」的判断**对 png 资产不成立**——资产 A 通道 mean 0.415 有真实分布。烘焙 `outputColor=vec4(low,mid,high,1)`（weatherBake.frag:108）把 L3 变成恒满格层。**A 通道「保持 1 不激活」的设计前提需重审**。

**修复方向（T3 拍板，本验收不自行改）**：①B 通道重标定——gain 2.2 降至 perlin 输出不饱和（旧图 hiFrac 2% 为目标分布）；②A 通道——恢复第 4 层真实内容（worley 或 high 减弱版），勿恒 1。修后重测：B5 白雾、B8 单调性、seed/windOffset/phase/repeat 全部弱响应项（雾底消除后才能真正显形）。

## 产物

- `r3-*.png`：baked/wrap 8km 对照+side、seed1、phase9000、repeat20、四预设
- 独立读回脚本（tmp，不入库）：bake-readback.mjs（直方图）、seed-verdict.mjs（seed 判定）、png-hist.mjs（旧图对照）
