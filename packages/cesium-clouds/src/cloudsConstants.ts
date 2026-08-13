// 体积云默认常量（spec r1 §7 选型表 + CloudLayers 搬 three-geospatial CloudLayers.ts）

// 默认质量档（spec r1 §7：high = lightShafts on / shapeDetail on / maxIter 500 / 3 cascade / mapSize 512）。
// 对标 three 版 qualityPresets.ts 默认（high），桌面高端 60fps 目标。
export const CLOUDS_DEFAULT_QUALITY = 'high' as const

// 云层高度（搬 three-geospatial CloudLayers.ts:30，单位 m）。
// 三层：低积云 750m / 中积云 1000m / 卷云 7500m。
export const CLOUDS_LAYER_ALTITUDES_M = [750, 1000, 7500] as const
