# 体积云 overlay 线性域化与后处理链重排设计（halo 被云覆盖修复）

- **日期**：2026-08-29
- **状态**：v2（吸收三专家评审：1 BLOCKER + 5 MAJOR + 全部 MINOR）
- **问题来源**：用户报告「相机直面太阳所产生的圆环状光晕与体积云的层级关系不对，光晕被后面的云覆盖了」

## v2 变更记录（供复审聚焦）

| 来源 | 修订 |
|------|------|
| 对抗 B1（三方均命中） | §6.2 setQuality 重建失败分支补 overlay 摘除（悬空 bridge 静默黑帧）；§8.2 补对应用例 |
| 集成 #1 + 对抗 #2 | §5.1 insert 同实例幂等（记忆已插入引用）；§5.2 removeAndDestroy 加 isDestroyed 防御 |
| 对抗 #3 | §5.2 insert 原子性：contains 前置 + try/catch 回滚 |
| 集成 #3 | §5.2 atmosphere 句柄 destroyed guard（insert/setMode/destroy no-op + warn） |
| 集成 #10 + 图形 F6 | §11 文档承载：根 README 建 clouds API 段；cloudsExposure 注释 10→6 三处修正 |
| 集成 #13/#15/#17 + 对抗 #6 | §8 补 mock 升级清单（remove spy 化 + invocationCallOrder、createLensFlareStage vi.mock、有状态 remove、旧用例反向修订）+ dt 共存用例 |
| 图形 F4 + 对抗 #4 | §5.2 rebuild 后按旧 enabled 回写 |
| 图形 F2 + 对抗 #8 | §9.2 补 lf 亮度阈值源含云（第二视觉变化）|
| 三方 | §7 demo 作用域提升（「两行」→实际四行）+ insert 失败处置 |
| 图形 F5 + 对抗 #9 | §9.6 profile=1 组合限制 |
| 图形 F1 | §9.3/V6 ?hdr=0 覆盖面文案修正（只压 atmosphere RT） |
| 对抗 #5 | §3 dt 脚注修正（默认无 depthTemporal） |
| 集成 #8 | §9.4 rebuild 成本修正（textureCache 全链 RT 重建） |
| 三方核实 | §5.2 lfHandle 形态结论关闭（plain handle 无 destroy 无泄漏） |
| 集成 task 建议 | §12 实现拆分建议（供 writing-plans 参考） |

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
| D2 | **编排形态 = 重挂式**：atmosphere 句柄提供 `insertStageBeforeLensFlare(stage)`——内部 `removeAndDestroy(lensFlare) + removeAndDestroy(tonemap)` → `add(stage)` → rebuild lensFlare → `add(tonemap)`。lensFlare rebuild 一次性成本（见 §9.4，与 weather 加载后 march shader 编译长帧同窗口，可接受）。Cesium 源码已核实：remove 即 destroy、remove/add 置 `_textureCacheDirty` 下帧 update 重建依赖图、帧间调用安全、同名 re-add 无冲突、执行序 = 集合数组序 | 「延迟式」（创建 atmosphere 时不 add lf/tm，等 clouds 后 finalize）：handle 引入未完成中间态（getter undefined、clouds 失败须记得裸 finalize）不变量差；否决 |
| D3 | **库间解耦 = demo 层显式编排**：`insertStageBeforeLensFlare` API 在 core 的 `AtmosphereStageHandle` 上，demo 在 createCloudsStage 后接线。clouds 包不 import atmosphere 句柄类型（现状 import 仅 math 常量 + LUT 类型，已核实零新增依赖） | clouds options 接 atmosphereHandle 参数：库耦合加深、消费面假设单一；否决 |
| D4 | **setQuality 协调 = overlay 跨 impl 存活**：overlay stage 从 per-impl 资源改为 per-handle 资源（一次创建、位置恒定、跨档不销毁），换档只切 `u_cloudsBuffer` uniform 源（闭包读顶层 `impl` 变量）。**失败分支处置见 §6.2（v2：评审 BLOCKER 修订）** | 每次 setQuality 重排 lf/tm（rebuild lf 全套）：换档长帧叠加无必要成本，且每次重排出错面大；否决。副作用见 §6 |
| D5 | **overlay 线性域数学**：premultiplied over 直加——`final = scene.rgb·(1-cloud.a) + cloud.rgb·u_cloudsExposure`。unpremultiply / ACESFilmic / gamma 全删（由链尾 tonemap 统一收尾）。已核实：无样本路径 `vec4(0)` → a=0 时 bit-exact 透传；E·premultiplied ≡ premultiplied(E·straight) | 线性域先 unpremultiply 再 straight mix：premultiplied over 在线性域本就是精确式，无 ACES 非线性失真问题（M2 注释的压暗问题是 ACES 域特有）；不需要 |
| D6 | **overlay RT datatype**：`resolveCloudsHdrDatatype(scene)`（与 march RT / resolvePass 同源检测，`createCloudsStage.ts:452` 已有先例）；sampleMode 保持 NEAREST（dither 透传保护 + 云边缘锐利）。已核实：±1.5/255 dither ≈ half-float ULP 的 ~12 倍，HF RT 无量化风险 | 维持 UNSIGNED_BYTE：线性 >1 段被 clip（真 8-bit 设备上太阳周边云过曝死白）；否决 |
| D7 | **exposure 默认值**：起点沿用 6，视觉验收后按需修订（URL `?cloudsExposure=` 已有）。已核实不透明云内部（a→1）新旧式同为 `pow(ACES(6·rgb), 1/2.2)`——云内部显示不变，差异仅在混合带；atmosphere 输出（≈0.6-6）与 cloud.rgb×6（≈0.6）同处 ACES 工作区 | —— |

