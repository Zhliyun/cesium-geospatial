# phase2c 体积丁达尔效应（Volumetric God Rays）设计

> 状态：brainstorming 产出（2026-08-13），待用户审 → writing-plans
> 方向：体积 march shadow_length（Bruneton Eq.17/18），物理路线
> 关联：
> - 废弃前置方案：`2026-08-12-tyndall-godrays-design.md`（屏幕空间 radial blur，HDR accumNorm 爆炸失败，已回退）
> - phase2a HDR 管线、phase2b LensFlare（`2026-08-04-phase2b-lens-flare-design.md`）
> - 参考库：three-geospatial `EpipolarShadowLengthNode`（WebGPU，地形 god rays，依赖 CSM——本项目无法直接移植，见 §2.3）

## 1. 背景与目标

### 1.1 前置方案失败教训

屏幕空间 radial blur 方案（Mitchell 风格，沿径向累加 atmosphere 亮区）在本项目 HDR + ACES 物理管线下**根本性失败**：accumNorm ∝ atmosphere HDR（太阳方向 half-float 溢出 Inf/NaN），16 轮 accumNorm 归一化 / 相对化 / clamp / mask / darkMask 全失控。结论：**屏幕空间 god rays 与 HDR 物理管线根本冲突**（accumNorm 量级失控），代码已回退到 plan commit（79f8a43）。

### 1.2 体积 march 物理路线

正确方向（three-geospatial 唯一采用路线）：沿视线 march，累加被前景地物遮挡的长度 `shadow_length`（米单位物理标量），喂给 Bruneton `GetSkyRadiance` / `GetSkyRadianceToPoint`（shadow_length 参数），阴影段散射被减去 → crepuscular rays。

**HDR 安全的根本原因**：`shadow_length` 是物理标量（米），不放大 sun radiance，half-float 不溢出——正是屏幕空间方案 accumNorm 爆炸的解药。

### 1.3 目标

在现有后处理链中加入**物理正确**的体积 god rays：阳光被前景山脊遮挡，山脊后方大气段在阴影里（散射减少），与未遮挡段的强前向 Mie 散射形成明暗对比 → 晨昏低角度可见的 crepuscular 光束，被山脊切割为其典型形态。

**主用例**：晨昏低太阳角，视线朝向太阳附近，山脊在视线与太阳之间。这是 god rays 物理上最强的几何配置，也是本设计 march 几何精确的用例（见 §4.3）。

### 1.4 非目标

- **体积云参与的光束（耶稣光）**——本项目无体积云。
- **epipolar 极线采样优化**——three-geospatial WebGPU 路线，移植到 GLSL 复杂，初版用全屏半分辨率 brute-force march，性能不足再优化（见 §8.4）。
- **地面 god rays**（山影投到地形表面的大气）——初版 shadow_length 只接天空分支（见 §6.1），YAGNI 留后期。
- **shadow map 路线**——Cesium globe 地形不投射 shadow map（见 §7.1），不可行。

## 2. 方案选择

### 2.1 shadow_length 消费方式：方式 1（标量单查询）

three-geospatial 两条路径（clouds `marchShadowLength` + atmosphere `EpipolarShadowLengthNode`）都用**方式 1**：march 输出标量 `shadow_length` → 单次 `GetSkyRadiance(shadow_length)` / `GetSkyRadianceToPoint(shadow_length)`。

另一理论选择**方式 2**（march 内做完整分段体积积分，每段独立散射累加）不采用：

- **HDR 安全**：shadow_length 是物理标量（米），不放大 sun radiance，half-float 不溢出。
- **复用 B 路径**：atmosphere stage 只需把 `GetSkyRadianceToPointScaled` / `getSkyRadiance` 第 3 参从 `0.0` 改为 march 得到的值，drop-in。
- **物理正确**：Bruneton `shadow_length` 本身就是 Eq.17/18 的解析实现（runtime.glsl L213 `d=max(d-shadow_length,0)` + shadow_transmittance 调制），不是近似。方式 2 反而要把 LUT 解析积分拆成数值分段，违反预计算优势且更贵。

### 2.2 shadow 源：B（太阳方向 screen-space ray march）

体积 god rays 的核心是判断"视线上每段大气是否被地形遮挡了**阳光**"（沿太阳方向的遮挡）。三方案：

