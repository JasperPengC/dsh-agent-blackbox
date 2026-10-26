/**
 * agent-blackbox · 浏览器端
 * ========================
 *
 * 性能设计（这是这一版重写的重点）：
 *
 *  1. **静态层缓存**：时间轴的 tool 条 / 阻塞泳道只画一次到离屏 canvas，
 *     每帧只 drawImage + 画播放头。之前是每帧重画 2500 个矩形。
 *  2. **脏标记合并**：所有渲染都进 `mark()`，同一帧内合并成一次；
 *     不再"每改一个值就整块 innerHTML 重排"。
 *  3. **数据流分层**：meta/spans/series 只在数据变化时拉；state 随时刻走；
 *     实时模式只轮询 `/api/live`（单个小请求）。
 *  4. **播放时只做必要工作**：列表/卡片按 8fps 更新，时间轴按 60fps 只画播放头。
 *
 * UX：骨架屏、空态、错误条、抽屉式详情、键盘导航、部分加载提示。
 */

// 性能打点（PerformanceObserver 的 longtask 只能给区间，定位要靠这些 mark）
const mark_ = (name) => {
  try {
    performance.mark('bb:' + name)
  } catch {
    /* ignore */
  }
}
mark_('app-eval-start')

import { cycleTheme, initTheme, resolvedTheme } from './theme.js'
import { hydrateIcons, icon, kindIcon } from './icons.js'
import { initTooltips } from './tooltip.js'
import { getPins, onPinsChange, togglePin } from './pins.js'
import { emptyStateMessage, listNeedsRebuild } from './list-state.js'

import {
  brushWindow,
  isFullWindow,
  intersects,
  panWindow,
  tOf,
  xOf,
  zoomWindow,
} from './timeline-math.js'

const $ = (s) => document.querySelector(s)

// ── 常量 ───────────────────────────────────────────────────────────────────
/** 深/浅两套工具色：浅底上原来的亮色对比度不够，换成同色系的深色版 */
const TOOL_COLORS_DARK = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#e879f9', '#4ade80', '#f87171']
const TOOL_COLORS_LIGHT = ['#0ea5e9', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#f97316', '#06b6d4', '#d946ef', '#22c55e', '#ef4444']
const AGENT_COLORS_LIGHT = ['#0ea5e9', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#f97316', '#06b6d4', '#d946ef']

const isLight = () => resolvedTheme() === 'light'
const toolPalette = () => (isLight() ? TOOL_COLORS_LIGHT : TOOL_COLORS_DARK)

/** canvas 绘制用色（来自 style.css 的 --cv-*，主题切换时重读） */
let CV = {}
function refreshPalette() {
  const cs = getComputedStyle(document.documentElement)
  const g = (n) => cs.getPropertyValue(n).trim()
  CV = {
    grid: g('--cv-grid'),
    text: g('--cv-text'),
    tick: g('--cv-tick'),
    band: g('--cv-band'),
    gapBg: g('--cv-gap-bg'),
    gapHatch: g('--cv-gap-hatch'),
    gapEdge: g('--cv-gap-edge'),
    gapLabelBg: g('--cv-gap-label-bg'),
    gapLabel: g('--cv-gap-label'),
    playhead: g('--cv-playhead'),
    cursor: g('--cv-cursor'),
    brushFill: g('--cv-brush-fill'),
    brushLine: g('--cv-brush-line'),
    fail: g('--cv-fail'),
    cached: g('--cv-cached'),
    cachedArea: g('--cv-cached-area'),
    in: g('--cv-in'),
    inArea: g('--cv-in-area'),
    out: g('--cv-out'),
    outArea: g('--cv-out-area'),
  }
}

/** agent 颜色：浅色主题用深色版（服务端下发的是深色主题调色板） */
function agentColorOf(agentId) {
  const list = meta?.agents || []
  const i = Math.max(0, list.findIndex((a) => a.id === agentId))
  if (isLight()) return AGENT_COLORS_LIGHT[i % AGENT_COLORS_LIGHT.length]
  return list[i]?.color || '#38bdf8'
}
const STATE_LABEL = { idle: '待命', thinking: '思考中', tool: '执行工具', waiting: '等待中', blocked: '被阻塞', done: '完成', failed: '失败' }
const STATE_CLASS = { idle: 's-idle', thinking: 's-thinking', tool: 's-tool', waiting: 's-blocked', blocked: 's-blocked', done: 's-done', failed: 's-blocked' }
const RUNTIME_LABEL = { dsh: 'DSH', 'claude-code': 'Claude Code', codex: 'Codex' }

// ── 格式化 ────────────────────────────────────────────────────────────────
const pad2 = (n) => String(Math.floor(n)).padStart(2, '0')
const fmtT = (ms) => `${pad2(Math.max(0, ms) / 60000)}:${pad2((Math.max(0, ms) % 60000) / 1000)}`
const fmtT1 = (ms) => `${pad2(Math.max(0, ms) / 60000)}:${((Math.max(0, ms) % 60000) / 1000).toFixed(1).padStart(4, '0')}`
const fmtSpan = (ms) => {
  const s = Math.round(Math.max(0, ms) / 1000)
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`
}
const fmtDur = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : fmtSpan(ms))
const fmtTok = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`)
const fmtUsd = (n) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const toolColor = (name) => {
  const palette = toolPalette()
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

// ── 数据访问 ──────────────────────────────────────────────────────────────
const SAVED_FILE_KEY = 'bb-file'
let savedFile = null

function sessionFile() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('file')
    if (fromUrl) return fromUrl
  } catch {
    /* ignore */
  }
  return savedFile
}

/**
 * 恢复上次选择的会话。
 * 插件面板的 iframe src 是固定的 `/blackbox/?embed=1`，重新打开面板会丢掉 URL 上的 ?file=，
 * 所以选择必须存 localStorage；这里用一次 meta 请求校验文件还在，再写回 URL。
 */
async function restoreSavedSession() {
  const fromUrl = new URLSearchParams(location.search).get('file')
  if (fromUrl) {
    try {
      localStorage.setItem(SAVED_FILE_KEY, fromUrl)
    } catch {
      /* ignore */
    }
    return
  }
  let saved = null
  try {
    saved = localStorage.getItem(SAVED_FILE_KEY)
  } catch {
    return
  }
  if (!saved) return
  try {
    const res = await fetch(`api/meta?file=${encodeURIComponent(saved)}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    if (data?.file !== saved) throw new Error('not found')
    savedFile = saved
    const url = new URL(location.href)
    url.searchParams.set('file', saved)
    history.replaceState(null, '', url.toString())
  } catch {
    try {
      localStorage.removeItem(SAVED_FILE_KEY)
    } catch {
      /* ignore */
    }
  }
}
function withFile(path) {
  const file = sessionFile()
  const sep = path.includes('?') ? '&' : '?'
  return file === null || file === '' ? path : `${path}${sep}file=${encodeURIComponent(file)}`
}
async function api(path) {
  const res = await fetch(withFile(path), { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

// ── 状态 ──────────────────────────────────────────────────────────────────
let meta = null
let state = null
let attr = null
let spans = []
let series = []
let windowEvents = []
let eventsMeta = { count: 0, from: 0, to: 0 }
let eventsReq = 0
let eventsTimer = null
let currentT = 0
let view = { from: 0, to: 0 }
let brushRange = null
let playing = false
let following = true
/** 焦点跟随：播放/跟随时跳过空闲 + 自动滚动高亮当前焦点（可开关，F 键/LocalStorage） */
let focusMode = true
try { focusMode = localStorage.getItem('bb-focus') !== 'off' } catch { /* ignore */ }
/** 所有"有活动"的时间点（事件 + 工具起止），用于播放时跳过空闲 */
let activityTimes = []
let lastSkipToastAt = 0
let lastFocusAt = 0
let lastFocusClearAt = 0
let speed = 2
let tab = 'events'
let search = ''
let activeKinds = new Set()
let onlyFail = false
let wfTool = null
let cursorIndex = -1
let visibleRows = []
let drawerData = null
let seekSeq = 0
let lastSeekAt = 0
let lastListAt = 0
let lastPlayingTick = 0

// ── 调度器：所有渲染走脏标记，同一帧合并 ───────────────────────────────────
const dirty = new Set()
let flushScheduled = false
const renderers = {
  chrome: renderChrome,
  kpis: renderKpis,
  spark: renderSpark,
  agents: renderAgents,
  attribution: renderAttribution,
  railmeta: renderRailMeta,
  stagefeed: renderStageFeed,
  waterfall: renderWaterfall,
  list: renderList,
  timelineStatic: invalidateTimeline,
}
const renderTimings = {}

/**
 * 重的渲染器（画布 / 曲线）推到下一帧。
 * 首屏一次要跑 7 个渲染器，全挤在一帧里可能堆出 >50ms 的长任务；
 * 拆成「本帧（DOM 列表/卡片）+ 下一帧（画布）」两批，最坏情况减半。
 */
const HEAVY_RENDERERS = new Set(['spark', 'timelineStatic'])

function runRenderer(k) {
  const fn = renderers[k]
  if (!fn) return
  const t0 = performance.now()
  fn()
  renderTimings[k] = Number((performance.now() - t0).toFixed(2))
}

function mark(...kinds) {
  for (const k of kinds) dirty.add(k)
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(() => {
    flushScheduled = false
    const batch = [...dirty]
    dirty.clear()
    const heavy = batch.filter((k) => HEAVY_RENDERERS.has(k))
    for (const k of batch) {
      if (!HEAVY_RENDERERS.has(k)) runRenderer(k)
    }
    if (heavy.length > 0) {
      requestAnimationFrame(() => {
        for (const k of heavy) runRenderer(k)
      })
    }
  })
}

// ── 可及性：焦点管理 ──────────────────────────────────────────────────────
let lastFocus = null

function focusablesIn(root) {
  const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll(sel)].filter((el) => !el.disabled && el.offsetParent !== null)
}

/** 让 Tab / Shift+Tab 在容器内循环（模态对话框必须） */
function trapTab(ev, root) {
  if (ev.code !== 'Tab') return
  const list = focusablesIn(root)
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault()
    last.focus()
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault()
    first.focus()
  }
}

// ── 启动状态 / 看门狗 ─────────────────────────────────────────────────────
let bootTimer = null
let bootWatchdog = null
let bootStartedAt = 0
let dataReady = false

function startBootStatus() {
  bootStartedAt = performance.now()
  // 计时/慢提示由 index.html 的内联脚本负责（即使 app.js 加载失败也能工作）；
  // 这里只保留"应用已启动但数据 8s 没到"的看门狗。
  bootWatchdog = setTimeout(() => {
    if (dataReady) return
    showError(new Error('加载超时：会话索引 8 秒内没有就绪，可能是文件过大或服务未响应。'))
  }, 8000)
}

function markDataReady() {
  if (dataReady) return
  dataReady = true
  if (bootTimer !== null) {
    clearInterval(bootTimer)
    bootTimer = null
  }
  if (bootWatchdog !== null) {
    clearTimeout(bootWatchdog)
    bootWatchdog = null
  }
  document.getElementById('bootSkeleton')?.remove()
  if (typeof window.__bbBootDone === 'function') window.__bbBootDone()
  mark('boot-ready')
}

// ── 会话切换器 ────────────────────────────────────────────────────────────
let swSessions = null
let swFiltered = []
let swIndex = 0
let dataGen = 0
let liveTimer = null

const RUNTIME_SHORT = { dsh: 'DSH', 'claude-code': 'Claude', codex: 'Codex' }

function relTime(ms) {
  const d = Date.now() - ms
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`
  return `${Math.round(d / 86_400_000)} 天前`
}

async function ensureSessions() {
  if (swSessions) return swSessions
  const res = await fetch(withFile('api/sessions'), { cache: 'no-store' })
  if (!res.ok) throw new Error(`api/sessions → ${res.status}`)
  const data = await res.json()
  swSessions = Array.isArray(data.sessions) ? data.sessions : []
  return swSessions
}

function renderSwitcherList(q = '') {
  const query = q.trim().toLowerCase()
  // 没带 ?file= 时服务端用默认会话：用 meta.file 标记"当前"
  const current = sessionFile() || meta?.file || null
  const all = swSessions || []
  const pinned = new Set(getPins())

  const match = (s) =>
    query === '' ||
    `${s.title ?? ''} ${s.project} ${s.sessionId} ${RUNTIME_SHORT[s.runtime] ?? s.runtime}`.toLowerCase().includes(query)

  // 分组：收藏 → 最近使用（5）→ 按项目（都排除已收藏/已进最近的）
  let sections = null
  if (query === '') {
    const favs = all.filter((s) => pinned.has(s.sessionId))
    const restAfterFav = all.filter((s) => !pinned.has(s.sessionId))
    const recent = restAfterFav.slice(0, 5)
    const rest = restAfterFav.slice(5)
    const groups = new Map()
    for (const s of rest) {
      const key = s.project || '未分组'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(s)
    }
    sections = [
      ...(favs.length > 0 ? [{ title: '收藏', items: favs, kind: 'pinned' }] : []),
      { title: '最近使用', items: recent },
      ...[...groups].map(([title, items]) => ({ title, items })),
    ]
    swFiltered = [...favs, ...recent, ...rest]
  } else {
    swFiltered = all.filter(match)
  }
  swIndex = Math.min(swIndex, Math.max(0, swFiltered.length - 1))

  const list = $('#switchList')
  if (!list) return
  if (swFiltered.length === 0) {
    list.innerHTML = `<div class="empty empty-lg">${icon('search', '', 20)}<span>没有匹配的会话</span></div>`
    return
  }

  const rowHTML = (s, i) => {
    const short = String(s.sessionId).replace(/^session-/, '').slice(0, 8)
    const title = s.title || '未命名会话'
    const fav = pinned.has(s.sessionId)
    return `<div class="sw-row ${i === swIndex ? 'on' : ''} ${s.file === current ? 'current' : ''}" data-i="${i}" data-file="${esc(s.file)}" data-sid="${esc(s.sessionId)}" role="option" tabindex="-1">
      <span class="chip rt-${esc(s.runtime)} sw-rt" data-tip="${esc(RUNTIME_LABEL[s.runtime] ?? s.runtime)}">${esc(RUNTIME_SHORT[s.runtime] ?? s.runtime)}</span>
      <span class="sw-main">
        <span class="sw-title">${esc(title)}</span>
        <span class="sw-sub">${esc(s.project || '—')} · ${esc(short)}</span>
      </span>
      <span class="sw-right">
        <button class="sw-pin ${fav ? 'on' : ''}" data-pin="${esc(s.sessionId)}" data-tip="${fav ? '取消收藏' : '收藏会话'}" aria-label="${fav ? '取消收藏' : '收藏会话'}">${icon(fav ? 'star' : 'starOff', '', 13)}</button>
        <span class="sw-time">${relTime(s.mtime)}</span>
      </span>
    </div>`
  }

  if (sections === null) {
    list.innerHTML = swFiltered.map(rowHTML).join('')
  } else {
    let i = 0
    list.innerHTML = sections
      .filter((sec) => sec.items.length > 0)
      .map(
        (sec) =>
          `<div class="sw-group">${esc(sec.title)}<em>${sec.items.length}</em></div>` +
          sec.items.map((s) => rowHTML(s, i++)).join(''),
      )
      .join('')
  }

  list.querySelectorAll('.sw-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest?.('.sw-pin')) return
      void switchSession(row.dataset.file)
    })
    row.addEventListener('mouseenter', () => {
      swIndex = Number(row.dataset.i)
      list.querySelectorAll('.sw-row').forEach((r) => r.classList.toggle('on', r === row))
    })
  })
  list.querySelectorAll('.sw-pin').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePin(btn.dataset.pin)
      renderSwitcherList($('#switchSearch')?.value ?? '')
    })
  })
  list.querySelector('.sw-row.on')?.scrollIntoView({ block: 'nearest' })
}

