/**
 * 会话总览页
 * ==========
 * 数据来自 `/api/overview`（服务端在 worker 里算好，查不到价格就显示 —）。
 * 这一页只做：骨架屏 → 展示 → 排序 / 过滤 / 搜索 → 点一行进仪表盘。
 */

import { hydrateIcons, icon } from './icons.js'
import { isPinned, onPinsChange, togglePin } from './pins.js'
import { initTooltips } from './tooltip.js'
import { initTheme } from './theme.js'

const $ = (s) => document.querySelector(s)
const RUNTIME_LABEL = { dsh: 'DSH', 'claude-code': 'Claude Code', codex: 'Codex' }

const fmtTok = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtSpan = (ms) => {
  const s = Math.round(Math.max(0, ms) / 1000)
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const rel = (ms) => {
  const d = Date.now() - ms
  if (d < 60000) return `${Math.round(d / 1000)} 秒前`
  if (d < 3600000) return `${Math.round(d / 60000)} 分钟前`
  if (d < 86400000) return `${Math.round(d / 3600000)} 小时前`
  return `${Math.round(d / 86400000)} 天前`
}
const money = (v, currency) => {
  const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
  if (v === 0) return `${sym}0`
  if (v < 0.01) return `${sym}${v.toFixed(4)}`
  if (v < 1) return `${sym}${v.toFixed(3)}`
  return `${sym}${v.toFixed(2)}`
}

const COLUMNS = [
  { key: 'runtime', label: 'runtime', num: false },
  { key: 'mtime', label: '最近活动', num: true },
  { key: 'durationMs', label: '时长', num: true },
  { key: 'events', label: '事件', num: true },
  { key: 'toolCalls', label: '工具', num: true },
  { key: 'tokens', label: 'token 输入 / 输出 / 缓存', num: true },
  { key: 'cost', label: '成本', num: true },
  { key: 'project', label: '会话 · 项目', num: false },
]

const params = new URLSearchParams(location.search)
const state = {
  data: null,
  runtime: null,
  q: '',
  hideEmpty: params.get('hideEmpty') !== '0',
  sortKey: 'tokens',
  sortDir: -1,
  loading: true,
  compareMode: false,
  compareA: null,
  cursor: -1,
}

let ovSlowTimer = null
function setOvStatus(text) {
  const box = document.getElementById('ovStatus')
  const label = document.getElementById('ovStatusText')
  if (!box || !label) return
  if (text === null) {
    box.hidden = true
    return
  }
  box.hidden = false
  label.textContent = text
}

async function load(refresh = false) {
  state.loading = true
  render()
  setOvStatus('正在扫描本机会话…')
  if (ovSlowTimer !== null) clearTimeout(ovSlowTimer)
  ovSlowTimer = setTimeout(() => setOvStatus('会话较多时首次扫描需要几秒，正在继续…'), 1800)
  try {
    const res = await fetch(`api/overview${refresh ? '?refresh=1' : ''}`)
    state.data = await res.json()
  } catch (err) {
    state.data = { error: String(err), rows: [] }
  }
  if (ovSlowTimer !== null) {
    clearTimeout(ovSlowTimer)
    ovSlowTimer = null
  }
  state.loading = state.data?.loading === true
  if (state.loading) {
    setOvStatus('会话较多时首次扫描需要几秒，正在继续…')
  } else {
    setOvStatus(null)
  }
  render()
  if (state.loading) setTimeout(() => load(false), 1200)
}

const valueOf = (row) => {
  switch (state.sortKey) {
    case 'runtime': return row.runtime
    case 'mtime': return row.mtime
    case 'durationMs': return row.durationMs
    case 'events': return row.events
    case 'toolCalls': return row.toolCalls
    case 'tokens': return row.tokens.in + row.tokens.out + row.tokens.cached
    case 'cost': return row.cost ?? -1
    default: return row.project
  }
}

function renderSkeleton() {
  $('#body').innerHTML = Array.from({ length: 8 })
    .map(
      () => `<tr class="sk-row"><td colspan="8"><div class="sk" style="width:${40 + Math.random() * 50}%"></div></td></tr>`,
    )
    .join('')
  $('#stats').innerHTML = Array.from({ length: 6 })
    .map(() => `<div class="stat"><div class="sk" style="width:50%"></div><div style="height:22px"></div></div>`)
    .join('')
}

function render() {
  // 数据没到：保留 HTML 里的骨架行，别先清空
  if (!state.data) return
  const d = state.data
  $('#head').innerHTML = COLUMNS.map(
    (c) => `<th class="${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}${state.sortKey === c.key ? (state.sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`,
  ).join('')
  $('#head').querySelectorAll('th').forEach((th) =>
    th.addEventListener('click', () => {
      const k = th.dataset.key
      if (state.sortKey === k) state.sortDir = -state.sortDir
      else {
        state.sortKey = k
        state.sortDir = k === 'runtime' || k === 'project' ? 1 : -1
      }
      render()
    }),
  )

  if (!d || state.loading) {
    renderSkeleton()
    $('#subtitle').textContent = '正在扫描所有会话…（首次会慢一点，之后走缓存）'
    return
  }
  if (d.error) {
    $('#body').innerHTML = `<tr><td colspan="8"><div class="empty-state" style="color:var(--bad)">${icon('alert', '', 20)}<b>扫描失败</b><p>${esc(d.error)}</p><p>检查会话目录是否存在，或点「重新扫描」重试。</p></div></td></tr>`
    return
  }

  const counts = {}
  for (const r of d.rows) counts[r.runtime] = (counts[r.runtime] ?? 0) + 1
  $('#runtimes').innerHTML =
    `<button data-rt="" class="${state.runtime === null ? 'on' : ''}" data-tip="显示全部 runtime">全部 ${d.rows.length}</button>` +
    Object.entries(RUNTIME_LABEL)
      .filter(([k]) => (counts[k] ?? 0) > 0)
      .map(
        ([k, label]) =>
          `<button data-rt="${k}" class="${state.runtime === k ? 'on' : ''}" data-tip="只看 ${label} 会话（${counts[k]} 个）">${label} ${counts[k]}</button>`,
      )
      .join('')
  $('#runtimes').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.runtime = b.dataset.rt === '' ? null : b.dataset.rt
      render()
    }),
  )

  const q = state.q.trim().toLowerCase()
  let rows = d.rows.filter((r) => (state.runtime === null || r.runtime === state.runtime))
  if (q) rows = rows.filter((r) => `${r.title ?? ''} ${r.project} ${r.sessionId}`.toLowerCase().includes(q))
  if (state.hideEmpty) rows = rows.filter((r) => r.tokens.in + r.tokens.out + r.tokens.cached > 0)
  rows = [...rows].sort((a, b) => {
    const va = valueOf(a)
    const vb = valueOf(b)
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * state.sortDir
    return (va - vb) * state.sortDir
  })

  const sum = (fn) => rows.reduce((a, r) => a + fn(r), 0)
  const tokens = {
    in: sum((r) => r.tokens.in),
    out: sum((r) => r.tokens.out),
    cached: sum((r) => r.tokens.cached),
  }
  const cost = sum((r) => r.cost ?? 0)
  const hit = tokens.in + tokens.cached > 0 ? Math.round((tokens.cached / (tokens.in + tokens.cached)) * 100) : 0
  $('#stats').innerHTML = [
    { k: '会话', v: String(rows.length), s: `共发现 ${d.discovered} 个` },
    { k: '输入 token', v: fmtTok(tokens.in), s: `缓存命中 ${hit}%` },
    { k: '输出 token', v: fmtTok(tokens.out), s: '' },
    { k: '缓存 token', v: fmtTok(tokens.cached), s: '' },
    { k: '工具调用', v: String(sum((r) => r.toolCalls)), s: `${sum((r) => r.toolFails)} 次失败` },
    { k: '估算成本', v: money(cost, d.currency), s: d.unpricedModels.length ? `${d.unpricedModels.length} 个模型未定价` : '全部已定价' },
  ]
    .map((i) => `<div class="stat"><div class="stat-k">${i.k}</div><div class="stat-v">${i.v}${i.s ? ` <small>${esc(i.s)}</small>` : ''}</div></div>`)
    .join('')

  $('#subtitle').textContent =
    `${d.rows.length} 个已统计${d.scanned ? `（本次新扫 ${d.scanned} 个）` : '（全部命中缓存）'}` +
    `${d.skippedLarge ? ` · ${d.skippedLarge} 个文件过大未统计` : ''}` +
    `${d.loading ? ' · 后台刷新中…' : ''}`
  $('#scopeChip').textContent = state.runtime === null ? '全部 runtime' : RUNTIME_LABEL[state.runtime]

  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens.in + r.tokens.out))
  $('#body').innerHTML = rows.length
    ? rows
        .map((r) => {
          const toks = r.tokens.in + r.tokens.out
          const bar = `<span class="bar" style="width:${Math.max(2, Math.round((toks / maxTokens) * 42))}px"></span>`
          const costCell = !toks
            ? '<span class="cost unknown">—</span>'
            : r.missingPrice
              ? `<span class="cost missing" title="有模型未配置价格，不参与合计">${r.cost !== undefined ? money(r.cost, d.currency) + '*' : '—'}</span>`
              : `<span class="cost">${money(r.cost ?? 0, d.currency)}</span>`
          const short = String(r.sessionId).replace(/^session-/, '').slice(0, 8)
          return `<tr data-file="${esc(r.file)}" data-row="${rows.indexOf(r)}">
            <td><span class="chip rt-${r.runtime}">${RUNTIME_LABEL[r.runtime] ?? r.runtime}</span></td>
            <td class="num">${rel(r.mtime)}</td>
            <td class="num">${fmtSpan(r.durationMs)}</td>
            <td class="num">${r.events}</td>
            <td class="num">${r.toolCalls}${r.toolFails ? ` <span style="color:var(--bad)">✗${r.toolFails}</span>` : ''}</td>
            <td class="num">${bar}${fmtTok(r.tokens.in)} / ${fmtTok(r.tokens.out)} / ${fmtTok(r.tokens.cached)}</td>
            <td class="num">${costCell}</td>
            <td>${
              (() => {
                const fav = isPinned(r.sessionId)
                const star = `<button class="row-pin ${fav ? 'on' : ''}" data-pin="${esc(r.sessionId)}" data-tip="${fav ? '取消收藏' : '收藏会话'}" aria-label="${fav ? '取消收藏' : '收藏会话'}">${icon(fav ? 'star' : 'starOff', '', 13)}</button>`
                const body = r.title
                  ? `<span class="proj" title="${esc(r.file)}"><b class="proj-title">${esc(r.title)}</b><span class="proj-sub">${esc(r.project)} · ${esc(short)}</span></span>`
                  : `<span class="proj" title="${esc(r.file)}"><span>${esc(r.project)}</span> · <b>${esc(short)}</b></span>`
                return `<span class="proj-wrap">${star}${body}</span>`
              })()
            }</td>
          </tr>`
        })
        .join('')
    : d.discovered === 0
      ? `<tr><td colspan="8">
           <div class="empty-state">
             ${icon('inbox', '', 20)}
             <b>还没有发现任何会话</b>
             <p>agent-blackbox 会扫描本机以下位置：</p>
             <ul>
               <li><code>~/.dsh/sessions/</code> · DSH</li>
               <li><code>~/.claude/projects/</code> · Claude Code</li>
               <li><code>~/.codex/sessions/</code> · Codex</li>
             </ul>
             <p>先跟 agent 聊几句，再点右上角「重新扫描」。</p>
           </div>
         </td></tr>`
      : `<tr><td colspan="8">
           <div class="empty-state">
             ${icon('search', '', 20)}
             <b>没有匹配的会话</b>
             <p>当前有 ${d.rows.length} 个会话，但都被筛选条件排除了。
                ${state.hideEmpty ? '试试关闭「隐藏无 token 的会话」' : ''}${state.q ? '或清空搜索' : ''}。</p>
           </div>
         </td></tr>`

  $('#body').querySelectorAll('.row-pin').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePin(btn.dataset.pin)
      render()
    })
  })
  state.cursor = -1
  $('#body').querySelectorAll('tr[data-file]').forEach((tr) => {
    const file = tr.dataset.file
    if (state.compareMode) {
      tr.style.cursor = 'copy'
      if (state.compareA === file) {
        tr.style.background = 'rgba(56,189,248,.12)'
        tr.style.outline = '1px solid rgba(56,189,248,.35)'
      }
    }
    // 悬停预热：大会话首次解码要 1~2s，先把请求发出去，点进去就快
    let warmed = false
    tr.addEventListener('mouseenter', () => {
      if (warmed) return
      warmed = true
      fetch(`api/meta?file=${encodeURIComponent(file)}`).catch(() => {})
    })
    tr.addEventListener('click', (ev) => {
      if (ev.target.closest?.('.row-pin')) return
      if (!state.compareMode) {
        location.href = `./?file=${encodeURIComponent(file)}`
        return
      }
      if (state.compareA === null) {
        state.compareA = file
        renderCompareHint()
        render()
      } else if (state.compareA !== file) {
        location.href = `compare?left=${encodeURIComponent(state.compareA)}&right=${encodeURIComponent(file)}`
      }
    })
  })

  const warn = []
  if (d.unpricedModels?.length) {
    warn.push(
      `⚠ ${d.unpricedModels.length} 个模型没有价格，相关会话的成本不参与合计：${d.unpricedModels.slice(0, 8).map(esc).join('、')}${d.unpricedModels.length > 8 ? ' …' : ''}`,
    )
    warn.push(`在 <code>~/.dsh/blackbox/pricing.json</code> 里补充，例如：<code>{"models": {"${esc(d.unpricedModels[0])}": {"in": 2, "out": 10, "cached": 0.2}}}</code>`)
  }
  if (d.pricingNote) warn.push(`<code>${esc(d.pricingNote)}</code>`)
  $('#warn').hidden = warn.length === 0
  $('#warn').innerHTML = warn.join('<br>')
}

