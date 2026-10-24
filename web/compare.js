/**
 * 会话对比页
 * ==========
 * 目标不是"谁的数大"，而是**结构差异**：把两个会话的用量、工具分布、阻塞拆开对齐，
 * 回答"为什么这个比那个贵/慢一倍"。
 */

import { hydrateIcons, icon } from './icons.js'
import { initTooltips } from './tooltip.js'
import { initTheme } from './theme.js'

const $ = (s) => document.querySelector(s)
const RUNTIME_LABEL = { dsh: 'DSH', 'claude-code': 'Claude Code', codex: 'Codex' }

const pad2 = (n) => String(Math.floor(n)).padStart(2, '0')
const fmtSpan = (ms) => {
  const s = Math.round(Math.max(0, ms) / 1000)
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`
}
const fmtDur = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : fmtSpan(ms))
const fmtTok = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`)
const fmtNum = (n) => n.toLocaleString('en-US')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const money = (v, cur) => {
  if (v === undefined) return '—'
  const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : `${cur} `
  if (v === 0) return `${sym}0`
  if (v < 0.01) return `${sym}${v.toFixed(4)}`
  if (v < 1) return `${sym}${v.toFixed(3)}`
  return `${sym}${v.toFixed(2)}`
}

const METRICS = [
  { key: 'durationMs', label: '时长', fmt: fmtSpan, worse: 'up' },
  { key: 'events', label: '事件数', fmt: fmtNum },
  { key: 'toolCalls', label: '工具调用', fmt: fmtNum },
  { key: 'toolFails', label: '工具失败', fmt: fmtNum, worse: 'up' },
  { key: 'tokensIn', label: '输入 token', fmt: fmtTok, worse: 'up' },
  { key: 'tokensOut', label: '输出 token', fmt: fmtTok, worse: 'up' },
  { key: 'tokensCached', label: '缓存 token', fmt: fmtTok },
  { key: 'cacheHitRate', label: '缓存命中率', fmt: (v) => `${v}%` },
  { key: 'cost', label: '估算成本', fmt: (v) => v, worse: 'up' },
  { key: 'blockedMs', label: '阻塞时长', fmt: fmtDur, worse: 'up' },
  { key: 'checkpoints', label: '轮次 / 检查点', fmt: fmtNum },
]

const state = {
  left: null,
  right: null,
  sessions: [],
  sessionsLoaded: false,
  data: null,
  loading: false,
  pickerSide: null,
}

// ── URL 同步 ──────────────────────────────────────────────────────────────
function readParams() {
  const p = new URLSearchParams(location.search)
  state.left = p.get('left')
  state.right = p.get('right')
}
function writeParams() {
  const p = new URLSearchParams()
  if (state.left) p.set('left', state.left)
  if (state.right) p.set('right', state.right)
  history.replaceState(null, '', `${location.pathname}?${p.toString()}`)
}

// ── 拉数据 ────────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const res = await fetch('api/overview')
    const data = await res.json()
    state.sessions = data.rows || []
    state.sessionsLoaded = true
    if (data.loading) setTimeout(loadSessions, 1200)
  } catch {
    state.sessions = []
    state.sessionsLoaded = true
  }
}

async function loadCompare() {
  if (!state.left || !state.right) {
    state.data = null
    render()
    return
  }
  state.loading = true
  render()
  try {
    const res = await fetch(`api/compare?left=${encodeURIComponent(state.left)}&right=${encodeURIComponent(state.right)}`)
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    state.data = data
  } catch (err) {
    state.data = { error: err instanceof Error ? err.message : String(err) }
  }
  state.loading = false
  render()
}

const sessionOf = (file) => state.sessions.find((s) => s.file === file)

function pickHTML(file, side) {
  if (!file) {
    return `<div class="pick-empty">＋ 选择${side === 'left' ? '左' : '右'}侧会话</div>`
  }
  const card = state.data && !state.data.error ? state.data[side] : null
  const s = sessionOf(file)
  const runtime = card?.runtime ?? s?.runtime ?? ''
  const short = String(card?.sessionId ?? s?.sessionId ?? file.split('/').slice(-1)[0]).replace(/^session-/, '').slice(0, 8)
  const title = card?.title || s?.title
  const goal = title || card?.goal || s?.goal || card?.project || s?.project || file
  const cur = state.data?.currency ?? 'USD'
  const nums = card
    ? `<div class="big" style="margin-top:2px">
         <div><span>时长</span><b>${fmtSpan(card.durationMs)}</b></div>
         <div><span>工具</span><b>${fmtNum(card.toolCalls)}</b></div>
         <div><span>token</span><b>${fmtTok(card.tokens.in)}/${fmtTok(card.tokens.out)}</b></div>
         <div><span>成本</span><b>${card.cost === undefined ? '—' : money(card.cost, cur)}</b></div>
       </div>`
    : `<div class="pick-meta" style="color:var(--text-3)">${s ? `${fmtTok(s.tokens.in)}↑ ${fmtTok(s.tokens.out)}↓ · ${s.toolCalls} 次工具` : ''}</div>`
  return `
    <div class="pick-head">
      <span class="chip rt-${runtime}">${RUNTIME_LABEL[runtime] ?? (runtime || '会话')}</span>
      <span class="pick-goal" title="${esc(goal)}">${esc(goal)}</span>
    </div>
    <div class="pick-meta">${esc(short)} · ${esc(card?.project ?? s?.project ?? '')} · 点击更换</div>
    ${nums}`
}