| | A：视线 depth march | **B：太阳光线 march（选定）** | C：混合 |
|---|---|---|---|
| 测的遮挡 | camera 视线方向 | **太阳方向**（物理正确） | 视线+太阳 blend |
| 几何正确性 | 仅视线朝太阳时近似正确 | **任意视线方向物理正确** | 最鲁棒 |
| 成本 | 单 march N 步 | 主 march N × 太阳 march M | 最贵 |
| 屏幕外失效 | 视线出屏幕 | 采样点沿太阳方向出屏幕 | 两者 |

**用户决策（2026-08-13）**：选 **B**（物理正确路线，符合项目物理保真优先风格）。任意视线方向都正确，代价是 N×M 成本与 screen-space 固有限制（§7.2）。

### 2.3 为什么不直接移植 three-geospatial

three-geospatial 纯地形 god rays 是 `EpipolarShadowLengthNode`（packages/atmosphere/src/webgpu），**WebGPU/TSL** 且**依赖 CSM 阴影贴图**（`shadowDepthNodes = lights.map(light => texture(light.shadow.map.depthTexture))`）。两个不可移植点：

1. **Cesium globe 地形不写 shadow map**（Cesium 已知限制：ShadowMap 只对 primitive/entity，不对 Globe/terrain）→ CSM 路线在纯地形场景无数据源。
2. **WebGPU/TSL** vs 本项目 Cesium PostProcessStage（GLSL ES 3.00）→ 需重写。

clouds 包 `marchShadowLength` 是 WebGL/GLSL，但遮挡源是 Beer Shadow Map（云密度），不适用纯地形。

**本项目路线**：保留 three-geospatial 的核心物理语义（march → shadow_length → Bruneton），但 shadow 源用 **screen-space sun ray march** 替代 CSM（§4.3），用全屏半分辨率 brute-force 替代 epipolar（初版）。

## 3. 架构

### 3.1 链位置

march pass 必须在 atmosphere 前（atmosphere 消费其输出）。与 lensflare 的 `lf_occlusion` 降采样 pass 同模式：

```
depthTemporal → gr_shadowLength(体积march, 半分辨率) → atmosphere(读shadowLength) → lensflare → tonomap
```

- `gr_shadowLength` stage：半分辨率 march pass，输出每像素 shadow_length（米，HalfFloat R 通道）。
- `atmosphere` stage：天空分支 `getSkyRadiance` 读 `u_shadowLengthTexture`（uniform-name 引用 `'gr_shadowLength'`），传第 3 参 shadow_length。
- `gr_shadowLength` 必须在 `atmosphere` 前 add（atmosphere 的 colorTexture 链不依赖它，但 uniform-name 依赖图要求被引用 stage 先注册——同 lensflare `lf_occlusion` 在 atmosphere 前模式）。

### 3.2 uniform-name 跨 stage 引用（复用 lensflare 验证模式）

atmosphere shader 声明 `uniform sampler2D u_shadowLengthTexture;`，AtmosphereStage uniforms 传 **string 字面量** `'gr_shadowLength'`（非 function 返回 texture 对象）。这是 lensflare I9/I10 评审强制约束的同款：只有 uniform-name string 引用才让 Cesium `PostProcessStageTextureCache.getStageDependencies` 把 `gr_shadowLength` 排在 `atmosphere` 前；function 返回 texture 对象不建依赖 → atmosphere 渲染时读到未就绪/上一帧 RT。

生产先例：本仓库 lensflare `occlusion.depthTexture='czm_depth_temporal'`（composite 内→顶层）、`composite.u_bloomTexture='lf_up4'`（composite 内→composite 内）均验证可行。本设计 `atmosphere.u_shadowLengthTexture='gr_shadowLength'`（顶层→顶层）等价。

### 3.3 depth 源（复用 lensflare / depthTemporal 模式）

march pass 的 `depthTexture` 源：
- `temporalEmaEnabled=true`（HDR 设备）：`'czm_depth_temporal'`（smoothDepth，EMA 消抖后地形 depth，与 atmosphere 同源）。
- 否则（UNSIGNED_BYTE 兜底）：Cesium 内建 scene globe depth，shader 用 `czm_readDepth`。

同 lensflare occlusion.frag 的 depth 源选择逻辑（`depthTexture` uniform 按 `temporalEmaEnabled` 传 `'czm_depth_temporal'` 或 undefined）。

### 3.4 像素类型与采样

