/**
 * 主题：跟随系统 / 深色 / 浅色
 * ==========================
 * 三个页面（仪表盘 / 总览 / 对比）共用。约定：
 *   · `<html data-theme="dark|light">` 是唯一开关，样式全部走 CSS 变量；
 *   · 用户在 <head> 的内联脚本里就会先把 data-theme 设好，避免刷新时闪一下白/黑；
 *   · 选择存 localStorage（key: bb-theme），auto 时监听系统偏好变化；
 *   · canvas 绘制用色从 CSS 变量读（`--cv-*`），切主题后由页面重绘。
 */
import { icon } from './icons.js'

const KEY = 'bb-theme'
const mq = window.matchMedia('(prefers-color-scheme: light)')

/** @type {'auto'|'dark'|'light'} */
let mode = readMode()

function readMode() {
  // 支持 ?theme=light|dark|auto：截图、嵌入、分享单页时不用改 localStorage
  try {
    const q = new URLSearchParams(location.search).get('theme')
    if (q === 'auto' || q === 'dark' || q === 'light') {
      try {
        localStorage.setItem(KEY, q)
      } catch {
        /* ignore */
      }
      return q
    }
  } catch {
    /* ignore */
  }
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'auto' || v === 'dark' || v === 'light') return v
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return 'auto'
}

/**
 * 宿主主题提示：插件面板是**同源 iframe**，可以直接读宿主的 DOM。
 * 先看常见约定（data-theme / .dark/.light class），再用背景亮度兜底 ——
 * 这样不依赖 DSH 内部实现，宿主换方案也不会失效。
 */
export function hostThemeHint() {
  if (window.self === window.top) return null
  try {
    const doc = window.parent.document
    const html = doc.documentElement
    const attr = html.getAttribute('data-theme') || doc.body?.getAttribute('data-theme')
    if (attr === 'light' || attr === 'dark') return attr
    if (html.classList.contains('dark')) return 'dark'
    if (html.classList.contains('light')) return 'light'
    const bg = getComputedStyle(doc.body).backgroundColor
    const nums = bg.match(/\d+/g)
    if (nums && nums.length >= 3) {
      const [r, g, b] = nums.map(Number)
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      if (lum > 0.55) return 'light'
      if (lum < 0.45) return 'dark'
    }
  } catch {
    /* 跨域或宿主还没准备好：退回系统偏好 */
  }
  return null
}

export function resolvedTheme() {
  if (mode !== 'auto') return mode
  return hostThemeHint() ?? (mq.matches ? 'light' : 'dark')
}

export function themeMode() {
  return mode
}

const ICONS = {
  auto: icon('themeAuto'),
  dark: icon('themeDark'),
  light: icon('themeLight'),
}

let currentTheme = null

export function applyTheme() {
  const theme = resolvedTheme()
  const changed = theme !== currentTheme
  currentTheme = theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.innerHTML = ICONS[mode]
    btn.dataset.iconDone = '1'
    const modeText = mode === 'auto' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色'
    const themeText = theme === 'light' ? '浅色' : '深色'
    btn.dataset.tip = `主题：${modeText}（当前${themeText}）`
    btn.setAttribute('aria-label', `主题：${modeText}，点击切换`)
  }
  if (changed) document.dispatchEvent(new CustomEvent('themechange', { detail: { theme, mode } }))
}

export function cycleTheme() {
  mode = mode === 'auto' ? 'dark' : mode === 'dark' ? 'light' : 'auto'
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* ignore */
  }
  applyTheme()
}

let inited = false

export function initTheme() {
  if (inited) return
  inited = true
  applyTheme()
  mq.addEventListener('change', () => {
    if (mode === 'auto') applyTheme()
  })
  // 嵌入在宿主面板里时：宿主换主题不会触发 iframe 的 media query，
  // 轻量轮询宿主状态（1.5s）足够，避免 MutationObserver 跨文档的复杂度。
  if (window.self !== window.top) {
    let last = resolvedTheme()
    let pending = null
    setInterval(() => {
      if (mode !== 'auto') return
      const next = resolvedTheme()
      if (next === last) {
        pending = null
        return
      }
      // 宿主判定可能抖动（背景透明/过渡动画）：连续两次一致才真正切换
      if (pending === next) {
        last = next
        pending = null
        applyTheme()
      } else {
        pending = next
      }
    }, 1500)
  }
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-theme-toggle]') : null
    if (!btn) return
    e.preventDefault()
    cycleTheme()
  })
}