## 3. 目标链结构

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| clouds=0（默认） | `[dt,] atmo, lf, tm` | 不变（零回归路径，insert API 不被调） |
| clouds=1, lensflare=1 | `[dt,] atmo, lf, tm, clouds`（**halo 被云盖**） | `[dt,] atmo, **clouds**, lf, tm`（halo 在云上 ✓） |
| clouds=1, lensflare=0 | `atmo, tm, clouds` | `atmo, clouds, tm` |
| 云销毁（handle.destroy） | 摘 clouds 后 `[dt,] atmo, lf, tm` | 同左——**摘除后链自动闭合**（lf 紧贴 atmo，无需重排） |
| setQuality 换档 | overlay remove+re-add（末尾，顺序已错） | overlay 引用与位置恒定，仅切 uniform 源 ✓ |
| setQuality 换档重建**失败** | overlay 随旧 impl 已摘（安全） | catch 分支摘 overlay（§6.2 v2）——句柄作废、云消失、不悬挂 |

（`dt` = depthTemporal——**HDR 设备且 `?depthTemporal=1` 显式开启才有，默认无**（v2 脚注修正：`resolved.depthTemporal` 默认 false）；`lf` = lensFlare composite；`tm` = tonemap；`clouds` = clouds overlay）

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
- `.a` 透传 `scene.a`（已核实 lf_threshold/lf_composite 只读 .rgb 且写死 .a=1.0、tonemap 不分支、atmosphere HDR 路径写 .a=1.0——中段 .a 无消费者，防御性保持）。

### 4.2 Stage 构造变更（`createCloudsStage.ts:467-482`）

- `pixelDatatype`: `PixelDatatype.UNSIGNED_BYTE` → `resolveCloudsHdrDatatype(scene)`（import 自 `./CloudsPass`，已导出）。
- `sampleMode`: NEAREST 保持。
- 注释更新：删除「display ready（已 ACES+gamma），下游无 HDR 需求」语义，改为「线性 HDR 输出，下游 tonemap 统一收尾」。
- **add 位置语义变化**：buildCloudsStageImpl 不再 `scene.postProcessStages.add(overlayStage)`（见 §6 overlay 所有权迁移）；add 时机移交消费者（§6.3）。

