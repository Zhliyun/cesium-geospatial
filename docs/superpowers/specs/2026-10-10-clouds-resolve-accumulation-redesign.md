# 体积云 resolve 时域累积重写（N>1 降分路线）

- 日期：2026-10-10
- 状态：立项（r1 draft）
- 起因：用户拍板上游路线（降分 march 保性能），但 N>1 静止画面出现密集白/黑方块，上游同条件干净
- 关联：[F2 march RT 超分 spec](2026-10-09-clouds-march-supersampling-design.md)、worktree `worktree-f2-supersample`

## 1. 问题陈述（量化）

**现象**：N=4（1/16 像素降分 march + temporal upscale）静止时画面出现密集白/黑方块；同机位 N=1（全分）无此现象。用户真机目验证实，上游 storybook 俯视对照无此现象。

**量化口径**：钉 `?time=2026-09-21T11:30:00Z&play=0`，同一页面加载内连拍两帧，像素差分（|Δ|>8 计为变化）：

| 配置 | 帧间差分 | maxD |
|---|---|---|
| **上游 storybook（300m 视角，cov 0.30）** | **0.83%** | 44 |
| 我们 N=4 11470m cov0.45（缺省） | 33.2% | 181 |
| 我们 N=4 11470m cov0.30 | 11.3% | 172 |
| 我们 N=4 11470m cov0.20 | 3.6% | 172 |
| 我们 N=4 421m cov0.30（近景，最接近上游条件） | 12.4% | 158 |
| 我们 N=4 + `frameUnfreeze=0` | **0.016%** | 173 |
| 我们 N=1 421m（参考） | 待测 | — |

**关键**：闪动与云覆盖率强相关（0.45→29.6%、0.30→11.3%、0.20→3.6%），但与上游在任何可比条件下都差 13-15 倍。

**闪动的两条通道**（`frameUnfreeze=1` = 静止时也递增 marchFrame，白点治理机制）：
- STBN 相位轮换：贡献 ~1.6%（`cloudsUnfreezeMip=99` 冻结后仍 31.6%）
- **jitter 相位轮换：贡献 ~31.6%**（`frameUnfreeze=0` 同时冻结两者 → 0.016%）

## 2. 已完成的调查（排除清单，全部实测）

| 环节 | 结论 | 证据 |
|---|---|---|
| despeckle 坐标域 / resolve RT 尺寸 | 已修（真 bug），非本问题 | `7d2fdac`，修复后分界线消失 |
| jitter 相位冻结 | 已修（`17d01d5`），**代价是暴露本问题** | 近景方块消失，远俯闪动 33% |
| α mix（上游 upscale 分支无 mix） | 非主因 | α=0 → 28.6%；α=0.5 → 39.1% |
| disocclusion rejection（上游无） | 非主因 | 禁用 → 27.9% |
| `getClosestFragment` 同质守卫（上游纯 closest） | 非主因 | 纯 closest → 29.6% |
| AABB 宽度 γ | 非主因 | γ=10 → 33.9%；γ=0.001 → 29.5% |
| despeckle | 非主因 | 关闭 → 34.5% |
| STBN 相位分域 | 非主因 | mip=99 冻结 → 31.6% |
| **三处「我们独有」的 resolve 改动全关（最大程度上游语义）** | **仍 29.6%** | `α=0 + disocclusion=1.01 + 纯 closest` |

**上游 resolve 逐行对比结论**：上游 `temporalUpscale` = `texelFetch current` → Bayer 直通 → `getClosestFragment`（纯 closest）→ `prevUv` 越界 rejection → `varianceClipping` → **`outputColor = clippedColor`（无 mix）**。我们比它多三处（上一表），全部排除。

