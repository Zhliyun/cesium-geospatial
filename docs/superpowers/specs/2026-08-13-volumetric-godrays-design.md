# phase2c 体积丁达尔效应（Volumetric God Rays）设计

> 状态：brainstorming → 3 专家评审（Cesium 集成 / 图形学大气物理 / 对抗性红队，2 approve_with_changes + 1 reject）→ **按评审大改（vec2 三分支 + C1/C2/C3 硬伤 + 声称降级）**，待用户审 → writing-plans
> 日期：2026-08-13（r1 评审修订版）
> 方向：体积 march shadow_length（Bruneton Eq.17/18 + three-geospatial 三分支），**物理启发式近似**（非纯物理正确，见 §7.7）
> 关联：
> - 废弃前置方案：`2026-08-12-tyndall-godrays-design.md`（屏幕空间 radial blur，HDR accumNorm 爆炸失败，已回退）
> - phase2a HDR 管线、phase2b LensFlare（`2026-08-04-phase2b-lens-flare-design.md`）
> - 参考库：three-geospatial `EpipolarShadowLengthNode`（WebGPU，地形 god rays）+ `runtime.ts:276-351`（三分支散射）

## 1. 背景与目标

### 1.1 前置方案失败教训

屏幕空间 radial blur 方案在本项目 HDR + ACES 物理管线下**根本性失败**：accumNorm ∝ atmosphere HDR（太阳方向 half-float 溢出 Inf/NaN），16 轮归一化全失控。结论：**屏幕空间 god rays 与 HDR 物理管线根本冲突**。代码已回退（79f8a43）。

### 1.2 体积 march 路线（物理启发式近似）

沿视线 march，累加被前景地物遮挡的长度，喂给 Bruneton 散射的阴影段处理 → crepuscular rays。

**诚实定性（r1 评审修订，图形学专家 reject 的核心）**：本方案是**物理启发式近似（physical-inspired）**，非纯物理正确。三个保真度差距（§7.7）：
1. screen-space sun ray march 测的是"camera 视野遮挡"非"太阳 POV 遮挡"（参考库用 CSM 真 shadow map）；
2. 缺 `HAS_HIGHER_ORDER_SCATTERING_TEXTURE`，Eq.18 走 #else 简单分支只阴影化 single scattering；
3. 地形 god rays 物理上限于低空（≤山脊高度 ~2-4km），天空尺度光柱需云（本项目无）。

走 vec2 + 三分支（§2.1）使阴影**位置**正确（区别于标量方案把远处阴影错置 camera 端），但上述三差距仍在。

**HDR 安全（r1 红队 survived 验证）**：shadow_length 是物理标量（米/km），经 Bruneton 只作 `GetTransmittance` 距离参数 + LUT 无量纲坐标，输出有界亮度，不放大 sun radiance，half-float 不溢出——根本区别于屏幕空间方案的 accumNorm ∝ HDR 太阳值。

### 1.3 目标与验收口径（r1 修订）

**目标**：在主用例（晨昏低太阳角，视线朝太阳附近，山脊在视线与太阳之间）产生**被山脊切割的低空光束**——山脊后方低空大气段阴影化（散射减少）与未遮挡段前向 Mie 散射的明暗对比。

**验收口径（r1 图形学专家修订）**：「山脊线附近被切割的**低空**光束」，**非**天空尺度贯穿光柱（后者物理上需云，本项目无）。区分两种用户预期：
- ✅ v1 支持：视线越过山脊看天空，山脊后方天空的明暗切割光束；
- ❌ v1 不支持：视线穿过近处山隙看空气中的光束（走地面分支，shadow_length=0，§6.1）、天空尺度贯穿光柱（需云）。

### 1.4 非目标

- 体积云参与的光束（耶稣光）——无体积云。
- epipolar 极线采样优化——three-geospatial WebGPU 路线，初版用全屏半分辨率 brute-force march（§8.4）。
- 地面分支 god rays（近处山隙丁达尔）——初版只接天空分支（§6.1），YAGNI 留后期。
- shadow map 路线——Cesium globe 不投射 shadow map（§7.1）。
- 纯物理正确 crepuscular rays——受 §7.7 三差距限制，v1 是物理启发式近似。

## 2. 方案选择

### 2.1 shadow_length 消费：vec2 + 三分支（r1 红队 refuted 标量后修订）

**标量方案被推翻**（r1 红队 REFUTE refuted + 图形学专家认同）：spec r0 的"方式1 标量单查询，物理正确非近似"是错的。Bruneton `GetSkyRadiance`（Eq.18，runtime.glsl:185-188）把标量 shadow_length 解释为"**阴影从 camera 起连续 l 米**"。典型 god ray 几何（camera 在光照区、山脊阴影在远处）下，标量把远处阴影**错置为 camera 端**，近处光照大气被错误减暗，实际阴影位置丢失。

**正确方案（three-geospatial runtime.ts:276-351 验证）**：march 输出 **vec2(totalShadowLength, distanceToFirstShadow)**，atmosphere 天空分支实现**三分支散射**：
- **Branch 1**（`totalShadowLength==0`）：无阴影，现状 `GetSkyRadiance(0)`。
- **Branch 3**（`totalShadowLength>0`，camera 在阴影外，**默认走此分支**）：A=`distanceToFirstShadow`，B=A+`totalShadowLength`，
  ```
  S = S(camera) - max(T(0,A)·S(A) - T(0,B)·S(B), 0)
  M = M(camera) - max(T(0,A)·M(A) - T(0,B)·M(B), 0)
  ```
  需 3 次 `GetCombinedScattering`（camera/A/B）+ 2 次 `GetTransmittance`（到 A/B）。