### 4.3 exposure 语义注释

`CLOUDS_OVERLAY_EXPOSURE_DEFAULT = 6` 保留为起点值，注释改写：标定语境从「云单独 ACES 前曝光」变为「线性域云 premultiplied 值缩放，链尾统一 ACES」，验收后定稿新值。**v2：三处「默认 10」陈旧注释一并修正**——`CloudsStageOptions.cloudsOverlayExposure` JSDoc（createCloudsStage.ts:127）、demo main.ts:412 注释、根 README cloudsExposure 行，全部改 6（与代码一致，防 V2 调参被误导）。

## 5. atmosphere 句柄编排接口（packages/cesium-core）

### 5.1 `AtmosphereStageHandle` 新增方法

```ts
/**
 * 把外部 stage 插入 atmosphere 与 lensFlare 之间（云 overlay 线性域合成用）。
 * 语义（v2 评审修订）：
 * - 同实例重复调用 = no-op（真幂等）；
 * - 不同实例 = 替换：先摘旧插入物（isDestroyed 防御）再重排；
 * - 传入已 add 到集合的 stage = 抛清晰错误（前置 contains 检查）——add 时名字冲突
 *   抛错会留下「lf/tm 已 remove、链残缺」的半途状态，必须前置拦截；
 * - 原子性：内部 remove lf/tm → add(stage) → rebuild lf → add(tm) 全程 try/catch，
 *   失败时回滚（重建 lf/tm 并 re-add）后 rethrow——调用方拿到的要么全成功要么原状；
 * - handle.destroy 后调用 = no-op + console.warn；
 * - lensFlare 不存在（创建时 lensFlare=false）时只重排 tonemap；
 * - rebuild 的 lf 继承旧 lf 的 enabled 状态（§5.2）。
 * 摘除由 stage 拥有者自行 removeAndDestroy——摘除后链自动闭合（lf 紧贴 atmo）。
 * 限制：setMode（dead code）在插入后的行为未定义（其自身已有顺序 TODO，注释 warn）。
 */
insertStageBeforeLensFlare(stage: PostProcessStage | PostProcessStageComposite): void
```

（v2：签名放宽收 Composite——collection.add/remove 与内部 removeAndDestroy 均收两者，无谓收窄。）

### 5.2 实现要点

