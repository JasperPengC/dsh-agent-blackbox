/**
 * 投影器（projector）—— 黑匣子的"回放内核"
 * ==========================================
 *
 * 设计只有一句话：**事件流是唯一真相，任何时刻的状态都是它的纯函数投影。**
 *
 *      状态(t) = fold(reduce, initialState, events[0..t])
 *
 * 这带来三个性质：
 *   · **可倒带**：拖动时间轴 = 换一个 t 重新 fold，不需要"撤销"逻辑；
 *   · **可复现**：同一份文件永远投影出同一个状态，没有隐式状态；
 *   · **可测试**：reducer 是纯函数，可以逐事件断言。
 *
 * 性能：从头 fold 每次 seek 是 O(n)。所以索引阶段每 `CHECKPOINT_EVERY` 条事件
 * 存一份状态快照，seek 变成 O(CHECKPOINT_EVERY)——**与事件总数无关**，
 * 10 万事件拖动时间轴仍是亚毫秒级（实测见 README）。
 */
import { AGENT_PALETTE, asBool, asNum, asStr, clip, } from "./schema.js";
import { cleanUserText } from "./text.js";
const RECENT_CAP = 120;
export function initialState(runId = 'run') {
    return {
        seq: -1,
        t: 0,
        run: { id: runId, goal: '', status: 'running', startedAt: 0 },
        agents: {},
        order: [],
        edges: [],
        stats: {
            events: 0,
            sessions: 0,
            toolCalls: 0,
            toolFails: 0,
            edges: 0,
            errors: 0,
            files: 0,
            tokens: { in: 0, out: 0, cached: 0 },
            costUsd: 0,
            blockedMs: 0,
        },
        files: {},
        recent: [],
    };
}
export function isBlockedState(s) {
    return s === 'blocked' || s === 'waiting';
}
/** 包含"仍在进行中的这一段"的累计阻塞时长。 */
export function blockedMsAt(a, now) {
    const live = a.blockedSince === undefined ? 0 : Math.max(0, now - a.blockedSince);
    return a.blockedMs + live;
}
export function cloneState(s) {
    return structuredClone(s);
}
// ────────────────────────────────────────────────────────────────────────────
// reducer
// ────────────────────────────────────────────────────────────────────────────
function ensureAgent(s, e) {
    const key = e.session || `—${e.agent || 'run'}`;
    const existing = s.agents[key];
    if (existing) {
        existing.last = Math.max(existing.last, e.t);
        return existing;
    }
    const idx = s.order.length;
    const agent = {
        id: key,
        agent: e.agent || key,
        role: e.agent || key,
        runtime: '',
        model: '',
        color: AGENT_PALETTE[idx % AGENT_PALETTE.length] ?? '#94a3b8',
        state: 'idle',
        since: e.t,
        first: e.t,
        last: e.t,
        tokens: { in: 0, out: 0, cached: 0 },
        costUsd: 0,
        calls: 0,
        fails: 0,
        files: 0,
        blockedMs: 0,
        done: false,
    };
    s.agents[key] = agent;
    s.order.push(key);
    s.stats.sessions++;
    return agent;
}
/**
 * 状态迁移。阻塞时长的结算只发生在这里 ——
 * 离开 blocked/waiting 时把这一段累加进 blockedMs，保证"谁浪费了最多时间"可算。
 */
function transition(a, next, t) {
    if (a.state === next) {
        a.since = a.since; // 保持第一次进入的时间，不抖动
        return;
    }
    if (a.blockedSince !== undefined) {
        a.blockedMs += Math.max(0, t - a.blockedSince);
        a.blockedSince = undefined;
    }
    a.state = next;
    a.since = t;
    if (isBlockedState(next))
        a.blockedSince = t;
    if (next === 'done' || next === 'failed')
        a.done = true;
}
function addEdge(s, e) {
    const d = e.data;
    const from = asStr(d['from'], e.session);
    const to = asStr(d['to']);
    if (!from || !to)
        return;
    const kind = asStr(d['kind'], 'delegate');
    const id = `${from}->${to}:${kind}`;
    const existing = s.edges.find((x) => x.id === id);
    if (existing) {
        existing.count++;
        return;
    }
    s.edges.push({
        id,
        from,
        to,
        kind,
        label: asStr(d['label']),
        at: e.t,
        count: 1,
    });
    s.stats.edges++;
}
/**
 * 纯 reducer：消费一条事件，原地更新状态。
 *
 * 刻意用"原地更新"而不是不可变对象：10 万事件要做 10 万次对象分配，GC 会把
 * seek 延迟顶到几十毫秒。快照的隔离由 checkpoint 的 structuredClone 负责。
 */