- **Branch 2**（`distanceToFirstShadow==0`，阴影从 camera 起）：`S = T(0,x)·S(x)`。three-geospatial `accurateShadowScattering=true` 默认**不走 Branch 2**（与 Branch 3 切换有不连续性，runtime.ts:340-344 注释），统一走 Branch 3。本项目同此默认。

> three-geospatial `accurateShadowScattering=false` 时走 Branch 2（标量等价），但默认 true 走 Branch 3。本项目固定 Branch 3（阴影在远处是 god rays 主几何）。

**为什么不用 GetSkyRadiance wrapper**：cesium `runtime.glsl` 的 `GetSkyRadiance`（L133-216）只实现标量 Eq.18（camera 端连续段），不支持 Branch 3。三分支须在 atmosphere shader 内手写（调底层 `GetCombinedScattering`/`GetTransmittance`/`GetExtrapolatedSingleMieScattering` + phase，§5.1）。

### 2.2 shadow 源：B（太阳方向 screen-space ray march）

体积 god rays 核心是判断"视线上每段大气是否被地形遮挡了**阳光**"。三方案评审后用户选 **B**（物理保真优先）：每段视线采样点 P 沿太阳方向做二次 screen-space ray march 测真实阳光遮挡，任意视线方向几何正确，代价 N×M 成本 + screen-space 固有限制（§7.2）。

### 2.3 为什么不直接移植 three-geospatial

`EpipolarShadowLengthNode`（WebGPU/TSL）依赖 **CSM 阴影贴图**，两个不可移植点：
1. Cesium globe 地形不写 shadow map（§7.1）→ CSM 无数据源；
2. WebGPU/TSL vs 本项目 GLSL ES 3.00 PostProcessStage → 需重写。

本项目路线：保留 three-geospatial 物理语义（vec2 + 三分支 march → shadow_length → Bruneton），shadow 源用 screen-space sun ray march 替代 CSM（§4.3），全屏半分辨率 brute-force 替代 epipolar（初版）。

## 3. 架构

### 3.1 链位置与 composite 包裹（r1 C1 critical 修订）

**r0 错误**：把 `gr_shadowLength` 当链中独立顶层 stage。Cesium `PostProcessStageCollection.execute`（@cesium/engine Scene/PostProcessStageCollection.js:818-828）顶层 series **无条件**把前一 stage 输出当下一 stage 的 colorTexture（不判 `inputPreviousStageTexture`，该 flag 只在 composite 内递归生效 L740-755）。`gr_shadowLength` 输出 shadow_length（非场景色）→ atmosphere 的 colorTexture/originalColor/`.a` depth 全崩。

**r1 修复（照搬 lensflare composite 模式）**：`gr_shadowLength` 包进非序列 composite，composite 最后一个子 stage 是透传 stage 输出场景色：

```
外层 gr_wrapper = PostProcessStageComposite({
  name: 'gr_wrapper',
  stages: [gr_shadowLength, gr_passthrough],   // inputPreviousStageTexture: false
  inputPreviousStageTexture: false
})
  ├─ gr_shadowLength：半分辨率 march，输出 vec2(totalShadowLength, distanceToFirstShadow)（.rg）
  └─ gr_passthrough：全分辨率，out_FragColor = texture(colorTexture, v_textureCoordinates)
                    （透传 depthTemporal 的 vec4(sceneColor, smoothLogDepth)，保 atmosphere 读 .a EMA depth 不变）
```

- composite 输出 = `getOutputTexture(最后一个子 stage)` = `gr_passthrough` = 场景色 → atmosphere colorTexture 正确，链不破。
- `atmosphere.u_shadowLengthTexture = 'gr_shadowLength'`（uniform-name 引用 composite **内**子 stage，同 lensflare `lf_occlusion` 是 composite 内半分兄弟被 features 引用的先例）。
- **add 顺序**（执行序 = add 序，见 §3.2）：`depthTemporal → gr_wrapper → atmosphere → lensflare → tonomap`。

> `gr_passthrough` 必须**最后**（composite output = 最后子 stage output）。`gr_shadowLength` 与 `gr_passthrough` 是 non-series 兄弟（`inputPreviousStageTexture:false`），`gr_passthrough.colorTexture` = `gr_wrapper` 的输入（depthTemporal 输出），非 `gr_shadowLength` 输出。

### 3.2 uniform-name 跨 stage 引用机制（r1 minor 修订：纠正 r0 机制描述）

执行顺序由 **add 顺序**决定（`PostProcessStageCollection.activeStages` 按 add 顺序填充，execute 串行），**不是** `getStageDependencies` 排序。uniform-name string 引用的真正作用：(a) 建立 framebuffer 依赖防止同 scale 共享冲刷（I9 类 bug）；(b) 让 Cesium 把 string 解析为对应 stage 的 outputTexture（`PostProcessStage.updateUniformTextures` :670-679）。`_stageNames` 全局 flat 字典（`:560 getStageByName`）支持跨顶层/composite 内查找——`atmosphere.u_shadowLengthTexture='gr_shadowLength'`（顶层→composite 内）等价可行（lensflare `occlusion.depthTexture='czm_depth_temporal'` composite 内→顶层是生产先例）。

### 3.3 depth 源：raw globe depth（r1 important 修订）

**r0 错误**：声称 march 读 `czm_depth_temporal`（EMA smoothDepth）"与 atmosphere 同源"。实际 `AtmosphereStage.ts:372` 显式 `hdrDepthTemporal:false`（Bug3 禁用 EMA），atmosphere 读 **raw globe depth**（`aerialPerspective.frag.ts:360 texture(depthTexture).r`），不同源。且 depthTemporal EMA 有已知 Bug3（reproject 错→地球切割+水波纹），march 若读它会继承伪影 + camera 运动时 depth 滞后→shadow_length 拖影→god rays 撕裂。

