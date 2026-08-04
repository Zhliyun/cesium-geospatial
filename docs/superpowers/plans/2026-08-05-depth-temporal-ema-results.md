# depthTemporal EMA 实施结果

> 基于 spec v2（`docs/superpowers/specs/2026-08-05-depth-temporal-ema-design.md`）+ plan（`docs/superpowers/plans/2026-08-05-depth-temporal-ema.md`）。
> 方案 A（单 stage 打包透传，零 lag），消除 inscatterScale=25 下相机俯仰变化的 inscatter 同心波纹。

## 实现总结（Task 1-13）

**核心架构**：depthTemporal stage（activeStages[0]）打包透传 `vec4(sceneColor.rgb, smoothDepth)`——scene color 流经 RGB，EMA 后的 raw log-depth 存 alpha。atmosphere（activeStages[1]）读 `.rgb`/`.a`。EMA 在 raw log-depth 域，reproject 纯 ECEF 米，运动门控 position+direction 双项 + 高度归一化。history 外部持久 HALF_FLOAT Texture ping-pong，postRender 用 Cesium `createViewportQuadCommand` blit。

- **Task 1（c2c22c5）**：`depthTemporalConstants.ts`——评审钉死参数：LOW/HIGH_ALPHA=0.05/0.5、DEPTH_THRESHOLD_DEFAULT=0.1（log-depth 相对阈值）、MAX_DELTA_K=0.01（高度归一化）、`?temporalQuality=low|high` 预设。
- **Task 2（d6c01e8）**：`depthTemporal.frag.ts` 组装器——raw log-depth 域 EMA（`texture().r`，禁 `czm_readDepth`）+ 纯 ECEF reproject（`czm_inverseView`，禁 altitudeCorrection/METER_TO_LENGTH_UNIT）+ 2-arg `czm_windowToEyeCoordinates`（LOG_DEPTH 分支）+ disocclusion（relDiff/farPlane/边界）+ 打包输出，glslang 校验通过。
- **Task 3（c5d7041）**：`historyBlit.ts`——history Texture ping-pong 管理 + bridge + `outputTexture` adapter（PostProcessStage.outputTexture getter 适配）。
- **Task 4（9b3fd68）**：blit command——用 Cesium `createViewportQuadCommand` 透传 history（替代 raw WebGL），shader-only blit。
- **Task 5（7cbbea4）**：`temporalAlpha.ts`——运动门控：position 项（cameraHeight 归一化）+ direction 项（DIRECTION_WEIGHT=0.5）双线性混合，maxDelta 上限。
- **Task 6（91a853b）**：`cesium-augment.d.ts` 补 `PostProcessStage.outputTexture` getter 类型（最小类型补丁）。
- **Task 7（67b33d0）**：`AtmosphereStage.ts` 装配 depthTemporal 为 activeStages[0]（atmosphere 之前）+ UNSIGNED_BYTE 兜底（非 HALF_FLOAT 时 shader 透传 raw depth）+ sanity check。
- **Task 8（ab36509）**：depthTemporal lifecycle——preRender resize history、postRender blit/swap/prevVP/alpha 更新、首帧 clear、判空保护。
- **Task 9（32ad768）**：aerialPerspective 读 depthTemporal smoothDepth——sceneDist 改 `.a`、originalColor 改 `.rgb`、2-arg `czm_windowToEyeCoordinates`、移除 5-tap、smoothstep UB 修正（horizonKm 边界）。
- **Task 10（755e5b6）**：lensflare occlusion 同源 smoothDepth——`texture().a` + log-depth 阈值（与 atmosphere 同 depth 源，杜绝闪烁）。
- **Task 11（1ec8f91）**：debug=5 规范为 smoothDepth 输出 + debug=8 raw globe depth（EMA 前抖动源），便于对比诊断。
- **Task 12（72db6fa）**：demo URL 参数化——`?temporalEma=0`（关 EMA）/`?temporalQuality=high`（弱平滑）/`?depthThreshold=N`，options 透传。
- **Task 13（b1c4150）**：`depthTemporal.regression.test.ts`——坐标系（reproject 公式）+ VP 一致性（`camera.frustum.projectionMatrix · camera.viewMatrix`，new Matrix4 非 in-place）+ EMA 收敛（alpha=0.05 IIR 60 帧方差 < 1e-6）+ disocclusion（大跳变 alpha=1 拒绝历史）。

