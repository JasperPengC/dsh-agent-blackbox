/**
 * 总览计算 worker
 * ===============
 *
 * 为什么需要它：`computeOverview()` 要扫几十个会话，本机实测冷启动 2.5 秒。
 * 它跑在主线程时，这 2.5 秒里 **DSH 的整个 HTTP 服务都是停的** —— 页面上所有
 * 请求（包括 DSH 自己）一起卡住。这就是"感觉卡"的根因。
 *
 * worker 里的同步代码不阻塞主线程；主线程只负责收结果。
 * 注意：worker 也是 Node，同样能直接加载 `.ts`（类型擦除对进程内文件生效）。
 */
import { parentPort } from 'node:worker_threads';
import { computeOverview } from "./overview.js";
import { computeCompare } from "./compare.js";
import { loadPricing } from "./pricing.js";
parentPort?.on('message', (msg) => {
    try {
        const result = msg.kind === 'compare'
            ? computeCompare({ left: msg.left, right: msg.right })
            : computeOverview(loadPricing(), {
                ...(msg.limit !== undefined ? { limit: msg.limit } : {}),
                ...(msg.runtime !== undefined ? { runtime: msg.runtime } : {}),
                useCache: msg.useCache !== false,
            });
        parentPort?.postMessage({ id: msg.id, ok: true, result });
    }
    catch (err) {
        parentPort?.postMessage({
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
