// diff-regions.ts —— 两张 PNG 差异定位：按网格统计差异像素分布（诊断用，非门禁）
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

const [refPath, outPath] = process.argv.slice(2)
const a = PNG.sync.read(readFileSync(refPath))
const b = PNG.sync.read(readFileSync(outPath))
if (a.width !== b.width || a.height !== b.height) throw new Error('尺寸不一致')

const W = a.width, H = a.height
const GX = 8, GY = 8 // 8x8 网格
const gw = W / GX, gh = H / GY
const gridMax: number[] = new Array(GX * GY).fill(0)
let diffCount = 0
let globalMax = 0
let sumAbs = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4
    let d = 0
    for (let c = 0; c < 4; c++) {
      const dd = Math.abs(a.data[o + c] - b.data[o + c])
      if (dd > d) d = dd
    }
    sumAbs += d
    if (d > 2) diffCount++
    if (d > globalMax) globalMax = d
    const gi = Math.floor(y / gh) * GX + Math.floor(x / gw)
    if (d > gridMax[gi]) gridMax[gi] = d
  }
}
console.log(`全局: maxΔ=${globalMax} 差异像素(>2)=${diffCount} (${((diffCount / (W * H)) * 100).toFixed(2)}%) 平均|Δ|=${(sumAbs / (W * H)).toFixed(3)}`)
console.log('网格 maxΔ（行=上→下，列=左→右；-2 表示 ≤2）:')
for (let gy = 0; gy < GY; gy++) {
  const row: string[] = []
  for (let gx = 0; gx < GX; gx++) {
    const v = gridMax[gy * GX + gx]
    row.push(v > 2 ? String(v).padStart(3) : '  .')
  }
  console.log('  ' + row.join(' '))
}
