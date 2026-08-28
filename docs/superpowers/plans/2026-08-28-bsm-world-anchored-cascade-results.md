# BSM 世界锚定 cascade —— 端到端验收结果（T6）

- 日期：2026-08-29（验收执行；fix round 1 干净管线复测覆盖初版数据，初版移附录 A）；spec `docs/superpowers/specs/2026-08-28-bsm-world-anchored-cascade-design.md` §6/§7
- 分支：`bsm-world-anchored`（worktree shadow-far-fadeout）
- **测量管线（fix round 1 定稿）**：vite dev；每组录制前 `agent-browser close` 全关（杀遗留 tab 的 rAF+探针）→ sleep 3 → 重开单 tab → networkidle → 4s → 录 10s → fps=10 抽帧；**帧数门禁 ≥50**（健康 53-97，不达标作废重录）；指标 pct>20/255 相邻帧跳变像素占比（同 spec §1.1）
- 基准：`mode=atmosphere&clouds=1&time=2026-08-28T17:30:00Z&camera=-80.6057,64.5197,7852,68.8,-17.8`（白天，云海+自阴影可见）
- 探针参数（本次交付）：`?cloudsProbeOrbit=N`（每帧 rotateLeft N rad，30 帧后启动）、`?cloudsProbeZoom=N`（每帧 zoomIn N m，dolly=滚轮语义）、`?cloudsShadowScale=N`（worldRadii×N，E1' 用）；`WORLD_RADII_DEFAULT`/`WORLD_INTERVALS_DEFAULT` 自 clouds 包导出（类缺省同源）

## 1. 四探针 AB 验收表（fix round 干净数据，核心）

增量 = 同批成对录制（同 URL 仅 `cloudsShadow` 开/关）的均值之差；帧数列即门禁记录。

| 探针 | world 开 | world 关 | **world 增量** | frustum 开 | frustum 关 | **frustum 增量** | 判定 <0.3% |
|---|---|---|---|---|---|---|---|
| 静止（sanity） | 0.034%（58帧） | 0.220%*（66帧） | **≈0.000%*** | – | – | – | ✅ |
| 慢速轨道 1e-5 rad/帧 | 4.117%（75帧） | 2.621%（70帧） | **1.496** | 4.528%（71帧） | 3.335%（53帧） | **1.193** | ❌ |
| 慢速平移 3 m/帧 | 2.350%（61帧） | 1.563%（66帧） | **0.787** | 2.538%（67帧） | 1.341%（90帧） | **1.197** | ❌ |
| 快速平移 12 m/帧 | 1.500%（95帧） | 0.848%（96帧） | **0.652** | 1.743%（96帧） | 0.821%（97帧） | **0.922** | ❌ |
| dolly 5 m/帧 | 2.040%（73帧） | 0.885%（95帧） | **1.155** | 2.221%（76帧） | 0.878%（97帧） | **1.343** | ❌ |

\* S1b（静止关）均值 0.220% 被单帧 10.85% 尖峰污染（65 对差分仅 1 尖峰，中位 0.042%）；静止增量按中位口径 ≈0.000%（S1a 0.034% vs S1b 中位 0.042%，同为编码底）。

**结论：干净管线下四探针 world 增量 0.65~1.50% 全部 >0.3%，spec §6 验收不达标**（初版污染数据的「不达标」结论在干净数据下成立；按 brief 不改生产代码）。

要点：
- **静止增量 ≈0.000%**——T5 静止跳过端到端完美（render 跳过 → BSM 冻结 → 开/关帧间一致）。
- **world vs frustum 同批相对削减**（跨批绝对值不可比，同批相减可信）：move3 34%、move12 29%、dolly 14%、**轨道 -26%（world 反超 frustum，两轮一致：1.59/1.37、1.50/1.19）**。
- **轨道反超归因（fix round 2 勘误+实验实锤）**：初版「rotateLeft 只改 heading、矩阵理论冻结、增量=固有视差」论述**错误**——Cesium 源码 `rotateLeft → rotate(camera.up, angle) → Matrix3.multiplyByVector(rotation, this.position)`，**position 绕过地心的轴旋转**，基准高度 7852m 下 1e-5 rad/帧 ≈ **63.8m/帧 ≈ c0 texel 62.5m——world 每帧恰好跳一格**，每帧重 march + STBN jitter 相位重随机化（「整数 texel 平移双线性无损」被破坏）。轨道版 E1'（§2.1）实测 snap 分量 1.156% 占总增量 77%——**world 在轨道工况负效坐实**（frustum 的 AABB center 慢变 snap 后跳频更低）。
- 单组测量组间方差 ~±0.2-0.3%（同探针跨批两三轮差 0.2-0.4%）；探针增量 0.65-1.50% >> 方差，超标结论稳。

## 2. E1' 归因实验（spec §6/§7 首要风险行）

`cloudsShadowFreeze=1&cloudsShadowScale=5&cloudsProbeMove=12`（矩阵冻结 + radii×5={80,168,480}km 覆盖全程航迹 + 720m/s 平移）：

