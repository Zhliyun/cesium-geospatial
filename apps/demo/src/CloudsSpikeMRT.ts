// CloudsSpikeMRT.ts — phase3 体积云 M1 spike probe
//
// 目的：go/no-go 验证 Cesium 下「custom Primitive pass=VOXELS + 自管 MRT FBO」可行性，4 项：
//   #1 custom Primitive（pass=VOXELS）在 globe 后、PostProcess 前执行（输出可见、半透明叠加不遮 globe）。
//   #2 globe depthTexture 能被云 shader 读取（probe 输出 depth 可视化）。
//   #3 czm_viewerPositionWC / czm_inverseView 自动注入（probe 输出 czm 量级）。
//   #4 自管 MRT FBO（3 attachment：color/depthVelocity/shadowLength）一次 draw 多输出
//      （layout(location=0/1/2) out 验证写入）。
//
// 所有 API 已 @cesium/engine@26.1.0 源码核实：
//   - Pass.VOXELS=10（Source/Renderer/Pass.js:27）。Pass.js 注释「Commands are executed in order by pass
//     up to the translucent pass」→ VOXELS(10) 在 GLOBE(2) 后、OPAQUE(8) 前执行
//     （Scene.js:2756 performPass(GLOBE) → :2934 performVoxelsPass → :2936 OPAQUE）→
//     globe depthTexture 在 VOXELS 执行时已就绪。
//   - Context.createViewportQuadCommand(fragSrc, {uniformMap, framebuffer, pass, renderState, owner})
//     返回 DrawCommand（Context.js:1619）。无 boundingVolume 的 command 不被 cull
//     （Scene.js:2074 isVisible：!defined(boundingVolume) → return true）。
//   - DrawCommand._framebuffer 优先 passState.framebuffer（Context.js:1412，「for off-screen rendering」）
//     → 云 cmd 写自己的 MRT FBO。
//   - Framebuffer({context, colorTextures:[t0,t1,t2], destroyAttachments:false}) → MRT；
//     Context.bindFramebuffer 自动 glDrawBuffers(_activeColorAttachments)（Context.js:1230-1239）→
//     多 attachment 自动启用，shader 用 layout(location=0/1/2) out 即可。
//   - globe depthTexture 私有路径：scene._view.globeDepth.depthStencilTexture（GlobeDepth.js:74 getter）。
//   - bridge {_texture,_target} 注入 PostProcessStage uniformMap（createUniform.js:259
//     gl.bindTexture(v._target,v._texture)；AtmosphereStage.ts:468 u_historyTexture 同模式）。
//   - ShaderSource WebGL2 自动注入 #version 300 es（:300）+ precision（:233-242）；
//     location 0 的 out_FragColor 显式声明安全——ShaderSource.js:284 正则检测到已存在则不重复注入。
//   - czm_viewerPositionWC 经 ShaderProgram._automaticUniforms 自动注入（Primitive 走 ShaderProgram 必注入）。
//   - PrimitiveCollection.update(frameState) 遍历 primitives[i].update(frameState)（:432）；
//     primitive.update 内 frameState.commandList.push(cmd)（CloudCollection.js:761 同模式）。

import {
  Texture,
  Framebuffer,
  Sampler,
  PixelFormat,
  PixelDatatype,
  TextureMinificationFilter,
  TextureMagnificationFilter,
  TextureWrap,
  PostProcessStage,
  type Scene,
} from 'cesium'
import type { Context, DrawCommand } from 'cesium'

// Pass.VOXELS=10（Renderer/Pass.js:27）。@private 不在公开 .d.ts（index.d.ts 缺），运行时从 'cesium'
// 可导入但类型不可见——用字面量常量 + 源码行号注释，避免依赖未导出类型。
const PASS_VOXELS = 10

// Context 公开 .d.ts 缺 drawingBufferWidth/createViewportQuadCommand（Context augment 为空 interface）。
// 局部补最小形状（参照 historyBlit.ts buildBlitCommand 的 cast 模式）。
interface SpikeContext {
  drawingBufferWidth: number
  drawingBufferHeight: number
  createViewportQuadCommand: (
    fragmentShaderSource: string,
    overrides: {
      uniformMap?: { [uniformName: string]: () => unknown }
      framebuffer?: Framebuffer
      pass?: number
      renderState?: unknown
      owner?: unknown
    },
  ) => DrawCommand
}