async function openSwitcher() {
  const panel = $('#switcher')
  if (!panel) return
  panel.hidden = false
  $('#switchSearch').value = ''
  swIndex = 0
  // 列表还在扫盘：先给骨架，不要空白
  if (!swSessions) {
    $('#switchList').innerHTML = Array.from({ length: 8 }, () => '<div class="sk-row" style="margin:8px 9px"></div>').join('')
  }
  try {
    await ensureSessions()
    renderSwitcherList('')
  } catch (err) {
    $('#switchList').innerHTML = `<div class="empty empty-lg">${icon('alert', '', 20)}<span>加载会话列表失败：${esc(String(err))}</span></div>`
  }
  $('#switchSearch')?.focus()
}

function closeSwitcher() {
  const panel = $('#switcher')
  if (panel) panel.hidden = true
  $('#sessionSwitch')?.focus()
}

function isSwitcherOpen() {
  const panel = $('#switcher')
  return !!panel && !panel.hidden
}

/** 原地切换会话：不刷新页面，重载数据后重新渲染 */
async function switchSession(file) {
  if (!file) return
  closeSwitcher()
  if (file === sessionFile()) return
  setPlaying(false)
  following = false
  if (liveTimer !== null) {
    clearInterval(liveTimer)
    liveTimer = null
  }
  dataGen++
  // 重置数据层（保留筛选/标签页等 UI 偏好）
  meta = null
  state = null
  attr = null
  spans = []
  series = []
  windowEvents = []
  eventsMeta = { count: 0, from: 0, to: 0 }
  view = { from: 0, to: 0 }
  currentT = 0
  brushRange = null
  wfTool = null
  cursorIndex = -1
  visibleRows = []
  staticDirty = true
  // 上一个会话的渲染签名/列表缓存不能带到新会话（否则会被"没变化"跳过）
  renderSig.clear()
  listHTML = ''
  lastListFirstSeq = ''
  const listEl = document.getElementById('rlist')
  if (listEl) listEl.dataset.total = ''
  const url = new URL(location.href)
  url.searchParams.set('file', file)
  url.searchParams.delete('t')
  url.searchParams.delete('from')
  url.searchParams.delete('to')
  history.replaceState(null, '', url.toString())
  dataReady = false
  armLoadingNotice()
  try {
    await loadStatic()
    // 默认跟随最新：切会话后不要停留在"不跟随"的状态
    following = true
    await seek(meta.duration)
    mark(...Object.keys(renderers))
    markDataReady()
    if (meta.follow) liveTimer = setInterval(liveTick, 800)
  } catch (err) {
    showError(err)
  }
}

// ── 首次使用引导 ──────────────────────────────────────────────────────────
const ONBOARD_KEY = 'bb-onboarded'

function showOnboard(force = false) {
  // 插件面板里不弹首访引导：外层已有面板 chrome，引导会挡住内容且每次新环境都弹
  if (EMBED) return
  const el = $('#onboard')
  if (!el) return
  // 截图 / 自动化 / 教学场景可以关掉：?onboard=off
  try {
    if (new URLSearchParams(location.search).get('onboard') === 'off' && !force) return
  } catch {
    /* ignore */
  }
  if (!force) {
    try {
      if (localStorage.getItem(ONBOARD_KEY)) return
    } catch {
      /* ignore */
    }
  }
  lastFocus = document.activeElement
  el.hidden = false
  $('#onboardOk')?.focus()
}

function hideOnboard() {
  const el = $('#onboard')
  if (!el || el.hidden) return
  el.hidden = true
  try {
    localStorage.setItem(ONBOARD_KEY, '1')
  } catch {
    /* ignore */
  }
  ;(lastFocus ?? $('#btnHelp'))?.focus()
}

// ── 帮助层 ────────────────────────────────────────────────────────────────
function toggleHelp(force) {
  const panel = $('#helpPanel')
  if (!panel) return
  const open = typeof force === 'boolean' ? force : panel.hidden
  // 引导和帮助不同时显示（否则两层遮罩叠在一起）
  if (open) hideOnboard()
  if (open) lastFocus = document.activeElement
  panel.hidden = !open
  $('#btnHelp')?.setAttribute('aria-expanded', String(open))
  if (open) $('#helpClose')?.focus()
  else (lastFocus ?? $('#btnHelp'))?.focus()
}

function isHelpOpen() {
  const panel = $('#helpPanel')
  return !!panel && !panel.hidden
}

// ── 索引补齐（快照首屏） ──────────────────────────────────────────────────
function setIndexChip(on) {
  const chip = $('#indexChip')
  if (chip) chip.hidden = !on
}

/**
 * 快照首屏：先用缓存的小快照（meta/series/spans/state/events）渲染，
 * 完整索引在后台构建；这里轮询到就绪后热替换一次。
 */
async function pollIndexReady() {
  const gen = dataGen
  for (let i = 0; i < 240; i++) {
    if (gen !== dataGen) return
    await sleep(250)
    try {
      const m = await api('api/meta')
      if (m.loading === true) continue
      setIndexChip(false)
      await refreshStatic()
      await seek(clamp(currentT, 0, meta.duration))
      scheduleWindowEvents()
      mark(...Object.keys(renderers))
      return
    } catch {
      /* 单个请求失败无所谓，继续等 */
    }
  }
  setIndexChip(false)
}

// ── 时间窗 ────────────────────────────────────────────────────────────────
function setView(next) {
  if (!meta) return
  view = next
  try {
    const url = new URL(location.href)
    if (isFullWindow(view, meta.duration)) {
      url.searchParams.delete('from')
      url.searchParams.delete('to')
    } else {
      url.searchParams.set('from', String(Math.round(view.from)))
      url.searchParams.set('to', String(Math.round(view.to)))
    }
    history.replaceState(null, '', url.toString())
  } catch {
    /* 沙箱里可能不允许，忽略 */
  }
  staticDirty = true
  mark('waterfall', 'chrome', 'list')
  renderWindowChip()
  scheduleWindowEvents()
}

function ensureVisible(t) {
  if (!meta) return
  if (t >= view.from && t <= view.to) return
  const span = Math.max(200, view.to - view.from)
  let from = t - span / 2
  if (from < 0) from = 0
  if (from + span > meta.duration) from = Math.max(0, meta.duration - span)
  setView({ from, to: Math.min(meta.duration, from + span) })
}

function resetView() {
  if (meta) setView({ from: 0, to: meta.duration })
}

function zoomAt(anchorT, factor) {
  if (!meta) return
  setView(zoomWindow(view, meta.duration, anchorT, factor))
}

function renderWindowChip() {
  const chip = $('#winChip')
  if (!chip || !meta) return
  const full = isFullWindow(view, meta.duration)
  const label = chip.querySelector('.lbl')
  const text = full ? '全量' : `窗口 ${fmtDur(view.to - view.from)}`
  if (label) label.textContent = text
  else chip.textContent = text
  chip.classList.toggle('on', !full)
  chip.title = full ? '当前显示全部时间（滚轮缩放 / 拖拽框选）' : `${fmtSpan(view.from)} – ${fmtSpan(view.to)} · 双击时间轴复位`
}

/** 空闲占比：整段会话里没有被工具调用/事件覆盖的时间百分比 */
function idleRatio() {
  const total = meta?.duration || 0
  if (!total) return null
  const coverage = spans.length > 0 ? spans : windowEvents.map((e) => ({ start: e.t, end: e.t }))
  if (coverage.length === 0) return 100
  const intervals = coverage
    .map((s) => [Math.max(0, s.start), Math.min(total, s.end ?? s.start)])
    .sort((a, b) => a[0] - b[0])
  let covered = 0
  let cursor = 0
  for (const [a, b] of intervals) {
    const from = Math.max(a, cursor)
    if (b > from) {
      covered += b - from
      cursor = b
    }
  }
  return Math.round((1 - covered / total) * 100)
}

// ── 嵌入模式 ──────────────────────────────────────────────────────────────
/**
 * 在 DSH 插件面板里，外层已经有品牌/标题/window 控件。
 * 如果把整页原样塞进 iframe，会出现**两层顶栏**、浪费 52px 高度。
 * 所以：带 ?embed=1 或"页面被 iframe 包着"时，隐藏自己的顶栏，
 * 改成右下角一个极简悬浮条（总览 / 对比 / 全屏）。
 */
const EMBED = new URLSearchParams(location.search).has('embed') || window.self !== window.top

function setupEmbed() {
  if (!EMBED) return
  document.documentElement.classList.add('embed')
  // 插件面板里没有首访引导：给一条一次性快捷键提示（8 秒或点"知道了"消失）
  try {
    if (localStorage.getItem('bb-embed-hint') !== 'off') {
      const hint = document.getElementById('embedHint')
      if (hint) {
        hint.hidden = false
        const hide = () => {
          hint.hidden = true
          try {
            localStorage.setItem('bb-embed-hint', 'off')
          } catch {
            /* ignore */
          }
        }
        document.getElementById('embedHintClose')?.addEventListener('click', hide)
        setTimeout(hide, 8000)
      }
    }
  } catch {
    /* ignore */
  }
  // 嵌入态已经有 38px 会话条，底部不再放悬浮 dock（会和内容抢位置）
}

// ── 启动 ──────────────────────────────────────────────────────────────────
mark_('app-eval-end')

// ── 外壳分帧挂载 ──────────────────────────────────────────────────────────
/**
 * 三个面板放在 <template> 里（惰性，不参与布局），一帧挂一个。
 * 目的：把"一次性布局整页"（实测 60~100ms，Long Tasks 记为长任务）
 * 拆成 3 个短任务。先挂中栏（信息密度最高），再左栏、右栏。
 */
const SHELL_TEMPLATES = ['tplStage', 'tplRail', 'tplInspector']

function nextFrame() {
  // 隐藏 iframe / 后台标签页里 rAF 可能不触发：加超时兜底，避免挂载卡死
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    requestAnimationFrame(() => {
      clearTimeout(timer)
      finish()
    })
  })
}

async function mountShell() {
  const main = document.querySelector('main')
  if (!main) return
  // 真实外壳接管：移除静态启动骨架
  main.classList.remove('has-boot')
  main.removeAttribute('aria-busy')
  main.innerHTML = ''
  for (const id of SHELL_TEMPLATES) {
    const tpl = document.getElementById(id)
    if (tpl && tpl.content) main.appendChild(tpl.content.cloneNode(true))
    await nextFrame()
  }
}

async function init() {
  mark_('init-start')
  startBootStatus()
  hydrateIcons()
  initTheme()
  initTooltips()
  refreshPalette()
  onPinsChange(() => {
    if (isSwitcherOpen()) renderSwitcherList($('#switchSearch')?.value ?? '')
    mark('list')
  })
  document.addEventListener('themechange', () => {
    refreshPalette()
    staticDirty = true
    mark('spark', 'timelineStatic', 'waterfall', 'list')
  })
  setupEmbed()
  // 外壳分帧挂载（模板 → 真实 DOM），挂完再绑事件（监听器目标都来自模板）
  await mountShell()
  hydrateIcons()
  mark_('shell-mounted')
  bindEvents()
  // 先把渲染循环跑起来（骨架屏在动），数据到了再填 —— 不要等数据才画第一帧
  requestAnimationFrame(loop)
  mark_('bind-end')
  await restoreSavedSession()
  try {
    await loadStatic()
    mark_('load-static-end')
    const params = new URLSearchParams(location.search)
    const deep = params.get('t')
    if (deep !== null && Number.isFinite(Number(deep))) {
      following = false
      await seek(Number(deep))
      applyWindowParams(params)
    } else if (meta.follow) {
      await seek(meta.duration)
    } else {
      await seek(meta.duration)
      applyWindowParams(params)
    }
  } catch (err) {
    showError(err)
  }
  if (meta) {
    markDataReady()
    disarmLoadingNotice()
  }
  mark(...Object.keys(renderers))
  requestAnimationFrame(() => {
    mark_('first-data-frame')
    // 首次使用引导：数据出来后再显示，避免挡住加载过程
    if (meta && meta.eventCount > 0) showOnboard()
  })
  if (meta?.follow) liveTimer = setInterval(liveTick, 800)
}

