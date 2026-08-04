# depthTemporal EMA 设计（时序抗抖，消除 globe depth 抖动导致的 inscatter 同心波纹）

> **状态**：设计确认（2026-08-05），待写实施 plan
> **方案**：A — depthTemporal PostProcessStage + postRender raw-WebGL blit（零 lag）
> **前置**：phase2a HDR 链（atmosphere HalfFloat → lensflare → tonemap）、phase2b LensFlare、散射增强（inscatterScale=25）均已合并 main

## 1. 背景与根因

### 现象
`inscatterScale=25`（散射增强，远处白雾浓）后，相机俯仰变化时出现**同心圆波纹闪动**，静止稍等后恢复。

### 根因（debug=5 已坐实）
- 波纹源是 **depthTexture 本身时序抖**：`debug=5`（depth 可视化）下红色 depth 通道同心圆闪动 + 地面消失变红（depth→1 远平面）。
- depth 抖来自 **Cesium 瓦片异步加载固有**：相机移动时瓦片加载/卸载（未加载区 depth=1）+ DEM 量化/LOD 精度跳变。
- 抖动路径：globe depth 抖 → `sceneDist` 抖 → `fore`/`mask`/`fogEnhance` 抖 → inscatter 同心波纹。

### 为何降 inscatterScale / 调 sse 都不减
- **降 inscatterScale 不减**：波纹是 inscatter 的**相对**抖动 `Δmix/mix`，与乘子 `fog(scale)` 无关（`Δ(mix·fog)/(mix·fog) = Δmix/mix`）。人眼对相对亮度敏感（Weber-Fechner），降 scale 减绝对亮度不减相对抖动。
- **sse 不减**：sse 减 LOD 切换频率，不减未加载区 depth=1 + DEM 量化跳变。

### 为何无法用空间平滑解决
- `fore`/`mask` 必须读 sceneDist（depth）：`fore` 提供 foreTrans（高透射保山体原色）+ foreInscatter（真实距离小 inscatter），去掉则山体透明（phase1 弃 A 路径教训）。`mask` 用 sceneDist 才能让山体（sceneDist 小）走 fore 清晰，用 tHitG 会把山体（椭球距离偏大）误判为远→走 base→雾。
- 5-tap 空间平均（已做）只平滑空间高频，对**时序**（跨帧瓦片加载）抖动无效。
- tHitG（椭球解析，无抖）不能用：椭球面 ≠ 真实地形，散射边界落在山体下方（透明错觉）。

### 结论
"inscatterScale≥15（远处雾浓）+ 真实地平线重合（sceneDist）+ 无波纹 + 山体清晰"四者，atmosphere 侧唯一解是**时序平滑 depth**（EMA on depth）。EMA 作用于 depth（世界属性，reproject 准，移动有效）而非 inscatter（view-dependent，reproject 不准，移动弱）。

## 2. 目标与非目标

### 目标
- 消除 inscatterScale=25 下相机俯仰变化时的同心波纹（移动 + 静态）。
- 保留 inscatterScale=25 远处雾浓、散射边界与真实地平线重合、山体清晰。
- 零 lag（本帧 depth，移动时拖影最小）。

### 非目标
- 不改 phase1 DUAL inscatter 主流程（base/fore/mask/fogEnhance/inscarterScale 语义不变）。
- 不改 phase2a HDR 链、phase2b LensFlare。
- 不修 Cesium 瓦片异步加载本身（固有限制，atmosphere 侧平滑）。
- 不引入 jitter/velocity buffer（经典 TAA）；EMA 用 prevViewProjection reproject。

## 3. 架构（方案 A）

PostProcess 链顺序变为：
```
depthTemporal (新, HALF_FLOAT) → atmosphere (现有) → lensflare (现有) → tonemap (现有)
```

