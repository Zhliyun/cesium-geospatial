# 体积云 overlay 线性域化与后处理链重排设计（halo 被云覆盖修复）

- **日期**：2026-08-29
- **状态**：v1（方向已由用户拍板：方案 A 云进线性域）
- **问题来源**：用户报告「相机直面太阳所产生的圆环状光晕与体积云的层级关系不对，光晕被后面的云覆盖了」

## 1. 问题与根因（systematic-debugging Phase 1 结论）

### 1.1 现象

相机直面太阳时，lensFlare 的 halo 圆环在有云的弧段被切断/覆盖（repro-2 截图：环 12 点方向天空处清晰，4~8 点弧段落入云区完全消失）。光晕应叠加在云之上（镜头效果不被场景物体覆盖），实际云盖光晕。

### 1.2 根因（三重证据定案）

后处理链按 add 顺序执行，当前：

```
depthTemporal → atmosphere → lensFlare(画 halo) → tonemap → clouds overlay(链尾)
```

- demo 先建 atmosphere（`apps/demo/src/main.ts:281`，lensFlare 默认全开 `:242`），后建云（`:382`，weather 纹理异步加载完才能建）；
- 云 overlay 被 append 到集合**末尾**（`packages/cesium-clouds/src/createCloudsStage.ts:483`），排在 tonemap 之后；
- overlay 合成式 `final = scene.rgb·(1-cloud.a) + cloud.a·cloudDisplay`（`OVERLAY_SHADER:244`）——凡有云的像素，lensFlare 已画好的 halo 被按云不透明度混掉。

**为什么当初这么排**：M2 云 overlay 选择了「云单独 ACES 到 display 域再叠」（exposure=6 标定），必须排在 tonemap 之后——display 域双 ACES 架构债。lensFlare（phase2b，先于云落地）的层级就此被压在云下。

**参考库对照**：three-geospatial 云是场景内 mesh（线性域渲染），LensFlareEffect 是 composer 尾效果——flare 天然叠加在云之上。本项目把云做成链尾 display 域 overlay 才颠倒了关系。

### 1.3 干扰假设排除

Cesium 内建 sun 已关（`main.ts:121` `scene.sun.show = false`）、skyBox 关、bloom 未启用——圆环光晕来源唯一锁定为本项目 lensFlare composite（halo 通道）。

## 2. 决策记录

| # | 决策 | 备选与否决理由 |
|---|------|----------------|
| D1 | **修复方向 = 方案 A：云 overlay 线性域化 + 位置前移**（用户拍板）。链变为 `dt → atmosphere → clouds(HDR) → lensFlare → tonemap` | 方案 B（flare 尾部重叠加）保视觉但侵入 lensFlare 内部 15 子 stage + 光晕渲染两遍，复杂度更高；否决 |
| D2 | **编排形态 = 重挂式**：atmosphere 句柄提供 `insertStageBeforeLensFlare(stage)`——内部 `removeAndDestroy(lensFlare) + removeAndDestroy(tonemap)` → `add(stage)` → rebuild lensFlare → `add(tonemap)`。lensFlare rebuild 一次性成本（~15 子 stage + RT + shader 编译，启动期百 ms 级，与 weather 加载后 march shader 编译长帧同窗口，可接受） | 「延迟式」（创建 atmosphere 时不 add lf/tm，等 clouds 后 finalize）：handle 引入未完成中间态（getter undefined、clouds 失败须记得裸 finalize）不变量差；否决 |
| D3 | **库间解耦 = demo 层显式编排**：`insertStageBeforeLensFlare` API 在 core 的 `AtmosphereStageHandle` 上，demo 在 createCloudsStage 后两行接线。clouds 包不 import atmosphere 句柄类型（链结构是应用层决策，其他消费者链可能不同） | clouds options 接 atmosphereHandle 参数：库耦合加深、消费面假设单一；否决 |
| D4 | **setQuality 协调 = overlay 跨 impl 存活**：overlay stage 从 per-impl 资源改为 per-handle 资源（一次创建、位置恒定、跨档不销毁），换档只切 `u_cloudsBuffer` uniform 源（闭包读顶层 `impl` 变量） | 每次 setQuality 重排 lf/tm（rebuild lf 全套）：换档长帧叠加无必要成本，且每次重排出错面大；否决。副作用见 §6 |
| D5 | **overlay 线性域数学**：premultiplied over 直加——`final = scene.rgb·(1-cloud.a) + cloud.rgb·u_cloudsExposure`。unpremultiply / ACESFilmic / gamma 全删（由链尾 tonemap 统一收尾） | 线性域先 unpremultiply 再 straight mix：premultiplied over 在线性域本就是精确式，无 ACES 非线性失真问题（M2 注释的压暗问题是 ACES 域特有）；不需要 |
| D6 | **overlay RT datatype**：`resolveCloudsHdrDatatype(scene)`（与 march RT / resolvePass 同源检测，`createCloudsStage.ts:452` 已有先例）；sampleMode 保持 NEAREST（dither 透传保护 + 云边缘锐利） | 维持 UNSIGNED_BYTE：线性 >1 段被 clip（太阳周边云过曝死白）；否决 |
| D7 | **exposure 默认值**：起点沿用 6，视觉验收后按需修订（URL `?cloudsExposure=` 已有）。双 ACES → 单 ACES 后云显示亮度/对比必变，本 spec 不预设精确值，验收记录定稿 | —— |

