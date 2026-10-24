/**
 * 本地 Web 服务 —— 内核 + 浏览器之间的唯一通道
 *
 * 架构约束：**浏览器是哑渲染器**。它不做投影、不做索引、不 import 内核代码，
 * 只发几个只读请求：
 *   GET /api/meta          元数据（agent 列表、时长、kind 分布、模型、检查点）
 *   GET /api/state?t=…     某个逻辑时刻的完整状态（投影在服务端完成）
 *   GET /api/spans         工具调用的时间跨度（瀑布图）
 *   GET /api/series        分桶后的 token 曲线（迷你图）
 *   GET /api/events?from&to  时间窗口内的事件
 *   GET /api/stats         统计报告
 *   GET /api/live          轻量轮询：事件数 / 时长 / 是否在增长
 *
 * 于是：前端可以随便换（React / 原生 / curl）；投影性能由内核负责；
 * 推到浏览器的是"状态"而不是"事件流"，10 万事件也拖不死浏览器。
 *
 * live 模式（--follow）下，文件增长时**增量扩展索引**而不是重建 ——
 * 每轮只处理新增的几条事件，长时间盯着看也不会越来越卡。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openSessionSource, TAIL_BYTES } from "./session-source.js";
import { attribution, buildIndex, extendIndex, seek, slice, } from "./projector.js";
import { buildStatsReport, fmtDur } from "./report.js";
import { compareAsync, overviewSnapshot, warmOverview } from "./overview-async.js";
import { DEFAULT_SNAPSHOT_QUERY, readSnapshot, writeSnapshot, } from "./snapshot-cache.js";
import { displayTitle, sessionIdFromFile } from "./dsh-titles.js";
import { readSessionHead } from "./session-head.js";
import { defaultRoots, discoverAll } from "./sources.js";
import { KIND_META } from "./schema.js";
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const STATIC = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
    '/overview': { file: 'overview.html', type: 'text/html; charset=utf-8' },
    '/overview.js': { file: 'overview.js', type: 'text/javascript; charset=utf-8' },
    '/timeline-math.js': { file: 'timeline-math.js', type: 'text/javascript; charset=utf-8' },
    '/compare': { file: 'compare.html', type: 'text/html; charset=utf-8' },
    '/compare.js': { file: 'compare.js', type: 'text/javascript; charset=utf-8' },
};
const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
};
/** web/ 下的静态文件兜底（只允许单层、白名单扩展名，不做目录穿越） */
function fallbackStatic(path) {
    if (!/^\/[\w.-]+\.(js|mjs|css|html|svg|json|png)$/.test(path))
        return undefined;
    const name = path.slice(1);
    const ext = name.slice(name.lastIndexOf('.'));
    const type = MIME[ext];
    if (!type)
        return undefined;
    return { file: name, type };
}
function json(res, body, status = 200) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(data),
    });
    res.end(data);
}
function runtimeOf(file) {
    try {
        return discoverAll().find((s) => s.file === file)?.runtime ?? '';
    }
    catch {
        return '';
    }
}
function metaOf(ix, follow, extra = {}) {
    const final = ix.events.length > 0 ? seek(ix, ix.duration) : undefined;
    const agents = (final?.order ?? []).map((key) => {
        const a = final?.agents[key];
        return {
            id: a?.id ?? key,
            agent: a?.agent ?? key,
            color: a?.color ?? '#94a3b8',
            runtime: a?.runtime ?? '',
            model: a?.model ?? '',
            calls: a?.calls ?? 0,
            tokens: a?.tokens ?? { in: 0, out: 0, cached: 0 },
            costUsd: a?.costUsd ?? 0,
        };
    });
    const title = final?.run.title ?? null;
    const kinds = Object.entries(ix.derived.kinds).map(([kind, count]) => {
        const m = KIND_META[kind];
        return {
            kind,
            count,
            label: m?.label ?? kind,
            color: m?.color ?? '#64748b',
            glyph: m?.glyph ?? '·',
        };
    });
    return {
        run: ix.run,
        title,
        file: ix.file,
        duration: ix.duration,
        eventCount: ix.events.length,
        buildMs: Number(ix.buildMs.toFixed(2)),
        checkpointEvery: ix.every,
        checkpoints: ix.checkpoints.length,
        follow,
        extended: ix.extended,
        wall: ix.wall,
        agents,
        edges: final?.edges ?? [],
        kinds: kinds.sort((a, b) => b.count - a.count),
        stats: final?.stats ?? null,
        runInfo: final?.run ?? null,
        tools: Object.entries(ix.derived.tools)
            .map(([tool, agg]) => ({ tool, ...agg }))
            .sort((a, b) => b.calls - a.calls),
        runtime: extra.runtime ?? '',
        partial: extra.partial === true,
        loading: extra.loading === true,
        cached: extra.cached === true,
        spanCount: ix.spans.length,
        usageCount: ix.usagePoints.length,
        blockedSpans: ix.blockedSpans.map((b) => ({
            agent: b.agent,
            from: b.from,
            to: b.to ?? ix.duration,
            ...(b.reason ? { reason: b.reason } : {}),
        })),
    };
}
/** 把 token 用量按时间分桶，给前端画迷你曲线（服务端算，前端只画）。 */
function seriesOf(ix, buckets) {
    const n = Math.max(8, Math.min(400, buckets));
    const out = [];
    const dur = Math.max(1, ix.duration);
    for (let i = 0; i < n; i++) {
        out.push({ t: Math.round((dur * i) / (n - 1)), in: 0, out: 0, cached: 0 });
    }
    const feed = (points) => {
        for (const p of points) {
            const idx = Math.min(n - 1, Math.round((p.t / dur) * (n - 1)));
            const slot = out[idx];
            slot.in += p.in;
            slot.out += p.out;
            slot.cached += p.cached;
        }
    };
    feed(ix.usagePoints);
    return out;
}
/** 只允许读已知会话目录与当前工作目录下的文件，避免变成任意文件读取器 */
function allowedFile(file) {
    const roots = defaultRoots();
    const normalized = file.replace(/\\/g, '/');
    const bases = [roots.dsh, roots.claude, roots.codex, process.cwd()];
    return bases.some((b) => normalized.startsWith(b.replace(/\\/g, '/')));
}
function normalizeBase(base) {
    if (!base)
        return '';
    let b = base.trim();
    if (b === '' || b === '/')
        return '';
    if (!b.startsWith('/'))
        b = `/${b}`;
    if (b.endsWith('/'))
        b = b.slice(0, -1);
    return b;
}
/**
 * 独立于 HTTP server 的路由。
 *
 * 拆出来是为了让 **DSH 插件**能复用同一套路由：插件把 `/blackbox` 前缀注册进
 * 宿主自己的 webServer，`startServer` 则是把这些路由挂在根路径上跑一个本地端口。
 * 两种形态共用同一份实现 —— 不用维护两套 API。
 */