- **destroyed guard（v2 新增）**：atmosphere 句柄加 destroyed 布尔；`destroy()` 幂等；destroy 后 `insertStageBeforeLensFlare`/`setMode` no-op + console.warn（对齐 clouds 句柄宽容风格）。
- **同实例幂等（v2 新增）**：闭包记忆 `insertedStage` 引用；同实例调用直接 return；不同实例先 `removeAndDestroy(旧)`（经 isDestroyed 防御）再重排。
- **removeAndDestroy 防御（v2 新增）**：函数入口判 `s.isDestroyed()` 为 true 则跳过（不调 `.destroy()`——destroyObject 会把 destroy 替换成 throwOnDestroyed，对已销毁 stage 的 fallback 分支会抛「This object was destroyed」断链）。现有实现（AtmosphereStage.ts:665-669）同步加此防御（setMode dead code 从未触发过该雷，insert 是活代码必须堵）。
- **contains 前置（v2 新增）**：`scene.postProcessStages.contains(stage)` 为 true 时抛清晰 `DeveloperError`（提示「stage 已在集合中，insert 要求传入未 add 的 stage」）。
- **原子性 try/catch（v2 新增）**：重排序列包 try/catch；失败时回滚（rebuild lf/tm + re-add 已摘的），rethrow。
- 创建时留存 lensFlare rebuild 参数：`resolved` 的 flare 五参（**读闭包变量当前值**，与 setMode 重建语义一致，非创建时快照——v2 措辞修正）+ `temporalEmaEnabled ? 'czm_depth_temporal' : undefined`（创建时常量）——封装为闭包内 `rebuildLensFlare()` 内部函数，与 `buildAtmosphereStage()`/`buildTonemapStage()` 同款风格。
- **enabled 继承（v2 新增）**：rebuild 后按旧 `lensFlareStage.enabled` 回写一行（消费者运行时 `lensFlareStage.enabled=false` 的 M1 切换路径不被 rebuild 重置）。
- `lensFlareStage` 变量 reassign（`let`，现状已是）+ handle getter 自动反映。
- **lfHandle 形态（v2 关闭）**：三专家核实 createLensFlareStage 返回 plain handle（纯引用字段、无 destroy()、无自持 GL 资源），composite remove 即级联销毁子 stage，RT 归 collection 级 textureCache 管理——无泄漏，无需额外销毁。
- depthSource `'czm_depth_temporal'` 字符串经 Cesium 内部 `getStageByName` 查名字表解析；dt stage 不被 remove、名字恒在——rebuild 后解析不变（已核实）。

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
- **setQuality 失败分支（v2 评审 BLOCKER 修订）**：重建抛错时旧 impl 已销毁、`destroyed=true` 置位，**此时必须同步摘除顶层 overlay**（remove 成功即已 destroy；失败则 `overlay.destroy()`）——否则 overlay 残留链中，u_cloudsBuffer 闭包每帧读已销毁 impl 的悬空 bridge（destroyObject 保留数据属性、GL 纹理名已删 → 绑定已删除纹理，静默黑帧/脏画面不报错）。摘除后云随句柄作废一起消失，语义与句柄「半死不可自愈、须重建 stage」一致。
- `handle.destroy()`：在 impl.destroy() 之外追加 overlay 摘除（remove 失败则自行 destroy，同 core `removeAndDestroy` 语义——覆盖「消费者从未 add」与「已 insert」两分支）。
- 销毁原子性语义保持：顶层 overlay 创建失败 → destroyed 置位逻辑不变。

### 6.3 add 时机移交消费者

clouds 顶层创建 overlay 后**不自动 add**。正确层级由消费者编排：

- demo（正常路径）：`atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)` 插入。
- clouds 无编排消费者：须自行 `scene.postProcessStages.add(cloudsHandle.overlayStage)`——**根 README 建「体积云 stage API」段**（v2 评审修订：承载 breaking change 说明 + 编排示例，见 §11）。

**否决自动探测**（识别集合中 tonemap/lensFlare 特征后自动插位）：clouds 包无法感知 core 的 stage 身份，探测脆弱。

**已知静默失败面（v2 记录）**：insert 失败被 demo catch 吞掉时，cloudsPass primitive 仍在每帧 march（GPU 白跑）而 overlay 永不 add → 云不可见。demo 侧处置：insert 失败时 `console.error`（区别于 weather 失败的 warn）+ `cloudsHandle.destroy()` 回收 primitive（§7）。

## 7. demo 接线（apps/demo）

```ts
// 作用域提升（v2 评审修订：atmosphereHandle 现为 else 块内 const :281，clouds 块在块外不可见）：
let atmosphereHandle: AtmosphereStageHandle | undefined   // 块外声明
if (skipAtmosphere) { ... } else {
  atmosphereHandle = createAtmosphereStage(scene, luts, {...})   // 现状逻辑
  // ... weather 异步加载后（现有 cloudsHandle != null 块内）：
  const cloudsHandle = createCloudsStage(scene, luts, weather, {...}) // overlay 已创建未 add
  if (atmosphereHandle != null) {
    atmosphereHandle.insertStageBeforeLensFlare(cloudsHandle.overlayStage)
  } else {
    scene.postProcessStages.add(cloudsHandle.overlayStage) // 无 atmosphere 编排的 fallback
  }
}
```

