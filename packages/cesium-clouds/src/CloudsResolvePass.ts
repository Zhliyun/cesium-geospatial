// CloudsResolvePass.ts
//
// M4 T4：云 resolve Pass——第二个 VolumetricPrimitive（pass=VOXELS，add 在 march 之后）
// 跑 cloudsResolve.frag：读 march 低分 MRT（color/depthVelocity）+ 全分 history → 写全分
// resolve RT。resolve/history 双 Texture ping-pong（plan D2）。
//
// 执行点（plan D1）：march primitive 与本 pass 的 primitive 同 pass=VOXELS，
// PrimitiveCollection 数组序 → update 顺序 → commandList 序 = march 先 resolve 后
// （GL 串行无读写 hazard）。createCloudsStage 负责按「先 march 后 resolve」顺序 add（T7）。
//
// swap 时机（plan D2）：createCloudsStage preRender **开头**调 swapBuffers()——等价 three 的
// render 后 swap：swap 后 historyRef=上帧输出（resolve 读）、resolveRef=待写（渲染中写入、
// overlay 闭包在 PostProcess 阶段取值 = 本帧输出）。
//
// 结构（plan T4 定案）：双 Texture + 双内部 VolumetricPrimitive（各挂一张的 FBO）+ 稳定外壳。
// 为什么不 swap 时重建 primitive：PrimitiveCollection 持 primitive 引用——destroy 旧实例会让
// collection 里的引用失效（destroyed 后 update 不再 push command，resolve 停摆）。外壳
// update 转发到 active，swap 只切 active 引用，零 GL 调用零 GC。

import {
  Texture,
  Sampler,
  BoundingRectangle,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  TextureWrap,
  Cartesian2,
  PixelFormat
} from 'cesium'
import type { Context } from 'cesium'
import { createVolumetricPrimitive, type VolumetricPrimitive } from '@cesium-geospatial/core'
import { buildCloudsResolveFragmentShader } from './CloudsResolveMaterial'

/** 云 resolve Pass 构造选项。 */
export interface CloudsResolvePassOptions {
  /** Cesium Context。 */
  context: Context
  /** 全分宽（drawingBufferWidth）。 */
  width: number
  /** 全分高。 */
  height: number
  /** HDR 像素类型（与 march MRT 同源 resolveCloudsHdrDatatype）。 */
  pixelDatatype: number
  /** march 低分 color（MRT att0）。 */
  colorBuffer: Texture
  /** march 低分 depthVelocity（MRT att1）。 */
  depthVelocityBuffer: Texture
  /** frame 闭包（读 params.frame——与 march/BSM 同帧递增，Bayer 相位共享）。 */
  frame: () => number
  /** variance clipping γ（three CloudsResolveMaterial 默认 2）。 */
  varianceGamma?: number
  /** temporal 混合 α（three 默认 0.1；upscale 分支不消费此值，编译进 TAA 分支）。 */
  temporalAlpha?: number
  /**
   * 【2026-10-08 白点治理】输出端孤点中值滤波强度（0=关缺省；1=全替换）——
   * 3×3 邻域中值替换孤立亮/暗点（march 采样方差白点的显示端清除）。
   * demo `?cloudsDespeckle=1`。
   */
  spatialDespeckle?: number
  /** 【2026-10-25】Bayer 直通开关（缺省 1） */
  bayerDirectThrough?: number
  /** 【2026-10-26 探针】1=alpha 输出「历史是否被裁」，配合 ?cloudsOverlayDebug=1 观察 */
  clipDebug?: number
  /**
   * 【2026-10-26 时域收敛】upscale 分支 EMA 权重（0 = 参考库纯裁剪累积语义）。
   * 1/16 = 16 相位滑动平均（每帧 6.25% 当前帧）。
   */
  temporalBlend?: number
  /** 【2026-10-26】0=跳过 AABB 裁剪（纯 EMA）。缺省 1=参考库语义。 */
  clipEnabled?: number
  /** 【2026-10-26】速度死区（全分像素；0=关）。demo `?cloudsVelDeadzone=0.5`。 */
  velocityThresholdPx?: number
  /** 【2026-10-26】EMA 权重的距离衰减（0=关）。 */
  blendDepthFalloff?: number
  /** 【2026-10-26】远云专用 EMA 权重（0=关）。 */
  temporalBlendFar?: number
  /** 【2026-10-26】历史采样点吸附整像素（缺省 1=开；0=关）。 */
  historySnap?: number
  /**
   * 【2026-10-27】**本帧**几何 jitter（归一化 UV）读取器。resolve 两处消费：
   * ① 当前帧低分采样反向平移（把整帧平移过的低分图重采样回像素栅格）；
   * ② velocity += j(t)（march 的 velocity 含 −j(t) 偏置）。
   */
  jitterUV?: () => Cartesian2
  /** 【2026-10-27 A/B】1=去抖动重采样（缺省）；0=旧行为（点采样 + 不补偿 velocity 偏置）。 */
  dejitter?: number
  /** 【2026-10-26】AABB 最小半宽（0=零回归；用于让历史在 march 噪声摆动下存活） */
  clipMinHalf?: number
  /** 【2026-10-25 探针】0=关历史重投影（排查拖动静止垂直漂移是否来自 velocity）。缺省 1。 */
  reprojectionEnabled?: number
  /**
   * disocclusion rejection 阈值（本项目 2026-09-02 黑块修复新增，默认 0.5；>1 禁用）。
   * |current.a − history.a| 超阈 = 遮挡关系翻转，拒绝 history 直出 current。
   */
  temporalDisocclusion?: number
  /**
   * upscale 降采样分母（涂抹修复 T1，2026-09-02）：注入 resolve shader 宏 UPSCALE_DIVISOR，
   * 须与 CloudsPass options.upscaleDivisor 传同值。缺省 1（2026-09-02 用户定稿全分档；
   * T1 合并时缺省 4=three 原文）。
   * 1 = 全分 march——resolve 不走 TEMPORAL_UPSCALE（低分重建无意义）而走 three 原生
   * temporalAntialiasing（TAA）分支：全分 texelFetch + velocity 重投影 + variance clipping
   * + α 混合（全分辨率画质 + 时域降噪）。
   */
  upscaleDivisor?: 1 | 2 | 4
}