export function reduce(s, e) {
    s.seq = e.seq;
    s.t = e.t;
    s.stats.events++;
    s.last = e;
    s.recent.push(e);
    if (s.recent.length > RECENT_CAP)
        s.recent.splice(0, s.recent.length - RECENT_CAP);
    const d = e.data;
    const agent = e.session ? ensureAgent(s, e) : undefined;
    switch (e.kind) {
        case 'run.start': {
            s.run.id = e.run;
            s.run.goal = asStr(d['goal'], s.run.goal);
            s.run.startedAt = e.t;
            s.run.wall = asStr(d['wall'], s.run.wall ?? '');
            break;
        }
        case 'checkpoint': {
            // "标题"检查点承载会话标题（DSH 的 session/title、Claude Code 的 summary）
            if (asStr(d['name']) === '标题') {
                const note = asStr(d['note']);
                if (note !== '')
                    s.run.title = note;
            }
            break;
        }
        case 'run.end': {
            const status = asStr(d['status'], 'done');
            s.run.status = status === 'failed' ? 'failed' : 'done';
            s.run.endedAt = e.t;
            break;
        }
        case 'session.start': {
            if (!agent)
                break;
            agent.runtime = asStr(d['runtime'], agent.runtime);
            agent.model = asStr(d['model'], agent.model);
            agent.role = asStr(d['role'], agent.role);
            const color = asStr(d['color']);
            if (color)
                agent.color = color;
            // 刻意不在这里做状态迁移：session.start 也用于"补发元数据"（比如稍后才知道 model），
            // 再打回 idle 会把正在执行的状态抹掉
            break;
        }
        case 'session.end': {
            if (!agent)
                break;
            const status = asStr(d['status'], 'done');
            transition(agent, status === 'failed' ? 'failed' : 'done', e.t);
            break;
        }
        case 'status': {
            if (!agent)
                break;
            const next = asStr(d['state'], agent.state);
            transition(agent, next, e.t);
            const waitingFor = asStr(d['waitingFor']);
            if (waitingFor) {
                agent.blockedBy = waitingFor;
                agent.blockReason = asStr(d['reason']);
            }
            else if (isBlockedState(next)) {
                // 阻塞中但没给 waitingFor：保留上一次的归因，总比空着强
                if (!agent.blockReason)
                    agent.blockReason = asStr(d['reason']);
            }
            // 注意：**解除阻塞时不清 blockedBy** —— 它是"历史归因"，
            // 排障时最想知道的是"它刚才在等谁"，而不是"它现在没在等"。
            break;
        }
        case 'message.user': {
            {
                const text = cleanUserText(asStr(d['text']));
                s.run.goal = s.run.goal || clip(text, 200);
            }
            break;
        }
        case 'message.agent': {
            if (!agent)
                break;
            agent.text = clip(asStr(d['text']));
            if (!isBlockedState(agent.state))
                transition(agent, 'thinking', e.t);
            break;
        }
        case 'think': {
            if (!agent)
                break;
            if (agent.state === 'idle')
                transition(agent, 'thinking', e.t);
            break;
        }
        case 'tool.call': {
            if (!agent)
                break;
            agent.calls++;
            s.stats.toolCalls++;
            agent.tool = asStr(d['tool'], 'tool');
            agent.call = e.call ?? asStr(d['call']);
            transition(agent, 'tool', e.t);
            break;
        }
        case 'tool.result': {
            if (!agent)
                break;
            const ok = asBool(d['ok'], true);
            if (!ok) {
                agent.fails++;
                s.stats.toolFails++;
            }
            agent.tool = undefined;
            agent.call = undefined;
            if (!isBlockedState(agent.state))
                transition(agent, 'thinking', e.t);
            break;
        }
        case 'file.edit': {
            const path = asStr(d['path']);
            if (!path)
                break;
            const added = asNum(d['added']);
            const removed = asNum(d['removed']);
            const rec = s.files[path] ?? { edits: 0, added: 0, removed: 0 };
            rec.edits++;
            rec.added += added;
            rec.removed += removed;
            s.files[path] = rec;
            s.stats.files = Object.keys(s.files).length;
            if (agent) {
                agent.files++;
                if (!isBlockedState(agent.state))
                    transition(agent, 'thinking', e.t);
            }
            break;
        }
        case 'usage': {
            const input = asNum(d['in']);
            const output = asNum(d['out']);
            const cached = asNum(d['cached']);
            const cost = asNum(d['costUsd']);
            s.stats.tokens.in += input;
            s.stats.tokens.out += output;
            s.stats.tokens.cached += cached;
            s.stats.costUsd += cost;
            if (agent) {
                agent.tokens.in += input;
                agent.tokens.out += output;
                agent.tokens.cached += cached;
                agent.costUsd += cost;
            }
            break;
        }
        case 'error': {
            s.stats.errors++;
            if (agent && asBool(d['fatal'])) {
                transition(agent, 'failed', e.t);
            }
            break;
        }
        case 'edge': {
            addEdge(s, e);
            break;
        }
        case 'checkpoint':
        case 'raw':
        default: {
            break;
        }
    }
}
/**
 * 重新计算全局阻塞时长。
 *
 * 为什么不放在 reducer 里逐事件累加：那是 O(agents) 每事件，
 * 100k 事件 × 750 agent 直接把 buildIndex 干到 17 秒。
 * 阻塞时长只跟"当前这一刻"有关，**在投影结束时算一次**就够了。
 */