- `gr_shadowLength`：`pixelDatatype: postHdrDatatype`（HalfFloat，线性域），`pixelFormat: RGBA`（PostProcessStage 要求 RGBA，shadow_length 存 `.r`，`.gba` 填 0）。
- `gr_shadowLength` `textureScale: 0.5`（半分辨率，1/4 像素）。
- **atmosphere 读 shadow_length 用 LINEAR 上采样**：shadow_length 是平滑物理标量（米），半分辨率→全分辨率 LINEAR 插值无方块；NEAREST 会出明显方块边界。这与 lensflare composite.frag NEAREST 保 dither 的约束**不同**——shadow_length 无 dither 需求，LINEAR 正确。

> **注意**：atmosphere stage 当前 `sampleMode` 未显式设置（默认 LINEAR 读 colorTexture）。`u_shadowLengthTexture` 是独立 sampler，其采样模式由声明决定——GLSL `texture()` 默认按 sampler 的 texture object 采样模式。PostProcessStage uniform-name 引用的 texture 继承源 stage 的 sampleMode。`gr_shadowLength` 需显式设 `sampleMode: LINEAR`（若 Cesium 默认非 LINEAR）。T1 spike 确认。

## 4. Shader 算法

### 4.1 early-exit（preRender CPU + shader 内 uniform 判定）

march pass **始终执行**（`inputPreviousStageTexture=false`，独立 RT——**不能用 `enabled=false`**：disabled stage 的 outputTexture 内容未定义，会污染 atmosphere 的 `u_shadowLengthTexture` 读取，这是与 lensflare composite（透传）的关键差异）。

`preRender` CPU 判 `sunDirection`，设 `u_godRaysSunVisible` uniform（int，0/1）：
- 太阳在地平下（`dot(sunDirectionWC, cameraUp) < -twilightAngle`，复用 `getEffectiveAtmosphereExposure` 太阳高度角判定）→ `0`。
- 太阳在视野外（`sunBehindCamera || !sunOnScreen`，复用 lensflare occlusion.frag 太阳屏幕位置判定）→ `0`。

shader `main` 开头：`if (u_godRaysSunVisible == 0) { out_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }`（全屏输出 0，atmosphere 读 0 → 零回归）。太阳可见时正常 march。太阳不可见时仍跑 pixel shader 但 early-return（无 march 循环），接近省 pass 性能。`?godRays=0` 运行时同理（preRender 强制 `u_godRaysSunVisible=0`）。

### 4.2 主 march（视线方向，N=16 步）

每像素（半分辨率）：

```glsl
// 1. 重建视线方向（复用 aerialPerspective.frag:109-116 reconstructRay 同逻辑：
//    czm_windowToEyeCoordinates(vec4(gl_FragCoord.xy, near/far, 1.0)) 近/远差分 → world rayDir）
vec3 rayDir;
reconstructRay(czm_viewerPositionWC, rayDir);  // world-space 单位视线方向

// 2. 主 march 终点 = camera 到大气顶层交点距离（runtime.glsl:170-172 distance_to_top_atmosphere_boundary
//    算法 -rmu - sqrt(rmu²-r²+topR²)；统一按天空，地面像素值被 atmosphere 忽略）
vec3 cameraWC = czm_viewerPositionWC;   // 单位与 aerialPerspective 接齐（altitudeCorrection + METER_TO_LENGTH_UNIT，T1）
float topR = ATMOSPHERE.top_radius;
float rmu = dot(cameraWC, rayDir);
float pointDist = max(-rmu - sqrt(rmu*rmu - dot(cameraWC,cameraWC) + topR*topR), 0.0);

// 3. 透视增长步长 march（近密远疏，覆盖 camera→pointDist）
float shadowLength = 0.0;
float t = u_godRaysMainStep0 * jitterHash();  // jitter 起始消 banding
float step = u_godRaysMainStep0;
for (int i = 0; i < GOD_RAYS_MAIN_STEPS; ++i) {  // N=16
  if (t > pointDist) break;
  vec3 P = cameraWC + rayDir * t;
  // —— 太阳光线 march：判 P 是否被地形挡住阳光 ——
  bool lit = sunRayMarchLit(P);  // §4.3
  if (!lit) shadowLength += step;
  step *= u_godRaysMainStepGrowth;  // 透视增长（如 1.3）
  t += step;
}
shadowLength *= u_godRaysIntensity;  // 工程强度缩放（1.0=物理）
gl_FragColor = vec4(shadowLength, 0.0, 0.0, 1.0);  // R=shadow_length（km），HalfFloat
```

