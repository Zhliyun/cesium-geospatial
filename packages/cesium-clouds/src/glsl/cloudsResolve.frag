precision highp float;
precision highp sampler2DArray;

// 【Cesium 适配扩展（涂抹修复 T1，2026-09-02）】upscale 分母缺省 1（2026-09-02 用户定稿
// 全分 TAA 档为默认；1=全分走 TAA 分支，2/4=低分 upscale）——运行时由
// buildCloudsResolveFragmentShader defines 恒注入；此缺省保 raw source 独立编译
// 可过（GLSL ES：未定义宏参与 #if 表达式是编译错）。
#ifndef UPSCALE_DIVISOR
#define UPSCALE_DIVISOR 1
#endif // UPSCALE_DIVISOR

#include "core/turbo"
#include "catmullRomSampling"
#include "varianceClipping"

uniform sampler2D colorBuffer;
uniform sampler2D depthVelocityBuffer;
uniform sampler2D colorHistoryBuffer;

#ifdef SHADOW_LENGTH
uniform sampler2D shadowLengthBuffer;
uniform sampler2D shadowLengthHistoryBuffer;
#endif // SHADOW_LENGTH

uniform vec2 texelSize;
uniform int frame;
uniform float varianceGamma;
uniform float temporalAlpha;
uniform float temporalDisocclusion;
uniform vec2 jitterOffset;
// 【v35 静止重投影禁用】静止帧（相机无位移/转向）时 0 → velocity 归零。根因（2026-10-10
// v28-v34 探针链）：jitter 16 相位轮换使「同一像素相邻帧的 ray」指向不同亚像素位置，
// 而 history 每像素存的是各相位混合的时域值——重投影无法正确采样（prevUv 每帧随机偏移
// ±2px）→ 云高频结构被采成自激噪声（实测：完全禁用后帧间差分 57.9%→0.003%；保留
// 任何 velocity 补偿（含 jitter 注入移除/小速度归零）仍 ≥27%）。运动中 1=正常重投影
//（世界点位移真实存在，禁用会拖影）。
uniform float u_reprojectionStrength;
// 【2026-10-08 白点治理】输出端孤点中值滤波强度（0=关缺省零回归；1=全替换）。
// 白点=march 能量积分采样方差的 1px 亮度尖峰（伴生暗斑族对称），时序平均
// （frameUnfreeze）消掉 ~95% 后的残余为每帧随机注入的稳态——邻域中值直接替换。
uniform float u_spatialDespeckle;
// 【v49 调查用调试】0=关（缺省零回归）；1=直显 march 原始输出（current，低分块拷贝）——
// 用于隔离「march 侧 current 抖动」与「resolve 侧放大」（demo `?cloudsResolveDebug=1`）。
uniform float u_resolveDebug;

in vec2 vUv;

layout(location = 0) out vec4 outputColor;
#ifdef SHADOW_LENGTH
layout(location = 1) out float outputShadowLength;
#endif // SHADOW_LENGTH

const ivec2 neighborOffsets[9] = ivec2[9](
  ivec2(-1, -1),
  ivec2(-1, 0),
  ivec2(-1, 1),
  ivec2(0, -1),
  ivec2(0, 0),
  ivec2(0, 1),
  ivec2(1, -1),
  ivec2(1, 0),
  ivec2(1, 1)
);

const ivec4[4] bayerIndices = ivec4[4](
  ivec4(0, 12, 3, 15),
  ivec4(8, 4, 11, 7),
  ivec4(2, 14, 1, 13),
  ivec4(10, 6, 9, 5)
);

// 【Cesium 适配扩展（涂抹修复 T1，2026-09-02）】UPSCALE_DIVISOR=2：半分 march（RT 面积 ×4，
// 细节上限 4px→2px 像素周期）下直通块从 4×4 变 2×2——16 相位 4×4 表不适用，改 2×2 Bayer
// 4 相位表 + frame%4 直通（每像素每 4 帧直通一次，逐轮消费 march 端 16 相位 jitter 的不同
// 真值）。N=4 路径（#else）保持 three 原文逐字，便于上游 diff。
#if UPSCALE_DIVISOR == 2
const int bayerIndices2[4] = int[4](0, 2, 3, 1);
#endif // UPSCALE_DIVISOR == 2

