// AtmosphereStage 内三处 1×1 惰性 dummy 纹理的构造与销毁归属（产品化设计 2026-10-27 §8.5）。
//
// 背景：这三张 dummy 原是 AtmosphereStage.ts 内联的惰性构造（首次 uniform 闭包求值时创建），
// 没有销毁路径——install 反复创建/销毁会泄漏 GPU 纹理（每张虽小，但生命周期包在 stage 里）。
// 抽到本模块后：
// 1. 构造集中于此（全仓库唯一 new Texture/Texture3D 的 dummy 位置），AtmosphereStage 只持句柄；
// 2. 句柄带 destroy()，AtmosphereStage 在 handle.destroy() 与 setMode 重建时释放；
// 3. 测试可用本地模块 mock 隔离——Node 无 WebGL，真实构造会因 maximumTextureSize=0 抛
//    DeveloperError（见 AtmosphereStage.insert.test.ts:31）。
import {
  PixelDatatype,
  PixelFormat,
  Sampler,
  Texture,
  Texture3D,
  TextureWrap,
  type Context
} from 'cesium'

/** dummy 句柄：texture 供 uniform 闭包返回，destroy 幂等（Cesium destroyObject 后重复 destroy 会抛）。 */
export interface DummyTextureHandle<T extends Texture | Texture3D> {
  readonly texture: T
  destroy(): void
}

function makeHandle<T extends Texture | Texture3D>(texture: T): DummyTextureHandle<T> {
  return {
    texture,
    destroy() {
      // 幂等：destroyObject 会把方法替换成 throwOnDestroyed，重复调用会抛「This object was destroyed」
      if (texture.isDestroyed()) return
      texture.destroy()
    }
  }
}

/**
 * 云影 shadowLength 的 1×1 黑 dummy（RGBA=(0,0,0,255)）：桥未就绪帧采样得 0 = 无影，
 * 与不 define CLOUDS_SHADOW_LENGTH 的零回归语义一致。
 */
export function createCloudsShadowDummy(context: Context): DummyTextureHandle<Texture> {
  return makeHandle(
    new Texture({
      context,
      source: { width: 1, height: 1, arrayBufferView: new Uint8Array([0, 0, 0, 255]) },
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE
    })
  )
}

/**
 * 地面云影 BSM 的 1×1×1 全 0 dummy：intervals (0,0) 区间测试恒假 → 级联 -1；
 * cascadeCount=0 → 循环不执行（spec §5/§8.1 空槽约定）。
 */
export function createGroundShadowDummy(context: Context): DummyTextureHandle<Texture3D> {
  return makeHandle(
    new Texture3D({
      context,
      source: {
        width: 1,
        height: 1,
        depth: 1,
        arrayBufferView: new Uint8Array(4) // 全 0
      },
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      flipY: false
    })
  )
}

/**
 * 月面 albedo 白 dummy（RGBA=(255,255,255,255)）：moonSurfaceTexture 未传时的零回归路径
 * （均匀月面 = 数值等价无纹理版）。
 */
export function createMoonSurfaceDummy(context: Context): DummyTextureHandle<Texture> {
  return makeHandle(
    new Texture({
      context,
      source: { width: 1, height: 1, arrayBufferView: new Uint8Array([255, 255, 255, 255]) },
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      sampler: new Sampler({ wrapS: TextureWrap.CLAMP_TO_EDGE, wrapT: TextureWrap.CLAMP_TO_EDGE })
    })
  )
}
