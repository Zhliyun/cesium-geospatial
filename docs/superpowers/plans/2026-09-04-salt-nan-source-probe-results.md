# 盐粒 NaN 源头调查结果——源头已死实证 + readPixels 探针基建落地（2026-09-04）

## 结论

**遗留项 #3「盐粒 NaN 源头未定位」实为伪遗留：当前 main（0063dea）上 NaN 源头已不存在。**
[[clouds-salt-black-inside-layer]] 中「消毒是兜底（运动中每帧注入被兜住，画面正确但源头仍在）」
系修复会话在没有数据探针条件下的**保守推断**，本轮 readPixels 基建首次实测推翻：

- 修复前 NaN 的产生途径有两条——①甲内段长无截断 → frontDepth/velocity 极端值域；
  ②跨深度错借 velocity → history 大距离错位采样。
- **53e8bc6（段长截断 + getClosestFragment 深度同质守卫）恰好从上游切断这两条途径**；
  c4c9f03（sanitizeHistory + outputColorSanityGuard）降格为纯保险（永不触发）。

## 调查过程（systematic-debugging Phase 1，数据探针取证）

复现域：`?mode=atmosphere&cloudsCoverage=1&camera=14.9759,48.6398,1770,1.5,-6.1`
（coverage=1 + 甲内 1770m + pitch -6.1° 近水平 + 黄昏 time 钉死）+ 三种运动形态。
工具：**零 shader 改动**的 raw-GL readPixels 探针（基建沉淀于
`apps/demo/scripts/nan-probe.console.js`）——FBO attach Cesium 纹理 + HALF_FLOAT
readPixels + exp 全 1 位型检测（NaN ∪ Inf 一网打尽）。

采样矩阵（约 270 帧 × 3 buffer × 9.7M texel）：

| 场景 | 帧数 | march color | depthVelocity | resolve 输出 |
|------|------|------------|---------------|-------------|
| 静止冻结（M4 frame 不递增） | ~60 | 0 | 0 | 0 |
| 旋转运动（CDP 拖拽 5 轮） | 60 | 0 | 0 | 0 |
| zoom 平移穿云 2076m→561m（大视差峰值 velE25≈79k 抽样） | ~90 | 0 | 0 | 0 |
| 静止+时间流动（原「间歇 ~25%」路径） | 60 | 0 | 0 | 0 |

画面全程正常（云海/甲内雾色，无盐粒无黑块）；数据交叉验证为活帧
（运动中 velocity 分布逐帧变化、静止后逐位恒定）。

## 附带发现

1. **probeMove 参数已被 0063dea 清退**（「运动探针三件」之一）——`?cloudsProbeMove=N`
   现为死参数。本调查用 CDP 拖拽（rotate）+ 滚轮（zoom=dolly 平移）替代，运动本质
   （甲内近水平 + coverage=1 + 大视差）均覆盖。若未来需确定性平移复现台，需重建。
2. velocity 极端值（|v|>0.25）在健康运动中可达数万 texel（zoom 动画峰值 ~13% 全屏，
   1/16 抽样 78761）——大 velocity 本身不是病，reject/disocclusion 路径按设计处理。
3. depthVelocityBuffer 的 no-cloud texel depth=cameraFar(≈1e10) 在 HalfFloat 存为 Inf——
   被 getClosestFragment 的 `>= 1e8` 守卫按 no-hit 语义正确消费，非 bug（设计哨兵）。

## How to apply

- 未来任何云伪影调查先跑 `apps/demo/scripts/nan-probe.console.js`（console 粘贴即用，
  `__nanProbe.run(N)`）再动 shader——NaN 类问题一票否决/一票坐实，不必再层层 A/B 猜。
- 消毒兜底（sanitizeHistory/outputColorSanityGuard）**保留不删**：零成本保险，
  防未来改动重新引入 NaN 源。
- CDP 输入驱动运动：`Input.dispatchMouseEvent` mousePressed/mouseMoved/mouseReleased
  （左键拖=rotate）、mouseWheel（deltaY 必须显式，zoom=dolly）；页面 rAF 探针用
  「写全局+node 轮询」模式回传（Runtime.evaluate 不 await Promise）。

相关：[[clouds-salt-black-inside-layer]]、[[clouds-black-penetrate]]、[[clouds-black-rotate]]。
