# M6 地面云影第一性原理重构设计（ground-shadow first-principles rework）

- 日期：2026-09-30
- 状态：draft r1（待评审）
- 背景：用户目验三项目（影随云动/投山/海面）全负；2026-09-30 排查钉死三层根因（记忆
  `m6-shadow-invisible-rootcause`，探针 debug=12/13 已入库 6cce4fa）。
- 立项：用户拍板「从第一性原理出发，需要从根本解决」。

## 0. 一句话

地面云影的物理量（太阳直射 × exp(−OD)）在管线三处被非物理环节钳压/畸变：
**夜间地板在白天吃掉 83% 信号（核心缺陷）→ 天空漫射异常死 32:1 → 烘焙场两极化**。
本设计逐链路回归第一性原理，每处修复配零回归锚。

## 1. 第一性原理推导与逐链路审计

地面点 P 的直射/漫射光照（Bruneton 语义）：

```
E_direct(P) = E_sun × T_atm(P→sun) × exp(−∫_layer ext dℓ)     ← 云影只调制这一项
E_diffuse(P) = E_sky(P)                                        ← 天空漫射填影
groundLight  = (E_direct + E_diffuse) / E_sun                  ← 乘子（09-01 feature）
final(P)     = originalColor × groundLight × T_atm(view) × groundDim + inscatter
```

实测（2026-09-30，钉时 2026-09-21T11:30Z，el≈41°，350m 近场，readPixels 数值）：

| 链路 | 物理预期 | 实测 | 判定 |
|---|---|---|---|
| T_atm(view) 近场 | ≈0.95+ | 1.0（debug=9 恒 51/51 标定） | ✓ |
| inscatter 近场 | 小（<5% 像素） | ≈0.0004（debug=10） | ✓ |
| sun/solar（shadow 前） | ~0.45-0.65 | **0.647** | ✓ |
| sky/solar | ~0.15-0.25 | **0.02（32:1）** | ✗ 链 2 |
| shadow 场 OD | 破云区有结构 | cov≥0.4 全地面 trans=0；≤0.25 无影 | ✗ 链 3 |
| glc 摆动（全影） | 0.667→0.02（33×） | **0.667→0.55（17%）** | ✗ 链 1 |
| 最终画面 Δ（全影） | ≥50/255 | **~12/255 ≈ 噪声地板 14** | 结果 |

### 链 1（核心缺陷）：夜间地板无门控，白天钳死影子

`aerialPerspective.frag` main 末端：

```glsl
groundLightColor = max((mulSunIrr + mulSkyIrr) / solar, u_groundNightAmbient);
//                                   0.647+0.02=0.667   地板默认 (0.55,0.62,0.78)
```

`u_groundNightAmbient=(0.55,0.62,0.78)` 为**夜间**定稿（09-01，注释「按曝光链预放大」——
夜间曝光链会再缩小，白天曝光=1 时地板=满日照的 83%）。影子把太阳项打到 0 后被 max 钳到
0.55：**33× 物理摆动 → 1.2×**。09-01 定标时 M6 云影尚不存在，地板的白天行为从未被检验；
M6（09-26）在地板之上建影子，信号出生即被掐死。strength 1/2/4 逐字节同（负乘子全被同一
地板钳平）、plain ON≈OFF（Δ12≈T7 噪声地板 14）均由此唯一解释。

**修复（1a）**：地板从全局 max 改为昼夜门控混合——

```glsl
float glcNightFactor = 1.0 - smoothstep(-0.0175, -0.1045, mulMuS); // 太阳 -1°→-6° 淡入
                                                    //（与 clouds.frag nightFactor 同窗同语义）
vec3 glcPhysical = (mulSunIrr + mulSkyIrr) / ATMOSPHERE.solar_irradiance;
groundLightColor = mix(glcPhysical, max(glcPhysical, u_groundNightAmbient), glcNightFactor);
```

- 白天（el>-1°）：nightFactor=0 → **纯物理，零地板**，影子满摆幅；
- 夜间（el<-6°）：nightFactor=1 → `max(物理, 地板)` 与现行为**逐位一致**（现 max 语义）；
- 晨昏带：连续过渡（同窗复用，无新常量）。
- 注意：夜间物理项 (0+0)/solar=0 < 地板 → max 取地板 = 现行为，逐位等价锚成立。

