/**
 * 适配器注册表 + 自动识别
 *
 * 新增一个 runtime：
 *   1. 在本目录加 `xxx.ts`，实现 `Adapter`（约 80 行）；
 *   2. 在下面的 ADAPTERS 里注册；
 *   3. 用真实日志补一条 fixture 回归测试。
 * 内核、投影器、UI 一行都不用改 —— 这是分层的目的。
 */
import { acpAdapter } from "./acp.js";
import { claudeAdapter } from "./claude.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexSessionAdapter } from "./codex-session.js";
import { codexAdapter } from "./codex.js";
import { dshAdapter } from "./dsh.js";
import { rawAdapter } from "./raw.js";
export { emitRaw, parseJsonLine } from "./types.js";
export const ADAPTERS = [
    dshAdapter,
    claudeCodeAdapter,
    codexSessionAdapter,
    claudeAdapter,
    acpAdapter,
    codexAdapter,
    rawAdapter,
];
export function getAdapter(id) {
    return ADAPTERS.find((a) => a.id === id);
}
export function adapterIds() {
    return ADAPTERS.map((a) => a.id);
}
/**
 * 从样本行里猜适配器。
 *
 * 判据 = **最高单行置信度 × 覆盖率系数**：
 *   score = maxLineScore × (0.5 + 0.5 × matchedLines / consideredLines)
 *
 * 为什么不是简单的"平均分"：像 DSH 这种日志，只有少数几行类型是强特征
 * （session / turn / step），大量行是工具与内部遥测。按平均值算会被稀释成 0.25，
 * 反而输给"每行都像"的适配器 —— 这是实测踩到的误判（dsh 被识别成 raw）。
 */
export function detectAdapter(sampleLines) {
    const acc = new Map();
    for (const a of ADAPTERS)
        acc.set(a.id, { total: 0, max: 0, matched: 0 });
    let considered = 0;
    for (const line of sampleLines) {
        if (line.trim() === '')
            continue;
        considered++;
        if (considered > 60)
            break;
        for (const a of ADAPTERS) {
            if (a.id === 'raw')
                continue;
            const score = a.detect(line);
            if (score <= 0)
                continue;
            const cur = acc.get(a.id);
            cur.total += score;
            cur.matched++;
            if (score > cur.max)
                cur.max = score;
        }
    }
    const denom = Math.max(1, Math.min(considered, 60));
    const scores = [...acc.entries()]
        .map(([id, a]) => {
        const coverage = a.matched / denom;
        const score = a.max * (0.5 + 0.5 * coverage);
        return { id, score: Number(score.toFixed(3)) };
    })
        .sort((x, y) => y.score - x.score);
    const top = scores[0];
    if (!top || top.score < 0.5)
        return { id: 'raw', score: 0, scores };
    return { id: top.id, score: top.score, scores };
}