### 组件
1. **depthTemporal PostProcessStage**（新）：读本帧 globe depth + 外部持久 history → reprojection + EMA → 输出 smoothDepth（HALF_FLOAT color texture，r 通道存 depth NDC z 值）。
2. **postRender raw-WebGL blit**（新，JS）：把 depthTemporal 输出拷进持久 history Texture（ping-pong）。
3. **atmosphere stage 改**（现有改）：depthTexture uniform 从"Cesium 内建 depth"改指"depthTemporal 输出"；sceneDist 反演用 smoothDepth（普通 texture 采样替代 czm_readDepth）。

### 数据流（每帧）
```
[globe render → depthTexture（本帧 globe depth，UNSIGNED_INT_24_8）]
    ↓
[depthTemporal stage]
  读 depthTexture（本帧）+ u_historyTexture（上帧 smoothDepth，HALF_FLOAT）
  reproject: worldPos → prevViewProjection → prevUV → history
  disocclusion + EMA(α) → smoothDepth
  输出 smoothDepth（HALF_FLOAT color RT）
    ↓ (texture cache 自动解析 "depthTemporal" 名 → atmosphere depthTexture uniform)
[atmosphere stage]
  读 smoothDepth（texture().r 替代 czm_readDepth）
  sceneDist 反演 → base/fore/mask/fogEnhance（inscatterScale=25）→ finalColor
    ↓
[lensflare → tonemap]
    ↓
[postRender hook]
  blit: depthTemporal output → write history Tex（raw WebGL fullscreen-quad）
  swap history ping-pong index
  update u_prevViewProjection = projectionMatrix · viewMatrix
  compute u_temporalAlpha（cameraDelta smoothstep）
```

## 4. depthTemporal stage 详细

### uniforms
- `depthTexture`（Cesium 内建本帧 globe depth，DEPTH_STENCIL UNSIGNED_INT_24_8）
- `u_historyTexture`（持久 HALF_FLOAT RGBA，上帧 smoothDepth；r 通道 = depth NDC z；bridge 对象 `{_texture, _target}`）
- `u_prevViewProjection`（mat4，上帧 VP）
- `u_temporalAlpha`（float，[0,1]，运动自适应；越大越偏 current）
- `u_texelSize`（vec2，1/viewportSize，disocclusion 邻域用）

### shader 逻辑（伪 GLSL）
```glsl
float curDepth = czm_readDepth(depthTexture, v_textureCoordinates);
// 反演 worldPos（复用 atmosphere 现有反演逻辑）
vec4 eyePos = czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, curDepth, 1.0));
eyePos /= eyePos.w;
vec3 worldPos = (czm_inverseView * eyePos).xyz;  // 注意：atmosphere 有 altitudeCorrection/METER_TO_LENGTH_UNIT 修正，这里用同套
// reproject 到上一帧
vec4 prevClip = u_prevViewProjection * vec4(worldPos, 1.0);
vec2 prevUV = prevClip.xy / prevClip.w * 0.5 + 0.5;
// disocclusion：上一帧不可见（出界/w<=0）或 depth 差异过大 → 纯 current
bool reprojectValid = (prevClip.w > 0.0)
  && (prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0);
float histDepth = reprojectValid ? texture(u_historyTexture, prevUV).r : curDepth;
float depthDiff = abs(histDepth - curDepth);
bool consistent = depthDiff < u_depthThreshold;  // depth 跳变阈值（瓦片 LOD 边界/穿山）
float alpha = (reprojectValid && consistent) ? u_temporalAlpha : 1.0;
// EMA：alpha=1 纯 current（disocclusion/首帧），alpha 小累积（静止强平滑）
float smoothDepth = mix(histDepth, curDepth, alpha);
out_FragColor = vec4(smoothDepth, 0.0, 0.0, 1.0);
```

### stage 选项
- `pixelDatatype: HALF_FLOAT`（depth EMA 需浮点精度，UNSIGNED_BYTE 量化毁 EMA）
- `textureScale: 1.0`（全分辨率，depth 精确）
- `sampleMode: NEAREST`（depth 精确，不插值）
- `inputPreviousStageTexture: false`（非链 color 流，读内建 depthTexture；其 output 通过 uniform name 串被 atmosphere 引用）