**velocity 调查**：
- 静止相机下未命中分支 velocity 实测 ~77px（应≈0）；`frontDepth ≈ 1e5`（cameraFar，量级正常）
- 排除：ray 坐标域（`czm_viewport` 探针实测为低分，与 `gl_FragCoord` 一致）、jitter 幅度（±2px，与上游 bayerOffsets 逐值相同）、矩阵构造（`elements[8]/[9]`，上游同款）、`vViewPosition` 语义（归一化差异被齐次除法抵消）
- 尝试修 `frontDepth` clamp（1e5）→ **42.3%（更差）**；无云像素 velocity 置 0 → **39.2%（更差）**——原 77px 会触发越界 rejection 直出 current（变相保护），修小反而进入有效区间错采 history

**探针读数**：`current`（march 原始输出）帧间变化 **78.6%**；最终输出 33%——即 **resolve 只把变化压缩 2.4 倍，上游压缩 ~94 倍**（假设上游 current 变化量级相近，**待测**）。

## 3. 决定性取证结果（2026-10-10 已完成，原「核心未知」已解答）

**上游 march current 帧间变化 = 4.44%**（临时改上游 `shaders/cloudsResolve.frag` 直显 `currentColor` 后连拍差分，maxD 72；上游最终输出基准 0.83%，即其 resolve 压缩 5.3×）。

**我们 march current 帧间变化 = 17.1%（cov0.45）/ 16.4%（cov0.30）**（主路径探针直显实测；最终输出 33%/11.3%）。
〔勘误：早期分区探针读数 78.6% 失真——分区直显把 history 写成 current 再回写，干扰读数，已弃用；**探针必须整帧替换，且注意早退分支会绕过**。〕

→ **结论：两侧都有差距，拆解为 march 侧 3.7× × resolve 侧 2.2×**：
- **march 侧**：我们 current 16.4%（cov0.30）vs 上游 4.44% → **3.7 倍**
- **resolve 侧**：我们压缩 2.4×（17.1→33 不成立，实际 33/17.1 表现为放大；以 cov0.30 计 16.4→11.3 为 1.45×）vs 上游 5.3×（4.44→0.83）→ **~2.2 倍**
- 叠加 ≈8 倍，与观察到的上游 0.83% vs 我们 11.3%（同 cov0.30）的 13.6 倍同量级

**注意**：我们 current 对覆盖率不敏感（16.4% vs 17.1%），而上游输出对覆盖率敏感 → **覆盖率的效应发生在 resolve 侧**（云缘像素占比决定被时域平均的暴露面）。

**jitter 是主要贡献源**（JS 侧把 `params.temporalJitter` 置 0 后实测）：最终输出 **33.2% → 7.28%（-78%）**。

**但 jitter 幅度本身正常**：探针直显 `|temporalJitter|×1000` 读数为 0.4（经 tonemap 显示为亮黄——**读数需按 ACES+gamma 反推，勿直读像素亮度**）→ 实际值 ≈0.0004，与上游公式（`(offset-0.5)/lowResW`）、bayerOffsets（`(i%4+0.5)/4`，值域 [0.125,0.875]）**逐值一致**。

→ **推论：同幅度的 jitter 在本仓库 march 内造成 17 倍于上游的输出扰动 → 敏感度异常的根源在 march 内部**。

**下一步排查清单（march 特有加码，本仓库独有）**：
1. 段长/8 clamp（`clouds.frag` 主 march 循环内）
2. 层内禁早退完整横穿 + 步数上限（同上）
3. shape 显式 LOD（E2：`textureLod(shapeTexture, shapePosition, mipLevel*1.5)`；上游为隐式 `texture()`——**隐式 LOD 在低分 march 下 LOD 更高=更平滑**，会诊曾指出这是上游低颗粒的真因之一）
4. 软化 T 门控（`mix(outAlpha, outAlpha*0.80, softenGate)`）
5. `u_hitStepMipBoost`（甲内步 mip 调制，2026-09-04 引入）

**排查方法**：逐个临时停用 → 用「current 帧间差分」探针（本 spec 已建立的口径）判定贡献度；注意每项都是修历史 bug 的改动，停用只作诊断，正式修复需另设计。

