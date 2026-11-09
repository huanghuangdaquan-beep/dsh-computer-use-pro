/**
 * lib/shot.js — 截图的「模型可见」交付 + 「将要点击的位置」标注
 *
 * 两个实测结论（驱动 0.34.1 / Windows 11）决定了这里的写法：
 *
 * 1) **为什么以前看不到截图**：`get_window_state` 不带 `screenshot_out_file` 时，
 *    驱动把截图当成 image content block 回给 MCP 客户端；而 `driver.js` 的 callTool
 *    为了省内存只保留了文本（图片进了 `imageBytes` 计数就被丢掉）。带上
 *    `screenshot_out_file` 时驱动只回一个文件路径。所以插件必须自己把文件读出来，
 *    交给宿主的 attachments 服务换成 ImageBlock —— 这才叫「模型能看见画面」。
 *    （宿主侧的图片通道有现成实现可依：dsh-tool-fs 的 read_image、浏览器插件的截图工具。）
 *
 * 2) **为什么 agent cursor 进不了窗口截图**：覆盖层是**独立顶层窗口**（整屏大小），
 *    而窗口截图是逐窗口合成的（PrintWindow）。实测同一窗口开/关覆盖层、把指针移到
 *    控件上，PNG 逐字节一致。覆盖层只对真机用户可见（且本机 SetWindowDisplayAffinity
 *    失败 → 它会出现在**桌面**截图里，但依然不会出现在窗口截图里）。
 *    所以「我将要点的位置」由插件自己在 PNG 像素上画标记，指数坐标与点击坐标同源。
 */

import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 读 IHDR 里的宽高；不是 PNG 返回 null */
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/* ------------------------------------------------------------------ PNG 编解码 */

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 解出 RGBA 像素。只支持驱动实际会产出的形态（8 位、非隔行；灰度/RGB/调色板/RGBA）。
 * 不认识的形态返回 null —— 标注是锦上添花，绝不能因此让截图交付失败。
 */
function decodePng(buf) {
  const head = pngSize(buf)
  if (!head) return null
  let i = 8
  let colorType = -1
  let bitDepth = 0
  let interlace = 0
  const idat = []
  let palette = null
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    i += 12 + len
    if (type === 'IHDR') {
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (bitDepth !== 8 || interlace !== 0) return null
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 6 ? 4 : 0
  if (!channels || (colorType === 3 && !palette)) return null
  let raw
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const { width, height } = head
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    const filter = raw[base]
    raw.copy(line, 0, base + 1, base + 1 + stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 0xff
      else if (filter === 2) line[x] = (line[x] + b) & 0xff
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff
      else if (filter !== 0) return null
    }
    line.copy(prev)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * channels
      if (colorType === 6) {
        out[o] = line[s]
        out[o + 1] = line[s + 1]
        out[o + 2] = line[s + 2]
        out[o + 3] = line[s + 3]
      } else if (colorType === 2) {
        out[o] = line[s]
        out[o + 1] = line[s + 1]
        out[o + 2] = line[s + 2]
        out[o + 3] = 255
      } else if (colorType === 3) {
        const p = line[s] * 3
        out[o] = palette[p]
        out[o + 1] = palette[p + 1]
        out[o + 2] = palette[p + 2]
        out[o + 3] = 255
      } else {
        out[o] = out[o + 1] = out[o + 2] = line[s]
        out[o + 3] = 255
      }
    }
  }
  return { width, height, rgba: out }
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

/* ------------------------------------------------------------------ 标注 */

const RING = [230, 0, 92]
const HALO = [255, 255, 255]

function paint(px, w, h, x, y, c) {
  if (x < 0 || y < 0 || x >= w || y >= h) return
  const i = (y * w + x) * 4
  px[i] = c[0]
  px[i + 1] = c[1]
  px[i + 2] = c[2]
  px[i + 3] = 255
}

function ring(px, w, h, cx, cy, r, thick, color) {
  const steps = Math.max(48, Math.round(r * 6))
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * Math.PI * 2
    const x0 = Math.round(cx + Math.cos(a) * r)
    const y0 = Math.round(cy + Math.sin(a) * r)
    for (let dx = -thick; dx <= thick; dx++) {
      for (let dy = -thick; dy <= thick; dy++) {
        if (dx * dx + dy * dy <= thick * thick) paint(px, w, h, x0 + dx, y0 + dy, color)
      }
    }
  }
}

function bar(px, w, h, x0, y0, x1, y1, thick, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps)
    const y = Math.round(y0 + ((y1 - y0) * s) / steps)
    for (let dx = -thick; dx <= thick; dx++) {
      for (let dy = -thick; dy <= thick; dy++) {
        if (dx * dx + dy * dy <= thick * thick) paint(px, w, h, x + dx, y + dy, color)
      }
    }
  }
}