### disocclusion 阈值 u_depthThreshold
- depth NDC z [0,1] 空间。瓦片 LOD 边界 depth 跳变（DEM 精度差）通常 > 0.001（NDC z）。穿山/遮挡变化 depth 跳变大。
- 初始 0.01（NDC z），URL `?depthThreshold=` 调。太大→波纹残留，太小→history 频繁 reset（失效）。

## 5. history + blit（JS，createAtmosphereStage 内）

### 持久 history Texture
- 两张 ping-pong：`historyTexA`、`historyTexB`（`new Cesium.Texture({context, width, height, pixelFormat: RGBA, pixelDatatype: HALF_FLOAT, sampler: {minificationFilter: NEAREST, magnificationFilter: NEAREST}})`）
- 尺寸跟 viewport（resize 时重建）
- 模板：`cesium-clouds-atmosphere/src/CloudShadowPass.js:141-191`（Cesium Texture 包原生 GL handle 范例）

### ping-pong index
- `historyIndex`（0/1），每帧 postRender 末尾 swap
- `u_historyTexture` uniform：函数返回当前 read Tex 的 bridge（swap 前那张）→ `{_texture: readTex._texture, _target: gl.TEXTURE_2D}`
- write Tex（swap 后变 read）

### postRender raw-WebGL blit（移植 `_blitBSM`）
- 自建 FBO，挂 write history Tex 的 `_texture` 到 COLOR_ATTACHMENT0
- fullscreen-quad shader：`out = texture(u_src, v_uv)` 透传（scale=1，HALF_FLOAT→HALF_FLOAT）
- u_src = depthTemporal output texture（通过 stage outputTexture getter 取 `stage.outputTexture`，或 PostProcessStageTextureCache 取）
- 关键：不用 `Texture.copyFromFramebuffer`（拒 HALF_FLOAT，见查证 §2）

### postRender hook 流程
```ts
scene.postRender.addEventListener(() => {
  // 1. blit depthTemporal output → write history Tex
  blitPass.execute(depthTemporalStage.outputTexture, writeHistoryTex);
  // 2. update uniforms for NEXT frame
  prevViewProjection = Matrix4.multiply(projectionMatrix, viewMatrix, new Matrix4());
  // temporalAlpha: cameraDelta smoothstep
  const cameraDelta = Cartesian3.distance(camera.positionWC, prevPositionWC);
  temporalAlpha = lerp(lowAlpha, highAlpha, smoothstep(0, maxDelta, cameraDelta));
  prevPositionWC = camera.positionWC.clone();
  // 3. swap ping-pong
  historyIndex = 1 - historyIndex;
});
```

### 运动门控 α 参数
- `lowAlpha = 0.05`（静止强累积，强平滑）
- `highAlpha = 0.8`（移动偏 current，减拖影）
- `maxDelta = 1000.0`（米，相机移动 1km 内 α 从 low→high 过渡）
- URL `?temporalAlpha=` 整体缩放，`?lowAlpha=`/`?highAlpha=` 细调

### 首帧处理
- 首帧无 history（historyTex 未写入）→ u_historyTexture 初始为空 Texture（`loadNull`，全 0）→ reproject history=0 → disocclusion（depthDiff 大）→ α=1 纯 current。第二帧起正常累积。

## 6. atmosphere stage 改动

### depthTexture uniform 指向
- 当前：Cesium 内建 depthTexture（POST_PROCESS_TEXTURES 自动注入）
- 改：uniform 值 = `"depthTemporal"`（string，stage 名）→ texture cache 自动解析依赖、分配独立 framebuffer（无 feedback loop，查证 §1）