function applyWindowParams(params) {
  const fromParam = Number(params.get('from'))
  const toParam = Number(params.get('to'))
  if (Number.isFinite(fromParam) && Number.isFinite(toParam) && toParam > fromParam) {
    setView({ from: Math.max(0, fromParam), to: Math.min(meta.duration, toParam) })
  }
}

let loadingTimer = null
function armLoadingNotice() {
  if (loadingTimer !== null) clearTimeout(loadingTimer)
  loadingTimer = setTimeout(() => {
    const notice = $('#notice')
    if (!notice.hidden) return
    $('#noticeText').textContent = '正在解码会话…（大会话首次打开需要 1~2 秒，之后走缓存）'
    $('#noticeAction').hidden = true
    notice.hidden = false
  }, 400)
}

function disarmLoadingNotice() {
  if (loadingTimer !== null) {
    clearTimeout(loadingTimer)
    loadingTimer = null
  }
  const notice = $('#notice')
  if (notice && $('#noticeAction').textContent !== '加载全部') notice.hidden = true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function loadStatic() {
  armLoadingNotice()
  document.querySelector('main')?.setAttribute('aria-busy', 'true')
  // 大会话的索引在 worker 里构建：先拿到 loading=true 的元信息，
  // 轮询到就绪再取 spans/series —— 主线程全程不被冻住。
  // 服务端在构建期间会挂住请求（长轮询），所以这里通常一次就拿到就绪数据；
  // 仍保留重试兜底（例如构建失败后回退）。
  let m = await api('api/meta')
  // 快照命中：首屏数据已经可用，索引在后台补（服务端返回 snapshot:true + loading:true）
  const snapshotMode = m.loading === true && m.snapshot === true
  if (snapshotMode) {
    setIndexChip(true)
  } else {
    let tries = 0
    while (m.loading === true && tries++ < 3) {
      await sleep(200)
      m = await api('api/meta')
    }
    if (m.loading === true) throw new Error('会话解码超时')
  }
  const [sp, se] = await Promise.all([api('api/spans?limit=2500'), api('api/series?buckets=140')])
  // 数据就绪：先测量尺寸（此刻才需要），再单独一帧分配画布
  // （Retina 下 backing store 是 3200×2000 级、~25MB，不能和数据渲染挤在同一任务）
  requestAnimationFrame(() => {
    observeTimelineSize()
    allocTimelineCanvas()
    drawTimelineFrame()
  })
  disarmLoadingNotice()
  document.querySelector('main')?.removeAttribute('aria-busy')
  meta = m
  spans = sp.spans
  series = se.buckets
  rebuildActivityTimes()
  if (view.to <= view.from) view = { from: 0, to: meta.duration }
  if (meta?.partial) showPartial()
  applyDensity()
  scheduleWindowEvents()
  if (snapshotMode) void pollIndexReady()
  mark('chrome', 'spark', 'waterfall', 'timelineStatic', 'stagefeed')
}

async function refreshStatic() {
  const [m, sp, se] = await Promise.all([
    api('api/meta'),
    api('api/spans?limit=2500'),
    api('api/series?buckets=140'),
  ])
  const spanChanged = sp.spans.length !== spans.length
  meta = m
  spans = sp.spans
  series = se.buckets
  rebuildActivityTimes()
  mark('chrome', 'spark', 'waterfall', 'timelineStatic')
  if (spanChanged) mark('list')
}

async function seek(t) {
  const target = clamp(t, 0, meta ? meta.duration : 0)
  // 跳到窗口外（比如从事件列表点一条久远的事件）→ 平移窗口把它包进来，
  // 保持当前缩放级别；直接复位到全量会让人"刚缩好的窗口没了"
  ensureVisible(target)
  currentT = target
  lastSeekAt = performance.now()
  const my = ++seekSeq
  try {
    const r = await api(`api/state?t=${Math.round(target)}`)
    if (my !== seekSeq) return
    state = r.state
    attr = r.attribution
    mark('agents', 'attribution', 'kpis', 'chrome', 'list')
    if (playing) mark('waterfall')
    else scheduleWindowEvents()
    if (focusMode && (playing || (following && meta?.follow))) updateFocus(target)
  } catch {
    /* 文件正在写时的瞬时失败，下一轮会补上 */
  }
}

// ── 焦点跟随：开关 ─────────────────────────────────────────────────────────
function toggleFocusMode() {
  focusMode = !focusMode
  try {
    localStorage.setItem('bb-focus', focusMode ? 'on' : 'off')
  } catch {
    /* ignore */
  }
  $('#btnFocus')?.classList.toggle('on', focusMode)
  if (focusMode) {
    rebuildActivityTimes()
    updateFocus(currentT)
    showToast('焦点跟随：开（跳过空闲 + 自动高亮）')
  } else {
    clearFocus()
    showToast('焦点跟随：关')
  }
}

// ── 焦点跟随：活动时间点 ───────────────────────────────────────────────────
function rebuildActivityTimes() {
  const set = new Set()
  for (const sp of spans) {
    set.add(Math.round(sp.start))
    if (sp.end !== null) set.add(Math.round(sp.end))
  }
  for (const e of windowEvents) set.add(Math.round(e.t))
  activityTimes = [...set].sort((a, b) => a - b)
}

/** 找到 t 之后的第一个活动时间（没有则 null） */
function nextActivityAfter(t) {
  let lo = 0
  let hi = activityTimes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (activityTimes[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo < activityTimes.length ? activityTimes[lo] : null
}

function maybeSkipToast(gap) {
  const now = performance.now()
  if (gap < 3000 || now - lastSkipToastAt < 2200) return
  lastSkipToastAt = now
  showToast(`跳过 ${fmtDur(gap)} 空闲`)
}

/** 清除所有焦点高亮 */
function clearFocus() {
  lastFocusKey = ''
  document.querySelectorAll('.is-focus').forEach((el) => el.classList.remove('is-focus'))
  delete document.body.dataset.focusAgent
  delete document.body.dataset.focusWf
  delete document.body.dataset.focusList
}

/**
 * 焦点跟随：把"当前播放头"对应的工具 / 事件 / agent 滚动到视野并高亮。
 * 只在播放中或跟随最新时调用，避免干扰手动浏览。
 */
let lastFocusKey = ''
function updateFocus(t) {
  if (!focusMode) return
  const now = performance.now()
  if (now - lastFocusAt < 150) return
  lastFocusAt = now

  // 当前工具；没有正在执行的就退到"最近一个已开始的工具"，保证焦点连续不消失
  let activeSpan = null
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i]
    if (!sp || sp.start > t) continue
    if (sp.end !== null && sp.end < t - 250) {
      activeSpan = sp
      break
    }
    activeSpan = sp
    break
  }

  // ── 先算出三个焦点，只有变化时才动 DOM ──────────────────────────────
  let wfIdx = -1
  if (wfRows.length > 0 && activeSpan) {
    for (let i = wfRows.length - 1; i >= 0; i--) {
      if (wfRows[i] && wfRows[i].start <= t + 1) { wfIdx = i; break }
    }
  }
  let listIdx = -1
  if (tab === 'events' && visibleRows.length > 0) {
    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i]
      if ((row.t ?? row.start ?? 0) <= t + 1) { listIdx = i; break }
    }
  }
  let agent = null
  if (state?.agents) {
    const busy = Object.values(state.agents).find((a) => {
      const st = a.state
      return st !== 'idle' && st !== 'done' && st !== undefined
    })
    if (busy) agent = busy.agent
  }
  if (!agent) {
    const latest = visibleRows.find((row) => (row.t ?? row.start ?? Infinity) <= t + 1) ?? windowEvents[0]
    agent = latest?.agent ?? latest?.session
  }

  const key = `${agent ?? ''}|${wfIdx}|${listIdx}`
  if (key === lastFocusKey) return
  lastFocusKey = key

  // 工具瀑布：高亮通过移动 class 完成；只有目标行还没渲染时才滚动+重画
  const wf = document.getElementById('waterfall')
  if (wf && wfIdx >= 0) {
    document.body.dataset.focusWf = String(wfIdx)
    const row = wf.querySelector(`.wf-row[data-i="${wfIdx}"]`)
    if (row) {
      wf.querySelectorAll('.wf-row.is-focus').forEach((el) => el.classList.remove('is-focus'))
      row.classList.add('is-focus')
    } else {
      const target = Math.max(0, wfIdx * WF_ROW_H - wf.clientHeight / 2 + WF_ROW_H * 2)
      if (Math.abs(wf.scrollTop - target) > 40) {
        wf.scrollTop = target
        paintWaterfallWindow()
        wf.querySelector(`.wf-row[data-i="${wfIdx}"]`)?.classList.add('is-focus')
      }
    }
  }

  // 事件列表：同样只移动高亮；目标行不在当前渲染窗口里才滚动重画
  const rl = document.getElementById('rlist')
  if (rl && listIdx >= 0) {
    document.body.dataset.focusList = String(listIdx)
    let rowEl = document.getElementById(`rrow-${listIdx}`)
    if (!rowEl) {
      const target = Math.max(0, listIdx * LIST_ROW_H - rl.clientHeight / 2 + LIST_ROW_H * 2)
      if (Math.abs(rl.scrollTop - target) > 30) {
        rl.scrollTop = target
        paintListWindow()
        rowEl = document.getElementById(`rrow-${listIdx}`)
      }
    }
    rl.querySelectorAll('.rrow.is-focus').forEach((el) => el.classList.remove('is-focus'))
    rowEl?.classList.add('is-focus')
  }

  if (agent) {
    document.body.dataset.focusAgent = String(agent)
    const card = [...document.querySelectorAll('.agent-card')].find((el) => el.dataset.agent === String(agent))
    card?.classList.add('is-focus')
  }

  // 缩放窗口下让播放头保持在视野里（避免播放头跑出窗口后内容看似不动）
  if (meta && playing && isFullWindow(view, meta.duration) === false) {
    const spanW = view.to - view.from
    if (t > view.to - spanW * 0.08) {
      setView({ from: t - spanW * 0.2, to: t + spanW * 0.8 })
    }
  }
}

/**
 * 回放/实时跟随时，工具瀑布与事件列表只展示"播放头之前"的内容，
 * 随着播放逐步揭示 —— 否则回放时整窗内容一直是满的，看不出时间推进。
 * 手动 seek/暂停时保持完整窗口，方便浏览。
 */
function revealMode() {
  return playing || (following && meta?.follow)
}

// ── 渲染签名（避免"数据没变还整块 innerHTML 重建"造成的闪烁/掉帧）───────
const renderSig = new Map()
/** 返回 true 表示"和上次一样，可以跳过渲染" */
function unchanged(key, sig) {
  if (renderSig.get(key) === sig) return true
  renderSig.set(key, sig)
  return false
}

// ── 主循环 ────────────────────────────────────────────────────────────────
let lastFrame = performance.now()
let lastSparkAt = 0
let lastEventsFetch = 0
let needFrame = true
function loop(now) {
  const dt = Math.min(120, now - lastFrame)
  lastFrame = now

  if (playing && meta) {
    // 焦点跟随：如果接下来一大段没有活动，直接跳到下一个活动点（留 150ms 余量）
    const next = focusMode ? nextActivityAfter(currentT + 1) : null
    const hasNext = typeof next === 'number' && Number.isFinite(next)
    if (focusMode && hasNext && next - currentT > 1500) {
      const idleAhead = next - currentT
      currentT = Math.min(meta.duration, Math.max(0, next - 150))
      maybeSkipToast(idleAhead)
    } else if (focusMode && !hasNext && meta.duration - currentT > 1500) {
      // 后面没有活动了：直接到结尾，不弹「跳过」提示（避免 Infinity:NaN:NaN）
      currentT = meta.duration
    } else {
      currentT += dt * speed
    }
    if (currentT >= meta.duration) {
      currentT = meta.duration
      setPlaying(false)
    }
    if (now - lastSeekAt > 110) void seek(currentT)
  }
  // 注意：following 默认是 true，但只有"实时会话"才需要持续追踪；
  // 静态会话每帧重绘会把瀑布行刷成闪烁
  if (focusMode && (playing || (following && meta?.follow))) updateFocus(currentT)

  // 时间轴每帧只画播放头；静态层已缓存
  drawTimelineFrame()
  updateClock()
  if (now - lastPlayingTick > 100) {
    lastPlayingTick = now
    paintRunningRows()
    paintPlayheadDependents()
  }
  if (playing && now - lastSparkAt > 300) {
    lastSparkAt = now
    mark('spark')
  }
  // 回放时事件窗口要跟着播放头推进（否则列表停在旧位置/为空）
  if (playing && revealMode() && now - lastEventsFetch > 700) {
    lastEventsFetch = now
    scheduleWindowEvents()
  }
  requestAnimationFrame(loop)
}

let lastClockText = ''
function updateClock() {
  const text = fmtT1(currentT)
  if (text === lastClockText) return
  lastClockText = text
  $('#clock').textContent = text
  $('#tlabel').textContent = text
}

// ── 窗口事件（突破"只看最近 N 条"） ───────────────────────────────────────
const EVENTS_LIMIT = 400