**步长策略**：几何级数增长（`step *= growth`），近处密（山脊附近精度），远处疏（大气高层 god rays 弱）。`step0` / `growth` 待 T1 标定（初版 step0=0.5km, growth=1.3，覆盖 0.5→~50km）。

### 4.3 太阳光线 march（sunDirection，M=8 步，screen-space depth）

从视线采样点 P 沿 `sunDirection`（世界方向）步进，每步 Q 投影到屏幕查 depthTexture，eye-space 线性深度比较判遮挡：

```glsl
bool sunRayMarchLit(vec3 P) {
  for (int j = 0; j < GOD_RAYS_SUN_STEPS; ++j) {  // M=8
    float s = u_godRaysSunStep0 * pow(u_godRaysSunStepGrowth, float(j));
    vec3 Q = P + sunDirectionWC * s;
    // Q → screen
    vec4 QClip = czm_viewProjection * vec4(Q, 1.0);
    if (QClip.w <= 0.0) break;                      // Q 在 camera 后方 → fallback（保持当前 lit）
    vec3 QNdc = QClip.xyz / QClip.w;
    if (any(lessThan(QNdc.xy, vec2(-1.0))) ||
        any(greaterThan(QNdc.xy, vec2(1.0)))) break; // Q 出屏幕 → fallback
    vec2 QUv = QNdc.xy * 0.5 + 0.5;
    // eye-space 线性深度比较（log depth 经 czm_windowToEyeCoordinates 反演，签名 vec4(windowXY, depth, 1.0)）
    vec2 QWindow = QUv * czm_viewport.zw;  // [0,1] uv → window 像素坐标（czm_viewport.zw=画布尺寸，T1 确认）
    float sceneEyeZ = czm_windowToEyeCoordinates(vec4(QWindow, texture(depthTexture, QUv).x, 1.0)).z;
    float QEyeZ = (czm_view * vec4(Q, 1.0)).z;
    if (QEyeZ < sceneEyeZ - u_godRaysDepthBias) {   // Q 比 scene 远（更负）→ 被地形遮挡
      return false;  // P 被挡住阳光 → shadow
    }
  }
  return true;  // 未找到遮挡 → lit
}
```

**几何正确性**（B 路线核心）：Q 是 P 到太阳路径上的点，若 Q 被相机视野内地形挡（Q 在某地形像素后方），近似认为 P→太阳路径被地形遮挡 → P 在阴影里。这是 screen-space 对"阳光遮挡"的近似（同 SSLV/screen-space shadow 原理）。

**screen-space 固有限制**（§7.2）：只能看到当前 camera 视野内、Q 投影在屏幕内的地形遮挡。Q 出屏幕 / camera 后方时 `break`（fallback 保持当前 lit 状态——若未找到遮挡则判 lit，保守，不产假阴影）。

**步长**：指数增长覆盖 P 到 P+sunMarchRange（初版 sunStep0=0.5km, growth=1.5, M=8 → 覆盖 ~0.5→~25km，含典型山脊距离）。`u_godRaysDepthBias` 防 self-occlusion acne（初版 0.01km）。

### 4.4 太阳方向复用

`sunDirectionWC` 由 AtmosphereStage `preRender` 每帧更新（Simon1994 + ICRF→Fixed，已有 `state.sunDirection`）。march pass uniforms 闭包读同一 `state.sunDirection`，与 atmosphere 同源——保证 march 的太阳方向与 inscatter 计算一致。

## 5. atmosphere stage 接入

### 5.1 天空分支 getSkyRadiance 传 shadow_length

当前 `aerialPerspective.frag.ts:313`：
```glsl
inscatter = getSkyRadiance(cameraPosition, rayDirection, 0.0, sunDirection, fragmentAngle, transmittance);
```
改为：
```glsl
float shadowLength = texture(u_shadowLengthTexture, v_textureCoordinates).r;  // LINEAR 上采样
inscatter = getSkyRadiance(cameraPosition, rayDirection, shadowLength, sunDirection, fragmentAngle, transmittance);
```

