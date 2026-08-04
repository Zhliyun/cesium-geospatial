# depthTemporal EMA 设计 v2（时序抗抖，消除 globe depth 抖动导致的 inscatter 同心波纹）

> **状态**：v2（2026-08-05），三专家评审后修订，纳入 3 critical + 9 major 修复
> **方案**：A — depthTemporal PostProcessStage 单 stage 打包透传（零 lag）
> **变更（v1→v2）**：① 架构改"单 stage 打包透传 vec4(scene.rgb, smoothDepth.a)"（v1 uniform-string 重定向是 showstopper，activeStages 颜色流串行）；② EMA 改 raw log-depth 域（v1 czm_readDepth 是 window-depth，HALF_FLOAT 100km 处 483m/台阶，落过渡带复现波纹）；③ reproject 钉死纯 ECEF 米（v1 注释误导，照搬 altitudeCorrection 全场景失效）；④ 运动门控加 direction 分量 + 高度归一化（v1 cameraDelta 不检测旋转/orbit 旁路）；⑤ disocclusion 改 log-depth 相对阈值 + 远平面特殊处理（v1 window-depth 固定阈值近严远松）；⑥ blit 改 Cesium createViewportQuadCommand（v1 raw WebGL postRender 状态风险）；⑦ resize 改 preRender 同步；⑧ 首帧/resize 强制 clear；⑨ lensflare 同源 smoothDepth；⑩ debug=5/8 拆分；⑪ §11 待确认全部定死
> **前置**：phase2a HDR 链 + phase2b LensFlare + 散射增强（inscarterScale=25）已合并 main

## 1. 背景与根因

### 现象
`inscatterScale=25` 下相机俯仰变化时同心圆波纹闪动，静止稍等恢复。

### 根因（debug=5 已坐实）
波纹源 = **depthTexture 本身时序抖**（`debug=5` 红色 depth 通道同心圆闪动 + 地面消失变红 depth→1）：Cesium 瓦片异步加载（未加载区 depth=1）+ DEM 量化/LOD 精度跳变。抖动路径：globe depth 抖 → `sceneDist` 抖 → `fore`/`mask`/`fogEnhance` 抖 → inscatter 同心波纹。

### 为何降 inscatterScale / 调 sse 都不减
- 降 inscatterScale：波纹是 inscatter **相对**抖动 `Δmix/mix`，与乘子 `fog(scale)` 无关。
- sse：减 LOD 切换频率，不减未加载 depth=1 + DEM 量化跳变。
- 空间 5-tap 平滑：对**时序**（跨帧瓦片加载）抖动无效。
- tHitG（椭球解析）：椭球面 ≠ 真实地形，散射边界落山体下方（透明错觉）。

### 结论
atmosphere 侧唯一解 = **时序平滑 depth（EMA on depth）**。EMA 作用于 depth（世界属性，reproject 准）而非 inscatter（view-dependent，reproject 不准）。

## 2. 目标与非目标

### 目标
- 消除 inscatterScale=25 下相机俯仰变化的同心波纹（移动 + 静态）。
- 保留 inscatterScale=25 远处雾浓、散射边界与真实地平线重合、山体清晰。
- 零 lag（本帧 globe depth，移动时拖影最小）。

### 非目标
- 不改 phase1 DUAL inscatter 主流程（base/fore/mask/fogEnhance/inscarterScale 语义不变）。
- 不改 phase2a HDR 链、phase2b LensFlare（occlusion 改读 smoothDepth 是目标内，见 §7）。
- 不修 Cesium 瓦片异步加载本身。
- 不引入经典 TAA（jitter + velocity buffer）：本项目无 velocity pass，jitter 需改 Cesium 相机投影（无官方 hook），收益不抵成本。

## 3. 架构（方案 A，单 stage 打包透传）