**r1 修复**：march 的 depth 源 = **Cesium 内建 scene globe depth**（与 atmosphere 实际同源）。`gr_shadowLength` stage 不覆盖 depthTexture uniform（Cesium 自动提供 scene depth），shader 统一用 `czm_readDepth(depthTexture, uv)`。放弃 EMA 消抖，但 god rays 对 depth 抖动不敏感（shadow_length 低频标量），换稳定性。

### 3.4 像素类型与采样（r1 important 修订）

- `gr_shadowLength`：`pixelDatatype: postHdrDatatype`（HalfFloat），`pixelFormat: RGBA`（PostProcessStage 要求 RGBA；vec2 存 `.rg`，`.ba` 填 0），`textureScale: 0.5`（半分辨率）。
- `gr_passthrough`：`pixelDatatype: postHdrDatatype`，`textureScale: 1.0`（全分辨率，1:1 透传保 atmosphere .a depth 精度）。
- **上采样 sampleMode（r1 important 修订）**：r0 称"gr_shadowLength 设 sampleMode:LINEAR → atmosphere 读无方块"是**错的**。Cesium `sampleMode` 只作用于 stage 的**输入** colorTexture（`PostProcessStage.js:949-954`），output 纹理 sampler 永远 NEAREST（`FramebufferManager.js:171/195/225`）。atmosphere 读 `gr_shadowLength` output 走 **NEAREST**。
  - 方案 A（推荐初版）：接受 NEAREST，god rays 低频，0.5× 半分 2×2 方块在 ACES+groundDim 后视觉可接受（lensflare occlusion 0.0625→features NEAREST 已生产验证 `features.frag.ts:102`）。T7 验收见方块走方案 B。
  - 方案 B：atmosphere shader 内对 `u_shadowLengthTexture` 手动 4-tap 双线性（textureSize + 0.5/texel 中心偏移，4 次 texture() 加权）绕过 sampler 限制。

## 4. Shader 算法

### 4.1 early-exit（preRender CPU + shader 内 uniform 判定）

march pass（`gr_shadowLength`）**始终 enabled**（`gr_wrapper` 始终执行；不能用 `enabled=false`——r1 Cesium 专家 + 红队 survived 验证：disabled stage 在 `getStageDependencies` 被跳过→无 framebuffer→outputTexture undefined→atmosphere 读 undefined sampler→GL 未定义行为）。

`preRender` CPU 判 `sunDirection`，设 `u_godRaysSunVisible` uniform（int 0/1）：
- 太阳在地平下（`dot(sunDirectionWC, cameraUp) < -twilightAngle`，复用 `getEffectiveAtmosphereExposure`）→ `0`。
- 太阳在视野外（`sunBehindCamera || !sunOnScreen`，复用 lensflare occlusion.frag 太阳屏幕位置判定）→ `0`。

`gr_shadowLength` shader `main` 开头：`if (u_godRaysSunVisible == 0) { out_FragColor = vec4(0.0); return; }`（全屏输出 vec2(0,0)，atmosphere 走 Branch 1 零回归）。太阳可见时正常 march。`?godRays=0` 同理（preRender 强制 `u_godRaysSunVisible=0`）。

### 4.2 主 march + first moment（r1 C3 单位修订 + A1 vec2 修订）

```glsl
// 1. 重建视线方向（复用 aerialPerspective.frag:109-116 reconstructRay 同逻辑：
//    czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, near/far, 1.0)) 近/远差分 → world rayDir）
vec3 rayDir;
reconstructRay(czm_viewerPositionWC, rayDir);

// 2. camera/单位（r1 C3 修订：必须与 atmosphere 完全同框架，km 域 + altitudeCorrection）
vec3 altitudeCorrection = u_altitudeCorrection;  // state.altitudeCorrection，km
vec3 cameraWC = (czm_viewerPositionWC + altitudeCorrection) * METER_TO_LENGTH_UNIT;  // km 域
float topR = u_atmosphereTopRadius;  // km（统一用 uniform，不引 ATMOSPHERE const，保持 shader 独立）
float rmu = dot(cameraWC, rayDir);
float pointDist = max(-rmu - sqrt(rmu*rmu - dot(cameraWC,cameraWC) + topR*topR), 0.0);  // camera→大气顶层

// 3. 主 march + first moment 累加（透视增长步长，jitter 起始）
float totalShadowLength = 0.0;
float firstShadowMoment = 0.0;
float t = u_godRaysMainStep0 * jitterHash();
float step = u_godRaysMainStep0;
for (int i = 0; i < GOD_RAYS_MAIN_STEPS; ++i) {  // N=16
  if (t > pointDist) break;
  vec3 P = cameraWC + rayDir * t;  // km 域
  bool lit = sunRayMarchLit(P);  // §4.3
  if (!lit) {
    float centerDist = t + step * 0.5;
    totalShadowLength += step;
    firstShadowMoment += step * centerDist;  // first moment（阴影段长 × 段中心距）
  }
  step *= u_godRaysMainStepGrowth;  // 透视增长（1.3），覆盖 ~109km 被 pointDist 截断
  t += step;
}

// 4. first moment → distanceToFirstShadow（three-geospatial EpipolarShadowLengthNode:582-595）
float distanceToFirstShadow = pointDist;  // 无阴影标记
if (totalShadowLength > 1e-6) {
  distanceToFirstShadow = clamp(
    firstShadowMoment / totalShadowLength - totalShadowLength * 0.5,
    0.0, max(pointDist - totalShadowLength, 0.0));
  if (distanceToFirstShadow < 1.0 / 1000.0) distanceToFirstShadow = 0.0;  // <1m→阴影从 camera 起（Branch 2 语义，但默认走 Branch 3）
}
out_FragColor = vec4(totalShadowLength * u_godRaysIntensity, distanceToFirstShadow, 0.0, 1.0);  // .rg=vec2，km，HalfFloat
```