**回归锚**：夜间场景（el<-6°）ON/OFF 与 main 逐位一致；白天 groundShadow=0 逐字节不变；
?groundLighting=0 路径不变。

### 链 2：天空漫射异常死（sun:sky = 32:1，物理应 2-3:1）

debug=13 实测 sky/solar=0.02。物理后果：影子区只剩 2% 光 → 修完链 1 后影子会**过黑**
（真实碎云影内仍有 40-70% 光照：漫射填影+直射透云）。且 09-01 乘子 feature 的
「影像×大气同步」语义实质退化为「太阳同步」。

**修复（2a）**：先定位 `GetIrradiance`（irradiance LUT 采样，mulMuS=cos 天顶角，km 单位）
为何 0.02——候选：LUT 采样 mu 语义（mu_s vs 1−mu）、irradiance_texture 绑定、
或 LUT 本身在地面 r 的值即如此（对照 Bruneton 参考 demo 的 E_diffuse 曲线）。
**本项是修复前置调查（Phase 0），不预设修法**；若 LUT 数据本身如此则回溯 precompute 链。

### 链 3：烘焙场两极化（mip/噪声平均 × remap 阈值顺序）

bake march（shadow.frag）mipLevels[0,0.5,1,2] + 3D 噪声 mip 平均 → 破云区云/隙预混成
「半密霾」；coverage remap 在平均之后切阈值 → 霾密度整体落在阈值上方 → 积成 OD≥30
（B1 直显 b+a 饱和实证）。coverage 扫描锚：≤0.25 无影 / 0.3 trans 0.45-0.8 / ≥0.4 全影。

第一性原理裁决：**Beer 定律必须作用于单条光线，ensemble 平均只能在透射率域做**
（exp 凸性：exp(−f·OD) ≠ (1−f)+f·exp(−OD)，前者把「50% 遮挡」错成「全黑」）。
**修复（3a）**：bake 产物增加 ensemble 透射语义——mip>0 级联的 texel 存
`T_texel = 1 − f̄·(1 − exp(−OD_dense))`（f̄=路径平均固体率，mip 0 级联保持逐光线真值），
消费端（ground + clouds 自阴影）直接读 T 而非 min(b, g×d) 重组。r/g/b/a 通道语义不动，
b 通道改存「已合成的柱透射率」（或加 a 通道现成尾项复用——实现期定）。
**效果**：cov 0.25-0.35 破云窗口出现真实碎云影；cov≥0.4 全影保持（物理正确）。

## 2. 实施顺序与验收

| 步 | 内容 | 验收 |
|---|---|---|
| P0 | 链 2 前置调查（GetIrradiance=0.02 根因） | 数值报告：修后 sky/solar 落 0.1-0.3 |
| P1 | 链 1a 地板门控（单独落地） | 近场 cov0.5 全影 plain Δ≥40/255；夜间逐位锚；groundShadow=0 逐字节 |
| P2 | 链 2a 天空漫射修复 | shadow 区亮度物理化（影内非纯黑）；白天 glc 摆动回到物理区间 |
| P3 | 链 3a 场 ensemble | cov 0.3 出现云形影（Δ≥30 局部）；八机位回归 |
| P4 | 真机三项目验复测（近场场景集） | 用户目验：影随云动/投山可见 |

每步独立 commit+逃生门；P1 与 P2/P3 可并行评审。

## 3. 已排除项（防止重查）

- debug=11 直显不可信（overlay+tonemap 污染）——读场用 debug=12；
- 跨配置 readPixels 绝对值被动态曝光污染——只比同帧比值/同配置差分；
- BSM 直显（cloudsDebug=4）b+a 饱和=链 3 症状非独立 bug；
- F2 半径短路（b0411c4）与本缺陷无关（纯性能卫生项）。

## 4. 开放问题

- Q1 groundDim 0.43（CI 基线 artistic 值）是否影响影对比度验收目标——P1 落地后实测再定。
- Q2 动态曝光对「全屏均匀变暗」的补偿行为——P1 后复测；若补偿过强，评估曝光输入端
  排除 shadow 贡献（勿在本 spec 内绑定解法）。
- Q3 链 3a 的 clouds 自阴影消费端同步改读 T——须与 15-29 轮自阴影验收形态对照防回归。
