# Phase 1 验收结果：大气透视 MVP

> **日期**：2026-07-30
> **关联**：spec `../specs/2026-07-30-phase1-atmospheric-perspective-design.md` §7.2；计划 `2026-07-30-phase1-atmospheric-perspective.md` Task 9
> **状态**：⏳ 待项目方浏览器验收（无 GPU 环境无法自动跑）
> **分支**：`phase1/atmospheric-perspective`（T1-T8 已合并审查通过；debug=4 补充为 working tree 增量）

---

## 0. 前置

### 0.1 dev server

已启动：`http://localhost:5173/`（vite v6.4.3）。

### 0.2 ion token（不入库）

token 三级解析，优先级：`VITE_ION_TOKEN` 环境变量 → URL `?ionToken=` → 空（fallback 裸 globe）。

**推荐用 URL 参数**（最简单，无需重启 server，token 只在浏览器地址栏不入 git）：

```
http://localhost:5173/?mode=atmosphere&ionToken=<你的token>&...
```

无 token 时仍可验收天空/大气分支（裸 globe 椭球 + 后处理大气），只是没有 ion 影像/地形纹理。

### 0.3 URL 参数速查

| 参数 | 含义 | 示例 |
|---|---|---|
| `mode` | `atmosphere` / `sky` / `depth` | `atmosphere` |
| `ionToken` | ion 访问令牌 | （你的 token） |
| `time` | ISO8601，决定太阳方向（preRender 据此算 sunDirection） | `2026-07-30T06:30:00Z` |
| `camera` | `lon,lat,height,heading,pitch`（角度制） | `100,28,80000,0,-90` |
| `ab` | `a`（A 路径，默认）/ `b`（B 兜底对照） | `a` |
| `exposure` | 曝光（默认 3.0，地表接入后待重标定） | `3` |
| `albedoScale` | 反照率缩放（默认 1） | `1` |
| `debug` | 0 正常 / 1 log radiance / 2 太阳方向 / 3 相机位置量级 / **4 法线可视化** | `4` |

### 0.4 首要调参目标（spec §5.2 验收项）

`geometricErrorCorrectionAmount` 的标定常数 **41.5 / 13.8 绑定 three.js FOV 50°**，Cesium 默认 FOV 60° 下过渡带高度错位。结构正确且可通过参数覆盖，但**默认值需在 T9 重新标定**——这是验收时第一个要确认/调整的项。若太空 limb 干净但地平线法线噪声错位，多半是这个常数需重标定（暂用分段 amount 兜底也可）。

---

## 1. 验收用例 URL 清单

> 以下 `<TOKEN>` 替换为你的 ion token。视角选中国西南横断山区（lon=100, lat=28，有起伏利于看法线/光照）。time 选 UTC 06:30 ≈ 该地正午前后；用户可微调 time 观察太阳移动。

### 用例 A — 近地白天俯视（地表大气透视 + 远山雾化 + A 路径光照）
```
http://localhost:5173/?mode=atmosphere&ionToken=<TOKEN>&time=2026-07-30T06:30:00Z&camera=100,28,80000,0,-90
```

### 用例 B — 地平线平视（天空/地表无缝衔接 + 远山 B/R 比）
```
http://localhost:5173/?mode=atmosphere&ionToken=<TOKEN>&time=2026-07-30T06:30:00Z&camera=100,28,1500,0,0
```

### 用例 C — 太空视角（地球 limb 大气辉光弧 + amount≈1 法线干净）
```
http://localhost:5173/?mode=atmosphere&ionToken=<TOKEN>&time=2026-07-30T06:30:00Z&camera=100,28,15000000,0,-90
```

### 用例 D — A/B 对比（验证 A 未静默退化成 B）
- A：`...&camera=100,28,80000,0,-90&ab=a`
- B：`...&camera=100,28,80000,0,-90&ab=b`
（同 time/camera，对比地表亮度是否随太阳角变化：A 应变化、B 不变）

### 用例 E — 法线可视化（验证 R-P1-1 法线重建精度，**最高风险项**）
```
http://localhost:5173/?mode=atmosphere&ionToken=<TOKEN>&time=2026-07-30T06:30:00Z&camera=100,28,80000,0,-90&debug=4
```
对照：赤道平坦区法线应偏绿（+y）、极点偏蓝（+z）、向阳坡朝太阳色（debug=2 先看太阳方向着色）、背阳坡反向。

