# M6 地面云影 结果（2026-09-21 spec r2 → 2026-09-24 验收）

- spec：`docs/superpowers/specs/2026-09-21-m6-ground-cloud-shadows-design.md`（r2，4 路专家评审：1 BLOCKER+8 MAJOR 全吸收，评审冲突经 clouds.frag 一手代码裁决）
- plan：`docs/superpowers/plans/2026-09-21-m6-ground-cloud-shadows.md`（7 任务 SDD 执行：每任务独立实现子代理+独立审查，0 次修复循环）
- 分支：`worktree-m6-ground-cloud-shadows`（BASE 45fd5e1 = main）

## 交付表

| commit | 内容 |
|---|---|
| `8cfcc05` | T1 core 桥接契约：CloudsShadowBridgeData+appendGroundShadowUniforms（10 键+字段级 dummy 表防 undefined 崩帧） |
| `d4ab4fb` | T2 档位 groundShadowSamples：low4/medium8/high16/ultra16（medium=three 缺省 8，16=其上限） |
| `9b074f5` | T3 桥出口 getGroundShadowBridgeData：恒 4 槽 padded 数组+O(1) 引用语义+destroy 守卫 |
| `d851581` | T4 aerial GLSL 函数族：运行期级联变体+vogel PCF+半径自适应（glslang 双 combo） |
| `3ad3997` | T5 乘子插入：mulSunIrr\*=sunTransmittance（三重短路逐位零回归）+debug=11（JS 条件拼入调和，moon 段先例） |
| `509d8ce` | T6 demo 接线：?groundShadow/?groundShadowStrength+README |

## 验收摘要（详细取证：.superpowers/sdd/2026-09-21-m6-ground-cloud-shadows/task-7-report.md，84 份截图/raw 资产可复核）

**测试**：core 354/354 + clouds 357/357 + 三包 tsc 全绿（单轮无 flaky）。

**真机 10 场景：6 符合预期 / 3 无法判定（取证能力边界）/ 0 异常**：
- 夜晚/暮光 ON/OFF maxΔ=1（太阳沉没门控真机成立）；低太阳角三连拍 0%>2（无帧间抖动）
- 宽幅软影形态：ON/OFF 差分 48%>8 全部 ≤14（无 >16 突刺=无条带/等值线硬 artifact）
- strength=0 vs OFF 地面核心区逐位级（残余仅地平线远带=远瓦片运行方差）
- 高空俯瞰软影 0%>8（级联无硬缝迹象）；孤立云-孤立影条位置吻合
- 无法判定 3 项均诚实记录：山体影机位未捕获（机制由 debug11/差分兜底）、海面无云影路径进入视野、debug11 读数被云 overlay 混合

**性能**：worst case（贴地满屏地面+coverage 0.5）三轮同扫描成对，Δmean≤0.1ms、Δp90≤2ms——不可分辨。T4 的 PCF 循环展开与 T5 的天空像素采样成本均未显性化。

## 已知项 / 遗留

1. **debug=11 关态跌落陷阱**：`?groundShadow=0&debug=11` 静默跌落 debug=10 图（分支被模板门包裹）——诊断陷阱，建议后续把恒白分支移出门外。
2. **debug=11 读数语义**：ON 态输出经云 overlay 线性混合，非纯透射率直读，绝对标定不可用。
3. T4 watch：级联 fade alpha/margin 在 interval.x=0 时除零（three 原版同语义）——本轮未观察到级联边界 artifact，变距滚动未覆盖。
4. 三项目验移交用户：影随云动（动态过程）、云影投山画面、海面阴影（需云-太阳-海面同框机位）。
5. SDD 过程 deferred minors 9 条（测试断言补强×2、文档行×3、风格×2、debug11 陷阱×1、透传覆盖×1）——均非阻塞。

## 测量坑新增（方法论沉淀）

- **ego-lite 窗口遮挡节流**：窗口不可见时 rAF 钳到 1-2fps，tilesLoaded 被动等待与 rAF 帧时测量全部失效。替代=**页面内手动驱动渲染**（`scene.initializeFrame()+scene.render(frozenTime)` 循环，节流免疫）——tilesLoaded 稳定、收敛捕获、性能墙钟差分全部立于此法。
- **debug 探针可被下游 stage 混合**：atmosphere 的 debug 直显会经 clouds overlay 线性混合，读数非纯物理量——探针设计需考虑链上后续 stage。

## 用户目验指南

```
# 云影投山（任选山地+有云时段）
http://localhost:5173/?time=2026-09-21T11:30:00Z&play=0&camera=8.0,45.28,700,0,-4&cloudsCoverage=0.5
# 高空俯瞰软影
http://localhost:5173/?time=2026-09-21T11:30:00Z&play=0&camera=8.0,45.3,5500,0,-80&cloudsCoverage=0.35
# 影随云动（动态）：同上去掉 play=0
# 对照：加 ?groundShadow=0
```