// probe shader —— MRT 3 out（layout location 显式声明）。
// 不写 #version / precision / v_textureCoordinates 声明：Cesium ShaderSource WebGL2 自动注入
// （#version 300 es、precision highp；ViewportQuadVS 输出 in vec2 v_textureCoordinates）。
// location 0 的 out_FragColor 显式声明安全（ShaderSource.js:284 检测到已存在则不重复注入）。
// czm_viewerPositionWC / czm_inverseView 经 ShaderProgram._automaticUniforms 自动注入（不声明）。
const PROBE_SHADER = `uniform sampler2D u_globeDepth;
in vec2 v_textureCoordinates;
layout(location = 0) out vec4 out_FragColor;
layout(location = 1) out vec4 out_DepthVelocity;
layout(location = 2) out vec4 out_ShadowLength;
void main() {
  // raw globe depth（log 编码，spike 先看 raw 是否变化——不解码，验 #2 depthTexture 可读）。
  // 注：log 深度编码下近地形 d 偏小（暗）、远空 d→1（亮），与「近白远黑」相反；
  // spike 判据是 B/depth 「随距离变化」即可，方向非关键。
  float d = texture(u_globeDepth, v_textureCoordinates).r;
  // czm 注入验证（验 #3）：相机到地心距离 / 地球半径，地表≈1.0、太空视角>1。
  float camMag = length(czm_viewerPositionWC) / 6.4e6;
  out_FragColor = vec4(0.5, camMag, d, 1.0);       // att0: R=执行标记 G=czm量级 B=depth
  out_DepthVelocity = vec4(d, 0.0, 0.0, 1.0);      // att1: R=depth（MRT 第 2 out 验证）
  out_ShadowLength = vec4(0.3, 0.0, 0.0, 1.0);     // att2: R=0.3 固定（MRT 第 3 out 验证）
}
`

// overlay shader —— 读云 MRT att + atmosphere colorTexture 半透明叠加（验「云输出能被后续 PostProcess 消费」）。
// colorTexture 由 Cesium PostProcessStage 自动提供值（声明由 shader 负责，与 historyBlit.ts 同；
// 见 CLAUDE.md「PostProcessStage 内建纹理 uniform 必须由 shader 显式声明」）。
// out_FragColor 未声明 → Cesium 自动注入 layout(location=0) out（单输出，无需 MRT）。
const OVERLAY_SHADER = `uniform sampler2D colorTexture;
uniform sampler2D u_cloudTex;
uniform float u_cloudAlpha;
in vec2 v_textureCoordinates;
void main() {
  vec4 scene = texture(colorTexture, v_textureCoordinates);
  vec4 cloud = texture(u_cloudTex, v_textureCoordinates);
  // 半透明叠加（<1.0 保 globe 透过，验「不遮 globe」）。
  out_FragColor = mix(scene, cloud, u_cloudAlpha);
}
`

// MRT attachment 采样器：NEAREST（像素对齐，与 depthTexture 1:1，不插值）+ CLAMP_TO_EDGE。
// 与 historyBlit.ts HISTORY_SAMPLER 同（depth 像素对齐场景）。
const SPIKE_SAMPLER = new Sampler({
  minificationFilter: TextureMinificationFilter.NEAREST,
  magnificationFilter: TextureMagnificationFilter.NEAREST,
  wrapS: TextureWrap.CLAMP_TO_EDGE,
  wrapT: TextureWrap.CLAMP_TO_EDGE,
})

/** 自定义 primitive：update 压 cmd 到 frameState.commandList，Cesium 按 pass 调度执行。
 *  须实现 Cesium Destroyable 三件套（update / isDestroyed / destroy）——PrimitiveCollection.add
 *  会调 primitive.isDestroyed 检查存活（Scene.js:4134 createPrimitiveEventListener）。 */
export interface CloudProbePrimitive {
  update(frameState: unknown): void
  isDestroyed(): boolean
  destroy(): void
}

/** spike 句柄：持 primitive + overlay stage 引用，便于销毁。 */
export interface CloudsSpikeHandle {
  readonly primitive: CloudProbePrimitive
  readonly overlayStage: PostProcessStage
  /** 释放所有 GL 资源（MRT FBO + 3 texture）并从 scene 摘除 primitive + overlay。幂等。 */
  destroy(): void
}

// bridge（Cesium createUniform.js 读 _target/_texture，把 Cesium.Texture 包成 raw GL sampler 兼容对象）。
// 与 historyBlit.ts getHistoryBridge 同模式（:80），供 overlay PostProcessStage uniform 注入。
function textureBridge(tex: Texture): { _texture: unknown; _target: number } {
  const internal = tex as unknown as { _texture: unknown; _target: number }
  return { _texture: internal._texture, _target: internal._target }
}

/**
 * 创建 spike probe。
 *
 * @param scene Cesium scene（atmosphere mode 下，atmosphere stage 已接线后调用）。
 * @param attIndex overlay 读哪个 MRT attachment：1=att0(color) / 2=att1(depthVel) / 3=att2(shadowLen)。
 *                 对应 URL ?cloudsSpike=1/2/3。越界自动 clamp 到 [1,3]。
 */