**探针工程坑（今日两次踩）**：① shader 内删 uniform 使用项 → uniform 被 GLSL 优化移除 → 与 uniformMap 冲突 → **整页白屏**（诊断请改 JS 侧置值，勿删 shader 项）；② 探针值读数必须经 tonemap 反推（线性 0.4 ≈ sRGB 0.68）。

## 3.1 基础噪声发现（第二个独立线索，2026-10-10）

把 jitter 置 0（JS 侧）**且** STBN 冻结（`cloudsUnfreezeMip=99`）后，云区输出仍每帧变 **6.06%**（同条件 cov=0 全无云仅 **0.169%**）。

→ **march 输入完全确定的情况下，云区输出仍在抖动** → **resolve 自身在确定输入下产生 ~6% 帧间变化**。这与「march 对 ray 微扰敏感 3.7×」**并列，是两个独立问题**。

**2026-10-10 追加（v7/v8 探针）**：
- v7 整帧直显 `historyColor` → 19.1%（形成 `history ← reproject(history)` 自循环，静止+jitter=0 下本应恒等 0%）→ **重投影非恒等**
- v8 整帧直显 `|depthVelocity.gb|×50` → **云区 velocity ≥ 0.02 UV（~77px）**（静止 + jitter=0，应 0）

→ **世界域重投影有明显错位，是 6% 基础噪声的直接来源**。相关代码：命中分支 `frontPositionWorld = ecefToWorld(frontPosition)` → `reprojectionMatrix × vec4(frontPositionWorld, 1.0)`（`reprojectionMatrix` 在 JS 侧由 `camera.viewMatrix` / `camera.frustum.projectionMatrix` 构造，见 `temporalMath.ts::buildReprojectionMatrices`）。本仓库 `worldToECEF = identity`（矩阵域已是 ECEF），故 `ecefToWorld` 非问题点。

**下一步（可直接接手，约 30-60 分钟）**：核对 **JS 侧 `camera.viewMatrix` / `camera.frustum.projectionMatrix`（preRender 时刻快照）与 shader 侧 `czm_view` / `czm_projection` 的一致性**——Cesium 可能在 preRender 之后更新相机矩阵，或 multi-frustum 分段使 shader 的 `czm_*` 与 JS 快照不同源；若不同源，构造 reprojectionMatrix 用的矩阵与渲染用的矩阵不一致 → 重投影系统性错位。验证手段：把 JS 侧矩阵作为 uniform 传入，shader 内与 `czm_view` 逐元素比较直显差值。

**2026-10-10 v9/v10 探针结果（矩阵一致性）**：
- JS `camera.viewMatrix` vs shader `czm_view`：**完全一致**（差值 ×1000 全黑）→ 排除「矩阵快照/域不同源」
- JS `camera.frustum.projectionMatrix` vs shader `czm_projection`：**有 ~2e-4 的最大元素差**（未命中区深红）→ 很可能是 Cesium **multi-frustum 分段矩阵**与 JS 完整投影矩阵的**深度项（m22/m23）差异**

→ 投影矩阵的 xy 项通常与 near/far 无关（只与 fov/aspect），故**深度项差异是否传导到 velocity 的 xy 需下一步单独探针确认**（例如只比较 m00/m11/m02/m12）。若确认 xy 一致，则 77px 的源头仍在别处（下一步检查 `ecefToWorld` 的转换矩阵实际取值、以及 `cameraPosition`/`rayDirection` 的域一致性）。

**2026-10-10 v12 探针（**勘误**）**：v8 的 velocity 探针**只在未命中分支**（云区走正常渲染，图上云区显示的白色是云本身、不是探针值——**此前「云区 77px」的判读有误**）。补测**命中（云）分支**：velocity 实测**小**（青色，|v|×50 < 1）→ **velocity 两侧均正常，排除**。