function renderPickers() {
  const l = $('#pickLeft')
  const r = $('#pickRight')
  l.innerHTML = pickHTML(state.left, 'left')
  r.innerHTML = pickHTML(state.right, 'right')
  $('#scopeChip').textContent = state.left && state.right ? '已选择两个会话' : '请选择两个会话'
}

// ── 渲染 ──────────────────────────────────────────────────────────────────
/**
 * Δ 展示：方向箭头 + 百分比 + 绝对值。
 * 注意 `delta.abs` 可能是负数（右比左小），格式化前必须取绝对值，
 * 否则像时长这种"从 0 起算"的格式化函数会把它压成 0:00。
 */
function deltaText(m, delta, fmtAbs) {
  if (delta.pct === null) return '<span class="d-flat">—</span>'
  const pct = delta.pct
  const arrow = pct > 0.05 ? '↑' : pct < -0.05 ? '↓' : '→'
  const sign = delta.abs > 0 ? '+' : delta.abs < 0 ? '−' : ''
  const absText = `${sign}${fmtAbs(Math.abs(delta.abs))}`
  let cls = 'd-flat'
  if (m.worse === 'up' && Math.abs(pct) > 0.5) cls = pct > 0 ? 'd-up' : 'd-down'
  else if (Math.abs(pct) > 0.5) cls = pct > 0 ? 'd-down' : 'd-up'
  return `<span class="${cls}">${arrow} ${Math.abs(pct).toFixed(1)}% <span style="color:var(--text-4)">(${absText})</span></span>`
}

function renderMetrics() {
  const d = state.data
  if (!d || d.error) {
    $('#metricsWrap').hidden = true
    return
  }
  $('#metricsWrap').hidden = false
  $('#metricsBody').innerHTML = METRICS.map((m) => {
    const delta = d.deltas[m.key]
    if (!delta) return ''
    const fmtAbs = (v) => {
      if (m.key === 'cost') return money(v, d.currency)
      if (m.key === 'durationMs' || m.key === 'blockedMs') return fmtSpan(v)
      if (m.key === 'tokensIn' || m.key === 'tokensOut' || m.key === 'tokensCached') return fmtTok(v)
      if (m.key === 'cacheHitRate') return `${v.toFixed(1)}pp`
      return fmtNum(Math.round(v))
    }
    return `<tr>
      <td>${m.label}</td>
      <td>${m.key === 'cost' ? money(delta.left, d.currency) : m.fmt(delta.left)}</td>
      <td>${m.key === 'cost' ? money(delta.right, d.currency) : m.fmt(delta.right)}</td>
      <td>${deltaText(m, delta, fmtAbs)}</td>
    </tr>`
  }).join('')
}

function renderTools() {
  const d = state.data
  if (!d || d.error || !d.tools?.length) {
    $('#toolsWrap').hidden = true
    return
  }
  $('#toolsWrap').hidden = false
  const rows = d.tools.slice(0, 14)
  // 条长 = 该工具占**本会话**工具调用的比例。
  // 不用"两侧取最大"做归一化：当一边 5000 次、另一边 200 次时，
  // 小的一侧会被压到 5% 看不见，而我们要比较的恰恰是"结构差异"。
  const leftTotal = Math.max(1, d.tools.reduce((a, t) => a + t.left.calls, 0))
  const rightTotal = Math.max(1, d.tools.reduce((a, t) => a + t.right.calls, 0))
  $('#toolsBody').innerHTML = rows
    .map((t) => {
      const lw = (t.left.calls / leftTotal) * 100
      const rw = (t.right.calls / rightTotal) * 100
      const fails = (s) => (s.fails > 0 ? ` ✗${s.fails}` : '')
      return `<div class="tool-row" title="${esc(t.tool)} · 左 ${t.left.calls} 次 ${fmtDur(t.left.ms)} / 右 ${t.right.calls} 次 ${fmtDur(t.right.ms)}">
        <div class="tool-name">${esc(t.tool)}</div>
        <div class="tool-track" style="display:flex; align-items:center; gap:6px; background:none">
          <div class="tool-track" style="flex:1"><div class="tool-bar l" style="width:${lw}%"></div></div>
          <div class="tool-n" style="width:52px; text-align:right">${t.left.calls}${fails(t.left)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px">
          <div class="tool-track" style="flex:1"><div class="tool-bar r" style="width:${rw}%"></div></div>
          <div class="tool-n" style="width:52px; text-align:right">${t.right.calls}${fails(t.right)}</div>
        </div>
      </div>`
    })
    .join('')
}

