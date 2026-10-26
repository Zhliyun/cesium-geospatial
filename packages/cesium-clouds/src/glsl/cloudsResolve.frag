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
// 【2026-10-08 白点治理】输出端孤点中值滤波强度（0=关缺省零回归；1=全替换）。
// 白点=march 能量积分采样方差的 1px 亮度尖峰（伴生暗斑族对称），时序平均
// （frameUnfreeze）消掉 ~95% 后的残余为每帧随机注入的稳态——邻域中值直接替换。
uniform float u_spatialDespeckle;
// 【2026-10-25 探针】0=关历史重投影（直接用 vUv 采历史，用于判定拖动静止带垂直漂移
// 是否来自 velocity）。缺省 1=正常。
uniform float u_reprojectionEnabled;
// 【2026-10-25】Bayer 直通开关（相位冻结时必须 0）。直通像素绕过累积直显原始 march 噪声；
// 相位冻结后这批像素固定不变 → 规则格点（实测 N=4 下 4px×2px、FFT 主峰 16135，
// N=1 全分路径无此峰）。参考库相位永远轮换，所以直通不会固化。
uniform float u_bayerDirectThrough;
// 【2026-10-26 探针】1 = 把「历史是否被 AABB 裁掉」写入 alpha（配合 ?cloudsOverlayDebug=1
// 直显：白=被裁=该像素本帧没有累积，黑=历史保留）。
uniform float u_clipDebug;
// 【2026-10-26 时域收敛修复】upscale 分支的显式 EMA 权重（0=参考库原语义：纯裁剪累积；
// ∈(0,1]=每帧把当前帧按此权重混入）。参考库纯裁剪在「march 逐相位摆动大」时退化为
// 冻结/跟随（实测静止帧间差 4.5/255，参考库 0.58），加 EMA 才能真正做 16 相位平均。
uniform float u_temporalBlend;
// 【2026-10-26】1=参考库语义（AABB 裁剪后累积）；0=跳过裁剪（纯 EMA，历史不被拉回当前帧）。
// 仅 u_temporalBlend>0 时有意义——用于验证「裁剪是否吃掉 16 相位平均」。
uniform float u_clipEnabled;
// 【2026-10-26 静止噪声根治】速度死区（全分像素）：|velocity| 低于此值时视为静止（prevUv=vUv）。
// 实测静止时重投影矩阵因 ECEF float32 精度仍有亚像素残差，逐帧把 history 采样点抖动
// ±0.x px → 云区逐像素时间标准差 5.6（参考库 1.34）；死区 0.5px 后 1.35。0=关（零回归）。
uniform float u_velocityThresholdPx;
// 【2026-10-26 远云抖动】EMA 权重的距离衰减系数（0=关）。远处云视差小、重投影近乎精确，
// 可用长窗平均压相位噪声；近处保短窗避免拖影。配合 u_temporalBlend（运动中值）使用。
uniform float u_blendDepthFalloff;
// 【2026-10-26 远地平线抖动】远云专用 EMA：近处保参考库纯裁剪（无拖影），远处（视差小、
// 重投影近乎精确）改用 EMA 长窗平均。u_temporalBlendFar=0 时关闭（零回归）。
uniform float u_temporalBlendFar;
uniform vec2 u_farRange;
// 【2026-10-27 拖影/晃动根因·最终定论】本帧几何 jitter（归一化 UV）。
// 本实现的 jitter 只作用于「射线重建」（windowCoord 偏移），不作用于像素栅格——于是：
//   ① 低分 texel q 的值实际采自 UV = (q+0.5)/lowRes + j(t)（整帧统一偏移，非逐像素）；
//   ② march 写出的 velocity 里恒含 −j(t)（实测静止 velocity = (−1.5/1280, −1.5/720) = −j)。
// 两条后果正是用户报的「整体晃」与「静止抖」：
//   - 不补偿：history 采在 p + j(t)，当前帧画在 p + j(t) → 云相对地形每帧整体平移 ±1.5px；
//   - 扣上帧 j(t−1)：history 采在 p + j(t) − j(t−1) → 静止时采样点仍逐帧游走（抖+拖影）。
// 正解（两者都要）：
//   ① 当前帧低分采样反向平移 −j(t)，把「抖动过的低分图」重采样回像素栅格（本文件 texture 处）；
//   ② 重投影前把 velocity 里的 −j(t) 加回去：prevUv = vUv − (velocity + j(t))。
// 这样 history/current 都落在像素栅格上，jitter 只承担「16 相位亚像素超采样」本职，
// 不再产生任何跨帧位移。
// 【2026-10-27 量纲定论】u_jitterUV = temporalJitter（(offset−0.5)/lowResW，全分归一化 UV）。
// march 的 windowCoord 偏移已按低分 FBO 尺寸换算（clouds.frag jitterPx），所以射线在屏幕上的
// 归一化位移**恰好等于** u_jitterUV（N=4 时 ±1.5 全分像素，与 three 一致）。
uniform vec2 u_jitterUV;
// 【2026-10-27 A/B 开关】1=去抖动重采样（缺省）；0=旧行为（texelFetch 点采样 + 不做
// velocity 偏置补偿）。仅用于同构建前后对照，排查时保留。
uniform float u_dejitter;

