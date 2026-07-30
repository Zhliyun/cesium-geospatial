# Phase 1 设计：大气透视 MVP（全量复刻 aerialPerspectiveEffect）

> **日期**：2026-07-30
> **前置**：Phase 0 go/no-go = GO（见 `2026-07-29-phase0-results.md`）
> **目标**：把 Phase 0"只有天空"推进到"大气参与整个场景渲染"——全量复刻源仓库 `aerialPerspectiveEffect`，含大气光照（sun/sky irradiance）+ 透射/内散射 + 法线重建，天空与大气透视合并为单一 PostProcessStage。
> **参考**：`/Users/zhangliyun/Documents/Ayvods/Web3D/three-geospatial`（`packages/atmosphere/src/shaders/aerialPerspectiveEffect.frag`、`AerialPerspectiveEffect.ts`）

---

## 1. 背景与已验证前提

Phase 0 已钉死四大件，Phase 1 直接复用：

| 已验证能力 | 证据 | Phase 1 复用处 |
|---|---|---|
| bruneton GLSL 注入（Texture3D/struct const/宏替换） | G1 通过 | aerial stage 的 `#include "bruneton/runtime"` |
| 深度→世界坐标 ECEF（czm 反投影，多视锥无条带） | G2 通过 | aerial 的地表点重建 |
| 密切球再中心化（无抖动） | G3 通过 | aerial 的大气局部坐标 |
| 相对亮度 uniform + 曝光/Reinhard | G3 调试记录 | aerial 颜色管线 |

**新增核心**：源仓库 `aerialPerspectiveEffect.frag` 的三块——`getSunSkyIrradiance`（大气光照）、`applyTransmittanceInscatter`（透射+内散射）、`RECONSTRUCT_NORMAL`（深度重建法线）。

## 2. 总体架构与渲染管线

单一 Cesium `PostProcessStage` 承载整个大气渲染（天空 + 地表大气透视合并）。

```
[Cesium 渲染 globe/地形/ion 影像] → colorTexture + depthTexture
        ↓
[AtmosphereStage (合并的 PostProcessStage)]
  天空分支：未命中地表（depth 为远平面）→ GetSkyRadiance（G3 已验证路径）
  地表分支：
    1. 深度 → 世界坐标 ECEF（复用 G2）
    2. 世界坐标屏幕求导 cross(dFdx,dFdy) → 法线（RECONSTRUCT_NORMAL，无需 MRT）
    3. 密切球再中心化 → 大气局部坐标（复用 G3）
    4. GetSunAndSkyIrradiance（太阳+天空照明，用法线）
    5. GetSkyRadianceToPoint（透射衰减 + 路径内散射）
    6. 合成：radiance = radiance*transmittance + inscatter
        ↓
[色调映射（曝光 + Reinhard）] → 屏幕
```

**关键架构判断**：全部输入只来自 `colorTexture` + `depthTexture` + 已有 czm uniforms，**不需要 Cesium 渲染任何额外 G-buffer**。法线走 `RECONSTRUCT_NORMAL`（源仓库预留的深度求导路径），绕开"Cesium 无法线缓冲"障碍。

## 3. 核心矛盾解法：避免二次光照（A 主 B 兜底）

**矛盾**：源仓库把 `inputColor` 当反照率 albedo（three.js 场景不发光），用大气重算照明；Cesium 的 globe/3D Tiles 内建光照默认已照亮 `colorTexture`，直接套会"二次光照"。

**决策（用户拍板）**：**A 为主、保留 B 为对照开关**。

- **A 路径（主）**：`scene.globe.enableLighting = false` + 影像/地形不算光照，使 `colorTexture ≈ albedo`；大气 stage 用 `SUN_LIGHT`+`SKY_LIGHT` 统一打光。对齐源仓库语义，日出日落地表随大气变暖。
- **B 路径（兜底/对照）**：不定义 `SUN_LIGHT`/`SKY_LIGHT`，只套 `radiance*transmittance + inscatter`；地表保留 Cesium 光照，大气只加"雾"。用于关不掉光照的 3D Tiles 场景，及 A/B 对比。
- 两条路径由编译期宏 + 运行时 uniform 切换，对齐源仓库 `sunLight`/`skyLight` 可开关设计。

## 4. 组件拆分与文件结构

### `packages/cesium-core/src/`（可测）