| 轮次 | 开 | 关 | 增量（非 snap 噪声地板） |
|---|---|---|---|
| 初版（管线污染后段） | 1.073% | 0.829% | **0.244%** |
| fix round（96/96帧） | 1.335% | 0.857% | **0.478%** |

- 地板两轮 0.24~0.48%（均值 ~0.36%）——**地板自身可能已超 0.3% 判据**。spec §1.1 预警（「0.3% 只剩 0.13% 余量」）兑现且更严峻：非 snap 地板（STBN jitter 每帧重随机化 + 消费端视差采样 + 层界 fade dither）与 snap 残余叠加，0.3% 判据在当前渲染/测量管线下无余量。
- 注意 E1' 在 texel 312.5m（scale=5）下测得；正常 texel 62.5m 频率更高，实际地板可能更高。

归因分解（以 fix round 地板 0.478% 计，矩阵相关残余 = 增量 − 地板）：

| 探针 | world 矩阵残余 | frustum 矩阵残余 |
|---|---|---|
| 平移 3 m/帧 | 0.31 | 0.72 |
| 平移 12 m/帧 | 0.17 | 0.44 |
| dolly 5 m/帧 | 0.68 | 0.87 |
| 轨道 1e-5 | 1.16（snap 跳格分量，§2.1 实测） | 0.85 |

### 2.1 轨道版 E1'（fix round 2 新增：区分「snap 跳格真闪动」vs 非矩阵地板）

`cloudsProbeOrbit=0.00001&cloudsShadowFreeze=1&cloudsShadowScale=5`（矩阵冻结 + 80km 膨胀盒 + 轨道）开/关 AB（70/67 帧，同批成对）：

| 组 | pct>20 均值 |
|---|---|
| BSM 开（冻结+膨胀） | 3.533% |
| BSM 关 | 3.193% |
| **轨道非 snap 地板** | **0.340%** |

**归因**：正常 world 轨道增量 1.496% − 地板 0.340% = **snap 跳格分量 1.156%（占 77%）——snap 分量实锤，world 在轨道工况负效坐实**。机理链（源码级）：`rotateLeft → rotate(camera.up, angle) → Matrix3.multiplyByVector(rotation, this.position)`——position 绕过地心的轴旋转，基准高度 7852m 下 1e-5 rad/帧 ≈ 63.8m/帧 ≈ c0 texel 62.5m，**world 每帧恰好跳一格**：每帧重 march + STBN jitter 相位重随机化，「整数 texel 平移双线性无损」的前提（相位延续）不成立。frustum 的 AABB center 慢变（30-90m/帧连续）snap 后隔数帧才跳，跳频更低 → 轨道下 world 反超 frustum 与此自洽。修复方向由此指向明确：**STBN 世界域索引（跳格帧 jitter 相位随网格平移延续）**，而非单纯加大 texel。

**处置建议（spec §7 首要风险行路径，基于立得住的论据）**：
1. E1' 地板可能自身超判据（move12 两轮 0.24/0.48、轨道 0.34——三工况地板 0.24~0.48%）；
2. 跨批绝对值不可比（frustum move3 旧值 0.17% 复现失败，系统性环境差）；
3. 轨道 snap 分量 1.156%（77%）——「每帧跳格 × jitter 重随机化」真闪动通道，world 轨道负效。
→ 或判据豁免/放宽（并按 2 重定义验收口径为同批成对），或立项 STBN 世界域索引 + 边界处理（针对 3 有明确修复靶点）+ 分档 radii（低太阳角）。

## 3. 静态 AB + 阴影存在性 + 低太阳角

- **world vs frustum 同视角静态截图**：>20/255 差异占比 0.77%、>50 占比 0.06%、均值 0.78/255——两模式画面几乎一致，差异集中于云影边界局部；无「阴影消失」级回归。
- **BSM 开 vs 关静态**（阴影存在性）：>20 占比 1.64%、>50 占比 0.24%——阴影效果存在，非全屏变化。
- **低太阳角近景**（`time=2026-08-29T00:45:00Z`、`camera=…,1400,68.8,-25`）：AI 读图——自阴影可见但很弱，**阴影边缘极度羽化弥散、云形结构糊成一团**（PCF 62.5m×6=375m 半影在 1.4km 近景下过软），低角度暖色传导不足。已知项：**分档 radii（spec §5 预案）确有必要，不在本计划**。
- **静止跳过 sanity**：§1 表首行（画面级确认 T5 render 跳过后 BSM 冻结零扰动；逻辑另有 T5 单测覆盖）。

## 4. 口径与已知项（诚实记录）