→ **6% 基础噪声的来源仍未定位**。累计排除：velocity（双侧）、view/projection 矩阵一致性（view 完全一致、projection 差异仅在深度项不影响 NDC.xy）、jitter（JS 置 0 后仍 6.06%）、STBN（冻结后同值）、despeckle（开关无差）、云内容维度（覆盖率/质量档/shapeDetail/密度低通全排除）。**下一步建议**：整帧直显 `clippedColor`（AABB 输出）与 `outputColor`（最终输出）分别连拍，判定 6% 是否来自 varianceClipping 的 AABB 逐帧移动（在确定输入下，AABB 若只依赖 current 邻域则应稳定——若仍在动，说明邻域采样本身引入了帧间差）。

**2026-10-10 v13 探针**：整帧直显 `clippedColor`（jitter=0 + STBN 冻结，march 输入确定）→ **11.2%**（大于最终输出的 6.06%）。

→ 数学上 `h_{n+1} = clipAABB(mean, h_n, min, max)` 应在**一步内收敛**（h 在 AABB 内 → 返回自身；在外 → clamp 到边界后下一步即稳定），故 11% 的持续变化**与理论不符** → **history 链的实现问题是 6% 基础噪声的当前最强嫌疑**。JS 侧 `CloudsResolvePass.swapBuffers` 三引用轮换与 `colorHistoryBuffer` 闭包绑定**代码上已核查正确**。

**下一步（可直接接手，约 20-30 分钟）**：把 `historyColor` 的采样从 `texture(colorHistoryBuffer, prevUv)`（bilinear）临时改为 `texelFetch(colorHistoryBuffer, ivec2(vUv * texSize), 0)`（点采样）做对照——若 11% 显著下降 → 定位为**重投影插值抖动**（prevUv 的亚像素偏移在 bilinear 下每帧取到不同混合比）；若不变 → 转向 Cesium PostProcess/primitive 的纹理绑定时机与本帧渲染顺序的交互（swap 在 preRender 开头 vs resolve 在 VOXELS pass 实际执行之间可能有其他消费者）。

**2026-10-10 v14 对照（插值方式排除）**：history 采样 `texture()`（bilinear）→ `texelFetch()`（点采样）→ **8.21%**（比 bilinear 的 6.06% 更差）→ **重投影插值抖动排除**（点采样反而更差，说明 bilinear 的平滑在起正向作用）。

**6% 基础噪声的当前状态（累计排除）**：velocity（未命中/命中双侧）、view/projection 矩阵一致性（view 完全一致、projection 差异仅深度项）、jitter（JS 置 0 后仍 6.06%）、STBN（冻结后同值）、despeckle（开关无差）、history 插值方式（texelFetch 更差）、云内容维度（覆盖率/质量档/shapeDetail/密度低通）。**剩余嫌疑**：Cesium 渲染链的时序交互——march 写 `colorBuffer` → resolve 读 → overlay 读 resolve 的链路上任一环的纹理绑定/执行顺序偏移，或 BSM/shadow 端更新间接影响（`freezeActive || changed || shadowTemporal` 分支）。

**2026-10-10 v15/v16 探针（结论与一处反转）**：
- **v15** 整帧直显 `|history − current|×5` → 全屏有色。**但此读数不能证明不收敛**——在 AABB 内 `history ≠ current` 属预期（`clipAABB` 返回 history 而非 mean）。**真正的异常证据是 v7 的「history 帧间变化 19%」**（输入确定下）。
- **v16** 主路径输出强制固定常量 `(0.5,0.5,0.5,1.0)` → 帧间仍变化 **43.4%**，且画面**仍是「云 + 黑块」而非平色** → **该实验读数不可靠**（固定输出触发其他路径或被覆盖，探针未达成隔离）。

→ **插桩路线在此止步**。v16 的反常提示：**resolve 主路径的输出可能不是画面云区的唯一来源**（早退像素/其他 stage 的影响力此前被低估）。