`getSkyRadiance`（aerialPerspective.frag.ts:288-305）→ `GetSkyRadiance`（runtime.glsl:133-216）已有 shadow_length 处理（Eq.18，L179-213）：
- shadow_length>0 时在 x_s = x + l·v 处查散射，shadow_transmittance = GetTransmittance(r, mu, shadow_length) 调制 single scattering（L199-212）。
- 本项目无 `HAS_HIGHER_ORDER_SCATTERING_TEXTURE`，走 L209-211 `#else` 简单变体 `scattering = scattering * shadow_transmittance`（只调制 single scattering，可用）。

### 5.2 地面分支保持 shadow_length=0（零回归）

`GetSkyRadianceToPointScaled` 两处调用（base L455、fore L475）**保持第 3 参 `0.0`**，不改。理由见 §6.1。

### 5.3 atmosphere uniforms 新增

`buildAtmosphereUniforms` 新增：
```ts
u_shadowLengthTexture: godRaysEnabled ? 'gr_shadowLength' : undefined,
```
`godRaysEnabled=false` 时不传（atmosphere shader 走无 god rays 分支，shadow_length=0）。

shader 侧 `u_shadowLengthTexture` 声明按 `godRays` option 条件生成（同 lensflare `useOcclusionTexture` 模式）：godRays=true 时声明 sampler + 读 shadow_length；false 时不声明、getSkyRadiance 传 0.0（原行为）。

## 6. 与 B 路径 DUAL inscatter 融合

### 6.1 接入范围：初版只接天空分支

shadow_length 只接入天空分支 `getSkyRadiance`（L313）。地面 base（L455）/ fore（L475）保持 `0.0`。

**理由**：
1. **god rays 本质是天空大气现象**——晨昏光束在天空，主用例视线穿过山脊看天空，全在天空分支。
2. **DUAL inscatter 标定零回归**——base/fore 物理量级不变（shadow_length=0 走原分支），保护 phase1 / Bug1-6 标定。
3. **地形是 god rays 的遮挡物**，不是光束载体；投到地形表面的效果弱且需额外标定，YAGNI 留后期。

后期扩展（接 base）容易：L455 第 3 参 `0.0` → `shadowLength`，加一行 + 标定测试。

### 6.2 零回归安全网

god rays 关闭（任一条件）时 shadow_length=0，`getSkyRadiance` 走 runtime.glsl L179 `shadow_length == 0.0 * m` 原分支 → 与 phase1 bit 等价：
- `u_godRaysEnabled=false`：march pass 不创建，atmosphere `u_shadowLengthTexture` 不传，shader 走 godRays=false 分支（getSkyRadiance 传 0.0）。
- `?godRays=0` 运行时 / 太阳在地平下 / 太阳视野外：preRender 强制 `u_godRaysSunVisible=0` → march shader early-return 全屏输出 0 → atmosphere 读 0（§4.1）。不用 `enabled=false`（独立 RT 会污染下游 `u_shadowLengthTexture`）。

**测试**：零回归用例（god rays 关闭）断言 atmosphere shader 产出与 phase1 bit 等价（getSkyRadiance 第 3 参为 0.0 字面量或读得 0）。

### 6.3 上采样

march pass 半分辨率 → atmosphere 全分辨率读 `u_shadowLengthTexture`，`texture()` LINEAR 插值。shadow_length 是平滑物理标量（米），半分辨率 LINEAR 上采样无方块伪影（对比 NEAREST 的明显方块）。god rays 本身是低频光束，半分辨率足够。

## 7. 关键约束与陷阱

### 7.1 Cesium globe 不投射 shadow map（根本约束）

Cesium `ShadowMap` 只对 primitive / entity / 3D Tiles 投射，**不对 Globe / terrain**。所以"地形遮挡阳光"无法用 shadow map 判断，只能 screen-space depth 近似（§4.3）。这是本项目与 three-geospatial（用 CSM）的根本差异，也是选 B 路线 screen-space 的根因。

### 7.2 screen-space 视野外遮挡丢失（B 路线固有限制）

screen-space sun ray march（§4.3）只能看到当前 camera 视野内、Q 投影在屏幕内的地形遮挡。视野外但可能挡阳光的山（Q 出屏幕）看不到。对 god rays 通常可接受（用户看到的山脊恰好在视野内），但极端视角（遮挡山在视野外）光束会缺失。**与 lensflare occlusion 的 screen-space 限制同类**，接受。

### 7.3 HDR 安全（相对屏幕空间方案的根本优势）