**关键约束（评审 critical #1）**：`PostProcessStageCollection` 按 `activeStages` 严格串行链接颜色流——`activeStages[i].colorTexture = getOutputTexture(activeStages[i-1])`。`PostProcessStage` 构造器**无** `inputPreviousStageTexture`（那是 `PostProcessStageComposite` 选项），且即便做成 Composite 也只影响内部 sub-stage 串联、不解决跨 active-stage 颜色中毒。所以 depthTemporal 不能"只输出 depth"放 atmosphere 前（atmosphere 的 colorTexture 会变成 smoothDepth，合成报废）。

**解法（单 stage 打包透传）**：depthTemporal fragment 同时读 `colorTexture`（scene color）+ `depthTexture`（globe depth），输出 `vec4(sceneColor.rgb, smoothDepth)`——scene color 流经 RGB，smoothDepth 存 alpha（globe 不透明 alpha=1，牺牲无害）。

```
PostProcess activeStages:
  [0] depthTemporal stage（新, HALF_FLOAT）:
        fragment 读 colorTexture（= scene color, activeStages[0] 自动）+ depthTexture（内建本帧 globe depth）
                 + u_historyTexture（持久 HALF_FLOAT, 上帧 smoothDepth.logDepth）
                 + u_prevViewProjection（mat4, 上帧 VP, ECEF 米域）
                 + u_temporalAlpha（float, [0,1], 运动门控 position+direction 双项）
                 → reprojection + disocclusion + EMA（raw log-depth 域）
                 → 输出 vec4(sceneColor.rgb, smoothDepth)   // smoothDepth = log-depth EMA
  [1] atmosphere stage（现有改）:
        colorTexture = depthTemporal 输出
        originalColor = texture(colorTexture).rgb
        smoothDepth  = texture(colorTexture).a              // log-depth EMA
        sceneDist 用 2-arg czm_windowToEyeCoordinates(uv, smoothDepth)（LOG_DEPTH 分支，勿 /=w）
  [2] lensflare stage（现有改）:
        depthTexture uniform 指向 "depthTemporal"（string → texture cache 解析），读 .a = smoothDepth
        （occlusion 36 点采样用 smoothDepth，统一消抖；1e-6 阈值改 log-depth 域等效值）
  [3] tonemap stage（不变）
```

### 数据流（每帧）
```
[globe render → scene colorTexture + depthTexture（本帧 globe depth, UNSIGNED_INT_24_8, log-depth）]
    ↓
[depthTemporal stage]（activeStages[0]）
  读 colorTexture（scene）+ depthTexture（本帧 globe）+ u_historyTexture（上帧 EMA）
  reprojection: worldPosECEF → u_prevViewProjection → prevUV → history
  disocclusion + EMA(α) in log-depth 域 → smoothDepth（log-depth）
  输出 vec4(sceneColor.rgb, smoothDepth)
    ↓ (activeStages[1] colorTexture = depthTemporal 输出)
[atmosphere stage]
  .rgb = originalColor, .a = smoothDepth → sceneDist 反演 → DUAL inscatter（inscarterScale=25）→ finalColor
    ↓
[lensflare → tonemap]
    ↓
[scene.preRender hook（下一帧）]  ← resize 检测 + history clear
[scene.postRender hook]
  blit: depthTemporal.outputTexture → write history Texture（Cesium createViewportQuadCommand + custom FBO）
  swap ping-pong, 更新 u_prevViewProjection = camera.frustum.projectionMatrix · camera.viewMatrix
  compute u_temporalAlpha（position+direction 双项, 高度归一化）
```

## 4. depthTemporal stage 详细

### uniforms
- `colorTexture`（activeStages[0] 自动 = scene color）
- `depthTexture`（Cesium 内建本帧 globe depth, DEPTH_STENCIL UNSIGNED_INT_24_8, **texture().r = log-depth**）
- `u_historyTexture`（持久 HALF_FLOAT RGBA，上帧 smoothDepth.logDepth；bridge `{_texture, _target}`）
- `u_prevViewProjection`（mat4，上帧 VP，**ECEF 米域**）
- `u_temporalAlpha`（float [0,1]，运动门控，越大越偏 current）
- `u_texelSize`（vec2，1/viewportSize，disocclusion 邻域用）