// 【v56-v63 黑块消毒实验收口——全部回退】六轮判据（绝对阈值 0.002/0.012、alpha 门槛
// 0.3/0.05、bilinear 样本剔除、输出端 5×5 拦截、洞检测、相对判据 lc<0.5×邻域均值）
// 实测黑块恒为 0.42-0.49%（vs N=1 基准 0.101%）——**值判据路线整体不可行**：黑块不是
// 「值异常」而是「尺寸放大」（N=4 把 march 的 1px 采样噪声放大为 8×8），与正常暗云在
// resolve 可见的数据上不可区分。机制结论与后续方向见 spec。

// 【2026-09-04 coverage=1 云甲内运动全黑修复：getHistoryNanGuard】history 采样含 NaN 时
// 以 current 替换。GLSL mix 为 IEEE 融合乘加——NaN·(1-α) 任意 α 均传播，NaN 一旦写入
// history 即 ping-pong 永久自持（δa rejection 的比较恒 false 拦不住、α=1 直混也无法
// 消除、刷新才清）。运动中大视差（近云深度 texel 数米位移→百 texel 级重投影）易采到
// 坏值区，故在采样后立即消毒。
vec4 sanitizeHistory(const vec4 sampled, const vec4 current) {
  if (any(isnan(sampled))) {
    return current;
  }
  return sampled;
}

vec4 getClosestFragment(const ivec2 coord) {
  // 【2026-09-03 夜间云内移动黑块修复：getClosestFragmentNoCloudGuard】云甲内视角下
  // depthVelocity.r 在「有云 texel（云距）/无云 texel（cameraFar≈1e10）」间逐像素跳变。
  // 3×3 全局最近深度会让无云 texel 借到别处云的 velocity → history 重投影错位 → 云的
  // a/rgb 拖尾成层叠鬼影（暗色块；移动时持续供错、刷新才清；夜晚 761m 复现组实证）。
  // 修=中心 texel 自身 depth 为远平面级（无样本=无云）时直接退回自身 velocity——
  // 自身即 no-hit 分支的 view-space 自洽重投影，语义最准。有云 texel 保持上游
  // closest-neighbor 行为（边缘稳定性）不变。
  vec4 centerDepthVelocity = texelFetch(depthVelocityBuffer, coord, 0);
  if (centerDepthVelocity.r >= 1e8) {
    return centerDepthVelocity;
  }
  // 【2026-09-03 coverage=1 云甲内盐粒修复：getClosestFragmentDepthHomogeneityGuard】
  // 甲内水平视角下 depthVelocity.r 在「近云数米 ↔ 甲顶球远端数百 km」间逐像素跳变
  // （合法几何值，非远平面哨兵——上述 1e8 守卫不覆盖）。全局最近深度让远端 texel 借到
  // 近云 velocity（反向错借同样存在）→ history 大距离错位；coverage=1 全屏 a≈1 →
  // |Δa| rejection 永不触发 → 满屏盐粒（temporal=0 直通同一 march buffer 平滑、
  // upscale=4 分支低分聚合深度平滑——层锁定全分 TAA 借用）。修=邻居与中心深度比
  // 超 2×（更深或更浅）视为跨层 texel 不参与 min 竞争；无同质邻居退回自身 velocity。
  // closest 边缘语义保留（同质域内仍取最近）。
  float centerDepth = centerDepthVelocity.r;
  vec4 result = centerDepthVelocity; // 缺省=自身（无同质邻居时退自身自洽重投影）
  vec4 neighbor;
  #pragma unroll_loop_start
  for (int i = 0; i < 9; ++i) {
    neighbor = texelFetchOffset(depthVelocityBuffer, coord, 0, neighborOffsets[i]);
    // 深度悬殊（>2× 或 <0.5×）= 跨层 texel，velocity 不可借。同质条件并入 min 竞争
    //（unroll 展开后无循环上下文，不能用 continue——glslang 'continue statement
    // only allowed in loops'）。
    // ⚠️【2026-10-10 候选修正未采纳】下界条件的「正确」写法
    //（`neighbor.r >= centerDepth * 0.5`）在一次跨时段截图对比中与静止画面劣化相关，
    // 但该对比受场景加载状态污染（两批次云分布明显不同；项目铁律：跨时段截图不可比），
    // 证据不足以确立因果。保持恒 false 现状（等价恒退自身 velocity，长期实测行为）；
    // 守卫启用需同批成对 A/B（相机/天气锁定同一次运行）后另议。
    if (neighbor.r <= centerDepth * 2.0 && centerDepth * 2.0 <= neighbor.r && neighbor.r < result.r) {
      result = neighbor;
    }
  }
  #pragma unroll_loop_end
  return result;
}