shadow_length 是物理标量（米），经 `u_godRaysIntensity` 缩放后仍是有界正标量（典型 0–50km）。`getSkyRadiance` 用它做 shadow_transmittance 调制（L199-212），输出仍是亮度量级 inscatter，不放大 sun radiance。half-float 不溢出——根本区别于屏幕空间方案的 accumNorm ∝ HDR 太阳方向值。

### 7.4 太阳 march 的 camera 后方 / 出屏幕 fallback

P 沿 sunDirection 步进，Q 可能在 camera 后方（`QClip.w <= 0`）或出屏幕。此时 `break`，保持当前 lit 状态（§4.3）。低太阳角时 sunDirection 近水平，Q 出屏幕概率高——fallback 偏 lit（保守，不产假阴影）。这意味着地平线附近、太阳方向的远距离遮挡可能漏判，但近处山脊遮挡（god rays 主形态）仍准确。

### 7.5 降采样 banding（jitter）

半分辨率 + 透视增长步长会在 shadow_length RT 产生同心圆 banding（步长等值线）。主 march 起始 `t = step0 * jitterHash()`（spatial hash，每像素不同）打散步长对齐。jitter 噪声在 HalfFloat RT 内，LINEAR 上采样 + god rays 低频特性将其抹平——不需额外 temporal 降噪（初版）。

### 7.6 depth bias 防 acne

太阳 march eye-space 深度比较（§4.3）需 `u_godRaysDepthBias`（初版 0.01km）防 self-occlusion acne（Q 刚好在地形表面时浮点误差误判遮挡）。bias 过大漏判近处遮挡，过小产 acne——T1 标定。

## 8. 性能

### 8.1 成本估算

- 主 march N=16 × 太阳 march M=8 = **128 次 depth 查询 + 投影 / 半分辨率像素**。
- 半分辨率 = 1/4 像素 → **32 次 depth 查询 / 全分辨率像素等效**。
- 每次查询含 `czm_viewProjection * vec4`（矩阵乘）+ `czm_windowToEyeCoordinates`（log depth 反演）。
- 现代 GPU（M1 / 中端独显）预估 < 2ms / 帧（1080p）。`?profile=1` 逐 stage GPU 计时实测验证。

### 8.2 early-exit

`preRender` 判太阳可见性（§4.1）：夜晚（太阳地平下）+ 太阳视野外 → `u_godRaysSunVisible=0`，march shader early-return 输出 0（无循环，接近省 pass）。典型用户会话（白天探索 + 晨昏验收 god rays），白天大半时间太阳在视野外，early-exit 收益显著。

### 8.3 profile

复用 demo `?profile=1` 逐 stage GPU 计时（PostProcessStage name 语义键）。`gr_shadowLength` 作为独立键，对比 atmosphere / lensflare / tonomap 占比。性能不达标触发 §8.4 优化。

### 8.4 后期优化（非初版）

- **epipolar 极线采样**：沿太阳-屏幕中心极线 march（非每像素），`UnwarpEpipolarNode` 重映射全屏。three-geospatial WebGPU 路线，GLSL 移植复杂。预估 5–10× 加速。
- **depth-based skip**：march pass 内判该像素是地面（depth < 天空）→ 直接输出 0（地面像素 shadow_length 被 atmosphere 忽略，省 march）。
- **min/max mip depth 层次结构**：太阳 march 自适应步长（three-geospatial EpipolarShadowLengthNode L327-432），跳过完全 lit/shadow 区域。
- **temporal 降噪**：jitter + history reproject 累积，减步数。

初版用 brute-force 半分辨率 N16×M8，profile 不达标再上 epipolar。

## 9. uniforms 与 URL 参数

### 9.1 march pass uniforms

