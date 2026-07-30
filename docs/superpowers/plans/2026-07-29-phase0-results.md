# Phase 0 验证结果（go/no-go）

> **状态**：✅ **三项全过 → GO，进入 Phase 1**。代码完成、静态验证通过、浏览器运行时验证（G1/G2/G3）由项目方于 2026-07-30 确认通过。
>
> **日期**：2026-07-29（代码）；2026-07-30（运行时验证确认）
> **分支**：`phase0/native-injection-spike`
> **Cesium 版本**：1.143.0（`@cesium/engine` 26.1.0）

---

## 1. 已完成（代码层，已验证）

| 项 | 状态 | 证据 |
|---|---|---|
| pnpm monorepo 骨架（cesium-core + demo） | ✅ | `pnpm install` 通过，workspace 解析正常 |
| 渲染器无关层：GLSL 资产（14 个 .glsl 保持原样）+ resolveIncludes/unrollLoops + 数学 | ✅ | 从源仓库逐字拷贝 |
| ATMOSPHERE const 注入（绕过 struct uniform 障碍） | ✅ | `atmosphereParameters.ts` |
| 密切球再中心化（Cesium 原生类型） | ✅ | 单测 2 个通过 |
| 单元测试 | ✅ | **12 passed**（resolveIncludes 3 + altitudeCorrection 2 + depthReconstruction 3 + parseHalfFloatBin 4） |
| demo TypeScript 类型检查 | ✅ | `tsc --noEmit` 无错误（补 cesium 内部类类型声明后） |
| LUT 加载（.bin half-float → Texture/Texture3D） | ✅ | parseHalfFloatBin 单测 + assets 拷贝 |
| dev server 启动 | ✅ | Vite 6.4.3 ready @ localhost:5173 |
| 资源可达性 | ✅ | index.html / main.ts / luts/*.bin(131072B) / cesium Workers & Assets 全部 HTTP 200 |

## 2. Cesium 能力查证结论（关键，降低 G1 风险）

源码级查证 `@cesium/engine@26.1.0` 确认以下能力**原生支持**，无需 hack：

| 能力 | 证据 | 对本项目的意义 |
|---|---|---|
| **Texture3D 类** | `Renderer/Texture3D.js`，从 `'cesium'` 导出（`Cesium.js:35`） | scattering 等 3D LUT 可用 Cesium 原生类创建，**无需裸 `gl._gl`** |
| **sampler3D uniform 绑定** | `createUniform.js:31-34` `SAMPLER_3D → UniformSampler`；`UniformSampler.set()` 读 `v._target`；`Texture3D` 有 `_target` getter（→ TEXTURE_3D） | PostProcessStage 的 uniforms 可直接传 Texture3D 对象 |
| **GLSL ES 3.00 PostProcessStage** | `out_FragColor` / `in vec2 v_textureCoordinates` / `texture()` | 与 bruneton GLSL3 资产天然兼容 |
| **precision highp sampler3D 自动注入** | `ShaderSource.js:246` | 无需手动声明 sampler3D precision |
| **Context._gl 私有** | 无公开 getter（但 Texture3D 封装了 texImage3D，不需要直接访问） | R7 风险由 Texture3D 化解 |

**结论**：交接文档列为最高风险之一的 R7（3D/half-float 纹理 Cesium 封装不全）**实际已被 Cesium 原生 Texture3D 解决**。交接文档基于较旧 Cesium 版本的判断，1.143 已无此障碍。

## 3. 待浏览器验证的 G1/G2/G3

运行 demo 后，在浏览器 console + 画面确认。**结论栏由项目方填写。**

### G1 — GLSL 编译
- **怎么做**：打开 `http://localhost:5173/?mode=sky`，看浏览器 console。
- **判据**：console **无** `Shader program link error` / `compile error`；全屏非全黑（即使颜色不对）。
- **已知风险点**（若编译失败，优先排查）：
  1. `const AtmosphereParameters ATMOSPHERE = AtmosphereParameters(...)` 的 struct 数组构造语法 `DensityProfileLayer[2](...)`（源仓库用 uniform，未用过 GLSL 构造；这是新增）。
  2. `#define GetSkyRadiance GetSkyLuminance`（runtime.glsl:458）的宏替换是否按预期把 main 的 5 参数调用引到 GetSkyLuminance。
  3. Texture3D 作为 PostProcessStage uniform 的实际绑定（类型系统支持，但 PostProcessStage uniforms 选项路径未实测）。
- **结论**：✅ **通过**（2026-07-30 项目方确认：console 无 shader 编译/链接错误）

### G2 — 深度重建
- **怎么做**：打开 `http://localhost:5173/?mode=depth`。
- **判据**：globe（灰色 ellipsoid）显示世界坐标彩虹分量（连续变化）；多视锥边界处无明显条带；相机移动分量平滑。
- **结论**：✅ **通过**（2026-07-30 项目方确认：globe 世界坐标彩虹分量连续，多视锥边界无条带）

### G3 — ECEF / 密切球再中心化
- **怎么做**：`?mode=sky`，移动相机。
- **判据**：天空非黑、有大气散射色彩；相机平移/旋转时**无全屏抖动/错位**（密切球再中心化正确的标志）。
- **结论**：✅ **通过**（2026-07-30 项目方确认：地平线视角天顶深蓝→地平线亮的瑞利散射渐变正确；太空视角地球向阳边缘大气辉光弧正确；整体拖动平滑无抖动/错位）

### G3 修复过程（运行时调试记录）

初次运行 G3 呈**全白球**——根因：`SUN/SKY_SPECTRAL_RADIANCE_TO_LUMINANCE` 误传**绝对亮度**（~1e5），而源仓库 `sky.frag` 传**相对亮度**（绝对亮度 ÷ 太阳亮度 75722，归一到 ~1 量级）且不做曝光。改传相对亮度后又**过暗**——用 `?debug=1/2/3` 三种可视化插桩定位：debug=3 白=桥接正确、debug=2 绿=太阳方向正确、debug=1 有结构=radiance 非零只是曝光过低。据 debug=1 对数刻度定标（天空主体 0.1~2、向阳峰值≈9），曝光调至 3.0 + Reinhard 压缩峰值，G3 通过。**修复提交**：`2295458`（相对亮度）、`328b89e`（debug 插桩+画布铺满）、`8f561f6`（曝光定标）。

另修复**画布不铺满**：缺 Cesium `widgets.css` → `index.html` 引入并强制 `.cesium-viewer/canvas` 100%。

## 4. go/no-go 裁决

**✅ GO（2026-07-30）**：G1/G2/G3 三项全过。go/no-go 前提（深度/多视锥语义、ECEF/密切球再中心化、GLSL 注入可行性）全部钉死。**进入 Phase 1（大气散射 MVP）。**

- **三项全过** → 进入 Phase 1（大气散射 MVP）。【已达成】
- ~~G1 失败~~ / ~~G2 失败~~ / ~~G3 失败~~ 的补救路径不再适用（均已通过）。

### Phase 1 待办（衔接交接文档全范围目标）

1. 天空 stage 复用 Phase 0 已验证管线（相对亮度 + 曝光/Reinhard 已就位）。
2. 大气透视（aerial perspective）：地表/模型按距离叠加雾化的散射（`GetSkyRadianceToPoint` 路径，需 G2 深度重建的世界坐标）。
3. 太阳/月亮 billboard、星空（可选，源仓库 stars.frag 已有）。
4. 色调映射接入 Cesium 后处理链（替换占位 Reinhard，对齐源仓库 exposure）。
5. 与 Cesium globe 地形的正确混合（GROUND_ALBEDO 分支、深度遮挡）。

## 5. 如何运行

```bash
pnpm install
pnpm dev          # → http://localhost:5173/?mode=sky  (或 ?mode=depth)
pnpm --filter @cesium-geospatial/core test   # 12 单测
```

## 6. 与计划的偏差（执行中调整）

1. **vite 7 → vite 6**：vite-plugin-static-copy 2.x peer 仅支持 vite 5/6（vite 7 太新，插件未适配）。降级 vite 6，生态成熟。
2. **vite-plugin-cesium → vite-plugin-static-copy**：前者依赖 rollup 2（不兼容）。改用 static-copy 手动服务 cesium 静态资源。
3. **裸 `gl._gl` → Cesium Texture3D**：查证发现 Cesium 1.143 原生 Texture3D 类完整支持，改用原生 API（消除 R7 风险）。
4. **Sampler wrapS 值**：计划草案 `wrapS: 0` 有误（CLAMP_TO_EDGE=0x812F），改用 Cesium 默认 sampler。
5. **太阳 API**：`computeSunPosition` 不存在；正确为 `computeSunPositionInEarthInertialFrame` + `Transforms.computeIcrfToFixedMatrix` 转 ECEF。
6. **cesium 类型补充**：Texture3D/Context/Texture 未在 cesium 公开 `.d.ts`，加 `cesium-augment.d.ts` 补最小类型。