### shader 逻辑（伪 GLSL，钉死约束）
```glsl
// 读 scene color（透传）+ 本帧 globe depth（raw log-depth，不调 czm_readDepth）
vec3 sceneColor = texture(colorTexture, v_textureCoordinates).rgb;
float curLogDepth = texture(depthTexture, v_textureCoordinates).r;   // raw log-depth（globe 写入值）

// 反演 worldPosECEF（纯 ECEF 米，禁加 altitudeCorrection / METER_TO_LENGTH_UNIT）
vec4 eyePos = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, curLogDepth, 1.0));  // 4-arg 接收 log-depth
eyePos /= eyePos.w;
vec3 worldPosECEF = (czm_inverseView * eyePos).xyz;   // ECEF 米，禁 Bruneton 密切球变换

// reproject 到上一帧
vec4 prevClip = u_prevViewProjection * vec4(worldPosECEF, 1.0);
vec2 prevUV = prevClip.xy / prevClip.w * 0.5 + 0.5;

// disocclusion（log-depth 域相对阈值 + 远平面特殊处理）
bool prevVisible = (prevClip.w > 0.0)
  && (prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0);
float histLogDepth = prevVisible ? texture(u_historyTexture, prevUV).a : curLogDepth;  // history 也存 .a
bool farPlane = (curLogDepth >= 1.0 - 1e-4);   // 远平面/未加载 depth≈1：不累积
float relDiff = abs(histLogDepth - curLogDepth) / max(curLogDepth, 1e-4);
bool consistent = !farPlane && (relDiff < u_depthThreshold);   // log-depth 相对阈值，距离无关

// EMA（log-depth 域）：alpha=1 纯 current（disocclusion/远平面/首帧），alpha 小累积
float alpha = (prevVisible && consistent) ? u_temporalAlpha : 1.0;
float smoothDepth = mix(histLogDepth, curLogDepth, alpha);

// 打包输出：scene color 流经 RGB，smoothDepth 存 alpha
out_FragColor = vec4(sceneColor, smoothDepth);
```

### 钉死约束（plan/代码审查清单）
- **EMA 域 = raw log-depth**（`texture().r`，**禁** `czm_readDepth`——它是 `czm_reverseLogDepth`，输出 window-depth，HALF_FLOAT 远处精度不足）。
- **reproject worldPos = 纯 ECEF 米**（`czm_inverseView * eyePos`，**禁** `altitudeCorrection` / `*METER_TO_LENGTH_UNIT`——那是 Bruneton 密切球局部 km 系，与 `u_prevViewProjection`（ECEF 米）坐标系错位会全场景失效）。
- **history 也存 .a**（与 depthTemporal output 同布局，方便 blit 透传）。

### stage 选项
- `pixelDatatype`：**复用 `resolvePostHdrDatatype(scene)`**（与 atmosphere 同套，HALF_FLOAT→FLOAT→UNSIGNED_BYTE 三级检测）。UNSIGNED_BYTE 时 8-bit 量化 EMA depth 无意义（量化噪声 >> 平滑量），**整体跳过 depthTemporal stage**（不 add，atmosphere 仍读内建 globe depth，回退现状波纹行为）。优先 **FLOAT（RGBA32F）**（GPU 支持 EXT_color_buffer_float 时，5Mm 处抖动 ~9m 彻底无 banding），HALF_FLOAT+log-depth 作移动端 fallback（5Mm 处 ~38km）。
- `textureScale: 1.0`（全分辨率，depth 精确，禁降分辨率——降分辨率 + NEAREST → 山体边缘锯齿 depth → 山体透明回归 phase1 弃路径）
- `sampleMode: NEAREST`（depth/scene color 精确）
- `gammaFromLinearColorSpace: false`（HDR 半精度数据，禁 gamma）

## 5. disocclusion + 运动门控（钉死，不留待确认）