// 本帧几何 jitter 在归一化 UV 下的真实位移 = u_jitterUV 本身（march 侧已按低分 FBO 换算）。
// ⚠️ 不要在这里写单行 `/** ... */` 块注释：Cesium removeComments 对无换行的块注释会
// match(/\n/g) 得 null 再取 .length → TypeError（表现为体积云整个创建失败）。
vec2 jitterShiftUv() {
  return u_jitterUV;
}
// 【2026-10-26 架构改造】历史采样点吸附到整像素（0=关）。长窗 EMA 在运动时每帧做亚像素
// 双线性重采样 → 沿运动方向累积重采样模糊 = 拖影。吸附到 texel 中心后 texture() 等价
// texelFetch，不再累积模糊（代价：丢掉 ≤0.5px 的亚像素时域超采样收益）。
uniform float u_historySnap;

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


// 【2026-10-26】速度死区：把亚像素残差归零（静止时 history 采样点不再逐帧抖动）。
vec2 applyVelocityDeadzone(const vec2 velocity, const ivec2 coord) {
  if (u_velocityThresholdPx <= 0.0) {
    return velocity;
  }
  vec2 velPx = velocity * vec2(textureSize(colorBuffer, 0));
  return max(abs(velPx).x, abs(velPx).y) < u_velocityThresholdPx ? vec2(0.0) : velocity;
}