**步长（r1 minor 修订）**：主 march step0=0.5km × growth=1.3^16 ≈ **109km**（r0 误写 50km），被 `pointDist`（大气顶层）截断。近处 step0=0.5km 对山脊（几 km 宽）可能偏粗，T1 标定可调 step0=0.2km。

### 4.3 太阳光线 march（r1 C2 depth 通道 + 反演修订 + C3 单位修订）

```glsl
bool sunRayMarchLit(vec3 P_km) {
  for (int j = 0; j < GOD_RAYS_SUN_STEPS; ++j) {  // M=8
    float s = u_godRaysSunStep0 * pow(u_godRaysSunStepGrowth, float(j));  // km
    vec3 Q_km = P_km + sunDirectionWC * s;  // km 域（sunDirectionWC 是单位向量，世界系）
    // Q 投影到屏幕：czm_viewProjection 期望 ECEF 米，km→米转回（r1 C3）
    vec4 QClip = czm_viewProjection * vec4(Q_km * (1.0 / METER_TO_LENGTH_UNIT), 1.0);
    if (QClip.w <= 0.0) break;                      // Q 在 camera 后方 → fallback（保持当前 lit）
    vec3 QNdc = QClip.xyz / QClip.w;
    if (any(lessThan(QNdc.xy, vec2(-1.0))) || any(greaterThan(QNdc.xy, vec2(1.0)))) break;  // 出屏幕
    vec2 QUv = QNdc.xy * 0.5 + 0.5;
    // depth 反演（r1 C2 修订：raw globe depth 是 log-depth，须 czm_reverseLogDepthWindow → 4-arg windowToEyeCoordinates）
    float logDepth = texture(depthTexture, QUv).r;  // scene globe depth 在 .r（r1 §3.3 改用 raw globe，非 .a）
    float winDepth = czm_reverseLogDepthWindow(logDepth, czm_currentFrustum.x, czm_currentFrustum.y);
    vec4 QEyePos = czm_windowToEyeCoordinates(vec4(QUv * czm_viewport.zw, winDepth, 1.0));
    if (abs(QEyePos.w) > 1e-6) QEyePos /= QEyePos.w;
    float sceneEyeZ = QEyePos.z;
    float QEyeZ = (czm_view * vec4(Q_km * (1.0 / METER_TO_LENGTH_UNIT), 1.0)).z;
    if (QEyeZ < sceneEyeZ - u_godRaysDepthBias) return false;  // Q 比 scene 远 → P 被挡阳光 → shadow
  }
  return true;
}
```

**depth 反演链（r1 C2 关键）**：复刻 `aerialPerspective.frag.ts:349-356,390` 已验证的链：raw log-depth → `czm_reverseLogDepthWindow(near,far)` → window-depth → 4-arg `czm_windowToEyeCoordinates(vec4(windowXY, winDepth, 1.0))` → eye-space z（经透视除法）。shader 须带 LOG_DEPTH defines（cesiumCore 注入），glslang 桩补 `czm_reverseLogDepthWindow`/`czm_currentFrustum`/`czm_viewport`（aerialPerspective VALIDATION_STUBS 已有先例）。

**screen-space 固有限制（§7.2/§7.4）**：Q 出屏幕/camera 后方 `break`（fallback 保持当前 lit，保守不产假阴影）。低太阳角主用例 Q 出屏幕概率高（§7.4 plausible_concern），T7 必须实测。

## 4.4 太阳方向复用

`sunDirectionWC` 由 AtmosphereStage `preRender` 每帧更新（Simon1994 + ICRF→Fixed，`state.sunDirection`）。march pass uniforms 闭包读同一 `state.sunDirection` + `state.altitudeCorrection`，与 atmosphere 同源。

## 5. atmosphere stage 接入（r1 A1 大改：三分支散射）

### 5.1 天空分支：vec2 + 三分支散射（替代 r0 标量 getSkyRadiance）

当前 `aerialPerspective.frag.ts:313` 天空分支：
```glsl
inscatter = getSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, fragmentAngle, transmittance);
```
改为读 vec2 shadow_length + 三分支：
```glsl
vec2 shadowLengthVec2 = texture(u_shadowLengthTexture, v_textureCoordinates).rg;  // NEAREST 上采样（§3.4）
inscatter = getSkyRadianceShadowed(cameraPosition, rayDirection, shadowLengthVec2, sunDirection, fragmentAngle, transmittance);
```

**新函数 `getSkyRadianceShadowed`**（手写三分支，移植 three-geospatial runtime.ts:276-351，调 cesium runtime.glsl 底层 helper）：