### disocclusion：log-depth 域相对阈值 + 远平面特殊处理
- `relDiff = |histLogDepth - curLogDepth| / curLogDepth < u_depthThreshold`（log-depth 相对差，距离无关容差）。
- `u_depthThreshold` 默认 **0.1**（log-depth 差 0.1 ≈ 距离相对变化 ~7%，区分 LOD 抖动 vs 真实遮挡）。URL `?depthThreshold=` 调。
- **远平面特殊处理**（history IIR 长期污染缓解）：`curLogDepth >= 1-eps`（未加载区 depth≈1）→ `alpha=1` 纯 current，**且 history 该像素不更新**（postRender blit 时跳过远平面像素，或写入 sentinel）。避免 depth=1 累积污染（静止恢复期 ~60 帧衰减）。
- 备选（plan A/B）：3x3 邻域 variance clipping（ShadowResolvePass AABB clip，history clamp 到邻域 min/max），更鲁棒但 +9 tap。

### 运动门控：position + direction 双项 + 高度归一化
- 评审 critical：cameraDelta（positionWC 距离）**不检测旋转**（原地 pitch positionWC 不变 → α=lowAlpha 强平滑 → 旋转期 disocclusion 大 → 拖影）；orbit/lookAt 时 maxDelta=1000m 对 Mm 高度相机过小（1°/帧≈17km → α=highAlpha → EMA 旁路）。
- 公式：`motion = Δpos_norm + w_dir · (1 - dot(directionWC, prevDir))`
  - `Δpos_norm = distance(positionWC, prevPositionWC) / maxDelta`
  - `maxDelta = cameraHeight · k`（高度归一化，k≈0.01，1Mm 高度 maxDelta=10km）
  - `w_dir`：direction 权重（本方案 reprojection 比 ShadowResolvePass velocity-buffer 更准，direction 权重调小，w_dir≈0.5）
- `temporalAlpha = mix(lowAlpha, highAlpha, smoothstep(0, 1, motion))`
  - `lowAlpha = 0.05`（静止强累积），`highAlpha = 0.5`（移动偏 current；比 ShadowResolvePass 0.8 低，因 reprojection 更准可承受更多累积）
- URL `?temporalQuality=low|high`（预设 low/high alpha 对）+ `?depthThreshold`（专家调）。删除 `?lowAlpha/?highAlpha/?temporalAlpha`（收敛）。

## 6. history + blit（JS，createAtmosphereQuadCommand）

### 持久 history Texture
- 两张 ping-pong（HALF_FLOAT 或 FLOAT，随 depthTemporal pixelDatatype）：`new Cesium.Texture({context, width, height, pixelFormat: RGBA, pixelDatatype, sampler: {minificationFilter: NEAREST, magnificationFilter: NEAREST}})`
- 尺寸跟 viewport，**preRender 检测**重建（见 resize）
- 模板：`cesium-clouds-atmosphere/src/CloudShadowPass.js:141-191`

### ping-pong + bridge
- `historyIndex`（0/1），每帧 postRender 末尾 swap
- `u_historyTexture` uniform：函数返回当前 read Tex 的 bridge（swap 前）→ `{_texture: readTex._texture, _target: gl.TEXTURE_2D}`

### blit（Cesium createViewportQuadCommand，替代 raw WebGL）
- 评审 major #3：raw WebGL blit 改写 GL state（blend/colorMask/activeTexture 粘滞），postRender 后 Cesium 还有 SkyAtmosphere 等流程。
- 改用 `Context.createViewportQuadCommand`（Cesium DrawCommand 管理状态，自带 RenderState/program cache）：shader `texture(u_src, v_uv)` 透传（含 .a = smoothDepth），`uniformMap: {colorTexture: () => depthTemporal.outputTexture}`，`framebuffer: customHistoryFBO`（`new Framebuffer({context, colorTextures: [writeHistoryTex]})`）。
- 绕过 `Texture.copyFromFramebuffer` 的 HALF_FLOAT 限制（那是 copyTexSubImage2D 路径，整 draw 不受限）。

