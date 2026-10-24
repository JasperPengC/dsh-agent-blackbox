/**
 * 会话解码 worker
 * ===============
 *
 * 大文件首次打开时，zstd 解码 + 适配器映射可能占用主线程 1 秒以上。
 * 放到 worker 里后，主线程只等结果 —— 页面保持可交互（骨架 + 进度感）。
 */
import { parentPort } from 'node:worker_threads';
import { getSessionEvents } from "./session-source.js";
import { discoverAll } from "./sources.js";
parentPort?.on('message', (msg) => {
    try {
        const session = discoverAll().find((s) => s.file === msg.file);
        if (!session)
            throw new Error(`找不到会话：${msg.file}`);
        const { events, cached } = getSessionEvents(session, msg.full === true);
        parentPort?.postMessage({ id: msg.id, ok: true, events, cached });
    }
    catch (err) {
        parentPort?.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
});