export function createRouter(opts) {
    const primary = openSessionSource(opts.file, opts.follow === true);
    const sources = new Map([[opts.file, primary]]);
    // 后台预热默认会话：第一次打开面板时索引已经建好（大会话冷启动要 1s+）
    setTimeout(() => {
        try {
            primary.reload();
        }
        catch {
            /* 预热失败不影响正常请求 */
        }
    }, 800).unref?.();
    /**
     * 首屏快照：索引就绪后把"默认视图的四个小响应"落盘；
     * 下次冷启动（含服务重启）在索引补齐之前先用快照把首屏渲染出来。
     */
    /**
     * 两个标记必须分开：
     *   · snapshots    = 已加载到内存的快照
     *   · snapshotBuilt = 已经安排过写盘（防止重复写）
     * 之前把"查过但没有"也缓存成 null，导致写盘守卫误判为"已处理"，
     * 快照永远写不出来（这个 bug 只有端到端跑一次才会发现）。
     */
    const snapshots = new Map();
    const snapshotBuilt = new Set();
    const snapKey = (file, full) => `${file}#${full ? '1' : '0'}`;
    const snapshotFor = (file, full, source) => {
        if (!source.native)
            return undefined;
        const key = snapKey(file, full);
        const hit = snapshots.get(key);
        if (hit)
            return hit;
        process.env['BLACKBOX_DEBUG'] && process.stderr.write(`[snap] miss key=${key.slice(-60)}\n`);
        // 未命中不缓存"没有"：文件可能在别的进程刚被写入。existsSync 很便宜。
        const loaded = readSnapshot(toSession(file), { full, tailBytes: TAIL_BYTES });
        if (process.env['BLACKBOX_DEBUG']) {
            process.stderr.write(`[snap] read ${loaded ? 'HIT' : 'MISS'} ${String(file).slice(-40)}\n`);
        }
        if (loaded)
            snapshots.set(key, loaded);
        return loaded;
    };
    const toSession = (file) => {
        const all = discoverAll();
        const hit = all.find((x) => x.file === file);
        if (!hit)
            throw new Error(`找不到会话：${file}`);
        return hit;
    };
    const buildSnapshot = (ix, file, full, source) => {
        const t = ix.duration;
        const state = seek(ix, t);
        const spans = ix.spans.filter((sp) => sp.start <= t).slice(-DEFAULT_SNAPSHOT_QUERY.spanLimit);
        const recent = ix.events.slice(-DEFAULT_SNAPSHOT_QUERY.eventLimit);
        return {
            v: 1,
            duration: t,
            query: DEFAULT_SNAPSHOT_QUERY,
            meta: {
                ...metaOf(ix, source.follow, {
                    runtime: runtimeOf(file),
                    partial: source.partial,
                    loading: false,
                    cached: true,
                }),
                title: displayTitle(sessionIdFromFile(file)) ?? null,
                native: true,
            },
            series: { buckets: seriesOf(ix, DEFAULT_SNAPSHOT_QUERY.buckets) },
            spans: { from: 0, to: t, count: spans.length, spans },
            state: { state, attribution: attribution(state, state.t) },
            events: { from: 0, to: t, count: ix.events.length, events: recent },
        };
    };
    const maybeWriteSnapshot = (ix, file, full, source) => {
        if (source.loading || !source.native)
            return;
        const key = snapKey(file, full);
        if (snapshotBuilt.has(key))
            return;
        snapshotBuilt.add(key);
        setImmediate(() => {
            try {
                const snap = buildSnapshot(ix, file, full, source);
                const ok = writeSnapshot(toSession(file), { full, tailBytes: TAIL_BYTES }, snap);
                if (ok)
                    snapshots.set(key, snap);
            }
            catch (err) {
                if (process.env['BLACKBOX_DEBUG']) {
                    process.stderr.write(`[snapshot] write failed: ${err instanceof Error ? err.stack : String(err)}\n`);
                }
            }
        });
    };
    const sourceFor = (file, full = false) => {
        const key = full ? `${file}#full` : file;
        if (key === opts.file)
            return primary;
        const hit = sources.get(key);
        if (hit)
            return hit;
        const made = openSessionSource(file, opts.follow === true, full ? { full: true } : {});
        sources.set(key, made);
        return made;
    };
    const basePath = normalizeBase(opts.basePath);
    /** 非 DSH 会话的标题缓存（文件头首条用户消息，按 mtime 失效） */
    const titleMemo = new Map();
    const titleFor = (s) => {
        if (s.runtime === 'dsh')
            return displayTitle(s.sessionId) ?? null;
        const hit = titleMemo.get(s.file);
        if (hit && hit.mtime === s.mtime)
            return hit.title;
        let title = null;
        try {
            const head = readSessionHead(s);
            if (head?.goal)
                title = head.goal.slice(0, 60);
        }
        catch {
            title = null;
        }
        titleMemo.set(s.file, { mtime: s.mtime, title });
        return title;
    };
    /** /api/sessions 的短缓存：切换器每次打开都会拉，避免反复扫盘 */
    let sessionsCache = null;
    const SESSIONS_TTL = 3000;
    const sessionsList = () => {
        if (sessionsCache !== null && Date.now() - sessionsCache.at < SESSIONS_TTL)
            return sessionsCache.rows;
        const rows = discoverAll()
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 300)
            .map((s) => {
            const parts = s.file.split('/');
            const idx = parts.findIndex((p) => p === 'sessions' || p === 'projects');
            const seg = idx >= 0 ? parts[idx + 1] : undefined;
            // codex 的目录是 sessions/YYYY/MM/DD/rollout…，按年份分组没意义 → 统一归到 Codex
            const project = s.runtime === 'codex'
                ? 'Codex'
                : seg
                    ? (seg.replace(/^--|--$/g, '').split('-').pop() ?? '')
                    : '';
            return {
                file: s.file,
                sessionId: s.sessionId,
                runtime: s.runtime,
                project,
                title: titleFor(s),
                mtime: s.mtime,
                size: s.size,
            };
        });
        sessionsCache = { at: Date.now(), rows };
        return rows;
    };
    const handle = (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let path = url.pathname;
        // 挂载前缀（插件里是 /blackbox）：剥掉前缀后，路由表与独立运行时完全一致。
        // 两种都容忍：请求带前缀（DSH 原样转发时）与已被宿主剥掉前缀（转发前处理时）。
        if (basePath !== '' && path.startsWith(basePath)) {
            path = path.slice(basePath.length);
            if (path === '')
                path = '/';
        }
        try {
            const staticFile = STATIC[path] ?? fallbackStatic(path);
            if (staticFile) {
                const abs = `${WEB_ROOT}${staticFile.file}`;
                if (!existsSync(abs)) {
                    res.writeHead(404).end('web asset missing');
                    return;
                }
                const body = readFileSync(abs);
                res.writeHead(200, {
                    'content-type': staticFile.type,
                    'cache-control': 'no-store',
                    'content-length': body.byteLength,
                });
                res.end(body);
                return;
            }
            // `?file=`：同一个服务可以查看任意会话（总览页点一行就跳过来）
            // `?full=1`：大会话默认只读尾部，用户显式要求时才全量加载
            const fileParam = url.searchParams.get('file');
            const activeFile = fileParam && allowedFile(fileParam) ? fileParam : opts.file;
            const full = url.searchParams.get('full') === '1';
            const source = sourceFor(activeFile, full);
            const ix = source.reload();
            if (!source.loading)
                maybeWriteSnapshot(ix, activeFile, full, source);
            switch (path) {
                case '/api/compare': {
                    const left = url.searchParams.get('left');
                    const right = url.searchParams.get('right');
                    if (!left || !right) {
                        json(res, { error: '需要 left 与 right 两个会话文件' }, 400);
                        return;
                    }
                    if (!allowedFile(left) || !allowedFile(right)) {
                        json(res, { error: '只允许读取已知会话目录下的文件' }, 403);
                        return;
                    }
                    compareAsync(left, right)
                        .then((result) => json(res, result))
                        .catch((err) => json(res, { error: err instanceof Error ? err.message : String(err) }, 500));
                    return;
                }
                case '/api/overview': {
                    // 永远不等计算：有快照立刻返回，没有就返回 loading（客户端显示骨架）
                    const snap = overviewSnapshot();
                    if (snap.result) {
                        json(res, { ...snap.result, loading: snap.loading, staleMs: Date.now() - snap.at });
                    }
                    else {
                        json(res, {
                            loading: true,
                            rows: [],
                            discovered: 0,
                            scanned: 0,
                            skippedLarge: 0,
                            currency: 'USD',
                            pricingNote: '',
                            unpricedModels: [],
                            totals: { tokens: { in: 0, out: 0, cached: 0 }, cost: 0 },
                            ...(snap.error ? { error: snap.error } : {}),
                        });
                    }
                    return;
                }
                case '/api/sessions': {
                    json(res, { sessions: sessionsList() });
                    return;
                }
                case '/api/health': {
                    json(res, { ok: true });
                    return;
                }
                case '/api/meta': {
                    // 标题优先级：事件日志里的"标题"检查点（权威）→ 文件头 → 投影缓存
                    const cacheTitle = displayTitle(sessionIdFromFile(activeFile)) ?? null;
                    const headTitle = source.head?.title ?? null;
                    /**
                     * 标题优先级：
                     *   · 完整加载：事件日志最后一条"标题"（权威）→ 投影缓存 → 文件头
                     *   · 部分加载：投影缓存（DSH 维护的当前值）→ 尾部事件 → 文件头
                     *     （文件头里通常是最早的兜底标题，用户改名后的标题在缓存/中段，不能反过来）
                     */
                    const pickTitle = (eventTitle) => source.partial ? cacheTitle || eventTitle || headTitle : eventTitle || cacheTitle || headTitle;
                    // 索引还没好，但有快照：先把首屏数据给出去（loading=true 让前端知道还要补）
                    if (source.loading) {
                        const snap = snapshotFor(activeFile, full, source);
                        if (snap) {
                            const snapTitle = typeof snap.meta['title'] === 'string' ? snap.meta['title'] : null;
                            json(res, {
                                ...snap.meta,
                                title: pickTitle(snapTitle),
                                loading: true,
                                snapshot: true,
                                native: true,
                            });
                            return;
                        }
                    }
                    const respond = () => {
                        const meta = metaOf(ix, source.follow, {
                            runtime: runtimeOf(activeFile),
                            partial: source.partial,
                            loading: source.loading,
                            cached: source.cached === true,
                        });
                        const eventTitle = typeof meta['title'] === 'string' ? meta['title'] : null;
                        const eventGoal = typeof meta['goal'] === 'string' ? meta['goal'] : null;
                        json(res, {
                            ...meta,
                            title: pickTitle(eventTitle),
                            goal: eventGoal || source.head?.goal || null,
                            native: source.native,
                        });
                    };
                    // 构建中：先挂住这个请求（长轮询），就绪立刻返回 ——
                    // 客户端不必按固定间隔轮询，省掉最多一个轮询周期的延迟。
                    if (source.loading && typeof source.whenReady === 'function') {
                        if (process.env['BLACKBOX_DEBUG']) {
                            process.stderr.write(`[snap] long-poll wait ${String(activeFile).slice(-40)}\n`);
                        }
                        void source
                            .whenReady()
                            .then(() => {
                            const readyIx = source.reload();
                            // 索引刚就绪：落一份首屏快照，供下次冷启动使用
                            maybeWriteSnapshot(readyIx, activeFile, full, source);
                            {
                                const meta = metaOf(readyIx, source.follow, {
                                    runtime: runtimeOf(activeFile),
                                    partial: source.partial,
                                    loading: source.loading,
                                    cached: source.cached === true,
                                });
                                const eventTitle = typeof meta['title'] === 'string' ? meta['title'] : null;
                                const eventGoal = typeof meta['goal'] === 'string' ? meta['goal'] : null;
                                json(res, {
                                    ...meta,
                                    title: pickTitle(eventTitle),
                                    goal: eventGoal || source.head?.goal || null,
                                    native: source.native,
                                });
                            }
                        })
                            .catch(() => respond());
                        return;
                    }
                    respond();
                    return;
                }
                case '/api/live': {
                    if (source.loading) {
                        const snap = snapshotFor(activeFile, full, source);
                        if (snap) {
                            json(res, {
                                eventCount: snap.meta['eventCount'] ?? 0,
                                duration: snap.duration,
                                checkpoints: snap.meta['checkpointCount'] ?? 0,
                                follow: source.follow,
                                loading: true,
                                extended: false,
                                snapshot: true,
                            });
                            return;
                        }
                    }
                    json(res, {
                        eventCount: ix.events.length,
                        duration: ix.duration,
                        checkpoints: ix.checkpoints.length,
                        follow: source.follow,
                        loading: source.loading,
                        extended: ix.extended,
                    });
                    return;
                }
                case '/api/state': {
                    const raw = url.searchParams.get('t');
                    const t = raw === null || raw === '' ? ix.duration : Number(raw);
                    if (!Number.isFinite(t)) {
                        json(res, { error: 'invalid t' }, 400);
                        return;
                    }
                    if (source.loading) {
                        const snap = snapshotFor(activeFile, full, source);
                        if (snap && Math.abs(t - snap.duration) <= 1) {
                            json(res, snap.state);
                            return;
                        }
                    }
                    const state = seek(ix, t);
                    json(res, { state, attribution: attribution(state, state.t) });
                    return;
                }
                case '/api/spans': {
                    const from = Number(url.searchParams.get('from') ?? '0') || 0;
                    const to = Number(url.searchParams.get('to') ?? String(ix.duration));
                    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') ?? '1500')));
                    if (source.loading) {
                        const snap = snapshotFor(activeFile, full, source);
                        if (snap && from <= 0 && to >= snap.duration && limit <= snap.query.spanLimit) {
                            json(res, snap.spans);
                            return;
                        }
                    }
                    const spans = ix.spans.filter((s) => s.start >= from && s.start <= to).slice(-limit);
                    json(res, { from, to, count: spans.length, spans });
                    return;
                }
                case '/api/series': {
                    const buckets = Number(url.searchParams.get('buckets') ?? '120') || 120;
                    if (source.loading) {
                        const snap = snapshotFor(activeFile, full, source);
                        if (snap && buckets === snap.query.buckets) {
                            json(res, snap.series);
                            return;
                        }
                    }
                    json(res, { buckets: seriesOf(ix, buckets) });
                    return;
                }
                case '/api/events': {
                    const from = Number(url.searchParams.get('from') ?? '0');
                    const to = Number(url.searchParams.get('to') ?? String(ix.duration));
                    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') ?? '200')));
                    if (source.loading) {
                        const snap = snapshotFor(activeFile, full, source);
                        if (snap && from <= 0 && to >= snap.duration - 1 && limit <= snap.query.eventLimit) {
                            json(res, {
                                from: 0,
                                to: snap.duration,
                                count: snap.events.count,
                                events: snap.events.events.slice(-limit),
                                snapshot: true,
                            });
                            return;
                        }
                    }
                    const events = slice(ix, Number.isFinite(from) ? from : 0, Number.isFinite(to) ? to : ix.duration);
                    const tail = events.slice(-limit);
                    json(res, { from, to, count: events.length, events: tail });
                    return;
                }
                case '/api/stats': {
                    json(res, buildStatsReport(ix, opts.file));
                    return;
                }
                default: {
                    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end('not found');
                }
            }
        }
        catch (err) {
            json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
        }
    };
    return {
        handle,
        reload: () => primary.reload(),
        file: opts.file,
        follow: opts.follow === true,
    };
}
export async function startServer(opts) {
    warmOverview();
    const router = createRouter({ file: opts.file, ...(opts.follow === true ? { follow: true } : {}) });
    const host = opts.host ?? '127.0.0.1';
    const basePort = opts.port ?? 7077;
    const server = createServer(router.handle);
    let port = basePort;
    const listen = () => new Promise((resolvePromise, rejectPromise) => {
        const onError = (err) => {
            server.removeListener('listening', onListening);
            if (err.code === 'EADDRINUSE' && port - basePort < 20) {
                port++;
                listen().then(resolvePromise, rejectPromise);
                return;
            }
            rejectPromise(err);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolvePromise(port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
    const actualPort = await listen();
    const url = `http://${host}:${actualPort}`;
    return {
        url,
        port: actualPort,
        file: opts.file,
        index: () => router.reload(),
        close: async () => {
            await new Promise((resolvePromise) => server.close(() => resolvePromise()));
        },
    };
}
/** 尽力打开系统浏览器（失败不影响服务）。 */
export function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { });
        child.unref();
    }
    catch {
        /* 无 GUI 环境就只打印 URL */
    }
}
export function describeServer(server, ix) {
    return `${server.url}  ·  ${ix.events.length} 事件 / ${fmtDur(ix.duration)}  ${server.file}`;
}