### sceneDist 反演改（aerialPerspective.frag.ts）
- 当前（L329）：`float depth = czm_readDepth(depthTexture, v_textureCoordinates);`
- 改：`float depth = texture(depthTexture, v_textureCoordinates).r;`（smoothDepth 是 HALF_FLOAT color texture，普通采样）
- 5-tap 邻域（L350-355）：`czm_readDepth(depthTexture, uv+offset)` → `texture(depthTexture, uv+offset).r`（5-tap 平滑 smoothDepth，可与 EMA 叠加或去 5-tap 由 EMA 替代——plan 阶段定）
- 反演后续（czm_windowToEyeCoordinates 等）不变——smoothDepth 是 NDC z [0,1]，与 czm_readDepth 输出语义一致

### glslang 校验桩（buildStandaloneShaderForValidation）
- atmosphere 的 `czm_readDepth` 桩（L522）若不再用可移除；但 depthTemporal 是新 stage 需独立校验 shader（含 czm_readDepth 桩读本帧 globe depth）

## 7. 风险 + 缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| **blit raw WebGL**（自建 FBO + shader，首次引入 raw WebGL）| 高 | 移植 `_blitBSM`（已验证模板）；先写 blit 透传单测；Cesium Context 状态保存/恢复 |
| HalfFloat 精度（depth NDC z EMA）| 中 | depth [0,1] HALF_FLOAT 精度足够（对数 depth 空间 EMA）；验收 banding |
| reproject 精度（对数 depth + prevVP）| 中 | 复用 atmosphere 现有 depth 反演；prevVP 用 projectionMatrix·viewMatrix |
| disocclusion（山体边缘/穿山/prevUV 出界）| 中 | depthDiff 阈值 + prevUV 边界检查；α=1 兜底 |
| 性能（每帧 +2 fullscreen pass：depthTemporal + blit）| 中 | depthTemporal 全分辨率 + blit 全分辨率；移动设备验收帧率；必要时降 depthTemporal 分辨率 |
| atmosphere readDepth 改动（影响所有 depth 消费）| 中 | 全套测试（sceneDist/hasScene/debug=5）；5-tap 同改 |
| resize（history Texture 重建）| 低 | scene.postRender 检测 viewport 尺寸变化 → 重建 history Texture + reset ping-pong |
| 首帧无 history | 低 | 空 Texture + α=1 兜底（disocclusion 自动）|
| Cesium Context 状态污染（raw WebGL blit 影响 PostProcess）| 中 | blit 前后 save/restore GL state（program/viewport/blend）|

## 8. 测试策略

### 单元测试（vitest）
- depthTemporal shader glslang 编译（新 compile test，含 czm_readDepth/czm_windowToEyeCoordinates/czm_inverseView 桩 + prevViewProjection/history/temporalAlpha uniform）
- history ping-pong 逻辑（JS：swap index、bridge 对象、首帧空 Texture）
- blit 透传正确性（mock Context，验证 fullscreen-quad + FBO 绑定）
- temporalAlpha 计算（cameraDelta smoothstep 边界）
- atmosphere sceneDist 用 smoothDepth（texture().r 替代 czm_readDepth）

### 集成测试
- createAtmosphereStage 装配 depthTemporal + atmosphere（stage 顺序、uniform 指向）
- resize 重建 history

### 视觉验收（demo URL）
- 波纹消除：`?mode=atmosphere&time=...&camera=93.4055,32.7362,1002025,0.0,-89&inscatterScale=25`（俯仰由高到低扫，debug=5 验 depth 稳）
- 山体清晰：`#camera=95.7229,31.5070,11645,295.8,-4.3`
- 散射边界重合：俯视验同心圆 = 真实地平线
- 拖影可接受：快速俯仰验残影
- inscatterScale=25 远处雾浓保留
- 调参 URL：`?temporalAlpha= ?lowAlpha= ?highAlpha= ?depthThreshold=`

## 9. 关键源码参考（实现时查阅）

