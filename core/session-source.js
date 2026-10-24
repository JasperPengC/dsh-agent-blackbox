/**
 * 会话数据源 —— 把"文件"变成"可查询的索引"
 * ==========================================
 *
 * 两种来源：
 *   1. **本项目录制的 NDJSON**：直接解析；
 *   2. **原生会话**（DSH .zstd / Claude Code .jsonl / Codex .jsonl）：
 *      用对应适配器增量解码成事件，再建索引。
 *
 * 有了这一层，`blackbox ui <任意会话文件>`、总览页点击跳转、以及将来
 * 的 DSH 插件面板，都走同一条路径 —— 不需要为每种来源各写一套。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getAdapter } from "./adapters/index.js";
import { NdjsonTail } from "./ndjson.js";
import { buildIndex, extendIndex } from "./projector.js";
import { createReader, discoverAll } from "./sources.js";
import { readEvents, writeEvents } from "./event-cache.js";
import { readSessionHead } from "./session-head.js";
/** 大会话默认只加载尾部：首次打开从 4 秒降到亚秒，且不阻塞别人 */
export const FULL_LOAD_LIMIT = 24 * 1024 * 1024;
export const TAIL_BYTES = 8 * 1024 * 1024;
/** 录制出来的 NDJSON：直接增量解析 */
function ndjsonSource(file, follow) {
    const tail = new NdjsonTail(file);
    let ix = buildIndex([], { file });
    let primed = false;
    return {
        file,
        follow,
        native: false,
        partial: false,
        loading: false,
        reload() {
            if (!primed) {
                ix = buildIndex(tail.prime().events, { file });
                primed = true;
                return ix;
            }
            if (!follow)
                return ix;
            const res = tail.poll();
            if (res.events.length > 0)
                ix = extendIndex(ix, res.events);
            return ix;
        },
    };
}
/** 原生会话：适配器 + 增量 reader + 索引 */
/**
 * 把一个原生会话解码成事件序列。
 *
 * 这是**最慢的一步**（zstd 解码 + JSON.parse + 适配器映射），
 * 大文件上可能占满主线程 1 秒以上。所以它被设计成独立函数：
 *   · 服务端启动 worker 时在 worker 里跑（不阻塞主线程）
 *   · worker 不可用时退回主线程同步跑（慢，但能用）
 */
export function decodeSessionEvents(session, full = false, depth = 0) {
    const adapter = getAdapter(session.adapter);
    if (!adapter)
        throw new Error(`找不到适配器：${session.adapter}`);
    const events = [];
    let seq = 0;
    let lastT = 0;
    let baseT = null;
    const partial = !full && session.size > FULL_LOAD_LIMIT;
    const from = partial ? Math.max(0, session.size - TAIL_BYTES) : 0;
    const reader = createReader(session, from);
    const emit = (d) => {
        let t = typeof d.t === 'number' ? Math.max(0, Math.round(d.t)) : lastT;
        if (partial) {
            if (baseT === null)
                baseT = t;
            t -= baseT;
        }
        lastT = Math.max(lastT, t);
        const e = {
            v: 1,
            seq: seq++,
            t,
            run: session.sessionId,
            session: d.session ?? session.sessionId,
            agent: d.agent ?? 'agent',
            kind: d.kind,
            data: d.data ?? {},
        };
        if (d.call)
            e.call = d.call;
        events.push(e);
    };
    const instance = adapter.create({ session: session.sessionId, agent: 'agent', runtime: session.runtime }, emit);
    const lines = reader.poll();
    for (const line of lines)
        instance.onLine(line);
    if (!full)
        instance.onEnd?.('done');
    // DSH 的子 agent 是**独立会话目录**（<project>/<childId>/session.v4.jsonl.zstd），
    // 父会话里只有 subagent/catalog 事件。这里把它们合并成多 agent 执行流。
    if (depth === 0 && session.runtime === 'dsh')
        return mergeSubagentSessions(session, events);
    return events;
}
/** 子会话保留的事件类型（丢弃子会话自己的 run/session 生命周期，避免污染父状态） */
const CHILD_KEEP = new Set([
    'tool.call',
    'tool.result',
    'think',
    'message.agent',
    'message.user',
    'status',
    'usage',
    'file.edit',
    'checkpoint',
    'error',
]);
/** 在项目目录里找子会话文件（DSH 用裸 uuid 作为目录名） */
function findChildSessionFile(parentFile, childId) {
    const projectDir = dirname(dirname(parentFile));
    const childDir = join(projectDir, childId);
    for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']) {
        const file = join(childDir, name);
        if (existsSync(file))
            return file;
    }
    return undefined;
}
/**
 * 把 subagent/catalog 指向的子会话事件合并进父事件流：
 *   · 时间轴对齐：子事件 t = 子会话内相对时间 + (子会话 createdAt - 父会话 createdAt)
 *   · agent 名字用 catalog 里的 label（重复时追加序号）
 *   · 只保留工具/消息/状态/用量等事件，丢弃子会话的 run.start 等
 */