```glsl
vec3 getSkyRadianceShadowed(vec3 camera, vec3 rayDir, vec2 shadowLengthVec2,
                            vec3 sunDir, float fragmentAngle, out vec3 transmittance) {
  // —— 复用 GetSkyRadiance 前段：camera 在大气壳层处理、r/mu/mu_s/nu、transmittance ——
  // （省略：同 runtime.glsl GetSkyRadiance L148-178 + aerialPerspective getSkyRadiance L296-303 前段）
  float r = length(camera); float mu = dot(camera, rayDir)/r;
  float mu_s = dot(camera, sunDir)/r; float nu = dot(rayDir, sunDir);
  // ... ray_r_mu_intersects_ground / horizon eps / transmittance = GetTransmittanceToTopAtmosphereBoundary ...

  float x = shadowLengthVec2.x;  // totalShadowLength
  // —— Branch 1：无阴影 ——
  if (x <= 0.0) {
    return GetSkyRadiance(camera, rayDir, 0.0, sunDir, transmittance);  // 现状，零回归
  }

  // —— Branch 3：camera 在阴影外，阴影段 [A, B]（three-geospatial runtime.ts:302-320）——
  float A = shadowLengthVec2.y;          // distanceToFirstShadow
  float B = A + x;                        // shadowLimit

  // S(camera), M(camera) 在 camera 处
  IrradianceSpectrum singleMieCam;
  IrradianceSpectrum Scam = GetCombinedScattering(ATMOSPHERE, scattering_texture,
    single_mie_scattering_texture, r, mu, mu_s, nu, ray_r_mu_intersects_ground, singleMieCam);

  // a 在 A 处（沿视线 A 米）
  float rA = ClampRadius(ATMOSPHERE, sqrt(A*A + 2.0*r*mu*A + r*r));
  float muA = (r*mu + A)/rA;  float muSA = (r*mu_s + A*nu)/rA;
  IrradianceSpectrum singleMieA;
  IrradianceSpectrum Sa = GetCombinedScattering(ATMOSPHERE, scattering_texture,
    single_mie_scattering_texture, rA, muA, muSA, nu, ray_r_mu_intersects_ground, singleMieA);
  DimensionlessSpectrum TA = GetTransmittance(ATMOSPHERE, transmittance_texture,
    r, mu, A, ray_r_mu_intersects_ground);

  // b 在 B 处（沿视线 B 米）
  float rB = ClampRadius(ATMOSPHERE, sqrt(B*B + 2.0*r*mu*B + r*r));
  float muB = (r*mu + B)/rB;  float muSB = (r*mu_s + B*nu)/rB;
  IrradianceSpectrum singleMieB;
  IrradianceSpectrum Sb = GetCombinedScattering(ATMOSPHERE, scattering_texture,
    single_mie_scattering_texture, rB, muB, muSB, nu, ray_r_mu_intersects_ground, singleMieB);
  DimensionlessSpectrum TB = GetTransmittance(ATMOSPHERE, transmittance_texture,
    r, mu, B, ray_r_mu_intersects_ground);

  // Branch 3 公式（three-geospatial runtime.ts:318-319）
  IrradianceSpectrum scattering = Scam - max(TA * Sa - TB * Sb, DimensionlessSpectrum(0.0));
  singleMieCam = singleMieCam - max(TA * singleMieA - TB * singleMieB, DimensionlessSpectrum(0.0));

#ifdef COMBINED_SCATTERING_TEXTURES
  singleMieCam = GetExtrapolatedSingleMieScattering(ATMOSPHERE, vec4(scattering, singleMieCam.r));
#endif
  singleMieCam *= smoothstep(0.0, 0.01, mu_s);  // sun below horizon hack

  return (scattering * RayleighPhaseFunction(nu) + singleMieCam *
          MiePhaseFunction(ATMOSPHERE.mie_phase_function_g, nu)) * SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
  // SUN_DISK_GLSL（日盘叠加）由外层 skyBranch 选项附加，同 getSkyRadiance
}
```

> **实现要点**：r_p/mu_p/mu_s_p + GetTransmittance + GetCombinedScattering 模式复刻自 `GetSkyRadianceToPointScaled`（aerialPerspective.frag.ts:208-250，已验证）。Branch 3 共 3 次 GetCombinedScattering + 2 次 GetTransmittance（camera/A/B），比标量 1 次查询贵 3×，但只在天空分支 + `x>0` 时（§8.1 成本）。COMBINED_SCATTERING_TEXTURES 外推 single Mie 同现状。无 `HAS_HIGHER_ORDER_SCATTERING_TEXTURE` → 用总散射（含多阶）做 S(camera)/S(A)/S(B)，对比度弱于 three-geospatial（§7.7 已知上限）。

### 5.2 地面分支保持 shadow_length=0（零回归）

`GetSkyRadianceToPointScaled` 两处（base L455、fore L475）**保持第 3 参 `0.0`**，不改（§6.1）。

### 5.3 atmosphere uniforms 新增

`buildAtmosphereUniforms` 新增 `u_shadowLengthTexture: godRaysEnabled ? 'gr_shadowLength' : undefined`。shader 侧 `u_shadowLengthTexture` 声明 + `getSkyRadianceShadowed` 按 `godRays` option 条件生成（同 lensflare `useOcclusionTexture` 模式）：godRays=true 声明 sampler + 读 vec2 + 三分支；false 时不声明、天空分支走原 `getSkyRadiance(0)`（零回归）。

## 6. 与 B 路径 DUAL inscatter 融合

### 6.1 接入范围：初版只接天空分支（r1 诚实标注地面缺失）

shadow_length 只接入天空分支（L313 `getSkyRadianceShadowed`）。地面 base（L455）/ fore（L475）保持 `0.0`。

**理由 + 诚实标注（r1 红队 minor 修订）**：god rays 主形态（视线越山脊看天空）在天顶分支。但经典丁达尔照片中"视线穿近处山隙看空气中光束"走地面分支（shadow_length=0）→ **v1 缺失**，需后期扩展 base L455。spec §1.3 已区分两用例预期。

### 6.2 零回归安全网

god rays 关闭时任一路径 → vec2 shadow_length=0 → `getSkyRadianceShadowed` Branch 1（`x<=0`）→ 调 `GetSkyRadiance(0)` → runtime.glsl L179 `shadow_length==0` 原分支 → 与 phase1 bit 等价：
- `godRays=false`：march pass 不创建，atmosphere `u_shadowLengthTexture` 不传，shader 走 godRays=false 分支（原 getSkyRadiance(0)）。
- `?godRays=0` / 太阳地平下 / 视野外：preRender `u_godRaysSunVisible=0` → march 输出 vec2(0,0) → Branch 1。

**测试**：零回归用例断言 god rays 关闭时 atmosphere 天空分支产出与 phase1 bit 等价（Branch 1 走原路径）。

### 6.3 上采样：NEAREST（r1 important 修订）