**下一步（可直接接手，建议先做这一步再续插桩）**：**直显「主路径 vs 早退分支」的空间掩码**（如主路径输出绿色、`currentFrame` 直通输出红色、rejection 输出蓝色）——先确认画面云区中走各分支的像素比例，再决定在哪个分支插桩。若云区大部分走早退分支，则 6% 基础噪声与「AABB/history 链」的关系需要重新评估。

**2026-10-10 v17 分支掩码（插桩点确认）**：主路径染黄、早退分支（Bayer 直通/越界/rejection）保持原输出 → 实测**主路径占画面绝大部分（~80-90%）**。

→ **主路径是云区的主要来源，此前在 `temporalUpscale` 主路径插桩是正确的**；v16 的反常（固定输出后画面仍非平色）更可能是早退像素集中在**云缘高频区**的视觉放大（占比小但位于高对比处）。

**下一步（可直接接手）**：验证 history 纹理内容是否为「上帧输出」——建议做法：主路径输出编码一个每帧交替的标记（如 `frame%2`），并在 history 采样后直显 `historyColor` 的对应通道，**在同一帧内用两次截图对照**（或用 readPixels 逐帧读取）判定 history 是「上帧值」还是「同帧值」；若为同帧值 → ping-pong/绑定链错位坐实。

**2026-10-10 v18 标记验证（history 链缺陷坐实）**：主路径输出改为 `vec4(frame%2, historyColor.r, 0, 1)`：

- **绿色 (R=0, G=1)**：history.r = 1 = 上帧标记 → 该区 history 正常
- **黑色 (R=0, G=0)**：history.r 与当前标记相同 → **未读到上帧输出**

实测画面**绿+黑混合，且黑色区域对应云的位置**；云区像素**走主路径**（其输出已是标记），故其下帧 history.r **本应为 1，实测 0** → **云区的 history 确实未读到上帧主路径输出**。

〔设计缺陷说明〕早退分支（Bayer 直通/越界/rejection）未一并染色，故非云区的绿/黑判读不可靠；但**云区部分（主路径）的结论有效**。

→ **history 链在云区存在实质缺陷**。代码层已核查无果（swap 三引用轮换、`colorHistoryBuffer` 闭包、ping-pong 对齐，v9-v14），缺陷指向 **Cesium primitive 运行时执行顺序或纹理绑定状态**（非源码逻辑）。

**下一步（可直接接手）**：改进标记实验——**所有分支统一输出标记**（在 `main()` 里对最终 `outputColor` 覆盖 `outputColor.r = mod(float(frame), 2.0)`），使 history 全为标记；再直显 history 逐帧比对，即可无歧义判定 history 落后几帧或从未更新。若确认为「从未更新」→ 检查 resolve primitive 的 FBO 是否真的指向 `resolveTex`（`createVolumetricPrimitive` 的 `mrtColorTextures` 在 swap 后是否随引用轮换更新——**外壳 `shell` 转发的是 `resolvePrim`，但 FBO 在创建时绑定，swap 只换引用**，此处需实证）。

**2026-10-10 v19 运行时探针（未完成，附坑）**：实现了 `window.__cloudsProbeMark` 驱动的运行时切换探针（uniform 控制、无需重编译：0=正常 / 1=输出帧标记 / 2=直显 history.r），两阶段切换本身成功（`page.evaluate` 正常返回），但**画面白屏**——新 uniform 的引入导致渲染中断，未取到读数。

**坑记录（新增 uniform 类探针必读）**：给 resolve shader 新增 uniform 时需同步确认 Cesium 的 uniform 绑定路径；本次经 `globalThis` 闭包注入即中断渲染。**教训：探针改动应分两步冒烟**（先只加 uniform 与绑定、确认画面正常，再加逻辑），一次性引入「新 uniform + 新逻辑」会掩盖失败原因。

**下一轮建议**：重做 v19 时先验证 uniform 冒烟，或改用**已有的 uniform 复用**（如以 `u_spatialDespeckle` 的特定值编码探针模式）规避新增绑定。

