# 体积云 M2 — 主 raymarch（three clouds.frag → Cesium 桥接）results

> **日期**：2026-08-14
> **基于**：spec `docs/superpowers/specs/2026-08-13-volumetric-clouds-design.md`（r1 + r2 附录 F）+ plan `docs/superpowers/plans/2026-08-14-clouds-m2-raymarch.md`
> **branch**：`phase3-clouds-m1`
> **结论**：✅ **M2 全过**——云主 march 在 Cesium 全链路实跑，视觉验收通过（云形/颜色/无 artifact），平面光照（flat lighting，无 BSM/temporal/god rays）。视觉验收循环中提前接通 3 项原 M4/M6 内容（STBN 资产 / local_weather decode / globe depth 截断）。
> **全量回归**：315 测试绿（core 258 + clouds 57）+ tsc 0（core/clouds/demo）。

## 1. 交付（T1–T5）

| Task | 内容 | commit |
|---|---|---|
| T1 | `CloudsMaterial.ts`——`buildCloudsMainFragmentShader`（surgery 桥接）+ `buildStandaloneCloudsShaderForValidation`（glslang 校验） | `b23bbc7` |
| T2 | `CloudsPass.ts`——VolumetricPrimitive + 2-attachment MRT + 全 business uniform 注入 | `b18c781` |
| T3 | `createCloudsStage.ts`——工厂 + cloudsBuffer bridge overlay + sunDirection/altitudeCorrection preRender | `ca508ef` |
| T4 | demo `?clouds=1` 接线 + 调试参数 | `5782995` |
| T5 | 本文档 + 全量回归 | （本 commit） |

### T1 surgery 桥接（spec §4.2 方案 C）

不拆 clouds.frag，文本手术（`surgeryCloudsFrag`，全部锚点 grep 验证唯一）：
1. 剥离 `viewMatrix/cameraNear/cameraFar` uniform → `#define viewMatrix czm_view` 等重定向（`cameraNear→czm_currentFrustum.x`）
2. `uniform AtmosphereParameters ATMOSPHERE` → const 构造（`ATMOSPHERE_DEFAULT_GLSL`，同 core 理由：uniformMap 不支持嵌套 struct 数组）
3. 7 个 `in` varying 块 **IN-PLACE** 替换为桥接块（`cloudsBridge_reconstructVaryings`：vUv=v_textureCoordinates / vCameraPosition=czm_viewerPositionWC / vRayDirection=czm_windowToEyeCoordinates 差分+czm_inverseView / vCameraDirection=前向；**必须 IN-PLACE 否则声明前使用**）
4. `void main()` → `cloudsMainBody()` + wrapper main
5. `uniform sampler2DArray shadowBuffer` → `sampler3D`（Cesium createUniform 不认 36289）
6. `getRayDistanceToScene` 函数体 → czm log-depth 反演版（见 §3 坑 9）
7. `densityProfile` struct uniform → const 构造

M3/M4/M5/M6 dummy 化：shadowBuffer 全 0 Texture3D（Beer=1 flat lighting）/ reprojection identity / 不 define SHADOW_LENGTH、HAZE / turbulence 1×1 中性。

## 2. 视觉验收循环（用户 demo 实测，9 坑全修）

每坑由用户视觉反馈 + console stack 或 debug 视图（`?cloudsDebug=1/2/3/4`）定位：