function scheduleWindowEvents() {
  if (eventsTimer !== null) clearTimeout(eventsTimer)
  eventsTimer = setTimeout(() => {
    eventsTimer = null
    void loadWindowEvents()
  }, 160)
}

async function loadWindowEvents() {
  if (!meta) return
  const my = ++eventsReq
  const from = Math.round(view.from)
  // 回放/实时跟随：请求到播放头为止（服务端返回的是 [from,to] 内最后 N 条，
  // 如果 to=窗口末尾，早期回放拿到的全是"未来事件"，揭示过滤后就永远是空的）
  const to = revealMode() ? Math.round(Math.max(from + 1, Math.min(view.to, currentT + 1))) : Math.round(view.to)
  try {
    const res = await api(`api/events?from=${from}&to=${to}&limit=${EVENTS_LIMIT}`)
    if (my !== eventsReq) return
    windowEvents = res.events || []
    eventsMeta = { count: res.count ?? windowEvents.length, from, to }
    rebuildActivityTimes()
    mark('list', 'stagefeed')
  } catch {
    /* 文件正在写时忽略 */
  }
}

// ── 实时 ──────────────────────────────────────────────────────────────────
/** 保证 follow 会话的轮询循环在跑（初始化时 meta 可能还是快照，follow 尚未就绪） */
function ensureLiveLoop() {
  if (!meta) return
  if (meta.follow && liveTimer === null) liveTimer = setInterval(liveTick, 800)
  if (!meta.follow && liveTimer !== null) {
    clearInterval(liveTimer)
    liveTimer = null
  }
}

async function liveTick() {
  if (!meta?.follow) return
  try {
    const l = await api('api/live')
    if (l.eventCount === (meta.eventCount ?? -1)) return
    await refreshStatic()
    if (following) await seek(meta.duration)
    scheduleWindowEvents()
  } catch { /* 忽略瞬时错误 */ }
}

function setPlaying(v) {
  playing = v
  document.body.classList.toggle('is-playing', v)
  // 暂停后恢复完整时间窗的事件（回放时窗口只到播放头）
  if (!v) {
    lastEventsFetch = 0
    scheduleWindowEvents()
  }
  const playBtn = $('#btnPlay')
  playBtn.innerHTML = icon(v ? 'pause' : 'play')
  playBtn.dataset.tip = v ? '暂停（空格）' : '播放（空格）'
}

// ── 顶栏 / 通知 ───────────────────────────────────────────────────────────
/** 从会话文件路径推断项目名：DSH 取 sessions/<project>，Claude 取 projects/<slug> */
function projectFromFile(file) {
  const parts = String(file).split('/')
  const i = parts.findIndex((p) => p === 'sessions' || p === 'projects')
  if (i >= 0 && parts[i + 1]) return parts[i + 1].replace(/^--|--$/g, '').replace(/-/g, '/').split('/').slice(-1)[0] || parts[i + 1]
  return ''
}

function renderChrome() {
  if (!meta) return
  renderWindowChip()
  const goal = (state?.run?.goal || '').trim()
  const title = (meta.title || '').trim()
  const shortId = String(meta.run || '').replace(/^session-/, '').slice(0, 8)
  // 标题优先级：DSH 会话标题（与侧栏一致）→ 首条用户消息 → 「未命名会话」
  // 标题优先级：
  //   · DSH 会话：服务端 title（事件里的"标题" → 文件头 → 投影缓存），与侧栏一致；
  //     没有标题就显示「未命名会话 · 短ID」，不拿首条消息冒充标题。
  //   · 非 DSH（录制文件 / Claude Code / Codex）：没有标题时用首条用户消息（goal），
  //     这类没有"侧栏标题"的概念，显示 goal 比"未命名会话"有用。
  const isDsh = meta.runtime === 'dsh'
  const fallbackGoal = String(meta.goal || goal || '').trim()
  const fallbackLabel = shortId ? `未命名会话 · ${shortId}` : (meta.runtime ? '未命名会话' : '录制文件')
  const goalText = title || (!isDsh ? fallbackGoal : '') || fallbackLabel
  $('#sessionTitle').textContent = goalText
  document.title = `${String(goalText).slice(0, 40)} · agent-blackbox`
  $('#sessionTitle').title = [goalText, goal || meta.goal, shortId, meta.file].filter(Boolean).join('\n')
  ensureLiveLoop()
  const rt = RUNTIME_LABEL[meta.runtime] ?? (meta.native ? '会话' : '录制文件')
  const chip = $('#runtimeChip')
  chip.textContent = rt
  chip.className = `chip rt-${meta.runtime || 'file'}`
  const project = projectFromFile(meta.file || '')
  const fileBase = String(meta.file || '').split('/').pop() || ''
  // DSH：项目名 · 短ID；录制文件：文件名（没有项目目录的概念）
  const progress = document.getElementById('playProgress')
  if (progress) {
    const dur = meta?.duration || 0
    progress.style.width = dur > 0 ? `${Math.min(100, Math.max(0, (currentT / dur) * 100))}%` : '0%'
  }
  $('#projectText').textContent = project
    ? [project, shortId].filter(Boolean).join(' · ')
    : fileBase
  const live = meta.follow || meta.extended
  $('#livePill').hidden = !live
  $('#total').textContent = `/ ${fmtT1(meta.duration)}`
  $('#tlabelEnd').textContent = `/ ${fmtT1(meta.duration)}`
  const cmpLink = $('#compareLink')
  if (cmpLink) {
    const file = sessionFile()
    cmpLink.href = file ? `compare?left=${encodeURIComponent(file)}` : 'compare'
  }
  const idle = idleRatio()
  const fullMeta =
    `${meta.eventCount ?? 0} 事件 · ${meta.checkpoints ?? 0} 检查点 / 每 ${meta.checkpointEvery ?? 0}` +
    `${idle === null ? '' : ` · 空闲 ${idle}%`} · 索引 ${meta.buildMs ?? 0}ms`
  // 底部空间有限：只留关键信息，完整串放 tooltip（之前最后一项被省略号截断）
  $('#footMeta').textContent =
    `${meta.eventCount ?? 0} 事件 · ${meta.checkpoints ?? 0} 检查点` +
    `${idle === null ? '' : ` · 空闲 ${idle}%`}`
  $('#footMeta').title = fullMeta
  $('#stageSub').textContent = `${meta.agents?.length ?? 0} 个 agent · ${state?.run?.wall ? `启动于 ${state.run.wall}` : ''}`
  $('#btnFollow').classList.toggle('on', following)
  $('#btnFocus')?.classList.toggle('on', focusMode)
  const st = state?.stats
  if (st) {
    const toolPart = `工具 <b>${st.toolCalls}</b>${st.toolFails ? ` <span style="color:var(--bad)">✗${st.toolFails}</span>` : ''}`
    $('#stageSub').innerHTML = `${meta.agents?.length ?? 0} 个 agent · ${toolPart} · ${fmtTok(st.tokens.in)}↑ ${fmtTok(st.tokens.out)}↓`
  }
}

/** 轻量反馈：右下角 1.6 秒后自动消失 */
let toastTimer = null
function showToast(text) {
  let el = $('#bbToast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'bbToast'
    el.className = 'bb-toast'
    document.body.appendChild(el)
  }
  el.textContent = text
  el.hidden = false
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.hidden = true
    toastTimer = null
  }, 1600)
}

function showError(err) {
  // 出错时收起启动状态条与看门狗，避免"加载中"和错误卡片同时出现
  if (bootTimer !== null) {
    clearInterval(bootTimer)
    bootTimer = null
  }
  if (bootWatchdog !== null) {
    clearTimeout(bootWatchdog)
    bootWatchdog = null
  }
  const bootStatus = document.getElementById('bootStatus')
  if (bootStatus) bootStatus.hidden = true
  const card = $('#errorCard')
  const message = err instanceof Error ? err.message : String(err)
  if (card) {
    $('#errorText').textContent = message
    card.hidden = false
    $('#errorRetry')?.focus()
    return
  }
  // 兜底：没有卡片时用顶部通知条
  const notice = $('#notice')
  $('#noticeText').textContent = `加载失败：${message}`
  const action = $('#noticeAction')
  action.hidden = false
  action.textContent = '重试'
  action.onclick = () => location.reload()
  notice.hidden = false
}

function showPartial() {
  const notice = $('#notice')
  $('#noticeText').textContent = `这是大会话：默认只加载了最近 ${Math.round((meta.sizeTailBytes ?? 8 * 1024 * 1024) / 1048576)}MB，保证打开速度。`
  const action = $('#noticeAction')
  action.hidden = false
  action.textContent = '加载全部'
  action.onclick = () => {
    const url = new URL(location.href)
    url.searchParams.set('full', '1')
    location.href = url.toString()
  }
  notice.hidden = false
}

// ── KPI ───────────────────────────────────────────────────────────────────
const KPI_FIELDS = [
  { key: 'events', label: '事件', get: (st) => st.events },
  { key: 'duration', label: '时长', get: () => null },
  { key: 'tools', label: '工具调用', get: (st) => st.toolCalls },
  { key: 'blocked', label: '阻塞', get: (st) => st.blockedMs },
  { key: 'tokensIn', label: '输入 token', get: (st) => st.tokens.in },
  { key: 'tokensOut', label: '输出 token', get: (st) => st.tokens.out },
]
function renderKpis() {
  const st = state?.stats
  if (!st) return
  const kpiSig = JSON.stringify([
    st.events,
    st.toolCalls,
    st.toolFails,
    st.blockedMs,
    st.tokens,
    meta?.duration,
    meta?.checkpoints,
    revealMode() ? Math.round(currentT / 250) : -1,
  ])
  if (unchanged('kpis', kpiSig)) return
  const cached = st.tokens.cached
  const hit = st.tokens.in + cached > 0 ? Math.round((cached / (st.tokens.in + cached)) * 100) : 0
  const agents = state ? Object.values(state.agents) : []
  const active = agents.filter((a) => a.state !== 'idle' && a.state !== 'done').length
  const waiting = agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length
  const idle = idleRatio()
  const items = [
    {
      k: '事件',
      v: String(st.events),
      s: `${meta?.kinds?.length ?? 0} 类事件`,
      tip: '本次会话记录的事件总数（按类型归并）',
    },
    {
      k: '时长',
      v: fmtSpan(meta?.duration ?? 0),
      // 回放时显示"回放到哪里"；否则显示 agent 状态/空闲占比
      s: revealMode()
        ? `回放到 ${fmtT1(currentT)}`
        : active > 0
          ? `${active} 个 agent 在跑`
          : idle === null
            ? '无 agent 在跑'
            : `其中空闲 ${idle}%`,
      tip:
        revealMode()
          ? '会话总时长（从开始到结束的墙钟时间）；小字是当前回放位置'
          : '从会话开始到结束的墙钟时长（含 agent 等待、空闲的时间）',
    },
    {
      k: '工具调用',
      v: String(st.toolCalls),
      s: st.toolFails > 0 ? `${st.toolFails} 次失败` : '全部成功',
      bad: st.toolFails > 0,
      tip: `工具调用总数；其中失败 ${st.toolFails} 次`,
    },
    {
      k: '阻塞',
      v: st.blockedMs > 0 ? fmtDur(st.blockedMs) : '—',
      s: waiting > 0 ? `${waiting} 个 agent 在等` : '无 agent 阻塞',
      tip: 'agent 之间互相等待（被委派的任务还没返回）累计的时长',
    },
    { k: '输入 token', v: fmtTok(st.tokens.in), s: `缓存命中 ${hit}%`, tip: '累计输入 token；小字是缓存命中率' },
    { k: '输出 token', v: fmtTok(st.tokens.out), s: `${meta?.usageCount ?? 0} 次请求`, tip: '累计输出 token 与模型请求次数' },
  ]
  $('#kpis').innerHTML = items
    .map(
      (i) =>
        `<div class="kpi ${i.cls || ''}" title="${esc(i.tip)}"><div class="kpi-k">${i.k}</div>` +
        `<div class="kpi-v">${i.v}</div>` +
        `<div class="kpi-s ${i.bad ? 'bad' : ''}">${esc(i.s)}</div></div>`,
    )
    .join('')
}

// ── 迷你曲线 ──────────────────────────────────────────────────────────────
function syncCanvas(canvas, ctx) {
  const r = canvas.getBoundingClientRect()
  const W = Math.max(1, r.width)
  const H = Math.max(1, r.height)
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { W, H }
}