/** 云 resolve Pass 句柄。 */
export interface CloudsResolvePass {
  /** 本帧 resolve 输出纹理（swap 后的 resolveRef——渲染中写入，overlay 读它）。 */
  readonly resolvedTexture: Texture
  /** 稳定外壳 primitive（createCloudsStage add 到 scene.primitives，在 march 之后；swap 不换引用）。 */
  readonly primitive: VolumetricPrimitive
  /** resolve↔history 交换（preRender 开头调；三引用轮换：resolvePrim/primB 与两 Texture）。 */
  swapBuffers(): void
  /** resolve 输出的 bridge（{_texture,_target}——overlay u_cloudsBuffer 用，temporal 开启时）。 */
  getResolvedBridge(): { _texture: unknown; _target: number }
  /**
   * 动态改 temporal α（运动自适应 T2，2026-09-02）：uniformMap 闭包每帧读最新值，
   * 下一 resolve draw 即生效。静止收敛用小 α、相机运动中用大 α——由 createCloudsStage
   * preRender 按相机速度驱动。
   */
  setTemporalAlpha(value: number): void
  /** 【2026-10-25】Bayer 直通开关（0=关；相位冻结时必须关） */
  setBayerDirectThrough(value: number): void
  setClipMinHalf(value: number): void
  /** 【2026-10-26】静止收敛：AABB 裁剪开关（1=参考库语义） */
  setClipEnabled(value: number): void
  /** 【2026-10-26】静止收敛：EMA 权重（0=纯裁剪） */
  setTemporalBlend(value: number): void
  /** 【2026-10-26】静止收敛：历史重投影开关（静止应为 0） */
  setReprojectionEnabled(value: number): void
  /** 【2026-10-26】EMA 权重的距离衰减系数（运动时 >0，静止 0） */
  setBlendDepthFalloff(value: number): void
  /** 【2026-10-26】远云专用 EMA 权重（0=关） */
  setTemporalBlendFar(value: number): void
  /** 释放：双内部 primitive（各含 FBO）+ 双 Texture。幂等。 */
  destroy(): void
}

