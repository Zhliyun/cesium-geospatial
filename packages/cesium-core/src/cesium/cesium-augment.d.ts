// cesium 公开 .d.ts 未声明 Texture3D / Context / Texture（内部 Renderer 类），
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

  export class Texture {
    constructor(options: {
      context: Context
      source: { width: number; height: number; arrayBufferView: ArrayBufferView }
      pixelFormat?: number
      pixelDatatype?: number
      flipY?: boolean
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface Context {}
}
