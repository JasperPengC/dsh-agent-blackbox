/**
 * DSH 会话标题
 * ============
 *
 * DSH 自己会把会话标题（LLM 生成的短标题）存在投影缓存里：
 *   ~/.dsh/storages/session_projcache/sessions/<uuid>.json
 *     record.rows.title.val            → "智能体黑匣子"
 *     record.rows.titleInput.val.first → 首条用户消息（没有生成标题时兜底）
 *
 * 我们的面板之前只显示会话 ID，用户根本对不上号 —— 这里把标题读出来，
 * 和 DSH 侧栏保持一致。目录很小（实测 3.8MB / 101 个文件），整目录扫一遍约十几毫秒，
 * 因此用 20 秒 TTL + 目录 mtime 做缓存。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const TTL_MS = 20_000;
let cache = null;
export function titlesDir() {
    return process.env['DSH_TITLES_DIR'] ?? join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
}
function load() {
    const dir = titlesDir();
    let dirMtime = 0;
    try {
        dirMtime = statSync(dir).mtimeMs;
    }
    catch {
        return new Map();
    }
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS && cache.dirMtime === dirMtime)
        return cache.map;
    const map = new Map();
    let files = [];
    try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    }
    catch {
        return map;
    }
    for (const file of files) {
        // 文件名有两种历史格式：<uuid>.json 与 session-<uuid>.json
        const id = `session-${file.replace(/\.json$/, '').replace(/^session-/, '')}`;
        try {
            const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            const rows = raw.record?.rows;
            const title = typeof rows?.title?.val === 'string' ? rows.title.val.trim() : '';
            const first = rows?.titleInput?.val?.first?.text;
            const firstMessage = typeof first === 'string' ? first.trim() : '';
            if (title || firstMessage) {
                map.set(id, {
                    ...(title ? { title } : {}),
                    ...(firstMessage ? { firstMessage } : {}),
                });
            }
        }
        catch {
            // 坏文件跳过：标题读不到只是显示 ID，不能因此让整个列表失败
        }
    }
    cache = { at: now, dirMtime, map };
    return map;
}
export function dshTitleOf(sessionId) {
    return load().get(sessionId);
}
/** 从会话文件路径里取出 session id（…/session-<uuid>/session.v4.jsonl.zstd） */
export function sessionIdFromFile(file) {
    const m = /session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(file);
    return m ? `session-${m[1]}` : undefined;
}
/** 给 UI 用的一行标题：只取**真实标题**（首条消息不冒充标题，保持与 DSH 侧栏一致） */
export function displayTitle(sessionId) {
    if (!sessionId)
        return undefined;
    const hit = dshTitleOf(sessionId);
    const text = hit?.title;
    if (!text)
        return undefined;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}