function renderSpark() {
  const canvas = $('#spark')
  const ctx = canvas.getContext('2d')
  const { W, H } = syncCanvas(canvas, ctx)
  ctx.clearRect(0, 0, W, H)
  if (!series.length) return
  const reveal = revealMode()
  // 回放时只画到播放头：波形从左侧逐步长出来
  const buckets = reveal ? series.filter((d) => d.t <= currentT + 1) : series
  const max = Math.max(1, ...series.map((d) => Math.max(d.in, d.out)))
  const span = Math.max(1, series.length - 1)
  const area = (key, stroke, fill) => {
    ctx.beginPath()
    buckets.forEach((d, i) => {
      const idx = series.indexOf(d)
      const x = (idx / span) * W
      const y = H - (d[key] / max) * (H - 6) - 2
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.3
    ctx.stroke()
    if (buckets.length > 0) {
      const last = buckets[buckets.length - 1]
      const lx = (series.indexOf(last) / span) * W
      ctx.lineTo(lx, H)
      ctx.lineTo(0, H)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
    }
  }
  area('cached', CV.cached, CV.cachedArea)
  area('in', CV.in, CV.inArea)
  area('out', CV.out, CV.outArea)
  // 波形前沿光点：一眼看出"现在画到哪了"
  if (reveal && buckets.length > 0) {
    const last = buckets[buckets.length - 1]
    const lx = (series.indexOf(last) / span) * W
    const ly = H - (Math.max(last.in, last.out) / max) * (H - 6) - 2
    ctx.fillStyle = CV.playhead
    ctx.beginPath()
    ctx.arc(lx, ly, 2.2, 0, Math.PI * 2)
    ctx.fill()
  }
  const sum = buckets.reduce((a, d) => a + d.in + d.out, 0)
  $('#sparkMeta').textContent = reveal
    ? `回放到 ${fmtT1(currentT)} · 截至当前 ${fmtTok(sum)}`
    : `峰值 ${fmtTok(max)} · 共 ${fmtTok(sum)}`
}

// ── Agent 卡片 ────────────────────────────────────────────────────────────
function feedOf(name, limit = 3) {
  const recent = state?.recent || []
  const feed = []
  for (let i = recent.length - 1; i >= 0 && feed.length < limit; i--) {
    const e = recent[i]
    if (e.agent !== name) continue
    if (e.kind === 'think') feed.push(['k-think', `${kindIcon('think')}<span>${esc(e.data.text || '')}</span>`])
    else if (e.kind === 'tool.call') feed.push(['k-tool', `${kindIcon('tool')}<span>${esc(e.data.tool)} · ${esc(e.data.summary || '')}</span>`])
    else if (e.kind === 'tool.result' && e.data.ok === false) feed.push(['k-err', `${kindIcon('cross')}<span>${esc(String(e.data.error || '').slice(0, 70))}</span>`])
    else if (e.kind === 'message.agent') feed.push(['k-msg', `${kindIcon('message')}<span>${esc(e.data.text || '')}</span>`])
  }
  return feed.reverse()
}
function lastAgentText(name) {
  const recent = state?.recent || []
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i]
    if (e.agent === name && e.kind === 'message.agent' && e.data.text) {
      const t = String(e.data.text).replace(/\s+/g, ' ')
      return t.length > 180 ? `${t.slice(0, 180)}…` : t
    }
  }
  return ''
}

/**
 * 左栏底部：会话信息 + 事件构成。
 * 之前这块是纯空白 —— 用真实元信息填补，比留白有价值。
 */
function renderRailMeta() {
  if (!meta) return
  const kv = $('#railKv')
  const kinds = $('#kindsDist')
  if (!kv || !kinds) return
  const rows = [
    ['runtime', meta.runtime || '—'],
    ['模型', (meta.agents?.[0]?.model) || '—'],
    ['项目', String(meta.run?.project || '—').split('/').slice(-1)[0] || '—'],
    ['文件', String(meta.file || '').split('/').slice(-1)[0] || '—'],
  ]
  kv.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="kv"><span>${esc(k)}</span><b title="${esc(String(v))}">${esc(String(v))}</b></div>`,
    )
    .join('')
  const list = [...(meta.kinds || [])].sort((a, b) => b.count - a.count).slice(0, 7)
  const total = (meta.kinds || []).reduce((n, k) => n + k.count, 0) || 1
  kinds.innerHTML =
    `<div class="kinds-head">事件构成 <em>${meta.kinds?.length || 0} 类 / ${total} 条</em></div>` +
    list
      .map(
        (k) => `<div class="kind-row" title="${esc(k.label || k.kind)} · ${k.count} 条">
          <span class="kind-name">${esc(k.label || k.kind)}</span>
          <span class="kind-bar"><i style="width:${Math.max(2, Math.round((k.count / total) * 100))}%"></i></span>
          <span class="kind-n">${k.count}</span>
        </div>`,
      )
      .join('')
  $('#railMetaNote').textContent = meta.partial ? '仅尾部' : ''
}

/**
 * 空会话的中间区：与其留一大块空白，不如把"最近发生了什么"铺开。
 * 插件面板里右栏默认收起，这段内联事件流尤其有用。
 */
function renderStageFeed() {
  const pane = $('#stageFeedPane')
  const list = $('#stageFeed')
  if (!pane || !list) return
  const empty = spans.length === 0
  pane.hidden = !empty
  if (!empty) return
  const kindMeta = Object.fromEntries((meta?.kinds || []).map((k) => [k.kind, k]))
  const rows = [...windowEvents].sort((a, b) => b.t - a.t).slice(0, 14)
  $('#stageFeedSub').textContent = `${windowEvents.length} 条 · 点击查看详情`
  list.innerHTML = rows.length
    ? rows
        .map((e) => {
          const km = kindMeta[e.kind] || {}
          return `<button class="sf-row" data-t="${e.t}" data-seq="${e.seq ?? ''}">
            <span class="sf-t">${fmtT(e.t)}</span>
            <span class="sf-g" style="color:${km.color || 'var(--text-4)'}">${kindIcon(e.kind)}</span>
            <span class="sf-a">${esc(e.agent || '')}</span>
            <span class="sf-x">${eventLine(e)}</span>
          </button>`
        })
        .join('')
    : `<div class="empty empty-lg">${icon('list', '', 20)}<span>这个会话还没有事件</span></div>`
  list.onclick = (ev) => {
    const row = ev.target.closest?.('.sf-row')
    if (!row) return
    const item = windowEvents.find((e) => String(e.seq) === row.dataset.seq)
    if (item) {
      openDrawer(item)
      void seek(item.t)
    }
  }
}

/** 数据密度：空会话时收掉空 pane，单 agent 时让卡片更长 */
function applyDensity() {
  const empty = spans.length === 0
  document.body.classList.toggle('no-span', empty)
  const wfPane = document.querySelector('.wf-pane')
  if (wfPane) wfPane.hidden = empty
  const agents = meta?.agents || []
  $('#agents')?.classList.toggle('single', agents.length === 1)
}

function renderAgents() {
  if (!meta || !state) return
  const agentSig = JSON.stringify([
    spans.length,
    (meta.agents || []).length,
    Object.values(state.agents).map((a) => [a.agent, a.state, a.calls, a.fails, a.blockedBy ?? '', a.tokens.in, a.tokens.out, a.tokens.cached]),
  ])
  if (unchanged('agents', agentSig)) return
  const html = (meta.agents || [])
    .map((a) => {
      const s = state.agents[a.id]
      if (!s) return ''
      const st = s.state
      const blocked = st === 'blocked' || st === 'waiting'
      const waitText = blocked && s.blockedBy
        ? `${fmtDur(Math.max(0, state.t - (s.blockedSince ?? state.t)))} ← ${state.agents[s.blockedBy]?.agent || s.blockedBy}`
        : ''
      const wait = waitText !== '' ? `${kindIcon('pause')}<span>${esc(waitText)}</span>` : ''
      const out = lastAgentText(s.agent)
      const single = (meta.agents || []).length === 1
      const feed = feedOf(s.agent, single ? 10 : 3)
      return `
        <article class="agent-card ${blocked ? 'is-blocked' : ''} ${document.body.dataset.focusAgent === s.agent ? 'is-focus' : ''}" data-agent="${esc(s.agent)}" style="--agent-color:${agentColorOf(a.id)}">
          <div class="agent-head">
            <span class="agent-name">${esc(s.agent)}</span>
            <span class="agent-model" title="${esc(a.model || a.runtime || '')}">${esc(a.model || a.runtime || '')}</span>
            <span class="agent-state ${STATE_CLASS[st] || 's-idle'}"><i></i>${STATE_LABEL[st] || st}</span>
          </div>
          ${out ? `<div class="agent-out"><b>最近输出</b> ${esc(out)}</div>` : ''}
          ${feed.length ? `<div class="agent-feed">${feed.map(([c, t]) => `<div class="${c}">${t}</div>`).join('')}</div>` : ''}
          <div class="agent-foot">
            <span>工具 <b>${s.calls}</b>${s.fails ? ` ✗${s.fails}` : ''}</span>
            <span>${fmtTok(s.tokens.in)}↑ ${fmtTok(s.tokens.out)}↓</span>
            <span>缓存 <b>${fmtTok(s.tokens.cached)}</b></span>
            ${wait ? `<span class="agent-wait">${wait}</span>` : ''}
          </div>
        </article>`
    })
    .join('')
  $('#agents').classList.toggle('single', (meta.agents || []).length === 1)
  const hint =
    spans.length === 0
      ? `<div class="stage-hint">这个会话还没有产生工具调用，所以<b>工具瀑布</b>是空的；
           时间轴上的细竖线是事件刻度。<kbd>?</kbd> 查看全部快捷键，右侧「事件」可以逐条查看发生了什么。</div>`
      : ''
  $('#agents').innerHTML =
    (html || `<div class="empty empty-lg">${icon('user', '', 20)}<span>没有 agent 事件</span></div>`) + hint
}

function renderAttribution() {
  const rows = (attr?.rows || []).filter((r) => r.blockedMs > 0)
  $('#attSum').textContent = rows.length ? `合计 ${fmtDur(rows.reduce((s, r) => s + r.blockedMs, 0))}` : ''
  if (!rows.length) {
    $('#attribution').innerHTML = `<div class="empty-slot">${icon('check', '', 20)}<span>没有 agent 在等别人</span></div>`
    return
  }
  const max = Math.max(...rows.map((r) => r.blockedMs), 1)
  $('#attribution').innerHTML = rows
    .map((r) => {
      const pct = state && state.t > 0 ? ((r.blockedMs / state.t) * 100).toFixed(0) : '0'
      const live = r.state === 'blocked' || r.state === 'waiting'
      return `<div class="att-row">
        <div class="att-name" title="${esc(r.agent)}">${esc(r.agent)}</div>
        <div class="att-bar"><div class="att-fill ${live ? 'hot' : ''}" style="width:${((r.blockedMs / max) * 100).toFixed(1)}%"></div>
          <div class="att-txt"><span>${fmtDur(r.blockedMs)}</span><span>${pct}%</span></div></div>
        ${r.blockedByName ? `<div class="att-sub">${live ? '正在等' : '曾等'} ${esc(r.blockedByName)}${r.reason ? ` · ${esc(r.reason)}` : ''}</div>` : ''}
      </div>`
    })
    .join('')
}

// ── 工具瀑布 ──────────────────────────────────────────────────────────────
const WF_LIMIT = 240
/** 单行高度（CSS 里的 .wf-row height + gap），虚拟列表按它算位置 */
const WF_ROW_H = 20
let wfRows = []
let lastWfLen = 0
let wfBound = false

function wfRowHTML(i, s, maxDur, maxEnd) {
  const ms = s.end === null ? null : s.end - s.start
  const width = Math.max(0.6, ((ms ?? maxDur * 0.5) / maxDur) * 100)
  const posPct = (s.start / maxEnd) * 100
  const color = s.ok ? toolColor(s.tool) : 'var(--bad)'
  return `<div class="wf-row wf-virtual ${s.ok ? '' : 'is-fail'}" data-i="${i}" data-t="${s.start}" style="top:${i * WF_ROW_H}px" data-tip="${esc(`${s.tool} · ${s.summary} · 开始 ${fmtT1(s.start)} · 耗时 ${ms === null ? '进行中' : fmtDur(ms)}`)}">
    <div class="wf-label"><b style="color:${color}">${esc(s.tool)}</b> ${esc(String(s.summary).slice(0, 34))}</div>
    <div class="wf-track"><div class="wf-pos" style="left:${posPct}%"></div><div class="wf-bar ${s.ok ? '' : 'fail'}" style="width:${width}%;background:${color};opacity:${s.end === null ? 1 : 0.78}"></div></div>
    <div class="wf-dur">${ms === null ? '…' : fmtDur(ms)}</div>
  </div>`
}

/** 只渲染视口内的行：从 240 行降到约 20 行，首次渲染不再是一次长任务 */
function paintWaterfallWindow() {
  const el = $('#waterfall')
  const inner = el?.querySelector('#wfInner')
  if (!el || !inner || wfRows.length === 0) return
  const dur = Math.max(1, meta?.duration || 1)
  const maxDur = Math.max(1, ...wfRows.map((x) => (x.end === null ? 1 : x.end - x.start)))
  const viewH = el.clientHeight || 300
  const start = Math.max(0, Math.floor(el.scrollTop / WF_ROW_H) - 4)
  const count = Math.ceil(viewH / WF_ROW_H) + 8
  const liveish = playing || (following && meta?.follow)
  const fresh = liveish && lastWfLen !== 0 && wfRows.length > lastWfLen
  lastWfLen = wfRows.length
  const slice = wfRows.slice(start, start + count)
  inner.innerHTML = slice
    .map((row, j) => {
      const idx = start + j
      const focus = document.body.dataset.focusWf === String(idx)
      const isNew = fresh && idx === wfRows.length - 1 ? ' is-new' : ''
      return wfRowHTML(idx, row, maxDur, dur).replace('class="wf-row wf-virtual', `class="wf-row wf-virtual${focus ? ' is-focus' : ''}${isNew}`)
    })
    .join('')
}

function onWaterfallScroll() {
  if (wfPaintScheduled) return
  wfPaintScheduled = true
  requestAnimationFrame(() => {
    wfPaintScheduled = false
    paintWaterfallWindow()
  })
}
let wfPaintScheduled = false

/**
 * 工具图例：颜色是按 hash 生成的，没有图例没人知道蓝的绿的分别是什么工具。
 * 顺便把图例做成筛选器：点一下只看这类调用，再点取消。
 */
function renderLegend(inView) {
  const el = $('#wfLegend')
  if (!el) return
  const counts = new Map()
  for (const s of inView) counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1)
  if (counts.size <= 1) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7)
  el.hidden = false
  el.innerHTML =
    top
      .map(
        ([tool, n]) =>
          `<button data-tool="${esc(tool)}" class="${wfTool === tool ? 'on' : ''}" data-tip="只看 ${esc(tool)}（${n} 次）">
             <i style="background:${toolColor(tool)}"></i>${esc(tool)}<span class="more">${n}</span>
           </button>`,
      )
      .join('') + (counts.size > top.length ? `<span class="more">+${counts.size - top.length}</span>` : '')
  el.onclick = (ev) => {
    const btn = ev.target.closest?.('button[data-tool]')
    if (!btn) return
    wfTool = wfTool === btn.dataset.tool ? null : btn.dataset.tool
    mark('waterfall')
  }
}