| # | 现象 | 根因 | 修 | commit |
|---|---|---|---|---|
| 1 | `Unrecognized uniform type: 36289` | Cesium createUniform 仅 SAMPLER_2D/3D/CUBE/UNSIGNED_INT_SAMPLER_2D | sampler2DArray→sampler3D + dummy 改 Texture3D | `c0a82fd` |
| 2 | `GL_INVALID_OPERATION missing fragment shader outputs` | MRT 3 attachment + shader 2 out（M2 无 SHADOW_LENGTH） | mrtTextures 收 2 attachment | `4d6a5cd` |
| 3 | 无地形全黑/天空白 | overlay 用 `mix` 语义，three 版是 premultiplied over（无云 a=0 黑覆盖） | `scene*(1-a)+cloud` | （T3 修） |
| 4 | 云噪声退化（棕白同心圆干涉纹） | Cesium Sampler 默认 CLAMP_TO_EDGE 把 3D 噪声钉边缘（shapePosition ±1908 循环采样）+ 恒值 jitter banding | WEATHER_SAMPLER REPEAT + CPU 随机 jitter | `c3f260f` |
| 5 | 全屏雪花纹 | 白噪声 jitter 误差能量全频段显形 | three 版真 STBN 资产（128×128×64 R8，NEAREST 必须——LINEAR 抹平蓝噪声结构） | `9cc8e9b` |
| 6 | 地平线白线（夹杂云带中，与光照无关） | dummyLocalWeather 1×1 全白=coverage 满 → 掠射连续云墙 inscatter 饱和外缘成线 | local_weather.png decode（PNG→RGBA Texture+mipmap，textureLod 显式 LOD 采样**必须 generateMipmap** 否则黑） | `5019cbb` |
| 7 | 云偏灰 | ① premultiplied 值直接 ACES（薄云压暗 ~5×）② three 版 ToneMapping exposure=10 标定漏乘 | unpremultiply `/max(a,1e-4)` + exposure（默认 10，验收校准 6，`?cloudsExposure=N`） | `6d84262`+`77478b9` |
| 8 | 云浮地形上（青藏 4858m 相机，云带 750-2200m 在地形下仍显示） | depthBuffer dummy 不截断 march | depth 接通提前（globeDepth.depthStencilTexture + czm_reverseLogDepthDist 反演） | `e3d9403` |
| 9 | `czm_reverseLogDepthDist: no matching overloaded function found` | czm_reverseLogDepthDist/Window **非 Cesium 内置**（core LOG_DEPTH_GLSL 自带；GLSL 未声明函数调用报 no matching overload） | core index 导出 LOG_DEPTH_GLSL + 云 shader 拼接注入 | `e3d9403`（amend） |

**物理确认（非 bug）**：高纬云偏棕 = 低太阳直射 transmittance 红移（正午 time 对照后消失）；1708m 云中视角"贴地" = 相机在云带内 + 云底 750m 与延庆谷底平齐（10km 俯视验证云层绝对高度正确）。

**debug 判读经验**：turbo colormap 对出界值（frontDepth/maxRayDistance >1 或 <0）多项式外推出假色（橙红黄/全白）——判 debug 图先想值域。

## 3. 提前接通的 M4/M6 项（视觉验收驱动）

| 项 | 原计划 | 提前理由 |
|---|---|---|
| STBN 真 3D 资产 | M4 temporal | 雪花纹是 jitter 噪声种类问题非 temporal 问题 |
| local_weather.png decode | M6 | 满 coverage dummy 的连续云墙是白线直接根因 |
| globe depth 截断 march | M6 | 云浮地形上是明显视觉错误（青藏） |

multi-frustum 风险（VOXELS pass 执行时刻 globeDepth 可能只含近段深度 → 远段地形不遮挡云）实测未见用户反馈异常——记录观察项，M6 全面接通时复查。

## 4. 验收 URL 集（time 固定正午可复现）

```
# 主验收（云形 + 真实 coverage + depth 遮挡）
?mode=atmosphere&clouds=1&time=2026-08-14T15:30:00Z&camera=-54.3865,77.2585,2137,20.6,-10.8
# depth 遮挡（青藏高原：云带在地形下被截断）
?mode=atmosphere&clouds=1&time=2026-08-14T07:00:00Z&camera=85.9391,28.7189,4858,253.4,-3.3
# 赤道正午对照（太阳高度 ~76°，云白亮）
?mode=atmosphere&clouds=1&time=2026-08-14T12:00:00Z&camera=20,0,3000,0,-15
# 调试：cloudsDebug=1/2/3/4（uv/frontDepth/sampleCount/shadowMap）
# 变体：cloudsShapeDetail=0 / cloudsTurbulence=0 / cloudsAccurate=0 / cloudsExposure=N
```

## 5. 已知项（M3+ 处理）

- **远景 jitter 噪声**（俯视 468km 仍可见细颗粒）：three 版 march jitter（起点偏移 ×2 + detail 随机跳过）设计依赖 temporal 收敛，单帧必有——M4 temporal 根治
- **overlay 在 tonemap 后**（ACES 非线性下 premultiplied 近似）：M3+ 若需精确线性合成，改 createAtmosphereStage 支持 stage 插入 hook（spec §4.3 记录）
- **multi-frustum 远遮挡时序**：见 §3，M6 复查
- **相机 resize**：MRT 纹理固定初始尺寸（接口留了 bridge 动态 getter），M6 集成时处理

## 6. M3 前置状态

- BSM（M3）：shadowBuffer uniform/sampler3D 桥接就绪，换真实 cascade 纹理 + shadowMatrices
- L2 卷云层（7500-8000m，densityScale 0.003）在 local_weather RGBA 通道内，随真纹理激活
- 云 god rays（M5）：SHADOW_LENGTH hook 预留（define 后加 loc 2 out + shadowLenTex 第 3 attachment）
