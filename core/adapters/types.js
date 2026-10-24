/**
 * 适配器契约
 * ==========
 *
 * 整个项目只有这一层知道"上游某个 runtime 的日志长什么样"。
 * 上游改格式时，**只改一个文件**，内核、投影、UI 全都不用动。
 *
 * 三条硬约束：
 *   1. **只读不改**：适配器消费字节，绝不修改原始日志；
 *   2. **不丢数据**：看不懂的行一律 emit 成 `raw`，宁可不懂也不能让证据消失；
 *   3. **不做推断**：适配器不猜"用户意图"，只做格式翻译。语义归约交给 projector。
 *
 * 新增一个 runtime 的适配器，标准工作量约 80 行（见 claude.ts）。
 */
/** 安全解析一行 JSON，失败返回 undefined（绝不抛）。 */
export function parseJsonLine(line) {
    const trimmed = line.trim();
    if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '['))
        return undefined;
    try {
        const v = JSON.parse(trimmed);
        if (typeof v !== 'object' || v === null || Array.isArray(v))
            return undefined;
        return v;
    }
    catch {
        return undefined;
    }
}
/** 把一行落成 raw 事件（不丢证据）。 */
export function emitRaw(emit, line, stream = 'line') {
    const text = line.replace(/\r$/, '');
    if (text.trim() === '')
        return;
    emit({ kind: 'raw', data: { stream, line: text.length > 4000 ? text.slice(0, 4000) : text } });
}