march 半分辨率 → atmosphere 全分辨率读 `u_shadowLengthTexture`，**NEAREST**（§3.4，Cesium output 默认 NEAREST，sampleMode 无法改）。god rays 低频，T7 验收见方块则 atmosphere 内手动 4-tap 双线性（§3.4 方案 B）。

## 7. 关键约束与陷阱

### 7.1 Cesium globe 不投射 shadow map（根本约束）

Cesium `ShadowMap` 只对 primitive/entity/3D Tiles，**不对 Globe/terrain**。"地形遮挡阳光"只能 screen-space depth 近似（§4.3）。这是与 three-geospatial（CSM）的根本差异。

### 7.2 screen-space 视野外遮挡丢失（B 路线固有限制）

screen-space sun ray march 只能看到 camera 视野内、Q 投影在屏幕内的地形遮挡。视野外挡阳光的山看不到。极端视角光束缺失（同 lensflare occlusion 限制，接受）。

### 7.3 HDR 安全

shadow_length（km）经 `u_godRaysIntensity` 缩放仍是有界正标量（0–~109km）。Branch 3 用它作 GetTransmittance 距离参数 + GetCombinedScattering 无量纲坐标，输出有界亮度。half-float 不溢出（红队 survived 验证）。

### 7.4 screen-space sun march 在主用例的未验证风险（r1 红队 plausible_concern）

低太阳角（主用例）时 sunDirection 近水平，P 沿 sunDir 步进的 Q **大概率出屏幕**→break→判 lit→不累加 shadow_length→god rays 缺失。**这是方案在主用例的核心未验证风险**。T7 必须用 `?debug=10` 在晨昏低角度实测山脊后方有非零 shadow_length。若低角度 march 失效，缓解：(1) 增大 sun march 步长使 Q 留屏；(2) 出屏幕用 last-on-screen depth 外推；(3) spec 显式标注"仅近处山脊（Q 留屏）有效"。

### 7.5 降采样时序闪烁（r1 红队 important 修订）

`jitterHash()` 每像素不同，camera 移动时半分像素 jitter 种子 + 视线几何变化 → shadow_length 逐帧翻转 → god rays 闪烁。shadow_length 在山脊轮廓处是高频阶跃（lit↔shadow 硬切），半分辨率 NEAREST 会把切割线模糊成阶梯。

**r1 缓解（红队建议）**：初版加轻量时序稳定——jitter 用 **4-frame 旋转 pattern**（非纯 spatial hash）+ NEAREST。或减半 sun march 步数 M 换全分辨率（N16×M4 全分 ≈ N16×M8 半分的 2× 成本）消除半分伪影。T7 验收必须测 camera 缓慢平移/旋转时的闪烁。

### 7.6 depth bias 防 acne

太阳 march eye-space 深度比较需 `u_godRaysDepthBias`（初版 0.01km）防 self-occlusion acne。T1 标定。

### 7.7 物理保真度上限（r1 图形学专家 reject 核心，新增）

v1 是**物理启发式近似**，三差距：
1. **screen-space sun march 是 camera-depth 测试非太阳 POV**（参考库用 CSM 真 shadow map）→ 对大气尺度 P（km 高），Q 投影到天空 depth=1 或远处地形，march 退化为恒判 lit（§7.4）。
2. **缺 HAS_HIGHER_ORDER_SCATTERING_TEXTURE**（lutLoader 只有 transmittance/scattering/irradiance 三张）→ Branch 3 的 S(camera)/S(A)/S(B) 用含多阶的总散射，对比度弱于 three-geospatial（多阶未正确阴影化）。
3. **地形 god rays 物理限于低空**（阴影体边界高度 ≈ h + d·tanε，山脊高 h、太阳仰角 ε；ε=5° d=10km 处边界仅 h+0.87km）→ 无天空尺度贯穿光柱（需云）。

**v1 验收口径**（§1.3）：山脊线附近被切割的低空光束，非物理正确 crepuscular rays。若 T7 对比度不足：可选 (a) 预计算加载 higher-order LUT（工程量大），(b) `u_godRaysIntensity>1` 人为放大（偏离物理但可验收）。

## 8. 性能

### 8.1 成本估算（r1 红队 minor 修订）

- march pass（gr_shadowLength，半分辨率）：N16×M8=128 次 depth 查询 + 投影矩阵乘 + log depth 反演 / 半分像素 ≈ 32/全分像素。
- atmosphere 天空分支 Branch 3（仅天空像素 + `x>0`）：3 次 GetCombinedScattering + 2 次 GetTransmittance（比标量 1 次贵 3×，但 LUT 查询比 depth march 便宜）。
- **v1 必加 depth-based skip**（§8.4 前移）：march 开头读本像素 depth，地面像素（shadow_length 被 atmosphere 天空分支忽略）直接输出 0 return，省 30–50% 像素的完整 march。
- dependent texture fetch（太阳 march 每步）是 GPU 性能杀手。<2ms/帧（1080p）需 `?profile=1` 实测，**偏乐观预估非承诺**。

### 8.2 early-exit

`preRender` `u_godRaysSunVisible=0`（太阳地平下/视野外）→ march early-return 0（无循环）。白天大半时间太阳在视野外，收益显著。

### 8.3 profile

复用 demo `?profile=1` 逐 stage GPU 计时（`gr_wrapper`/`gr_shadowLength` 作为键）。性能不达标触发 §8.4。

### 8.4 后期优化（非初版）

epipolar 极线采样（5–10× 加速，GLSL 移植复杂）；min/max mip depth 层次结构（自适应步长）；temporal 降噪（减步数）。初版 brute-force 半分辨率 N16×M8 + depth-based skip。

## 9. uniforms 与 URL 参数

### 9.1 march pass uniforms（gr_shadowLength）