function renderWaterfall() {
  // 数据没到：保留模板里的骨架行，别先清空成白板
  if (!dataReady) return
  const reveal = revealMode()
  let inView = spans.filter((s) => intersects(s.start, s.end, view))
  if (reveal) inView = inView.filter((s) => s.start <= currentT + 1)
  const wfSig = JSON.stringify([
    spans.length,
    Math.round(view.from),
    Math.round(view.to),
    onlyFail,
    wfTool,
    meta?.duration,
    reveal ? inView.length : -1,
    // 工具完成时 end 会变：取尾部若干项的 end，避免"完成状态不更新"
    spans.slice(-40).map((x) => x.end ?? -1).join(','),
    spans.slice(-40).filter((x) => !x.ok).length,
  ])
  if (unchanged('waterfall', wfSig)) return
  renderLegend(inView)
  let pool = onlyFail ? inView.filter((s) => !s.ok) : inView
  if (wfTool) pool = pool.filter((s) => s.tool === wfTool)
  const list = pool.slice(-WF_LIMIT)
  const fullWin = meta ? isFullWindow(view, meta.duration) : true
  $('#wfMeta').textContent = `${inView.length} 次调用在窗口内${fullWin ? '' : `（共 ${spans.length}）`}${wfTool ? ` · 筛选 ${wfTool}（${list.length}）` : ` · 显示最近 ${list.length} 条`} · 条长 = 耗时 / 最慢 ${fmtDur(Math.max(1, ...list.map((x) => (x.end === null ? 1 : x.end - x.start))))}`
  const el = $('#waterfall')
  if (!wfBound) {
    el.addEventListener('scroll', onWaterfallScroll, { passive: true })
    wfBound = true
  }
  if (list.length === 0) {
    el.innerHTML =
      `<div class="empty empty-lg">${icon('wrench', '', 20)}<span>还没有工具调用 · agent 执行命令或读写文件后会在这里按时长排序出现</span></div>`
    wfRows = []
    return
  }
  el.innerHTML = `<div id="wfInner" style="position:relative;height:${list.length * WF_ROW_H}px"></div>`
  wfRows = list
  const wasFollowing = following || meta?.follow || reveal
  if (wasFollowing) el.scrollTop = el.scrollHeight
  paintWaterfallWindow()
  if (wasFollowing) el.scrollTop = el.scrollHeight
  el.onclick = (ev) => {
    const row = ev.target.closest?.('.wf-row')
    if (!row) return
    const s = wfRows[Number(row.dataset.i)]
    if (!s) return
    setPlaying(false)
    following = false
    void seek(s.start)
    openDrawer(s)
  }
}

function paintRunningRows() {
  if (!state) return
  const t = currentT
  document.querySelectorAll('#waterfall .wf-row').forEach((row) => {
    const s = wfRows[Number(row.dataset.i)]
    if (!s) return
    const running = s.end === null || (s.start <= t && t <= s.end)
    if (running !== row.classList.contains('is-running')) row.classList.toggle('is-running', running)
  })
}
function paintPlayheadDependents() {
  // 时间文本统一走 updateClock（那里有去重）；这里不需要每 100ms 再写一次
}

// ── 右栏列表 ──────────────────────────────────────────────────────────────
function renderChips() {
  const kinds = (meta?.kinds || []).filter((k) => k.count > 0).slice(0, 9)
  $('#kindChips').innerHTML = kinds
    .map((k) => `<button class="chipbtn ${activeKinds.has(k.kind) ? 'on' : ''}" data-kind="${k.kind}" style="${activeKinds.has(k.kind) ? `background:${k.color};border-color:${k.color}` : ''}">${esc(k.label)} ${k.count}</button>`)
    .join('')
  $('#kindChips').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.kind
      activeKinds.has(k) ? activeKinds.delete(k) : activeKinds.add(k)
      renderChips()
      mark('list')
    }),
  )
}

/**
 * 把「原始行」整理成一句能读的话。
 * DSH 的内部流是带 HTML 片段的 JSON（`<span>{&quot;stream&quot;...`），
 * 直接 JSON.stringify 会让界面全是转义符 —— 用户看不出发生了什么。
 */
function rawLineSummary(d) {
  const line = typeof d.line === 'string' ? d.line : ''
  if (!line) return JSON.stringify(d).slice(0, 90)
  let text = line
  // 尝试解析 JSON，取出常见文本字段
  try {
    const o = JSON.parse(line)
    const pick = o.text ?? o.content ?? o.delta ?? o.message ?? o.command ?? o.path ?? o.summary
    if (typeof pick === 'string' && pick.trim()) text = pick
    else if (typeof o.type === 'string') text = `[${o.type}] ${JSON.stringify(o).slice(0, 70)}`
  } catch {
    /* 不是 JSON，就用原文 */
  }
  text = text.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 110 ? `${text.slice(0, 110)}…` : text || line.slice(0, 90)
}

function eventLine(e) {
  const d = e.data || {}
  switch (e.kind) {
    case 'tool.call': return `<b>${esc(e.agent)}</b> ${esc(d.tool)} <span>${esc(String(d.summary || '').slice(0, 80))}</span>`
    case 'tool.result':
      return `<b>${esc(e.agent)}</b> ${kindIcon(d.ok === false ? 'cross' : 'check')} <span>${esc(String(d.output || d.error || '').slice(0, 100))}</span>`
    case 'message.agent': case 'think': case 'message.user':
      return `<b>${esc(e.agent || 'user')}</b> <span>${esc(String(d.text || '').slice(0, 120))}</span>`
    case 'status': return `<b>${esc(e.agent)}</b> <span>${esc(d.state)} ${esc(d.reason || '')}</span>`
    case 'edge': return `<b>${esc(e.agent)}</b> ${kindIcon('handoff')} <span>${esc(d.label || '')}</span>`
    case 'file.edit': return `<b>${esc(e.agent)}</b> ✎ <span>${esc(d.path || '')} ${d.added ? `+${d.added}` : ''} ${d.removed ? `-${d.removed}` : ''}</span>`
    case 'usage': return `<b>${esc(e.agent)}</b> <span>${fmtTok(d.in || 0)}↑ ${fmtTok(d.out || 0)}↓ 缓存 ${fmtTok(d.cached || 0)}</span>`
    case 'checkpoint': return `<span>${kindIcon('flag')} ${esc(d.name || '')} ${esc(String(d.note || '').slice(0, 70))}</span>`
    case 'run.start': return `<span>任务开始 · ${esc(String(d.goal || '').slice(0, 80))}</span>`
    case 'run.end': return `<span>任务结束 · ${esc(d.status || '')}</span>`
    case 'session.start': return `<b>${esc(e.agent)}</b> <span>${esc(d.runtime || '')} ${esc(d.model || '')} 上线</span>`
    case 'session.end': return `<b>${esc(e.agent)}</b> <span>下线</span>`
    case 'raw': return `<span class="raw-line">${esc(rawLineSummary(d))}</span>`
    default: return `<span>${esc(rawLineSummary(d))}</span>`
  }
}

function renderList() {
  // 数据没到：保留骨架行
  if (!dataReady) return
  if (!meta) return
  const reveal = revealMode()
  const revealedEvents = reveal ? windowEvents.filter((e) => e.t <= currentT + 1) : windowEvents
  const listSig = JSON.stringify([
    tab,
    search,
    [...activeKinds].sort(),
    onlyFail,
    windowEvents.length,
    windowEvents[0]?.seq ?? -1,
    windowEvents[windowEvents.length - 1]?.seq ?? -1,
    spans.length,
    reveal ? revealedEvents.length : -1,
    tab === 'files' ? Object.keys(state?.files ?? {}).length : 0,
  ])
  if (unchanged('list', listSig)) return
  const now = performance.now()
  if (playing && now - lastListAt < 240) return
  lastListAt = now

  const q = search.trim().toLowerCase()
  let html = ''
  visibleRows = []

  if (tab === 'events') {
    const kindMeta = Object.fromEntries((meta.kinds || []).map((k) => [k.kind, k]))
    // 列表跟随**时间窗**，而不是"最近 120 条"：
    // 这样才能在 3 万条事件的会话里翻看任意一段，而不是只能看尾巴
    const list = [...revealedEvents].sort((a, b) => b.t - a.t)
    for (const e of list) {
      if (activeKinds.size > 0 && !activeKinds.has(e.kind)) continue
      const text = eventLine(e)
      if (q && !(text + e.kind).toLowerCase().includes(q)) continue
      const km = kindMeta[e.kind] || {}
      visibleRows.push(e)
      html += `<div class="rrow ${e.kind === 'error' ? 'is-err' : ''}" data-idx="${visibleRows.length - 1}" data-seq="${e.seq}">
        <div class="t">${fmtT(e.t)}</div>
        <div class="g" style="color:${km.color || 'var(--text-4)'}">${kindIcon(e.kind)}</div>
        <div class="d">${text}</div></div>`
    }
    const clipped = eventsMeta.count > windowEvents.length
    $('#rInfo').textContent = reveal
      ? `回放到 ${fmtT1(currentT)} · 已展开 ${visibleRows.length} 条 · ↑↓ 选择`
      : `窗口内 ${visibleRows.length} 条${clipped ? `（共 ${eventsMeta.count} 条，显示最近 ${windowEvents.length}）` : ''} · ↑↓ 选择 · Enter 详情`
  } else if (tab === 'tools') {
    const list = (onlyFail ? spans.filter((s) => !s.ok) : spans).slice(-500).reverse()
    for (const s of list) {
      if (q && !(s.tool + s.summary).toLowerCase().includes(q)) continue
      const ms = s.end === null ? null : s.end - s.start
      visibleRows.push(s)
      html += `<div class="rrow" data-idx="${visibleRows.length - 1}" data-t="${s.start}">
        <div class="t">${fmtT(s.start)}</div>
        <div class="g" style="color:${s.ok ? toolColor(s.tool) : 'var(--bad)'}">${kindIcon(s.ok ? 'tool.call' : 'error')}</div>
        <div class="d"><b>${esc(s.tool)}</b> <span>${esc(String(s.summary).slice(0, 64))} · ${ms === null ? '进行中' : fmtDur(ms)}</span></div></div>`
    }
    $('#rInfo').textContent = `${spans.length} 次工具调用 · 按时间倒序`
  } else {
    const files = Object.entries(state?.files || {})
    for (const [path, rec] of files) {
      if (q && !path.toLowerCase().includes(q)) continue
      visibleRows.push({ path, ...rec })
      html += `<div class="rrow" data-idx="${visibleRows.length - 1}">
        <div class="t">${rec.edits}×</div>
        <div class="g" style="color:#fb923c">✎</div>
        <div class="d"><b>${esc(path.split('/').pop())}</b> <span>${esc(path)}</span></div></div>`
    }
    $('#rInfo').textContent = `${files.length} 个文件被改动`
  }

  // 列表可能有多达 400 行：只渲染视口内的（虚拟列表），首次渲染不再是长任务
  listHTML = html
  cursorIndex = -1
  paintListWindow(true)
}

/** 行高与 CSS 对齐（.rrow height: 23px） */
const LIST_ROW_H = 23
let listHTML = ''
let listBound = false
let lastListFirstSeq = ''
let listPaintScheduled = false

function paintListWindow(resetScroll = false) {
  const el = $('#rlist')
  if (!el) return
  // 数据还没到：保留模板里的骨架行，不要提前画"没有内容"
  if (!dataReady) return
  if (!listBound) {
    el.addEventListener(
      'scroll',
      () => {
        if (listPaintScheduled) return
        listPaintScheduled = true
        requestAnimationFrame(() => {
          listPaintScheduled = false
          paintListWindow(false)
        })
      },
      { passive: true },
    )
    listBound = true
  }
  const total = visibleRows.length
  if (total === 0) {
    const filtered = search.trim() !== '' || activeKinds.size > 0 || (tab === 'tools' && onlyFail)
    // 回放/实时跟随：可能只是"还没回放到第一条事件"，不能报"这个会话还没有事件"
    if (revealMode() && !filtered) {
      el.innerHTML = `<div class="empty empty-lg">${icon('list', '', 20)}<span>回放到 ${fmtT1(currentT)} · 播放头之前还没有${
        tab === 'tools' ? '工具调用' : '事件'
      }</span></div>`
      return
    }
    const message = emptyStateMessage({
      tab,
      filtered,
      spansCount: spans.length,
      eventsCount: windowEvents.length,
      totalEvents: eventsMeta.count,
    })
    el.innerHTML = `<div class="empty empty-lg">${icon(filtered ? 'search' : 'list', '', 20)}<span>${message}</span></div>`
    // 空态替换掉了 #rlistInner；把 total 归零，避免切换会话后"总数恰好相同"
    // 时跳过重建、导致列表一直空白
    el.dataset.total = '0'
    return
  }
  if (resetScroll) el.scrollTop = 0
  // 用 data 属性算出总高度；行内容仍然来自 renderList 拼好的 html
  if (listNeedsRebuild(el.dataset.total, total, el.querySelector('#rlistInner') !== null)) {
    el.dataset.total = String(total)
    el.innerHTML = `<div id="rlistInner" style="position:relative;height:${total * LIST_ROW_H}px"></div>`
  }
  const inner = el.querySelector('#rlistInner')
  if (!inner) return
  const start = Math.max(0, Math.floor(el.scrollTop / LIST_ROW_H) - 4)
  const count = Math.ceil((el.clientHeight || 400) / LIST_ROW_H) + 8
  // html 里每行有 data-idx，切片后需要重新定位
  const tmp = document.createElement('div')
  tmp.innerHTML = listHTML
  const rows = [...tmp.children].slice(start, start + count)
  // 新事件出现时给第一行一次性入场动画（只在播放/实时跟随时，避免静态页面闪）
  const liveish = playing || (following && meta?.follow)
  const firstSeq = visibleRows[0] ? String(visibleRows[0].seq ?? '') : ''
  const freshFirst = liveish && lastListFirstSeq !== '' && firstSeq !== '' && firstSeq !== lastListFirstSeq
  lastListFirstSeq = firstSeq
  inner.innerHTML = rows
    .map((r) => {
      const idx = Number(r.getAttribute('data-idx'))
      const selected = idx === cursorIndex
      const focus = document.body.dataset.focusList === String(idx)
      const fresh = freshFirst && idx === 0 ? ' is-new' : ''
      return `<div class="rrow rrow-virtual${focus ? ' is-focus' : ''}${fresh}" id="rrow-${idx}" role="option" aria-selected="${selected}" data-idx="${idx}" style="top:${idx * LIST_ROW_H}px">${r.innerHTML}</div>`
    })
    .join('')
  inner.onclick = (ev) => {
    const row = ev.target.closest?.('.rrow')
    if (row) onRowActivate(Number(row.dataset.idx))
  }
}