### 用例 F — 夜半球（spec R-P1-9 预期外观）
```
http://localhost:5173/?mode=atmosphere&ionToken=<TOKEN>&time=2026-07-30T20:30:00Z&camera=100,28,80000,0,-90
```
预期：夜侧近全黑（A 路径 dot(N,L)→0 使 irradiance≈0），非全黑到无法辨识即可。

### 用例 G — NaN/Inf 防护
任一上述用例 + 全屏扫一遍，确认无纯黑/纯白异常像素块（尤其地平线、视锥边界、地形边缘）。可叠加 `&debug=1` 看 log radiance 是否有突变。

### 用例 H — 双重大气检查
A 路径已写死 `showGroundAtmosphere=false` + `fog.enabled=false`。目检地表无额外雾霾叠加层即可（代码侧已杜绝双重大气发生）。

### 用例 I — Phase 0 回归（零劣化）
```
http://localhost:5173/?mode=sky
http://localhost:5173/?mode=depth
```
确认天空/深度调试分支与 Phase 0 行为一致（`logarithmicDepthBuffer=false`，走未改动的 SkyStage/DepthDebugStage）。

### 用例 J — 性能
1080p 下 `mode=atmosphere` 相对无 stage 基线帧率下降应 < 30%（记录项）。

---

## 2. 量化判据（spec §7.2，readPixels / 截图像素分析代理断言）

| 用例 | 量化判据 | 通过? | 备注/采样 |
|---|---|---|---|
| A 远山雾化 | 远距离采样带 B/R 比 > 近距离带 | ⬜ | |
| A/B 光照一致 | 向阳坡平均亮度 > 背阳坡；太阳高度角 20°→0° 时地表 R/B 比单调上升（**影像烘焙光照除外**——选平坦区验证） | ⬜ | |
| B 地平线衔接 | 地平线扫描线相邻像素最大梯度 < 阈值 | ⬜ | |
| C 太空 limb | 地球 limb 大气辉光弧连续、法线噪声在 amount≈1 下干净 | ⬜ | |
| D A/B 对比 | A 地表亮度随太阳角变化、B 不变化 | ⬜ | |
| G NaN/Inf | 全屏无异常 0/极值像素 | ⬜ | |
| E 法线可视化 | normalECEF*0.5+0.5 朝向符合赤道/极点/斜坡预期 | ⬜ | |
| I Phase 0 回归 | sky/depth 不劣化 | ⬜ | |
| F 夜半球 | 夜侧非全黑到无法辨识 | ⬜ | |
| J 性能 | 帧率下降 < 30% | ⬜ | |

---

## 3. 记录区（项目方填写）

每个用例：固定 URL + 截图 + 量化采样 + 判定（通过/失败）。

| 用例 | 截图路径 | 量化采样 | 判定 |
|---|---|---|---|
| A | | | |
| B | | | |
| C | | | |
| D | | | |
| E | | | |
| F | | | |
| G | | | |
| H | | | |
| I | | | |
| J | | | |

---

## 4. 已知风险/债务（验收时记录实际表现）

1. **amount 标定 41.5/13.8**（FOV 60° 需重标定）—— 用例 A/E 首要确认。
2. **exposure=3.0 占位值**只对天空定过标 —— 地表接入后可能需调（用例 A 看 exposure）。
3. **夜半球近全黑**（R-P1-9）—— 用例 F 确认是否可接受。
4. **半透明物体/3D Tiles 无深度**被天空判定吞掉 —— 源仓库同源问题，本 Phase 聚焦 globe/地形/影像。
5. **ion 影像烘焙光照与法线再照明冲突**（晨昏）—— albedoScale 缓解，验收注明"烘焙光照除外"。

---

## 5. 验收结论

- [ ] 全部量化判据通过 → Phase 1 验收通过，可 `finishing-a-development-branch` 合并
- [ ] 部分失败 → 记录失败项，回 T5/T6/T7 对应模块修复后复验
- [ ] amount 标定需调整 → 改 `geometricErrorCorrection.ts` 的 `GEO_ERROR_CORRECTION_NEAR/FAR` 或 URL 覆盖验证后再定值