```glsl
uniform sampler2D depthTexture;        // Cesium 内建 scene globe depth（r1 §3.3，非 czm_depth_temporal）
uniform vec3  u_sunDirectionWC;        // state.sunDirection
uniform vec3  u_altitudeCorrection;    // state.altitudeCorrection（r1 C3 单位对齐）
uniform float u_atmosphereTopRadius;   // 大气顶层半径 km（统一 uniform，不引 ATMOSPHERE const）
uniform int   u_godRaysMainSteps;      // 主 march 步数（默认 16）
uniform float u_godRaysMainStep0;      // 主 march 起始步长 km（默认 0.5）
uniform float u_godRaysMainStepGrowth; // 主 march 步长增长（默认 1.3）
uniform int   u_godRaysSunSteps;       // 太阳 march 步数（默认 8）
uniform float u_godRaysSunStep0;       // 太阳 march 起始步长 km（默认 0.5）
uniform float u_godRaysSunStepGrowth;  // 太阳 march 步长增长（默认 1.5）
uniform float u_godRaysDepthBias;      // eye-space 深度 bias km（默认 0.01）
uniform float u_godRaysIntensity;      // 强度缩放（默认 1.0=物理启发式，0=关闭）
uniform int   u_godRaysSunVisible;     // preRender CPU 算（太阳地平下/视野外=0，shader early-return 0）
uniform int   u_debugMode;             // 与 atmosphere 同源
```

`METER_TO_LENGTH_UNIT` 从 cesiumCore buildAtmospherePrefix #define。`czm_viewerPositionWC`/`czm_view`/`czm_viewProjection`/`czm_windowToEyeCoordinates`/`czm_reverseLogDepthWindow`/`czm_currentFrustum`/`czm_viewport`：Cesium 自动注入（compile 桩补）。

### 9.2 AtmosphereStageOptions 新增

```ts
godRays?: boolean              // 默认 true（?godRays=0 关）
godRaysIntensity?: number      // 默认 1.0
godRaysMainSteps?: number      // 默认 16
godRaysSunSteps?: number       // 默认 8
```

### 9.3 demo URL 参数

- `?godRays=0/1`（默认 1）：preRender 强制 `u_godRaysSunVisible=0` + atmosphere shader 分支。
- `?godRaysIntensity=N`、`?godRaysMainSteps=N`、`?godRaysSunSteps=N`：调参。
- `?debug=10`：shadow_length RT 可视化（.r=totalShadowLength false-color + .g=distanceToFirstShadow）。

## 10. debug probe

`u_debugMode` 扩展（与 atmosphere debug=1/2/3/5/6/7/8 同源）：
- **debug=10**：march pass 直接输出 vec2 可视化（.r=totalShadowLength / maxRef → jet colormap，.g=distanceToFirstShadow / pointDist → 第二色）。排查 march 累加、太阳方向、early-exit、distanceToFirstShadow first-moment 反推。
- **debug=11**（备选）：太阳 march lit 状态（主 march 第一采样点 lit/shadow 黑白）。

debug=10/11 在 march pass 内截获输出，不进 atmosphere 消费链。

## 11. 测试策略（项目惯例 TDD）

### 11.1 shader 构建器单测

- `buildGodRaysMarchFragmentShader(options)`：产出含预期 uniform、`GOD_RAYS_MAIN_STEPS`/`SUN_STEPS` 宏、`sunRayMarchLit`、主 march + first moment 累加、distanceToFirstShadow 反推、vec2 输出。
- `buildAerialPerspectiveFragmentShader({godRays:true})`：天空分支调 `getSkyRadianceShadowed`（读 vec2 + 三分支），含 Branch 1/3。
- `buildAerialPerspectiveFragmentShader({godRays:false})`：天空分支原 `getSkyRadiance(0)`（零回归）。

### 11.2 GLSL compile test

`godRaysMarch.compile.test.ts` + `aerialPerspective` 扩展：glslangValidator + `#version 300 es` + `out vec4 out_FragColor`（r1 minor：非 gl_FragColor）+ `czm_*`/`czm_windowToEyeCoordinates`/`czm_reverseLogDepthWindow`/`czm_currentFrustum`/`czm_viewport` 桩（aerialPerspective VALIDATION_STUBS 先例）。godRays=true/false 两分支都过。

### 11.3 stage 创建单测

- `gr_wrapper` 是 `PostProcessStageComposite`（`inputPreviousStageTexture:false`），子 stage `[gr_shadowLength, gr_passthrough]`，`gr_passthrough` 最后。
- `gr_passthrough` 透传 colorTexture（输出场景色），`gr_wrapper` 在 `atmosphere` 前 add。
- `atmosphere.u_shadowLengthTexture === 'gr_shadowLength'`（uniform-name string）。
- 半分辨率（gr_shadowLength textureScale=0.5）+ 全分辨率 passthrough（1.0）+ HalfFloat。
- `godRays=false` 时 gr_wrapper 不创建 + atmosphere `u_shadowLengthTexture` undefined。
- early-exit：`preRender` 太阳地平下/视野外时 `u_godRaysSunVisible=0`，shader early-return 0（不用 enabled=false）。

### 11.4 零回归测试

god rays 关闭：atmosphere 天空分支走 Branch 1（`getSkyRadiance(0)` 原路径）。现有 aerialPerspective.frag.test.ts 全部用例不回归。

### 11.5 视觉验收（demo，r1 口径修订）

- 晨昏低角度、视线朝太阳、山脊在前 → 山脊线附近被切割的低空光束（§1.3 口径）。
- `?debug=10`：山脊后方天空 totalShadowLength 非零（暖色）、distanceToFirstShadow 反映阴影段位置。
- `?godRays=0` 与 phase1 一致（零回归）。
- **§7.4 核心验证**：晨昏低角度实测 march 是否测到遮挡（红队 plausible_concern）。
- `?profile=1` march pass + atmosphere Branch 3 占比可接受。
- camera 缓慢移动测试时序闪烁（§7.5）。

