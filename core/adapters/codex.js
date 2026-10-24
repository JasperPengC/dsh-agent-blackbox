/**
 * Codex（app-server / JSON-RPC）适配器
 *
 * 上游没有稳定的公开 schema 文档，因此本适配器采用**结构启发式**：
 * 以 `params.item.type` 分派，未知 item 一律落 raw。
 *
 * 状态：heuristic。这不是偷懒，是诚实 —— README 的兼容性表里会如实写
 * "字段可能漂移"。发现新 item type 时，只需在 `mapItem` 里加一个 case。
 */
import { asNum, asStr } from "../schema.js";
import { emitRaw, parseJsonLine, } from "./types.js";
function asObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}
/** 把一条 item 映射成 0..n 个事件。 */
function mapItem(item, phase, emit) {
    const type = asStr(item['type']);
    const id = asStr(item['id']);
    switch (type) {
        case 'agentMessage': {
            if (phase !== 'completed')
                return true;
            emit({ kind: 'message.agent', data: { text: asStr(item['text']), final: true } });
            return true;
        }
        case 'reasoning': {
            if (phase !== 'completed')
                return true;
            emit({ kind: 'think', data: { text: asStr(item['text'] ?? item['content']) } });
            return true;
        }
        case 'commandExecution': {
            const command = Array.isArray(item['command'])
                ? item['command'].map((c) => asStr(c)).join(' ')
                : asStr(item['command']);
            if (phase === 'started') {
                const draft = {
                    kind: 'tool.call',
                    data: { tool: 'shell', summary: command.slice(0, 160), input: { command } },
                };
                if (id)
                    draft.call = id;
                emit(draft);
                return true;
            }
            const exitCode = asNum(item['exitCode'], 0);
            const draft = {
                kind: 'tool.result',
                data: {
                    ok: exitCode === 0,
                    output: asStr(item['aggregatedOutput'] ?? item['output']),
                    ms: asNum(item['durationMs']),
                    ...(exitCode !== 0 ? { error: `exit ${exitCode}` } : {}),
                },
            };
            if (id)
                draft.call = id;
            emit(draft);
            return true;
        }
        case 'fileChange': {
            const changes = Array.isArray(item['changes']) ? item['changes'] : [];
            for (const change of changes) {
                const c = asObj(change);
                emit({
                    kind: 'file.edit',
                    data: {
                        path: asStr(c['path']),
                        added: asNum(c['added']),
                        removed: asNum(c['removed']),
                    },
                });
            }
            return true;
        }
        case 'mcpToolCall': {
            const tool = asStr(item['tool'] ?? item['name'], 'mcp');
            if (phase === 'started') {
                const draft = {
                    kind: 'tool.call',
                    data: { tool, summary: asStr(item['title'], tool), input: item['arguments'] },
                };
                if (id)
                    draft.call = id;
                emit(draft);
                return true;
            }
            const status = asStr(item['status'], 'completed');
            const draft = {
                kind: 'tool.result',
                data: { ok: status !== 'failed' && status !== 'error', output: asStr(item['result']) },
            };
            if (id)
                draft.call = id;
            emit(draft);
            return true;
        }
        case 'webSearch': {
            if (phase === 'started') {
                const draft = {
                    kind: 'tool.call',
                    data: { tool: 'web_search', summary: asStr(item['query']) },
                };
                if (id)
                    draft.call = id;
                emit(draft);
                return true;
            }
            const draft = {
                kind: 'tool.result',
                data: { ok: true, output: asStr(item['result'] ?? item['summary']) },
            };
            if (id)
                draft.call = id;
            emit(draft);
            return true;
        }
        default:
            return false;
    }
}
export const codexAdapter = {
    id: 'codex',
    label: 'Codex (app-server JSON-RPC)',
    status: 'heuristic',
    note: '按 app-server 公开行为实现的启发式映射；上游 item type 变动时只需改 mapItem',
    detect(line) {
        const o = parseJsonLine(line);
        if (!o)
            return 0;
        const method = asStr(o['method']);
        if (method.startsWith('item/') || method.startsWith('turn/') || method.startsWith('thread/')) {
            return 0.88;
        }
        if (asStr(o['jsonrpc']) === '2.0' && o['params'] !== undefined && o['method'] === undefined) {
            return 0.2;
        }
        return 0;
    },
    create(ctx, emit) {
        let started = false;
        const start = () => {
            if (started)
                return;
            started = true;
            emit({
                kind: 'session.start',
                data: { runtime: 'codex', model: ctx.model ?? '', role: ctx.agent, cwd: ctx.cwd ?? '' },
            });
        };
        return {
            onLine(line) {
                const o = parseJsonLine(line);
                if (!o) {
                    emitRaw(emit, line);
                    return;
                }
                const method = asStr(o['method']);
                const params = asObj(o['params']);
                if (method === 'thread/started' || method === 'session/configured') {
                    start();
                    const model = asStr(params['model']);
                    if (model)
                        ctx.model = model;
                    return;
                }
                if (method === 'item/started' || method === 'item/completed') {
                    start();
                    const item = asObj(params['item']);
                    const phase = method === 'item/started' ? 'started' : 'completed';
                    if (!mapItem(item, phase, emit))
                        emitRaw(emit, line);
                    return;
                }
                if (method === 'turn/completed') {
                    start();
                    const usage = asObj(params['usage']);
                    const input = asNum(usage['inputTokens'] ?? usage['input_tokens']);
                    const output = asNum(usage['outputTokens'] ?? usage['output_tokens']);
                    if (input + output > 0)
                        emit({ kind: 'usage', data: { in: input, out: output } });
                    emit({ kind: 'session.end', data: { status: 'done' } });
                    return;
                }
                if (method === 'turn/started') {
                    start();
                    emit({ kind: 'status', data: { state: 'thinking' } });
                    return;
                }
                if (method === 'error' || method === 'thread/error') {
                    emit({ kind: 'error', data: { message: JSON.stringify(params), fatal: false } });
                    return;
                }
                emitRaw(emit, line);
            },
            onEnd(status) {
                start();
                emit({ kind: 'session.end', data: { status } });
            },
        };
    },
};