### postRender hook 流程
```ts
scene.postRender.addEventListener(() => {
  const src = depthTemporalStage.outputTexture;
  if (!defined(src)) return;   // 首帧/stage disabled/outputTexture undefined → 跳过，保持上帧状态
  // blit depthTemporal output → write history Tex
  blitCommand.execute(scene.context, customHistoryFBO);
  // 更新下帧 uniforms
  prevViewProjection = Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, ...);
  const dh = Cartesian3.distance(camera.positionWC, prevPositionWC) / (cameraHeight * 0.01);
  const dd = 1 - Cartesian3.dot(camera.directionWC, prevDir);
  temporalAlpha = mix(0.05, 0.5, smoothstep(0, 1, dh + 0.5 * dd));
  prevPositionWC = camera.positionWC.clone(); prevDir = camera.directionWC.clone();
  historyIndex = 1 - historyIndex;
});
```

### prevViewProjection 坐标系一致性（评审 major）
- `camera.frustum.projectionMatrix · camera.viewMatrix`（ECEF 米→clip），与 depthTemporal shader 内 `czm_inverseView`（ECEF 米）一致。
- plan 单测：对比 JS 算的 VP 与同帧 depthTemporal shader 内 `uniform mat4 czm_viewProjection`（Cesium 自动注入）数值一致。多视锥（远视锥像素）若偏差可见，改用 shader 内写 `czm_viewProjection` 到 R32F 输出、postRender blit 该输出作 prevVP。

### 首帧 + resize 强制 clear（评审 major）
- 首帧/resize 重建 history Texture 后，**强制 clear**（移除"loadNull 全 0"假设——Cesium Texture source=undefined 内容未定义）：
  - 最优：首帧 postRender blit **当前 globe depth** 作 history 基线（第二帧 reproject 即有效），而非清 0。
  - 或 raw WebGL `gl.clearTexImage`（WebGL2）清远平面值（log-depth=1）。
- 列入 plan 验收 + 单测断言。

### resize（评审 major，升高危）
- **preRender 检测** viewport 尺寸变化（在 collection.update 重建 depthTemporal outputTexture 之前），重建 history Texture + reset ping-pong + clear。
- 保证本帧 depthTemporal outputTexture 与 history Tex 同尺寸（否则 blit GL size mismatch 静默中断 postProcess）。

## 7. atmosphere + lensflare 改动

### atmosphere sceneDist 反演（aerialPerspective.frag.ts）
- 当前 L329 `float depth = czm_readDepth(depthTexture, v_textureCoordinates);` → 改读 depthTemporal output .a：
  - `float smoothDepth = texture(colorTexture, v_textureCoordinates).a;`（colorTexture 现在是 depthTemporal 输出，含 scene color .rgb + smoothDepth .a）
  - **2-arg czm_windowToEyeCoordinates**：`vec4 eyePos = czm_windowToEyeCoordinates(vec2(gl_FragCoord.xy), smoothDepth);`（LOG_DEPTH 分支处理 log-depth，源码注释"对 log-depth 比 reverseLogDepth+4-arg 更精确"），**禁 `eyePos /= eyePos.w`**（2-arg 返回 .xyz 已是真眼坐标，/=w 会缩放 d 倍）。
  - `originalColor = texture(colorTexture, v_textureCoordinates).rgb`（L321，从 .rgba 改 .rgb）
- **移除 5-tap 邻域平均**（L350-355）：EMA 已时序平滑，5-tap 空间平均在已平滑 depth 上双重平滑，山体边缘 worldPos 偏移可能引入雾化溢出。sceneDist 直接用中心 smoothDepth。山体边缘若需更稳，plan A/B 用 3x3 closest（ShadowResolvePass getClosestFragment 取最小 depth）。