/**
 * 在截图上画「点击点」：白色光晕 + 品红圆环 + 四向短刻线。
 * 白圈是为了在深色/浅色界面上都看得清；坐标就是传进来的 PNG 像素坐标。
 */
export function markPoint(buf, point) {
  const img = decodePng(buf)
  if (!img) return null
  const { width: w, height: h, rgba } = img
  const cx = Math.round(Number(point?.x))
  const cy = Math.round(Number(point?.y))
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  ring(rgba, w, h, cx, cy, 12, 2, HALO)
  ring(rgba, w, h, cx, cy, 10, 2, RING)
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    bar(rgba, w, h, cx + dx * 15, cy + dy * 15, cx + dx * 22, cy + dy * 22, 2, HALO)
    bar(rgba, w, h, cx + dx * 15, cy + dy * 15, cx + dx * 22, cy + dy * 22, 1, RING)
  }
  return encodePng(w, h, rgba)
}

/* ------------------------------------------------------------------ 交付 */

/**
 * 把 PNG 提交给宿主的 attachments 服务，换一个模型能直接看的 ImageBlock。
 *
 * 交付条件与宿主的 `read_image` 保持一致（缺一不可）：
 *   · 有 `attachments` 服务、媒体类型在 imageLimits 白名单里、体积不超单图/单消息上限；
 *   · 当前模型路由**没有明确**声明「只收文本」（inputModalities 里有 image，或拿不到
 *     这份元数据）。拿不到元数据时仍然交付：宿主在组装请求时会把图片投影成文本给纯文本
 *     模型（dsh-llm 的 projectImagesForTextModel），不会把会话写坏；只有路由明确说
 *     「不收图片」才退回纯文本 + 路径。
 * 任何一条不满足就只留本地文件，并把原因写回给调用方（绝不静默）。
 */
export async function attachImage({ ctx, exec, data, name, logger }) {
  let attachments = null
  try {
    attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : ctx?.attachments ?? null
  } catch {
    attachments = null
  }
  if (!attachments || typeof attachments.saveImage !== 'function') {
    return { image: null, reason: '宿主没有提供 attachments 图片服务（宿主的图片通道缺席）' }
  }
  const limits = attachments.imageLimits ?? {}
  const mediaTypes = Array.isArray(limits.mediaTypes) ? limits.mediaTypes : ['image/png']
  if (!mediaTypes.includes('image/png')) return { image: null, reason: `宿主不接受 image/png（只收 ${mediaTypes.join(' / ')}）` }
  const cap = Math.min(Number(limits.maxImageBytes) || Infinity, Number(limits.maxMessageImageBytes) || Infinity)
  if (data.length > cap) return { image: null, reason: `截图 ${data.length} 字节，超过宿主单图上限 ${cap} 字节` }

  // 只有路由**明确**给出 inputModalities 且里面没有 image 时才拒绝交付；
  // 拿不到元数据（老宿主 / exec 里没有 agent）就照常交付，宿主会替纯文本模型做投影。
  let capable = true
  let why = ''
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm
    const cfg = exec?.agent?.session?.requestHeader?.()?.config ?? null
    const provider = cfg?.provider ?? exec?.agent?.options?.provider
    const model = cfg?.model ?? exec?.agent?.options?.model
    if (llm && typeof llm.resolveModelInfo === 'function' && provider && model) {
      const info = await llm.resolveModelInfo(provider, model, exec?.signal)
      if (Array.isArray(info?.inputModalities)) capable = info.inputModalities.includes('image')
      if (!capable) why = `当前路由 ${provider}/${model} 声明只收文本（inputModalities 无 image）`
    }
  } catch (err) {
    capable = true
    why = `路由能力检查失败（按可交付处理）：${err instanceof Error ? err.message : err}`
  }
  if (!capable) return { image: null, reason: why }

  try {
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
    if (!ref || !ref.attachmentId) return { image: null, reason: 'attachments.saveImage 没返回可用引用' }
    // 多数附件服务只回引用、不回尺寸：用 PNG 头的真实宽高兜底，别把 0x0 的图片块交给模型
    const dims = pngSize(data) ?? { width: 0, height: 0 }
    return {
      image: {
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType || 'image/png',
        bytes: Number(ref.bytes) || data.length,
        width: Number(ref.width) || dims.width,
        height: Number(ref.height) || dims.height,
        ...(ref.name || name ? { name: String(ref.name || name) } : {}),
      },
      reason: '',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger?.warn?.(`[computer-use] 截图入附件库失败（只落盘）：${msg}`)
    return { image: null, reason: `attachments.saveImage 失败：${msg}` }
  }
}
