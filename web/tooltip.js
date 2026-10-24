/**
 * 悬浮提示（全局单例浮层）
 * ======================
 * 为什么不用 CSS `::after`：气泡挂在按钮自身，**贴边会被裁切**，
 * 且无法根据可用空间自动上下翻转。这里用一个全局浮层 + JS 定位：
 *   · 默认在目标下方 8px；下方放不下就翻到上方
 *   · 水平方向夹在视口内（6px 边距），窄面板/贴右边都不会被裁
 *   · 键盘 focus 也能触发（`:focus-visible` 语义由 focusin 近似）
 *   · 120ms 延迟，离开/滚动/点击立即隐藏
 */

const DELAY_MS = 120
const GAP = 8
const EDGE = 6

let tipEl = null
let showTimer = null
let active = null

function ensure() {
  if (tipEl) return tipEl
  tipEl = document.createElement('div')
  tipEl.className = 'bb-tooltip'
  tipEl.id = 'bbTooltip'
  tipEl.setAttribute('role', 'tooltip')
  tipEl.hidden = true
  document.body.appendChild(tipEl)
  return tipEl
}

function place(target) {
  const el = ensure()
  const r = target.getBoundingClientRect()
  const t = el.getBoundingClientRect()
  // 垂直：优先下方，放不下翻到上方；都放不下就贴视口内
  let y = r.bottom + GAP
  if (y + t.height > window.innerHeight - EDGE) {
    const above = r.top - GAP - t.height
    y = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - t.height - EDGE)
  }
  // 水平：以目标中心对齐，再夹进视口
  let x = r.left + r.width / 2 - t.width / 2
  x = Math.min(Math.max(EDGE, x), window.innerWidth - t.width - EDGE)
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(y)}px`
  el.dataset.side = y < r.top ? 'top' : 'bottom'
}

function show(target) {
  const text = target.dataset.tip
  if (!text) return
  const el = ensure()
  el.textContent = text
  el.hidden = false
  place(target)
}

export function hideTooltip() {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
  active = null
  if (tipEl) tipEl.hidden = true
}

function schedule(target) {
  if (target === active) return
  hideTooltip()
  active = target
  showTimer = setTimeout(() => {
    showTimer = null
    if (active === target && target.isConnected) show(target)
  }, DELAY_MS)
}

function tipTarget(node) {
  if (!(node instanceof Element)) return null
  const el = node.closest('[data-tip]')
  return el instanceof HTMLElement ? el : null
}

export function initTooltips() {
  if (initTooltips.done) return
  initTooltips.done = true

  // ── 触摸设备：长按 450ms 显示（没有 hover，只能长按） ──────────────────
  const coarse = window.matchMedia('(hover: none)')
  let touchTimer = null
  let touchShownAt = 0

  const cancelTouch = () => {
    if (touchTimer !== null) {
      clearTimeout(touchTimer)
      touchTimer = null
    }
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch') return
      // 新的触摸开始：先收起旧的
      hideTooltip()
      const target = tipTarget(e.target)
      if (!target) return
      cancelTouch()
      touchTimer = setTimeout(() => {
        touchTimer = null
        show(target)
        touchShownAt = Date.now()
        // 长按后 2.4 秒自动收起（用户也可以点别处收起）
        setTimeout(() => {
          if (Date.now() - touchShownAt >= 2200) hideTooltip()
        }, 2400)
      }, 450)
    },
    true,
  )

  document.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType !== 'touch') return
      cancelTouch()
      // 长按已显示：释放后保留，方便阅读
      if (touchShownAt > 0 && Date.now() - touchShownAt > 300) return
      // 短按：不显示（避免误触）
    },
    true,
  )
  document.addEventListener(
    'pointercancel',
    () => {
      cancelTouch()
      hideTooltip()
    },
    true,
  )
  // 长按时浏览器可能弹上下文菜单，阻止它
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (touchShownAt > 0 && Date.now() - touchShownAt < 2500) e.preventDefault()
    },
    true,
  )

  document.addEventListener('pointerover', (e) => {
    const target = tipTarget(e.target)
    if (!target) return
    // 同一个目标内移动（子节点间）不重开
    if (target.contains(e.relatedTarget)) return
    schedule(target)
  })
  document.addEventListener('pointerout', (e) => {
    const target = tipTarget(e.target)
    if (!target) return
    if (target.contains(e.relatedTarget)) return
    hideTooltip()
  })
  // 键盘：focusin + capture 阶段 focus（某些环境 focusin 不冒泡到 document，双保险）
  const onFocus = (e) => {
    const target = tipTarget(e.target)
    if (target) schedule(target)
  }
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focus', onFocus, true)
  document.addEventListener('focusout', () => hideTooltip())
  // 位置会变或气泡会挡住的时机：一律收起
  document.addEventListener(
    'click',
    () => {
      // 触摸长按后紧接着的 click 不要立刻把气泡收掉
      if (touchShownAt > 0 && Date.now() - touchShownAt < 1500) return
      hideTooltip()
    },
    true,
  )
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') hideTooltip()
  })
  window.addEventListener('scroll', () => hideTooltip(), true)
  window.addEventListener('resize', () => hideTooltip())
}