### lensflare occlusion 同源 smoothDepth（评审 major #10）
- `occlusion.frag.ts:97` `czm_readDepth(depthTexture)` → depthTexture uniform 指向 "depthTemporal"（string），读 `.a` = smoothDepth。
- occlusion 36 点 depth 比较 + `1e-6` 阈值（occlusion.frag.ts:20）改 log-depth 域等效值（plan 验证 smoothDepth 远平面 1.0 精度）。
- 统一消抖（避免"inscatter 稳了但 lensflare ghost/halo 闪烁"新 artifact）。

### debug 拆分（评审 major #12）
- `debug=5`：显示 smoothDepth（EMA 后，验证 depthTemporal 输出稳）。
- 新增 `debug=8`：depthTemporal stage 内独立输出本帧 raw globe depth（log-depth，验证抖动源仍存在 + EMA 对比）。
- atmosphere shader debug 级联加 debug=8 分支。

## 8. 风险 + 缓解（修订）

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| **Cesium 版本升级**（私有 API：outputTexture getter / texture cache 依赖 / createUniform bridge `_texture,_target` / globeDepth.depthStencilTexture）| **高** | adapter 层封装（bridge 协议/outputTexture 取值/_gl 集中一处）；启动 sanity check（assert outputTexture defined / bridge 字段 / camera VP 可读，失败 graceful degrade 禁用 depthTemporal + 警告）；package.json 给 @cesium/engine 加版本约束 |
| **resize 时序**（outputTexture 帧首 textureCache.update 重建 vs history postRender 重建 → GL size mismatch）| **高** | preRender 检测 viewport 变化重建 history（在 collection.update 前） |
| **history IIR 长期污染**（depth=1 累积，~60 帧衰减）| 中 | 远平面特殊处理（α=1 + 不写 history）+ log-depth 相对阈值 disocclusion |
| postRender blit GL 状态（createViewportQuadCommand 缓解）| 中 | Cesium DrawCommand 管理状态；plan 查清 postRender 后到下帧 preRender 间 Cesium GL 调用 |
| lensflare occlusion smoothDepth 适配（1e-6 阈值 log-depth 域）| 中 | plan 验证 occlusion 阈值对 smoothDepth 有效 |
| EMA log-depth 域精度（HALF_FLOAT）| 中 | 优先 FLOAT（EXT_color_buffer_float）；HALF_FLOAT+log fallback（5Mm ~38km）；debug=5 验收无台阶 |
| reproject 多视锥偏差（远视锥像素 VP 不一致）| 中 | plan 单测 JS VP vs shader czm_viewProjection；偏差可见则改 shader 写 VP |
| 性能（每帧 +1 depthTemporal fullscreen pass + blit，全分辨率 HALF_FLOAT）| 中 | 量化移动设备 1080p 帧率（plan 验收硬指标）；blit 必须全分辨率（history 跟 viewport） |
| 首帧/resize history 未初始化 | 低 | 强制 clear（首帧 blit 当前 globe depth 基线） |
| 首帧 outputTexture undefined | 低 | postRender blit 前判空跳过 |
| alpha 牺牲影响（globe alpha=1 无害）| 低 | plan 验证 lensflare/composite 不依赖 input alpha |

## 9. 测试策略（加自动化回归）

### 单元测试（vitest）
- depthTemporal shader glslang 编译（新 compile test，含 czm_windowToEyeCoordinates 2-arg/4-arg 桩、czm_inverseView、prevViewProjection/history/temporalAlpha uniform、LOG_DEPTH define）
- **坐标系单测**（评审）：mock 静态场景（VP 不变），断言 `prevUV == v_textureCoordinates`（验证 ECEF 米 reproject 自洽）
- **JS VP vs shader czm_viewProjection 一致性**（评审）：同帧对比，断言数值一致
- **EMA 收敛自动化回归**（评审）：mock cameraDelta 序列 + 模拟瓦片 LOD 抖动 depth 序列（奇偶帧 depth 跳 0.005），断言 smoothDepth 经 N 帧收敛到稳定值（方差 < 阈值），捕获 EMA 退化
- history ping-pong 逻辑（swap index、bridge、首帧空 + 强制 clear）
- blit 透传（Cesium createViewportQuadCommand + custom FBO 绑定）
- temporalAlpha 计算（position+direction 双项 + 高度归一化边界）
- atmosphere sceneDist 用 smoothDepth（.a + 2-arg czm_windowToEyeCoordinates）

