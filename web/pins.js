/**
 * 收藏会话（本地持久化）
 * ====================
 * DSH 侧栏有 pinned，我们在面板里也给一个：按 **sessionId** 存 localStorage，
 * 这样文件路径变化（重命名/移动）不影响收藏。
 *
 * 事件：`bb-pins-change`（同页）与 `storage`（跨标签页）都会通知，UI 自行重渲染。
 */
const KEY = 'bb-pins'

export function getPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function isPinned(sessionId) {
  if (!sessionId) return false
  return getPins().includes(sessionId)
}

/** 返回切换后是否处于收藏状态 */
export function togglePin(sessionId) {
  if (!sessionId) return false
  const pins = getPins()
  const at = pins.indexOf(sessionId)
  if (at >= 0) pins.splice(at, 1)
  else pins.unshift(sessionId)
  try {
    localStorage.setItem(KEY, JSON.stringify(pins.slice(0, 200)))
  } catch {
    /* 隐私模式：忽略 */
  }
  dispatchEvent(new CustomEvent('bb-pins-change'))
  return at < 0
}

export function onPinsChange(handler) {
  addEventListener('bb-pins-change', handler)
  addEventListener('storage', (e) => {
    if (e.key === KEY) handler()
  })
}
