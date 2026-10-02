// The node map, drawn as braille: every cell is 2×4 sub-pixels, so a 120×24
// pane is a 240×96 canvas. Pure: give it the hosts, packets and the time, get
// back Raster cells. No `$` here.

export type NodeStyle = 'ok' | 'flagged' | 'mcp' | 'web' | 'error' | 'local' | 'unknown'

// `slot` is the host's first-seen index: positions never move as hosts arrive.
export type MapNode = { host: string; style: NodeStyle; flashUntil: number; count: number; slot: number }

// A packet in flight along one host's edge: out from the machine, or back in.
export type Packet = { host: string; dir: 'out' | 'in'; ok: boolean; startedAt: number }

export const PACKET_MS = 900
const DEFAULT = 0x01000000
const BG = 0x000000

const COLORS: Record<NodeStyle, number> = {
  ok: 0x39ff88,
  flagged: 0xff3355,
  mcp: 0xb57bff,
  web: 0x33d6ff,
  error: 0xff8844,
  local: 0x8899aa,
  unknown: 0xc0c0c0,
}
const DIM: Record<NodeStyle, number> = {
  ok: 0x0f5a32,
  flagged: 0x6a1020,
  mcp: 0x45306a,
  web: 0x0f4a5c,
  error: 0x6a3418,
  local: 0x2a3440,
  unknown: 0x404040,
}
const GRID = 0x0c2a18
const SWEEP = 0x1c8a4c
const AMBER = 0xffb000
const CENTER = 0xe6ffe6

// Braille dot bit for sub-pixel (x 0..1, y 0..3) within a cell.
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

function lum(c: number): number {
  return ((c >> 16) & 0xff) * 3 + ((c >> 8) & 0xff) * 6 + (c & 0xff)
}

class Canvas {
  readonly w: number
  readonly h: number
  readonly px: Uint32Array
  readonly text: Map<number, { cp: number; color: number }> = new Map()
  constructor(readonly cols: number, readonly rows: number) {
    this.w = cols * 2
    this.h = rows * 4
    this.px = new Uint32Array(this.w * this.h)
  }
  dot(x: number, y: number, color: number) {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return
    const i = yi * this.w + xi
    const cur = this.px[i] as number
    if (cur === 0 || lum(color) >= lum(cur)) this.px[i] = color
  }
  line(x0: number, y0: number, x1: number, y1: number, color: number, step = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let k = 0; k <= n; k += step) {
      const t = k / n
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color)
    }
  }
  circle(cx: number, cy: number, r: number, color: number, step = 1) {
    const n = Math.max(12, Math.ceil(2 * Math.PI * r))
    for (let k = 0; k < n; k += step) {
      const a = (k / n) * 2 * Math.PI
      this.dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, color)
    }
  }
  disc(cx: number, cy: number, r: number, color: number) {
    for (let y = -r; y <= r; y += 1) for (let x = -r; x <= r; x += 1) if (x * x + y * y <= r * r + 0.5) this.dot(cx + x, cy + y, color)
  }
  // Text in cell units; it covers the braille in those cells.
  label(col: number, row: number, s: string, color: number) {
    row = Math.max(0, Math.min(this.rows - 1, row))
    let c = Math.max(0, Math.min(col, this.cols - s.length))
    for (const ch of s) {
      if (c >= this.cols) break
      const cp = ch.codePointAt(0) ?? 32
      this.text.set(row * this.cols + c, { cp: cp > 0xffff || cp < 32 ? 63 : cp, color })
      c += 1
    }
  }
  cells(): Uint32Array {
    const out = new Uint32Array(this.cols * this.rows * 3)
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const i = row * this.cols + col
        const t = this.text.get(i)
        if (t) {
          out[i * 3] = t.cp
          out[i * 3 + 1] = t.color
          out[i * 3 + 2] = BG
          continue
        }
        let bits = 0
        let color = 0
        for (let dy = 0; dy < 4; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const c = this.px[(row * 4 + dy) * this.w + col * 2 + dx] as number
            if (c !== 0) {
              bits |= (BIT[dy] as number[])[dx] as number
              if (color === 0 || lum(c) > lum(color)) color = c
            }
          }
        }
        out[i * 3] = bits === 0 ? 32 : 0x2800 + bits
        out[i * 3 + 1] = bits === 0 ? DEFAULT : color
        out[i * 3 + 2] = BG
      }
    }
    return out
  }
}

export type Layout = { cx: number; cy: number; rx: number; ry: number; pos: Map<string, { x: number; y: number; angle: number }> }

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

