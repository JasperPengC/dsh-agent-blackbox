/**
 * 跨会话对比
 * ==========
 *
 * 回答的问题只有一个：**"为什么这个任务比那个贵/慢一倍？"**
 *
 * 所以对比的不是"谁的数字大"，而是**结构差异**：
 *   · 时长多了 3 倍，是工具调用多了，还是单次调用变慢了？
 *   · token 多了，是缓存命中差（重读上下文），还是输出变长（想太多）？
 *   · 阻塞时间差多少 —— 是不是有一边一直在等另一个 agent？
 *
 * 每个指标都给出 Δ 和百分比，前端只负责画。
 */
import { getAdapter } from "./adapters/index.js";
import { estimateCost, loadPricing } from "./pricing.js";
import { discoverAll, summarizeSession } from "./sources.js";
import { loadCache, saveCache } from "./overview.js";
/**
 * 取统计结果，优先复用**总览缓存**。
 *
 * 为什么重要：对比页一打开就要两份统计，而服务器已经为总览扫过一遍了。
 * 命中缓存时对比是**毫秒级**；否则要重新解析（最大 45MB 的会话要 4 秒）。
 * 缓存的 key 是文件路径 + (size, mtime)，文件变了自然失效。
 */
const summaryCache = new Map();
const CACHE_LIMIT = 24;
let diskCache = null;
let diskCacheDirty = false;
function entryToSummary(session, entry) {
    return {
        session,
        events: entry.events,
        toolCalls: entry.toolCalls,
        toolFails: entry.toolFails,
        tools: entry.tools ?? {},
        tokens: entry.tokens,
        byModel: entry.tokensByModel ?? {},
        models: entry.models,
        durationMs: entry.durationMs,
        blockedMs: entry.blockedMs ?? 0,
        checkpoints: entry.checkpoints ?? 0,
        goal: entry.goal ?? '',
    };
}
function cachedSummary(session) {
    const hit = summaryCache.get(session.file);
    if (hit && hit.size === session.size && hit.mtime === session.mtime)
        return hit.summary;
    // 1) 总览缓存：mtime 相同 或 扫描没过 60 秒（活会话一直变，不能死等 mtime）
    if (diskCache === null)
        diskCache = loadCache();
    const entry = diskCache[session.file];
    const STALE_REUSE_MS = 60_000;
    const exact = entry !== undefined && entry.size === session.size && entry.mtime === session.mtime;
    const acceptableStale = entry !== undefined &&
        typeof entry.scannedAt === 'number' &&
        Date.now() - entry.scannedAt < STALE_REUSE_MS;
    if (entry && (exact || acceptableStale)) {
        const summary = entryToSummary(session, entry);
        summaryCache.set(session.file, { size: session.size, mtime: session.mtime, summary });
        return summary;
    }
    // 2) 真的解析一次，并写回缓存（下次总览和对比都受益）
    const adapter = getAdapter(session.adapter);
    if (!adapter)
        return undefined;
    const summary = summarizeSession(session, adapter);
    if (!summary)
        return undefined;
    summaryCache.set(session.file, { size: session.size, mtime: session.mtime, summary });
    if (summaryCache.size > CACHE_LIMIT) {
        const first = summaryCache.keys().next().value;
        if (first !== undefined)
            summaryCache.delete(first);
    }
    diskCache[session.file] = {
        scannedAt: Date.now(),
        size: session.size,
        mtime: session.mtime,
        events: summary.events,
        toolCalls: summary.toolCalls,
        toolFails: summary.toolFails,
        tokens: summary.tokens,
        durationMs: summary.durationMs,
        models: summary.models,
        tokensByModel: summary.byModel,
        tools: summary.tools,
        blockedMs: summary.blockedMs,
        checkpoints: summary.checkpoints,
        goal: summary.goal,
        ...(summary.title ? { title: summary.title } : {}),
    };
    diskCacheDirty = true;
    return summary;
}
function cardOf(summary, pricing, unpriced) {
    let cost = 0;
    let missingPrice = false;
    for (const [model, tokens] of Object.entries(summary.byModel)) {
        const r = estimateCost(pricing, model, tokens);
        if (r.missing) {
            missingPrice = true;
            unpriced.add(model);
        }
        else {
            cost += r.cost ?? 0;
        }
    }
    const totalIn = summary.tokens.in + summary.tokens.cached;
    const card = {
        file: summary.session.file,
        runtime: summary.session.runtime,
        sessionId: summary.session.sessionId,
        project: summary.session.project,
        goal: summary.goal,
        mtime: summary.session.mtime,
        durationMs: summary.durationMs,
        events: summary.events,
        toolCalls: summary.toolCalls,
        toolFails: summary.toolFails,
        tokens: summary.tokens,
        missingPrice,
        blockedMs: summary.blockedMs,
        checkpoints: summary.checkpoints,
        models: summary.models,
        cacheHitRate: totalIn > 0 ? Math.round((summary.tokens.cached / totalIn) * 100) : 0,
    };
    if (!missingPrice)
        card.cost = cost;
    return card;
}
function delta(left, right) {
    const abs = right - left;
    const pct = left === 0 ? (right === 0 ? 0 : null) : (abs / left) * 100;
    return { left, right, abs, pct };
}
export function computeCompare(opts) {
    const pricing = loadPricing();
    const all = discoverAll();
    const find = (file) => all.find((s) => s.file === file);
    const leftSession = find(opts.left);
    const rightSession = find(opts.right);
    if (!leftSession)
        throw new Error(`找不到会话：${opts.left}`);
    if (!rightSession)
        throw new Error(`找不到会话：${opts.right}`);
    const leftSummary = cachedSummary(leftSession);
    const rightSummary = cachedSummary(rightSession);
    if (!leftSummary)
        throw new Error('无法统计左侧会话（文件过大或格式不支持）');
    if (!rightSummary)
        throw new Error('无法统计右侧会话（文件过大或格式不支持）');
    const unpriced = new Set();
    const left = cardOf(leftSummary, pricing, unpriced);
    const right = cardOf(rightSummary, pricing, unpriced);
    const deltas = {
        durationMs: delta(left.durationMs, right.durationMs),
        events: delta(left.events, right.events),
        toolCalls: delta(left.toolCalls, right.toolCalls),
        toolFails: delta(left.toolFails, right.toolFails),
        tokensIn: delta(left.tokens.in, right.tokens.in),
        tokensOut: delta(left.tokens.out, right.tokens.out),
        tokensCached: delta(left.tokens.cached, right.tokens.cached),
        cacheHitRate: delta(left.cacheHitRate, right.cacheHitRate),
        cost: delta(left.cost ?? 0, right.cost ?? 0),
        blockedMs: delta(left.blockedMs, right.blockedMs),
        checkpoints: delta(left.checkpoints, right.checkpoints),
    };
    const tools = compareTools(leftSummary.tools, rightSummary.tools);
    const leftModels = new Set(left.models);
    const rightModels = new Set(right.models);
    const shared = [...leftModels].filter((m) => rightModels.has(m));
    if (diskCacheDirty && diskCache !== null) {
        try {
            saveCache({ ...loadCache(), ...diskCache });
            diskCacheDirty = false;
        }
        catch {
            /* 缓存写失败不影响结果 */
        }
    }
    return {
        currency: pricing.displayCurrency,
        left,
        right,
        deltas,
        tools,
        models: { left: left.models, right: right.models, shared },
        unpricedModels: [...unpriced],
    };
}
/** 合并两侧工具分布，按"总调用次数"倒序 —— 差异最大的排前面 */
function compareTools(leftTools, rightTools) {
    const zero = { calls: 0, fails: 0, ms: 0 };
    const names = new Set([...Object.keys(leftTools), ...Object.keys(rightTools)]);
    return [...names]
        .map((tool) => ({ tool, left: leftTools[tool] ?? zero, right: rightTools[tool] ?? zero }))
        .sort((a, b) => b.left.calls + b.right.calls - (a.left.calls + a.right.calls));
}