- **`cesium/aerialPerspective.frag.ts`** — 移植 `aerialPerspectiveEffect.frag` 主体。复用 `buildAtmospherePrefix()` + bruneton runtime。含天空分支（复用 G3）与地表分支（`getSunSkyIrradiance`/`applyTransmittanceInscatter`/`RECONSTRUCT_NORMAL`）。编译期宏由参数控制：`SUN_LIGHT`/`SKY_LIGHT`/`TRANSMITTANCE`/`INSCATTER`/`GROUND_ALBEDO`。
- **`cesium/normalReconstruction.ts`** — `RECONSTRUCT_NORMAL_GLSL`：深度重建的 viewPosition 屏幕求导 `normalize(cross(dFdx(vp), dFdy(vp)))` 出视图系法线，转 ECEF。配 CPU 单测（已知几何法线 vs 重建法线误差）。
- **`cesium/AtmosphereStage.ts`** — `createAtmosphereStage(scene, luts, options)`：合并 stage 组装。uniforms 复用 SkyStage（sunDirection/altitudeCorrection/4×LUT/SUN·SKY_SPECTRAL），新增 `albedoScale`/`bottomRadius`/`correctGeometricErrorAmount`/`higher_order_scattering_texture`。`options`：`{ sunLight, skyLight, transmittance, inscatter, groundAlbedo }` 控制 A/B 与分支。

### `apps/demo/src/`（接线 + 验证）

- **`main.ts`** — 新增 `?mode=atmosphere`。接入 ion 影像 + 全球地形（token 走环境变量/URL，不入库），A 路径设 `globe.enableLighting=false`。保留 `?mode=sky|depth` 旧路径作回归对照。
- **`public/luts/higher_order_scattering.bin`** — 从源仓库 assets 拷贝（Phase 0 未拷），复用 `createLUT3D`/`parseHalfFloatBin`。

### 旧代码处置

`SkyStage`/`skyStage.frag`（Phase 0 天空）的逻辑并入 `AtmosphereStage` 的天空分支；`SkyStage` 保留作 `?mode=sky` 回归对照，不删。

## 5. 测试策略

### 单测（node，vitest，沿用 Phase 0 设施）

- `normalReconstruction.test.ts` — 已知平面/球面几何法线 vs 重建法线，误差在阈值内。
- `aerialPerspective.frag` 组装测试 — 各宏组合（A/B × 各分支开关）生成的 shader 经 `resolveIncludes` 均能成功展开、含关键函数签名（`GetSunAndSkyIrradiance`/`GetSkyRadianceToPoint`）。

### 浏览器验收（项目方跑）

- `?mode=atmosphere`：远山按距离雾化（远偏蓝灰）、向阳/背阳地表亮度随太阳方向一致变化、日落时地表随大气变暖。
- A/B 切换对比。
- 移动/缩放相机：大气透视平滑、无抖动、地形边缘法线噪声可接受。
- 回归：`?mode=sky`/`?mode=depth` 不劣化。

## 6. 风险与应对

| # | 风险 | 等级 | 应对 |
|---|---|---|---|
| R-P1-1 | 法线重建精度：屏幕求导在远处/地形边缘有噪声 | 中 | 复刻源仓库 `correctGeometricErrorAmount` 球面法线 mix 压制；浏览器验收重点看地形边缘 |
| R-P1-2 | 关光照后画面偏平，albedoScale 需调 | 低 | albedoScale 暴露 URL 参数实时调，参照源仓库默认 1.0 |
| R-P1-3 | B 路径大气照明与 Cesium 光照并存，日落不一致 | 已知 | B 定位为对照/兼容模式，文档标注取舍 |
| R-P1-4 | ion token 与资产加载依赖网络 | 低 | token 走环境变量/URL 不入库；加载失败 fallback 裸 globe |
| R-P1-5 | higher_order_scattering 3D LUT | 低 | 拷源仓库 assets，复用已验证的 Texture3D 加载 |
| R-P1-6 | 天空与大气透视 stage 边界 | 已决 | **合并为单一 stage**（用户拍板），天空分支复用 G3 代码，避免 depth 边界接缝 |

## 7. 成功标准

1. `?mode=atmosphere` 下 ion 影像+地形场景呈现正确大气透视：远山雾化、光照随太阳一致、晨昏地表色温随大气变化。
2. 天空与地表在同一 stage 内无缝衔接，地平线与太空视角均正确。
3. 单测全过、浏览器验收通过、A/B 可切换。
4. 不破坏 Phase 0 已有 `sky`/`depth` 模式。

## 8. 非目标（YAGNI，本 Phase 不做）

- CSM 阴影（`HAS_SHADOW` 分支）、lightingMask、overlayBuffer——源仓库有但依赖额外缓冲，留待后续。
- 体积云（clouds）——Phase 3。
- 星空/月亮 billboard——可后续加，非大气透视必需。
- WebGPU 路径——本移植只针对 WebGL2/Cesium。
