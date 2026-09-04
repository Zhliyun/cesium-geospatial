// nan-probe.console.js —— 云链路 NaN/Inf readPixels 数据探针（console/ego-browser 粘贴即用）
//
// 【来源】2026-09-04 盐粒 NaN 源头调查（docs/superpowers/plans/2026-09-04-salt-nan-source-probe-results.md）。
// 交接文档遗留项「根治需 readPixels 数据探针基建」的落地物：零 shader 改动，raw GL FBO
// attach Cesium 纹理 + HALF_FLOAT readPixels + 位运算 NaN/Inf 位型检测 + rAF 连续采样。
//
// 【用法】demo 页 console（或 ego-browser js()）先粘贴本文件全部内容，然后：
//   __nanProbe.run(20)                    // 连续采样 20 帧，结果打在 __nanProbe.results
//   __nanProbe.results                    // 每帧 { colorBad, dvelBad, resolveBad, velE25samp }
//   __nanProbe.sample()                   // 单帧快照
// 配合运动输入（拖拽 rotate / 滚轮 zoom / ?play=1 时间流动）在运动中采样。
//
// 【检测原理】HALF_FLOAT 位型：exp 全 1（0x7C00）= NaN（mant≠0）或 Inf（mant=0）——
// 二者都是「不该出现的值」，统一统计。resolve 双 buffer ping-pong，__nanProbe 每帧经
// overlayStage._uniformMap.u_cloudsBuffer() 取当帧 resolve 输出（bridge 恒指 resolveTex）。
//
// 【可检测的 buffer】
//   colorBad    = march MRT att0（rgb radiance + a transmittance，HalfFloat RGBA）
//   dvelBad     = march MRT att1（r frontDepth + gb velocity）
//   resolveBad  = resolve 输出（overlay 的 u_cloudsBuffer，全分）
//   velE25samp  = |velocity|>0.25 的 texel 数（1/16 抽样；运动视差强度指标）
//
// 【陷阱】readPixels 用裸 gl.bindFramebuffer 会与 Cesium _currentFramebuffer 状态机脱钩
// （memory: cesium-framebuffer-state-machine-pollution）——本探针读后立即重绑 null，且
// Cesium 每 draw 前 bind 自身 FBO，实践无污染（本轮 ~270 帧无异常）；如见渲染错乱先摘探针。
(function installNanProbe() {
  const canvas = document.querySelector('.cesium-widget canvas')
  const gl = canvas.getContext('webgl2')
  const st = window.__cloudsStage
  if (!st) { console.error('[nanProbe] window.__cloudsStage 不存在（需 demo 页且 clouds 开启）'); return }
  const cp = st.cloudsPass

  function snap(glTex) {
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glTex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      return null
    }
    const buf = new Uint16Array(cp.colorTexture.width * cp.colorTexture.height * 4)
    gl.readPixels(0, 0, cp.colorTexture.width, cp.colorTexture.height, gl.RGBA, gl.HALF_FLOAT, buf)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    return buf
  }

  // half-float exp 全 1 位型 = NaN ∪ Inf
  function badBits(buf, offset) {
    let bad = 0
    for (let i = 0; i < buf.length; i += 4) {
      if ((buf[i * 4 + offset] & 0x7C00) === 0x7C00) bad++
    }
    return bad
  }

  function halfToFloat(h16) {
    const e = (h16 & 0x7C00) >> 10, m = h16 & 0x3FF, sign = h16 & 0x8000 ? -1 : 1
    if (e === 0) return sign * Math.pow(2, -14) * (m / 1024)
    if (e === 0x1F) return m ? NaN : sign * Infinity
    return sign * Math.pow(2, e - 15) * (1 + m / 1024)
  }

  window.__nanProbe = {
    sample() {
      const color = snap(cp.colorTexture._texture)
      const dvel = snap(cp.depthVelocityTexture._texture)
      const resolve = snap(st.overlayStage._uniformMap.u_cloudsBuffer()._texture)
      const r = {
        colorBad: color ? badBits(color, 0) + badBits(color, 1) + badBits(color, 2) + badBits(color, 3) : -1,
        dvelBad: dvel ? badBits(dvel, 0) + badBits(dvel, 1) + badBits(dvel, 2) : -1,
        resolveBad: resolve ? badBits(resolve, 0) + badBits(resolve, 1) + badBits(resolve, 2) + badBits(resolve, 3) : -1
      }
      if (dvel) {
        let e25 = 0
        for (let i = 0; i < dvel.length / 4; i += 16) { // 1/16 抽样
          const g = Math.abs(halfToFloat(dvel[i * 4 + 1])), b = Math.abs(halfToFloat(dvel[i * 4 + 2]))
          if (g > 0.25 || b > 0.25) e25++
        }
        r.velE25samp = e25
      }
      return r
    },
    run(n = 20) {
      window.__nanProbe.results = null
      const results = []
      let i = 0
      function tick() {
        results.push(window.__nanProbe.sample())
        if (++i < n) requestAnimationFrame(tick)
        else {
          window.__nanProbe.results = results
          const bad = results.filter(r => r.colorBad > 0 || r.dvelBad > 0 || r.resolveBad > 0)
          console.log(`[nanProbe] ${n} 帧: 坏帧=${bad.length}` +
            (bad.length ? ' ← 有 NaN/Inf！逐帧看 __nanProbe.results' : '（全链干净）'))
        }
      }
      requestAnimationFrame(tick)
    },
    results: null
  }
  console.log('[nanProbe] 已安装：__nanProbe.run(N) 连续采样 N 帧（配合运动输入使用）')
})()