function mergeSubagentSessions(parent, events) {
    const catalogs = events.filter((e) => e.kind === 'subagent');
    if (catalogs.length === 0)
        return events;
    const parentHead = readSessionHead(parent);
    const parentT0 = parentHead?.startedAt ?? 0;
    const run = events[0]?.run ?? parent.sessionId;
    const extra = [];
    const seen = new Set();
    const names = new Map();
    let merged = 0;
    for (const ev of catalogs) {
        if (merged >= 8)
            break;
        const childId = String(ev.data['childId'] ?? '');
        if (childId === '' || seen.has(childId))
            continue;
        seen.add(childId);
        const childFile = findChildSessionFile(parent.file, childId);
        if (!childFile)
            continue;
        let childEvents;
        try {
            const stat = statSync(childFile);
            const childSession = {
                runtime: 'dsh',
                adapter: 'dsh',
                sessionId: `session-${childId}`,
                project: parent.project,
                file: childFile,
                format: childFile.endsWith('.zstd') ? 'zstd-jsonl' : 'jsonl',
                size: stat.size,
                mtime: stat.mtimeMs,
            };
            childEvents = decodeSessionEvents(childSession, true, 1);
        }
        catch {
            continue;
        }
        if (childEvents.length === 0)
            continue;
        const childHead = readSessionHead({
            runtime: 'dsh',
            adapter: 'dsh',
            sessionId: `session-${childId}`,
            project: parent.project,
            file: childFile,
            format: 'zstd-jsonl',
            size: 0,
            mtime: 0,
        });
        const offset = childHead?.startedAt && parentT0 ? childHead.startedAt - parentT0 : 0;
        const baseLabel = String(ev.data['label'] ?? '').trim() || childId.slice(0, 8);
        const dup = names.get(baseLabel) ?? 0;
        names.set(baseLabel, dup + 1);
        const shortLabel = baseLabel.length > 28 ? `${baseLabel.slice(0, 27)}…` : baseLabel;
        const agent = dup === 0 ? shortLabel : `${shortLabel} · ${dup + 1}`;
        for (const ce of childEvents) {
            if (!CHILD_KEEP.has(ce.kind))
                continue;
            extra.push({
                ...ce,
                t: Math.max(0, ce.t + offset),
                run,
                agent,
                session: `session-${childId}`,
            });
        }
        merged++;
    }
    if (extra.length === 0)
        return events;
    const all = [...events, ...extra].sort((a, b) => a.t - b.t || a.seq - b.seq);
    return all.map((e, i) => ({ ...e, seq: i }));
}
/**
 * 带磁盘缓存的入口：先看缓存，未命中再解码并回写。
 *
 * 命中时只做"读文件 + gunzip + JSON.parse"，比解码快一个数量级；
 * 而且缓存跨进程有效，服务重启后第一次打开也是热的。
 */
export function getSessionEvents(session, full = false) {
    const opts = { full, tailBytes: TAIL_BYTES };
    const hit = readEvents(session, opts);
    if (hit)
        return { events: hit.events, cached: true };
    const events = decodeSessionEvents(session, full);
    writeEvents(session, opts, events);
    return { events, cached: false };
}
/**
 * 原生会话数据源：**首帧不阻塞**。
 *
 * `reload()` 第一次被调用时先返回空索引并启动 worker；构建完成后
 * 后续请求就拿到真索引。前端靠 `meta.loading` 显示骨架并轮询。
 * （之前是在请求里同步解码，大会话会把 DSH 的整个 HTTP 服务冻住 1~2 秒。）
 */