- insert 失败处置：try/catch 内 `console.error('[clouds] 链插入失败，云已回收')` + `cloudsHandle.destroy()`（§6.3 静默失败面对策）。
- setQuality 键盘回调：现状 `cloudsHandle.setQuality(q)` 不变（overlay 位置恒定，无需 demo 再编排）。
- README：参数表 cloudsExposure 默认值 10→6 修正 + §6.3 API 段交叉引用。

## 8. 测试计划

### 8.0 mock 基建升级（v2 新增，两包测试的前置）

1. core `mockSceneWithAddSpy`：`postProcessStages.remove` 从裸函数 `() => false` 改 **vi.fn 可控返回值**；跨方法相对顺序断言用 vitest 原生 `mock.invocationCallOrder`（add/remove/contains 各 spy 的调用序统一可比）。
2. core 新增 `vi.mock('./lensFlare/createLensFlareStage')`（现状测试用真实实现直跑）——rebuild 参数断言与新旧实例区分依赖它。
3. 真实 `PostProcessStage.destroy()` 在 node 下可跑（releaseResources 对未初始化字段短路 + destroyObject）；destroyObject 后 `isDestroyed()===true` 可作「旧 stage 已销毁」断言探针。
4. clouds mock：remove 需**有状态**（记录 add 过的 stage 才返回 true）——覆盖 §8.2.4 已 add/未 add 两分支。
5. **旧用例反向修订**：现有「clouds:true → add 到 postProcessStages」（createCloudsStage.test.ts:203-214）与新语义（不自动 add）矛盾，须改写为「创建后集合零 add」。

### 8.1 core（AtmosphereStage.test.ts 增补）

1. `insertStageBeforeLensFlare` 顺序断言：`[remove lf, remove tm, add clouds, add lf', add tm']`（lf 在场）；lf 不在场：`[remove tm, add clouds, add tm']`（invocationCallOrder）。
2. rebuild 后 `handle.lensFlareStage` 引用更新为新 composite（≠ 旧引用）。
3. lf rebuild 参数一致：resolved 五参 + depthSource 透传（vi.mock 探针断言收参）。
4. 插入后 `handle.tonemapStage` 为 rebuild 新实例（getter 反映）。
5. **同实例幂等（v2）**：第二次 insert(同 stage) 集合零操作。
6. **contains 前置（v2）**：已 add 的 stage → 抛错且集合无变更。
7. **destroyed guard（v2）**：handle.destroy 后 insert → no-op + warn；destroy 幂等。
8. **enabled 继承（v2）**：旧 lf.enabled=false → rebuild 后新 lf.enabled===false。
9. **depthTemporal 共存（v2）**：`[dt, atmo, clouds, lf', tm']`——dt 不动 + rebuild lf 的 depthSource='czm_depth_temporal'。

### 8.2 clouds（createCloudsStage.test.ts 增补 + 修订）

1. OVERLAY_SHADER 源断言修订：线性域式在场（`(1.0 - cloud.a)`、`cloud.rgb * u_cloudsExposure`）；`cloudsOverlay_ACESFilmic`、`1.0 / 2.2`、`max(cloud.a` 不在场。
2. overlay datatype 断言：构造参数 `pixelDatatype` = `resolveCloudsHdrDatatype(scene)`（mock 同源）。
3. **overlay 跨 impl 存活**：setQuality 换档后 `handle.overlayStage` 引用不变（===）；`u_cloudsBuffer` 闭包求值切换到新 impl 的 bridge（探针：新 cloudsPass.getColorBridge 被调用）。
4. 销毁清单修订：impl.destroy 不摘 overlay（collection.remove 探针不触发 overlay）；handle.destroy 时 overlay 摘除（已 add 分支 remove 成功、未 add 分支 destroy 直调——需 §8.0.4 有状态 remove）。
5. 顶层创建后**未自动 add**（collection.add 探针零调用；§8.0.5 旧用例反向修订）。
6. **setQuality 重建失败 overlay 摘除（v2 评审 BLOCKER 用例）**：mock buildImpl 第二次抛错 → 断言 overlay 已被 removeAndDestroy、句柄作废（后续 setQuality warn no-op）。
7. 既有终审用例「换档×temporal 完整销毁清单」同步修订（overlay 移出 impl 清单）。

