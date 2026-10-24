/**
 * 总览的"非阻塞"外壳
 * ==================
 *
 * 三条规矩：
 *   1. **请求永远不等计算** —— 有快照就立刻返回，没有就返回 `loading: true`；
 *   2. **计算在 worker 里** —— 不阻塞主线程（否则 DSH 整个 HTTP 服务会被卡住）；
 *   3. **同一时刻只算一次** —— 多个请求/多个页面不会把 CPU 打满。
 *
 * 结果按"多久算旧"判定：默认 20 秒内直接复用；过期后返回旧值并后台刷新
 * （stale-while-revalidate），用户永远看不到等待。
 */
import { Worker } from 'node:worker_threads';
import { computeOverview } from "./overview.js";
import { computeCompare } from "./compare.js";
import { loadPricing } from "./pricing.js";
const STALE_MS = 20_000;
/**
 * worker 入口的扩展名取决于运行形态：
 *   · 仓库内开发：Node 直接跑 `.ts`
 *   · 发布包：跑 `dist/*.js`
 * 这个路径是 new URL 的字符串参数，tsc 的 `rewriteRelativeImportExtensions`
 * **不会**重写它 —— 必须自己判断，否则发布版会去找不存在的 .ts worker。
 */
const WORKER_FILE = import.meta.url.endsWith('.js') ? './overview-worker.js' : './overview-worker.ts';
const WORKER_URL = new URL(WORKER_FILE, import.meta.url);
let snapshot = { result: null, loading: false, at: 0 };
let worker = null;
let seq = 0;
let inflight = false;
let idleTimer = null;
const pending = new Map();
function ensureWorker() {
    if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (worker)
        return worker;
    try {
        worker = new Worker(WORKER_URL);
        worker.unref();
        worker.on('message', (msg) => {
            const done = pending.get(msg.id);
            pending.delete(msg.id);
            done?.(msg);
        });
        worker.on('error', () => {
            worker = null;
            inflight = false;
            // worker 挂了就退回主线程算 —— 慢，但至少能出结果
            fallback();
        });
        worker.on('exit', () => {
            worker = null;
        });
        return worker;
    }
    catch {
        worker = null;
        return null;
    }
}
function fallback() {
    if (inflight)
        return;
    inflight = true;
    setTimeout(() => {
        try {
            const result = computeOverview(loadPricing(), { limit: 200 });
            snapshot = { result, loading: false, at: Date.now() };
        }
        catch (err) {
            snapshot = { ...snapshot, loading: false, error: err instanceof Error ? err.message : String(err) };
        }
        finally {
            inflight = false;
        }
    }, 10);
}
export function refreshOverview(limit = 200) {
    if (inflight)
        return;
    inflight = true;
    snapshot = { ...snapshot, loading: true };
    const w = ensureWorker();
    if (!w) {
        inflight = false;
        fallback();
        return;
    }
    const id = ++seq;
    pending.set(id, (msg) => {
        inflight = false;
        if (msg.ok && msg.result) {
            snapshot = { result: msg.result, loading: false, at: Date.now() };
        }
        else {
            snapshot = { ...snapshot, loading: false, ...(msg.error ? { error: msg.error } : {}) };
        }
        scheduleWorkerIdle();
    });
    w.postMessage({ id, limit, useCache: true });
}
/** 算完空闲 10 秒就回收 worker：不占资源，也不会让宿主进程"有事可做"地挂着 */
function scheduleWorkerIdle() {
    if (idleTimer !== null)
        clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        idleTimer = null;
        worker?.terminate();
        worker = null;
    }, 10_000);
    idleTimer.unref?.();
}
/**
 * 跨会话对比：同样放到 worker 里。
 * 两个大会话的统计加起来可能好几秒，绝不能占主线程。
 */
/** 主线程的对比结果短缓存：页面切换/重复请求不必再进 worker */
const compareMemo = new Map();
const COMPARE_MEMO_MS = 15_000;
const COMPARE_MEMO_LIMIT = 12;
export function compareAsync(left, right) {
    const memoKey = `${left}|${right}`;
    const hit = compareMemo.get(memoKey);
    if (hit && Date.now() - hit.at < COMPARE_MEMO_MS)
        return Promise.resolve(hit.result);
    return new Promise((resolve, reject) => {
        // 对比用**一次性 worker**：不和常驻的总览 worker 排队。
        // （总览刷新可能占用 worker 好几秒，排队会让对比"莫名很慢"）
        let worker;
        try {
            worker = new Worker(WORKER_URL);
        }
        catch {
            setTimeout(() => {
                try {
                    resolve(computeCompare({ left, right }));
                }
                catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            }, 10);
            return;
        }
        let settled = false;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            worker.terminate();
            fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error('对比超时（120s）'))), 120_000);
        timer.unref?.();
        worker.on('message', (msg) => {
            finish(() => {
                if (msg.ok && msg.result) {
                    compareMemo.set(memoKey, { at: Date.now(), result: msg.result });
                    if (compareMemo.size > COMPARE_MEMO_LIMIT) {
                        const first = compareMemo.keys().next().value;
                        if (first !== undefined)
                            compareMemo.delete(first);
                    }
                    resolve(msg.result);
                }
                else {
                    reject(new Error(msg.error ?? '对比失败'));
                }
            });
        });
        worker.on('error', (err) => finish(() => reject(err)));
        worker.postMessage({ id: 1, kind: 'compare', left, right });
    });
}
/** 显式回收（测试 / 关闭时用） */
export function disposeOverview() {
    if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    worker?.terminate();
    worker = null;
    inflight = false;
    pending.clear();
}
/** 读快照：新鲜就直接给；过期则返回旧值 + 触发后台刷新 */
export function overviewSnapshot() {
    const age = Date.now() - snapshot.at;
    if (snapshot.result === null || age > STALE_MS)
        refreshOverview();
    return snapshot;
}
/** 服务启动后预热一次，用户第一次打开总览页就是热的 */
export function warmOverview() {
    setTimeout(() => refreshOverview(), 1500);
}
