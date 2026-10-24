/**
 * 图标系统
 * ========
 * 统一规格：16×16 viewBox、1.5px 描边、圆角端点、currentColor。
 * 为什么不用 emoji / 文本符号（▶ ✕ ⚙）：不同平台字形不一致、对齐不稳、颜色不可控。
 *
 * 用法：
 *   import { icon, kindIcon } from './icons.js'
 *   el.innerHTML = icon('play')          // 返回完整 <svg> 字符串
 *   el.innerHTML = icon('close', 'sm')   // 附加 class
 */

const S = (body) => `<svg class="ico" viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">${body}</svg>`

/** 描边路径统一属性 */
const P = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'

export const ICONS = {
  // 品牌：黑匣子（带记录点）
  logo: S(`<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3" ${P}/><circle cx="8" cy="8" r="2.1" fill="currentColor"/>`),

  // 播放控制
  play: S(`<path d="M5.2 3.6 12.4 8l-7.2 4.4z" fill="currentColor"/>`),
  pause: S(`<rect x="4.6" y="3.4" width="2.4" height="9.2" rx="1" fill="currentColor"/><rect x="9" y="3.4" width="2.4" height="9.2" rx="1" fill="currentColor"/>`),
  follow: S(`<path d="M2.5 11.5 6 5l2.6 4.2L11 6l2.5 5.5" ${P}/><circle cx="11" cy="6" r="1.3" fill="currentColor"/>`),

  // 导航
  overview: S(`<path d="M2.6 13V7.4M6.2 13V3.2M9.8 13V9.6M13.4 13V5.6" ${P}/>`),
  compare: S(`<path d="M3 5.4h8.2M9 3.2l2.4 2.2L9 7.6M13 10.6H4.8M7 8.4 4.6 10.6 7 12.8" ${P}/>`),
  refresh: S(`<path d="M13 8a5 5 0 1 1-1.5-3.6" ${P}/><path d="M13.2 2.4v3.2H10" ${P}/>`),
  help: S(`<circle cx="8" cy="8" r="5.6" ${P}/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4" ${P}/><circle cx="8" cy="11.6" r=".85" fill="currentColor"/>`),
  panel: S(`<rect x="2.2" y="3" width="11.6" height="10" rx="2.2" ${P}/><path d="M10.2 3.4v9.2" ${P}/>`),
  external: S(`<path d="M6.4 3.4H3.6a1.2 1.2 0 0 0-1.2 1.2v7.8a1.2 1.2 0 0 0 1.2 1.2h7.8a1.2 1.2 0 0 0 1.2-1.2V9.6" ${P}/><path d="M9.6 2.6h3.8v3.8M13.1 2.9 8.2 7.8" ${P}/>`),

  // 主题
  themeAuto: S(`<circle cx="8" cy="8" r="5.4" ${P}/><path d="M8 2.6v10.8" ${P}/><path d="M8 2.6a5.4 5.4 0 0 1 0 10.8" fill="currentColor" opacity=".22"/>`),
  themeDark: S(`<path d="M13.2 9.7A5.6 5.6 0 0 1 6.3 2.8 5.6 5.6 0 1 0 13.2 9.7Z" ${P}/>`),
  themeLight: S(`<circle cx="8" cy="8" r="3.1" ${P}/><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" ${P}/>`),

  // 通用操作
  close: S(`<path d="M4 4l8 8M12 4l-8 8" ${P}/>`),
  clear: S(`<circle cx="8" cy="8" r="5.6" ${P}/><path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8" ${P}/>`),
  search: S(`<circle cx="7" cy="7" r="4.6" ${P}/><path d="M10.4 10.4 14 14" ${P}/>`),
  jump: S(`<path d="M3.4 3.4v4.2a2 2 0 0 0 2 2h6.8" ${P}/><path d="M9.8 7.4l2.6 2.2-2.6 2.2" ${P}/>`),
  copy: S(`<rect x="5.4" y="5.4" width="8" height="8" rx="2" ${P}/><path d="M10.6 5.2V4a1.8 1.8 0 0 0-1.8-1.8H4A1.8 1.8 0 0 0 2.2 4v4.8A1.8 1.8 0 0 0 4 10.6h1.2" ${P}/>`),
  chevronDown: S(`<path d="M4.2 6.4 8 10.2l3.8-3.8" ${P}/>`),
  arrowLeft: S(`<path d="M12.8 8H3.2M6.4 4.8 3.2 8l3.2 3.2" ${P}/>`),
  fit: S(`<path d="M2.8 6V2.8H6M10 2.8h3.2V6M13.2 10v3.2H10M6 13.2H2.8V10" ${P}/><path d="M6 6l-1.4-1.4M10 6l1.4-1.4M10 10l1.4 1.4M6 10l-1.4 1.4" ${P}/>`),
  star: S(`<path d="M8 2.6l1.7 3.4 3.8.55-2.75 2.68.65 3.78L8 11.22l-3.4 1.79.65-3.78L2.5 6.55l3.8-.55z" fill="currentColor"/>`),
  starOff: S(`<path d="M8 2.6l1.7 3.4 3.8.55-2.75 2.68.65 3.78L8 11.22l-3.4 1.79.65-3.78L2.5 6.55l3.8-.55z" ${P}/>`),
  focus: S(`<circle cx="8" cy="8" r="3.2" ${P}/><path d="M8 1.6v3M8 11.4v3M1.6 8h3M11.4 8h3" ${P}/><circle cx="8" cy="8" r="1" fill="currentColor"/>`),
  inbox: S(`<path d="M2.4 8.6 4 3.4a1.4 1.4 0 0 1 1.3-1h5.4a1.4 1.4 0 0 1 1.3 1l1.6 5.2v3a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z" ${P}/><path d="M2.4 9.4h3.2l.8 1.6h3.2l.8-1.6h3.2" ${P}/>`),
  arrowRight: S(`<path d="M3.2 8h9.6M9.6 4.8 12.8 8l-3.2 3.2" ${P}/>`),

  // 标签页
  list: S(`<path d="M5.6 4.2h7.4M5.6 8h7.4M5.6 11.8h7.4" ${P}/><circle cx="3" cy="4.2" r=".9" fill="currentColor"/><circle cx="3" cy="8" r=".9" fill="currentColor"/><circle cx="3" cy="11.8" r=".9" fill="currentColor"/>`),
  wrench: S(`<path d="M10.3 2.6a3.2 3.2 0 0 0-3.9 4.1L2.8 10.3a1.7 1.7 0 0 0 2.4 2.4l3.6-3.6a3.2 3.2 0 0 0 4.1-3.9l-1.9 1.9-1.7-1.7z" ${P}/>`),
  file: S(`<path d="M9 2.4H5A1.6 1.6 0 0 0 3.4 4v8A1.6 1.6 0 0 0 5 13.6h6a1.6 1.6 0 0 0 1.6-1.6V6z" ${P}/><path d="M9 2.6V6h3.4" ${P}/>`),

  // 事件类型
  message: S(`<path d="M13.4 8.2a4.9 4.9 0 0 1-5 4.7H6l-2.6 1.5.4-2.3a4.7 4.7 0 0 1-1.2-3.2 4.9 4.9 0 0 1 5-4.7h.3a4.9 4.9 0 0 1 5.5 4z" ${P}/>`),
  user: S(`<circle cx="8" cy="5.6" r="2.5" ${P}/><path d="M3.4 13.2a4.6 4.6 0 0 1 9.2 0" ${P}/>`),
  think: S(`<path d="M8 2.4l1.5 3.1 3.1 1.5-3.1 1.5L8 11.6 6.5 8.5 3.4 7l3.1-1.5z" ${P}/>`),
  tool: S(`<path d="M10.3 2.6a3.2 3.2 0 0 0-3.9 4.1L2.8 10.3a1.7 1.7 0 0 0 2.4 2.4l3.6-3.6a3.2 3.2 0 0 0 4.1-3.9l-1.9 1.9-1.7-1.7z" ${P}/>`),
  check: S(`<path d="M3.2 8.4l3 3 6.6-6.8" ${P}/>`),
  cross: S(`<path d="M4 4l8 8M12 4l-8 8" ${P}/>`),
  alert: S(`<path d="M8 2.8 14 13H2z" ${P}/><path d="M8 6.4v3.1" ${P}/><circle cx="8" cy="11.4" r=".8" fill="currentColor"/>`),
  flag: S(`<path d="M3.4 13.4V2.8M3.4 3.4h7.8l-1.4 2.6 1.4 2.6H3.4" ${P}/>`),
  activity: S(`<path d="M2.4 8h2.4l1.7-4.2 2.6 8.4L11 8h2.6" ${P}/>`),
  handoff: S(`<path d="M2.6 8h10.8M10.4 5.2 13.2 8l-2.8 2.8" ${P}/>`),
  gauge: S(`<path d="M2.6 12.4a5.6 5.6 0 1 1 10.8 0" ${P}/><path d="M8 8.6 10.6 6" ${P}/><circle cx="8" cy="9.2" r="1" fill="currentColor"/>`),
  code: S(`<path d="M5.8 4.6 2.4 8l3.4 3.4M10.2 4.6 13.6 8l-3.4 3.4" ${P}/>`),
  square: S(`<rect x="4" y="4" width="8" height="8" rx="1.6" ${P}/>`),
  dot: S(`<circle cx="8" cy="8" r="2.2" fill="currentColor"/>`),
}

/** 事件类型 → 图标名 */
const KIND_ICON = {
  'tool.call': 'tool',
  'tool.result': 'check',
  'think': 'think',
  'message.agent': 'message',
  'message.user': 'user',
  'status': 'activity',
  'edge': 'handoff',
  'file.edit': 'file',
  'usage': 'gauge',
  'checkpoint': 'flag',
  'run.start': 'play',
  'run.end': 'square',
  'session.start': 'user',
  'session.end': 'user',
  'error': 'alert',
  'raw': 'code',
}

/** 渲染图标；未知名称回退到 dot，保证不会出现空按钮 */
export function icon(name, cls = '', size = 16) {
  const body = ICONS[name] ?? ICONS['dot']
  return body
    .replace('class="ico"', `class="ico${cls ? ` ${cls}` : ''}"`)
    .replace('width="16" height="16"', `width="${size}" height="${size}"`)
}

/** 事件类型图标 */
export function kindIcon(kind) {
  return icon(KIND_ICON[kind] ?? 'dot')
}

/** 把 HTML 里的 data-icon 占位替换成统一 SVG（幂等） */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone === '1') continue
    el.dataset.iconDone = '1'
    const size = Number(el.dataset.iconSize) || 16
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, '', size))
  }
}
