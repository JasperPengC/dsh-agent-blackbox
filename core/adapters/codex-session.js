/**
 * Codex 会话日志适配器 —— `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 *
 * 真实样本（已核对）：
 *   {"timestamp":…,"ordinal":0,"type":"session_meta","payload":{"session_id":…,"cwd":…,"cli_version":…}}
 *   {"type":"turn_context","payload":{"model":"…","cwd":…,"approval_policy":…}}
 *   {"type":"response_item","payload":{"type":"message","role":"assistant","content":[…]}}
 *   {"type":"response_item","payload":{"type":"reasoning","summary":[…]}}
 *   {"type":"response_item","payload":{"type":"function_call","name":"…","namespace":"…","arguments":"{…}","call_id":"…"}}
 *   {"type":"response_item","payload":{"type":"function_call_output","call_id":"…","output":[…]}}
 *   {"type":"token_usage_record","payload":{"usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…}}}
 *
 * 与 Claude Code 相反：Codex 的条目**是完整的**，不需要按 id 聚合。
 * 但 token 用量单独成事件（token_usage_record），所以成本可以直接算准。
 */
import { asNum, asStr } from "../schema.js";
import { emitRaw, parseJsonLine, } from "./types.js";
const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
/** 纯噪声：状态快照 / 内部事件 */
const SKIP_EVENT = new Set(['world_state', 'event_msg']);
function contentText(content) {
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
function summarize(name, rawArgs) {
    let args = {};
    if (typeof rawArgs === 'string') {
        try {
            args = obj(JSON.parse(rawArgs));
        }
        catch {
            return name;
        }
    }
    else if (typeof rawArgs === 'object' && rawArgs !== null) {
        args = rawArgs;
    }
    const pick = ['command', 'path', 'file_path', 'query', 'code', 'title', 'description'];
    for (const k of pick) {
        const v = args[k];
        if (typeof v === 'string' && v.trim() !== '')
            return v.length > 110 ? `${v.slice(0, 110)}…` : v;
    }
    return name;
}
export const codexSessionAdapter = {
    id: 'codex-session',
    label: 'Codex（rollout 会话文件）',
    status: 'verified',
    note: '~/.codex/sessions/年/月/日/rollout-*.jsonl，追加写，可实时尾随；token 用量单独成事件，成本可算准',
    detect(line) {
        const o = parseJsonLine(line);
        if (!o)
            return 0;
        const type = asStr(o['type']);
        if (type === 'session_meta' && obj(o['payload'])['session_id'] !== undefined)
            return 0.95;
        if (type === 'response_item' || type === 'turn_context' || type === 'token_usage_record')
            return 0.85;
        if (type === 'event_msg' || type === 'world_state')
            return 0.6;
        return 0;
    },
    create(ctx, emit) {
        let t0 = 0;
        let started = false;
        let model = ctx.model ?? '';
        const pending = [];
        let curTs = 0;
        const rel = (ts) => Math.max(0, Math.round(ts - t0));
        const start = (ts, meta) => {
            if (started)
                return;
            started = true;
            t0 = ts;
            emit({
                kind: 'run.start',
                t: 0,
                data: { wall: new Date(ts).toISOString(), goal: '', sessionId: asStr(meta['session_id']) },
            });
            emit({
                kind: 'session.start',
                t: 0,
                data: {
                    runtime: 'codex',
                    model,
                    role: ctx.agent,
                    cwd: asStr(meta['cwd']),
                    provider: asStr(meta['model_provider']),
                },
            });
        };
        const handle = (o) => {
            const ts = Date.parse(asStr(o['timestamp']));
            if (Number.isFinite(ts) && ts > 0)
                curTs = ts;
            if (!started) {
                if (!Number.isFinite(ts) || ts <= 0)
                    return;
                curTs = ts;
                start(ts, asStr(o['type']) === 'session_meta' ? obj(o['payload']) : {});
            }
            const type = asStr(o['type']);
            const payload = obj(o['payload']);
            if (type === 'session_meta') {
                const m = asStr(obj(payload['model'])['slug']);
                if (m !== '' && m !== model) {
                    model = m;
                    emit({ kind: 'session.start', t: rel(curTs), data: { runtime: 'codex', model, role: ctx.agent } });
                }
                return;
            }
            if (type === 'turn_context') {
                const m = asStr(payload['model']);
                if (m !== '' && m !== model) {
                    model = m;
                    emit({
                        kind: 'session.start',
                        t: rel(curTs),
                        data: { runtime: 'codex', model, role: ctx.agent, cwd: asStr(payload['cwd']) },
                    });
                }
                return;
            }
            if (type === 'token_usage_record') {
                const u = obj(payload['usage']);
                const input = asNum(u['input_tokens']);
                const output = asNum(u['output_tokens']);
                const cached = asNum(u['cached_input_tokens']);
                if (input + output + cached > 0) {
                    emit({ kind: 'usage', t: rel(curTs), data: { in: input, out: output, cached } });
                }
                return;
            }
            if (type === 'response_item') {
                const pt = asStr(payload['type']);
                switch (pt) {
                    case 'message': {
                        const role = asStr(payload['role']);
                        const text = contentText(payload['content']);
                        if (text === '')
                            return;
                        if (role === 'assistant')
                            emit({ kind: 'message.agent', t: rel(curTs), data: { text, final: true } });
                        else if (role === 'user')
                            emit({ kind: 'message.user', t: rel(curTs), data: { text } });
                        // developer / system：每回合重复的提示词，不落地
                        return;
                    }
                    case 'reasoning': {
                        const summary = payload['summary'];
                        const text = Array.isArray(summary) ? contentText(summary.map((s) => ({ text: asStr(obj(s)['text']) }))) : '';
                        if (text !== '')
                            emit({ kind: 'think', t: rel(curTs), data: { text } });
                        return;
                    }
                    case 'function_call':
                    case 'custom_tool_call': {
                        const name = asStr(payload['name'] ?? payload['tool'], 'tool');
                        const ns = asStr(payload['namespace']);
                        const tool = ns === '' ? name : `${ns}.${name}`;
                        const draft = {
                            kind: 'tool.call',
                            data: {
                                tool,
                                input: payload['arguments'] ?? payload['input'],
                                summary: summarize(name, payload['arguments'] ?? payload['input']),
                            },
                        };
                        const callId = asStr(payload['call_id'] ?? payload['id']);
                        if (callId)
                            draft.call = callId;
                        emit({ ...draft, t: rel(curTs) });
                        return;
                    }
                    case 'function_call_output':
                    case 'custom_tool_call_output': {
                        const draft = {
                            kind: 'tool.result',
                            data: { ok: true, output: contentText(payload['output']) },
                        };
                        const callId = asStr(payload['call_id']);
                        if (callId)
                            draft.call = callId;
                        emit({ ...draft, t: rel(curTs) });
                        return;
                    }
                    case 'web_search_call': {
                        const draft = {
                            kind: 'tool.call',
                            data: { tool: 'web_search', summary: asStr(payload['query']) },
                        };
                        const callId = asStr(payload['id']);
                        if (callId)
                            draft.call = callId;
                        emit({ ...draft, t: rel(curTs) });
                        return;
                    }
                    default:
                        return;
                }
            }
            if (SKIP_EVENT.has(type))
                return;
            emitRaw(emit, JSON.stringify(o));
        };
        function flush() {
            const batch = pending.splice(0);
            for (const l of batch) {
                const parsed = parseJsonLine(l);
                if (parsed)
                    handle(parsed);
            }
        }
        return {
            onLine(line) {
                const o = parseJsonLine(line);
                if (!o) {
                    emitRaw(emit, line);
                    return;
                }
                if (!started && t0 === 0) {
                    const ts = Date.parse(asStr(o['timestamp']));
                    if (!Number.isFinite(ts) || ts <= 0) {
                        pending.push(line);
                        if (pending.length > 5000) {
                            t0 = Date.now();
                            flush();
                        }
                        return;
                    }
                }
                if (!started && pending.length > 0)
                    flush();
                handle(o);
            },
            onEnd(status) {
                if (!started)
                    return;
                emit({ kind: 'session.end', data: { status } });
            },
        };
    },
};