### 8.3 demo 视觉验收（URL）

| # | URL 要素 | 判据 |
|---|----------|------|
| V1 | 修复后同 repro-2 视角（`mode=atmosphere&clouds=1&time=2026-08-29T09:30:00Z&camera=120,30,800,268,20&lfHalo=0.5&lfIntensity=0.005`） | halo 圆环完整叠在云上（4~8 点弧段不再被云切断）；用户目验收尾 |
| V2 | 同视角 `&cloudsExposure=N` 遍历 | 云视觉重标：用户选定新默认值（同时目测 lf 强度变化——§9.2 亮度阈值源含云）；回改 `CLOUDS_OVERLAY_EXPOSURE_DEFAULT` + README |
| V3 | `clouds=0`（`mode=atmosphere` 全套既有验收 URL） | 零回归（链不变） |
| V4 | `lensflare=0&clouds=1` | 云正常合成于 tonemap 前 |
| V5 | 键盘 1-4 换档后回同视角 | halo 层级不破（overlay 位置恒定） |
| V6 | `hdr=0`（v2 判据修正） | `?hdr=0` 只把 atmosphere RT 压到 RGBA8（disableHalfFloat 仅作用 core postHdrDatatype，march/overlay/lf 的 datatype 由各自检测决定、不受该 flag 控制）——本机（HalfFloat 设备）实际链 = atmo(RGBA8) → clouds(HF) → lf(HF) → tm(RGBA8)，云的 >1 线性值不 clip。判据：画面可看、无崩溃、云正常；**真 8-bit 设备全链路行为无法在本机复现，如实记录**（可选增强：disableHalfFloat 透传进 clouds，不强制） |

## 9. 已知限制与风险

1. **太阳被云遮挡时 halo 仍显示**：lensFlare occlusion 只读 globe depth，云不在 depth。修复后「云后太阳」halo 画在云上（物理上应被云 transmittance 调制减弱）。后续增强立项，不在本次。
2. **云视觉两处变化（v2 合并图形 F2/对抗 #8）**：① 双 ACES → 单 ACES（亮度/对比，V2 重标）；② **lf 亮度阈值源变化**——lf_threshold 从读 atmosphere 输出变为读 clouds overlay 输出（lf 前移到云后），被照亮的亮云（线性 ≥0.6 > threshold）将参与 flare 能量提取，多云场景 flare 总能量上升、亮云局部可能产生以云为中心的 ghost/halo。与参考库行为一致（flare 读含云合成场景）、方向正确，但属层级修正之外的第二视觉变化，V1/V2 验收时一并目测。
3. **UNSIGNED_BYTE 兜底的真实边界（v2 修正）**：`?hdr=0` 只压 atmosphere RT；真 8-bit 设备上 march/overlay/lf 全 RGBA8，云 >1 线性值 clip（太阳周边死白）——客观降级，本机无法复现，记录（V6）。
4. **insert 一次性长帧（v2 成本修正）**：remove/add 触发 collection 级 `_textureCacheDirty` → textureCache 重建**全部** framebuffers（不只 lf 的 RT——atmosphere/tonemap/depthTemporal/clouds 的 RT 同帧全重分配）+ lf 15 子 stage shader 编译。一次性、demo weather 加载完成帧窗口，可接受；比 v1 估计更长。
5. **setMode（dead code）**：插入后行为未定义（其已有顺序 TODO），方法注释 warn，不修。
6. **profile=1 与 clouds=1 组合（v2 记录）**：GPU 计时包装发生在启动期（链=atmo/lf/tm），insert 在 weather 加载后——rebuild 出的新 lf'/tm' 不被包装，`?profile=1&clouds=1` 输出缺 lf/tm/clouds_overlay 计时键。已知限制，记录不修。
7. **薄云边缘大气段双重计入（pre-existing，仅记录）**：march 内 applyAerialPerspective 已对云 rgb 施加 camera→cloudFront 大气段，overlay 的 (1-a) 背景又含同段大气——该段在云与背景各计一次。现状 display 域同样存在，本次不恶化，不修。
8. **dFdx/dFdy、LUT half-float 精度**等既有约束不受影响（overlay 改动不触 shader 控制流分支）。