function nativeSource(session, follow, full = false) {
    const partial = !full && session.size > FULL_LOAD_LIMIT;
    let ix = buildIndex([], { file: session.file });
    let ready = false;
    let building = false;
    let failed;
    let resolveReady = null;
    const readyPromise = new Promise((resolve) => {
        resolveReady = resolve;
    });
    let cachedHit = false;
    // 跟随模式的"文件是否增长"判断：没变就完全不做解码（live 轮询很频繁）
    let lastSize = -1;
    let lastMtime = -1;
    // 大会话只读尾部：goal/createdAt 在文件头，单独补一次（256KB pread，很便宜）
    const head = partial ? readSessionHead(session) : undefined;
    const finish = (events) => {
        try {
            ix = buildIndex(events, { file: session.file, run: session.sessionId });
            ready = true;
            resolveReady?.();
        }
        catch (err) {
            failed = err instanceof Error ? err.message : String(err);
            resolveReady?.();
        }
        finally {
            building = false;
        }
    };
    const start = () => {
        if (building || ready)
            return;
        building = true;
        void (async () => {
            try {
                const { buildInWorker } = await import("./session-worker-client.js");
                const { events, cached } = await buildInWorker(session, full);
                cachedHit = cached;
                finish(events);
            }
            catch {
                // worker 不可用：退回主线程（至少能用）
                try {
                    finish(getSessionEvents(session, full).events);
                }
                catch (err) {
                    failed = err instanceof Error ? err.message : String(err);
                    building = false;
                    resolveReady?.();
                }
            }
        })();
    };
    return {
        file: session.file,
        follow,
        native: true,
        partial,
        get loading() {
            return !ready;
        },
        get cached() {
            return cachedHit;
        },
        get head() {
            return head;
        },
        whenReady() {
            if (ready)
                return Promise.resolve();
            // 防御：还没人调用 reload() 时主动启动，避免等待一个永远不会开始的构建
            start();
            return readyPromise;
        },
        reload() {
            if (ready) {
                if (follow) {
                    // 实时模式：文件没变就直接返回（live 轮询每 ~800ms 一次，不能每次都解码）
                    let size = -1;
                    let mtime = -1;
                    try {
                        const st = statSync(session.file);
                        size = st.size;
                        mtime = st.mtimeMs;
                    }
                    catch {
                        return ix;
                    }
                    if (size === lastSize && mtime === lastMtime)
                        return ix;
                    lastSize = size;
                    lastMtime = mtime;
                    // 绕过磁盘缓存直接解码：文件每次增长都会产生新缓存键，实时会话会把缓存目录写爆
                    const next = decodeSessionEvents(session, full);
                    if (partial) {
                        // 大会话是"尾部窗口"，窗口滑动后前序事件会变化，只能重建索引
                        if (next.length !== ix.events.length)
                            ix = buildIndex(next, { file: session.file, run: session.sessionId });
                    }
                    else if (next.length > ix.events.length) {
                        ix = extendIndex(ix, next.slice(ix.events.length));
                    }
                }
                return ix;
            }
            start();
            return ix;
        },
        get error() {
            return failed;
        },
    };
}
/** 按路径打开：先看是不是原生会话，否则按 NDJSON 处理。 */
export function openSessionSource(file, follow, opts = {}) {
    if (!existsSync(file))
        throw new Error(`找不到文件：${file}`);
    const isNdjson = file.endsWith('.ndjson');
    if (!isNdjson) {
        const session = discoverAll().find((s) => s.file === file);
        if (session)
            return nativeSource(session, follow, opts.full === true);
        // 用户直接指了一个 .jsonl / .zstd，但没在已知目录里：按扩展名猜格式
        const guessed = guessSession(file);
        if (guessed)
            return nativeSource(guessed, follow, opts.full === true);
    }
    return ndjsonSource(file, follow);
}
/** 已知目录之外的文件：按扩展名与首行特征猜一个 SourceSession */
function guessSession(file) {
    try {
        const stat = statSync(file);
        const base = basename(file);
        if (file.endsWith('.zstd')) {
            return {
                runtime: 'dsh',
                adapter: 'dsh',
                sessionId: base.replace(/\.zstd$/, ''),
                project: file.replace(/\/[^/]+$/, ''),
                file,
                format: 'zstd-jsonl',
                size: stat.size,
                mtime: stat.mtimeMs,
            };
        }
        if (file.endsWith('.jsonl')) {
            const adapter = base.startsWith('rollout-') ? 'codex-session' : 'claude-code';
            return {
                runtime: adapter === 'codex-session' ? 'codex' : 'claude-code',
                adapter,
                sessionId: base.replace(/\.jsonl$/, ''),
                project: file.replace(/\/[^/]+$/, ''),
                file,
                format: 'jsonl',
                size: stat.size,
                mtime: stat.mtimeMs,
            };
        }
    }
    catch {
        /* 猜不出来就按 NDJSON */
    }
    return undefined;
}