## 12. 任务分解概要（writing-plans 预览）

1. **T1 march shader 构建器 + compile**：`buildGodRaysMarchFragmentShader`（vec2 first-moment 输出 + sun ray march + depth 反演链 + km 单位），glslang 过。
2. **T2 atmosphere 三分支 shader**：`getSkyRadianceShadowed`（Branch 1/3，调 GetCombinedScattering/GetTransmittance），godRays=false 零回归。
3. **T3 composite stage + 链位置**：`gr_wrapper=[gr_shadowLength, gr_passthrough]`，uniform-name 引用，raw globe depth，early-exit uniform。
4. **T4 AtmosphereStageOptions + demo URL**：godRays/intensity/steps 参数化。
5. **T5 debug probe**：debug=10 vec2 可视化。
6. **T6 单测全过 + tsc + glslang + 零回归**。
7. **T7 视觉验收 + 参数标定**：§7.4 低角度 march 有效性实测、step0/growth/bias/intensity、profile、时序闪烁。

（精确任务分解由 writing-plans 产出。）

---

## 附录 A：Bruneton shadow_length 物理语义 + 三分支（r1 图形学专家行号修订）

**GetSkyRadianceToPoint（地面，Eq.17，runtime.glsl:317-356）**：shadow_length>0 时第二查询点向 **point 端**移 l 米（L322 `d=max(d-shadow_length,0)`，注释 L318-321 "ignore scattering along the **last** shadow_length meters"），point 端连续段。

**GetSkyRadiance（天空，Eq.18，runtime.glsl:179-213）**：shadow_length>0 时查询点在 x_s=camera+l·v（**camera 端**连续段，L189 `d=shadow_length`，注释 L185-188 "omit scattering between camera and point at distance l"）。**两 Eq 阴影段位置相反**（r0 把 Eq.17 行号/语义套到 Eq.18，已修）。本项目天空分支用 Eq.18 几何（camera 端），但标量 Eq.18 只处理"阴影从 camera 起"——对"阴影在远处"须 Branch 3（§5.1）。

**三分支（three-geospatial runtime.ts:276-351，本项目 §5.1 移植）**：vec2(totalShadowLength, distanceToFirstShadow) → Branch 1（x==0 无阴影）/ Branch 3（x>0，`S=S(camera)-max(T(0,A)S(A)-T(0,B)S(B),0)`，A=distanceToFirstShadow, B=A+x）/ Branch 2（y==0 阴影从 camera 起 `S=T(0,x)S(x)`，默认不走）。`distanceToFirstShadow` 由 march first moment 反推（`m/x-0.5x`，EpipolarShadowLengthNode.ts:582-595）。

## 附录 B：参考实现对照（r1 修订）

| 维度 | three-geospatial EpipolarShadowLengthNode + runtime.ts | 本项目（Cesium） |
|---|---|---|
| 遮挡源 | CSM shadow map | screen-space sun ray march（§4.3） |
| march 策略 | epipolar + min/max mip | 全屏半分辨率 brute-force（初版） |
| 输出 | vec2(totalShadowLength, distanceToFirstShadow) | **同**（§4.2 first moment） |
| 消费 | runtime.ts 三分支 Branch 1/2/3 | **同**（§5.1，默认 Branch 3） |
| higher-order LUT | 有（多阶正确阴影化） | **无**（对比度弱，§7.7） |
| 后端 | WebGPU/TSL | GLSL ES 3.00 PostProcessStage + composite |

## 附录 C：r1 评审修订摘要（3 专家，2026-08-13）

| 评审项 | 级别 | 来源 | r1 修订 |
|---|---|---|---|
| 链拓扑（独立 stage 顶替 colorTexture） | critical | 3 专家共识 | §3.1 包进 composite + passthrough |
| depth 通道 .x→.a/.r + 跳过 log 反演 | critical | 3 专家共识 | §4.3 czm_reverseLogDepthWindow 链 + §3.3 raw globe depth |
| 单位米/km 混用 | critical/important | 3 专家共识 | §4.2 km 域 + altitudeCorrection + METER_TO_LENGTH_UNIT |
| 标量 shadow_length 语义错配 | critical（refuted） | 红队 + 图形学 | §2.1/§5.1 升级 vec2 + 三分支 |
| 物理正确过度声称 | important（reject 核心） | 图形学 | §1.2/§7.7 降级为物理启发式近似 + 验收口径 |
| sampleMode:LINEAR 无效 | important | Cesium 专家 | §3.4/§6.3 接受 NEAREST 或手动 4-tap |
| depth 源与 atmosphere 同源虚假 | important | 红队 | §3.3 改 raw globe depth |
| 半分辨率时序闪烁 | important | 红队 | §7.5 4-frame jitter 或全分辨率 |
| 地形 god rays 限于低空 | important | 图形学 | §1.3/§7.7 验收口径调整 |
| 缺 higher-order LUT | important | 图形学 | §7.7 已知对比度上限 |
| 低角度 march 失效风险 | plausible_concern | 红队 | §7.4 T7 实测 + 缓解 |
| gl_FragColor/out_FragColor | minor | Cesium 专家 | §11.2 out_FragColor |
| getStageDependencies 机制描述 | minor | Cesium 专家 | §3.2 执行序=add 序 |
| ATMOSPHERE.top_radius vs uniform | minor | Cesium 专家 | §4.2/§9.1 统一 u_atmosphereTopRadius |
| 主 march 覆盖 50→109km | minor | 图形学 | §4.2 修正 |
| Eq.17/18 行号 + 阴影位置 | minor | 图形学 | 附录 A 修正 |