**2026-10-10 v20 运行时探针（成功取到读数）**：改用**复用已有 `u_spatialDespeckle` 编码**（2 = 主路径输出统一帧标记 / 3 = 直显 `history.r`，despeckle 条件排除 >1.5 的值），同页面两阶段切换成功（`page.evaluate` 设置 `window.__cloudsProbeMark`）。

**读数**：画面 = 红色（`history.r`=1 = 上帧标记，链正常）+ **黑色（`history.r`=0）**，**黑色区域呈云形** → **云区像素的输出未进入 history**（v18 结论在干净设计下复现）。

**与 v17 形成的关键矛盾**：v17 掩码显示**主路径占画面 80-90%（含云区）**，但本探针显示**云区像素未写入标记** → 理解为：**云区像素虽走主路径，其输出却未进入下一帧读到的 history** → 问题不在「分支选择」，而在 **resolve 输出纹理的写入与下一帧 history 读取之间的对应关系**（纹理轮换/绑定在运行时未如源码逻辑那样对齐）。

**新增工程坑（本轮）**：新增 uniform 会导致整页白屏（v19）；**复用已有 uniform 编码探针模式**是可行替代（v20 成功）。探针请优先复用现有 uniform。

**下一轮建议**：在 `CloudsResolvePass` 的 `swapBuffers` 前后用页面内脚本打印/比对 `resolveTex`/`historyTex` 的 `_texture` 句柄（JS 侧可访问），验证运行时轮换是否与源码逻辑一致——若句柄未随 swap 更新，即坐实轮换失效。

**2026-10-10 v21 决定性发现：history 落后 2 帧（swap 时机差一帧）**

两个探针合起来锁定根因：

1. **swap 句柄检查**（`swapBuffers` 内比较 `resolveTex._texture` 与上帧值并写入 `document.title`）→ **`SWAP-CHANGED`** → 纹理轮换**每帧确实发生**（排除「轮换失效」）。
2. **标记读数反推落后帧数**（v20 的 `frame % 2` 标记 + `history.r` 直显）：
   - 落后 **1 帧** → 画面应为**红或绿**（R ≠ G）
   - 落后 **2 帧** → 画面应为**黄或黑**（R = G）
   - **实测为黑** → **history 落后 2 帧**

→ **根因：resolve 写入的纹理与下一帧被读作 history 的纹理错位一帧**。`swapBuffers` 在 **preRender 开头**执行，而 resolve 的实际渲染发生在该帧更晚，「本帧写入的纹理」要到「下下帧」才被当作 history 读取。

**修复方向**：将 `swapBuffers` 移到本帧渲染完成之后（Cesium `postRender` 钩子），或与渲染顺序严格对齐的等价时机（参考上游：three 的 `render()` 内 render 完 resolve 才 swap）。修复后复测预期：**11470m cov0.45 帧间差分从 33% 显著下降**，接近 `frameUnfreeze=0` 的 0.016% 量级（余下为 jitter 项）。

**下一轮（修复 + 验证，约 30-45 分钟）**：①swap 移至 postRender 或按渲染顺序重排；②用 `frame%2` 标记复测（读数应从「黑」变「红/绿」）；③测 11470m 帧间差分确认下降。

**2026-10-10 v21 结论修正（同一晚，更严谨的解读）**：`SWAP-CHANGED` 确认轮换正常；但**「落后 2 帧」的推论不能解释 v20 读数中的「同一帧内红+黑混合」**——「落后 N 帧」模型下，同一帧的 history 内容应**全屏统一**（全红或全黑），而实测是混合。

→ **当前最佳模型：resolve 输出的部分像素未写入 history 纹理**（混合 = 部分像素的 history 停留在更早内容），而非时序落后。可能原因：写入/读取的纹理在**部分区域**不对应（纹理尺寸或视口不匹配导致部分区域未覆盖），或 resolve 的绘制只覆盖了画面的一部分（与 v17「主路径占 80-90%」的分布形态吻合——**未写标记的区域正是那 10-20% 非主路径像素**）。

