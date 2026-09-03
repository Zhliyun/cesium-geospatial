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