## 3. 目标链结构

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| clouds=0（默认） | `[dt,] atmo, lf, tm` | 不变（零回归路径，insert API 不被调） |
| clouds=1, lensflare=1 | `[dt,] atmo, lf, tm, clouds`（**halo 被云盖**） | `[dt,] atmo, **clouds**, lf, tm`（halo 在云上 ✓） |
| clouds=1, lensflare=0 | `atmo, tm, clouds` | `atmo, clouds, tm` |
| 云销毁（handle.destroy） | 摘 clouds 后 `[dt,] atmo, lf, tm` | 同左——**摘除后链自动闭合**（lf 紧贴 atmo，无需重排） |
| setQuality 换档 | overlay remove+re-add（末尾，顺序已错） | overlay 引用与位置恒定，仅切 uniform 源 ✓ |

（`dt` = depthTemporal，HDR 设备才有；`lf` = lensFlare composite；`tm` = tonemap；`clouds` = clouds overlay）

## 4. overlay 线性域化（packages/cesium-clouds）

### 4.1 Shader（OVERLAY_SHADER 重写）

```glsl
uniform sampler2D colorTexture;      // atmosphere 输出（线性 HDR）
uniform sampler2D u_cloudsBuffer;    // march/resolve 输出（premultiplied 线性 HDR）
uniform float u_cloudsExposure;
in vec2 v_textureCoordinates;

void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  vec4 cloud = texture(u_cloudsBuffer, v_textureCoordinates);
  // 线性域 premultiplied over：cloud.rgb 已含 opacity 因子，直接加和。
  // ACES + gamma 由链尾 tonemap 统一（消灭 M2「云单独 ACES」display 域双 ACES 债）。
  vec3 final = scene.rgb * (1.0 - cloud.a) + cloud.rgb * u_cloudsExposure;
  out_FragColor = vec4(final, scene.a);
}
```

- `cloudsOverlay_ACESFilmic` 函数、unpremultiply（`/ max(cloud.a, 1e-4)`）、`pow(..., 1/2.2)` 全部删除。
- `.a` 透传 `scene.a`（lf/tm 均不消费中段 `.a`，防御性保持）。

### 4.2 Stage 构造变更（`createCloudsStage.ts:467-482`）

- `pixelDatatype`: `PixelDatatype.UNSIGNED_BYTE` → `resolveCloudsHdrDatatype(scene)`（import 自 `./CloudsPass`，已导出）。
- `sampleMode`: NEAREST 保持。
- 注释更新：删除「display ready（已 ACES+gamma），下游无 HDR 需求」语义，改为「线性 HDR 输出，下游 tonemap 统一收尾」。
- **add 位置语义变化**：buildCloudsStageImpl 不再 `scene.postProcessStages.add(overlayStage)`（见 §6 overlay 所有权迁移）；clouds 单独使用（无 atmosphere 编排）时的 append 语义由消费者自行 add（见 §6.3）。

### 4.3 exposure 语义注释

`CLOUDS_OVERLAY_EXPOSURE_DEFAULT = 6` 保留为起点值，注释改写：标定语境从「云单独 ACES 前曝光」变为「线性域云 premultiplied 值缩放，链尾统一 ACES」，验收后定稿新值。

## 5. atmosphere 句柄编排接口（packages/cesium-core）

### 5.1 `AtmosphereStageHandle` 新增方法

```ts
/**
 * 把外部 stage 插入 atmosphere 与 lensFlare 之间（云 overlay 线性域合成用）。
 * 实现：removeAndDestroy(lensFlare) + removeAndDestroy(tonemap) → add(stage) →
 * rebuild lensFlare（按创建时留存的 resolved 参数与 depthSource）→ add(tonemap)。
 * lensFlare 不存在（lensFlare=false）时只重排 tonemap。
 * 摘除由 stage 拥有者自行 removeAndDestroy——摘除后链自动闭合（lf 紧贴 atmo）。
 * 重复调用：第二个 stage 替换第一个（先 removeAndDestroy 旧插入物）再重排——
 * 覆盖「先建后换」场景；但本项目 D4 overlay 跨 impl 存活，正常不触发。
 * 限制：setMode（dead code）在插入后的行为未定义（其自身已有顺序 TODO，注释 warn）。
 */
insertStageBeforeLensFlare(stage: PostProcessStage): void
```

