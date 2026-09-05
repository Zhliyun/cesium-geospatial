# 平视地平线性能优化 P0+P1 结果（2026-09-05）

- 分支：`worktree-clouds-horizon-perf`（6fac367 P0 + b73bf04 P1，基于 58471e3）
- 动机：用户主诉「开启体积云后平视地平线 FPS 低、多场景、各时刻、一直都这样」；
  排查台账见对话记录（测量脚本模式沉淀于会话 job tmp：perf-scan/perf-ab/perf-diff/perf-heat）
- 性质：bounded 小改动（无正式 spec）；P0=逐位零回归设计，P1=带标定旋钮的分辨率变更

## 排查台账（只读测量，冷机+120Hz 屏 rAF 无 60 帽，锚点漂移 <3%）

静止 p50（ms）：裸球 8.3 全场景恒定；+大气=8.3（**大气 stage 静止成本≈0**，
2026-09-04 文档的 +7.9~48ms 未复现，疑 60Hz 帽/热降频污染旧测）。

| 场景 | +云 | 拆账（开关差分） |
|---|---|---|
| 贴地·昼 | +6~7 | 光柱 march ~5 + 太阳侧 ~2（`cloudsShadow=0` 回裸球） |
| 贴地·夜 | +9 | 光柱 ~6 + 少量太阳侧；双关回裸球 |
| 甲内·昼低角 | +11~14 | 基础 march 预算为主 + BSM ~5 + 光柱 ~4.6 |
| **甲内·夜** | **+24（31FPS）** | **太阳侧白烧 ~14-20 + 光柱 5.4 + 基础 ~14** |
| 高空 30km | ≈0 | 50-300km 渐隐生效 |

甲内夜 33.4ms 三角自洽：def 33.4 = noLSnoSh 17.6 + BSM 消费 ~14 + 光柱 5.4（重叠 ~4）。

## P0 夜晚太阳侧门控（6fac367）

**原理**：sunIrradiance 三通道精确 0 时（太阳当地沉没 >5°，ACCURATE LUT/桥接 varying
两路径皆然——夜间全黑调查实证），受照样本的 toSun march + BSM 光深采样结果只被乘 0
（0×AMS=+0，AMS 有限）→ 门控跳过逐位等价。月光 march 的 A1 门控（7d525fc）镜像补全；
晨昏带（任意非零分量）照跑同款纪律。

**验证**（真机 A/B，5173=58471e3 vs 5174=本分支）：
- 甲内·白天：**字节级逐位相等**
- 甲内·夜 / 贴地·夜：=对照组噪声地板（maxΔ43/over3 3.7e-5 vs 对照 44/4.2e-5）
- **甲内·夜 33.4→16.7ms（FPS 30→60 翻倍，成对两轮稳定）**
- 贴地·夜无变化：掠射视线不进云甲→受照样本趋零，太阳侧浪费为云甲内视角类特有
  （修正排查期「贴地夜 ~6ms 白烧」的推断——当时 noLSnoSh=8.3≈裸球已暗示）
- 341 clouds 测试绿；教训：见下「测量坑」

## P1 光柱 march 降采样（b73bf04）

**原理**：marchShadowLength 沿视线逐步采 BSM（≤150 步，A2 改造后 16km 段）。BSM
三级联 texel 实际足迹 L0≈62m/L1≈131m/L2≈375m（mapSize 512）——50m 步长对 BSM 实际
携带信息本就过采样（上游 clouds.frag 注释自认 "sample resolution can be much lower"）。
缺省 minShadowLengthStepSize 50→100（迭代 ~146→~96，-34%）；
**`?cloudsShaftStep=` 标定旋钮**（=50 回上游原值；demo parameters 直通块注入，与
coverage/tint 同块防对象字面量重复键覆盖）。

**验证**：
- **贴地·夜 16.9→9.4ms**（≈回裸球；该机位云成本主体即光柱 march）
- 甲内·夜 16.2≈P0 后水平（增量在噪声内）；黄昏 god rays 场景 before/after
  **maxΔ=2（无像素超 3，数值不可见级）**；夜月/甲内昼=噪声地板
- 341 测试绿 + 两包 tsc clean
- **光柱形态目验=用户验收项**（50/100/150 三档 URL 对照后拍板缺省定稿）

## 测量坑（本役新踩/复踩）

1. **vite 缓存假差异（复踩，代价一轮误判）**：主 checkout 5173 server 的陈旧 .vite
   缓存制造了甲内夜 15.4% 像素假差异（meanΔ 1.4），清双缓存后归零。**跨版本 A/B
   前必须双方 server 全部清缓存重启**——「渲染异常先清缓存」铁律的 A/B 版。
2. **PNG 字节比对协议无效**：同代码两次加载字节即不同（M4 静止冻结 frame 序号随加载
   变 → 三角 dithering 图案差 ±1 LSB）。跨版本等价性判定=像素级 maxΔ/over3 对照
   处理组 vs 同代码对照组噪声地板。
3. **对照组也会抓到坏样本**：tilesLoaded-5s+3s 余量偶有 refinement 波次中途截图
   （tie-night 对照 1.5% 噪声）——坏对（字节数离群）作废重采。
4. **120Hz vsync 量化+GPU 频率漂移使 ~3ms 级 delta 不可分辨**：tie-noon 同配置跨加载
   p50 8.4↔15.9 波动（1-tick vs 2-tick vsync + boost 时钟摆动）。大 delta（>7ms）
   成对可见，小 delta 结论须谨慎；profile=1 timer 饱和仍不可用（昨日已证）。
5. worktree guard 拦 sed+env 复合命令——参数化用 Edit 工具改脚本。

## 遗留与后续候选

- **P2 白天预算域未动**（用户画质关）：甲内昼低角 +11~14ms 主体=基础 march 预算；
  `?cloudsQuality=medium` 现成可拿 ~6ms；消费端影子 LOD 为潜在工程课题
- **A 预算（58471e3）运动帧严格成对验收仍欠**：本役运动窗测量受 CDP 拖拽 rAF 采样
  稀疏限制不可判；当前旋转 p95 19-36ms 远好于昨日文档基线 94-125（高度重定红利）
- tie-noon 的 P1 增量被 vsync 量化淹没，验收时可体感对比
- 用户 P1 目验拍板后：缺省 100 or 150 定稿 + 分支合并 main

相关：[[clouds-horizon-perf-ledger]]（排查台账记忆）、
docs/superpowers/plans/2026-09-04-surface-grazing-rotate-lag-results.md（前役）、
docs/superpowers/specs/2026-09-04-clouds-adaptive-budget-design.md（A 预算）。