vec2 snapToTexel(const vec2 uv) {
  vec2 size = vec2(textureSize(colorHistoryBuffer, 0));
  return (floor(uv * size) + 0.5) / size;
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
    // 【2026-10-27 死代码修复】原条件 `neighbor.r <= c*2 && c*2 <= neighbor.r` 只有
    // neighbor.r 恰好等于 c*2 时才成立 → 恒 false，退化成「永远只取中心块」。本意是
    // 「深度在 [0.5c, 2c] 内才算同质邻居」，按本意修正。
    if (neighbor.r <= centerDepth * 2.0 && neighbor.r >= centerDepth * 0.5 && neighbor.r < result.r) {
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
  // 【2026-10-27 去抖动重采样·取代 2026-10-25 的点采样】低分 texel 的真实采样位置是
  // (q+0.5)/lowRes + j(t)（见 u_jitterUV 注释）。用 uv − j(t) 做双线性查找 = 把「整帧
  // 平移过的低分图」重采样回像素栅格：云不再相对地形整体晃，且每帧贡献都落在同一栅格上
  //（EMA 才能长窗累积）。代价=双线性带来的 ~0.5 低分 texel 软化，比 4×4 方块+整体晃划算。
  vec4 currentColor = u_dejitter > 0.5
    ? texture(colorBuffer, vUv - jitterShiftUv())
    : texelFetch(colorBuffer, lowResCoord, 0);
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
  // 【2026-10-27】march 的 velocity 含 −j(t)（射线偏移），加回 j(t) 得像素栅格真实速度
  //（静止时精确为 0）。死区必须在补偿**之后**判：补偿前 jitter 本身就是 ~1.5px 的假速度。
  vec2 velocity = applyVelocityDeadzone(
    depthVelocity.gb + jitterShiftUv() * u_dejitter, lowResCoord);
  vec2 prevUv = mix(vUv, vUv - velocity, u_reprojectionEnabled);
  if (u_historySnap > 0.5) { prevUv = snapToTexel(prevUv); }
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
  if (abs(currentColor.a - historyColor.a) > temporalDisocclusion) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Disocclusion rejection
  }
  // 【2026-10-26 修复】varianceClipping 首参是 ivec2 像素坐标（内部 texelFetchOffset），
  // 此处原来传 vUv（0..1 归一化 UV）——邻域被固定在纹理左上角，AABB 与当前像素无关，
  // 历史几乎永远落在 AABB 外 → 每帧退回 current → 时域完全不累积（实测：静止帧间差
  // 2.4/255 且不随时间收敛；同像素 march alpha 每帧在 0↔0.97 翻转而输出跟着跳）。
  vec4 clippedColor = u_clipEnabled > 0.5
    ? varianceClipping(colorBuffer, lowResCoord, currentColor, historyColor, varianceGamma)
    : historyColor;
  if (u_clipDebug > 0.5) {
    float wasClipped = any(greaterThan(abs(clippedColor - historyColor), vec4(1e-5))) ? 1.0 : 0.0;
    outputColor = vec4(currentColor.rgb, wasClipped);
    return;
  }
  // 【2026-10-25 观感对齐：回到参考库的纯累积】参考库的 upscale 分支（生产路径，恒 N=4）
  // 是 `outputColor = clippedColor`——历史经当前帧邻域 AABB 裁剪后直接写回，**不混入
  // 当前帧**。我们 2026-09-02 为治静止抖动加了 mix(clipped, current, α=0.1)：当时噪声
  // 相位是冻结的（STBN mip 门控），所以看不出副作用；2026-10-24 相位改为每帧轮换后，
  // 这 10% 直通就让每帧的新噪声原样透出 = 用户反馈的「整体快速抖动」。
  // 恢复参考库语义：纯累积，噪声由 16 相位的历史平均消掉。
  // 回退：`?cloudsUpscale=1` 走下面的 TAA 分支（那里保留 α 混合，与参考库 TAA 分支一致）。
  // 【2026-10-26】u_temporalBlend>0 时改为 EMA（α=1/16 即 16 相位滑动平均）：纯裁剪在
  // march 逐相位摆动大时不会平均（历史被 AABB 拉向当前或被冻结），实测 8× 于参考库。
  // 【2026-10-26】远近分治：近处 α=u_temporalBlend（缺省 0=纯裁剪，无拖影）；
  // 远处 α=u_temporalBlendFar（长窗平均压远地平线相位噪声）。远段不做 AABB 裁剪
  // （裁剪会把历史拉回当前帧邻域，平均失效）。
  // 【2026-10-27 太空机位拖影·根治】原来的「远段」只用**深度**判定，隐含假设是
  // 「远=视差小=可长窗」。这个假设在**旋转**下不成立：旋转造成的屏幕位移与深度无关，
  // 112km 机位视线到云 ≥270km ≫ u_farRange.y(60km) → 全屏 farT=1 → 既绕过 AABB 裁剪、
  // 又把 α 换成 20 帧长窗（farBlend=0.05），两条防拖影机制同时失效 → 严重拖影。
  // 修：farT 再乘一个「屏幕速度小」的门控——每秒几十像素的位移不允许走长窗。
  float velPx = length(velocity * vec2(textureSize(colorBuffer, 0)));
  float farSpeedGate = 1.0 - smoothstep(4.0, 12.0, velPx);
  float farT = u_temporalBlendFar > 0.0
    ? smoothstep(u_farRange.x, u_farRange.y, max(0.0, depthVelocity.r)) * farSpeedGate
    : 0.0;
  // 【2026-10-27 远段也必须先裁剪】原来 farT=1 时 accumColor=historyColor（原始历史）——
  // 长窗 + 无界历史 = 任何径向亚像素残差都被拉成长影（掠射带把**竖直**方向的残差放大：
  // 近地平线竖偏 1px ≈ 沿视线数公里深度差）。远段只需要「更长的平均窗」，不需要「无界历史」。
  vec4 accumColor = clippedColor;
  float blendAlpha = mix(u_temporalBlend, u_temporalBlendFar, farT);
  outputColor = mix(accumColor, currentColor, blendAlpha);
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
  outputShadowLength = mix(clippedShadowLength.r, currentShadowLength.r, u_temporalBlend);
  #endif // SHADOW_LENGTH
}