1. **跑钟专项降级未验**（spec §6 明示路径）：demo 无时钟参数，太阳静止已覆盖主验收；留待 `?cloudsClock=1` 立项再验。
2. **dolly 以 `cloudsProbeZoom=5` 等价实现**：手动滚轮不可脚本化；每帧 zoomIn 5m 为 preRender 域同模式，语义=沿视线缩放（真滚轮语义）。
3. **轨道探针口径**：brief 给的 0.0008 rad/帧在本机捕获率（~7fps）下每捕获帧位移 ~12px，画面整体滑动淹没闪动（关基线 23-27%）；降 200 倍至 1e-5 对齐上轮「准静止轨道」口径（关基线 2.6-3.3%——仍高于上轮 0.06%，见 4）。
4. **跨批绝对值不可比（fix round 确认）**：干净管线下 frustum move3 增量 1.197%，仍 6 倍于上轮门禁实验旧值 0.17%——**排除 tab 污染后复现依然失败**，属系统性环境差（捕获率 ~7-10fps vs 上轮 ~10fps、帧间累计 8-9 渲染帧位移、机器负载/DPR/浏览器状态）。结论：增量绝对值只在同批成对内可比；0.3% 判据的跨批复现需固定环境基线（后续验收建议：同批内附 frustum 对照组做锚）。
5. **测量管线坑（fix round 定稿纪律）**：agent-browser `open` 恒新开 tab，遗留 tab 跑 Cesium rAF+探针 → GPU 均摊 → 捕获率逐组劣化（实测 70→11 帧）；**纪律=每组 close 全关 + sleep 3 重开单 tab + 帧数门禁 ≥50（不达标作废重录）**，本 fix round 20 组全部一次过门禁（53-97 帧）。

## 5. spec §6/§7 对照结论

| spec 项 | 结果 |
|---|---|
| §6 四探针增量 <0.3% | ❌ 全部超标（world 0.65~1.50%；静止 ≈0.000% 达标） |
| §6 E1' 归因实验 | ✅ 已做（move12 两轮 + 轨道 fix round 2）：地板 0.24~0.48%，可能自身超判据 |
| §6 静态截图 world vs frustum | ✅ 无覆盖/精度回归（0.77% 局部差异） |
| §6 BSM on/off 静态 | ✅ 阴影存在 |
| §6 裸残余对照（cloudsShadowTemporal=0） | ✅ 全部组默认 temporal=false（裸路径） |
| §6 跑钟 | ⏸ 降级未验（§4.1） |
| §6 低太阳角 PCF | ✅ 已观察：过软（§3，分档 radii 预案确有必要） |
| §6 静止跳过 | ✅ 端到端 ≈0.000% |
| §7 首要风险（非矩阵地板） | 兑现且更严峻：地板 0.24-0.48%，0.3% 判据双层无余量 |

**总判定：验收执行完成、数据齐全（干净管线复测 + 轨道归因实验）；四探针目标不达标（DONE_WITH_CONCERNS）**。世界锚定静止完美、平移/dolly 工况矩阵通道削减 14-34%；**轨道负效坐实**（rotateLeft 实为 position 绕地心轴旋转 63.8m/帧 ≈ c0 texel → world 每帧跳格 × jitter 重随机化，snap 分量 1.156% 占 77%，反超 frustum 与此自洽；初版「固有视差」论述系事实错误已撤回）。生产代码未动（按 brief 约束）。后续动作待裁决（§2.1 三条论据）：判据豁免/重定义（同批成对口径），或 STBN 世界域索引/边界处理立项（修复靶点明确）+ 分档 radii（低太阳角近景软化）。

## 6. 复现命令

```bash
pkill -f vite; rm -rf apps/demo/node_modules/.vite; nohup pnpm dev > /tmp/vite-t6.log 2>&1 &
# 例：world 快速平移 BSM 开
# http://localhost:5173/?mode=atmosphere&clouds=1&time=2026-08-28T17:30:00Z&camera=-80.6057,64.5197,7852,68.8,-17.8&cloudsProbeMove=12
# AB 关基线：同 URL + &cloudsShadow=0；frustum 对照：+ &cloudsShadowAnchor=frustum
# E1'：+ &cloudsShadowFreeze=1&cloudsShadowScale=5
# 录屏纪律（每组）：agent-browser close → sleep 3 → open 单 tab → networkidle → 4s
#   → record start/stop 10s → ffmpeg -vf fps=10 抽帧 → 帧数 ≥50 否则重录
# 差分：PIL 相邻帧 |ΔL|>20/255 占比均值（脚本 $CLAUDE_JOB_DIR/tmp/t6r-*.py/sh）
```

---

## 附录 A：初版数据（测量污染，已被 fix round 覆盖，仅存档）

初版管线无「每组 close 重开」纪律：前 12 组录制时遗留 tab 逐步累积（15 tab 并跑 rAF+探针），捕获率从 70 帧劣化到 11 帧；后段重启浏览器恢复（64-101 帧）但非每组建制化。数据特征与 fix round 同向（四探针全超标），绝对值不可比。初版表：

| 探针 | world 增量 | frustum 增量 | 备注 |
|---|---|---|---|
| 静止 | 0.000% | – | 62/67 帧 |
| 轨道 1e-5 | 1.590 / 0.934（两测） | 1.373 | 0.0008 大位移组（开 27.43/关 23.49）位移淹没，弃 |
| 平移 3 m | 0.360 | 1.057 | |
| 平移 12 m | 0.641 / 0.911（两测） | 1.107 | |
| dolly 5 m | 0.725 | 未测 | fix round 补 F4 组 |
| E1' | 0.244 | – | 97/98 帧 |