**下一步（明确）**：直显「写入标记的像素 vs 未写入的像素」的空间分布（v20 的 `history.r` 直显即为该分布），与 v17 的分支掩码（主路径 = 黄）逐像素比对——**若两者互补，则「history 未更新」等价于「早退分支像素不写 history」，是设计使然而非缺陷**，此路线的 6% 基础噪声就应转而从「早退分支占比」入手（降低早退比例 / 让早退像素也参与累积）。

**2026-10-10 v22 双通道对照（该问题的第三次独立确认）**：同一帧内输出 `vec4(mod(frame,2), historyColor.r, 0, 1)` → 读数 = **绿 + 黑**（**无红、无黄**）：

- **绿 (R=0, G=1)**：`history.r` = 1 = 上帧标记 → 该区 history 链**正常**（非云区）
- **黑 (R=0, G=0)**：`history.r` = 0 → **未收到上帧标记**，且**黑区呈云形**

**画面无红/黄** 说明**早退像素几乎不存在**（早退像素的 R 会是 current 的红通道值，不是 0/1 的纯色）→ **前述「早退分支不写 history」的假设被排除**。

→ **history 部分未更新，且集中在云区**（三次独立确认：v18/v20/v22）。**现象确凿，但云区与非云区在 resolve 链上找不到对应的代码分支差异**（探针模式下 rejection 条件也不触发：探针输出 a=1 与 history.a 差异为 0）。

**接手建议**：下一步应怀疑**更底层**的机制——例如云区像素的 `depthVelocity.r`（云距）与 `getClosestFragment` 的交互使 `prevUv` 落到纹理外（越界 → 直出 current → 不写标记，但画面仍显示正常的云），或 resolve pass 的绘制在云区被其他 pass 覆盖。**验证思路**：直显 `prevUv` 是否越界（`step(0.0, prevUv.x) * step(prevUv.x, 1.0)` 类的掩码），与黑区分布比对。

**2026-10-10 v23（prevUv 越界假设 → 排除）**：整帧直显越界掩码（越界=红、未越界=绿，经 `?cloudsDespeckle=4` 触发）→ 实测**画面几乎全绿**，红色仅出现在画面边缘 1-2 像素（属正常行为）。

→ **云区像素的 `prevUv` 并未越界** → 「越界 rejection 导致云区不写 history」**排除**。

## 3.9 今日收尾状态（2026-10-10，26 轮实验）

**已确证的现象**：resolve 的 history 在**云区像素上未收到上帧输出**（v18/v20/v22 三次独立确认，黑区恒呈云形）。

**已排除（12 类，全部实测）**：swap 轮换（`SWAP-CHANGED` 运行时确认）、早退分支（v22 无红/黄）、**prevUv 越界**（v23）、view/projection 矩阵一致性、velocity（双侧）、jitter 相位、STBN 相位、despeckle、history 插值方式（texelFetch 更差）、云内容维度（覆盖率/质量档/shapeDetail/密度低通）、march 特有加码中可验者、AABB γ。

**未解释**：云区与非云区在 resolve 链上找不到对应的代码分支差异。

**接手建议（下次开场直接执行）**：

**2026-10-10 v24（触发条件锁定，接手建议 1 已完成）**：模式 5 直显 `currentColor.a` → 画面 = 黑（a=0 天空）+ **白（a=1 浓云）** + 灰（云缘）。

**与 v20 黑区比对：v20 的「history 未更新」区 ≈ v24 的浓云区（a ≈ 1）** → **触发条件 = 云的不透明度 a ≈ 1**。