function onRowActivate(idx) {
  const item = visibleRows[idx]
  if (!item) return
  if (tab === 'files') return
  if (item.kind) {
    openDrawer(item)
    return
  }
  // 窄屏右栏是浮层：选完就收起，避免挡住内容
  if (window.matchMedia('(max-width: 980px)').matches) {
    document.body.classList.remove('panel-open')
    $('#btnPanel')?.setAttribute('aria-expanded', 'false')
  }
  setPlaying(false)
  following = false
  void seek(item.start)
}

function moveCursor(delta) {
  const total = visibleRows.length
  if (total === 0) return
  cursorIndex = clamp(cursorIndex + delta, 0, total - 1)
  const el = $('#rlist')
  if (el) {
    const top = cursorIndex * LIST_ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + LIST_ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + LIST_ROW_H - el.clientHeight
    paintListWindow(false)
    el.querySelectorAll('.rrow').forEach((r) => {
      const on = Number(r.dataset.idx) === cursorIndex
      r.classList.toggle('is-cursor', on)
      r.setAttribute('aria-selected', String(on))
    })
    if (cursorIndex >= 0) el.setAttribute('aria-activedescendant', `rrow-${cursorIndex}`)
  }
}

// ── 时间轴（静态层缓存 + 每帧只画播放头） ─────────────────────────────────
const tl = $('#timeline')
const tlCtx = tl.getContext('2d')
const tlCache = document.createElement('canvas')
const tlCacheCtx = tlCache.getContext('2d')
let tlSize = { W: 0, H: 0 }
let staticDirty = true

function invalidateTimeline() {
  staticDirty = true
}

function buildTimelineStatic(W, H) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (tlCache.width !== Math.round(W * dpr) || tlCache.height !== Math.round(H * dpr)) {
    tlCache.width = Math.round(W * dpr)
    tlCache.height = Math.round(H * dpr)
  }
  tlCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  tlCacheCtx.clearRect(0, 0, W, H)
  if (!meta) return
  const ctx = tlCacheCtx
  const x = (t) => xOf(t, view, W)

  const toolY = 6
  const toolH = Math.max(14, Math.round(H * 0.42))
  ctx.fillStyle = CV.band
  ctx.fillRect(0, toolY, W, toolH)
  const spanFrom = Math.max(0, xOf(view.from, view, W) - 1)
  const spanTo = xOf(view.to, view, W) + 1
  ctx.save()
  ctx.beginPath()
  ctx.rect(spanFrom, 0, Math.max(0, spanTo - spanFrom), H)
  ctx.clip()
  for (const s of spans) {
    if (!intersects(s.start, s.end, view)) continue
    const x0 = Math.max(spanFrom, x(s.start))
    const x1 = Math.min(spanTo, Math.max(x0 + 1.2, x(s.end ?? s.start + 1)))
    ctx.globalAlpha = s.end === null ? 0.95 : 0.5
    ctx.fillStyle = s.ok ? toolColor(s.tool) : CV.fail
    ctx.fillRect(x0, toolY, x1 - x0, toolH)
  }
  ctx.globalAlpha = 1
  ctx.restore()

  // 阻塞泳道
  const agents = meta.agents || []
  const laneTop = toolY + toolH + 6
  const laneH = 4
  const laneGap = 2
  agents.forEach((_, i) => {
    ctx.fillStyle = CV.gapBg
    ctx.fillRect(0, laneTop + i * (laneH + laneGap), W, laneH)
  })
  for (const b of meta.blockedSpans || []) {
    const i = agents.findIndex((a) => a.id === b.agent)
    if (i < 0 || !intersects(b.from, b.to, view)) continue
    ctx.fillStyle = agentColorOf(agents[i].id)
    ctx.globalAlpha = 0.62
    const bx0 = Math.max(spanFrom, x(b.from))
    const bx1 = Math.min(spanTo, Math.max(bx0 + 1.4, x(b.to)))
    ctx.fillRect(bx0, laneTop + i * (laneH + laneGap), bx1 - bx0, laneH)
  }
  ctx.globalAlpha = 1

  // ── 空档：让"它闲了多久"一眼可见 ─────────────────────────────────────
  // 长会话里大量时间其实是空闲的；不标出来，时间轴看起来就像"没数据"。
  const spanMs = view.to - view.from
  // 只标注"显著"空档：2% 阈值在密集会话里会画出几十条斜纹，反而像噪声
  const gapThreshold = Math.max(2000, spanMs * 0.05)
  // 覆盖范围：优先工具调用；没有工具时用事件点，否则整段会话会被误标成一个大空档
  const coverage = spans.length > 0 ? spans : windowEvents.map((e) => ({ start: e.t, end: e.t }))
  const covered = []
  for (const s of coverage) {
    if (!intersects(s.start, s.end, view)) continue
    covered.push([Math.max(view.from, s.start), Math.min(view.to, s.end ?? view.to)])
  }
  covered.sort((a, b) => a[0] - b[0])
  const gaps = []
  let cursor = view.from
  for (const [a, b] of covered) {
    if (a - cursor > gapThreshold) gaps.push([cursor, a])
    cursor = Math.max(cursor, b)
  }
  if (view.to - cursor > gapThreshold) gaps.push([cursor, view.to])
  // 空档带：始终画（柔和不抢活动条），标签只给最宽的 3 个，避免密集小空档变成噪点
  const gapW = (g) => x(g[1]) - x(g[0])
  const labeled = new Set(
    [...gaps]
      .filter((g) => gapW(g) > 90)
      .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
      .slice(0, 3),
  )
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const gap of gaps) {
    const [a, b] = gap
    const gx0 = x(a)
    const gx1 = Math.max(gx0 + 1, x(b))
    ctx.fillStyle = CV.gapBg
    ctx.fillRect(gx0, 0, gx1 - gx0, H)
    ctx.strokeStyle = CV.gapEdge
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(gx0 + 0.5, 4)
    ctx.lineTo(gx0 + 0.5, H - 4)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(gx1 - 0.5, 4)
    ctx.lineTo(gx1 - 0.5, H - 4)
    ctx.stroke()
    ctx.setLineDash([])
    if (!labeled.has(gap)) continue
    const label = `空闲 ${fmtDur(b - a)}`
    ctx.font = '9px ui-monospace, monospace'
    const tw = ctx.measureText(label).width
    const cx = (gx0 + gx1) / 2
    const cy = toolY + toolH + 24
    if (tw + 12 < gx1 - gx0) {
      ctx.fillStyle = CV.gapLabelBg
      ctx.beginPath()
      ctx.roundRect(cx - tw / 2 - 5, cy - 7, tw + 10, 14, 3)
      ctx.fill()
      ctx.fillStyle = CV.gapLabel
      ctx.fillText(label, cx, cy)
    }
  }
  ctx.restore()

  // 时间刻度：线 + 文字（每 1/5 一段）
  const baseY = H - 10
  ctx.strokeStyle = CV.grid
  ctx.fillStyle = CV.text
  ctx.lineWidth = 1
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'bottom'
  const tickCount = W < 520 ? 3 : 5
  for (let i = 0; i <= tickCount; i++) {
    const px = Math.round(((W - 2) * i) / tickCount) + 1
    ctx.beginPath()
    ctx.moveTo(px, baseY - 5)
    ctx.lineTo(px, baseY)
    ctx.stroke()
    const label = fmtSpan(view.from + ((view.to - view.from) * i) / tickCount)
    ctx.textAlign = i === 0 ? 'left' : i === tickCount ? 'right' : 'center'
    ctx.fillText(label, px, baseY - 7)
  }
  ctx.textBaseline = 'alphabetic'
}

/**
 * 尺寸只在 layout 变化时更新（ResizeObserver）。
 * 之前每帧都 getBoundingClientRect() —— 那是**每帧强制一次布局**，
 * 并且会让首帧的骨架屏布局挤进一个长任务里。
 */
function applyTimelineSize(width, height) {
  const W = Math.max(1, width)
  const H = Math.max(1, height)
  if (Math.abs(W - tlSize.W) <= 0.5 && Math.abs(H - tlSize.H) <= 0.5) return
  tlSize = { W, H }
  staticDirty = true
  if (meta) allocTimelineCanvas()
}

/**
 * 分配可见画布。
 * Retina 下 backing store 是 3200×2000 级（~25MB），一次分配要几十毫秒，
 * 所以它单独占一帧，不和数据渲染挤在同一个任务里。
 */
function allocTimelineCanvas() {
  const { W, H } = tlSize
  if (W <= 0 || H <= 0) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const bw = Math.round(W * dpr)
  const bh = Math.round(H * dpr)
  if (tl.width === bw && tl.height === bh) return
  tl.width = bw
  tl.height = bh
  tlCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  staticDirty = true
}

function observeTimelineSize() {
  const measure = () => {
    const r = tl.getBoundingClientRect()
    applyTimelineSize(r.width, r.height)
  }
  // 初始量一次；之后的 layout 变化由 observer 通知（不再每帧读 DOM）
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => measure())
    const wrap = tl.parentElement
    if (wrap) ro.observe(wrap)
  } else {
    window.addEventListener('resize', measure, { passive: true })
  }
}

let hoverX = null
function hideTimelineSkeleton() {
  document.getElementById('tlSkeleton')?.remove()
}

function drawTimelineFrame() {
  // 数据没到之前不画：省掉两张 Retina 尺寸 canvas 的分配与首次布局
  if (!meta) return
  const { W, H } = tlSize
  if (W <= 0 || H <= 0) return
  if (staticDirty) {
    buildTimelineStatic(W, H)
    staticDirty = false
  }
  tlCtx.clearRect(0, 0, W, H)
  hideTimelineSkeleton()
  tlCtx.drawImage(tlCache, 0, 0, W, H)

  tlCtx.save()
  if (brushRange) {
    const bx1 = xOf(Math.min(brushRange.a, brushRange.b), view, W)
    const bx2 = xOf(Math.max(brushRange.a, brushRange.b), view, W)
    tlCtx.fillStyle = CV.brushFill
    tlCtx.fillRect(bx1, 0, Math.max(1, bx2 - bx1), H)
    tlCtx.strokeStyle = CV.brushLine
    tlCtx.lineWidth = 1
    tlCtx.beginPath()
    tlCtx.moveTo(bx1, 0); tlCtx.lineTo(bx1, H)
    tlCtx.moveTo(bx2, 0); tlCtx.lineTo(bx2, H)
    tlCtx.stroke()
  }
  // 没有工具调用的会话：用事件刻度填充时间轴，否则整条轴看起来是空白
  if (spans.length === 0 && windowEvents.length > 0) {
    const bandY = Math.round(H * 0.34)
    const bandH = Math.max(6, Math.round(H * 0.2))
    tlCtx.save()
    tlCtx.fillStyle = CV.tick
    for (const e of windowEvents) {
      if (e.t < view.from || e.t > view.to) continue
      const ex = xOf(e.t, view, W)
      tlCtx.fillRect(Math.round(ex), bandY, 1.5, bandH)
    }
    tlCtx.restore()
  }

  const px = currentT < view.from || currentT > view.to ? -100 : xOf(currentT, view, W)
  tlCtx.save()
  if (playing) {
    // 播放中给播放头一点光晕，让"正在走"更明显
    tlCtx.globalAlpha = 0.25
    tlCtx.strokeStyle = CV.playhead
    tlCtx.lineWidth = 5
    tlCtx.beginPath()
    tlCtx.moveTo(px, 0)
    tlCtx.lineTo(px, H)
    tlCtx.stroke()
    tlCtx.globalAlpha = 1
  }
  tlCtx.strokeStyle = CV.playhead
  tlCtx.lineWidth = 1.4
  tlCtx.beginPath()
  tlCtx.moveTo(px, 0)
  tlCtx.lineTo(px, H)
  tlCtx.stroke()
  tlCtx.fillStyle = CV.playhead
  tlCtx.beginPath()
  tlCtx.arc(px, H - 6, 3, 0, Math.PI * 2)
  tlCtx.fill()
  if (hoverX !== null) {
    tlCtx.strokeStyle = CV.cursor
    tlCtx.beginPath()
    tlCtx.moveTo(hoverX, 0)
    tlCtx.lineTo(hoverX, H)
    tlCtx.stroke()
  }
  tlCtx.restore()
}

function tAtX(clientX) {
  const r = tl.getBoundingClientRect()
  return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * (meta ? meta.duration : 0)
}

