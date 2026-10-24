/**
 * 会话头信息（部分加载时补 goal / 开始时间）
 * =========================================
 *
 * 大会话默认只读尾部 8MB。但 `run.start` / 第一条用户消息在文件**开头**，
 * 所以只加载尾部时 `run.goal` 是空的 —— 界面只能显示会话 ID（用户对不上号）。
 *
 * 这里单独读文件头部（默认 256KB）解析出：
 *   · 首条**用户**消息（跳过 user-approval 这类系统注入）
 *   · session.createdAt
 * 成本很低（一次 pread），且只对 partial 会话执行。
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { decodeFrames } from "./live.js";
import { cleanUserText } from "./text.js";
const MAX_BYTES = 256 * 1024;
function readPrefix(file, maxBytes) {
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(maxBytes);
        const n = readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, n);
    }
    finally {
        closeSync(fd);
    }
}
function splitLines(text) {
    const parts = text.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '')
        parts.pop();
    return parts.filter((l) => l.trim() !== '');
}
export function headLines(session, maxBytes = MAX_BYTES) {
    const buf = readPrefix(session.file, maxBytes);
    if (session.format === 'zstd-jsonl')
        return decodeFrames(buf).lines;
    return splitLines(buf.toString('utf8'));
}
/** 从一行里提取"用户说的话"；认不出来返回空串 */
function userTextOf(o) {
    const type = typeof o['type'] === 'string' ? o['type'] : '';
    const data = (o['data'] ?? {});
    // DSH：agent/inbox/spliced → inserted[].content[].text（只取 source.kind === 'user'）
    if (type === 'agent/inbox/spliced') {
        const inserted = Array.isArray(data['inserted']) ? data['inserted'] : [];
        for (const item of inserted) {
            const source = (item['source'] ?? {});
            const kind = typeof source['kind'] === 'string' ? source['kind'] : '';
            if (kind !== '' && kind !== 'user')
                continue; // 跳过 user-approval 等系统注入
            const content = Array.isArray(item['content']) ? item['content'] : [];
            for (const c of content) {
                if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].trim() !== '')
                    return c['text'];
            }
            if (typeof item['text'] === 'string' && item['text'].trim() !== '')
                return item['text'];
        }
        return '';
    }
    // DSH：message/user
    if ((type === 'message/user' || type === 'user') && typeof data['text'] === 'string') {
        return data['text'];
    }
    // Claude Code：{"type":"user","message":{"content":[{"type":"text","text":"…"}]}}
    if (type === 'user') {
        const message = (o['message'] ?? {});
        const content = message['content'];
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            for (const c of content) {
                if (c['type'] === 'text' && typeof c['text'] === 'string')
                    return c['text'];
            }
        }
    }
    // Codex rollout：{"type":"event_msg","payload":{"type":"user_message","message":"…"}}
    if (type === 'event_msg') {
        const payload = (o['payload'] ?? {});
        if (payload['type'] === 'user_message' && typeof payload['message'] === 'string')
            return payload['message'];
    }
    // Codex 新版：{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"…"}]}}
    if (type === 'response_item') {
        const payload = (o['payload'] ?? {});
        if (payload['type'] === 'message' && payload['role'] === 'user') {
            const content = payload['content'];
            if (Array.isArray(content)) {
                for (const c of content) {
                    if ((c['type'] === 'input_text' || c['type'] === 'text') && typeof c['text'] === 'string')
                        return c['text'];
                }
            }
            if (typeof payload['text'] === 'string')
                return payload['text'];
        }
    }
    return '';
}
export function readSessionHead(session, maxBytes = MAX_BYTES) {
    let goal = '';
    let title = '';
    let startedAt = 0;
    for (const line of headLines(session, maxBytes)) {
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            continue;
        }
        const type = typeof o['type'] === 'string' ? o['type'] : '';
        if (startedAt === 0 && type === 'session' && typeof o['createdAt'] === 'number') {
            startedAt = o['createdAt'];
        }
        // 标题：DSH 的 session/title、Claude Code 的 summary（都是"最后一次为准"）
        if (type === 'session/title') {
            const data = (o['data'] ?? {});
            if (typeof data['title'] === 'string' && data['title'].trim() !== '')
                title = data['title'].trim();
        }
        else if (type === 'summary' && typeof o['summary'] === 'string' && o['summary'].trim() !== '') {
            title = o['summary'].trim();
        }
        if (goal === '') {
            const clean = cleanUserText(userTextOf(o));
            if (clean !== '')
                goal = clean;
        }
    }
    if (goal === '' && startedAt === 0 && title === '')
        return undefined;
    return {
        ...(goal !== '' ? { goal: goal.replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
        ...(title !== '' ? { title: title.slice(0, 120) } : {}),
        ...(startedAt !== 0 ? { startedAt } : {}),
    };
}