### 5.2 实现要点

- 创建时留存 lensFlare rebuild 所需的完整参数：`resolved` 的 flare 五参 + `temporalEmaEnabled ? 'czm_depth_temporal' : undefined`（depthSource）——存为闭包内 `rebuildLensFlare()` 内部函数，与 `buildAtmosphereStage()`/`buildTonemapStage()` 同款风格。
- `lensFlareStage` 变量 reassign（`let`，现状已是）+ handle getter 自动反映。
- lfHandle 的额外销毁：rebuild 时旧 `createLensFlareStage` 返回的 handle 若带 `destroy()`（plan 阶段核对其形态；composite remove 即级联销毁子 stage，handle 额外资源随子 stage 销毁），确保无泄漏。
- `removeAndDestroy` 传 undefined 的防御（lf 不存在分支）。

### 5.3 不提供 detach API

摘除 = stage 拥有者（clouds handle）自己 `removeAndDestroy(overlay)`，摘除后集合 `[dt,] atmo, lf, tm` 自动正确，atmosphere 无需参与。

## 6. overlay 所有权迁移：per-impl → per-handle（D4）

### 6.1 CloudsStageImpl 接口变化

- `overlayStage` 从 `CloudsStageImpl` 移除（impl 不再拥有 overlay）。
- `resolvePass` 加入 `CloudsStageImpl`（uniform 源切换需要：temporal 路径 overlay 读 `resolvePass.getResolvedBridge()`）。
- `impl.destroy()` 销毁清单**移除** overlay 摘除项（其余不变：cloudsPass → resolvePass → shadowPass → shadowTurbulenceDummy → overlay 中去掉末项）。

### 6.2 顶层（createCloudsStage）变化

- overlay stage 在顶层创建一次（构造参数同 §4.2，uniforms 闭包读顶层 `impl` 变量）：
  ```ts
  u_cloudsBuffer: () => impl.resolvePass != null
    ? impl.resolvePass.getResolvedBridge()
    : impl.cloudsPass.getColorBridge()
  ```
- `handle.overlayStage` getter 直接返回该顶层 stage（不再委托 impl）。
- `setQuality`：destroy 旧 impl → buildImpl 新 impl → **overlay 不动**（uniform 闭包下一帧自动读新 impl 的 bridge）。换档零重排。
- `handle.destroy()`：在 impl.destroy() 之外追加 overlay 摘除（remove 失败则自行 destroy，同 core `removeAndDestroy` 语义——覆盖「消费者从未 add」与「已 insert」两分支）。
- 销毁原子性语义保持：顶层 overlay 创建失败 → destroyed 置位逻辑不变。

### 6.3 add 时机移交消费者

clouds 顶层创建 overlay 后**不自动 add**。正确层级由消费者编排：

- demo（正常路径）：`atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)` 插入。
- clouds 无编排消费者：须自行 `scene.postProcessStages.add(cloudsHandle.overlayStage)`——README 注明。

**否决自动探测**（识别集合中 tonemap/lensFlare 特征后自动插位）：clouds 包无法感知 core 的 stage 身份，探测脆弱。

## 7. demo 接线（apps/demo）

```ts
const atmosphereHandle = createAtmosphereStage(scene, luts, {...})   // 现状
// ... weather 异步加载后
const cloudsHandle = createCloudsStage(scene, luts, weather, {...}) // overlay 已创建未 add
atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage) // 两行编排
```

- setQuality 键盘回调：现状 `cloudsHandle.setQuality(q)` 不变（overlay 位置恒定，无需 demo 再编排）。
- README 参数表补 cloudsExposure 语义变化说明（线性域重标）。

## 8. 测试计划

### 8.1 core（AtmosphereStage.test.ts 增补）

1. `insertStageBeforeLensFlare` 顺序断言：mock collection add/remove 序列——`[remove lf, remove tm, add clouds, add lf', add tm']`（lf 在场）；lf 不在场：`[remove tm, add clouds, add tm']`。
2. rebuild 后 `handle.lensFlareStage` 引用更新为新 composite（≠ 旧引用）。
3. lf rebuild 参数一致：resolved 五参 + depthSource 透传（探针断言 createLensFlareStage 收到的参数）。
4. 插入后 `handle.tonemapStage` 为 rebuild 新实例（getter 反映）。