void temporalAntialiasing(const ivec2 coord, out vec4 outputColor, out float outputShadowLength) {
  // 【2026-10-27】同 temporalUpscale：反向平移 j(t) 把当前帧放回像素栅格。
  vec4 currentColor = u_dejitter > 0.5
    ? texture(colorBuffer, vUv - jitterShiftUv())
    : texelFetch(colorBuffer, coord, 0);
  #ifdef SHADOW_LENGTH
  vec4 currentShadowLength = vec4(texelFetch(shadowLengthBuffer, coord, 0).rgb, 1.0);
  #endif // SHADOW_LENGTH

  vec4 depthVelocity = getClosestFragment(coord);
  vec2 velocity = applyVelocityDeadzone(
    depthVelocity.gb + jitterShiftUv() * u_dejitter, coord);

  vec2 prevUv = mix(vUv, vUv - velocity, u_reprojectionEnabled);
  if (u_historySnap > 0.5) { prevUv = snapToTexel(prevUv); }
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
  if (abs(currentColor.a - historyColor.a) > temporalDisocclusion) {
    outputColor = currentColor;
    #ifdef SHADOW_LENGTH
    outputShadowLength = currentShadowLength.r;
    #endif // SHADOW_LENGTH
    return; // Disocclusion rejection
  }
  vec4 clippedColor = varianceClipping(colorBuffer, coord, currentColor, historyColor);
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
  bool currentFrame = (bayerValue == frame % 4) && u_bayerDirectThrough > 0.5;
  #else // UPSCALE_DIVISOR == 2
  ivec2 lowResCoord = coord / 4;
  int bayerValue = bayerIndices[coord.x % 4][coord.y % 4];
  bool currentFrame = (bayerValue == frame % 16) && u_bayerDirectThrough > 0.5;
  #endif // UPSCALE_DIVISOR == 2
  temporalUpscale(coord, lowResCoord, currentFrame, outputColor, outputShadowLength);
  #else // TEMPORAL_UPSCALE
  temporalAntialiasing(coord, outputColor, outputShadowLength);
  #endif // TEMPORAL_UPSCALE

  // 【2026-10-08 白点治理】孤点中值替换（u_spatialDespeckle>0 才走，全屏一致分支）：
  // 当前像素 luma 与邻域中值差超阈（0.1 线性域）= 孤立亮/暗点 → 中值替换。
  // 【5×5 窗】云缘颗粒带密度高（>44%），3×3 中值（抗 44%）失效——5×5 中值抗 ~52%
  // 且窗更大覆盖 2px 簇；25 texelFetch+插入排序成本 ~1ms/1080p（resolve 全屏 pass）。
  if (u_spatialDespeckle > 0.0) {
    // 【2026-10-24 左下象限伪影根治】despeckle 必须按 colorBuffer 自身分辨率取坐标：
    // N>1 时 colorBuffer 是低分 march RT，用全分 coord 去 texelFetch 会让「左下
    // lowRes 尺寸」那块像素恰好落在有效 texel 范围内（其余出界返回 0）——低分原图
    // 被 1:1 混进全分输出的左下角，形成尺寸 ∝ 1/N 的矩形块（N=4→480×270，
    // N=2→960×540，N=1 因 colorBuffer 全分而无症状）。改为低分坐标后窗口语义
    // 也正确（5×5 邻域 = 低分域 5×5 texel，与 despeckle「孤点」的尺度一致）。
    #ifdef TEMPORAL_UPSCALE
    ivec2 speckleCoord = lowResCoord;
    #else
    ivec2 speckleCoord = coord;
    #endif
    // 【2026-10-24 窗口 5×5→3×3】25→9 次 texelFetch：N=2 实测帧时由 +2.0ms 降到 ~0
    // （10.24→9.89ms，噪声内），颗粒 −11%（13.79→12.27）与 5×5 的 −13% 同档。
    #define DSP_R 1
    #define DSP_N ((DSP_R * 2 + 1) * (DSP_R * 2 + 1))
    float lumas[DSP_N];
    float alphas[DSP_N];
    vec3 colors[DSP_N];
    int k = 0;
    for (int dy = -DSP_R; dy <= DSP_R; ++dy) {
      for (int dx = -DSP_R; dx <= DSP_R; ++dx) {
        vec4 cn = texelFetch(colorBuffer, speckleCoord + ivec2(dx, dy), 0);
        colors[k] = cn.rgb;
        alphas[k] = cn.a;
        lumas[k] = dot(colors[k], vec3(0.299, 0.587, 0.114));
        ++k;
      }
    }
    vec3 meanColor = vec3(0.0);
    float meanA = 0.0;
    for (int i = 0; i < DSP_N; ++i) { meanColor += colors[i]; meanA += alphas[i]; }
    meanColor /= float(DSP_N);
    meanA /= float(DSP_N);
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
}
