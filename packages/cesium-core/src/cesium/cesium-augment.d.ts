// cesium 公开 .d.ts 未声明 Texture3D / Context / Texture / Sampler / TextureWrap（内部 Renderer 类），
// 但运行时从 'cesium' 可导入（Cesium.js re-export @cesium/engine）。补充最小类型。
declare module 'cesium' {
  export class Texture3D {
    constructor(options: {
      context: Context
      source?: {
        width: number
        height: number
        depth: number
        arrayBufferView: ArrayBufferView
      }
      pixelFormat?: number
      pixelDatatype?: number
      flipY?: boolean
    })
  }

  // Texture 构造支持两种变体：
  //   1) 数据纹理：source: { width, height, arrayBufferView }（LUT 路径）
  //   2) 空纹理（RT 目标）：width/height + sampler（history ping-pong 路径）
  export class Texture {
    constructor(options: {
      context: Context
      source?: {
        width: number
        height: number
        arrayBufferView: ArrayBufferView
      }
      width?: number
      height?: number
      pixelFormat?: number
      pixelDatatype?: number
      sampler?: Sampler
      flipY?: boolean
    })
    width: number
    height: number
    destroy(): void
  }

  // Sampler（@cesium/engine Renderer 内部类，Cesium.js re-export，公开 .d.ts 缺失）。
  // Texture 构造的 sampler 形参需 Sampler 实例（见 cesium-clouds-atmosphere/CloudShadowPass.js）。
  export class Sampler {
    constructor(options?: {
      wrapS?: TextureWrap
      wrapT?: TextureWrap
      minificationFilter?: TextureMinificationFilter
      magnificationFilter?: TextureMagnificationFilter
      maximumAnisotropy?: number
    })
  }

  // TextureWrap（@cesium/engine 冻结对象，值同 WebGLConstants）。
  export enum TextureWrap {
    CLAMP_TO_EDGE = 33071,
    REPEAT = 10497,
    MIRRORED_REPEAT = 33648,
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface Context {}

  // DrawCommand（@cesium/engine Renderer 内部类，公开 .d.ts 缺失）。
  // createViewportQuadCommand 返回此类型；depthTemporal blit / Task 8 lifecycle 用。
  // 字段对应 DrawCommand 构造 opts + execute(context, options)。
  export interface DrawCommand {
    vertexArray?: unknown
    primitiveType?: number
    renderState?: unknown
    shaderProgram?: unknown
    uniformMap?: { [uniformName: string]: () => unknown }
    framebuffer?: unknown
    pass?: number
    owner?: unknown
    execute(context: Context, options?: { framebuffer?: unknown }): void
  }

  // PostProcessStage.outputTexture getter（私有，PostProcessStage.js:346-356，可返 undefined）。
  // depthTemporal history blit 用（Task 7/8 读 depthTemporal stage 输出纹理）。
  // declaration merging：augment 公开 PostProcessStage 类，补 outputTexture 成员类型。
  export interface PostProcessStage {
    readonly outputTexture: Texture | undefined
  }
}