```glsl
uniform sampler2D depthTexture;        // czm_depth_temporal 或 scene globe depth（§3.3）
uniform vec3  u_sunDirectionWC;        // state.sunDirection（与 atmosphere 同源）
uniform float u_atmosphereTopRadius;   // 大气顶层半径 km
uniform int   u_godRaysMainSteps;      // 主 march 步数（默认 16）
uniform float u_godRaysMainStep0;      // 主 march 起始步长 km（默认 0.5）
uniform float u_godRaysMainStepGrowth; // 主 march 步长增长（默认 1.3）
uniform int   u_godRaysSunSteps;       // 太阳 march 步数（默认 8）
uniform float u_godRaysSunStep0;       // 太阳 march 起始步长 km（默认 0.5）
uniform float u_godRaysSunStepGrowth;  // 太阳 march 步长增长（默认 1.5）
uniform float u_godRaysDepthBias;      // eye-space 深度 bias km（默认 0.01）
uniform float u_godRaysIntensity;      // 强度缩放（默认 1.0=物理，0=关闭）
uniform int   u_godRaysSunVisible;     // preRender CPU 算（太阳地平下/视野外时=0，shader early-return 输出 0）
uniform int   u_debugMode;             // 与 atmosphere 同源 debugMode
```

`czm_viewerPositionWC` / `czm_view` / `czm_viewProjection` / `czm_inverseView` / `czm_windowToEyeCoordinates`：Cesium 自动注入（离线 compile 需桩）。

### 9.2 AtmosphereStageOptions 新增

```ts
godRays?: boolean              // 默认 true（early-exit 保证非晨昏省成本；?godRays=0 关）
godRaysIntensity?: number      // 默认 1.0（物理）
godRaysMainSteps?: number      // 默认 16（?godRaysMainSteps= 调）
godRaysSunSteps?: number       // 默认 8（?godRaysSunSteps= 调）
```

### 9.3 demo URL 参数

- `?godRays=0/1`（默认 1）：运行时开关（preRender 强制 `u_godRaysSunVisible=0` 使 march 输出 0 + atmosphere shader 分支）。
- `?godRaysIntensity=N`：强度（1.0 物理默认）。
- `?godRaysMainSteps=N` / `?godRaysSunSteps=N`：march 步数（性能/质量 trade-off 调参）。
- `?debug=10`：shadow_length RT 可视化（false-color 米量级，排查 march 失效主手段）。

## 10. debug probe

`u_debugMode` 扩展（与 atmosphere debug=1/2/3/5/6/7/8 同源，复用 URL `?debug=`）：

- **debug=10**：march pass 直接输出 shadow_length 可视化（false-color，`shadowLength / maxRef` → RGB jet colormap，maxRef~50km）。排查：march 是否累加、太阳方向是否正确、early-exit 是否误触发。
- **debug=11**（备选）：太阳 march lit 状态可视化（该像素主 march 第一采样点的 lit/shadow，黑白）。排查太阳 ray march 遮挡判定。

march pass 与 atmosphere 共享 `u_debugMode`（同 `state`/options 源）。debug=10/11 在 march pass 内截获输出，不进 atmosphere 消费链。

## 11. 测试策略（项目惯例 TDD）

### 11.1 shader 构建器单测

- `buildGodRaysMarchFragmentShader(options)`：产出含预期 uniform 声明、`GOD_RAYS_MAIN_STEPS` / `GOD_RAYS_SUN_STEPS` 宏、`sunRayMarchLit` 函数、主 march 循环、shadow_length 输出。
- `buildAerialPerspectiveFragmentShader({godRays:true})`：天空分支 `getSkyRadiance` 第 3 参为 `shadowLength`（读 `u_shadowLengthTexture`），非 `0.0` 字面量。
- `buildAerialPerspectiveFragmentShader({godRays:false})`：天空分支 `getSkyRadiance(..., 0.0, ...)`（零回归，与 phase1 一致）。

### 11.2 GLSL compile test

`godRaysMarch.compile.test.ts`：`glslangValidator` + `#version 300 es` + `czm_*` / `czm_windowToEyeCoordinates` / `out_FragColor` / `v_textureCoordinates` 桩（同 `aerialPerspective.compile.test.ts` 模式）。`godRays=true/false` 两分支都过。

### 11.3 stage 创建单测

- `gr_shadowLength` 在 `atmosphere` 前 add（activeStages 顺序）。
- `atmosphere.u_shadowLengthTexture === 'gr_shadowLength'`（uniform-name string，非 function）。
- 半分辨率（textureScale=0.5）、HalfFloat、sampleMode LINEAR。
- `godRays=false` 时 march pass 不创建 + atmosphere `u_shadowLengthTexture` undefined。
- early-exit：`preRender` 太阳地平下 / 视野外时 `u_godRaysSunVisible=0`，shader early-return 输出 0（不用 `enabled=false`——独立 RT 会污染下游 `u_shadowLengthTexture`）。

### 11.4 零回归测试

