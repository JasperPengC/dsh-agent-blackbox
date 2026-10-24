/**
 * DeepSeek Harness（DSH）会话适配器 —— `session.v4.jsonl.zstd`
 *
 * 这是本项目的第一个 **真实生产日志** 适配器：不是按文档猜的格式，
 * 而是对着 `~/.dsh/sessions/<project>/session-<uuid>/session.v4.jsonl.zstd`
 * 解出来的多帧 zstd NDJSON。
 *
 * 一条 DSH 事件长这样：
 *   {"type":"tool/call","seq":26,"time":1792681840587,
 *    "data":{"turn":1,"step":1,"callId":"call_00_…","name":"bash","arguments":"{\"command\":\"ls\"}"}}
 *
 * 关键点：
 *   · `seq` 已单调 → 直接可作为因果顺序
 *   · `time` 是绝对毫秒 → 减去会话 createdAt 得到相对时间轴
 *   · `assistant/message` 里同时有 reasoning / text / tool-call 块，
 *     但 tool-call 另有一条 `tool/call` 事件 → **这里只取 reasoning 和 text，避免重复**
 *   · 内部遥测（request/header、web-search-llm-request 等）体积大且无排障价值，
 *     只保留"它发生过"的类型名，不保留载荷 → 既不失证也不淹没有效信息
 */
import { asNum, asStr } from "../schema.js";
import { emitRaw, parseJsonLine, } from "./types.js";
const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
/** 只记类型名、不记载荷的内部遥测事件 */
const INTERNAL = new Set([
    'request/context',
    'web/deepseek-search-llm-request',
    'session/title-llm-request',
    'approval/policy',
    'permission/preset',
    'sandbox/mode',
    'agent/inbox/spliced',
]);
/**
 * 与 tool/call ⇄ tool/result 生命周期重复的事件。
 * 显式跳过而不是落成 raw —— 否则 61 个后台任务会产生 122 条噪声，
 * 把真正要看的信息淹掉（"不丢证据"不等于"全都要留在主时间轴上"）。
 */