### Cesium（@cesium/engine@26.1.0）
- `Source/Scene/PostProcessStage.js`：stage 装配、uniform 绑定 Texture（`:437-450`）、outputTexture getter（`:346-356`）
- `Source/Scene/PostProcessStageTextureCache.js`：依赖检测/独立 framebuffer（`:53-64, 222-232`）
- `Source/Renderer/createUniform.js`：sampler uniform bridge（`gl.bindTexture(v._target, v._texture)`，`:254-260`）
- `Source/Renderer/Texture.js`：`copyFromFramebuffer` 限制（`:985-1063`，拒 FLOAT/HALF_FLOAT/depth）→ blit 必须 raw WebGL
- `Source/Scene/Scene.js`：render 顺序（`:4306-4499`），PostProcess execute 拿 depthTexture（`:3947-3962`）
- `Source/Scene/GlobeDepth.js`：depthStencilTexture 持久（`:74-76`）

### cesium-clouds-atmosphere（参考模板）
- `src/ShadowResolvePass.js`：HALF_FLOAT ping-pong + 运动自适应 alpha + reprojection + EMA fragment（`:97-179, 222-241, 294-296`），preRender hook（`:306`）
- `src/CloudShadowPass.js`：Cesium Texture 包原生 GL handle（`:141-191`）
- `src/ThreeGeospatialPipeline.js`：`_blitBSM` raw WebGL blit（`:1152-1181`）、postRender VP 捕获 + ping-pong index（`:1250-1293`）、uniform bridge（`:1125-1148`）

### 本项目（复用）
- `packages/cesium-core/src/cesium/AtmosphereStage.ts`：PostProcessStage 装配/preRender/destroy 骨架（stage 顺序 L333-335）、HalfFloat 检测（resolvePostHdrDatatype）
- `packages/cesium-core/src/cesium/depthReconstruction.ts`：现有 depth 反演 GLSL（EMA reprojection 复用）
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`：sceneDist 反演（L329, L346-371）、glslangUtil.ts（共享 compile 辅助）

## 10. 文件清单（plan 阶段细化）

### 新增
- `packages/cesium-core/src/cesium/depthTemporal/depthTemporal.frag.ts`：depthTemporal fragment shader 组装器
- `packages/cesium-core/src/cesium/depthTemporal/depthTemporalConstants.ts`：α 范围、depthThreshold、ping-pong 默认
- `packages/cesium-core/src/cesium/depthTemporal/historyBlit.ts`：raw WebGL blit pass（移植 _blitBSM）+ history Texture 管理
- `packages/cesium-core/src/cesium/depthTemporal/*.test.ts`：shader compile + ping-pong + blit 单测

### 修改
- `packages/cesium-core/src/cesium/AtmosphereStage.ts`：装配 depthTemporal stage（atmosphere 前）+ history/blit 生命周期 + postRender hook + uniform 接线
- `packages/cesium-core/src/cesium/aerialPerspective.frag.ts`：sceneDist `czm_readDepth` → `texture().r`（L329, L350-355）
- `packages/cesium-core/src/cesium/aerialPerspective.frag.test.ts`：同步断言
- `apps/demo/src/main.ts`：URL 参数 `?temporalAlpha= ?lowAlpha= ?highAlpha= ?depthThreshold=`（调参）

### 文档
- `docs/superpowers/plans/2026-08-05-depth-temporal-ema.md`：实施 plan（writing-plans 产出）
- `docs/superpowers/plans/2026-08-05-depth-temporal-ema-results.md`：结果

## 11. 待 plan 阶段确认的细节

- 5-tap 邻域平均是否保留（EMA 已时序平滑，5-tap 可能冗余；或保留作空间补充）
- depthTemporal stage 是否独立 composite 还是并入 atmosphere composite
- blit 用 scene.postRender 还是 PostProcessStageCollection 的 stage 间钩子
- temporalAlpha 用 cameraDelta（positionWC）还是 viewMatrix 矩阵差（更精确含旋转）
- HALF_FLOAT history 是否需 clear 首帧（空 Texture loadNull 是否够）