// ── 抽屉 ──────────────────────────────────────────────────────────────────
function openDrawer(data) {
  lastFocus = document.activeElement
  drawerData = data
  const isEvent = Boolean(data.kind)
  $('#drawerTitle').textContent = isEvent
    ? `${data.kind} · seq ${data.seq ?? '?'} · ${fmtT(data.t ?? 0)}`
    : `${data.tool ?? data.path ?? '详情'} · ${data.start !== undefined ? fmtDur((data.end ?? data.start) - data.start) : ''}`
  $('#drawerBody').textContent = JSON.stringify(data, null, 2)
  $('#drawer').hidden = false
  $('#drawerBackdrop').hidden = false
  $('#drawer').focus()
}
function closeDrawer() {
  const wasOpen = !$('#drawer').hidden
  $('#drawer').hidden = true
  $('#drawerBackdrop').hidden = true
  drawerData = null
  // 关闭后把焦点还给打开它的元素（键盘用户不能"丢焦点"）
  if (wasOpen) {
    // 列表行是虚拟列表，重新渲染后原节点可能已被替换 —— 退回到列表容器
    const target = lastFocus && document.contains(lastFocus) ? lastFocus : $('#rlist')
    try {
      target?.focus()
    } catch {
      /* ignore */
    }
  }
  lastFocus = null
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────
function bindEvents() {
  // 注意：这里**不**测量时间轴尺寸。
  // 测量会强制一次整页布局；而数据没到之前根本不画时间轴，
  // 所以把测量推迟到数据就绪之后（见 loadStatic）。
  tl.addEventListener('pointerdown', (e) => {
    if (!meta) return
    setPlaying(false)
    following = false
    mark('chrome')
    tl.setPointerCapture(e.pointerId)
    const startX = e.clientX - tl.getBoundingClientRect().left
    const startT = tOf(startX, view, tlSize.W)
    const mode = e.shiftKey ? 'pan' : 'brush'
    let moved = false
    const onMove = (ev) => {
      const x = clamp(ev.clientX - tl.getBoundingClientRect().left, 0, tlSize.W)
      if (mode === 'pan') {
        if (Math.abs(ev.clientX - e.clientX) > 2) moved = true
        const msPerPx = (view.to - view.from) / Math.max(1, tlSize.W - 2)
        setView(panWindow(view, meta.duration, -(ev.movementX || 0) * msPerPx))
        return
      }
      if (Math.abs(x - startX) > 3) moved = true
      if (moved) brushRange = { a: startT, b: tOf(x, view, tlSize.W) }
    }
    const onUp = (ev) => {
      tl.removeEventListener('pointermove', onMove)
      tl.removeEventListener('pointerup', onUp)
      if (mode === 'pan') {
        if (!moved) void seek(startT)
        brushRange = null
        return
      }
      const endX = clamp(ev.clientX - tl.getBoundingClientRect().left, 0, tlSize.W)
      const movedPx = Math.abs(endX - startX)
      brushRange = null
      if (moved && movedPx > 6) {
        setView(brushWindow(startT, tOf(endX, view, tlSize.W), meta.duration))
      } else {
        void seek(startT)
      }
    }
    tl.addEventListener('pointermove', onMove)
    tl.addEventListener('pointerup', onUp)
  })
  tl.addEventListener(
    'wheel',
    (e) => {
      if (!meta) return
      e.preventDefault()
      const rect = tl.getBoundingClientRect()
      const anchor = tOf(clamp(e.clientX - rect.left, 0, rect.width), view, tlSize.W)
      // deltaY > 0（向下）→ 缩小；向上 → 放大。指数映射保证手感均匀
      zoomAt(anchor, Math.exp(e.deltaY * 0.0018))
      following = false
    },
    { passive: false },
  )
  tl.addEventListener('dblclick', () => resetView())
  tl.addEventListener('pointerleave', () => {
    hoverX = null
    $('#tlTip').hidden = true
  })

  // 标签页键盘导航：←/→/Home/End
  $('#tabs').addEventListener('keydown', (e) => {
    const tabs = [...$('#tabs').querySelectorAll('button[data-tab]')]
    const idx = tabs.findIndex((t) => t.classList.contains('on'))
    let next = -1
    if (e.code === 'ArrowRight') next = (idx + 1) % tabs.length
    else if (e.code === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length
    else if (e.code === 'Home') next = 0
    else if (e.code === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    tabs[next].click()
    tabs[next].focus()
  })
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]')
    if (!b) return
    tab = b.dataset.tab
    $('#tabs').querySelectorAll('button').forEach((x) => {
      const on = x === b
      x.classList.toggle('on', on)
      x.setAttribute('aria-selected', String(on))
    })
    mark('list')
  })
  const searchInput = $('#search')
  const searchClear = $('#searchClear')
  searchClear?.addEventListener('click', () => {
    if (!searchInput) return
    searchInput.value = ''
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    searchInput.focus()
  })
  searchInput?.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      e.preventDefault()
      searchInput.value = ''
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      searchInput.blur()
    }
  })
  $('#search').addEventListener('input', (e) => {
    if (searchClear) searchClear.hidden = e.target.value === ''
    search = e.target.value
    mark('list')
  })
  $('#onlyFail').addEventListener('change', (e) => {
    onlyFail = e.target.checked
    mark('waterfall', 'list')
  })
  $('#btnPlay').addEventListener('click', () => {
    if (!playing && currentT >= (meta?.duration ?? 0)) currentT = 0
    following = false
    mark('chrome')
    setPlaying(!playing)
    showToast(playing ? '播放中（空格暂停）' : '已暂停')
  })
  $('#btnFollow').addEventListener('click', async () => {
    following = !following
    mark('chrome')
    if (following) {
      setPlaying(false)
      if (meta) await seek(meta.duration)
      if (meta?.follow) {
        showToast('已跟随最新（实时会话，有新事件会自动刷新）')
        ensureLiveLoop()
      } else {
        const ended = state?.run?.status === 'done'
        showToast(ended ? '已跳到最新（该会话已结束）' : '已跳到最新')
      }
      const list = document.getElementById('rlist')
      if (list) list.scrollTop = 0
    } else {
      showToast('已取消跟随')
    }
  })
  $('#btnFocus').addEventListener('click', () => toggleFocusMode())
  $('#speed').addEventListener('change', (e) => {
    speed = Number(e.target.value) || 1
  })
  $('#winChip')?.addEventListener('click', () => resetView())
  $('#errorRetry')?.addEventListener('click', () => location.reload())
  $('#onboardOk')?.addEventListener('click', () => hideOnboard())
  $('#onboardClose')?.addEventListener('click', () => hideOnboard())
  $('#onboard')?.addEventListener('click', (e) => {
    if (e.target.id === 'onboard') hideOnboard()
  })
  $('#helpReplayGuide')?.addEventListener('click', () => {
    toggleHelp(false)
    showOnboard(true)
  })
  // 会话切换器
  $('#sessionSwitch')?.addEventListener('click', () => void openSwitcher())
  $('#sessionTitle')?.addEventListener('click', () => void openSwitcher())
  $('#switchRefresh')?.addEventListener('click', async () => {
    swSessions = null
    try {
      await ensureSessions()
      renderSwitcherList($('#switchSearch')?.value ?? '')
    } catch {
      /* ignore */
    }
  })
  $('#switcher')?.addEventListener('click', (e) => {
    if (e.target.id === 'switcher') closeSwitcher()
  })
  $('#switchSearch')?.addEventListener('input', (e) => {
    swIndex = 0
    renderSwitcherList(e.target.value)
  })
  $('#switchSearch')?.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault()
      if (swFiltered.length === 0) return
      swIndex = (swIndex + (e.code === 'ArrowDown' ? 1 : -1) + swFiltered.length) % swFiltered.length
      renderSwitcherList(e.target.value)
    } else if (e.code === 'Enter') {
      e.preventDefault()
      const pick = swFiltered[swIndex]
      if (pick) void switchSession(pick.file)
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault()
      const pick = swFiltered[swIndex]
      if (pick) {
        togglePin(pick.sessionId)
        renderSwitcherList(e.target.value)
      }
    } else if (e.code === 'Escape') {
      e.preventDefault()
      closeSwitcher()
    }
  })
  $('#btnHelp')?.addEventListener('click', () => toggleHelp())
  $('#helpClose')?.addEventListener('click', () => toggleHelp(false))
  $('#helpPanel')?.addEventListener('click', (e) => {
    if (e.target.id === 'helpPanel') toggleHelp(false)
  })
  $('#btnPanel')?.addEventListener('click', () => {
    const open = document.body.classList.toggle('panel-open')
    $('#btnPanel').setAttribute('aria-expanded', String(open))
  })
  $('#btnRefresh').addEventListener('click', async () => {
    try {
      await refreshStatic()
      await seek(currentT)
      scheduleWindowEvents()
    } catch (err) {
      showError(err)
    }
  })
  $('#drawerClose').addEventListener('click', closeDrawer)
  $('#drawerBackdrop').addEventListener('click', closeDrawer)
  $('#drawerCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(drawerData, null, 2))
      $('#drawerCopy').textContent = '已复制'
      setTimeout(() => ($('#drawerCopy').textContent = '复制 JSON'), 1200)
    } catch { /* ignore */ }
  })
  $('#drawerJump').addEventListener('click', () => {
    const t = drawerData?.t ?? drawerData?.start
    if (typeof t === 'number') {
      closeDrawer()
      setPlaying(false)
      following = false
      void seek(t)
    }
  })

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      if (isSwitcherOpen()) closeSwitcher()
      else void openSwitcher()
      return
    }
    if (isSwitcherOpen()) {
      if (e.code === 'Escape') closeSwitcher()
      return
    }
    if (e.target instanceof HTMLInputElement) return
    if (!$('#drawer').hidden) {
      if (e.code === 'Escape') {
        closeDrawer()
        return
      }
      trapTab(e, $('#drawer'))
      return
    }
    const onboardEl = $('#onboard')
    if (onboardEl && !onboardEl.hidden) {
      if (e.code === 'Escape') {
        e.preventDefault()
        hideOnboard()
      }
      return
    }
    if (isHelpOpen()) {
      if (e.code === 'Escape' || e.key === '?') {
        e.preventDefault()
        toggleHelp(false)
        return
      }
      trapTab(e, $('#helpPanel'))
      return
    }
    if (e.code === 'Space') { e.preventDefault(); $('#btnPlay').click() }
    else if (e.code === 'ArrowRight') { setPlaying(false); void seek(currentT + (e.shiftKey ? 5000 : 1000)) }
    else if (e.code === 'ArrowLeft') { setPlaying(false); void seek(currentT - (e.shiftKey ? 5000 : 1000)) }
    else if (e.code === 'ArrowDown') { e.preventDefault(); moveCursor(1) }
    else if (e.code === 'ArrowUp') { e.preventDefault(); moveCursor(-1) }
    else if (e.code === 'Enter' && cursorIndex >= 0) onRowActivate(cursorIndex)
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(currentT, 0.6) }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(currentT, 1.7) }
    else if (e.key === '0') { e.preventDefault(); resetView() }
    else if (e.code === 'Home') void seek(0)
    else if (e.code === 'End') void seek(meta?.duration ?? 0)
    else if (e.key === '?') { e.preventDefault(); toggleHelp(true) }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); cycleTheme() }
    else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault()
      toggleFocusMode()
    }
    else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault()
      const sid = meta?.run
      if (sid) {
        const now = togglePin(sid)
        showToast(now ? '已收藏当前会话' : '已取消收藏')
      }
    }
    else if (e.key === '/') {
      e.preventDefault()
      const input = $('#search')
      input?.focus()
      input?.select()
    }
    else if (e.code === 'Escape') closeDrawer()
  })

  window.addEventListener('resize', () => {
    mark('spark', 'timelineStatic')
  })
}

// 调试钩子（scripts/shot.mjs / perf.mjs 用）
window.__bb = {
  get meta() { return meta },
  get state() { return state },
  get spans() { return spans },
  get series() { return series },
  get currentT() { return currentT },
  get view() { return { ...view } },
  get windowEvents() { return windowEvents.length },
  get timings() { return { ...renderTimings } },
  get tlSize() { return { ...tlSize } },
  get longTasks() { return window.__longTasks || [] },
  get wfTool() { return wfTool },
  toggleHelp: (on) => toggleHelp(on),
  showOnboard: (force) => showOnboard(force),
  showError: (msg) => showError(new Error(String(msg))),
  get dataReady() {
    return dataReady
  },
  get focus() {
    return { mode: focusMode, times: activityTimes.length, next: nextActivityAfter(currentT + 1) }
  },
  updateFocus: (t) => updateFocus(t),
  focusDebug: () => ({
    agents: Object.values(state?.agents ?? {}).map((a) => a.agent),
    states: Object.values(state?.agents ?? {}).map((a) => a.state),
    cards: [...document.querySelectorAll('.agent-name')].map((e) => e.textContent),
    spans: spans.length,
    visible: visibleRows.length,
    wfRows: wfRows.length,
  }),
  hideOnboard: () => hideOnboard(),
  setOnlyFail: (on) => { onlyFail = on; mark('waterfall') },
  get marks() {
    const out = {}
    for (const m of performance.getEntriesByType('mark')) {
      if (m.name.startsWith('bb:')) out[m.name.slice(3)] = Math.round(m.startTime)
    }
    return out
  },
  setIndexChip: (on) => setIndexChip(on),
  setTab: (t) => { tab = t; mark('list') },
  get eventsMeta() { return { ...eventsMeta } },
  setView: (from, to) => setView({ from, to }),
  resetView: () => resetView(),
  seek: (t) => seek(t),
}

init().catch(showError)
