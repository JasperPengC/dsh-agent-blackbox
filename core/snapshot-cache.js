/**
 * 首屏快照缓存
 * ============
 *
 * 问题：事件缓存命中后，重启后首次打开仍要 850ms（2.2 万事件要解压 + 解析 + worker 传输）。
 * 但对**首屏**来说，真正需要的不是全部事件，而是四个小响应：
 *   meta（agents / kinds / blockedSpans / duration …）
 *   series（140 个 token 分桶）
 *   spans（工具调用列表，≤2500）
 *   state(t=duration) + 最近事件（KPI / agent 卡片 / 事件列表）
 *
 * 这些加起来几百 KB。把它们按同一个内容 key 缓存下来，首屏就可以**不等索引**：
 *   · 命中：直接返回快照（loading=true，索引在后台补）
 *   · 未命中：走原来的长轮询
 *
 * 快照只存"默认视图"的参数（t=end、from=0、to=duration、limit 固定），
 * 其它参数一律视为 miss —— 宁可慢一点，也不能拿错数据糊弄。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { cacheKey } from "./event-cache.js";
const SNAPSHOT_VERSION = 1;
const QUIET_MS = 30_000;
export const DEFAULT_SNAPSHOT_QUERY = { buckets: 140, spanLimit: 2500, eventLimit: 400 };
function root() {
    return process.env['BLACKBOX_SNAPSHOT_CACHE'] ?? join(homedir(), '.dsh', 'blackbox', 'snapshots');
}
function pathOf(session, opts) {
    return join(root(), `${cacheKey(session, opts, 'snapshot')}.json.gz`);
}
export function readSnapshot(session, opts) {
    const file = pathOf(session, opts);
    if (!existsSync(file))
        return undefined;
    try {
        const raw = readFileSync(file);
        const parsed = JSON.parse(gunzipSync(raw).toString('utf8'));
        if (parsed?.v !== SNAPSHOT_VERSION ||
            typeof parsed.duration !== 'number' ||
            !parsed.meta ||
            !Array.isArray(parsed.series?.buckets) ||
            !Array.isArray(parsed.spans?.spans) ||
            !parsed.state ||
            !Array.isArray(parsed.events?.events)) {
            rmIfExists(file);
            return undefined;
        }
        parsed.bytes = raw.byteLength;
        return parsed;
    }
    catch {
        rmIfExists(file);
        return undefined;
    }
}
export function writeSnapshot(session, opts, snapshot) {
    if (Date.now() - session.mtime < QUIET_MS)
        return false;
    try {
        mkdirSync(root(), { recursive: true });
        const file = pathOf(session, opts);
        const tmp = `${file}.tmp-${process.pid}`;
        const payload = { ...snapshot, v: SNAPSHOT_VERSION };
        delete payload.bytes;
        writeFileSync(tmp, gzipSync(JSON.stringify(payload), { level: 3 }));
        renameSync(tmp, file);
        prune();
        return true;
    }
    catch {
        return false;
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
const MAX_SNAPSHOTS = 60;
function prune() {
    try {
        const dir = root();
        const files = readdirSync(dir).filter((f) => f.endsWith('.json.gz'));
        if (files.length <= MAX_SNAPSHOTS)
            return;
        const sorted = files
            .map((f) => {
            try {
                return { path: join(dir, f), at: statSync(join(dir, f)).mtimeMs };
            }
            catch {
                return undefined;
            }
        })
            .filter((x) => x !== undefined)
            .sort((a, b) => a.at - b.at);
        for (const f of sorted.slice(0, sorted.length - MAX_SNAPSHOTS))
            rmIfExists(f.path);
    }
    catch {
        /* ignore */
    }
}
export function snapshotStats() {
    const dir = root();
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
export function clearSnapshots() {
    const dir = root();
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
