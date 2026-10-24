/**
 * raw 适配器 —— 兜底，不做任何解码
 *
 * 存在意义：**任何 agent 的输出都能被录下来**。哪怕今天没有对应适配器，
 * 明天再补一个离线转换脚本也不迟 —— 黑匣子先得在飞机上。
 *
 * 状态：fallback。
 */
import { emitRaw, parseJsonLine } from "./types.js";
export const rawAdapter = {
    id: 'raw',
    label: '原始行（不解码）',
    status: 'fallback',
    note: '把每行 stdout/stderr 原样存成 raw 事件，保证不丢证据；后续可用脚本离线转换',
    detect() {
        return 0;
    },
    create(_ctx, emit) {
        return {
            onLine(line) {
                // 看起来像 JSON 的也原样保留，只是标个 stream，方便事后挑出来
                emitRaw(emit, line, parseJsonLine(line) ? 'json' : 'line');
            },
        };
    },
};
