import { Texture, PixelFormat, PixelDatatype, type Context } from 'cesium'

// 2D LUT（transmittance 256x64, irradiance 64x16）—— RGBA half-float 源 → Float32，
// 用 Cesium Texture（仅支持 2D）。flipY=false（数据按行，不翻转）。
// 默认 sampler 即 CLAMP_TO_EDGE + LINEAR，满足 LUT 采样。
export function createLUT2D(
  context: Context,
  data: Float32Array,
  width: number,
  height: number
): Texture {
  return new Texture({
    context,
    source: { width, height, arrayBufferView: data },
    pixelFormat: PixelFormat.RGBA,
    pixelDatatype: PixelDatatype.FLOAT,
    flipY: false
  })
}

// 3D LUT（scattering 256x128x32）—— Cesium 无 3D 纹理封装，回退裸 gl.texImage3D。
// Context._gl 是私有（Cesium 无公开 getter），这是 R7 验证点；返回裸 WebGLTexture，
// 在 stage 的 uniformMap 里手动绑定（T5 验证 sampler3D 绑定可行性）。
export function createLUT3D(
  context: Context,
  data: Float32Array,
  width: number,
  height: number,
  depth: number
): WebGLTexture {
  const gl = (
    context as unknown as { _gl: WebGL2RenderingContext }
  )._gl
  const texture = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, texture)
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA32F,
    width,
    height,
    depth,
    0,
    gl.RGBA,
    gl.FLOAT,
    data
  )
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_3D, null)
  return texture
}
