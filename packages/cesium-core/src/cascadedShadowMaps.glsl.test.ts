// cascadedShadowMaps.glsl 文本锚点回归（2026-08-28 远端深色斑修复）。
//
// 根因：getFadedCascadeIndex 末层分支原为 `if (depth >= interval.x)`（three 上游注释
// "Don't fade out the last cascade"）——无远端上界。Cesium 全球尺度下云可视距离
// （maxRayDistance 2e5）≫ BSM 有效距离，超出 shadowFar 的云若 light-space xy 落在末层
// ortho 盒内（uv 合法）会采样到错位 BSM 内容 → 远端云面异常深色斑（屏幕锚定、随相机
// 前进；用户视角 -80.6057,64.5197,7852 实测）。three 场景视距≈阴影 far 故未暴露。
//
// 本测试用文本锚点（非行为复刻——GLSL 无 node 执行环境，复刻实现会随源漂移失义），
// 防未来同步 three 上游或重构时静默丢失上界。GLSL 语法层回归由 cloudsMain.compile.test
// 覆盖（经 #include "core/cascadedShadowMaps" 组装编译）。
import { describe, expect, it } from 'vitest'
import source from './glsl/cascadedShadowMaps.glsl?raw'

describe('cascadedShadowMaps.glsl 远端上界（2026-08-28 深色斑修复锚点）', () => {
  it('getFadedCascadeIndex 末层分支含 depth < 1.0 上界（超出 shadowFar 不选末层 → 消费端 -1 fallback 光深 0）', () => {
    // 末层（#else 分支）的选中条件必须是「有下界且有上界」——只有下界时远处云被误分到末层，
    // light-xy 落盒内则采样错位 BSM 内容（frontDepth 不对应 → distanceToFront 虚高 → 深色斑）
    expect(source).toContain('if (depth >= interval.x && depth < 1.0) {')
  })

  it('getCascadeIndex 末层 fallback 前检查 depth >= 1.0 返回 -1（与 faded 版语义一致）', () => {
    expect(source).toContain('if (depth >= 1.0) {')
    expect(source).toContain('return -1;')
  })

  it('两个 cascade 选择函数仍在（上游结构未大改，锚点 1/2 才有意义）', () => {
    expect(source).toContain('int getCascadeIndex(')
    expect(source).toContain('int getFadedCascadeIndex(')
  })
})
