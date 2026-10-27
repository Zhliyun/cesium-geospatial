// demo 验收档单一来源（spec §8.4）。demo 的 URL 参数全部在 profile 之上覆盖；
// 产品 install 缺省复用同一份值，避免 demo 与产品两处手抄分叉。
//
// 收录口径：只收 demo **无条件**传给 createAtmosphereStage / createCloudsStage、
// 且与库缺省不同的值（或 demo 明确拍板、需与产品共享的基准常量）。
// 与库缺省相同的项（例如 lensFlare=true、temporalEma=true、inscatterScale=8、
// moonAngularRadius=0.014）不入表——库已负责，重复反而制造第二来源。
//
// 逐项来源见各字段注释（apps/demo/src/main.ts 对应位置）。

import type { AtmosphereStageOptions } from '@cesium-geospatial/core'
import type { CloudsStageOptions } from '@cesium-geospatial/clouds'

/** demo 验收档：demo 裸 URL（无任何参数）即生效的默认路径。 */
export interface DemoProfile {
  /** 大气 stage 缺省项（展开在 demo URL 条件项之前）。 */
  atmosphere: Partial<AtmosphereStageOptions>
  /** 体积云 stage 缺省项（展开在 demo URL 条件项之前）。 */
  clouds: Partial<CloudsStageOptions>
  /** 月盘亮度基准（未按纹理均值补偿前）；demo 在载月面纹理时除以 albedoMean。 */
  moonRadianceBase: number
}

export const DEMO_PROFILE = {
  atmosphere: {
    // 来源：apps/demo/src/main.ts:325（`...DEMO_PROFILE.atmosphere`）；URL 显式覆盖在 :450-452。
    // 库缺省 1（物理满档）；【2026-09-30 用户拍板】P1 解锁满摆幅后全影过深，
    // 0.7 试档后上调 0.8 定稿。仅在 M6 地面云影桥存在（?groundShadow!=0）时生效——
    // shader 的 HAS_GROUND_SHADOW define 由桥决定，单独传 strength 不改画面。
    groundShadowStrength: 0.8
  },
  clouds: {
    // 来源：apps/demo/src/main.ts:597（`...DEMO_PROFILE.clouds`，原字面量 `clouds: true`）。
    // 库缺省 false（不建云 stage）；demo 验收缺省开启，?clouds=0 关闭（整段不创建）。
    clouds: true
  },
  // 来源：apps/demo/src/main.ts:318-321 的 moonRadianceDefault 基准。
  // 1546=774×(0.014/0.0099)²——ω 定稿 0.014 时同式保显示亮度（库缺省亦为 1546，
  // 但它是 demo/产品共同的验收基准，显式固化以防库缺省变更悄悄改画面）。
  moonRadianceBase: 1546
} satisfies DemoProfile
