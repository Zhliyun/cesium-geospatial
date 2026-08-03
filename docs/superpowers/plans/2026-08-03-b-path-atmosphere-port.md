# B 路径大气移植计划（完全参考 cesium-clouds-atmosphere）

> 对齐源库：/Users/zhangliyun/Documents/Ayvods/Web3D/cesium-clouds-atmosphere

## 背景

T9 验收中现象 1（高空中间弧线）、现象 2（贴地山体透明/条纹）、新现象（山体与地平线重叠），
经多轮调试 + 对比 cesium-clouds-atmosphere 库（改编自 three-geospatial 的 Cesium 大气库），
根因收敛：**我的 A 路径（法线重算 lighting + exposure 15）是病灶**，Cesium 上应走 B 路径。
用户决定停止自研修复，完全参考该库重做。

## 根因总结（调试结论）

| 现象 | 根因 |
|---|---|
| 弧线 | A 路径法线重建（半球校正 dot>0 反号 + 退化回退临界翻转） |
| 透明/条纹 | half-float LUT 灾消，被 exposure=15 放大 10× |
| 山体重叠地平线 | 天空判定 `rawDepth>=1-1e-8` 过简，Cesium depth plane 假 depth 误判 |
| 日夜曝光 | 固定 exposure=15，无动态适配 |

**关键反证**：cesium-clouds-atmosphere 用**同样的 half-float LUT**（scattering.bin 8MiB）但工作正常，
证明问题不在 LUT，在集成方式（B 路径 + 小 exposure + ACES + 精细判定）。

## 架构决策

**保留（我的架构更干净，Agent 报告确认）**：
- 单 PostProcessStage（天空+地面合一；源库双 stage 是为云预留 HDR 中间态）
- GLSL const 注入 ATMOSPHERE struct（源库 flatten uniform，受 Cesium uniformMap 限制）
- 3 LUT + COMBINED_SCATTERING_TEXTURES（源库 5 LUT，single_mie/higher_order 不采样）
- `depthTestAgainstTerrain=true`（Cesium 地形 depth 硬前提；源库 demo 无地形不需）
- 对数深度（地形 z-fighting 必需）
- Simon1994 太阳方向自算（源库用 Cesium 内置 sunDirectionWC；自算更可控）

**移植（源库核心）**：
1. 复杂天空判定：`brunetonIntersectsGround` + `sceneLum>=0.06` 亮度兜底 + `muLook` + 球交（壳层/太空/内球三分支）
2. B 路径合成：`finalColor = originalColor·transmittance + inscatter`（去法线/lighting 重算）
3. ACES filmic tonemap（替换 Reinhard）
4. 动态曝光：`_getEffectiveAtmosphereExposure`（day=1.5 / night=0.1 / twilight±6°，按相机当地太阳高度角）
5. `reconstructRay`：`czm_windowToEyeCoordinates` 近远差分（替换 ndc+inverseProjection，修仰视退化）

**剥离（不移植）**：BSM/云阴影/Tyndall（sunT=1）、single_mie/higher_order LUT、dat.gui、getAtmosphereForClouds

**数值核对**：源库 `bottom_radius=6367.72km`（AtmosphereParameters L176），我用 6360km。保留 6360km（three-geospatial 默认），密切球再中心化已适配。

## Tasks

### Task 1：重写 aerialPerspective.frag.ts（核心，B 路径 + 复杂判定 + ACES）
- 基于 源库 aerialPerspectiveEffect.frag（去 BSM，sunT=1）+ 加天空分支（getSkyRadiance）
- 新增辅助函数（从源库复制）：`ACESFilmic`, `tonemapDisplay`, `reconstructRay`, `rayForwardHitsSphere`, `cameraInAtmosphereShell`
- 新 main：reconstructRay → 重建世界坐标 → 天空判定（brunetonIntersectsGround+sceneLum+球交）→ `isSky? getSkyRadiance : originalColor·trans+inscatter` → `*exposure` → ACES+gamma
- 删：`getSunSkyIrradiance`/`correctGeometricError`/normalLine/法线相关 uniform（albedoScale/ellipsoidRadii/geometricErrorCorrectionAmount）
- options 简化：去 `sunLight`/`skyLight`/`correctGeometricError`/`ground`，保留 `transmittance`/`inscatter`/`sun`/`sky`

### Task 2：重写 AtmosphereStage.ts（动态曝光 + B uniform）
- 加 `_getEffectiveAtmosphereExposure`（按相机 cartographic up · sunDirectionWC 算太阳高度角，day/night/twilight 插值）
- uniform 调整：去 albedoScale/ellipsoidRadii/geometricErrorCorrectionAmount；加 sunPixelAngle=fov/canvasHeight
- exposure 改动态（preRender 更新）
- 保留 Simon1994 太阳方向、altitudeCorrection、depthTestAgainstTerrain

### Task 3：清理 A 路径残留
- 删 `normalReconstruction.ts`（+ test）
- 删 `runtime.glsl` 的 nearFade（恢复源库原貌）
- `colorSpace.ts`：加 ACES（或内联 frag，删 colorSpace 的 linearToSRGB）
- 删 `geometricErrorCorrection.ts`（+ test，AtmosphereStage 引用）

### Task 4：main.ts（B 默认）
- 去 `ab=A/B` 开关，B 路径为默认（直接 createAtmosphereStage）
- 去 `correctGeometricError`/`transmittance`/`inscatter`/`exposure`/`atmo` URL 诊断开关（动态曝光接管）
- 保留 camera/time/tileCache/debug URL 参数 + moveEnd hash

### Task 5：测试 + 验证
- 更新 aerialPerspective.frag.test.ts / AtmosphereStage.test.ts 断言（B 路径合成、ACES、动态曝光）
- 跑 core 全测试
- 用户验证现象 1（弧线）/2（透明）/重叠 + 日夜曝光

## 风险
- ACES 改色调（用户可能需调 exposure day/night 默认值）
- 复杂天空判定有多个魔法常数（SHELL_SKY_DEPTH_SLOP=0.014 等），源库调过，直接搬
- 单 stage 合并天空+地面 tonemap：源库双 stage（天空 HDR → 地面 ACES），我单 stage 末端 ACES，逻辑等价（天空也走 ACES）