### 集成测试
- createAtmosphereStage 装配 depthTemporal + atmosphere + lensflare（stage 顺序、uniform 指向、alpha 流）
- resize 重建 history（preRender 同步）
- UNSIGNED_BYTE 兜底跳过 depthTemporal

### 视觉验收（demo URL）
- 波纹消除：`?mode=atmosphere&time=...&camera=93.4055,32.7362,1002025,0.0,-89&inscatterScale=25`（俯仰由高到低扫）
- **debug=8 验 raw globe depth 抖动源仍存在**（确认 EMA 输入是抖动的）
- **debug=5 验 smoothDepth 稳**（确认 EMA 输出稳，1Mm 高度俯仰扫描无台阶）
- 山体清晰：`#camera=95.7229,31.5070,11645,295.8,-4.3`
- 散射边界重合（俯视同心圆 = 真实地平线）
- 拖影可接受（快速俯仰 + orbit 验残影）
- lensflare 不闪（occlusion 同源 smoothDepth）
- inscatterScale=25 远处雾浓保留
- 调参：`?temporalQuality=low|high ?depthThreshold=`
- ?temporalEma=0 显式关 depthTemporal（回退现状，对比）

## 10. 关键源码参考（标注私有 API）

### Cesium（@cesium/engine@26.1.0，**私有/内部 API，无稳定性保证**）
- `Source/Scene/PostProcessStageCollection.js:816-830`：activeStages 颜色流串行（critical #1 依据）
- `Source/Scene/PostProcessStage.js:94-107`（构造器无 inputPreviousStageTexture）、`:346-356`（outputTexture getter，可返 undefined）、`:517-539`（combine 硬编码 depthTexture）
- `Source/Scene/PostProcessStageTextureCache.js:53-64, 222-232, 319-376`（依赖检测、framebuffer 持久、帧首重建）
- `Source/Renderer/createUniform.js:254-260`（sampler bridge `v._target/v._texture`）
- `Source/Renderer/Texture.js:985-1063`（copyFromFramebuffer 拒 FLOAT/HALF_FLOAT/depth）
- `Source/Scene/Scene.js:4306-4499`（render 顺序）、`:3947-3962`（PostProcess execute）
- `Source/Scene/GlobeDepth.js:74-76`（depthStencilTexture 持久，方案 B 用，A 不需）
- `readDepth.glsl:3`（czm_readDepth = czm_reverseLogDepth，window-depth）、`windowToEyeCoordinates.glsl:61-65/106-110`（4-arg / 2-arg overload，2-arg 含 LOG_DEPTH 分支）

### cesium-clouds-atmosphere（参考模板，**私有 raw WebGL**）
- `src/ShadowResolvePass.js:97-179, 222-241, 294-296, 306`（HALF_FLOAT ping-pong + 运动自适应 alpha position+direction + reprojection + EMA + preRender）
- `src/CloudShadowPass.js:141-191`（Cesium Texture 包原生 GL handle）
- `src/ThreeGeospatialPipeline.js:1152-1181`（_blitBSM，A 改用 Cesium createViewportQuadCommand 替代）