const LIFECYCLE = new Set([
    'job/registered',
    'job/settled',
    'command/done',
    'step/start',
    'step/end',
    'workspace/changes',
]);
function textOf(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map((c) => {
        const o = obj(c);
        return asStr(o['text'] ?? o['content']);
    })
        .filter((s) => s !== '')
        .join('\n');
}
/** 从工具参数里挑一个能一眼看懂的一行摘要 */
function summarize(name, args) {
    const pick = (...keys) => {
        for (const k of keys) {
            const v = args[k];
            if (typeof v === 'string' && v.trim() !== '')
                return v;
            if (Array.isArray(v))
                return v.map((x) => String(x)).join(' ');
        }
        return '';
    };
    const s = pick('command', 'cmd') ||
        pick('path', 'file_path', 'filePath') ||
        pick('query', 'q', 'url') ||
        pick('description', 'label', 'prompt');
    if (s === '')
        return name;
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
function parseArgs(raw) {
    if (typeof raw !== 'string')
        return raw;
    const t = raw.trim();
    if (t === '' || (t[0] !== '{' && t[0] !== '['))
        return raw;
    try {
        return JSON.parse(t);
    }
    catch {
        return raw;
    }
}
export const dshAdapter = {
    id: 'dsh',
    label: 'DeepSeek Harness (session.v4.jsonl)',
    status: 'verified',
    note: '解自真实 DSH 会话日志（多帧 zstd NDJSON）；配合 `blackbox live` 可实时监视正在跑的会话',
    detect(line) {
        const o = parseJsonLine(line);
        if (!o)
            return 0;
        const type = asStr(o['type']);
        if (type === 'session' && asNum(o['version']) === 4)
            return 0.99;
        if (type === 'turn/start' || type === 'turn/end')
            return 0.9;
        if (type === 'step/start' || type === 'step/end')
            return 0.85;
        if (type === 'tool/call' || type === 'tool/result')
            return 0.8;
        if (type === 'assistant/message' && obj(o['data'])['message'] !== undefined)
            return 0.8;
        return 0;
    },
    create(ctx, emit) {
        /**
         * 时间锚点。
         *
         * 真实日志里 `session` 行**没有 `time` 字段**（只有 `createdAt`），
         * 而 `createdAt` 在个别老会话里也可能缺失。如果这时用 0 当基准，
         * 所有事件的 t 都会变成 1.7e12 毫秒（"时长 17 亿秒"）。
         * 所以：锚点没确定之前先把行缓冲起来，确定后再回放 —— 绝不猜。
         */
        let t0 = 0;
        let started = false;
        let model = ctx.model ?? '';
        const seenPrompts = new Set();
        const pending = [];
        let flushing = false;
        const rel = (time) => Math.max(0, Math.round(time - t0));
        /** 尝试确定时间基准；返回是否已可用 */
        const anchor = (o, time) => {
            if (t0 > 0)
                return true;
            if (asStr(o['type']) === 'session') {
                const created = asNum(o['createdAt'] ?? obj(o['data'])['createdAt']);
                if (created > 0) {
                    t0 = created;
                    return true;
                }
            }
            if (time > 0) {
                t0 = time;
                return true;
            }
            return false;
        };
        const emitAt = (draft, time) => {
            if (t0 > 0)
                emit({ ...draft, t: rel(time) });
            else
                emit(draft);
        };
        const start = (data, time) => {
            if (started)
                return;
            started = true;
            // 注意 asNum(0) 会返回 0 而不是 fallback：从文件中间开始读时（尾部加载）
            // 没有 createdAt，必须退回"第一行的时间戳"，否则 t 会变成绝对值（24 小时的时间轴）
            if (t0 <= 0) {
                const created = asNum(data['createdAt']);
                t0 = created > 0 ? created : time;
            }
            const id = asStr(data['id']);
            emit({
                kind: 'run.start',
                t: 0,
                data: {
                    wall: new Date(t0 || Date.now()).toISOString(),
                    goal: '',
                    ...(id ? { sessionId: id } : {}),
                },
            });
            emitAt({
                kind: 'session.start',
                data: {
                    runtime: 'dsh',
                    model,
                    role: ctx.agent,
                    cwd: asStr(data['cwd']),
                    preset: asStr(data['agentPreset']),
                },
            }, time);
        };
        const handle = (o, time) => {
            const type = asStr(o['type']);
            const data = obj(o['data']);
            if (type === 'session') {
                // 注意：session 行的字段在**顶层**（不是 data 里）：
                // {"type":"session","version":4,"id":…,"createdAt":…,"cwd":…}
                start({ ...o, ...data }, time);
                return;
            }
            if (!started)
                start({}, time);
            switch (type) {
                case 'turn/start': {
                    emitAt({ kind: 'checkpoint', data: { name: `turn ${asNum(data['turn'])}` } }, time);
                    break;
                }
                case 'turn/end': {
                    const reason = obj(data['reason']);
                    emitAt({
                        kind: 'checkpoint',
                        data: { name: `turn ${asNum(data['turn'])} 结束`, note: asStr(reason['kind']) },
                    }, time);
                    break;
                }
                case 'user/message': {
                    const source = obj(data['source']);
                    const srcKind = asStr(source['kind']);
                    // 审批策略变更之类的系统通知也走 user/message；它们不是用户发言，
                    // 混进来会把"任务目标"污染成一句系统提示。
                    if (srcKind !== '' && srcKind !== 'user')
                        break;
                    const text = textOf(data['content']);
                    if (text !== '')
                        emitAt({ kind: 'message.user', data: { text } }, time);
                    break;
                }
                case 'assistant/message': {
                    const message = obj(data['message']);
                    const blocks = Array.isArray(message['content']) ? message['content'] : [];
                    for (const raw of blocks) {
                        const block = obj(raw);
                        const bt = asStr(block['type']);
                        if (bt === 'reasoning') {
                            const text = asStr(block['text']);
                            if (text !== '')
                                emitAt({ kind: 'think', data: { text } }, time);
                        }
                        else if (bt === 'text') {
                            const text = asStr(block['text']);
                            if (text !== '')
                                emitAt({ kind: 'message.agent', data: { text, final: true } }, time);
                        }
                        // tool-call 块不在这里落地：另有一条 tool/call 事件带完整参数
                    }
                    const usage = obj(data['usage']);
                    const input = asNum(usage['inputTokens']);
                    const output = asNum(usage['outputTokens']);
                    const cached = asNum(usage['cacheReadTokens']);
                    if (input + output + cached > 0) {
                        emitAt({ kind: 'usage', data: { in: input, out: output, cached } }, time);
                    }
                    break;
                }
                case 'tool/call': {
                    const name = asStr(data['name'], 'tool');
                    const args = parseArgs(data['arguments']);
                    const draft = {
                        kind: 'tool.call',
                        data: { tool: name, input: args, summary: summarize(name, obj(args)) },
                    };
                    const callId = asStr(data['callId']);
                    if (callId)
                        draft.call = callId;
                    emitAt(draft, time);
                    break;
                }
                case 'tool/result': {
                    const message = obj(data['message']);
                    const callId = asStr(message['toolCallId'] ?? data['toolCallId']);
                    const ok = message['isError'] !== true;
                    const output = textOf(message['content']);
                    const draft = {
                        kind: 'tool.result',
                        data: { ok, output, ...(ok ? {} : { error: output }) },
                    };
                    if (callId)
                        draft.call = callId;
                    emitAt(draft, time);
                    break;
                }
                case 'deliverables/presented': {
                    const files = Array.isArray(data['files']) ? data['files'] : [];
                    for (const raw of files) {
                        const f = obj(raw);
                        const path = asStr(f['path']);
                        if (path === '')
                            continue;
                        emitAt({ kind: 'file.edit', data: { path, added: 0, removed: 0 } }, time);
                    }
                    if (files.length > 0) {
                        emitAt({ kind: 'checkpoint', data: { name: '交付', note: `${files.length} 个文件` } }, time);
                    }
                    break;
                }
                case 'subagent/catalog': {
                    const d = obj(data);
                    const childId = asStr(d['childId']);
                    if (childId !== '') {
                        emitAt({
                            kind: 'subagent',
                            data: {
                                childId,
                                label: asStr(d['label']) || childId.slice(0, 8),
                                mode: asStr(d['mode']),
                            },
                        }, time);
                    }
                    break;
                }
                case 'session/title': {
                    const title = asStr(data['title']);
                    if (title !== '')
                        emitAt({ kind: 'checkpoint', data: { name: '标题', note: title } }, time);
                    break;
                }
                case 'command/run': {
                    emitAt({
                        kind: 'checkpoint',
                        data: { name: asStr(data['name'], 'command'), note: asStr(data['args']).trim() },
                    }, time);
                    break;
                }
                case 'todo/write': {
                    const todos = Array.isArray(data['todos']) ? data['todos'] : [];
                    const done = todos.filter((t) => obj(t)['status'] === 'completed').length;
                    emitAt({ kind: 'checkpoint', data: { name: 'todo', note: `${done}/${todos.length} 完成` } }, time);
                    break;
                }
                case 'request/header': {
                    // model / provider 只在这里出现：session 行没有模型信息。
                    // 拿到后补发一条 session.start（reducer 只更新元数据，不改变状态）。
                    const config = obj(obj(data['header'])['config']);
                    const m = asStr(config['model']);
                    const provider = asStr(config['provider']);
                    if (m !== '' && m !== model) {
                        model = m;
                        emitAt({
                            kind: 'session.start',
                            data: { runtime: 'dsh', model, provider, role: ctx.agent },
                        }, time);
                    }
                    break;
                }
                case 'system/message': {
                    const text = textOf(obj(data['message'])['content']);
                    // 系统提示每步都会重复一次，8KB 级别：同样的内容只记一次
                    const key = `${text.length}:${text.slice(0, 64)}`;
                    if (text !== '' && !seenPrompts.has(key)) {
                        seenPrompts.add(key);
                        emitAt({ kind: 'checkpoint', data: { name: 'system prompt', note: `${text.length} 字符` } }, time);
                    }
                    break;
                }
                default: {
                    if (INTERNAL.has(type)) {
                        // 保留"发生过"，丢掉大载荷
                        emitAt({ kind: 'raw', data: { stream: 'dsh-internal', line: type } }, time);
                    }
                    else if (!LIFECYCLE.has(type)) {
                        emitRaw(emit, JSON.stringify(o));
                    }
                }
            }
        };
        const processLine = (line) => {
            const o = parseJsonLine(line);
            if (!o) {
                emitRaw(emit, line);
                return;
            }
            const time = asNum(o['time']);
            if (!anchor(o, time)) {
                // 还没有时间基准：缓冲，等锚点确定后按原顺序回放
                pending.push(line);
                if (pending.length > 5000) {
                    t0 = Date.now();
                    flush();
                }
                return;
            }
            if (!flushing && pending.length > 0)
                flush();
            handle(o, time);
        };
        function flush() {
            if (flushing)
                return;
            flushing = true;
            const batch = pending.splice(0);
            for (const line of batch)
                processLine(line);
            flushing = false;
        }
        return {
            onLine(line) {
                processLine(line);
            },
            onEnd(status) {
                if (!started)
                    start({}, Date.now());
                emit({ kind: 'session.end', data: { status } });
            },
        };
    },
};
