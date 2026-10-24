/**
 * ACP（Agent Client Protocol）适配器 —— 通用层
 *
 * ACP 是 JSON-RPC 2.0：`session/update` 通知里带 `params.update`，
 * `sessionUpdate` 字段决定载荷形状。覆盖 Claude Code / Codex / OpenCode /
 * DeepSeek Harness 等 40+ 个实现了 ACP 的 agent。
 *
 *   {"jsonrpc":"2.0","method":"session/update","params":{
 *      "sessionId":"…","update":{"sessionUpdate":"agent_message_chunk",
 *      "content":{"type":"text","text":"…"}}}}
 *
 * 状态：verified（ACP 有公开 schema，字段名稳定）。
 */
import { asNum, asStr } from "../schema.js";
import { emitRaw, parseJsonLine, } from "./types.js";
function asObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}
/** 从 content 里取文本（content 可能是 {type:'text',text} 或 content block 数组）。 */
function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((c) => contentText(c))
            .filter((s) => s !== '')
            .join('\n');
    }
    const obj = asObj(content);
    const type = asStr(obj['type']);
    if (type === 'text' || type === '')
        return asStr(obj['text']);
    return asStr(obj['text']);
}
export const acpAdapter = {
    id: 'acp',
    label: 'ACP / Agent Client Protocol (JSON-RPC)',
    status: 'verified',
    note: '官方协议，覆盖 Claude Code / Codex / OpenCode / DeepSeek Harness 等实现；字段名由 ACP schema 约束',
    detect(line) {
        const o = parseJsonLine(line);
        if (!o)
            return 0;
        const method = asStr(o['method']);
        if (method === 'session/update') {
            const p = asObj(o['params']);
            if (asStr(p['sessionUpdate']) !== '' || asObj(p['update'])['sessionUpdate'] !== undefined) {
                return 0.97;
            }
            return 0.9;
        }
        if (method === 'session/new' || method === 'session/load' || method === 'initialize')
            return 0.7;
        if (asStr(o['jsonrpc']) === '2.0' && ('result' in o || 'error' in o))
            return 0.4;
        return 0;
    },
    create(ctx, emit) {
        let started = false;
        // ACP 的文本是流式 chunk，累计成"当前这一段"
        let buffer = '';
        const start = () => {
            if (started)
                return;
            started = true;
            emit({
                kind: 'session.start',
                data: { runtime: 'acp', model: ctx.model ?? '', role: ctx.agent, cwd: ctx.cwd ?? '' },
            });
        };
        const flush = () => {
            if (buffer === '')
                return;
            emit({ kind: 'message.agent', data: { text: buffer, final: true } });
            buffer = '';
        };
        const handleUpdate = (update) => {
            start();
            const kind = asStr(update['sessionUpdate']);
            switch (kind) {
                case 'agent_message_chunk': {
                    // 流式 chunk 只累积，不逐条落地：一个回合边界才 emit 一条完整发言。
                    // 回放场景不需要"打字机效果"，逐 chunk 落库只会让时间轴充满噪声。
                    buffer += contentText(update['content']);
                    break;
                }
                case 'agent_thought_chunk': {
                    emit({ kind: 'think', data: { text: contentText(update['content']) } });
                    break;
                }
                case 'user_message_chunk': {
                    flush();
                    emit({ kind: 'message.user', data: { text: contentText(update['content']) } });
                    break;
                }
                case 'tool_call': {
                    flush();
                    const draft = {
                        kind: 'tool.call',
                        data: {
                            tool: asStr(update['title'], asStr(update['kind'], 'tool')),
                            summary: asStr(update['title']),
                            input: update['rawInput'],
                        },
                    };
                    const id = asStr(update['toolCallId']);
                    if (id)
                        draft.call = id;
                    emit(draft);
                    break;
                }
                case 'tool_call_update': {
                    const status = asStr(update['status']);
                    if (status === 'completed' || status === 'failed') {
                        const draft = {
                            kind: 'tool.result',
                            data: {
                                ok: status === 'completed',
                                output: contentText(update['content'] ?? update['rawOutput']),
                            },
                        };
                        const id = asStr(update['toolCallId']);
                        if (id)
                            draft.call = id;
                        emit(draft);
                    }
                    break;
                }
                case 'plan': {
                    flush();
                    const entries = update['entries'];
                    const count = Array.isArray(entries) ? entries.length : 0;
                    emit({ kind: 'checkpoint', data: { name: 'plan', note: `${count} 项计划` } });
                    break;
                }
                case 'available_commands_update':
                    break;
                default: {
                    break;
                }
            }
        };
        return {
            onLine(line) {
                const o = parseJsonLine(line);
                if (!o) {
                    emitRaw(emit, line);
                    return;
                }
                const method = asStr(o['method']);
                if (method === 'session/update') {
                    const params = asObj(o['params']);
                    handleUpdate(asObj(params['update']));
                    return;
                }
                // 响应行：initialize / session/new 的 result 里带 model、cwd 等
                const result = asObj(o['result']);
                if (method === 'initialize') {
                    const ua = asStr(result['userAgent']);
                    if (ua)
                        ctx.model = ua;
                    start();
                    return;
                }
                if (method === 'session/new' || method === 'session/load') {
                    start();
                    const models = asObj(result['models']);
                    const current = asObj(models['currentModelId']);
                    const model = asStr(current['id'] ?? result['model']);
                    if (model)
                        ctx.model = model;
                    emit({
                        kind: 'session.start',
                        data: { runtime: 'acp', model: ctx.model ?? '', role: ctx.agent, cwd: ctx.cwd ?? '' },
                    });
                    return;
                }
                if ('error' in o) {
                    emit({ kind: 'error', data: { message: JSON.stringify(o['error']), fatal: false } });
                    return;
                }
                if ('result' in o && 'id' in o)
                    return;
                emitRaw(emit, line);
            },
            onEnd(status) {
                start();
                flush();
                emit({ kind: 'session.end', data: { status } });
            },
        };
    },
};
/** ACP 里 cost/usage 常由实现自己塞进 update，兜底从任意字段里捞一次。 */
export function extractAcpUsage(update) {
    const cost = asNum(update['costUsd'] ?? update['cost_usd']);
    const input = asNum(update['inputTokens'] ?? update['input_tokens']);
    const output = asNum(update['outputTokens'] ?? update['output_tokens']);
    if (cost === 0 && input === 0 && output === 0)
        return undefined;
    return { kind: 'usage', data: { in: input, out: output, costUsd: cost } };
}
