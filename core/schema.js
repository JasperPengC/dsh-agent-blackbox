/**
 * agent-blackbox · event schema v1
 * =================================
 *
 * 一条事件就是"黑匣子"里的一帧。设计目标：
 *
 *  1. **可归约**：任何一个事件都必须能被一个纯函数 reducer 消化，不需要回问外部状态。
 *  2. **可序列化**：只用 JSON 基础类型，没有 Date / Map / Set / class 实例。
 *  3. **不丢信息**：适配器看不懂的行一律落成 `raw` 事件，宁可不懂也不能丢。
 *  4. **可演进**：`v` 字段 + 未知 `kind` 被容忍而不是被拒绝（前向兼容）。
 *
 * 兼容性原则：**consumer 容忍未知字段，producer 只写已知字段**。
 */
export const SCHEMA_VERSION = 1;
/** 事件类型。加新类型是 minor 变更；删/改语义是 major 变更。 */
export const KINDS = [
    'run.start',
    'run.end',
    'session.start',
    'session.end',
    'edge',
    'status',
    'message.user',
    'message.agent',
    'think',
    'tool.call',
    'tool.result',
    'file.edit',
    'usage',
    'error',
    'checkpoint',
    'subagent',
    'raw',
];
const KIND_SET = new Set(KINDS);
/** agent 在某一时刻的状态。`waiting` 是"等外部事件"，`blocked` 是"被人挡住"。 */
export const SESSION_STATES = [
    'idle',
    'thinking',
    'tool',
    'waiting',
    'blocked',
    'done',
    'failed',
];
/** kind → 展示元数据。UI 与终端共用，避免两处颜色不一致。 */
export const KIND_META = {
    'run.start': { label: '任务开始', color: '#6ee7b7', glyph: '▶' },
    'run.end': { label: '任务结束', color: '#34d399', glyph: '■' },
    'session.start': { label: '会话启动', color: '#60a5fa', glyph: '◉' },
    'session.end': { label: '会话结束', color: '#93c5fd', glyph: '◎' },
    edge: { label: '委派/交接', color: '#f472b6', glyph: '⤳' },
    status: { label: '状态', color: '#fbbf24', glyph: '◆' },
    'message.user': { label: '用户消息', color: '#a78bfa', glyph: '👤' },
    'message.agent': { label: 'Agent 发言', color: '#c4b5fd', glyph: '🤖' },
    think: { label: '思考', color: '#94a3b8', glyph: '💭' },
    'tool.call': { label: '工具调用', color: '#38bdf8', glyph: '🔧' },
    'tool.result': { label: '工具返回', color: '#0ea5e9', glyph: '↩' },
    'file.edit': { label: '改文件', color: '#fb923c', glyph: '✎' },
    usage: { label: '用量', color: '#4ade80', glyph: '⛽' },
    error: { label: '错误', color: '#f87171', glyph: '✖' },
    checkpoint: { label: '检查点', color: '#e879f9', glyph: '⚑' },
    subagent: { label: '子 agent', color: '#a78bfa', glyph: '⧉' },
    raw: { label: '原始行', color: '#64748b', glyph: '·' },
};
/** agent 节点配色，按出现顺序取。 */
export const AGENT_PALETTE = [
    '#60a5fa',
    '#f472b6',
    '#34d399',
    '#fbbf24',
    '#a78bfa',
    '#fb923c',
    '#22d3ee',
    '#e879f9',
];
export function isKind(x) {
    return typeof x === 'string' && KIND_SET.has(x);
}
/**
 * 校验一条**已归一化**的事件。这里刻意只做 envelope 校验：
 * `data` 的形状由各 kind 的语义决定，reducer 对缺失字段是容错的，
 * 因此把 data 校验得更严只会让工具因为上游加字段而变脆。
 */
export function validateEvent(x) {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) {
        return { ok: false, error: 'not an object' };
    }
    const o = x;
    if (typeof o.v !== 'number' || !Number.isFinite(o.v)) {
        return { ok: false, error: 'v must be a number' };
    }
    if (o.v > SCHEMA_VERSION) {
        return { ok: false, error: `unsupported schema version v=${o.v} (max ${SCHEMA_VERSION})` };
    }
    if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 0) {
        return { ok: false, error: 'seq must be a non-negative integer' };
    }
    if (typeof o.t !== 'number' || !Number.isFinite(o.t) || o.t < 0) {
        return { ok: false, error: 't must be a non-negative finite number' };
    }
    if (typeof o.run !== 'string' || o.run.length === 0) {
        return { ok: false, error: 'run must be a non-empty string' };
    }
    if (typeof o.session !== 'string')
        return { ok: false, error: 'session must be a string' };
    if (typeof o.agent !== 'string')
        return { ok: false, error: 'agent must be a string' };
    if (!isKind(o.kind)) {
        // 未知 kind 不算坏数据：报错由调用方决定是否容忍（见 parseNdjson 的 lenient）
        return { ok: false, error: `unknown kind: ${String(o.kind)}` };
    }
    if (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data)) {
        return { ok: false, error: 'data must be an object' };
    }
    const event = {
        v: o.v,
        seq: o.seq,
        t: o.t,
        run: o.run,
        session: o.session,
        agent: o.agent,
        kind: o.kind,
        data: o.data,
    };
    if (typeof o.call === 'string' && o.call.length > 0)
        event.call = o.call;
    return { ok: true, event };
}
// ────────────────────────────────────────────────────────────────────────────
// 容错取值：上游数据不可信，所有 reducer 都走这几个函数
// ────────────────────────────────────────────────────────────────────────────
export function asStr(v, fallback = '') {
    return typeof v === 'string' ? v : v == null ? fallback : String(v);
}
export function asNum(v, fallback = 0) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
export function asBool(v, fallback = false) {
    return typeof v === 'boolean' ? v : fallback;
}
/** 截断长文本，避免一条工具输出把内存和 UI 撑爆。 */
export function clip(text, max = 280) {
    if (text.length <= max)
        return text;
    return `${text.slice(0, max)}… (+${text.length - max})`;
}
