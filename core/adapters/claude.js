/**
 * Claude Code 适配器 —— `claude -p --output-format stream-json --verbose`
 *
 * 日志形态（每行一个 JSON）：
 *   {"type":"system","subtype":"init","session_id":…,"model":…,"cwd":…,"tools":[…]}
 *   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use"|"thinking",…}], "usage":{…}}}
 *   {"type":"user",     "message":{"content":[{"type":"tool_result","tool_use_id":…,"is_error":…}]}}
 *   {"type":"result","subtype":"success","total_cost_usd":…,"usage":{…},"result":…}
 *
 * 状态：verified（有真实样本回归测试）。若上游新增 type，未知行会落成 raw，不会丢。
 */
import { asNum, asStr } from "../schema.js";
import { emitRaw, parseJsonLine, } from "./types.js";
function usageOf(obj) {
    const u = (typeof obj === 'object' && obj !== null ? obj : {});
    return {
        input: asNum(u['input_tokens']),
        output: asNum(u['output_tokens']),
        cached: asNum(u['cache_read_input_tokens']),
    };
}
function contentBlocks(message) {
    const msg = (typeof message === 'object' && message !== null ? message : {});
    const content = msg['content'];
    if (!Array.isArray(content))
        return [];
    return content.filter((c) => typeof c === 'object' && c !== null);
}
export function handleAssistant(emit, msg, callIdPrefix) {
    const blocks = contentBlocks(msg);
    const texts = [];
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const type = asStr(block['type']);
        if (type === 'text') {
            texts.push(asStr(block['text']));
            continue;
        }
        if (type === 'thinking') {
            emit({ kind: 'think', data: { text: asStr(block['thinking']) } });
            continue;
        }
        if (type === 'tool_use') {
            const name = asStr(block['name'], 'tool');
            const id = asStr(block['id'], `${callIdPrefix}-${i}`);
            const input = block['input'];
            emit({
                kind: 'tool.call',
                call: id,
                data: {
                    tool: name,
                    input,
                    summary: summarizeInput(name, input),
                },
            });
        }
    }
    if (texts.length > 0) {
        const text = texts.join('');
        emit({ kind: 'message.agent', data: { text } });
    }
    const u = usageOf(msg['usage']);
    if (u.input + u.output + u.cached > 0) {
        // 只记 token，不记成本：成本在 result 行统一给，避免重复累计
        emit({ kind: 'usage', data: { in: u.input, out: u.output, cached: u.cached } });
    }
}
export function handleUser(emit, msg) {
    const raw = (typeof msg === 'object' && msg !== null ? msg : {});
    // 真实日志里 user.message.content 可能是字符串（人直接输入的一句话）
    if (typeof raw['content'] === 'string') {
        const text = raw['content'];
        if (text !== '')
            emit({ kind: 'message.user', data: { text } });
        return;
    }
    for (const block of contentBlocks(msg)) {
        const type = asStr(block['type']);
        if (type === 'tool_result') {
            const id = asStr(block['tool_use_id']);
            const raw = block['content'];
            const output = typeof raw === 'string'
                ? raw
                : Array.isArray(raw)
                    ? raw
                        .map((c) => (typeof c === 'object' && c !== null ? asStr(c['text']) : ''))
                        .join('\n')
                    : '';
            const isError = block['is_error'] === true;
            const draft = {
                kind: 'tool.result',
                data: { ok: !isError, output, ...(isError ? { error: output } : {}) },
            };
            if (id)
                draft.call = id;
            emit(draft);
            continue;
        }
        if (type === 'text') {
            emit({ kind: 'message.user', data: { text: asStr(block['text']) } });
        }
    }
}
function summarizeInput(tool, input) {
    if (typeof input !== 'object' || input === null)
        return tool;
    const obj = input;
    const keys = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description'];
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.length > 0)
            return v.length > 120 ? `${v.slice(0, 120)}…` : v;
    }
    return tool;
}
export const claudeAdapter = {
    id: 'claude',
    label: 'Claude Code (stream-json)',
    status: 'verified',
    note: 'claude -p --output-format stream-json --verbose 的输出，或将其 stdout 重定向成 .jsonl 后 ingest',
    detect(line) {
        const o = parseJsonLine(line);
        if (!o)
            return 0;
        const type = asStr(o['type']);
        if (type === 'system' && asStr(o['subtype']) === 'init')
            return 0.95;
        if (type === 'result' && ('total_cost_usd' in o || asStr(o['subtype']) !== ''))
            return 0.85;
        if ((type === 'assistant' || type === 'user') && typeof o['message'] === 'object')
            return 0.8;
        if (type === 'stream_event')
            return 0.6;
        return 0;
    },
    create(ctx, emit) {
        let started = false;
        let seenResult = false;
        const start = (model) => {
            if (started)
                return;
            started = true;
            emit({
                kind: 'session.start',
                data: {
                    runtime: 'claude-code',
                    model: model ?? ctx.model ?? '',
                    role: ctx.agent,
                    cwd: ctx.cwd ?? '',
                },
            });
        };
        return {
            onLine(line) {
                const o = parseJsonLine(line);
                if (!o) {
                    emitRaw(emit, line);
                    return;
                }
                const type = asStr(o['type']);
                switch (type) {
                    case 'system': {
                        if (asStr(o['subtype']) === 'init')
                            start(asStr(o['model']) || undefined);
                        break;
                    }
                    case 'assistant': {
                        start(asStr(o['model']) || undefined);
                        handleAssistant(emit, o['message'], `msg${asNum(o['sequence'])}`);
                        break;
                    }
                    case 'user': {
                        handleUser(emit, o['message']);
                        break;
                    }
                    case 'result': {
                        start();
                        seenResult = true;
                        const cost = asNum(o['total_cost_usd']);
                        const u = usageOf(o['usage']);
                        if (cost > 0 || u.input + u.output > 0) {
                            // 结果行只补成本与"最终"文本，token 已在逐轮里记过
                            emit({ kind: 'usage', data: { in: 0, out: 0, cached: 0, costUsd: cost } });
                        }
                        const finalText = asStr(o['result']);
                        if (finalText)
                            emit({ kind: 'message.agent', data: { text: finalText, final: true } });
                        emit({ kind: 'session.end', data: { status: o['is_error'] === true ? 'failed' : 'done' } });
                        break;
                    }
                    case 'stream_event': {
                        // 细粒度增量：知道它开始了就行，正文由 assistant 行给出，不重复记
                        start();
                        break;
                    }
                    case 'rate_limit_event':
                    case 'system_reminder':
                        break;
                    default: {
                        emitRaw(emit, line);
                    }
                }
            },
            onEnd(status) {
                start();
                if (!seenResult)
                    emit({ kind: 'session.end', data: { status } });
            },
        };
    },
};