void temporalUpscale(
  const ivec2 coord,
  const ivec2 lowResCoord,
  const bool currentFrame,
  out vec4 outputColor,
  out float outputShadowLength
) {
  // 【v56 黑 texel 消毒】march 输出的「不透明黑 texel」（rgb≈0 且 a 显著 = 黑楔类数值伪影；
  // overlay 的 NaN 消毒只拦 NaN/负值，不拦合法的 0）在冻结后经 bilinear 扩散为 8×8 黑块。
  // despeckle 失效：其参照（低分邻域均值）取自 march 自身 → 黑 texel 把参照也拉黑 → 不判异常。
  // 修法：bilinear 的 4 样本先剔除黑样本（不透明+极暗），用剩余样本加权插值；全黑则保持。
  vec2 mrtSz2 = vec2(textureSize(colorBuffer, 0));
  vec2 uvLow = vUv * mrtSz2 - 0.5;
  vec2 fl = floor(uvLow);
  vec2 fr = uvLow - fl;
  ivec2 i00 = clamp(ivec2(fl), ivec2(0), ivec2(mrtSz2) - 1);
  ivec2 i10 = clamp(i00 + ivec2(1, 0), ivec2(0), ivec2(mrtSz2) - 1);
  ivec2 i01 = clamp(i00 + ivec2(0, 1), ivec2(0), ivec2(mrtSz2) - 1);
  ivec2 i11 = clamp(i00 + ivec2(1, 1), ivec2(0), ivec2(mrtSz2) - 1);
  vec4 s00 = texelFetch(colorBuffer, i00, 0);
  vec4 s10 = texelFetch(colorBuffer, i10, 0);
  vec4 s01 = texelFetch(colorBuffer, i01, 0);
  vec4 s11 = texelFetch(colorBuffer, i11, 0);
  float w00 = (1.0 - fr.x) * (1.0 - fr.y);
  float w10 = fr.x * (1.0 - fr.y);
  float w01 = (1.0 - fr.x) * fr.y;
  float w11 = fr.x * fr.y;
  // 黑样本剔除（线性域极暗 + 不透明）
  bool b00 = dot(s00.rgb, vec3(0.299, 0.587, 0.114)) < 0.012 && s00.a > 0.05;
  bool b10 = dot(s10.rgb, vec3(0.299, 0.587, 0.114)) < 0.012 && s10.a > 0.05;
  bool b01 = dot(s01.rgb, vec3(0.299, 0.587, 0.114)) < 0.012 && s01.a > 0.05;
  bool b11 = dot(s11.rgb, vec3(0.299, 0.587, 0.114)) < 0.012 && s11.a > 0.05;
  float wsum = (b00 ? 0.0 : w00) + (b10 ? 0.0 : w10) + (b01 ? 0.0 : w01) + (b11 ? 0.0 : w11);
  vec4 currentColor;
  if (wsum > 1e-4) {
    currentColor = (s00 * (b00 ? 0.0 : w00) + s10 * (b10 ? 0.0 : w10)
      + s01 * (b01 ? 0.0 : w01) + s11 * (b11 ? 0.0 : w11)) / wsum;
  } else {
    currentColor = mix(mix(s00, s10, fr.x), mix(s01, s11, fr.x), fr.y); // 全黑：保持原样
  }
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, lowResCoord, 0).rgb, 1.0);
  #endif // SHADOW_LENGTH

  if (currentFrame) {
    // Use the texel just rendered without any accumulation.
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return;
  }

  vec4 depthVelocity = getClosestFragment(lowResCoord);
  // 【v35 静止重投影禁用】见 u_reprojectionStrength 声明处注释（探针链 v28-v43 结论）。
  vec2 velocity = depthVelocity.gb * u_reprojectionStrength;
  vec2 prevUv = vUv - velocity;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Rejection
  }

  // Variance clipping with a large variance gamma seems to work fine for
  // upsampling. This increases ghosting, of course, but it's hard to notice on
  // clouds.
  // vec4 historyColor = textureCatmullRom(colorHistoryBuffer, prevUv);
  vec4 historyColor = sanitizeHistory(texture(colorHistoryBuffer, prevUv), currentColor); // getHistoryNanGuard
  // 【2026-09-02 云地平线黑块修复（disocclusion rejection）】四组俯冲 A/B 定位黑块源=
  // resolve history 混合（temporal=0 / α=1 / γ=0.5 / α=0.5 全零黑块，默认参数必现）。
  // 云海地平线深度不连续处：低分 march 读 depth 带 temporalJitter，相位轮换使部分帧被
  // 地形深度切空（color=vec4(0)）写入 history；运动中 getClosestFragment 3×3 最近深度
  // 取 velocity 跨界污染 → prevUv 错位 → history 采到云/非云交界无效 texel → γ=2 宽
  // AABB（邻域亮云/透明混布方差大）剪不住 → mix(clip(history), current, 0.1) 以 90%
  // history 权重输出暗块；1/16 currentFrame 直通 texel 露出真值 = 黑块内规则白点阵
  // （用户截图同形态）。修法=TAA disocclusion 检测：current/history 云 alpha 差异超阈 =
  // 遮挡关系翻转，不信任 history 直出 current（同 prevUv 越界 rejection 路径）。阈值
  // 默认 0.5：跨云边界错采 |Δa|=1（0↔1）稳触发；云边缘正常相位噪声 |Δa|<0.3 不误杀
  // （误杀代价仅该 texel 一帧直出=可接受）。
  // 【2026-10-12 v44 rejection 退役】原判据 |Δa|>temporalDisocclusion 在 jitter 相位轮换下
  // 云缘恒成立（那不是「遮挡翻转」，而是亚像素抖动的正常表现）→ 直出 current（跟随 march
  // 抖动；运动时尤为明显——用户 2026-10-12 真机报告「拖动相机时类似抖动」）。其原修的两个
  // 黑块 bug（2026-09-02 云地平线 / 2026-09-03 穿云）根因均为 velocity 错位 → history 采到
  // 死值——该错位已由 v44 重投影修复消除（jitter 双重注入移除 + 上帧 jitter 补偿）。
  // 上游 resolve 本就无 rejection。条件恒 false 保留分支体便于故障回退（GLSL 裁剪死代码）。
  if (false && abs(currentColor.a - historyColor.a) > temporalDisocclusion) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Disocclusion rejection
  }
  // 【v54 冻结跳过 AABB】v53 实测：clip 的邻域（低分 texel）不抹块（blockSignal 反而 1.093）
  // 且引入 8.9% 抖动 —— 回退到 v52 的「冻结自持」（0.03% 抖动）。块由空域上采样滤波解决
  //（见 currentColor 的 4 邻域平均——那才是块边界的正解）。
  vec4 clippedColor = temporalAlpha < 1e-5
    ? historyColor
    : varianceClipping(colorBuffer, vUv, currentColor, historyColor, varianceGamma);
  // 【2026-09-02 静止收敛抖动修复】three 原文 outputColor = clippedColor 直出——variance
  // clip 的 AABB 逐帧随 current(Bayer ±2px 轮换采样)移动,history 被 clip 拉向本帧
  // current → 输出跟随 current 轮换不收敛。高对比云区(近云视角)显示层持续抖动
  // (连拍 20-40% 像素逐帧变化;低对比远景/three storybook 场景不可见——分辨率×对比度
  // 放大,机制 three 同款)。修法=TAA 标准混合:输出 = mix(clip(history), current, α)
  // ——Bayer 轮换分量指数衰减(α=0.1 → 16 相位残留 0.9^16≈18%),fresh 直出帧保持
  // 超采样语义不变。
  outputColor = mix(clippedColor, currentColor, temporalAlpha);
  // 【outputColorSanityGuard】NaN 兜底：任何上游残留 NaN（含 mix 的 IEEE 传播）直出 current。
  if (any(isnan(outputColor.rgb))) {
    outputColor = currentColor;
  }

  #ifdef SHADOW_LENGTH
  // Sampling the shadow length history using scene depth doesn't make much
  // sense, but it's too hard to derive it properly. At least this approach
  // resolves the edges of scene objects.
  // vec4 historyShadowLength = vec4(textureCatmullRom(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  vec4 clippedShadowLength = varianceClipping(
    shadowLengthBuffer,
    vUv,
    currentShadowLength,
    historyShadowLength,
    varianceGamma
  );
  outputShadowLength = clippedShadowLength.r;
  #endif // SHADOW_LENGTH
}