### 本项目（复用）
- `packages/cesium-core/src/cesium/AtmosphereStage.ts`：stage 装配（L333-335）、resolvePostHdrDatatype（L205-217，depthTemporal 复用）
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`：sceneDist 反演（L329 改 .a + 2-arg）、originalColor（L321 改 .rgb）、5-tap 移除（L350-355）、debug=5（L472）+ debug=8
- `packages/cesium-core/src/cesium/lensFlare/occlusion.frag.ts:97`：depthTexture 指向 depthTemporal .a
- `packages/cesium-core/src/cesium/depthReconstruction.ts`：现有 depth 反演 GLSL（参考，但 reproject 用 ECEF 米不复用密切球变换）
- `packages/cesium-core/src/cesium/cesium-augment.d.ts`：outputTexture getter 类型补充
- `packages/cesium-core/src/glslangUtil.ts`：共享 compile 辅助

## 11. 决策记录（v1 §11 待确认全部定死）

| 项 | v1 状态 | v2 决策 |
|----|--------|---------|
| EMA 域 | 待确认（误称 log 空间）| **raw log-depth 域**（texture().r，禁 czm_readDepth）|
| reproject 坐标系 | 注释误导（altitudeCorrection）| **纯 ECEF 米**（禁 altitudeCorrection/METER_TO_LENGTH_UNIT）|
| 运动门控 | cameraDelta（positionWC）| **position + direction 双项 + 高度归一化**（motion = Δpos/(h·0.01) + 0.5·(1-dot(dir,prevDir))）|
| disocclusion 阈值 | window-depth 固定 0.01 | **log-depth 相对阈值 0.1 + 远平面特殊处理**（备选 variance clipping）|
| 5-tap 邻域 | 待确认 | **移除**（EMA 替代空间平滑；边缘 closest 备选）|
| blit 时机 | postRender vs stage 钩子 | **postRender + Cesium createViewportQuadCommand**（替代 raw WebGL）|
| history clear | 待确认 | **强制 clear**（首帧 blit 当前 globe depth 基线）|
| depthTemporal 独立 composite | 待确认 | **单 stage 打包透传**（不 composite，scene color 流经）|
| pixelDatatype | 硬编码 HALF_FLOAT | **复用 resolvePostHdrDatatype**（FLOAT 优先，UNSIGNED_BYTE 跳过 stage）|
| lensflare depth | 未提 | **同源 smoothDepth**（occlusion 读 depthTemporal .a）|
| debug=5 语义 | 未提 | **debug=5 smoothDepth + debug=8 raw globe depth** |
| URL 调参 | 4 个（temporalAlpha/lowAlpha/highAlpha/depthThreshold）| **收敛 2 个**（?temporalQuality=low|high + ?depthThreshold）+ ?temporalEma=0 显式关 |

## 12. 文件清单（plan 阶段细化）

### 新增
- `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.ts`：depthTemporal fragment shader 组装器（含 LOG_DEPTH define、2-arg czm_windowToEyeCoordinates 桩）
- `packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.ts`：alpha 范围、depthThreshold、ping-pong、maxDelta k
- `packages/cesium-core/src/cesium/depthTemporal/historyBlit.ts`：createViewportQuadCommand blit + history Texture ping-pong 管理 + adapter（Cesium 私有 API 封装）
- `packages/cesium-core/src/cesium/depthTemporal/*.test.ts`：shader compile + 坐标系 + VP 一致性 + EMA 收敛 + ping-pong + blit 单测

### 修改
- `packages/cesium-core/src/cesium/AtmosphereStage.ts`：装配 depthTemporal stage（activeStages[0]）+ history/blit 生命周期 + preRender（resize）+ postRender hook + uniform 接线 + UNSIGNED_BYTE 兜底
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`：sceneDist `.a` + 2-arg czm_windowToEyeCoordinates（L329）、originalColor `.rgb`（L321）、移除 5-tap（L350-355）、debug=5（L472）+ debug=8
- `packages/cesium-core/src/cesium/lensFlare/occlusion.frag.ts`：depthTexture 指向 depthTemporal .a（L97）+ 阈值 log-depth 域
- `packages/cesium-core/src/cesium/cesium-augment.d.ts`：outputTexture getter 类型
- `apps/demo/src/main.ts`：URL `?temporalQuality= ?depthThreshold= ?temporalEma=`

### 文档
- `docs/superpowers/plans/2026-08-05-depth-temporal-ema.md`（writing-plans 产出）
- `docs/superpowers/plans/2026-08-05-depth-temporal-ema-results.md`
