import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildAtmospherePrefix } from './cesiumCore'

describe('buildAtmospherePrefix', () => {
  it('含 HAS_HIGHER_ORDER_SCATTERING_TEXTURE（C9：云 god rays 走物理正确分支防过暗黑）', () => {
    expect(buildAtmospherePrefix()).toContain(
      '#define HAS_HIGHER_ORDER_SCATTERING_TEXTURE'
    )
  })

  it('契约：prefix 恒 define HAS_HIGHER ⇒ 所有 include bruneton/runtime 的消费端 frag 必须声明+绑定 higher_order_scattering_texture', () => {
    // 回归锁（2026-09-03 seed 链排查副产）：prefix 自 C9 起无条件加 define，runtime.glsl 的
    // GetScattering/GetSkyRadiance 在该分支引用 higher_order_scattering_texture——消费端 frag
    // 漏声明 = undeclared identifier 编译炸 → Cesium render loop 停 → tiles/云全停摆，
    // 浏览器 A/B 实验全成死帧伪像（当日 seed=1 vs 1337「同图」实为此伪像）。
    // aerialPerspective（core 自有）声明在场；demo skyStage.frag/SkyStage.ts 曾遗漏
    //（另一分支 49ad628 已修，本分支独立补齐）——此处锁死两文件防复发。
    const read = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), 'utf-8')
    // core 自家消费端（LUT uniform 段单源）
    expect(read('./aerialPerspective.frag.ts')).toContain(
      'uniform sampler3D higher_order_scattering_texture;'
    )
    // demo sky 消费端（跨包契约锁：demo 无测试基建，锁在 prefix 单源侧）
    expect(read('../../../../apps/demo/src/skyStage.frag.ts')).toContain(
      'uniform sampler3D higher_order_scattering_texture;'
    )
    expect(read('../../../../apps/demo/src/SkyStage.ts')).toContain(
      'higher_order_scattering_texture: () => luts.higherOrderScattering'
    )
  })

  it('含 COMBINED_SCATTERING_TEXTURES + 纹理尺寸 define + precision highp sampler3D', () => {
    const prefix = buildAtmospherePrefix()
    expect(prefix).toContain('#define COMBINED_SCATTERING_TEXTURES')
    expect(prefix).toContain('#define TRANSMITTANCE_TEXTURE_WIDTH 256')
    expect(prefix).toContain('#define SCATTERING_TEXTURE_R_SIZE 32')
    expect(prefix).toContain('precision highp sampler3D;')
  })
})