### 8.2 clouds（createCloudsStage.test.ts 增补 + 修订）

1. OVERLAY_SHADER 源断言修订：线性域式在场（`(1.0 - cloud.a)`、`cloud.rgb * u_cloudsExposure`）；`cloudsOverlay_ACESFilmic`、`1.0 / 2.2`、`max(cloud.a` 不在场。
2. overlay datatype 断言：构造参数 `pixelDatatype` = `resolveCloudsHdrDatatype(scene)`（mock 同源）。
3. **overlay 跨 impl 存活**：setQuality 换档后 `handle.overlayStage` 引用不变（===）；`u_cloudsBuffer` 闭包求值切换到新 impl 的 bridge（探针：新 cloudsPass.getColorBridge 被调用）。
4. 销毁清单修订：impl.destroy 不摘 overlay（collection.remove 探针不触发 overlay）；handle.destroy 时 overlay 摘除（已 add 分支 remove 成功、未 add 分支 destroy 直调）。
5. 顶层创建后**未自动 add**（collection.add 探针零调用）。
6. 既有终审用例「换档×temporal 完整销毁清单」同步修订（overlay 移出 impl 清单）。

### 8.3 demo 视觉验收（URL）

| # | URL 要素 | 判据 |
|---|----------|------|
| V1 | 修复后同 repro-2 视角（`mode=atmosphere&clouds=1&time=2026-08-29T09:30:00Z&camera=120,30,800,268,20&lfHalo=0.5&lfIntensity=0.005`） | halo 圆环完整叠在云上（4~8 点弧段不再被云切断）；用户目验收尾 |
| V2 | 同视角 `&cloudsExposure=N` 遍历 | 云视觉重标：用户选定新默认值 |
| V3 | `clouds=0`（`mode=atmosphere` 全套既有验收 URL） | 零回归（链不变） |
| V4 | `lensflare=0&clouds=1` | 云正常合成于 tonemap 前 |
| V5 | 键盘 1-4 换档后回同视角 | halo 层级不破（overlay 位置恒定） |
| V6 | `hdr=0`（UNSIGNED_BYTE 兜底） | 降级可看（线性 >1 clip 为客观限制，记录不修） |

## 9. 已知限制与风险

1. **太阳被云遮挡时 halo 仍显示**：lensFlare occlusion 只读 globe depth，云不在 depth。修复后「云后太阳」halo 画在云上（物理上应被云 transmittance 调制减弱）。后续增强立项，不在本次。
2. **云视觉必变**（双 ACES → 单 ACES）：V2 重标定收尾；曝光值验收前不稳定，README 注明。
3. **UNSIGNED_BYTE 设备/?hdr=0**：线性域 >1 段 clip，太阳周边云死白——客观降级，记录。
4. **lensFlare rebuild 一次性长帧**：insert 调用帧（demo weather 加载完成帧）~15 子 stage + RT + shader 编译，与 march shader 编译长帧同窗口。
5. **setMode（dead code）**：插入后行为未定义（其已有顺序 TODO），方法注释 warn，不修。
6. **dFdx/dFdy、LUT half-float 精度**等既有约束不受影响（overlay 改动不触 shader 控制流分支）。

## 10. 不做的事

- 云 transmittance 接入 lensFlare occlusion（§9.1 后续立项）。
- temporal（cloudsTemporal/BSM temporal）行为——overlay 输入源（march att0 vs resolve 输出）选择逻辑原样保留。
- setMode 的顺序修复（dead code）。
- Cesium 内建 sun/skyBox 恢复（已关，不碰）。
- 质量档位数值与合并语义（刚合并 c72dd35，零触碰——唯一交叉点是 §6 销毁清单/接口调整，配套修订其测试）。

## 11. 涉及文件清单

| 文件 | 变更 |
|------|------|
| `packages/cesium-clouds/src/createCloudsStage.ts` | OVERLAY_SHADER 线性域重写；overlay 顶层化（跨 impl）+ 不自动 add；CloudsStageImpl 接口调整（去 overlayStage、加 resolvePass）；destroy 清单与 handle.destroy；注释 |
| `packages/cesium-core/src/cesium/AtmosphereStage.ts` | `insertStageBeforeLensFlare` + rebuildLensFlare 内部函数 + 参数留存；handle 接口 |
| `packages/cesium-clouds/src/createCloudsStage.test.ts` | §8.2 |
| `packages/cesium-core/src/cesium/AtmosphereStage.test.ts` | §8.1 |
| `apps/demo/src/main.ts` | §7 两行编排 |
| `README.md` | cloudsExposure 语义 + 编排调用说明 |