前置 cleanup（3b38fdc）：aerialPerspective 回退到 363e441 形态（全局 ×inscatterScale，无 fogEnhance），为 depthTemporal 接线提供干净基线。

## 验证

- **test**：223/223 pass（core 全套，25 个测试文件），含 Task 13 回归（坐标系/VP 一致性/EMA 收敛/disocclusion）。
- **tsc**：0 error（core + demo 均通过）。
- **glslang**：5 个 shader 编译通过——aerialPerspective（2-arg 桩）×1、depthTemporal（默认 + debug=8）×2、occlusion（smooth + legacy UNSIGNED_BYTE 兜底）×2。

## 视觉验收（待用户，demo）

> 用 `pnpm dev` 启动 demo，hard refresh（Cmd+Shift+R）后访问以下 URL 验收。**用户验收后填本节**。

4 个验收场景（spec v2 §9）：

1. **波纹消除（俯仰扫）**：
   `http://localhost:5173/?mode=atmosphere&time=2026-08-04T01:00:00Z&camera=93.4055,32.7362,1002025,0.0,-89&inscatterScale=25`
   - 预期：相机俯仰变化时，远处 inscatter 同心波纹消除（depthTemporal EMA 平滑 globe depth 抖动）。静止后画面稳定无残留抖。

2. **debug=8（抖动源）+ debug=5（EMA 后稳）**：
   上述 URL 加 `&debug=8`（raw globe depth，EMA 前，看抖动源）vs `&debug=5`（atmosphere smoothDepth，EMA 后，看平滑效果）。
   - 预期：debug=8 显示 raw globe log-depth（远密集近稀疏，俯仰变化时同心抖动可见）；debug=5 显示 EMA 后 smoothDepth（抖动平滑）。

3. **山体清晰**：
   `http://localhost:5173/?mode=atmosphere&inscatterScale=25#camera=95.7229,31.5070,11645,295.8,-4.3`
   - 预期：山体边缘清晰不透明（depthTemporal 不糊 fore/mask 山体——EMA 作用于 depth，fore/mask 读 smoothDepth 稳定）。

4. **lensflare 不闪 + 拖影验**：
   上述 URL 加 `&lensflare=1`（默认开），orbit/快速俯仰。
   - 预期：lensflare 不闪（occlusion 同源 smoothDepth）；快速移动时拖影可控（temporalAlpha 移动→highAlpha 偏 current，减拖影）。

**诊断参数**：
- `?temporalEma=0`：关 EMA（depthTemporal 透传 raw depth，对比 EMA on/off 效果）
- `?temporalQuality=high`：弱平滑（lowAlpha=0.1/highAlpha=0.8，减拖影，适合快速操作）
- `?depthThreshold=N`：调 log-depth 相对阈值（默认 0.1）

## 已知 issue / 后续 ticket

1. **FBO 每帧重建 → GL framebuffer handle 泄漏**（Task 8 code review）：每帧 `buildHistoryFBO` 创建新 Framebuffer（`gl.createFramebuffer`），从不 destroy。60fps 长时累积（~21.6万/h）。demo 验收短时不崩；生产长时需修。
   - **ticket**：history FBO ping-pong 缓存（2 FBO 各绑定 1 history Tex，与 historyState 同生命周期，resize 时 destroy 重建，destroy() 清理）。
2. **1e-4 字面量 single source 瑕疵**（Task 10 code review）：occlusion.frag + aerialPerspective.frag 用字面量 1e-4，非 import FOG_PLANE_LOGDEPTH_EPS。值一致但跨文件 single source 债。
3. **Minor polish 汇总**（各 task code review Minor）：
   - Task 8: M5/M6 scratch 惯例（Matrix4/camera.positionWC.clone 复用），M7 resize destroy 断言
   - Task 9: M2 depthTexture unused 注释，M3 smoothstep UB horizonKm<20km 边界注释
   - Task 12: M1 旧测试注释滞后，M2 validate 风格 `!== false` vs `?? true`，M3 setMode TODO 过时，M4 透传 uniform 冗余注释，M5 test 注释晦涩

## 结论

[待用户视觉验收后填：波纹消除达成 / 山体清晰 / lensflare 不闪 / 拖影可控。若验收通过，ready for finishing-a-development-branch（merge/PR/keep）。]