export function createCloudsSpike(scene: Scene, attIndex: number): CloudsSpikeHandle {
  const idx = Math.min(Math.max(attIndex, 1), 3) - 1 // 0..2
  const context = (scene as unknown as { context: SpikeContext }).context

  // MRT 尺寸：drawingBuffer（spike 不处理 resize——resize 后 RT 尺寸不匹配会导致 overlay 采样偏移，
  // 验收期间保持窗口尺寸不变即可；正式体积云需 resize 重建 RT）。
  const width = context.drawingBufferWidth || 256
  const height = context.drawingBufferHeight || 256

  // ── 3 张 color attachment（UNSIGNED_BYTE RGBA，spike 足够；正式体积云 depthVelocity/shadowLength
  //    需 HalfFloat 保精度，此处 spike 仅验 MRT 多 out 写入通路，RGBA8 即可）。
  const mkTex = (): Texture =>
    new Texture({
      context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      sampler: SPIKE_SAMPLER,
    })
  const texColor = mkTex() // att0
  const texDepthVel = mkTex() // att1
  const texShadowLen = mkTex() // att2
  const mrtTextures = [texColor, texDepthVel, texShadowLen]

  // ── MRT Framebuffer：3 attachment。destroyAttachments=false（texture 由本模块管理，
  //    FBO.destroy 仅释放 GL framebuffer handle，不连带 destroy texture）。
  const mrtFBO = new Framebuffer({
    context,
    colorTextures: mrtTextures,
    destroyAttachments: false,
  })

  // ── probe DrawCommand：createViewportQuadCommand 自带 viewport quad vertexArray + TRIANGLES +
  //    ShaderProgram.fromCache。pass=VOXELS → globe 后执行；framebuffer=mrtFBO → 写 3 attachment
  //    （Context.js:1412 cmd._framebuffer 优先 passState.framebuffer）。
  //    renderState 不设（默认 depthTest.enabled=false；MRT FBO 无 depth attachment，depthMask 无副作用）。
  //    无 boundingVolume → 永不 cull（Scene.js:2074）。
  //    uniformMap.u_globeDepth 闭包每帧读 scene._view.globeDepth.depthStencilTexture（VOXELS 在 GLOBE
  //    后执行，此时 depthStencilTexture 必已就绪）。
  const probeCmd = context.createViewportQuadCommand(PROBE_SHADER, {
    uniformMap: {
      u_globeDepth: () => {
        const view = (scene as unknown as {
          _view?: { globeDepth?: { depthStencilTexture?: Texture } }
        })._view
        return view?.globeDepth?.depthStencilTexture
      },
    },
    framebuffer: mrtFBO,
    pass: PASS_VOXELS,
  })

  // ── 自定义 primitive：update 压 cmd（PrimitiveCollection.update 遍历 primitives[i].update(frameState)，
  //    CloudCollection.js:761 frameState.commandList.push 同模式）。destroy 幂等（防 destroyPrimitives
  //    设置下 PrimitiveCollection.remove 内部调 destroy + 本句柄 destroy 双调）。
  let destroyed = false
  const primitive: CloudProbePrimitive = {
    update(frameState: unknown): void {
      ;(frameState as { commandList: { push: (cmd: DrawCommand) => void } }).commandList.push(
        probeCmd,
      )
    },
    // isDestroyed：Cesium Destroyable 接口要求（PrimitiveCollection.add → Scene.js:4134
    // createPrimitiveEventListener 调 primitive.isDestroyed）。缺它 → "primitive.isDestroyed is
    // not a function" + 后续渲染 "reading 'id'" 崩（实测 2026-08-13 spike）。
    isDestroyed(): boolean {
      return destroyed
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      mrtFBO.destroy() // destroyAttachments=false → 仅释放 GL framebuffer handle
      texColor.destroy()
      texDepthVel.destroy()
      texShadowLen.destroy()
    },
  }
  // scene.primitives.add 期望 Primitive 类型；plain object cast（add 内部仅设 _external + push）。
  const primitives = scene.primitives as unknown as {
    add: (p: CloudProbePrimitive) => void
    remove: (p: CloudProbePrimitive) => boolean
  }
  primitives.add(primitive)

  // ── overlay PostProcessStage：读选中 att 的 bridge + atmosphere colorTexture 半透明叠加。
  //    加到 scene.postProcessStages 末尾（atmosphere composite 之后）→ colorTexture = atmosphere 输出。
  //    u_cloudTex 返 bridge（与 AtmosphereStage.ts:468 u_historyTexture 同模式）。
  const bridges = mrtTextures.map(textureBridge)
  const overlayStage = new PostProcessStage({
    name: 'clouds_spike_overlay',
    fragmentShader: OVERLAY_SHADER,
    uniforms: {
      u_cloudTex: () => bridges[idx],
      u_cloudAlpha: 0.7, // <1.0 保半透明（验「不遮 globe」）
    },
  })
  scene.postProcessStages.add(overlayStage)

  return {
    primitive,
    overlayStage,
    destroy(): void {
      // primitive：摘除（destroyPrimitives=true 时 remove 内部已 destroy，primitive.destroy 幂等兜底）
      primitives.remove(primitive)
      primitive.destroy()
      // overlay：PostProcessStageCollection.remove 成功则内部已 destroy，失败则手动 destroy
      if (!scene.postProcessStages.remove(overlayStage)) {
        overlayStage.destroy()
      }
    },
  }
}