/**
 * 创建云 resolve Pass（双 Texture/双内部 primitive ping-pong + 稳定外壳）。
 */
const ZERO2 = new Cartesian2(0, 0)

export function createCloudsResolvePass(
  options: CloudsResolvePassOptions
): CloudsResolvePass {
  const { context } = options
  const varianceGamma = options.varianceGamma ?? 2
  // T2（2026-09-02）：α 由 const 改 let——setTemporalAlpha 每帧改写，uniformMap 闭包读最新值
  let temporalAlpha = options.temporalAlpha ?? 0.1
  // 【2026-10-25】Bayer 直通开关（缺省 1）；相位冻结时由上层每帧置 0（见 shader 注释）
  let bayerDirectThrough = options.bayerDirectThrough ?? 1
  // 【2026-10-26】AABB 最小半宽（0=零回归）
  let clipMinHalf = options.clipMinHalf ?? 0
  // 【2026-10-26】静止收敛三开关（preRender 按 still 逐帧改写）
  let clipEnabled = options.clipEnabled ?? 1
  let temporalBlend = options.temporalBlend ?? 0
  let reprojectionEnabled = options.reprojectionEnabled ?? 1
  // 【2026-10-27】远段长窗起点 50km→20km（6km 机位俯视时云海主体在 13–50km，原阈值够不到，
  // 长窗形同虚设 → 那片云只能吃 4 帧运动窗 = 颗粒）。近于 6km 的云仍走运动短窗。
  const farRange = new Cartesian2(2e4, 6e4)
  let blendDepthFalloff = options.blendDepthFalloff ?? 0
  let temporalBlendFar = options.temporalBlendFar ?? 0
  const temporalDisocclusion = options.temporalDisocclusion ?? 0.5
  const upscaleDivisor =
    options.upscaleDivisor === 4 || options.upscaleDivisor === 2 ? options.upscaleDivisor : 1

  // history 经 texture() bilinear 采样 → LINEAR（march 输出走 texelFetch 与 filter 无关）
  const sampler = new Sampler({
    minificationFilter: TextureMinificationFilter.LINEAR,
    magnificationFilter: TextureMagnificationFilter.LINEAR,
    wrapS: TextureWrap.CLAMP_TO_EDGE,
    wrapT: TextureWrap.CLAMP_TO_EDGE
  })
  const mkTex = (): Texture =>
    new Texture({
      context,
      width: options.width,
      height: options.height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: options.pixelDatatype,
      sampler
    })

  let resolveTex = mkTex() // 本帧写入
  let historyTex = mkTex() // 上帧输出（resolve 读；首帧全 0 → varianceClipping clip 到 current 邻域）

  const texelSize = new Cartesian2(1 / options.width, 1 / options.height)
  const uniformMap: { [name: string]: () => unknown } = {
    colorBuffer: () => options.colorBuffer,
    depthVelocityBuffer: () => options.depthVelocityBuffer,
    colorHistoryBuffer: () => historyTex,
    texelSize: () => texelSize,
    frame: options.frame,
    varianceGamma: () => varianceGamma,
    temporalAlpha: () => temporalAlpha,
    temporalDisocclusion: () => temporalDisocclusion,
    // 【2026-10-24】despeckle 缺省回到 0：曾设为 1（窗口 3×3 后零成本），但它是空间
    // 滤波，会让云面偏「磨砂」——用户目验否决。保留为 ?cloudsDespeckle=1 手动开启。
    u_spatialDespeckle: () => options.spatialDespeckle ?? 0,
    u_reprojectionEnabled: () => reprojectionEnabled,
    u_bayerDirectThrough: () => bayerDirectThrough,
    u_clipDebug: () => options.clipDebug ?? 0,
    u_clipMinHalf: () => clipMinHalf,
    u_temporalBlend: () => temporalBlend,
    u_clipEnabled: () => clipEnabled,
    // 【2026-10-27】缺省 0.35 全分像素：重投影恒开后用它压静止的亚像素残差
    //（实测 ~0.013px），既防「静止爬行」又不影响任何可见运动。
    u_velocityThresholdPx: () => options.velocityThresholdPx ?? 0,
    u_blendDepthFalloff: () => blendDepthFalloff,
    u_temporalBlendFar: () => temporalBlendFar,
    u_farRange: () => farRange,
    u_jitterUV: () => options.jitterUV?.() ?? ZERO2,
    u_dejitter: () => options.dejitter ?? 1,
    // 【2026-10-27 对齐参考库】historySnap 缺省 1→0：参考库 history 是 `texture()` 双线性；
    // 我们每帧把 prevUv 吸附到全分 texel（±0.5px 量化），旋转时分数部分逐帧变化，在掠射带
    // 被放大成云纹上下游走。需要对比时可 `?cloudsHistorySnap=1`。
    u_historySnap: () => options.historySnap ?? 0
  }

  // N=1（全分 march）：temporalUpscale=false → TAA 分支（temporalAntialiasing）——
  // 低分重建语义（lowResCoord/直通 Bayer）对全分输入无意义；TAA 分支 per-pixel
  // texelFetch + velocity 重投影 + variance clipping + α 混合（three 原生路径）。
  // N>1：temporalUpscale=true → upscale 分支（宏 UPSCALE_DIVISOR 选直通映射）。
  const fragmentShaderSource = buildCloudsResolveFragmentShader({
    temporalUpscale: upscaleDivisor > 1,
    upscaleDivisor
  })
  // ⚠️ viewport 必须显式 = 全分：RenderState.viewport 为 undefined 时 Cesium 不动 GL viewport
  //（保持上一个 draw 遗留值）——resolve 跟在低分 march 后执行会继承 march 的低分 viewport，
  // 只在全分纹理左下角 1/16 区域写入（实测 M4：resolveTex 其余全 0、云整体消失）。
  // M2/M3 时代 march 全分时此处「碰巧」正确（遗留 viewport=drawingBuffer）。
  const fullViewport = new BoundingRectangle(0, 0, options.width, options.height)
  const mkPrim = (tex: Texture): VolumetricPrimitive =>
    createVolumetricPrimitive({
      context,
      fragmentShaderSource,
      uniformMap,
      mrtColorTextures: [tex],
      viewport: fullViewport
    })
  let resolvePrim = mkPrim(resolveTex)
  let primB = mkPrim(historyTex)

  let destroyed = false
  // 稳定外壳：swap 只切 active（两内部 primitive 恰一个被转发 → 每帧恰好一次 resolve draw）
  const shell: VolumetricPrimitive = {
    update(frameState: unknown): void {
      if (destroyed) return
      resolvePrim.update(frameState)
    },
    isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      resolvePrim.destroy()
      primB.destroy()
      resolveTex.destroy()
      historyTex.destroy()
    }
  }
  return {
    get resolvedTexture(): Texture {
      return resolveTex
    },
    primitive: shell,
    swapBuffers(): void {
      if (destroyed) return
      // 三引用轮换（resolvePrim/primB 与 resolveTex/historyTex 对齐）：
      // primB 挂的正是换入的 resolveTex，换出者下轮复用
      const nextResolveTex = historyTex
      const nextResolvePrim = primB
      historyTex = resolveTex
      resolveTex = nextResolveTex
      primB = resolvePrim
      resolvePrim = nextResolvePrim
    },
    getResolvedBridge(): { _texture: unknown; _target: number } {
      const internal = resolveTex as unknown as { _texture: unknown; _target: number }
      return { _texture: internal._texture, _target: internal._target }
    },
    setClipMinHalf(value: number): void {
      clipMinHalf = value
    },
    setClipEnabled(value: number): void {
      clipEnabled = value
    },
    setTemporalBlend(value: number): void {
      temporalBlend = value
    },
    setReprojectionEnabled(value: number): void {
      reprojectionEnabled = value
    },
    setBlendDepthFalloff(value: number): void {
      blendDepthFalloff = value
    },
    setTemporalBlendFar(value: number): void {
      temporalBlendFar = value
    },
    setBayerDirectThrough(value: number): void {
      bayerDirectThrough = value
    },
    setTemporalAlpha(value: number): void {
      temporalAlpha = value
    },
    destroy(): void {
      shell.destroy()
    }
  }
}
