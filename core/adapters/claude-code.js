/**
 * Claude Code 会话日志适配器 —— `~/.claude/projects/<slug>/<sessionId>.jsonl`
 *
 * 与 `claude.ts` 的区别：
 *   · `claude.ts`  吃 `claude -p --output-format stream-json` 的 **stdout**
 *   · 本文件      吃 Claude Code 自己的 **会话文件**（每行带 timestamp / sessionId）
 *
 * 真实样本的关键事实（实测 15.7MB / 844 行 assistant）：
 *   **同一个 assistant message.id 会被写成多行**，每行一个 content block
 *   （thinking / text / tool_use），而 `usage` 只出现在最后一行。
 *   如果逐行落地，token 会被重复计算 4~5 倍、发言会被拆成碎片。
 *   → 必须按 message.id 聚合，等这一条消息写完再一次性落地。
 *
 * 这个坑只有拿真实文件跑才会发现：按文档写永远是对的。
 */
import { asNum, asStr } from "../schema.js";
import { handleAssistant, handleUser } from "./claude.js";
import { emitRaw, parseJsonLine, } from "./types.js";
const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
/** 每个回合都在写、但排障时没有信息量的内部遥测 */
const INTERNAL = new Set([
    'attachment',
    'api-request',
    'api-request-blob',
    'api-request-shape',
    'file-history-snapshot',
    'last-prompt',
    'mode',
    'permission-mode',
    'atis-latch',
    'queue-operation',
    'progress',
]);
export const claudeCodeAdapter = {
    id: 'claude-code',
    label: 'Claude Code（会话文件）',
    status: 'verified',
    note: '~/.claude/projects/<项目>/<sessionId>.jsonl，追加写，可实时尾随；assistant 逐块写需按 message.id 聚合',
    detect(line) {
        const o = parseJsonLine(line);
        if (!o)
            return 0;
        const type = asStr(o['type']);
        if (type === 'assistant' && typeof o['message'] === 'object' && o['sessionId'] !== undefined)
            return 0.92;
        if (type === 'user' && o['sessionId'] !== undefined && o['uuid'] !== undefined)
            return 0.88;
        if (type === 'system' && o['sessionId'] !== undefined)
            return 0.8;
        if (type === 'summary' || type === 'custom-title' || type === 'ai-title')
            return 0.75;
        return 0;
    },
    create(ctx, emit) {
        let t0 = 0;
        let started = false;
        let model = ctx.model ?? '';
        const pending = [];
        const rel = (ts) => Math.max(0, Math.round(ts - t0));
        let curTs = 0;
        /** 聚合中的 assistant 消息 */
        let bufId = '';
        let bufBlocks = [];
        let bufUsage = undefined;
        let bufUuid = '';
        const stamped = (d) => {
            if (typeof d.t === 'number' || t0 === 0)
                emit(d);
            else
                emit({ ...d, t: rel(curTs) });
        };
        const start = (ts, data) => {
            if (started)
                return;
            started = true;
            t0 = ts;
            emit({
                kind: 'run.start',
                t: 0,
                data: { wall: new Date(ts).toISOString(), goal: '', sessionId: asStr(data['sessionId']) },
            });
            emit({
                kind: 'session.start',
                t: 0,
                data: { runtime: 'claude-code', model, role: ctx.agent, cwd: asStr(data['cwd']) },
            });
        };
        const flushAssistant = () => {
            if (bufBlocks.length === 0 && bufUsage === undefined) {
                bufId = '';
                return;
            }
            handleAssistant(stamped, { content: bufBlocks, usage: bufUsage }, bufUuid);
            bufId = '';
            bufBlocks = [];
            bufUsage = undefined;
        };
        const handle = (o) => {
            const ts = Date.parse(asStr(o['timestamp']));
            if (Number.isFinite(ts) && ts > 0)
                curTs = ts;
            if (!started) {
                if (!Number.isFinite(ts) || ts <= 0)
                    return;
                curTs = ts;
                start(ts, o);
            }
            const type = asStr(o['type']);
            // 内部遥测行会插在 assistant 分块之间，不能因为它把一条消息截断
            if (type !== 'assistant' && !INTERNAL.has(type))
                flushAssistant();
            switch (type) {
                case 'assistant': {
                    const message = obj(o['message']);
                    const id = asStr(message['id']);
                    // 换了一条消息 → 上一条已写完，先落地
                    if (bufId !== '' && id !== bufId)
                        flushAssistant();
                    bufId = id;
                    bufUuid = asStr(o['uuid']);
                    const content = message['content'];
                    if (Array.isArray(content))
                        bufBlocks.push(...content);
                    const usage = message['usage'];
                    if (typeof usage === 'object' && usage !== null && asNum(obj(usage)['output_tokens']) >= 0) {
                        const u = obj(usage);
                        // usage 只在最后一行有值，其余行是全 0 —— 只保留有值的
                        if (asNum(u['input_tokens']) + asNum(u['output_tokens']) + asNum(u['cache_read_input_tokens']) > 0) {
                            bufUsage = usage;
                        }
                    }
                    const m = asStr(message['model']);
                    if (m !== '' && m !== model) {
                        model = m;
                        emit({ kind: 'session.start', t: rel(curTs), data: { runtime: 'claude-code', model, role: ctx.agent } });
                    }
                    break;
                }
                case 'user': {
                    handleUser(stamped, obj(o['message']));
                    break;
                }
                case 'summary': {
                    const text = asStr(o['summary']);
                    if (text !== '')
                        emit({ kind: 'checkpoint', t: rel(curTs), data: { name: '摘要', note: text } });
                    break;
                }
                case 'custom-title': {
                    const title = asStr(o['customTitle']);
                    if (title !== '')
                        emit({ kind: 'checkpoint', t: rel(curTs), data: { name: '标题', note: title } });
                    break;
                }
                case 'ai-title': {
                    const title = asStr(o['title'] ?? o['aiTitle']);
                    if (title !== '')
                        emit({ kind: 'checkpoint', t: rel(curTs), data: { name: '标题', note: title } });
                    break;
                }
                case 'system': {
                    const subtype = asStr(o['subtype']);
                    if (subtype === 'turn_duration') {
                        emit({
                            kind: 'checkpoint',
                            t: rel(curTs),
                            data: { name: 'turn', note: `${asNum(o['messageCount'])} 条消息 · ${asNum(o['durationMs'])}ms` },
                        });
                    }
                    else if (subtype === 'api_error') {
                        emit({ kind: 'error', t: rel(curTs), data: { message: asStr(o['message']), fatal: false } });
                    }
                    break;
                }
                default: {
                    if (!INTERNAL.has(type))
                        emitRaw(emit, JSON.stringify(o));
                }
            }
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
                flushAssistant();
                emit({ kind: 'session.end', data: { status } });
            },
        };
    },
};