export function refreshBlocked(s) {
    let total = 0;
    for (const key of s.order) {
        const a = s.agents[key];
        if (a)
            total += blockedMsAt(a, s.t);
    }
    s.stats.blockedMs = total;
}
/** 从事件流投影出最终状态。 */
export function fold(events, runId) {
    const s = initialState(runId ?? events[0]?.run ?? 'run');
    for (const e of events)
        reduce(s, e);
    refreshBlocked(s);
    return s;
}
export function createAgg() {
    return {
        tools: {},
        kinds: {},
        open: new Map(),
        spans: [],
        spanIndex: new Map(),
        usage: [],
        blocked: [],
        blockedOpen: new Map(),
    };
}
export function feedAgg(agg, e) {
    agg.kinds[e.kind] = (agg.kinds[e.kind] ?? 0) + 1;
    if (e.kind === 'tool.call') {
        const tool = asStr(e.data['tool'], 'tool');
        const rec = agg.tools[tool] ?? { calls: 0, fails: 0, ms: 0 };
        rec.calls++;
        agg.tools[tool] = rec;
        if (e.call) {
            agg.open.set(e.call, { tool, at: e.t });
            agg.spanIndex.set(e.call, agg.spans.length);
            agg.spans.push({
                call: e.call,
                tool,
                agent: e.agent,
                summary: asStr(e.data['summary'], tool),
                start: e.t,
                end: null,
                ok: true,
            });
        }
        return;
    }
    if (e.kind === 'tool.result') {
        const callId = e.call;
        const open = callId ? agg.open.get(callId) : undefined;
        const failed = !asBool(e.data['ok'], true);
        if (open) {
            const rec = agg.tools[open.tool] ?? { calls: 0, fails: 0, ms: 0 };
            if (failed)
                rec.fails++;
            rec.ms += Math.max(0, asNum(e.data['ms'], e.t - open.at));
            agg.tools[open.tool] = rec;
            agg.open.delete(callId);
        }
        else {
            const tool = asStr(e.data['tool'], 'unknown');
            const rec = agg.tools[tool] ?? { calls: 0, fails: 0, ms: 0 };
            if (failed)
                rec.fails++;
            agg.tools[tool] = rec;
        }
        if (callId) {
            const idx = agg.spanIndex.get(callId);
            if (idx !== undefined) {
                const span = agg.spans[idx];
                if (span) {
                    span.end = e.t;
                    span.ok = !failed;
                }
            }
        }
        return;
    }
    if (e.kind === 'status') {
        const state = asStr(e.data['state']);
        const openIdx = agg.blockedOpen.get(e.agent);
        if (isBlockedState(state)) {
            if (openIdx === undefined) {
                agg.blocked.push({
                    agent: e.agent,
                    from: e.t,
                    to: null,
                    ...(asStr(e.data['reason']) ? { reason: asStr(e.data['reason']) } : {}),
                });
                agg.blockedOpen.set(e.agent, agg.blocked.length - 1);
            }
        }
        else if (openIdx !== undefined) {
            const span = agg.blocked[openIdx];
            if (span)
                span.to = e.t;
            agg.blockedOpen.delete(e.agent);
        }
        return;
    }
    if (e.kind === 'usage') {
        agg.usage.push({
            t: e.t,
            in: asNum(e.data['in']),
            out: asNum(e.data['out']),
            cached: asNum(e.data['cached']),
        });
    }
}
export const CHECKPOINT_EVERY = 400;
/**
 * 构建内存索引：
 *   1. 把 `t` 规整成单调不减（外部日志可能乱序）；
 *   2. 一遍 fold，每 N 条打一个状态快照；
 *   3. 顺手做全局聚合（工具耗时、kind 分布、span、token 曲线）。
 */
