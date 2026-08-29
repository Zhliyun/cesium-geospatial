# 夜间云环境底光（方向 B）结果记录

> 2026-08-29 · bounded 修复（无独立 spec/plan——systematic-debugging 四阶段 + 用户 AskUserQuestion 拍板方向 B）

## 问题

体积云在黑夜中全黑（用户报告）。物理世界夜间云有月光/气辉/城市光照亮，应有微光形体。

## 根因（systematic-debugging Phase 1-2 证据链）

1. **主因——云照明模型无夜间光源**（上游 Bruneton/three-geospatial 固有缺失，移植忠实非回归）：
   云全部光照项（太阳直射×多阶散射 + 天空辐照 + 地面弹射）派生自 `GetSunAndSkyIrradiance`。
   实测 `irradiance.bin` LUT（half-float 64×16）：云层高度行（v=0,1,2）太阳当地仰角沉没
   超 ~5°（mu_s < -0.08）后 sky irradiance **精确为 0**；夜间云自体辐射恒等于 0。
   参考库 three-geospatial 云包 grep `moon|night` 零命中（其 moon 只画圆盘不进云照明）。
2. **厚云 alpha 放大器**：overlay `final = scene×(1-a) + cloud.rgb×E`，厚云海 a→1、rgb=0
   → `scene×0 + 0×12 = 纯黑`。
3. **反差刺眼**：夜空有 16-28/255 底光（skyBox 星空经大气 transmittance 压暗的残余；
   `atmo=0` 时 62 佐证），云=0 形成黑洞。

修复方向经 AskUserQuestion 拍板：**B 夜间环境底光**（A 完整月光体系 / C 方向性月光近似留后续迭代）。

## 修复

- `clouds.frag`：光照循环 `skyIrradiance += vec3(nightAmbient) × nightFactor`，
  `nightFactor = 1 - smoothstep(sin(-12°), sin(-5°), muSunLocal)`（当地太阳仰角
  -5°=LUT 归零线起淡入，-12° 满值；白天 0 零回归）。抬在 skyIrradiance 上经
  skyGradient × scattering × 能量守恒积分传播 → 云保有形体梯度。
- `CloudsParameters.nightAmbient`（默认 0.12，标定：×RECIPROCAL_PI4×skyGradient(0.75)
  ×scattering(0.9)×overlay E(12) ≈ 18/255 display ≈ 夜空底光量级）；CloudsPass 专有
  uniformMap（ShadowPass 生成端不声明不消费）；不进质量档位（视觉参数）。
- demo：`?cloudsNightAmbient=` 调参（0 = 关闭回退纯黑）。

## 验收（5199 worktree server，ion 地形 fallback 椭球基线）

夜间（time=2026-08-29T15:00:00Z，太阳仰角 -28°，camera=116,40,12000,0,-75 俯视云海），
上 1/3 像素统计：

| nightAmbient | mean | p50 | lum<3 占比 | 结论 |
|---|---|---|---|---|
| 0（关闭回退） | 1.06 | 0.00 | **81.5%** | 云=黑洞（复现根因） |
| **0.12（默认）** | 16.34 | 11.67 | 11.2% | 云有形体微光，与夜色协调 |
| 0.6（强调） | 44.03 | 32.67 | 8.8% | 过亮（验证单调通路） |

白天零回归（time=2026-08-30T04:00:00Z 正午）：默认 vs 0.6 逐像素 diff = **0.000**
（max 0.0）——nightFactor 白天精确 0，5 倍 ambient 零泄漏。

## 测试

新增 3 用例（TDD 红→绿）：CloudsPass.test.ts（uniform 注入 + 默认 0.12 + parameters
覆盖）、cloudsMain.compile.test.ts（shader 声明/表达式断言 + glslang 真编译）。
clouds 全套 210 绿（含 shadow 生成端不受影响）；tsc 干净。

## 遗留

- 方向 C（方向性月光+月相）/方向 A（完整月光体系含天空侧）未做——夜间云为无方向环境底光。
- worktree 5199 ion 地形 fallback（token/网络）——不影响云验收但与主 checkout 画面不可直接对拍。
