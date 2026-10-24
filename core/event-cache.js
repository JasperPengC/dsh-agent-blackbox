/**
 * 解码结果磁盘缓存
 * ================
 *
 * 为什么需要：大会话"解码 + 适配器映射"要 1 秒以上（47MB 会话实测 1.25s），
 * 而这段结果**只跟 (文件, size, mtime, 适配器, 读取窗口) 有关**。
 * 把它按内容寻址缓存下来，同一个文件第二次打开（甚至换进程 / 重启服务）就只剩反序列化。
 *
 * 三条规矩：
 *   1. **宁可不用，不能给错**：key 里带 size + mtime + 适配器 + 窗口，任何一项变了就 miss；
 *      读出来的数据再校验一遍结构，坏缓存直接删掉并回退到重新解码。
 *   2. **活会话不写**：文件 30 秒内还在变，写进去下一秒就失效，白白占用磁盘。
 *   3. **有界**：条数与总字节数都有上限，超了按访问时间淘汰。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
/** 缓存格式版本：事件 schema 或解码逻辑变化时 +1，旧缓存自然失效 */
const CACHE_VERSION = 3; // v3: DSH 会话合并子 agent 事件
const MAX_ENTRIES = 80;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
/** 文件多久没变才值得缓存 */
const QUIET_MS = 30_000;
export function cacheRoot() {
    return process.env['BLACKBOX_EVENT_CACHE'] ?? join(homedir(), '.dsh', 'blackbox', 'events-cache');
}
/**
 * 内容寻址的 key：事件缓存与快照缓存共用同一套失效规则。
 * （快照缓存通过 namespace 参数区分，避免两份缓存互相覆盖）
 */
export function cacheKey(session, opts, namespace = '') {
    const h = createHash('sha1');
    h.update([
        CACHE_VERSION,
        namespace,
        session.adapter,
        session.file,
        session.size,
        Math.round(session.mtime),
        opts.full ? 'full' : `tail:${opts.tailBytes}`,
    ].join('|'));
    return h.digest('hex');
}
/** 轻量结构校验：坏缓存不抛错，直接当 miss */
function looksValid(parsed) {
    if (typeof parsed !== 'object' || parsed === null)
        return false;
    const p = parsed;
    if (p.v !== CACHE_VERSION)
        return false;
    if (!Array.isArray(p.events) || p.events.length === 0)
        return false;
    const first = p.events[0];
    return (typeof first === 'object' &&
        first !== null &&
        typeof first.seq === 'number' &&
        typeof first.t === 'number' &&
        typeof first.kind === 'string');
}
export function readEvents(session, opts) {
    const file = join(cacheRoot(), `${cacheKey(session, opts)}.json.gz`);
    if (!existsSync(file))
        return undefined;
    try {
        const raw = readFileSync(file);
        const parsed = JSON.parse(gunzipSync(raw).toString('utf8'));
        if (!looksValid(parsed)) {
            rmIfExists(file);
            return undefined;
        }
        // 命中时刷新访问时间，供淘汰策略使用（只改元数据，很便宜）
        try {
            const now = new Date();
            statSync(file);
            writeFileSync(file, raw); // 重新写一遍以更新 mtime
        }
        catch {
            /* 忽略 */
        }
        return { events: parsed.events, bytes: raw.byteLength };
    }
    catch {
        rmIfExists(file);
        return undefined;
    }
}
function rmIfExists(file) {
    try {
        rmSync(file, { force: true });
    }
    catch {
        /* ignore */
    }
}
export function writeEvents(session, opts, events) {
    // 活会话不写：下一秒就失效
    if (Date.now() - session.mtime < QUIET_MS)
        return false;
    if (events.length === 0)
        return false;
    try {
        const dir = cacheRoot();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${cacheKey(session, opts)}.json.gz`);
        const tmp = `${file}.tmp-${process.pid}`;
        const payload = { v: CACHE_VERSION, events };
        writeFileSync(tmp, gzipSync(JSON.stringify(payload), { level: 3 }));
        renameSync(tmp, file); // 原子落地：避免读到写了一半的缓存
        prune();
        return true;
    }
    catch {
        return false;
    }
}
/** 超限时按 mtime 淘汰最旧的 */
function prune() {
    try {
        const dir = cacheRoot();
        const entries = readdirSync(dir)
            .filter((f) => f.endsWith('.json.gz'))
            .map((f) => {
            const path = join(dir, f);
            try {
                const st = statSync(path);
                return { path, size: st.size, at: st.mtimeMs };
            }
            catch {
                return undefined;
            }
        })
            .filter((e) => e !== undefined)
            .sort((a, b) => a.at - b.at);
        let total = entries.reduce((sum, e) => sum + e.size, 0);
        let count = entries.length;
        for (const entry of entries) {
            if (count <= MAX_ENTRIES && total <= MAX_TOTAL_BYTES)
                break;
            rmIfExists(entry.path);
            count--;
            total -= entry.size;
        }
    }
    catch {
        /* 淘汰失败不影响正确性 */
    }
}
export function cacheStats() {
    const dir = cacheRoot();
    const stats = { root: dir, entries: 0, bytes: 0 };
    if (!existsSync(dir))
        return stats;
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.json.gz'))
                continue;
            try {
                stats.entries++;
                stats.bytes += statSync(join(dir, f)).size;
            }
            catch {
                /* ignore */
            }
        }
    }
    catch {
        /* ignore */
    }
    return stats;
}
export function clearCache() {
    const dir = cacheRoot();
    if (!existsSync(dir))
        return 0;
    let removed = 0;
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.json.gz'))
                continue;
            rmIfExists(join(dir, f));
            removed++;
        }
    }
    catch {
        /* ignore */
    }
    return removed;
}