$('#q').addEventListener('input', (e) => {
  state.q = e.target.value
  render()
})
if (!state.hideEmpty) {
  const box = document.getElementById('hideEmpty')
  if (box) box.checked = false
}
$('#hideEmpty').addEventListener('change', (e) => {
  state.hideEmpty = e.target.checked
  render()
})
$('#compareMode').addEventListener('change', (e) => {
  state.compareMode = e.target.checked
  state.compareA = null
  renderCompareHint()
  render()
})
/** 首访提示：只在第一次打开总览页时出现 */
function initHintBar() {
  const bar = $('#hintBar')
  if (!bar) return
  try {
    if (localStorage.getItem('bb-overview-hint')) return
  } catch {
    /* ignore */
  }
  bar.hidden = false
  $('#hintClose')?.addEventListener('click', () => {
    bar.hidden = true
    try {
      localStorage.setItem('bb-overview-hint', '1')
    } catch {
      /* ignore */
    }
  })
}

function renderCompareHint() {
  const el = $('#compareHint')
  if (!state.compareMode) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.textContent = state.compareA
    ? '已选择第一个会话，再点一个即可对比'
    : '对比模式：点第一个会话作为左侧，再点第二个'
}
// 键盘：/ 聚焦搜索、↑↓ 移动、Enter 打开、Esc 清空
window.addEventListener('keydown', (e) => {
  const target = e.target
  if (target instanceof HTMLInputElement) {
    if (e.code === 'Escape') {
      target.value = ''
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.blur()
    }
    return
  }
  if (e.key === '/') {
    e.preventDefault()
    $('#q').focus()
    $('#q').select()
    return
  }
  const rows = [...document.querySelectorAll('#body tr[data-file]')]
  if (rows.length === 0) return
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
    e.preventDefault()
    state.cursor = (state.cursor + (e.code === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows.forEach((r, i) => r.classList.toggle('is-cursor', i === state.cursor))
    rows[state.cursor].scrollIntoView({ block: 'nearest' })
  } else if (e.code === 'Enter' && state.cursor >= 0) {
    e.preventDefault()
    location.href = `./?file=${encodeURIComponent(rows[state.cursor].dataset.file)}`
  }
})

$('#refresh').addEventListener('click', () => load(true))

initTheme()
initTooltips()
hydrateIcons()
renderCompareHint()
initHintBar()
onPinsChange(() => render())
load()
