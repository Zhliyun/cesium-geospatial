// ShadowPass.ts
//
// M3 T3：BSM 生成端——sun-POV 全屏 march 写 Texture3D 的 cascade 层。
//
// 时机（决策 D2）：createCloudsStage 的 scene.preRender listener 内调 render()——
// 先于云 march（VOXELS pass），且此刻 camera.frustum.near/far 是完整视锥（cascade split 域一致）。
// BSM 不依赖 globe depth（sun-POV 云密度场，零场景几何）→ preRender 合法。
//
// 生成机制（决策 D1）：Cesium Texture3D（HALF_FLOAT RGBA mapSize²×N）+ 裸 GL FBO
// glFramebufferTextureLayer 逐层 attach（WebGL2 允许 TEXTURE_3D attach layer）→ 每 cascade
// 一次全屏 draw。Plan B（layer attach 不可用）：2D FBO + glCopyTexSubImage3D——render() 内部
// 替换，接口不变。
//
// 「不传 framebuffer 保留外部裸 FBO」机制（已核 Cesium Context.js 源码）：FullscreenPass 的
// DrawCommand 不带 framebuffer → Context.draw 取 `command._framebuffer ?? passState.framebuffer`
// = undefined → beginDraw → bindFramebuffer(context, undefined)——当 `undefined ===
// context._currentFramebuffer`（每帧 endFrame() 置 undefined；preRender 时刻恒成立）时整个
// 函数 no-op，GL 绑定原样保留（我们裸 bind 的 FBO 不被动）。若 _currentFramebuffer 非
// undefined（如 Cesium Framebuffer 曾 bind 过）会 bind null 破坏裸绑定——preRender 时机无此路径。

import {
  Texture3D,
  PixelFormat,
  PixelDatatype,
  Sampler,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  TextureWrap,
  RenderState,
  BoundingRectangle
} from 'cesium'
import type { Context } from 'cesium'
import { FullscreenPass } from '@cesium-geospatial/core'
import { buildCloudsShadowFragmentShader, type ShadowMainOptions } from './ShadowMaterial'

// 裸 GL 常量（WebGL2RenderingContext enum 值）
const GL_FRAMEBUFFER = 0x8d40
const GL_COLOR_ATTACHMENT0 = 0x8ce0
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5
const GL_FRAMEBUFFER_BINDING = 0x8ca6

/**
 * 生成端单次全屏 draw 的抽象（缺省 FullscreenPass；测试注入 stub）。
 * FullscreenPass 依赖 context.createViewportQuadCommand（Cesium Context 深路径），
 * 抽出工厂便于 node 单测。
 */
export interface ShadowDrawPass {
  execute(context: Context): void
  destroy(): void
}

/** draw pass 工厂（缺省 FullscreenPass + RenderState viewport=mapSize；测试注入 stub）。 */
export type ShadowDrawPassFactory = (
  context: Context,
  fragmentShaderSource: string,
  uniformMap: { [name: string]: () => unknown },
  viewportSize: number
) => ShadowDrawPass

/** ShadowPass 构造选项。 */
export interface ShadowPassOptions {
  /** Cesium Context（取 _gl 做裸 FBO 调用）。 */
  context: Context
  /** cascade 数（3；shadow.frag CASCADE_COUNT 同值，BSM Texture3D 的 depth 维）。 */
  cascadeCount: number
  /** BSM 单边尺寸（512）。 */
  mapSize: number
  /** 像素数据类型（缺省 HALF_FLOAT；HALF_FLOAT renderable 检测由调用方 createCloudsStage 传入）。 */
  pixelDatatype?: number
  /** 业务 uniform（weather/LUT/层/march-shadow 档/inverseShadowMatrices——调用方组好）。 */
  uniformMap: { [name: string]: () => unknown }
  /** T2 组装器编译分支开关（缺省全开）。 */
  shaderOptions?: ShadowMainOptions
  /** 测试注入 draw pass 工厂；缺省 FullscreenPass。 */
  createDrawPass?: ShadowDrawPassFactory
}

/** BSM 生成端 Pass 句柄（T4 消费 bsmTexture；T5 preRender 调 render）。 */
export interface ShadowPass {
  /** BSM 纹理（mapSize²×cascadeCount，sampler3D）——消费端 clouds.frag shadowBuffer uniform 直传。 */
  readonly bsmTexture: Texture3D
  /** 生成一帧 BSM：N×(attach layer i → u_cascadeIndex=i → 全屏 draw)。preRender 调。 */
  render(): void
  /** 释放：裸 FBO + drawPass + bsmTexture。幂等。 */
  destroy(): void
}

// 缺省 draw pass 工厂：FullscreenPass + RenderState.fromCache（viewport=mapSize、depth off）。
// 不传 framebuffer——见文件头「保留外部裸 FBO」机制；RenderState.viewport 在 execute 内 apply。
const defaultCreateDrawPass: ShadowDrawPassFactory = (
  context,
  fragmentShaderSource,
  uniformMap,
  viewportSize
) =>
  new FullscreenPass(context, {
    fragmentShaderSource,
    uniformMap,
    renderState: RenderState.fromCache({
      viewport: new BoundingRectangle(0, 0, viewportSize, viewportSize),
      depthTest: { enabled: false },
      depthMask: false
    })
  })

// Cesium 公开 .d.ts 缺 drawingBufferWidth/Height（Context augment 为空 interface）。局部补最小形状。
interface CesiumContext extends Context {
  drawingBufferWidth: number
  drawingBufferHeight: number
}

