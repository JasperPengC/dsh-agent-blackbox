/**
 * 实时监视（live）—— 本项目的"有用"体现在这里
 * ==============================================
 *
 * DSH 把会话实时写进 `~/.dsh/sessions/<project>/session-<uuid>/session.v4.jsonl.zstd`：
 * **多帧 zstd + 追加写**。于是"实时看自己正在跑的会话"只需要三步：
 *
 *   1. 找到最新的会话文件；
 *   2. 从上次读到的偏移量继续读，按 zstd 魔数切帧，只解完整帧；
 *   3. 解码出的 JSONL 行交给适配器 → 落成事件 → 服务器 follow 模式推给页面。
 *
 * 一个关键细节：**追加写的帧可能只写了一半**。
 * 直接 `zstdDecompressSync` 会抛错 —— 这时不能推进偏移量，等下一轮再试。
 * 否则丢掉的不是一条日志，而是一整帧事件。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const SESSION_FILE = 'session.v4.jsonl.zstd';
export function sessionsRoot() {
    return process.env['DSH_SESSIONS_DIR'] ?? join(homedir(), '.dsh', 'sessions');
}
/** 列出所有会话（按最近修改时间倒序）。 */
export function discoverSessions(root = sessionsRoot()) {
    const out = [];
    if (!existsSync(root))
        return out;
    let projects;
    try {
        projects = readdirSync(root);
    }
    catch {
        return out;
    }
    for (const project of projects) {
        const projectDir = join(root, project);
        let sessions;
        try {
            sessions = readdirSync(projectDir);
        }
        catch {
            continue;
        }
        for (const sessionId of sessions) {
            const dir = join(projectDir, sessionId);
            const file = join(dir, SESSION_FILE);
            try {
                const st = statSync(file);
                out.push({
                    project: project.replace(/^--|--$/g, '').replace(/-/g, '/'),
                    sessionId,
                    dir,
                    file,
                    size: st.size,
                    mtime: st.mtimeMs,
                });
            }
            catch {
                /* 没有 session 文件的目录跳过 */
            }
        }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}
/** 按 zstd 魔数切帧，只解完整帧。 */
export function decodeFrames(buf) {
    const starts = [];
    let i = 0;
    while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
        starts.push(i);
        i += ZSTD_MAGIC.length;
    }
    if (starts.length === 0)
        return { lines: [], consumed: 0, partial: buf.length > 0 };
    let text = '';
    let consumed = starts[0] ?? 0;
    for (let k = 0; k < starts.length; k++) {
        const from = starts[k];
        const last = k + 1 >= starts.length;
        const to = last ? buf.length : starts[k + 1];
        const frame = buf.subarray(from, to);
        let chunk;
        try {
            chunk = zstdDecompressSync(frame).toString('utf8');
        }
        catch {
            // 最后一帧没写完：停在这里，偏移量不推进，等下一轮
            return { lines: splitLines(text), consumed: from, partial: true };
        }
        // 更隐蔽的情况：截断的帧**不报错**（解码器不校验尾部），但解出来的文本
        // 不会以换行结尾。DSH 按行写，所以"末尾没有 \n"就是没写完 —— 不消费它。
        if (last && !chunk.endsWith('\n')) {
            return { lines: splitLines(text), consumed: from, partial: true };
        }
        text += chunk;
        consumed = to;
    }
    return { lines: splitLines(text), consumed, partial: false };
}
function splitLines(text) {
    if (text === '')
        return [];
    const parts = text.split('\n');
    // 末尾空串说明最后一行是完整的（以 \n 结尾）
    if (parts.length > 0 && parts[parts.length - 1] === '')
        parts.pop();
    return parts.filter((l) => l.trim() !== '');
}
/**
 * 会话文件尾随器：维护字节偏移，每次 poll 只读新增部分。
 * 复杂度 O(新增字节)，与文件大小无关 —— 这是"长时间盯着看"不卡的前提。
 */
export class SessionTailer {
    #file;
    #offset = 0;
    #partial = false;
    constructor(file, from = 0) {
        this.#file = file;
        this.#offset = from;
    }
    get file() {
        return this.#file;
    }
    get offset() {
        return this.#offset;
    }
    /** 读增量。没有新数据时返回空数组（不抛）。 */
    poll() {
        let size;
        try {
            size = statSync(this.#file).size;
        }
        catch {
            return [];
        }
        if (size <= this.#offset)
            return [];
        const length = size - this.#offset;
        const buf = Buffer.allocUnsafe(length);
        let read = 0;
        try {
            const fd = openSync(this.#file, 'r');
            try {
                read = readSync(fd, buf, 0, length, this.#offset);
            }
            finally {
                closeSync(fd);
            }
        }
        catch {
            return [];
        }
        if (read <= 0)
            return [];
        const chunk = buf.subarray(0, read);
        const decoded = decodeFrames(chunk);
        this.#offset += decoded.consumed;
        this.#partial = decoded.partial;
        return decoded.lines;
    }
    get waitingForFrameTail() {
        return this.#partial;
    }
}
/** 选择要监视的会话：显式路径 / 会话 id 前缀 / 最近的会话。 */
export function pickSession(arg, root = sessionsRoot()) {
    const all = discoverSessions(root);
    if (all.length === 0)
        return { error: `没有找到任何会话：${root}`, all };
    if (arg === undefined || arg === 'latest') {
        return { session: all[0], all };
    }
    if (existsSync(arg)) {
        const st = statSync(arg);
        return {
            session: {
                project: '',
                sessionId: arg.split('/').slice(-2, -1)[0] ?? 'session',
                dir: arg.replace(/\/[^/]+$/, ''),
                file: arg,
                size: st.size,
                mtime: st.mtimeMs,
            },
            all,
        };
    }
    const hit = all.find((s) => s.sessionId.includes(arg) || s.sessionId.endsWith(arg));
    if (!hit)
        return { error: `没有匹配的会话：${arg}`, all };
    return { session: hit, all };
}
// ────────────────────────────────────────────────────────────────────────────
// 一次性全量读取（给 `sessions --decode` / 测试用）
// ────────────────────────────────────────────────────────────────────────────
export function readAllFrames(file) {
    const buf = readFileSync(file);
    return decodeFrames(buf).lines;
}