- god rays 关闭：atmosphere shader `getSkyRadiance` 第 3 参为 `0.0`（godRays=false 分支）或读得 0（march 全 0）。
- 现有 aerialPerspective.frag.test.ts 全部用例（u_distanceScale / DUAL inscatter / limb / debug）不回归。

### 11.5 视觉验收（demo）

- 晨昏低角度、视线朝太阳、山脊在前 → 可见 crepuscular 光束，被山脊切割。
- `?debug=10` shadow_length RT 可视化：山脊后方天空有非零 shadow_length（红/暖色），山脊前方天空近 0（蓝/冷色）。
- `?godRays=0` 与 phase1 视觉一致（零回归）。
- `?profile=1` march pass 占比可接受。

## 12. 任务分解概要（writing-plans 预览）

1. **T1 march shader 构建器 + compile test**：`buildGodRaysMarchFragmentShader`，glslang 过。
2. **T2 atmosphere shader 接入**：`buildAerialPerspectiveFragmentShader({godRays})` 天空分支读 shadow_length，godRays=false 零回归。
3. **T3 stage 创建 + 链位置**：`gr_shadowLength` pass（半分辨率、uniform-name 引用、depth 源、early-exit），atmosphere uniforms 接 `u_shadowLengthTexture`。
4. **T4 AtmosphereStageOptions + demo URL**：godRays / godRaysIntensity / godRaysSteps 参数化。
5. **T5 debug probe**：debug=10 shadow_length 可视化。
6. **T6 单测全过 + tsc + glslang**。
7. **T7 视觉验收 + 参数标定**：晨昏 god rays 可见、step0/growth/bias/intensity 调参、profile。

（精确任务分解与依赖由 writing-plans 产出。）

---

## 附录 A：Bruneton shadow_length 物理语义（Eq.17/18）

**GetSkyRadianceToPoint（地面，Eq.17，runtime.glsl:317-356）**：视线 camera→point，shadow_length>0 时第二散射查询点向 camera 移 shadow_length（L322 `d=max(d-shadow_length,0)`），`shadow_transmittance = GetTransmittance(r,mu,d)`（L334），组合 `scattering = scattering - shadow_transmittance·scattering_p`（L355）——从 lit 段减去阴影段散射。

**GetSkyRadiance（天空，Eq.18，runtime.glsl:179-213）**：shadow_length>0 时在 x_s=x+l·v 处查散射（L189-198），`shadow_transmittance = GetTransmittance(r,mu,shadow_length)`（L199-201），`scattering = scattering·shadow_transmittance`（L210，#else 简单变体，调制 single scattering）。

两者语义一致：shadow_length = 视线上被遮挡（沿太阳方向）的长度，该段散射被 shadow_transmittance 调制（减去/衰减）。本项目天空分支用 GetSkyRadiance（Eq.18）。

## 附录 B：参考实现对照

| 维度 | three-geospatial EpipolarShadowLengthNode | 本项目（Cesium） |
|---|---|---|
| 遮挡源 | CSM shadow map（depthTexture.compare） | screen-space sun ray march（depthTexture 线性深度比较） |
| march 策略 | epipolar 极线 + min/max mip | 全屏半分辨率 brute-force（初版） |
| 输出 | vec2(totalShadowLength, distanceToFirstShadow) | scalar shadow_length（R 通道） |
| 消费 | SkyNode → getIndirectRadiance → Bruneton | atmosphere getSkyRadiance(shadow_length) |
| 后端 | WebGPU/TSL | GLSL ES 3.00 PostProcessStage |
| 地形支持 | CSM 含地形 | Cesium globe 不写 shadow map → screen-space 近似 |

## 附录 C：与废弃屏幕空间方案的差异（教训）

| | 废弃屏幕空间 radial blur | 本体积 march 方案 |
|---|---|---|
| 失败根因 | accumNorm ∝ HDR 太阳方向 half-float 溢出 | shadow_length 物理标量，HDR 安全 |
| 物理基础 | 后处理径向模糊（无物理） | Bruneton Eq.17/18（物理正确） |
| 遮挡 | bright-pass + depth 太阳门控 | 体积 march + 太阳光线 depth |
| 光束形态 | 圆形辉光（假） | 被山脊切割的物理光束 |
| 复用 B 路径 | 独立 composite 叠加 | drop-in shadow_length 参数 |