/**
 * 预置全 0 texel 视图（TypedArray 类型随 pixelDatatype 匹配）。
 *
 * HALF_FLOAT 无原生 TypedArray——Uint16Array 位承载（0x0000 = +0.0 half）。Cesium
 * Texture3D.loadBufferSource 对 arrayBufferView 无 TypedArray 类型校验（defined 检查后
 * 直接透传 texSubImage3D，已核 @cesium/engine 源码），Uint16Array 配 HALF_FLOAT 合法。
 * 预置 0 保证首帧生成前消费端采样得 0 光深 → Beer=1（与 M2 dummy shadowBuffer 同降级语义）。
 */
function allocZeroedTexels(texelCount: number, pixelDatatype: number): Uint16Array | Float32Array | Uint8Array {
  if (pixelDatatype === PixelDatatype.HALF_FLOAT) {
    return new Uint16Array(texelCount)
  }
  if (pixelDatatype === PixelDatatype.FLOAT) {
    return new Float32Array(texelCount)
  }
  return new Uint8Array(texelCount)
}

/**
 * 创建 BSM 生成端 Pass（Texture3D + 裸 FBO + 逐 cascade 全屏 draw）。
 *
 * @param options 见 ShadowPassOptions。
 */
export function createShadowPass(options: ShadowPassOptions): ShadowPass {
  const context = options.context as CesiumContext
  const cascadeCount = options.cascadeCount
  const mapSize = options.mapSize
  const pixelDatatype = options.pixelDatatype ?? PixelDatatype.HALF_FLOAT
  const gl = (context as unknown as { _gl: WebGL2RenderingContext })._gl

  // ── BSM 纹理（immutable storage——有 source 时 Cesium 走 texStorage3D，可逐层 attach）──
  // LINEAR + CLAMP_TO_EDGE：消费端 sampleShadowOpticalDepth 三线性插值；R 维同样 clamp
  // （Sampler.wrapR，3D 纹理第三维）。flipY=false——flipY=true 时 Cesium Texture3D 会
  // console.warn 不支持。
  const bsmTexture = new Texture3D({
    context,
    source: {
      width: mapSize,
      height: mapSize,
      depth: cascadeCount,
      arrayBufferView: allocZeroedTexels(mapSize * mapSize * cascadeCount * 4, pixelDatatype)
    },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype,
    sampler: new Sampler({
      minificationFilter: TextureMinificationFilter.LINEAR,
      magnificationFilter: TextureMagnificationFilter.LINEAR,
      wrapS: TextureWrap.CLAMP_TO_EDGE,
      wrapT: TextureWrap.CLAMP_TO_EDGE,
      wrapR: TextureWrap.CLAMP_TO_EDGE
    }),
    flipY: false
  })

  // ── 裸 GL FBO（Cesium Framebuffer 不支持 attach Texture3D 单层——走 glFramebufferTextureLayer）──
  const fbo = gl.createFramebuffer()

  // ── uniformMap：业务 uniform 展开 + u_cascadeIndex 注入覆盖（T2 shader 侧声明 uniform int；
  // render() 每 draw 前切值，同 shader 复用 ShaderProgram 缓存）。mutable 闭包。
  let cascadeIndex = 0
  const uniformMap: { [name: string]: () => unknown } = {
    ...options.uniformMap,
    u_cascadeIndex: () => cascadeIndex
  }

  // ── draw pass（缺省 FullscreenPass；shader 用 T2 组装器）──
  const fragmentShaderSource = buildCloudsShadowFragmentShader(options.shaderOptions)
  const drawPass = (options.createDrawPass ?? defaultCreateDrawPass)(
    context,
    fragmentShaderSource,
    uniformMap,
    mapSize
  )

  // Texture3D raw WebGLTexture handle（裸 FBO attach 用；私有 _texture，cast 访问）
  const rawTex = (bsmTexture as unknown as { _texture: WebGLTexture })._texture

  let destroyed = false
  return {
    bsmTexture,
    render(): void {
      if (destroyed) return
      // save：外部 FBO 绑定（可能 null=default framebuffer）——finally 恢复
      const prevFbo = gl.getParameter(GL_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      gl.bindFramebuffer(GL_FRAMEBUFFER, fbo)
      try {
        for (let i = 0; i < cascadeCount; i++) {
          // 逐层 attach（TEXTURE_3D layer attach；level 0——BSM 无 mipmap）
          gl.framebufferTextureLayer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, rawTex, 0, i)
          // 完整性只在 i===0 查一次（三层同 texture 同格式，一层完整则全完整）。
          // 不完整 → warn + return（降级：消费端 fallback dummy Beer=1——无自阴影，不炸）。
          if (i === 0 && gl.checkFramebufferStatus(GL_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
            console.warn('[clouds] BSM FBO 不完整，跳过本帧（主 march fallback Beer=1）')
            return
          }
          cascadeIndex = i // 先切 uniform 再 draw（同 draw 内 uniformMap 闭包读到本层值）
          drawPass.execute(context)
        }
      } finally {
        // restore：外部 FBO 绑定 + viewport 回 drawingBuffer（RenderState.viewport=mapSize
        // 在 execute 内 apply 过；bindFramebuffer 切回时 WebGL 虽会重置 viewport，显式恢复
        // 以防 prevFbo 尺寸非当前 drawingBuffer 的边角）
        gl.bindFramebuffer(GL_FRAMEBUFFER, prevFbo)
        gl.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight)
      }
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      drawPass.destroy()
      gl.deleteFramebuffer(fbo)
      // Texture3D destroy（augment 类型未声明 destroy，cast 调用——同 CloudsPass 惯例）
      ;(bsmTexture as unknown as { destroy(): void }).destroy()
    }
  }
}
