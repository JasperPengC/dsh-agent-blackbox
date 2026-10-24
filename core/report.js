/**
 * 终端渲染层
 * ==========
 *
 * 三种输出，全部是纯函数（输入 Index/RunState，输出字符串）：
 *   · `renderStats`  统计报告（给人看 / `--json` 给机器看）
 *   · `renderBoard`  回放时的实时看板
 *   · `renderEvent`  单条事件的一行摘要
 *
 * 刻意不带颜色逻辑进 projector：渲染是表现层，内核不该知道终端的存在。
 */
import { KIND_META } from "./schema.js";
import { attribution, blockedMsAt, isBlockedState, timeSeek, } from "./projector.js";
export function makePaint(on) {
    const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
    return {
        on,
        bold: wrap('1'),
        dim: wrap('2'),
        red: wrap('31'),
        green: wrap('32'),
        yellow: wrap('33'),
        blue: wrap('34'),
        magenta: wrap('35'),
        cyan: wrap('36'),
        gray: wrap('90'),
        hex: (s, color) => {
            if (!on)
                return s;
            const m = /^#([0-9a-f]{6})$/i.exec(color);
            if (!m)
                return s;
            const n = Number.parseInt(m[1], 16);
            return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m`;
        },
    };
}
// ── 格式化 ──────────────────────────────────────────────────────────────────
export function fmtT(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
export function fmtDur(ms) {
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(1)}s`;
    return fmtT(ms);
}
export function fmtTokens(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
export function fmtUsd(n) {
    if (n === 0)
        return '$0';
    if (n < 0.01)
        return `$${n.toFixed(4)}`;
    return `$${n.toFixed(3)}`;
}
export function pad(s, width) {
    // 中文按 2 列宽估算，够用就行（不做完整 EastAsianWidth）
    let w = 0;
    for (const ch of s)
        w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
    if (w >= width)
        return s;
    return s + ' '.repeat(width - w);
}
export function clipTo(s, width) {
    if (s.length <= width)
        return s;
    return `${s.slice(0, Math.max(0, width - 1))}…`;
}
const STATE_LABEL = {
    idle: '待命',
    thinking: '思考中',
    tool: '执行工具',
    waiting: '等待中',
    blocked: '被阻塞',
    done: '完成',
    failed: '失败',
};
export function stateTag(p, state) {
    switch (state) {
        case 'blocked':
            return p.red('⏸ BLOCKED');
        case 'waiting':
            return p.yellow('… WAITING');
        case 'tool':
            return p.cyan('⚙ TOOL');
        case 'thinking':
            return p.blue('● THINK');
        case 'done':
            return p.green('✓ DONE');
        case 'failed':
            return p.red('✖ FAIL');
        default:
            return p.gray('· IDLE');
    }
}
// ── 事件一行摘要 ────────────────────────────────────────────────────────────
export function renderEvent(e, p, t0 = 0) {
    const meta = KIND_META[e.kind];
    const stamp = p.gray(fmtT(e.t - t0).padStart(6));
    const who = pad(e.agent || '—', 10);
    const d = e.data;
    const str = (k) => {
        const v = d[k];
        return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
    };
    let detail = '';
    switch (e.kind) {
        case 'tool.call':
            detail = `${str('tool')} · ${str('summary')}`;
            break;
        case 'tool.result':
            detail = `${d['ok'] === false ? '失败' : '成功'} · ${clipTo(str('output'), 70)}`;
            break;
        case 'message.agent':
        case 'message.user':
        case 'think':
            detail = clipTo(str('text'), 78);
            break;
        case 'status':
            detail = `${str('state')}${str('waitingFor') ? ` ← 等待 ${str('waitingFor')}` : ''}${str('reason') ? ` · ${str('reason')}` : ''}`;
            break;
        case 'edge':
            detail = `${str('from')} → ${str('to')}${str('label') ? ` · ${str('label')}` : ''}`;
            break;
        case 'file.edit':
            detail = `${str('path')} +${d['added'] ?? 0} -${d['removed'] ?? 0}`;
            break;
        case 'usage':
            detail = `${fmtTokens(Number(d['in'] ?? 0))}↑ ${fmtTokens(Number(d['out'] ?? 0))}↓ ${fmtUsd(Number(d['costUsd'] ?? 0))}`;
            break;
        case 'error':
            detail = str('message');
            break;
        case 'session.start':
            detail = `${str('runtime')} ${str('model')}`;
            break;
        case 'session.end':
            detail = `status ${str('status')}`;
            break;
        case 'run.start':
            detail = clipTo(str('goal'), 78);
            break;
        case 'run.end':
            detail = `status ${str('status')}`;
            break;
        default:
            detail = clipTo(Object.keys(d).length > 0 ? JSON.stringify(d) : '', 78);
    }
    return `${stamp} ${p.hex(meta.glyph, meta.color)} ${who} ${p.hex(meta.label.padEnd(6), meta.color)} ${detail}`;
}
// ── 回放看板 ────────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CJK_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
function charWidth(ch) {
    return CJK_RE.test(ch) ? 2 : 1;
}
/** 终端里 ANSI 控制序列不占列，所以裁剪必须"看得见才计数"。 */
export function visibleWidth(s) {
    let w = 0;
    for (const ch of s.replace(ANSI_RE, ''))
        w += charWidth(ch);
    return w;
}
export function clipAnsi(s, max) {
    let out = '';
    let w = 0;
    let i = 0;
    while (i < s.length) {
        if (s[i] === '\x1b') {
            const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
            if (m) {
                out += m[0];
                i += m[0].length;
                continue;
            }
        }
        const ch = s[i];
        const cw = charWidth(ch);
        if (w + cw > max)
            break;
        out += ch;
        w += cw;
        i++;
    }
    return out;
}
/** 裁剪 + 补空格到恰好 width 列（ANSI 安全）。 */
export function fitAnsi(s, width) {
    const clipped = clipAnsi(s, width);
    const gap = width - visibleWidth(clipped);
    return gap > 0 ? clipped + ' '.repeat(gap) : clipped;
}
export function padAnsi(s, width) {
    const gap = width - visibleWidth(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
}
export function renderBoard(ix, s, p, width = 0) {
    const w = width > 0 ? width : Math.min(process.stdout.columns ?? 96, 100);
    const inner = Math.max(40, w - 1);
    const lines = [];
    const hr = '─'.repeat(inner);
    const row = (content) => {
        lines.push(p.gray('│') + fitAnsi(content, inner));
    };
    const left = `${p.bold(' agent-blackbox')} ${p.gray('·')} ${p.cyan(ix.run)}`;
    const right = `${p.bold(fmtT(s.t))} ${p.gray('/')} ${p.gray(fmtT(ix.duration))} ${p.gray('·')} ` +
        `${p.gray(`${s.stats.events}/${ix.events.length} ev`)}`;
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
    lines.push(p.gray(`┌${hr}`));
    row(left + ' '.repeat(gap) + right);
    lines.push(p.gray(`├${hr}`));
    for (const key of s.order) {
        const a = s.agents[key];
        if (!a)
            continue;
        const dot = p.hex('●', a.color);
        const name = padAnsi(pad(clipTo(a.agent, 12), 13), 14);
        const model = padAnsi(clipTo(a.model || a.runtime || '—', 18), 19);
        const state = padAnsi(stateTag(p, a.state), 12);
        const tool = a.tool ? p.cyan(` ${clipTo(a.tool, 12)}`) : '';
        const tail = p.gray(`${fmtTokens(a.tokens.in)}↑ ${fmtTokens(a.tokens.out)}↓ ${fmtUsd(a.costUsd)}`);
        let line = `${dot} ${name}${model}${state}${tool}`;
        if (isBlockedState(a.state) && a.blockedBy !== undefined) {
            line +=
                p.red(`⏸ ${fmtDur(blockedMsAt(a, s.t))} `) +
                    p.gray(`等 ${s.agents[a.blockedBy]?.agent ?? a.blockedBy}`);
        }
        else {
            line += tail;
        }
        row(line);
    }
    const att = attribution(s);
    if (att.rows.some((r) => r.blockedMs > 0)) {
        lines.push(p.gray(`├${hr}`));
        for (const r of att.rows.slice(0, 3)) {
            if (r.blockedMs <= 0)
                continue;
            const pct = s.t > 0 ? ((r.blockedMs / s.t) * 100).toFixed(0) : '0';
            const line = `${p.yellow('⏱')} ${padAnsi(pad(r.agent, 12), 13)} 累计阻塞 ${p.bold(fmtDur(r.blockedMs))} (${pct}%)` +
                (r.blockedByName ? p.gray(` ← ${r.blockedByName}`) : '') +
                (r.reason ? p.gray(` · ${r.reason}`) : '');
            row(line);
        }
    }
    lines.push(p.gray(`└${hr}`));
    const recent = ix.events.filter((e) => e.t <= s.t).slice(-4);
    for (const e of recent)
        lines.push(clipAnsi(renderEvent(e, p), inner + 2));
    if (recent.length === 0)
        lines.push(p.gray('  （还没有事件）'));
    return lines.join('\n');
}
/** 沿时间轴均匀采样，量 seek 延迟 —— 这是"可拖动时间轴"的自证指标。 */
export function benchSeek(ix, samples = 120) {
    const n = Math.max(1, Math.min(samples, 400));
    const times = [];
    for (let i = 0; i < n; i++) {
        const t = Math.round((ix.duration * i) / Math.max(1, n - 1));
        times.push(timeSeek(ix, t).ms);
    }
    times.sort((a, b) => a - b);
    const at = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    return {
        samples: n,
        medianMs: at(0.5),
        p95Ms: at(0.95),
        maxMs: times[times.length - 1] ?? 0,
    };
}
export function buildStatsReport(ix, file) {
    const final = ix.events.length > 0 ? timeSeek(ix, ix.duration).state : undefined;
    const durationMs = ix.duration;
    const agents = (final?.order ?? []).map((key) => {
        const a = final.agents[key];
        const blocked = final ? blockedMsAt(a, durationMs) : 0;
        return {
            agent: a.agent,
            runtime: a.runtime,
            model: a.model,
            calls: a.calls,
            fails: a.fails,
            tokens: { ...a.tokens },
            costUsd: a.costUsd,
            blockedMs: blocked,
            blockedPct: durationMs > 0 ? (blocked / durationMs) * 100 : 0,
        };
    });
    const tools = Object.entries(ix.derived.tools)
        .map(([tool, agg]) => ({
        tool,
        calls: agg.calls,
        fails: agg.fails,
        totalMs: agg.ms,
        avgMs: agg.calls > 0 ? agg.ms / agg.calls : 0,
    }))
        .sort((a, b) => b.totalMs - a.totalMs);
    const att = final ? attribution(final, durationMs) : { rows: [], blocking: {}, totalBlockedMs: 0 };
    return {
        file,
        run: ix.run,
        events: ix.events.length,
        kinds: Object.keys(ix.derived.kinds).length,
        durationMs,
        wall: ix.wall,
        buildMs: ix.buildMs,
        seek: benchSeek(ix),
        agents,
        tools,
        attribution: att.rows
            .filter((r) => r.blockedMs > 0 || r.blockedBy !== undefined)
            .map((r) => ({
            agent: r.agent,
            blockedMs: r.blockedMs,
            pct: durationMs > 0 ? (r.blockedMs / durationMs) * 100 : 0,
            ...(r.blockedByName ? { blockedByName: r.blockedByName } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
        })),
        files: Object.entries(final?.files ?? {})
            .map(([path, rec]) => ({ path, ...rec }))
            .sort((a, b) => b.edits - a.edits),
        totals: {
            toolCalls: final?.stats.toolCalls ?? 0,
            toolFails: final?.stats.toolFails ?? 0,
            tokens: { ...(final?.stats.tokens ?? { in: 0, out: 0, cached: 0 }) },
            costUsd: final?.stats.costUsd ?? 0,
            blockedMs: att.totalBlockedMs,
        },
    };
}
export function renderStats(r, p, width = 0) {
    const w = Math.min(width > 0 ? width : (process.stdout.columns ?? 100), 110);
    const out = [];
    const rule = (label) => {
        out.push('');
        out.push(p.bold(p.cyan(`── ${label} `)) + p.gray('─'.repeat(Math.max(0, w - label.length - 5))));
    };
    const kv = (k, v) => {
        out.push(`  ${p.gray(pad(k, 12))} ${v}`);
    };
    out.push(p.bold('agent-blackbox') + p.gray(' · 统计报告'));
    rule('概览');
    if (r.file)
        kv('文件', r.file);
    kv('run', p.cyan(r.run));
    kv('事件', `${r.events} 条 · ${r.kinds} 类`);
    kv('逻辑时长', p.bold(fmtDur(r.durationMs)));
    if (r.wall.start)
        kv('墙钟', `${r.wall.start}${r.wall.end ? ` → ${r.wall.end}` : ''}`);
    kv('性能', `索引 ${r.buildMs.toFixed(1)}ms · seek 中位 ${r.seek.medianMs.toFixed(2)}ms / p95 ${r.seek.p95Ms.toFixed(2)}ms（${r.seek.samples} 采样）`);
    rule('Agent');
    if (r.agents.length === 0) {
        out.push(p.gray('  （没有 agent 事件）'));
    }
    else {
        out.push(`  ${p.gray(pad('agent', 14))}${p.gray(pad('runtime/model', 24))}${p.gray(pad('调用', 8))}${p.gray(pad('tokens', 18))}${p.gray(pad('成本', 9))}${p.gray('阻塞')}`);
        for (const a of r.agents) {
            const rm = clipTo(`${a.runtime || '—'}${a.model ? `/${a.model}` : ''}`, 23);
            const tok = `${fmtTokens(a.tokens.in)}↑ ${fmtTokens(a.tokens.out)}↓`;
            const blocked = a.blockedMs > 0 ? p.yellow(`${fmtDur(a.blockedMs)} (${a.blockedPct.toFixed(0)}%)`) : p.gray('—');
            out.push(`  ${pad(a.agent, 14)}${pad(rm, 24)}${pad(String(a.calls) + (a.fails > 0 ? p.red(` ✗${a.fails}`) : ''), 8)}${pad(tok, 18)}${pad(fmtUsd(a.costUsd), 9)}${blocked}`);
        }
    }
    if (r.tools.length > 0) {
        rule('工具耗时 Top');
        for (const t of r.tools.slice(0, 8)) {
            const fail = t.fails > 0 ? p.red(` ✗${t.fails}`) : '';
            out.push(`  ${pad(t.tool, 18)} ${p.bold(pad(String(t.calls) + ' 次', 8))}${fail.padEnd(8)} ${p.gray('合计')} ${pad(fmtDur(t.totalMs), 9)} ${p.gray('均值')} ${fmtDur(t.avgMs)}`);
        }
    }
    if (r.attribution.length > 0) {
        rule('归因：谁在等谁');
        for (const row of r.attribution) {
            const ratio = Math.min(1, row.pct / 100);
            const bar = p.yellow('█'.repeat(Math.max(0, Math.round(ratio * 20))));
            out.push(`  ${pad(row.agent, 14)} ${p.bold(pad(fmtDur(row.blockedMs), 9))} ${pad(`${row.pct.toFixed(0)}%`, 5)} ${bar}`);
            if (row.blockedByName || row.reason) {
                out.push(p.gray(`  ${' '.repeat(14)} ← ${row.blockedByName ?? '?'}${row.reason ? ` · ${row.reason}` : ''}`));
            }
        }
        const total = r.totals.blockedMs;
        if (r.durationMs > 0 && total > 0) {
            out.push(p.gray(`  合计阻塞 ${fmtDur(total)}，占墙钟 ${((total / r.durationMs) * 100).toFixed(0)}%（有并行，故可能 > 100%）`));
        }
    }
    if (r.files.length > 0) {
        rule('产出文件');
        for (const f of r.files.slice(0, 10)) {
            out.push(`  ${pad(clipTo(f.path, 46), 47)} ${p.gray(`${f.edits} 次`)} ${p.green(`+${f.added}`)} ${p.red(`-${f.removed}`)}`);
        }
    }
    rule('合计');
    out.push(`  工具 ${r.totals.toolCalls} 次（失败 ${r.totals.toolFails}） · ` +
        `token ${fmtTokens(r.totals.tokens.in)}↑ ${fmtTokens(r.totals.tokens.out)}↓ · ` +
        `成本 ${p.bold(fmtUsd(r.totals.costUsd))}`);
    out.push('');
    return out.join('\n');
}
