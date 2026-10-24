/**
 * 会话来源（多 runtime 统一发现层）
 * =================================
 *
 * 每个 CLI agent 把会话写在完全不同的地方、用完全不同的格式：
 *
 *   DSH          ~/.dsh/sessions/<项目>/session-<uuid>/session.v4.jsonl.zstd   （多帧 zstd）
 *   Claude Code  ~/.claude/projects/<slug>/<sessionId>.jsonl                    （逐行 JSONL）
 *   Codex        ~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl               （逐行 JSONL）
 *
 * 这一层只做两件事：
 *   1. **发现**：把三种来源归一化成同一个 `SourceSession`；
 *   2. **读取**：给每个来源一个"从偏移量读新增行"的 reader（zstd 切帧 / 纯文本行）。
 *
 * 至于"这些行进哪个适配器"，由 `adapter` 字段决定 —— 发现层不认识格式。
 */
import { existsSync, openSync, closeSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { SessionTailer, readAllFrames } from "./live.js";
import { dshTitleOf } from "./dsh-titles.js";
import { cleanUserText } from "./text.js";
export function defaultRoots() {
    const home = homedir();
    return {
        dsh: process.env['DSH_SESSIONS_DIR'] ?? join(home, '.dsh', 'sessions'),
        claude: process.env['CLAUDE_PROJECTS_DIR'] ?? join(home, '.claude', 'projects'),
        codex: process.env['CODEX_SESSIONS_DIR'] ?? join(home, '.codex', 'sessions'),
    };
}
function safeReaddir(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
function statOf(file) {
    try {
        const st = statSync(file);
        return { size: st.size, mtime: st.mtimeMs };
    }
    catch {
        return undefined;
    }
}
/** Claude 的项目目录名是 cwd 的变形：`-Users-me-proj` ↔ `/Users/me/proj` */
export function decodeClaudeProject(slug) {
    if (slug.startsWith('-'))
        return slug.replace(/-/g, '/');
    return slug;
}
function discoverDsh(root) {
    const out = [];
    for (const projectDir of safeReaddir(root)) {
        const projectPath = join(root, projectDir);
        for (const sessionDir of safeReaddir(projectPath)) {
            const file = join(projectPath, sessionDir, 'session.v4.jsonl.zstd');
            const st = statOf(file);
            if (!st)
                continue;
            out.push({
                runtime: 'dsh',
                adapter: 'dsh',
                sessionId: sessionDir,
                project: projectDir.replace(/^--|--$/g, '').replace(/-/g, '/'),
                file,
                format: 'zstd-jsonl',
                ...st,
            });
        }
    }
    return out;
}
function discoverClaude(root) {
    const out = [];
    for (const slug of safeReaddir(root)) {
        const dir = join(root, slug);
        for (const name of safeReaddir(dir)) {
            if (!name.endsWith('.jsonl'))
                continue;
            const file = join(dir, name);
            const st = statOf(file);
            if (!st)
                continue;
            out.push({
                runtime: 'claude-code',
                adapter: 'claude-code',
                sessionId: name.replace(/\.jsonl$/, ''),
                project: decodeClaudeProject(slug),
                file,
                format: 'jsonl',
                ...st,
            });
        }
    }
    return out;
}
function discoverCodex(root) {
    const out = [];
    // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    const walk = (dir, depth) => {
        if (depth > 4)
            return;
        for (const entry of safeReaddir(dir)) {
            const next = join(dir, entry);
            let isDir = false;
            try {
                isDir = statSync(next).isDirectory();
            }
            catch {
                continue;
            }
            if (isDir) {
                walk(next, depth + 1);
                continue;
            }
            if (!entry.endsWith('.jsonl'))
                continue;
            const st = statOf(next);
            if (!st)
                continue;
            // rollout-2026-10-21T22-40-16-<uuid>.jsonl
            const m = /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(.+?)(?:\.jsonl)?$/.exec(entry);
            out.push({
                runtime: 'codex',
                adapter: 'codex-session',
                sessionId: m?.[1] ?? entry.replace(/\.jsonl$/, ''),
                project: basename(dir) === entry ? dir : join(dir.split('/').slice(-4, -1).join('/')),
                file: next,
                format: 'jsonl',
                ...st,
            });
        }
    };
    walk(root, 0);
    return out;
}
/** 发现所有 runtime 的会话，按最近活动倒序。 */
export function discoverAll(roots = defaultRoots()) {
    const all = [...discoverDsh(roots.dsh), ...discoverClaude(roots.claude), ...discoverCodex(roots.codex)];
    all.sort((a, b) => b.mtime - a.mtime);
    return all;
}
// ────────────────────────────────────────────────────────────────────────────
// 读取：从偏移量读新增行
// ────────────────────────────────────────────────────────────────────────────
/** 纯文本行尾随器（Claude Code / Codex 都是逐行 JSONL）。 */
export class TextTail {
    #file;
    #offset = 0;
    constructor(file, from = 0) {
        this.#file = file;
        this.#offset = from;
    }
    get offset() {
        return this.#offset;
    }
    poll() {
        const st = statOf(this.#file);
        if (!st || st.size <= this.#offset)
            return [];
        const length = st.size - this.#offset;
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
        const nl = chunk.lastIndexOf(0x0a);
        if (nl < 0)
            return [];
        const text = chunk.subarray(0, nl + 1).toString('utf8');
        this.#offset += nl + 1;
        return text.split('\n').filter((l) => l.trim() !== '');
    }
}
export function createReader(session, from = 0) {
    if (session.format === 'zstd-jsonl') {
        const tailer = new SessionTailer(session.file, from);
        return { poll: () => tailer.poll(), reset: () => { } };
    }
    const tail = new TextTail(session.file, from);
    return { poll: () => tail.poll(), reset: () => { } };
}
/**
 * 只跑适配器、不建索引地统计一个会话 —— 总览页要扫几十上百个会话，
 * 不能每个都 buildIndex（那会把几百万事件留在内存里）。
 */
/** 只跑适配器、不建索引地统计一段行 —— 总览页要扫几十个会话，不能每个都 buildIndex。 */
function summarizeLines(session, adapter, lines) {
    const summary = {
        session,
        events: 0,
        toolCalls: 0,
        toolFails: 0,
        tools: {},
        tokens: { in: 0, out: 0, cached: 0 },
        byModel: {},
        models: [],
        durationMs: 0,
        blockedMs: 0,
        checkpoints: 0,
        goal: '',
    };
    let currentModel = '';
    let lastT = 0;
    let lastTitle = '';
    /** 工具调用开始时间，用于算每个工具的累计耗时 */
    const openCalls = new Map();
    /** 各 session（agent）当前的阻塞起点 */
    const blockedSince = new Map();
    const inst = adapter.create({ session: session.sessionId, agent: 'agent', runtime: session.runtime }, (d) => {
        summary.events++;
        if (typeof d.t === 'number' && d.t > lastT)
            lastT = d.t;
        if (d.kind === 'session.start' && typeof d.data?.['model'] === 'string') {
            const m = d.data['model'];
            if (m !== '')
                currentModel = m;
        }
        if (d.kind === 'tool.call') {
            summary.toolCalls++;
            const tool = String(d.data?.['tool'] ?? 'tool');
            const rec = summary.tools[tool] ?? { calls: 0, fails: 0, ms: 0 };
            rec.calls++;
            summary.tools[tool] = rec;
            if (d.call)
                openCalls.set(d.call, { tool, at: typeof d.t === 'number' ? d.t : 0 });
        }
        if (d.kind === 'tool.result') {
            const failed = d.data?.['ok'] === false;
            if (failed)
                summary.toolFails++;
            const open = d.call ? openCalls.get(d.call) : undefined;
            if (open) {
                const rec = summary.tools[open.tool] ?? { calls: 0, fails: 0, ms: 0 };
                if (failed)
                    rec.fails++;
                const end = typeof d.t === 'number' ? d.t : open.at;
                rec.ms += Math.max(0, end - open.at);
                summary.tools[open.tool] = rec;
                openCalls.delete(d.call);
            }
        }
        if (d.kind === 'checkpoint') {
            summary.checkpoints++;
            if (d.data?.['name'] === '标题' && typeof d.data?.['note'] === 'string')
                lastTitle = d.data['note'];
        }
        if (d.kind === 'message.user' && summary.goal === '') {
            const text = cleanUserText(String(d.data?.['text'] ?? ''));
            if (text !== '')
                summary.goal = text.slice(0, 160);
        }
        if (d.kind === 'status') {
            const st = String(d.data?.['state'] ?? '');
            const who = d.session ?? 'agent';
            if (st === 'blocked' || st === 'waiting') {
                if (!blockedSince.has(who))
                    blockedSince.set(who, typeof d.t === 'number' ? d.t : 0);
            }
            else if (blockedSince.has(who)) {
                const start = blockedSince.get(who);
                const end = typeof d.t === 'number' ? d.t : start;
                summary.blockedMs += Math.max(0, end - start);
                blockedSince.delete(who);
            }
        }
        if (d.kind === 'usage') {
            const i = Number(d.data?.['in'] ?? 0) || 0;
            const o = Number(d.data?.['out'] ?? 0) || 0;
            const c = Number(d.data?.['cached'] ?? 0) || 0;
            summary.tokens.in += i;
            summary.tokens.out += o;
            summary.tokens.cached += c;
            const key = currentModel === '' ? 'unknown' : currentModel;
            const agg = summary.byModel[key] ?? { in: 0, out: 0, cached: 0 };
            agg.in += i;
            agg.out += o;
            agg.cached += c;
            summary.byModel[key] = agg;
        }
    });
    for (const line of lines) {
        if (line.trim() === '')
            continue;
        inst.onLine(line);
    }
    inst.onEnd?.('done');
    // 收尾：还在阻塞中的 agent 也要计入
    for (const start of blockedSince.values())
        summary.blockedMs += Math.max(0, lastT - start);
    summary.durationMs = lastT;
    // 标题优先级：事件日志里的"标题"检查点（权威，和 DSH 侧栏一致）→ 投影缓存 → 首条消息
    const eventTitle = lastTitle;
    const hit = session.runtime === 'dsh' ? dshTitleOf(session.sessionId) : undefined;
    const title = eventTitle || hit?.title;
    if (title)
        summary.title = title.replace(/\s+/g, ' ').slice(0, 120);
    else if (session.runtime !== 'dsh' && summary.goal)
        summary.title = summary.goal;
    if (!summary.goal && hit?.firstMessage)
        summary.goal = hit.firstMessage.slice(0, 160);
    summary.models = Object.entries(summary.byModel)
        .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
        .map(([m]) => m);
    return summary;
}
export function summarizeSession(session, adapter, maxBytes = 96 * 1024 * 1024) {
    if (session.size > maxBytes)
        return undefined;
    try {
        const lines = session.format === 'zstd-jsonl'
            ? readAllFrames(session.file)
            : readFileSync(session.file, 'utf8').split('\n');
        return summarizeLines(session, adapter, lines);
    }
    catch {
        return undefined;
    }
}
export function sessionKey(s) {
    return `${s.runtime}:${s.sessionId}`;
}
