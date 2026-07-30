// sRGB ↔ 线性色彩空间闭环（简化伽马 2.2，与 three.js 后处理惯例一致）。
//
// 大气散射计算必须在线性空间进行：
//   输入纹理（sRGB）→ sRGBToLinear → 散射/合成 → linearToSRGB → 输出到屏幕。
// 若缺任一环节，画面会整体偏亮或偏暗（伽马错位）。

// GLSL：sRGB 与线性色彩空间互转。
export const COLOR_SPACE_GLSL = `
// sRGB 纹理值 → 线性（反伽马 2.2）
vec3 sRGBToLinear(const vec3 c) {
  return pow(c, vec3(2.2));
}

// 线性值 → sRGB（伽马 1/2.2）
vec3 linearToSRGB(const vec3 c) {
  return pow(c, vec3(1.0 / 2.2));
}
`

// CPU 纯函数（单测用），与 GLSL sRGBToLinear 同式：pow(x, 2.2)。
export function srgbToLinear(x: number): number {
  return Math.pow(x, 2.2)
}

// CPU 纯函数（单测用），与 GLSL linearToSRGB 同式：pow(x, 1/2.2)。
export function linearToSrgb(x: number): number {
  return Math.pow(x, 1 / 2.2)
}
