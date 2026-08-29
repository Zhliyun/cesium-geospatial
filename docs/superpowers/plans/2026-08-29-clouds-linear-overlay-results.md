# 体积云 overlay 线性域化与链重排 验收 Results

- **日期**：2026-08-29
- **spec**：`docs/superpowers/specs/2026-08-29-clouds-linear-overlay-design.md`（v2.1，三专家两轮评审闭环）
- **plan**：`docs/superpowers/plans/2026-08-29-clouds-linear-overlay.md`（SDD 执行，T1-T5 全完成）
- **问题**：相机直面太阳时 lensFlare halo 圆环被体积云覆盖（云 overlay 排链尾，把已画好的 halo 按云不透明度混掉）

## 一句话结论

修复生效：halo 光晕叠加在云之上（V1 像素级铁证），`clouds=0` 零回归（V3 逐像素 mean diff 0.03），曝光默认值定稿 12（用户目验拍板）。

## 测试

| 包 | 结果 |
|---|---|
| @cesium-geospatial/core | 32 files / **295 passed**（基线 281 + insert API 新增 14） |
| @cesium-geospatial/clouds | 15 files / **207 passed**（基线 203，改写 1 + 新增 5） |
| tsc --noEmit 三包 | 零错误 |

（T2 fix round 补 §8.1.11b 回滚失败锁；T3 fix round 补跨 impl 强断言与 listener 摘除断言。）

## 视觉验收（spec §8.3，worktree :5199 vs 主 checkout :5173 基线）

### V1 主判据：halo 叠加在云上 —— **通过**

确定性证据链（非 AI 目测）：
- 修复前后同视角（`time=2026-08-29T09:30:00Z&camera=120,30,800,268,20&lfHalo=0.5&lfIntensity=0.005`）像素 diff：>10 阈值差异仅 0.63% 像素，其中 **96.3% 修复后更亮（平均 +30.9 色阶）**= halo 弧叠加方向；
- 差异 **100% 集中在 3~9 点方向（云区侧）弧段**（平均半径 998px 成环弧），天空侧（9~12~3 点）**零像素差异**；
- V1（lf 开）vs V4（lf 关）弧线上 8497px、+21.1 色阶——弧线亮度来源锁定 lensflare halo；
- 视觉参考（用户目验收尾）：修复版 4~8 点弧段连续叠云，基线版该弧段被吃。

### V2 云曝光定稿 —— **12（用户拍板）**

四档候选（黄昏逆光视角，下半画面 >240 白色占比）：e3 57.5% / e6 61.4% / e10 67.6% / e15 74.8%。用户目验后自选 **12**（e10/e15 之间，云体积感/亮度平衡）。已回改三处：`CLOUDS_OVERLAY_EXPOSURE_DEFAULT`（含定稿注释）、README 参数表、demo 注释。**注意 spec §9.2 耦合**：E=12 下更多亮云会越过 lf thresholdLevel=3.0 参与 flare 能量提取——用户挑值时同屏带 lf，接受该观感。

### V3 零回归 —— **通过**

`clouds=0` 同 URL 对比：逐像素 mean diff 0.03、>10 差异仅 0.03%——链未变。

### V4 lensflare=0 —— **通过**

云正常合成（atmo → clouds → tm 链）。附带发现：lfIntensity=0.005 时 lf 开关画面差仅 0.2%——**画面大环主体是大气 Mie glow，spec 所称「halo」实为 Mie glow + lensflare halo 的叠加观感**（修复对两者层级分别正确：Mie 属大气在云后受云调制、flare 属镜头效果在云上）。

### V5 换档 halo 层级 —— **通过**

low/ultra 档（URL `?cloudsQuality=` 起）halo 环完整、与 high 差 4.9%/1.6%（overlay 跨 impl 位置恒定）。键盘 `1` 键在 agent-browser 有工具层怪癖（见环境坑 3），URL 参数路径已覆盖。

### V6 hdr=0 降级 —— **通过（按 spec 修正判据）**

画面可看、无崩溃、云正常（本机 ?hdr=0 只压 atmosphere RT 为 RGBA8，云 >1 线性值不 clip；真 8-bit 全链路本机不可复现，如实记录）。

## 插入长帧现象（spec §9.4）

weather 加载完成帧的 insert 触发全链 RT 重建 + lf 15 子 stage shader 编译——一次性长帧与 march shader 编译同窗口，验收过程中未见可感知卡顿异常（未做逐帧计时，spec 定性可接受）。

## 实施偏差与裁决记录（SDD ledger 摘要）

1. T2：plan 守卫序缺陷（contains 前置致幂等不可达）——实现者幂等前移，controller 裁决采纳；spec「已销毁同实例走替换」措辞矛盾由实现统一入口抛错消解（留 spec 勘误）。
2. T2：node 环境必要隔离 5 处（historyBlit mock / lensFlareMock isDestroyed / TS 签名 / stubLuts 四字段 / undefined 窄化）。
3. T3：plan 笔误 `mock.calls.at(-1)`（取参数数组）——实现者改 `mock.results.at(-1).value`。
4. T4：profile 闭包 TS18048 可选链（let 闭包窄化丢失，行为等价）。

## 验收环境坑（复现须知）

1. **headless 下 clouds=1 任何地表视角 100% 全白**（5173/5199 一致、与曝光/时间无关）——headless GPU 路径环境问题非代码回归；云验收必须 `AGENT_BROWSER_HEADED=1`。
2. **worktree 缺 `.env.local`** → 裸 globe 污染与主 checkout 的 diff（V3 初拍 21% 假差异）——复制 token 后复拍归零。
3. **agent-browser `press 1` 工具层怪癖**（画面重置太空全景、不触发切档；press 2/3/4 正常）——按键验收改用 `?cloudsQuality=` URL 参数。
4. **worktree 内 `pnpm --filter <pkg> exec` 可报 "No projects matched" 且退出码 0（假绿穿透）**——测试/tsc 一律包目录直跑或根 `pnpm test`。

## 遗留（spec §9 已知限制，未修）

- 太阳被云遮挡时 halo 仍显示（lf occlusion 只读 globe depth）——后续增强立项。
- lf 亮度阈值源含云（E=12 下增强）——spec §9.2 记录，用户验收接受。
- profile=1 与 clouds=1 组合下 lf/tm/clouds_overlay 计时键缺失——已知限制。
- 薄云边缘大气段双重计入（pre-existing，本次不恶化）。
- spec「已销毁同实例走替换」措辞与实现（统一入口抛错）的勘误留档。

## 截图清单

`/Users/zhangliyun/.claude/jobs/366ddd10/tmp/`：`t5-v1-fixed.png` / `t5-v1-baseline-5173.png`（修复前后对比）、`t5-v1-noclouds.png`、`t5-v2-e3/e6/e10/e15.png`、`t5-v3*.png`、`t5-v4.png`、`t5-v5-low/ultra.png`、`t5-v6.png` + diff 可视化与分析脚本（取证可复现）。