export function buildIndex(events, opts = {}) {
    const started = performance.now();
    // 自适应间隔：小文件也能有检查点（否则 demo 里"检查点 0 个"很难看），
    // 大文件则封顶在 CHECKPOINT_EVERY，保证快照内存 O(n/every) 不失控。
    const auto = Math.min(CHECKPOINT_EVERY, Math.max(25, Math.floor(events.length / 20)));
    const every = opts.every ?? auto;
    // 1. t 单调化（seq 已排序）
    let prevT = 0;
    const normalized = new Array(events.length);
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const t = Math.max(prevT, e.t);
        prevT = t;
        normalized[i] = e.t === t ? e : { ...e, t };
    }
    const run = opts.run ?? normalized[0]?.run ?? 'run';
    const state = initialState(run);
    const checkpoints = [];
    const agg = createAgg();
    const wall = {};
    let n = 0;
    for (const e of normalized) {
        reduce(state, e);
        feedAgg(agg, e);
        n++;
        if (e.kind === 'run.start') {
            const w = asStr(e.data['wall']);
            if (w)
                wall.start = w;
        }
        if (e.kind === 'run.end') {
            const w = asStr(e.data['wall']);
            if (w)
                wall.end = w;
        }
        if (n % every === 0) {
            // 快照不带 recent：它会在 seek 时由后续事件重建，没必要为它付克隆成本
            const snap = cloneState(state);
            snap.recent = [];
            checkpoints.push({ t: e.t, seq: e.seq, state: snap });
        }
    }
    const duration = normalized.length > 0 ? normalized[normalized.length - 1].t : 0;
    return {
        file: opts.file,
        run,
        events: normalized,
        every,
        checkpoints,
        duration,
        derived: { tools: agg.tools, kinds: agg.kinds, duration },
        wall,
        buildMs: performance.now() - started,
        tailState: cloneState(state),
        agg,
        spans: agg.spans,
        usagePoints: agg.usage,
        blockedSpans: agg.blocked,
        extended: false,
    };
}
/**
 * 增量扩展：把追加进来的事件接到已有索引上，**不重放历史**。
 *
 * live 模式每次轮询都可能只多 3~5 条事件；如果每次重建索引，
 * 100 万事件的会话会被 O(n) 重算拖死。这里只做：
 * clone(尾状态) → fold 新事件 → 追加 span/usage → 可能补检查点。
 */
