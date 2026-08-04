// depthTemporalConstants 单元测试。
// 钉死三专家评审参数（spec v2 §5/§11），任何数值变更需重新评审。
import { describe, it, expect } from 'vitest'
import {
  LOW_ALPHA,
  HIGH_ALPHA,
  DEPTH_THRESHOLD_DEFAULT,
  MAX_DELTA_K,
  DIRECTION_WEIGHT,
  FOG_PLANE_LOGDEPTH_EPS,
  TEMPORAL_QUALITY_PRESETS,
} from './depthTemporalConstants'

describe('depthTemporalConstants', () => {
  it('钉死评审参数：alpha/threshold/高度归一化/方向权重/远平面 eps/预设键集', () => {
    // 标量常量（6 个）
    expect(LOW_ALPHA).toBe(0.05)
    expect(HIGH_ALPHA).toBe(0.5)
    expect(DEPTH_THRESHOLD_DEFAULT).toBe(0.1) // log-depth 相对阈值
    expect(MAX_DELTA_K).toBe(0.01) // maxDelta = cameraHeight * 0.01
    expect(DIRECTION_WEIGHT).toBe(0.5) // 运动门控 direction 项权重
    expect(FOG_PLANE_LOGDEPTH_EPS).toBe(1e-4) // 远平面判定 eps

    // preset 键集（防漏键/拼错，类型收窄为 'low' | 'high' 的运行时镜像）
    expect(Object.keys(TEMPORAL_QUALITY_PRESETS).sort()).toEqual(['high', 'low'])

    // preset 4 个字段
    expect(TEMPORAL_QUALITY_PRESETS.low.lowAlpha).toBe(0.05)
    expect(TEMPORAL_QUALITY_PRESETS.low.highAlpha).toBe(0.5)
    expect(TEMPORAL_QUALITY_PRESETS.high.lowAlpha).toBe(0.1)
    expect(TEMPORAL_QUALITY_PRESETS.high.highAlpha).toBe(0.8)
  })
})
