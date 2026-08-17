# 体积云 M4 temporal resolve——结果

> plan：`docs/superpowers/plans/2026-08-17-clouds-m4-temporal.md`（D1–D10 决策内嵌）
> spec：`docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md` §6 M4
> 时间：2026-08-17（单会话，main 直接开发，14 commits `b0a1ba4..dc79955`）

## 最终状态（一句话）

**temporal 双端全链路移植完成并验证可用，但云端 resolve 的收敛锁在静止场景不稳（velocity 含云前点 Bayer 相位跳动分量 + γ=2 宽 AABB 不裁错位 history → 明显高频抖动）——temporal/shadowTemporal 双默认关闭回退 M3 稳定行为（连拍差分 0.1% 完全静止），代码保留 `?cloudsTemporal=1`/`?cloudsShadowTemporal=1` 显式开启（1/4 分 march 120fps vs 全分卡死的帧率优势可体验），收敛修复留专门迭代。**

## 任务完成清单（T1–T8 全过 + 4 个追加修复）

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 | `temporalMath.ts`——Bayer 4×4 表 + jitter + reprojection 矩阵（three 逐字对齐） | ✅ 5 用例 |
| T2 | `CloudsResolveMaterial.ts`——cloudsResolve.frag 组装器（vUv 桥接 + 删 jitterOffset + TEMPORAL_UPSCALE 双分支 glslang） | ✅ 6 用例 |
| T3 | ShadowMaterial TEMPORAL_PASS 按原文加回（surgery 条件化）+ `ShadowResolveMaterial.ts`（sampler3D 手术单 cascade 化） | ✅ 8 用例 |
| T4 | `CloudsResolvePass.ts`——第二个 VOXELS primitive（**稳定外壳双实例 ping-pong**，swap 零重建） | ✅ 4 用例 |
| T5 | ShadowPass temporal——velocity 层双 attach（depth=2N）+ shadowResolve 逐 cascade + prevMatrices 编排契约 | ✅ 5 用例 |
| T6 | march 1/4 分（ceil(w/4) + resolution=lowRes\*4 + targetUvScale + mipLevelScale=0.25 + viewport）+ jitter 注入 ray 重建 + core viewport 选项 | ✅ |
| T7 | createCloudsStage 编排——preRender 开头 swap / frame 递增与**拆分绑定**（D7）/ jitter+reprojection 矩阵 / overlay bridge 切换 / URL 开关 | ✅ 22 用例 |
| T8 | demo URL 参数 + 技术 smoke | ✅ |

**测试**：core 271 + clouds 138 = **409 全绿**；双包 tsc 0；demo tsc 0。

## 4 个追加修复（实施/用户验收中抓出，全部测试固化）

1. **BSM resolve feedback loop**（用户报 GL_INVALID_OPERATION）：生成段给 att1 挂 velocity 层后 resolve 沿用同 FBO——att1 残留 bsmTexture 与 resolve 采样的 inputBuffer 同对象成环，**Chrome 静默吞 draw（BSM resolve 从未真正执行）**。修：生成/resolve 分用两个裸 FBO。静止不报是因为 requestRenderMode 无渲染帧。
2. **云消失双根因**（用户报无云）：① T8 排序护甲的固定地心球被 `createPotentiallyVisibleSet` 的 frustum 段区间分配全灭（plane distance 负 → 与任何段不相交 → VOXELS 桶恒 0，march+resolve 全不画）；② resolve viewport 未设继承 march 低分 viewport（只写全分纹理左下 1/16）。修：护甲球**每帧跟随相机**（[-1,+1] 恒交第一段恰好 1 次/帧，顺带消除 multi-frustum 重复执行浪费）；resolve 显式全分 viewport。
3. **静止抖动根因**：低分 march 的 `gl_FragCoord`（低分 viewport 域）直喂期望全分窗口域的 `czm_windowToEyeCoordinates` → NDC 系统性偏 4× → velocity 恒错 → history 错位拉锯。修：`gl_FragCoord.xy / targetUvScale` 域换算（非 temporal 恒等零回归）。
4. **终局回退**：域修复后抖动 10.2%→12–16% 波动——残余是 velocity 的 W 相位跳动分量 + γ=2 宽 AABB 的收敛锁建立不起来（three 同款噪声、参数组合在我们云对比度下不稳）。**决策：双默认 false**。

## 新踩坑清单（M5/M6 及通用必读）

- **GLSL ES 3.0 无 `texelFetchOffset(sampler3D)` 重载**（桌面 GL 才有，glslang ES 实测）→ 组装层后处理换 `texelFetch(S, P + ivec3(off, 0), 0)`
- **varianceClipping 宏体系**：include 前重定义 VARIANCE_SAMPLER 会与展开后 `#ifdef VARIANCE_SAMPLER_ARRAY` 块冲突 → 保留原文 ARRAY 宏 + include 展开后后处理换 sampler 类型
- **voxels pass 多 command**：`backToFront` 排序读 boundingVolume（单 command 不触发比较、多 command 炸）+ `createPotentiallyVisibleSet` 对**有** boundingVolume 的 command 做段区间剔除（cull 未设不剔除但 near/far 区间照算）——**正确姿势：跟随相机的共享等距球**
- **Cesium RenderState viewport 为 undefined 时不动 GL viewport**——低分 pass 后跟的全分 pass 会继承错误 viewport
- **vite 对 workspace 包的模块级缓存不可靠**（部分文件改动生效部分不生效，重启也不保证）——改包源后必须 `rm -rf apps/demo/node_modules/.vite` + 重启；**诊断前提：先确认探针真在跑（TS 层计数非 null）**
- **测量方法论**：抖动量化必须**连拍逐对差分**（单对会采到运气窗口假低估）；readPixels HALF_FLOAT 纹理的组合检查可能 502 静默返全 0（先查 IMPLEMENTATION_COLOR_READ_TYPE）
- **glslang 编译测试「全量超时、单跑过」** = 环境残留进程（Chrome/vite 常驻 50+）抢核，pkill 后全绿——勿误判代码回归

## 验收记录（2026-08-17 用户参与）

- Feedback loop：修复后 flyTo 双程 0x502 归零 ✅
- 云消失：修复后 VOXELS 桶 [2]、云形恢复 ✅
- 静止抖动：用户两次报告明显抖动 → 域修复减半未除根 → 回退默认关后连拍 0.1% 完全静止 ✅
- temporal=1（显式开）：2137m 视角 120fps（vsync 顶格）vs 全分卡死——帧率优势一个数量级 ✅
- 默认（M3 行为）：云/自阴影/大气全部正常，水下视角等既有回归无恙 ✅

## 已知限制与后续

- **temporal 收敛修复**（专门迭代）：方向——① velocity 相位差纯化（reprojection 用 jittered 采样点语义对齐 three 的投影注入推导）② 自适应 AABB（variance 按对比度缩放）③ upscale 分支加 temporalAlpha 混合。修好后翻转默认值即可（单行）。
- resize 仍不处理（M2 起已知限制，M6）。
- BSM temporal 机制已验证可用（shadowTemporal=1），默认随云端一起保守关闭。
- 云演化（weather scroll）区 temporal 糊为 spec 已知限制。

## 下一步

- **M5 云 god rays**（SHADOW_LENGTH hook 预留 + higher-order LUT 已加载；spec 前置核实：跑 three demo 确认 lightShafts 视觉达标）
- M6 地形交互 + 质量预设 + 集成
