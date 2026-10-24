/**
 * 时间窗（view window）的纯函数
 * ============================
 * 抽出来有两个原因：
 *   1. 缩放/框选的边界条件很容易写错（锚点保持、最小窗口、越界回弹）；
 *   2. 浏览器与 Node 两端共用 —— 浏览器直接 import，测试也直接 import。
 *
 * 坐标系：`view = { from, to }` 是"当前显示的时间区间"（毫秒，相对 run 起点）。
 * 所有绘制都把 t 映射到 [0, width] 上，映射函数只在这里定义一次。
 */

/** 最小窗口：再窄就没有信息量了（200ms） */
export const MIN_WINDOW_MS = 200

/** 把窗口夹回 [0, duration]，并保证最小宽度 */
export function clampWindow(from, to, duration, minMs = MIN_WINDOW_MS) {
  const dur = Math.max(1, duration)
  const min = Math.min(minMs, dur)
  let a = Math.min(Math.max(0, from), dur)
  let b = Math.min(Math.max(0, to), dur)
  if (b < a) [a, b] = [b, a]
  if (b - a >= min) return { from: a, to: b }
  // 太窄：以中点为锚撑到最小宽度，再推回边界内
  const mid = (a + b) / 2
  a = mid - min / 2
  b = mid + min / 2
  if (a < 0) { b -= a; a = 0 }
  if (b > dur) { a -= b - dur; b = dur }
  return { from: Math.max(0, a), to: Math.min(dur, b) }
}

/**
 * 以 anchorT 为锚点缩放。
 * factor < 1 = 放大（窗口变窄）；> 1 = 缩小。
 * 关键性质：**锚点在屏幕上的相对位置不变** —— 这才符合"滚轮对着哪就放大哪"的直觉。
 */
export function zoomWindow(view, duration, anchorT, factor, minMs = MIN_WINDOW_MS) {
  const span = view.to - view.from
  const dur = Math.max(1, duration)
  const nextSpan = Math.min(dur, Math.max(Math.min(minMs, dur), span * factor))
  const ratio = span > 0 ? (anchorT - view.from) / span : 0.5
  let from = anchorT - nextSpan * Math.min(1, Math.max(0, ratio))
  let to = from + nextSpan
  if (from < 0) { to -= from; from = 0 }
  if (to > dur) { from -= to - dur; to = dur }
  return { from: Math.max(0, from), to: Math.min(dur, to) }
}

/** 平移窗口（deltaMs > 0 = 向后看） */
export function panWindow(view, duration, deltaMs, minMs = MIN_WINDOW_MS) {
  const span = view.to - view.from
  const dur = Math.max(1, duration)
  let from = view.from + deltaMs
  if (from < 0) from = 0
  if (from + span > dur) from = Math.max(0, dur - span)
  return { from, to: Math.min(dur, from + Math.max(Math.min(minMs, dur), span)) }
}

/** 框选：两个端点 → 窗口（自动排序 + 夹取） */
export function brushWindow(a, b, duration, minMs = MIN_WINDOW_MS) {
  return clampWindow(Math.min(a, b), Math.max(a, b), duration, minMs)
}

export function isFullWindow(view, duration, eps = 1) {
  return view.from <= eps && view.to >= Math.max(1, duration) - eps
}

/** 时间 → 像素（宽度 W 内留 1px 边距） */
export function xOf(t, view, W) {
  const span = Math.max(1, view.to - view.from)
  return ((t - view.from) / span) * (W - 2) + 1
}

/** 像素 → 时间 */
export function tOf(x, view, W) {
  const span = Math.max(1, view.to - view.from)
  return view.from + ((x - 1) / Math.max(1, W - 2)) * span
}

/** 判断一段区间是否与窗口相交（工具条过滤用） */
export function intersects(start, end, view) {
  const e = end === null ? Number.POSITIVE_INFINITY : end
  return e >= view.from && start <= view.to
}
