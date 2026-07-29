import { PostProcessStage } from 'cesium'
import { buildDepthDebugFragmentShader } from './depthDebugStage.frag'

export function createDepthDebugStage(): PostProcessStage {
  return new PostProcessStage({
    fragmentShader: buildDepthDebugFragmentShader()
    // depthTexture / colorTexture 由 Cesium 自动提供（shader 声明了即自动绑定）
  })
}