// Hosts around the machine at golden-angle steps by first-seen slot, so a new
// host never moves the ones already drawn, on an ellipse that fits the canvas.
export function layout(cols: number, rows: number, nodes: readonly { host: string; slot: number }[]): Layout {
  const w = cols * 2
  const h = rows * 4
  const cx = w / 2
  const cy = h / 2
  const rx = Math.max(6, cx - 8)
  const ry = Math.max(4, cy - 6)
  const pos = new Map<string, { x: number; y: number; angle: number }>()
  for (const n of nodes) {
    const angle = -Math.PI / 2 + n.slot * GOLDEN
    // Alternate between two rings so neighbours in angle do not share a label line.
    const k = n.slot % 2 === 0 ? 1 : 0.72
    pos.set(n.host, { x: cx + Math.cos(angle) * rx * k, y: cy + Math.sin(angle) * ry * k, angle })
  }
  return { cx, cy, rx, ry, pos }
}

// One frame of the map, as RasterProps `cells` words.
export function drawMap(cols: number, rows: number, nodes: readonly MapNode[], packets: readonly Packet[], now: number, hidden = 0): Uint32Array {
  const cv = new Canvas(cols, rows)
  const { cx, cy, rx, ry, pos } = layout(cols, rows, nodes)
  // Radar rings and a crosshair, the grid everything sits on.
  for (const k of [0.36, 0.72, 1]) {
    const n = Math.max(24, Math.ceil(Math.PI * (rx + ry) * k))
    for (let i = 0; i < n; i += 3) {
      const a = (i / n) * 2 * Math.PI
      cv.dot(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k, GRID)
    }
  }
  cv.line(cx - rx, cy, cx + rx, cy, GRID, 4)
  cv.line(cx, cy - ry, cx, cy + ry, GRID, 4)
  // A slow sweep, one turn every four seconds, with a short fading tail.
  const sweep = ((now % 4000) / 4000) * 2 * Math.PI - Math.PI / 2
  for (let k = 0; k < 6; k += 1) {
    const a = sweep - k * 0.06
    const fade = k === 0 ? SWEEP : GRID
    cv.line(cx, cy, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, fade, k === 0 ? 1 : 2)
  }
  // Edges.
  for (const node of nodes) {
    const p = pos.get(node.host)
    if (p) cv.line(cx, cy, p.x, p.y, DIM[node.style], 2)
  }
  // Packets with a short trail.
  for (const pk of packets) {
    const p = pos.get(pk.host)
    if (!p) continue
    const t = (now - pk.startedAt) / PACKET_MS
    if (t < 0 || t > 1) continue
    const color = pk.dir === 'out' ? 0xffffff : pk.ok ? COLORS.ok : COLORS.error
    for (let k = 0; k < 4; k += 1) {
      const tt = Math.max(0, t - k * 0.04)
      const u = pk.dir === 'out' ? tt : 1 - tt
      const x = cx + (p.x - cx) * u
      const y = cy + (p.y - cy) * u
      if (k === 0) cv.disc(x, y, 1, color)
      else cv.dot(x, y, k === 1 ? color : DIM[pk.ok ? 'ok' : 'error'])
    }
  }
  // Nodes, a pulsing amber ring on first contact, and labels.
  for (const node of nodes) {
    const p = pos.get(node.host)
    if (!p) continue
    const color = COLORS[node.style]
    cv.disc(p.x, p.y, 2, color)
    if (now < node.flashUntil) {
      const phase = ((now % 600) / 600) * 2 * Math.PI
      cv.circle(p.x, p.y, 4 + Math.sin(phase) * 1.5, AMBER, 1)
    }
    const col = Math.round(p.x / 2)
    const row = Math.round(p.y / 4)
    const name = node.host.length > 22 ? node.host.slice(0, 21) + '~' : node.host
    const text = node.count > 1 ? `${name} x${node.count}` : name
    const below = Math.sin(p.angle) > 0.2
    const labelRow = below ? row + 1 : row - 1
    const labelCol = Math.cos(p.angle) < -0.3 ? col - text.length - 1 : Math.cos(p.angle) > 0.3 ? col + 2 : col - Math.floor(text.length / 2)
    cv.label(labelCol, labelRow, text, now < node.flashUntil ? AMBER : color)
  }
  // The machine at the centre.
  cv.disc(cx, cy, 3, CENTER)
  cv.label(Math.round(cx / 2) - 3, Math.round(cy / 4) + 1, '[ YOU ]', CENTER)
  if (nodes.length === 0) cv.label(Math.round(cx / 2) - 11, Math.round(cy / 4) - 2, 'no outbound traffic yet', SWEEP)
  if (hidden > 0) cv.label(cols - 14, rows - 1, `+${hidden} more hosts`, AMBER)
  return cv.cells()
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Standard padded base64 of the words' little-endian bytes.
export function encodeCells(words: Uint32Array): string {
  const bytes = new Uint8Array(words.length * 4)
  for (let i = 0; i < words.length; i += 1) {
    const v = words[i] as number
    bytes[i * 4] = v & 0xff
    bytes[i * 4 + 1] = (v >>> 8) & 0xff
    bytes[i * 4 + 2] = (v >>> 16) & 0xff
    bytes[i * 4 + 3] = (v >>> 24) & 0xff
  }
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] as number) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}