## 10. 不做的事

- 云 transmittance 接入 lensFlare occlusion（§9.1 后续立项）。
- lf threshold 云感知调权（§9.2② 目测后如有需要另立项）。
- temporal（cloudsTemporal/BSM temporal）行为——overlay 输入源（march att0 vs resolve 输出）选择逻辑原样保留。
- setMode 的顺序修复（dead code）。
- profile 包装跟随 rebuild（§9.6 记录）。
- Cesium 内建 sun/skyBox 恢复（已关，不碰）。
- 质量档位数值与合并语义（刚合并 c72dd35，零触碰——唯一交叉点是 §6 销毁清单/接口调整，配套修订其测试）。

## 11. 涉及文件清单

| 文件 | 变更 |
|------|------|
| `packages/cesium-clouds/src/createCloudsStage.ts` | OVERLAY_SHADER 线性域重写；overlay 顶层化（跨 impl）+ 不自动 add + setQuality catch 摘 overlay；CloudsStageImpl 接口调整（去 overlayStage、加 resolvePass）；destroy 清单与 handle.destroy；cloudsOverlayExposure JSDoc 10→6；注释 |
| `packages/cesium-core/src/cesium/AtmosphereStage.ts` | `insertStageBeforeLensFlare`（幂等/contains 前置/原子回滚/destroyed guard/enabled 继承）+ rebuildLensFlare 内部函数 + 参数留存；removeAndDestroy isDestroyed 防御；handle 接口（destroyed） |
| `packages/cesium-clouds/src/createCloudsStage.test.ts` | §8.0.4/5 + §8.2 |
| `packages/cesium-core/src/cesium/AtmosphereStage.test.ts` | §8.0.1/2/3 + §8.1 |
| `apps/demo/src/main.ts` | §7：atmosphereHandle 作用域提升 + insert 编排 + 失败处置 + :412 注释 10→6 |
| `README.md` | cloudsExposure 10→6；**新建「体积云 stage API」段**（overlayStage 须消费者 add、demo 两行编排示例、insertStageBeforeLensFlare 用法）——breaking change 文档承载 |

## 12. 实现拆分建议（供 writing-plans 参考，v2 新增）

- **T1（clouds，shader 数学）**：§4 全部 + §8.2.1/2。注意 T1 单独合入时 overlay 仍在链尾读 display 域按线性处理，视觉暂错——只能单测验收，demo 视觉验收统一在 T4 后。
- **T2（core，编排 API，可与 T1 并行）**：insertStageBeforeLensFlare 全语义 + rebuildLensFlare + destroyed guard + removeAndDestroy 防御 + §8.0.1/2/3 + §8.1 全部。
- **T3（clouds，所有权迁移，依赖 T1 同文件串行）**：overlay 顶层化 + impl 接口调整 + 不自动 add + setQuality catch 摘 overlay + §8.0.4/5 + §8.2.3-7。
- **T4（demo+文档）**：main.ts 作用域提升 + insert 编排 + 失败处置 + README（API 段 + 10→6）。
- **T5（视觉验收）**：V1-V6 + V2 曝光定稿（回改默认值 + README）+ results 文档。