void temporalAntialiasing(const ivec2 coord, out vec4 outputColor, out float outputShadowLength) {
  vec4 currentColor = texelFetch(colorBuffer, coord, 0);
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, coord, 0).rgb, 1.0);
  #endif // SHADOW_LENGTH

  vec4 depthVelocity = getClosestFragment(coord);
  // 【v35 静止重投影禁用】同 upscale 分支（depthVelocity.r 深度不受影响——aEff 按距离衰减保留）。
  vec2 velocity = depthVelocity.gb * u_reprojectionStrength;

  vec2 prevUv = vUv - velocity;
  if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Rejection
  }

  vec4 historyColor = sanitizeHistory(texture(colorHistoryBuffer, prevUv), currentColor); // getHistoryNanGuard
  // 【2026-09-03 穿云黑块修复】disocclusion rejection——312573d 只加在 temporalUpscale 分支
  // （N=4 时代默认档），1ce0d93 默认档切 N=1 走本分支后补丁丢失：穿云 velocity 跨层错位 →
  // history 采到无效 texel（黑）→ γ=2 宽 AABB 剪不住 → mix 90% 黑 history 固化扩散（傍晚
  // 穿云黑块 A/B 复现实证）。|Δa|>阈 = 云/非云遮挡关系翻转，不信任 history 直出 current。
  // 【2026-10-12 v44 rejection 退役】原判据 |Δa|>temporalDisocclusion 在 jitter 相位轮换下
  // 云缘恒成立（那不是「遮挡翻转」，而是亚像素抖动的正常表现）→ 直出 current（跟随 march
  // 抖动；运动时尤为明显——用户 2026-10-12 真机报告「拖动相机时类似抖动」）。其原修的两个
  // 黑块 bug（2026-09-02 云地平线 / 2026-09-03 穿云）根因均为 velocity 错位 → history 采到
  // 死值——该错位已由 v44 重投影修复消除（jitter 双重注入移除 + 上帧 jitter 补偿）。
  // 上游 resolve 本就无 rejection。条件恒 false 保留分支体便于故障回退（GLSL 裁剪死代码）。
  if (false && abs(currentColor.a - historyColor.a) > temporalDisocclusion) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Disocclusion rejection
  }
  // 【v54】同 upscale 分支：冻结跳过 clip（块由空域上采样滤波解决）。
  vec4 clippedColor = temporalAlpha < 1e-5
    ? historyColor
    : varianceClipping(colorBuffer, coord, currentColor, historyColor);
  // 【2026-10-09 远云平均自适应】α 按云前距离衰减：远云视差小（屏幕近乎静止，可狠平均）
  // 且欠采样噪声幅度大（需要狠平均）——双契合。50km→α/2 起步（2e-5/米）。
  float aEff = temporalAlpha / (1.0 + max(0.0, depthVelocity.r) * 2e-5);
  outputColor = mix(clippedColor, currentColor, aEff);
  // 【outputColorSanityGuard】NaN 兜底：任何上游残留 NaN（含 mix 的 IEEE 传播）直出 current。
  if (any(isnan(outputColor.rgb))) {
    outputColor = currentColor;
  }

  #ifdef SHADOW_LENGTH
  vec4 historyShadowLength = vec4(texture(shadowLengthHistoryBuffer, prevUv).rgb, 1.0);
  vec4 clippedShadowLength = varianceClipping(
    shadowLengthBuffer,
    coord,
    currentShadowLength,
    historyShadowLength
  );
  outputShadowLength = mix(clippedShadowLength.r, currentShadowLength.r, temporalAlpha);
  #endif // SHADOW_LENGTH
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);

  #if !defined(SHADOW_LENGTH)
  float outputShadowLength;
  #endif // !defined(SHADOW_LENGTH)

  #ifdef TEMPORAL_UPSCALE
  #if UPSCALE_DIVISOR == 2
  ivec2 lowResCoord = coord / 2;
  int bayerValue = bayerIndices2[(coord.y % 2) * 2 + (coord.x % 2)];
  bool currentFrame = bayerValue == frame % 4;
  #else // UPSCALE_DIVISOR == 2
  ivec2 lowResCoord = coord / 4;
  // 【v48 实验回退】1/64 低密度直通（bayer8x8）实测：抖动 19%→12%（非线性），且细节刷新
  // 变慢 → 画面块状/更糊（用户核心诉求是「不糊」）→ 回退上游 4×4/16 相位语义。
  int bayerValue = bayerIndices[coord.x % 4][coord.y % 4];
  bool currentFrame = bayerValue == frame % 16;
  #endif // UPSCALE_DIVISOR == 2
  // 【v52 冻结禁直通（二回）】v47 曾恢复直通（治「模糊」）——但当时的「模糊」根因是**预热期
  // EMA 平均**（history 被 α=0.1 累积低通），而非禁直通本身。预热已于 v47 移除 → 冻结时
  // history = 加载后最初的 march 原始输出（未平均，锐利）；此时禁直通 = 零 current 注入
  // （0% 抖动）且不失锐利。重测此组合（v45 的结论受预热污染）。
  if (temporalAlpha < 1e-5) currentFrame = false;
  temporalUpscale(coord, lowResCoord, currentFrame, outputColor, outputShadowLength);
  #else // TEMPORAL_UPSCALE
  temporalAntialiasing(coord, outputColor, outputShadowLength);
  #endif // TEMPORAL_UPSCALE

  // 【2026-10-08 白点治理】孤点中值替换（u_spatialDespeckle>0 才走，全屏一致分支）：
  // 当前像素 luma 与邻域中值差超阈（0.1 线性域）= 孤立亮/暗点 → 中值替换。
  // 【5×5 窗】云缘颗粒带密度高（>44%），3×3 中值（抗 44%）失效——5×5 中值抗 ~52%
  // 且窗更大覆盖 2px 簇；25 texelFetch+插入排序成本 ~1ms/1080p（resolve 全屏 pass）。
  if (u_spatialDespeckle > 0.0) {
    // 【2026-10-10 低分 march 域修复】邻域索引必须用 march 域坐标：coord 是 resolve RT
    // 坐标（全分/超分域），colorBuffer 是 march RT（N=2/4 降分时低分）——直接用 coord
    // 在 N>1 时越界 texelFetch（返回 0）→ 半屏黑点 + x=1/divisor 处竖分界
    //（上界外像素邻域全 0 → 均值被拉黑 → 反向替换）。N=1/超分时两域重合，行为不变。
    #ifdef TEMPORAL_UPSCALE
      ivec2 despeckleCoord = lowResCoord;
    #else
      ivec2 despeckleCoord = coord;
    #endif
    float lumas[25];
    float alphas[25];
    vec3 colors[25];
    int k = 0;
    for (int dy = -2; dy <= 2; ++dy) {
      for (int dx = -2; dx <= 2; ++dx) {
        vec4 cn = texelFetch(colorBuffer, despeckleCoord + ivec2(dx, dy), 0);
        colors[k] = cn.rgb;
        alphas[k] = cn.a;
        lumas[k] = dot(colors[k], vec3(0.299, 0.587, 0.114));
        ++k;
      }
    }
    vec3 meanColor = vec3(0.0);
    float meanA = 0.0;
    for (int i = 0; i < 25; ++i) { meanColor += colors[i]; meanA += alphas[i]; }
    meanColor /= 25.0;
    meanA /= 25.0;
    float lumaOut = dot(outputColor.rgb, vec3(0.299, 0.587, 0.114));
    float lumaMean = dot(meanColor, vec3(0.299, 0.587, 0.114));
    // 【2026-10-09 分通道方向性滤波】rgb=对称（亮喷溅+黑点都治——黑点=暗离群，
    // 单侧版实测 5950m 黑点回潮 28.0）；α=单侧只填透明洞——对称 α 替换会在云边界
    // 内侧把高 α 拉向跨边界低均值=云啃成半透明透出暗地形（3021m 层内实测黑方块）。
    // 替换量∝离群幅度（连续化防色带）。
    float lumDiff = lumaOut - lumaMean;
    if (abs(lumDiff) > 0.02) {
      outputColor.rgb = mix(outputColor.rgb, meanColor,
        min(1.0, abs(lumDiff) * 4.0) * u_spatialDespeckle);
    }
    float aDeficit = meanA - outputColor.a;
    if (aDeficit > 0.05) {
      outputColor.a = mix(outputColor.a, meanA,
        min(1.0, aDeficit * 4.0) * u_spatialDespeckle);
    }
  }

  #if defined(SHADOW_LENGTH) && defined(DEBUG_SHOW_SHADOW_LENGTH)
  outputColor = vec4(turbo(outputShadowLength * 0.05), 1.0);
  #endif // defined(SHADOW_LENGTH) && defined(DEBUG_SHOW_SHADOW_LENGTH)

  #ifdef DEBUG_SHOW_VELOCITY
  outputColor.rgb = outputColor.rgb + vec3(abs(texture(depthVelocityBuffer, vUv).gb) * 10.0, 0.0);
  #endif // DEBUG_SHOW_VELOCITY

  // 【v49/v59 调查用调试】1=直显 march 原始输出（点采样）；2=直显其 alpha；3=其 rgb×50
  if (u_resolveDebug > 0.5 && u_resolveDebug < 1.5) {
    #ifdef TEMPORAL_UPSCALE
    outputColor = texelFetch(colorBuffer, lowResCoord, 0);
    #else
    outputColor = texelFetch(colorBuffer, coord, 0);
    #endif // TEMPORAL_UPSCALE
  } else if (u_resolveDebug > 1.5 && u_resolveDebug < 2.5) {
    #ifdef TEMPORAL_UPSCALE
    outputColor = vec4(vec3(texelFetch(colorBuffer, lowResCoord, 0).a), 1.0);
    #else
    outputColor = vec4(vec3(texelFetch(colorBuffer, coord, 0).a), 1.0);
    #endif // TEMPORAL_UPSCALE
  } else if (u_resolveDebug > 2.5 && u_resolveDebug < 3.5) {
    #ifdef TEMPORAL_UPSCALE
    outputColor = vec4(texelFetch(colorBuffer, lowResCoord, 0).rgb * 50.0, 1.0);
    #else
    outputColor = vec4(texelFetch(colorBuffer, coord, 0).rgb * 50.0, 1.0);
    #endif // TEMPORAL_UPSCALE
  } else if (u_resolveDebug > 8.5 && u_resolveDebug < 9.5) {
    // 【v61 终极隔离】纯红覆盖 resolve 输出：若用户所见「黑块」仍在 → 黑块不在 resolve
    // 输出里（消毒四次失败的解释），而在 overlay 之后（lensFlare/tonemap/合成）。
    outputColor = vec4(1.0, 0.0, 0.0, 1.0);
  } else if (u_resolveDebug > 5.5 && u_resolveDebug < 6.5) {
    // 【v61b】直显 history 的 rgb×50（黑块处的数值放大——判据校准用）
    outputColor = vec4(texture(colorHistoryBuffer, vUv).rgb * 50.0, 1.0);
  } else if (u_resolveDebug > 6.5 && u_resolveDebug < 7.5) {
    // 【v61c】直显 history 的 alpha（黑块处的 a——「洞 vs 黑」判定用）
    outputColor = vec4(vec3(texture(colorHistoryBuffer, vUv).a), 1.0);
  }
}