export function extendIndex(ix, incoming) {
    if (incoming.length === 0)
        return ix;
    const lastSeq = ix.events.length > 0 ? ix.events[ix.events.length - 1].seq : -1;
    const fresh = incoming.filter((e) => e.seq > lastSeq);
    if (fresh.length === 0)
        return ix;
    const state = cloneState(ix.tailState);
    let prevT = ix.duration;
    for (const raw of fresh) {
        const t = Math.max(prevT, raw.t);
        prevT = t;
        const e = raw.t === t ? raw : { ...raw, t };
        reduce(state, e);
        feedAgg(ix.agg, e);
        ix.events.push(e);
        if (e.kind === 'run.start') {
            const w = asStr(e.data['wall']);
            if (w)
                ix.wall.start = w;
        }
        if (e.kind === 'run.end') {
            const w = asStr(e.data['wall']);
            if (w)
                ix.wall.end = w;
        }
        if (ix.events.length % ix.every === 0) {
            const snap = cloneState(state);
            snap.recent = [];
            ix.checkpoints.push({ t: e.t, seq: e.seq, state: snap });
        }
    }
    ix.duration = prevT;
    ix.derived = { tools: ix.agg.tools, kinds: ix.agg.kinds, duration: prevT };
    ix.spans = ix.agg.spans;
    ix.usagePoints = ix.agg.usage;
    ix.blockedSpans = ix.agg.blocked;
    ix.tailState = cloneState(state);
    ix.extended = true;
    return ix;
}
/** 二分：第一个满足 pred 的下标（pred 单调递增）。 */
function lowerBound(n, pred) {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (pred(mid))
            hi = mid;
        else
            lo = mid + 1;
    }
    return lo;
}
function firstEventAfterSeq(ix, seq) {
    const ev = ix.events;
    return lowerBound(ev.length, (i) => ev[i].seq > seq);
}
function firstEventAfterT(ix, t) {
    const ev = ix.events;
    return lowerBound(ev.length, (i) => ev[i].t > t);
}
/**
 * 投影到逻辑时刻 `t`。
 *
 * 复杂度：O(CHECKPOINT_EVERY + log n)，与总事件数无关。
 * 这是本项目最重要的性能承诺 —— 也是"10 万事件仍可拖动时间轴"的根据。
 */
export function seek(ix, t) {
    const target = Math.max(0, Math.min(t, ix.duration));
    const cps = ix.checkpoints;
    // 最后一个 cp.t <= target
    let loCp = lowerBound(cps.length, (i) => cps[i].t > target) - 1;
    const cp = loCp >= 0 ? cps[loCp] : undefined;
    const state = cp ? cloneState(cp.state) : initialState(ix.run);
    let i = cp ? firstEventAfterSeq(ix, cp.seq) : 0;
    const ev = ix.events;
    for (; i < ev.length; i++) {
        const e = ev[i];
        if (e.t > target)
            break;
        reduce(state, e);
    }
    state.t = target;
    refreshBlocked(state);
    // 检查点快照刻意不带 recent（省克隆成本），所以这里用二分回填最后一段 —
    // 否则从检查点起跳的视图右栏会"只剩十几条事件"。
    const upto = firstEventAfterT(ix, target);
    const from = Math.max(0, upto - RECENT_CAP);
    state.recent = ix.events.slice(from, upto);
    return state;
}
/** 取时间窗口内的事件（UI 事件列表用）。 */
export function slice(ix, fromT, toT) {
    const ev = ix.events;
    const start = lowerBound(ev.length, (i) => ev[i].t >= fromT);
    const end = firstEventAfterT(ix, toT);
    return ev.slice(start, end);
}
export function finalState(ix) {
    return seek(ix, ix.duration);
}
/** 单次查询的投影耗时（ms），CLI 用来打印自证指标。 */
export function timeSeek(ix, t) {
    const t0 = performance.now();
    const state = seek(ix, t);
    return { state, ms: performance.now() - t0 };
}
/**
 * 归因面板的数据源。
 *
 * 这是整个项目想回答的核心问题：**"任务为什么慢了？"**
 * 答案不是"模型慢"，而是"reviewer 在 coder 身上等了 96 秒，占墙钟 31%"。
 */
export function attribution(state, now = state.t) {
    const rows = [];
    const blocking = {};
    let total = 0;
    for (const key of state.order) {
        const a = state.agents[key];
        if (!a)
            continue;
        const ms = blockedMsAt(a, now);
        total += ms;
        const row = {
            session: a.id,
            agent: a.agent,
            state: a.state,
            blockedMs: ms,
        };
        if (a.blockedBy) {
            row.blockedBy = a.blockedBy;
            const target = state.agents[a.blockedBy];
            row.blockedByName = target ? target.agent : a.blockedBy;
            // "谁堵住了谁"只统计**当前**仍在等的，历史归因看 rows
            if (isBlockedState(a.state))
                (blocking[a.blockedBy] ??= []).push(a.agent);
        }
        if (a.blockReason)
            row.reason = a.blockReason;
        if (a.blockedSince !== undefined)
            row.since = a.blockedSince;
        rows.push(row);
    }
    rows.sort((x, y) => y.blockedMs - x.blockedMs);
    return { rows, blocking, totalBlockedMs: total };
}