function renderWarn() {
  const d = state.data
  const el = $('#warn')
  const lines = []
  if (d?.error) lines.push(`${icon('alert', '', 14)} 对比失败：${esc(d.error)}`)
  if (d?.unpricedModels?.length) {
    lines.push(`⚠ ${d.unpricedModels.length} 个模型没有价格，成本列不参与对比：${d.unpricedModels.slice(0, 6).map(esc).join('、')}`)
  }
  if (d?.models && d.models.left.length + d.models.right.length > 0) {
    const shared = d.models.shared
    lines.push(`模型：左 ${d.models.left.map(esc).join(', ')} · 右 ${d.models.right.map(esc).join(', ')}${shared.length ? ` · 共有 ${shared.map(esc).join(', ')}` : ''}`)
  }
  el.hidden = lines.length === 0
  el.innerHTML = lines.join('<br>')
}

function render() {
  renderPickers()
  renderMetrics()
  renderTools()
  renderWarn()
  if (state.loading) {
    $('#metricsWrap').hidden = false
    $('#metricsBody').innerHTML = Array.from({ length: 6 })
      .map(() => '<tr><td><div class="sk" style="width:70px"></div></td><td><div class="sk" style="width:60px;margin-left:auto"></div></td><td><div class="sk" style="width:60px;margin-left:auto"></div></td><td><div class="sk" style="width:80px;margin-left:auto"></div></td></tr>')
      .join('')
  }
}

// ── 选择器 ────────────────────────────────────────────────────────────────
let pickerIndex = 0

function openPicker(side) {
  state.pickerSide = side
  pickerIndex = 0
  $('#pickerTitle').textContent = side === 'left' ? '选择左侧会话' : '选择右侧会话'
  $('#pickerPanel').hidden = false
  $('#pickerSearch').value = ''
  renderPickerList('')
  $('#pickerSearch').focus()
}

function renderPickerList(q) {
  const query = q.trim().toLowerCase()
  const rows = state.sessions
    .filter((s) => !query || `${s.title ?? ''} ${s.project} ${s.sessionId} ${s.goal ?? ''}`.toLowerCase().includes(query))
    .slice(0, 120)
  pickerIndex = Math.min(pickerIndex, Math.max(0, rows.length - 1))
  $('#pickerList').innerHTML = rows.length
    ? rows
        .map(
          (s, i) => `<div class="picker-row ${i === pickerIndex ? 'on' : ''}" data-file="${esc(s.file)}" data-tip="${esc(s.file)}">
            <div><span class="chip rt-${s.runtime}">${RUNTIME_LABEL[s.runtime] ?? s.runtime}</span></div>
            <div class="tool-n">${esc(String(s.sessionId).replace(/^session-/, '').slice(0, 8))} · ${fmtTok(s.tokens.in)}↑</div>
            <div class="goal">${esc(s.title || s.goal || s.project)}</div>
          </div>`,
        )
        .join('')
    : `<div class="picker-empty">${icon('search', '', 20)}<span>没有匹配会话</span></div>`
  $('#pickerList').querySelectorAll('.picker-row[data-file]').forEach((row) =>
    row.addEventListener('click', () => {
      if (state.pickerSide === 'left') state.left = row.dataset.file
      else state.right = row.dataset.file
      $('#pickerPanel').hidden = true
      writeParams()
      void loadCompare()
    }),
  )
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────
$('#pickLeft').addEventListener('click', () => openPicker('left'))
$('#pickRight').addEventListener('click', () => openPicker('right'))
$('#pickerClose').addEventListener('click', () => ($('#pickerPanel').hidden = true))
$('#pickerPanel').addEventListener('click', (e) => {
  if (e.target.id === 'pickerPanel') $('#pickerPanel').hidden = true
})
$('#pickerSearch').addEventListener('input', (e) => {
  pickerIndex = 0
  renderPickerList(e.target.value)
})
$('#pickerSearch').addEventListener('keydown', (e) => {
  const rows = [...$('#pickerList').querySelectorAll('.picker-row[data-file]')]
  if (rows.length === 0) return
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
    e.preventDefault()
    pickerIndex = (pickerIndex + (e.code === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows.forEach((r, i) => r.classList.toggle('on', i === pickerIndex))
    rows[pickerIndex].scrollIntoView({ block: 'nearest' })
  } else if (e.code === 'Enter') {
    e.preventDefault()
    rows[pickerIndex]?.click()
  }
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#pickerPanel').hidden = true
})

// ── 启动 ──────────────────────────────────────────────────────────────────
async function init() {
  readParams()
  render()
  await loadSessions()
  // 已经有参数就直接对比；否则让用户点选
  if (state.left && state.right) await loadCompare()
  else if (state.left && !state.right) openPicker('right')
  else if (!state.left && state.right) openPicker('left')
  render()
  if (!state.right) openPicker(state.left ? 'right' : 'left')
}

initTheme()
initTooltips()
hydrateIcons()
init()