**与 disocclusion rejection 的关联（当前最强假设）**：`|currentColor.a − historyColor.a| > 0.5` 在「浓云（a=1）+ history 未建立（a=0）」时**恒触发** → 若 rejection 像素的输出未写回 history，即形成**自持死锁**（永远 rejection、永不累积）。代码上 rejection 分支的输出会写入 resolve RT（→ 下帧 history），故死锁的前提是「该写入未生效」——这与 v18/v20/v22 的观测互为印证。

**下一步（约 30 分钟）**：验证 rejection 像素的输出是否写入 history——把 rejection 分支的输出改为显著标记（如 `vec4(0.0, 0.5, 0.0, 1.0)`），观察下一帧该像素的 history 是否随之变化；若不变，即坐实「rejection 分支的输出未进入 history」，修复方向随之明确。

**备用路径**：用 WebGL 调试工具（Spector.js 类）逐 draw call 检查 resolve pass 的实际渲染目标与写入范围（超出截图探针能力）。
1. 在 upscale 分支**整帧**直显 `historyColor`（重投影后的 history）→ 连拍差分：
   - history 也在变 → **重投影 / ping-pong 写入链**问题（查 prevUv 与 swap 时序）
   - history 稳定而输出变 → **AABB / 混合链**问题
2. 探针须整帧替换（**分区探针会把 history 写成 current 造成读数污染**，见勘误）；jitter 置 0 用 JS 侧（shader 删项会崩）

## 3.2 云内容维度已全排除（2026-10-10）

| 对照 | 读数 | 结论 |
|---|---|---|
| cov=0（全无云） | 0.169% | 抖动纯属云区 |
| cov 0.20 / 0.30 / 0.45 | 3.6% / 11.3% / 33.2% | 云缘像素占比决定暴露面 |
| 质量档 medium / high / ultra | 23.5% / 33.2% / 36.0% | **采样越多越闪**（精确 march 更如实反映 ray 微扰） |
| shapeDetail=0 | 34.1% | 高频密度细节非主因 |
| weatherBias=2（密度低通） | 27.6% | 轻微，非主因 |
| jitter=0 | 6.87% | jitter 是主贡献（-79%） |
| jitter=0 + STBN 冻结 | 6.06% | **基础噪声，见 3.1** |

- **A（取证）**：测上游 current 的帧间变化 → 分流 march 侧 / resolve 侧
- **B（march 侧方案）**：审查并对齐 march 特有加码；若 jitter 敏感性来自「低分 + 我们的采样序列」，考虑 jitter 幅度标定（对当前场景降幅）
- **C（resolve 侧方案）**：按上游重写累积链（长窗 IIR + 16 相位完整注入），可能需要改变 history 的写入/读取时序（怀疑累积被某些路径绕过）
- **D（兜底门控）**：N>1 仅在近景/静止满足条件的域启用（F2 spec 方案 A 的按需触发形态）

## 5. 验收门

1. **11470m cov0.45 帧间差分 ≤ 5%**（对齐上游量级；现 33%）
2. 四基准机位（421m/3021m/11470m/太空）无画质回归
3. 帧时不高于 N=1 同机位
4. 运动帧（转动相机）无拖影回归

## 6. 风险

- **场景不可比**：上游 storybook 无地形（海面+天空），我们有地形山脉——云缘占比与背景对比度不同，可能影响可见度而非机制
- **云形态/天气场差异**：我们自研烘焙天气场 vs 上游纹理，云缘的密度梯度不同 → 对 jitter 的敏感度不同
- 上游 storybook 用 `setPixelRatio(devicePixelRatio)`（与我们相同），但分辨率/覆盖率可调 —— 需锁定同参对照

## 7. 前置与工具

- 帧间差分脚本：`$CLAUDE_JOB_DIR/tmp/png-diff-f2.mjs`（全图）、`png-diff-regions.mjs`（分区）
- 探针范式：shader 内 `#ifdef DEBUG_*` + `outputColor` 直显（本仓库已有 6 个同类探针可参照）
- 上游 storybook：`localhost:6006`（`Clouds/Basic`，controls 在 shadow DOM 内，程序化操作受限）
