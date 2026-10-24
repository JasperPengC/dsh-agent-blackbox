#!/usr/bin/env node
/**
 * agent-blackbox CLI
 * ==================
 *
 *   blackbox record  -- <cmd…>   录制一个 agent 进程
 *   blackbox ingest  <log>       转换已有日志
 *   blackbox stats   <run>       统计报告
 *   blackbox replay  <run>       终端回放（倒带看状态）
 *   blackbox ui      <run>       本地 Web 可视化
 *   blackbox adapters            适配器与可信度
 *   blackbox demo                内置示例
 *
 * 设计原则：**每个命令都能 `--json`，都能接管道**。这是"能被别的 agent 驱动"
 * 的前提 —— 一个调试工具如果自己不能被脚本化，就不配做调试工具。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ADAPTERS, detectAdapter, getAdapter, } from "./adapters/index.js";
import { Recorder, loadNdjson, parseNdjson, writeNdjson } from "./ndjson.js";
import { discoverSessions, readAllFrames, sessionsRoot } from "./live.js";
import { createReader, discoverAll, sessionKey, summarizeSession } from "./sources.js";
import { formatCurrency, loadPricing } from "./pricing.js";
import { cacheStats, clearCache } from "./event-cache.js";
import { snapshotStats, clearSnapshots } from "./snapshot-cache.js";
import { computeOverview } from "./overview.js";
import { buildIndex, seek } from "./projector.js";
import { buildStatsReport, clipTo, fmtDur, fmtT, makePaint, renderBoard, renderEvent, renderStats, } from "./report.js";
import { openBrowser, startServer } from "./server.js";
const PKG_URL = new URL('../package.json', import.meta.url);
const FIXTURE_URL = new URL('../fixtures/mission-demo.ndjson', import.meta.url);
const VERSION = (() => {
    try {
        const pkg = JSON.parse(readFileSync(PKG_URL, 'utf8'));
        return pkg.version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
const IS_TTY = process.stdout.isTTY === true;
function paintFor(noColor) {
    const on = noColor !== true &&
        IS_TTY &&
        process.env['NO_COLOR'] === undefined &&
        process.env['TERM'] !== 'dumb';
    return makePaint(on);
}
function die(msg, code = 1) {
    process.stderr.write(`\x1b[31m✖\x1b[0m ${msg}\n`);
    process.exit(code);
}
function readInput(file) {
    if (file === '-')
        return readFileSync(0, 'utf8');
    if (!existsSync(file))
        die(`找不到文件：${file}`, 2);
    return readFileSync(file, 'utf8');
}
function loadRun(file) {
    const text = readInput(file);
    const parsed = parseNdjson(text, true);
    if (parsed.events.length === 0) {
        die(`文件里没有可用事件：${file}\n` +
            `  · 如果这是某 agent 的原始 stdout，请先 ${paintFor(false).bold(`blackbox ingest ${file}`)}`, 3);
    }
    const label = file === '-' ? '<stdin>' : file;
    // run 名以事件里的 run 字段为准（文件改名不应该改变 run 身份）
    const ix = buildIndex(parsed.events, { file: label });
    return { ix, file: label, skipped: parsed.skipped };
}
function deriveRunName(file) {
    // 允许文件名里显式写 run 名：run 名取 `--name` 或文件名去扩展名
    const base = basename(file);
    const ext = extname(base);
    return base.slice(0, base.length - ext.length) || 'run';
}
const HELP = `
agent-blackbox ${VERSION} — AI agent 的黑匣子：录下来、看得见、倒得回去

用法
  blackbox <command> [options]

命令
  record <cmd…>            录制一个 agent 进程的实时输出
  ingest <log>             把已有日志转换成本项目格式（不丢行）
  stats  <run.ndjson>      统计报告：谁慢、谁贵、谁被谁挡住
  replay <run.ndjson>      终端回放（合法时间轴，可倒带）
  ui     <run.ndjson>      本地 Web 可视化（时间轴 + 流图 + 归因）
  live   [会话id]          ★ 实时监视会话（DSH / Claude Code / Codex 都能接）
  sessions                 列出本机所有 agent 会话（全 runtime）
  overview                 多会话总览 + 成本排行
  cache                    解码缓存统计（--clear 清空）
  adapters                 列出适配器与可信度
  demo                     回放内置示例（零配置）

示例
  # ★ 实时看自己正在跑的会话（最常用）
  blackbox live

  # 回放某个历史会话（自动解 zstd）
  blackbox sessions
  blackbox ui <会话id前缀>

  # 录一次 Claude Code 运行
  blackbox record --adapter claude --out runs/fix-bug.ndjson -- claude -p "修掉这个 bug" --output-format stream-json --verbose

  # 转换已有日志并出报告
  blackbox ingest claude-output.jsonl && blackbox stats claude-output.ndjson

  # 打开可视化
  blackbox ui runs/fix-bug.ndjson --open

  # 零配置体验（内置示例，不调用任何模型）
  blackbox demo --ui

通用选项
  --no-color               关闭颜色
  -h, --help               显示帮助
  -v, --version            显示版本

判断标准
  这个工具的每个输出都能 --json，所以它自己也能被 agent 驱动。
`;
function cmdRecord(args) {
    const sep = args.indexOf('--');
    const optArgs = sep >= 0 ? args.slice(0, sep) : args;
    const childArgv = sep >= 0 ? args.slice(sep + 1) : [];
    if (childArgv.length === 0) {
        die('record 需要子命令：blackbox record --out run.ndjson -- claude -p "..."', 1);
    }
    let parsed;
    try {
        parsed = parseArgs({
            args: optArgs,
            options: {
                adapter: { type: 'string', default: 'auto' },
                out: { type: 'string' },
                name: { type: 'string' },
                agent: { type: 'string' },
                session: { type: 'string' },
                cwd: { type: 'string' },
                echo: { type: 'boolean', default: false },
                'no-color': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
            allowPositionals: false,
        });
    }
    catch (err) {
        die(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    }
    const adapterId = String(parsed.values.adapter ?? 'auto');
    const echo = parsed.values.echo === true;
    const paint = paintFor(parsed.values['no-color'] === true);
    const label = String(parsed.values.name ?? deriveRunName(childArgv[0] ?? 'run'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = resolve(String(parsed.values.out ?? `runs/${label}-${stamp}.ndjson`));
    const session = String(parsed.values.session ?? `s-${label}`);
    const agent = String(parsed.values.agent ?? basename(childArgv[0] ?? 'agent'));
    const explicit = adapterId === 'auto' ? null : (getAdapter(adapterId) ?? null);
    if (adapterId !== 'auto' && !explicit) {
        die(`未知适配器：${adapterId}（可选：${ADAPTERS.map((a) => a.id).join(' / ')} / auto）`);
    }
    const t0 = Date.now();
    const recorder = new Recorder({ file: out, run: label, session, agent, t0 });
    recorder.push({
        kind: 'run.start',
        t: 0,
        data: { goal: childArgv.join(' '), wall: new Date(t0).toISOString() },
    });
    const ctx = {
        session,
        agent,
        runtime: adapterId === 'auto' ? 'unknown' : adapterId,
        ...(parsed.values.cwd ? { cwd: String(parsed.values.cwd) } : {}),
    };
    // 每一行到达时就记下它的时刻：即使因为自动识别而先缓冲，落盘时也不会丢时间。
    let lineAt = t0;
    const emit = (d) => {
        recorder.push(typeof d.t === 'number' ? d : { ...d, t: Math.max(0, lineAt - t0) });
    };
    let adapter = explicit;
    let instance = explicit ? explicit.create(ctx, emit) : null;
    const buffered = [];
    let decided = false;
    const decide = () => {
        if (decided)
            return;
        decided = true;
        const lines = buffered.map((b) => b.line);
        const det = detectAdapter(lines);
        const chosen = explicit ?? getAdapter(det.id) ?? getAdapter('raw');
        if (!chosen)
            die('内部错误：没有可用适配器');
        adapter = chosen;
        instance = chosen.create(ctx, emit);
        process.stderr.write(paint.gray(`  · 适配器 ${chosen.label}${explicit ? '' : `（自动识别 ${(det.score * 100).toFixed(0)}%）`}\n`));
        for (const b of buffered) {
            lineAt = b.at;
            instance.onLine(b.line);
        }
        buffered.length = 0;
    };
    const onLine = (line) => {
        lineAt = Date.now();
        if (echo)
            process.stdout.write(line + '\n');
        if (instance) {
            instance.onLine(line);
            return;
        }
        buffered.push({ line, at: lineAt });
        // 自动识别要尽早决策：攒满 3 行、或单行置信度已经很高时就定下来。
        // （攒到 12 行再决策会让整段录制的时间戳塌缩到结束那一刻）
        if (buffered.length >= 3)
            decide();
        else if (detectAdapter(buffered.map((b) => b.line)).score >= 0.8)
            decide();
    };
    process.stderr.write(`${paint.bold('agent-blackbox')} ${paint.gray('record')} → ${paint.cyan(out)}\n`);
    const child = spawn(childArgv[0] ?? '', childArgv.slice(1), {
        cwd: parsed.values.cwd ? String(parsed.values.cwd) : process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
    });
    let stdoutDone = false;
    let stderrDone = false;
    let finished = false;
    const finish = (code, signal) => {
        if (!stdoutDone || !stderrDone || finished)
            return;
        finished = true;
        decide();
        const status = code === 0 ? 'done' : 'failed';
        instance?.onEnd?.(status);
        recorder.push({
            kind: 'run.end',
            data: {
                status,
                wall: new Date().toISOString(),
                ...(code !== 0 ? { reason: signal ? `signal ${signal}` : `exit ${String(code)}` } : {}),
            },
        });
        recorder.close();
        const ix = buildIndex(loadNdjson(out, true).events, { file: out, run: label });
        process.stderr.write(`\n${paint.green('✓')} 已录制 ${paint.bold(String(ix.events.length))} 事件 ` +
            `${paint.gray('/')} ${fmtDur(ix.duration)} → ${paint.cyan(out)}\n` +
            `  ${paint.gray('下一步:')} blackbox stats ${out}\n` +
            `  ${paint.gray('        ')} blackbox ui ${out} --open\n`);
        process.exit(status === 'done' ? 0 : 1);
    };
    if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on('line', onLine);
        rl.on('close', () => {
            stdoutDone = true;
            finish(child.exitCode, child.signalCode);
        });
    }
    else {
        stdoutDone = true;
    }
    if (child.stderr) {
        const rl = createInterface({ input: child.stderr });
        rl.on('line', (line) => {
            // stderr 不是结构化输出：原样透传给人看，不污染事件流
            if (line.trim() !== '')
                process.stderr.write(paint.gray(`  ! ${line}\n`));
        });
        rl.on('close', () => {
            stderrDone = true;
            finish(child.exitCode, child.signalCode);
        });
    }
    else {
        stderrDone = true;
    }
    child.on('error', (err) => {
        die(`启动失败：${err.message}`);
    });
    const onSigint = () => {
        child.kill('SIGINT');
        setTimeout(() => process.exit(130), 500);
    };
    process.once('SIGINT', onSigint);
    // 子进程很安静（长时间没输出）时也要把缓冲吐出去，避免第一段事件永远不落盘
    const flushTimer = setInterval(() => {
        if (!decided && buffered.length > 0)
            decide();
    }, 700);
    flushTimer.unref();
}
// ────────────────────────────────────────────────────────────────────────────
// ingest
// ────────────────────────────────────────────────────────────────────────────
function cmdIngest(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                adapter: { type: 'string', default: 'auto' },
                out: { type: 'string' },
                session: { type: 'string' },
                agent: { type: 'string' },
                name: { type: 'string' },
                't-step': { type: 'string', default: '250' },
                'no-color': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch (err) {
        die(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    }
    const input = parsed.positionals[0];
    if (!input)
        die('用法：blackbox ingest <log> [--adapter auto] [--out run.ndjson]');
    const paint = paintFor(parsed.values['no-color'] === true);
    let text = readInput(input);
    // DSH 的会话日志是多帧 zstd；`ingest <session.v4.jsonl.zstd>` 直接可用
    if (input.endsWith('.zstd'))
        text = readAllFrames(input).join('\n');
    const lines = text.split('\n');
    let adapterId = String(parsed.values.adapter ?? 'auto');
    if (adapterId === 'auto') {
        const det = detectAdapter(lines);
        adapterId = det.id;
        process.stderr.write(paint.gray(`  · 自动识别：${adapterId}（置信度 ${(det.score * 100).toFixed(0)}%；候选 ${det.scores
            .filter((s) => s.score > 0)
            .map((s) => `${s.id}:${s.score.toFixed(2)}`)
            .join(' ')}）\n`));
    }
    const adapter = getAdapter(adapterId);
    if (!adapter)
        die(`未知适配器：${adapterId}`);
    const base = deriveRunName(input);
    const name = String(parsed.values.name ?? base);
    const defaultName = `${base.replace(/\.(jsonl|log|txt|out|json)$/i, '')}.ndjson`;
    // 默认落在**输入文件旁边**，而不是当前工作目录 —— 少一个"文件跑哪去了"的疑问
    const out = resolve(String(parsed.values.out ?? join(dirname(resolve(input === '-' ? '.' : input)), defaultName)));
    const tStep = Number(parsed.values['t-step'] ?? '250');
    const recorder = new Recorder({
        file: out,
        run: name,
        session: String(parsed.values.session ?? `s-${name}`),
        agent: String(parsed.values.agent ?? name),
        tStep: Number.isFinite(tStep) && tStep > 0 ? tStep : 250,
    });
    const stat = existsSync(input) ? statSync(input) : undefined;
    recorder.push({
        kind: 'run.start',
        data: {
            goal: `${basename(input)}（ingest / ${adapter.id}）`,
            wall: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString(),
            tSynthetic: true,
        },
    });
    const ctx = {
        session: String(parsed.values.session ?? `s-${name}`),
        agent: String(parsed.values.agent ?? name),
        runtime: adapter.id,
    };
    let suppliedT = false;
    const instance = adapter.create(ctx, (d) => {
        if (typeof d.t === 'number')
            suppliedT = true;
        recorder.push(d);
    });
    let consumed = 0;
    for (const line of lines) {
        const trimmed = line.replace(/\r$/, '');
        if (trimmed === '')
            continue;
        instance.onLine(trimmed);
        consumed++;
    }
    instance.onEnd?.('done');
    recorder.push({ kind: 'run.end', data: { status: 'done' } });
    recorder.close();
    const ix = buildIndex(loadNdjson(out, true).events, { file: out, run: name });
    process.stderr.write(`${paint.green('✓')} ${consumed} 行 → ${paint.bold(String(ix.events.length))} 事件 → ${paint.cyan(out)}\n` +
        (suppliedT
            ? `  ${paint.gray('时间轴来自日志自带时间戳')}\n`
            : `  ${paint.gray('注意：源日志无逐行时间戳，时间轴为合成（每事件 +' + String(tStep) + 'ms）')}\n`) +
        `  ${paint.gray('下一步:')} blackbox stats ${out}\n`);
}
// ────────────────────────────────────────────────────────────────────────────
// stats
// ────────────────────────────────────────────────────────────────────────────
function cmdStats(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                json: { type: 'boolean', default: false },
                'no-color': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch (err) {
        die(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    }
    const file = parsed.positionals[0];
    if (!file)
        die('用法：blackbox stats <run.ndjson> [--json]');
    const { ix, skipped } = loadRun(file);
    const report = buildStatsReport(ix, file);
    if (parsed.values.json === true) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return;
    }
    const paint = paintFor(parsed.values['no-color'] === true);
    process.stdout.write(renderStats(report, paint) + '\n');
    if (skipped > 0) {
        process.stderr.write(paint.yellow(`  ⚠ 有 ${skipped} 行被跳过（不是合法事件）\n`));
    }
}
// ────────────────────────────────────────────────────────────────────────────
// replay
// ────────────────────────────────────────────────────────────────────────────
function clearScreen() {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function cmdReplay(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                once: { type: 'boolean', default: false },
                at: { type: 'string' },
                duration: { type: 'string', default: '20' },
                'no-color': { type: 'boolean', default: false },
                events: { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch (err) {
        die(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    }
    const file = parsed.positionals[0];
    if (!file)
        die('用法：blackbox replay <run.ndjson> [--once] [--duration 20]');
    const { ix } = loadRun(file);
    const paint = paintFor(parsed.values['no-color'] === true);
    const once = parsed.values.once === true || !IS_TTY;
    if (once) {
        // --at 允许直接停在某一刻（配合 deep link 使用），默认展示最终状态
        const atRaw = parsed.values.at;
        const at = atRaw === undefined ? ix.duration : Math.max(0, Math.min(Number(atRaw) || 0, ix.duration));
        const state = seek(ix, at);
        process.stdout.write(renderBoard(ix, state, paint) + '\n');
        if (parsed.values.events === true) {
            process.stdout.write('\n' + paint.gray('── 全部事件 ──') + '\n');
            for (const e of ix.events)
                process.stdout.write(renderEvent(e, paint) + '\n');
        }
        return;
    }
    const seconds = Math.max(1, Number(parsed.values.duration ?? '20') || 20);
    const fps = 12;
    const frames = Math.round(seconds * fps);
    const frameMs = 1000 / fps;
    process.stdout.write('\x1b[?25l');
    try {
        for (let i = 0; i <= frames; i++) {
            const t = Math.round((ix.duration * i) / frames);
            const state = seek(ix, t);
            clearScreen();
            process.stdout.write(renderBoard(ix, state, paint) + '\n');
            process.stdout.write(paint.gray(`  ← → 拖动时间轴（这里是回放：${fmtT(t)} / ${fmtT(ix.duration)}，${(i / frames * 100).toFixed(0)}%）\n`));
            await sleep(frameMs);
        }
    }
    finally {
        process.stdout.write('\x1b[?25h');
    }
    process.stdout.write(paint.gray('\n  回放结束。想看交互式时间轴：blackbox ui ' + file + '\n'));
}
// ────────────────────────────────────────────────────────────────────────────
// ui
// ────────────────────────────────────────────────────────────────────────────
async function cmdUi(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                port: { type: 'string', default: '7077' },
                host: { type: 'string', default: '127.0.0.1' },
                follow: { type: 'boolean', default: false },
                open: { type: 'boolean', default: false },
                'no-color': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch (err) {
        die(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    }
    const file = parsed.positionals[0];
    if (!file)
        die('用法：blackbox ui <run.ndjson> [--port 7077] [--follow] [--open]');
    const paint = paintFor(parsed.values['no-color'] === true);
    const port = Number(parsed.values.port ?? '7077');
    const server = await startServer({
        file: resolve(file),
        port: Number.isFinite(port) ? port : 7077,
        host: String(parsed.values.host ?? '127.0.0.1'),
        follow: parsed.values.follow === true,
    });
    const ix = server.index();
    process.stdout.write(`\n  ${paint.bold('agent-blackbox')}  ${paint.green('▸')} ${paint.cyan(server.url)}\n` +
        `  ${paint.gray('文件')} ${file}  ${paint.gray('·')}  ${ix.events.length} 事件 ${paint.gray('/')} ${fmtDur(ix.duration)}` +
        `${parsed.values.follow === true ? paint.green('  · FOLLOW') : ''}\n` +
        `  ${paint.gray('Ctrl+C 退出')}\n\n`);
    if (parsed.values.open === true)
        openBrowser(server.url);
    await new Promise((resolvePromise) => {
        const stop = () => {
            void server.close().then(() => {
                process.stdout.write(`\n  ${paint.gray('已停止')}\n`);
                resolvePromise();
            });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}
// ────────────────────────────────────────────────────────────────────────────
// sessions —— 找会话（全 runtime）
// ────────────────────────────────────────────────────────────────────────────
function relTime(ms) {
    const d = Date.now() - ms;
    if (d < 60_000)
        return `${Math.round(d / 1000)} 秒前`;
    if (d < 3_600_000)
        return `${Math.round(d / 60_000)} 分钟前`;
    if (d < 86_400_000)
        return `${Math.round(d / 3_600_000)} 小时前`;
    return `${Math.round(d / 86_400_000)} 天前`;
}
function fmtSize(bytes) {
    if (bytes > 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
    if (bytes > 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${Math.round(bytes / 1024)}KB`;
}
const RUNTIME_LABEL = {
    dsh: 'DSH',
    'claude-code': 'Claude Code',
    codex: 'Codex',
};
function cmdSessions(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                json: { type: 'boolean', default: false },
                runtime: { type: 'string' },
                limit: { type: 'string', default: '30' },
                'no-color': { type: 'boolean', default: false },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch {
        die('用法：blackbox sessions [--runtime dsh|claude-code|codex] [--limit 30] [--json]');
    }
    const paint = paintFor(parsed.values['no-color'] === true);
    const runtime = parsed.values.runtime ? String(parsed.values.runtime) : undefined;
    const all = discoverAll().filter((s) => runtime === undefined || s.runtime === runtime);
    const limit = Math.max(1, Number(parsed.values.limit ?? '30') || 30);
    const rows = all.slice(0, limit);
    if (parsed.values.json === true) {
        process.stdout.write(JSON.stringify({ total: all.length, sessions: rows }, null, 2) + '\n');
        return;
    }
    if (all.length === 0) {
        process.stdout.write(`${paint.yellow('没有找到会话')}。支持的来源：\n`);
        process.stdout.write(paint.gray('  ~/.dsh/sessions · ~/.claude/projects · ~/.codex/sessions\n'));
        return;
    }
    const counts = {};
    for (const s of all)
        counts[s.runtime] = (counts[s.runtime] ?? 0) + 1;
    const summary = Object.entries(counts)
        .map(([k, v]) => `${RUNTIME_LABEL[k] ?? k} ${v}`)
        .join(' · ');
    process.stdout.write(paint.bold(`\n会话总览（${all.length} 个：${summary}）\n\n`));
    rows.forEach((s, i) => {
        const short = s.sessionId.replace(/^session-/, '').slice(0, 8);
        process.stdout.write(`  ${paint.gray(String(i).padStart(2))}  ${paint.cyan((RUNTIME_LABEL[s.runtime] ?? s.runtime).padEnd(11))} ` +
            `${paint.gray(relTime(s.mtime).padEnd(10))} ${paint.gray(fmtSize(s.size).padStart(7))}  ` +
            `${paint.bold(short)}  ${paint.gray(clipTo(s.project, 44))}\n`);
    });
    process.stdout.write(`\n  ${paint.gray('实时监视最近的：')} ${paint.bold('blackbox live')}\n` +
        `  ${paint.gray('监视指定会话：  ')} ${paint.bold('blackbox live ' + (rows[0]?.sessionId.replace(/^session-/, '').slice(0, 8) ?? ''))}\n` +
        `  ${paint.gray('按成本排行：    ')} ${paint.bold('blackbox overview')}\n\n`);
}
// ────────────────────────────────────────────────────────────────────────────
// live —— 实时监视任意 runtime 的会话
// ────────────────────────────────────────────────────────────────────────────
/** 大文件从尾部开始（只保留最近一段），避免一上来读 100MB。 */
const LIVE_TAIL_BYTES = 8 * 1024 * 1024;
const LIVE_FULL_LIMIT = 64 * 1024 * 1024;
async function cmdLive(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                port: { type: 'string', default: '7077' },
                host: { type: 'string', default: '127.0.0.1' },
                runtime: { type: 'string' },
                out: { type: 'string' },
                list: { type: 'boolean', default: false },
                'no-open': { type: 'boolean', default: false },
                'no-color': { type: 'boolean', default: false },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch (err) {
        die(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    }
    const paint = paintFor(parsed.values['no-color'] === true);
    if (parsed.values.list === true) {
        cmdSessions(['--no-color']);
        return;
    }
    const runtimeFilter = parsed.values.runtime ? String(parsed.values.runtime) : undefined;
    const all = discoverAll().filter((s) => runtimeFilter === undefined || s.runtime === runtimeFilter);
    if (all.length === 0) {
        die(`没有找到会话${runtimeFilter ? `（runtime=${runtimeFilter}）` : ''}：试试 blackbox sessions`, 2);
    }
    const needle = parsed.positionals[0];
    let session;
    if (needle === undefined || needle === 'latest') {
        session = all[0];
    }
    else {
        session =
            all.find((s) => s.sessionId === needle) ??
                all.find((s) => s.sessionId.includes(needle)) ??
                all.find((s) => s.project.includes(needle));
    }
    if (!session) {
        process.stderr.write(`${paint.red('✖')} 没有匹配的会话：${needle}\n\n${paint.gray('最近的几个：')}\n`);
        for (const s of all.slice(0, 8)) {
            process.stderr.write(`  ${paint.cyan(s.sessionId.replace(/^session-/, '').slice(0, 8))}  ${paint.gray(RUNTIME_LABEL[s.runtime] ?? s.runtime)}  ${paint.gray(s.project)}\n`);
        }
        process.exit(2);
    }
    const adapter = getAdapter(session.adapter);
    if (!adapter)
        die(`找不到适配器：${session.adapter}`);
    const short = session.sessionId.replace(/^session-/, '').slice(0, 8);
    const out = resolve(String(parsed.values.out ?? `runs/live-${session.runtime}-${short}.ndjson`));
    writeNdjson(out, []);
    const recorder = new Recorder({
        file: out,
        run: session.sessionId,
        session: session.sessionId,
        agent: 'agent',
    });
    const instance = adapter.create({ session: session.sessionId, agent: 'agent', runtime: session.runtime }, (d) => recorder.push(d));
    // 大文件只从尾部开始：要么完整（有 session_meta 可拿 cwd/model），要么最近一段
    const from = session.size > LIVE_FULL_LIMIT ? Math.max(0, session.size - LIVE_TAIL_BYTES) : 0;
    const reader = createReader(session, from);
    const initial = reader.poll();
    for (const line of initial)
        instance.onLine(line);
    const port = Number(parsed.values.port ?? '7077');
    const server = await startServer({
        file: out,
        port: Number.isFinite(port) ? port : 7077,
        host: String(parsed.values.host ?? '127.0.0.1'),
        follow: true,
    });
    process.stdout.write(`\n  ${paint.bold('agent-blackbox')} ${paint.green('● LIVE')} ${paint.cyan(server.url)}\n` +
        `  ${paint.gray('runtime')} ${RUNTIME_LABEL[session.runtime] ?? session.runtime}  ${paint.gray('会话')} ${session.sessionId}\n` +
        `  ${paint.gray('项目')}   ${session.project}\n` +
        `  ${paint.gray('来源')}   ${session.file}${from > 0 ? paint.yellow('  （大文件，只读最近 8MB）') : ''}\n` +
        `  ${paint.gray('已解码')} ${initial.length} 行 → ${recorder.count} 事件  ${paint.gray('· 每 400ms 增量同步')}\n` +
        `  ${paint.gray('Ctrl+C 退出')}\n\n`);
    if (parsed.values['no-open'] !== true)
        openBrowser(server.url);
    const timer = setInterval(() => {
        const lines = reader.poll();
        if (lines.length === 0)
            return;
        for (const line of lines)
            instance.onLine(line);
        process.stderr.write(paint.gray(`  +${lines.length} 行 · ${recorder.count} 事件\n`));
    }, 400);
    timer.unref?.();
    await new Promise((resolvePromise) => {
        const stop = () => {
            clearInterval(timer);
            instance.onEnd?.('done');
            recorder.close();
            void server.close().then(() => {
                process.stdout.write(`\n  ${paint.gray('已停止')} · ${recorder.count} 事件 · 录制文件 ${out}\n\n`);
                resolvePromise();
            });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}
// ────────────────────────────────────────────────────────────────────────────
// cache —— 解码结果缓存
// ────────────────────────────────────────────────────────────────────────────
function cmdCache(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                clear: { type: 'boolean', default: false },
                json: { type: 'boolean', default: false },
                'no-color': { type: 'boolean', default: false },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch {
        die('用法：blackbox cache [--clear] [--json]');
    }
    const paint = paintFor(parsed.values['no-color'] === true);
    if (parsed.values.clear === true) {
        const a = clearCache();
        const b = clearSnapshots();
        process.stdout.write(`${paint.green('✓')} 已清空 ${a} 个解码缓存、${b} 个首屏快照\n`);
        return;
    }
    const events = cacheStats();
    const snaps = snapshotStats();
    if (parsed.values.json === true) {
        process.stdout.write(JSON.stringify({ events, snapshots: snaps }, null, 2) + '\n');
        return;
    }
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    process.stdout.write(`${paint.bold('缓存')}\n` +
        `  解码缓存    ${events.entries} 条 · ${mb(events.bytes)}   ${paint.gray(events.root)}\n` +
        `  首屏快照    ${snaps.entries} 条 · ${mb(snaps.bytes)}   ${paint.gray(snaps.root)}\n` +
        `  ${paint.gray('文件 30 秒内仍在变化时不写缓存；上限 80 条 / 300MB，按最近访问淘汰')}\n`);
}
// ────────────────────────────────────────────────────────────────────────────
// overview —— 多会话总览 + 成本排行
// ────────────────────────────────────────────────────────────────────────────
function fmtSpan(ms) {
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
        : `${m}:${String(ss).padStart(2, '0')}`;
}
function cmdOverview(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: {
                json: { type: 'boolean', default: false },
                runtime: { type: 'string' },
                limit: { type: 'string', default: '40' },
                'no-cache': { type: 'boolean', default: false },
                all: { type: 'boolean', default: false },
                'no-color': { type: 'boolean', default: false },
                sort: { type: 'string', default: 'tokens' },
            },
            strict: true,
            allowPositionals: true,
        });
    }
    catch {
        die('用法：blackbox overview [--limit 40] [--runtime …] [--sort tokens|cost|time] [--json] [--no-cache]');
    }
    const paint = paintFor(parsed.values['no-color'] === true);
    const pricing = loadPricing();
    const limit = parsed.values.all === true ? Number.MAX_SAFE_INTEGER : Math.max(1, Number(parsed.values.limit ?? '40') || 40);
    const isTty = process.stderr.isTTY === true;
    const result = computeOverview(pricing, {
        limit,
        ...(parsed.values.runtime ? { runtime: String(parsed.values.runtime) } : {}),
        useCache: parsed.values['no-cache'] !== true,
        onProgress: (done, total) => {
            if (isTty && done % 3 === 0)
                process.stderr.write(paint.gray(`\r  扫描 ${done}/${total} …`));
        },
    });
    if (isTty)
        process.stderr.write(paint.gray('\r' + ' '.repeat(40) + '\r'));
    const rows = [...result.rows];
    const sortBy = String(parsed.values.sort ?? 'tokens');
    rows.sort((a, b) => {
        if (sortBy === 'time')
            return b.mtime - a.mtime;
        if (sortBy === 'cost') {
            const ca = a.cost ?? -1;
            const cb = b.cost ?? -1;
            if (ca !== cb)
                return cb - ca;
        }
        // 默认按 token：成本依赖价格表，token 永远有 —— 排序依据必须可靠
        return b.tokens.in + b.tokens.out - (a.tokens.in + a.tokens.out);
    });
    if (parsed.values.json === true) {
        process.stdout.write(JSON.stringify({ currency: result.currency, pricingNote: result.pricingNote, total: rows.length, sessions: rows }, null, 2) + '\n');
        return;
    }
    process.stdout.write(paint.bold(`\n多会话总览 · ${rows.length} 个会话`) +
        paint.gray(`（共发现 ${result.discovered} 个）· 币种 ${result.currency}\n\n`));
    process.stdout.write(paint.gray('  #  runtime     最近        时长       工具     输入        输出       缓存      成本       项目') + '\n');
    rows.forEach((r, i) => {
        const toks = r.tokens.in + r.tokens.out + r.tokens.cached;
        const costText = !toks
            ? paint.gray('—')
            : r.missingPrice
                ? r.cost !== undefined
                    ? paint.yellow(formatCurrency(pricing, r.cost) + '*')
                    : paint.gray('—')
                : formatCurrency(pricing, r.cost ?? 0);
        process.stdout.write(`  ${paint.gray(String(i).padStart(2))} ${paint.cyan((RUNTIME_LABEL[r.runtime] ?? r.runtime).padEnd(11))} ` +
            `${paint.gray(relTime(r.mtime).padEnd(10))} ${paint.gray(fmtSpan(r.durationMs).padStart(9))} ` +
            `${paint.gray(String(r.toolCalls).padStart(6))}${r.toolFails > 0 ? paint.red('✗' + r.toolFails) : '  '} ` +
            `${fmtTokNum(r.tokens.in).padStart(10)} ${fmtTokNum(r.tokens.out).padStart(10)} ${fmtTokNum(r.tokens.cached).padStart(9)} ` +
            `${costText.padEnd(10)} ${paint.gray(clipTo(r.project, 34))}\n`);
    });
    process.stdout.write(paint.gray('  ' + '─'.repeat(118)) +
        `\n  ${paint.bold('合计')} ${paint.gray('token')} ${fmtTokNum(result.totals.tokens.in)}↑ ${fmtTokNum(result.totals.tokens.out)}↓ ` +
        `${paint.gray('缓存')} ${fmtTokNum(result.totals.tokens.cached)} · ${paint.bold('估算成本')} ` +
        `${paint.bold(formatCurrency(pricing, result.totals.cost))}\n`);
    if (result.unpricedModels.length > 0) {
        process.stdout.write(paint.yellow(`  ⚠ ${result.unpricedModels.length} 个模型没有价格，相关会话的成本不参与合计：` +
            `${result.unpricedModels.slice(0, 6).join(', ')}${result.unpricedModels.length > 6 ? ' …' : ''}\n`));
        process.stdout.write(paint.gray(`    在 ~/.dsh/blackbox/pricing.json 里补：{"models": {"模型名": {"in": 2, "out": 10, "cached": 0.2}}}\n`));
    }
    if (result.skippedLarge > 0) {
        process.stdout.write(paint.gray(`  ${result.skippedLarge} 个会话过大（>96MB）未统计\n`));
    }
    process.stdout.write('\n');
}
function fmtTokNum(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
// ────────────────────────────────────────────────────────────────────────────
// adapters
// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// adapters
// ────────────────────────────────────────────────────────────────────────────
function cmdAdapters(args) {
    let parsed;
    try {
        parsed = parseArgs({
            args,
            options: { json: { type: 'boolean', default: false }, 'no-color': { type: 'boolean', default: false } },
            strict: true,
            allowPositionals: true,
        });
    }
    catch {
        die('用法：blackbox adapters [--json]');
    }
    if (parsed.values.json === true) {
        process.stdout.write(JSON.stringify(ADAPTERS.map((a) => ({ id: a.id, label: a.label, status: a.status, note: a.note })), null, 2) + '\n');
        return;
    }
    const paint = paintFor(parsed.values['no-color'] === true);
    process.stdout.write(paint.bold('\nagent-blackbox · 适配器\n\n'));
    const tag = {
        verified: paint.green('verified '),
        heuristic: paint.yellow('heuristic'),
        fallback: paint.gray('fallback '),
    };
    for (const a of ADAPTERS) {
        process.stdout.write(`  ${paint.cyan(a.id.padEnd(8))} ${tag[a.status] ?? a.status}  ${a.label}\n` +
            paint.gray(`  ${' '.repeat(8)} ${a.note}\n`));
    }
    process.stdout.write('\n');
}
// ────────────────────────────────────────────────────────────────────────────
// demo
// ────────────────────────────────────────────────────────────────────────────
async function cmdDemo(args) {
    const fixture = fileURLToPath(FIXTURE_URL);
    if (!existsSync(fixture)) {
        die(`内置示例缺失：${fixture}\n  先运行：node scripts/make-fixture.ts`, 2);
    }
    const wantUi = args.includes('--ui');
    const wantStats = args.includes('--stats');
    const forward = args.filter((a) => a !== '--ui' && a !== '--stats');
    if (wantStats) {
        cmdStats([fixture, ...forward]);
        return;
    }
    if (wantUi) {
        await cmdUi([fixture, '--open', ...forward]);
        return;
    }
    await cmdReplay([fixture, ...forward]);
}
// ────────────────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────────────────
export async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] ?? 'help';
    const rest = argv.slice(1);
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
        process.stdout.write(HELP.trimStart() + '\n');
        return;
    }
    if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
        process.stdout.write(`${VERSION}\n`);
        return;
    }
    if (rest.includes('-h') && rest.includes('--help') === false) {
        process.stdout.write(HELP.trimStart() + '\n');
        return;
    }
    switch (cmd) {
        case 'record':
            cmdRecord(rest);
            return;
        case 'ingest':
            cmdIngest(rest);
            return;
        case 'stats':
            cmdStats(rest);
            return;
        case 'replay':
            await cmdReplay(rest);
            return;
        case 'ui':
            await cmdUi(rest);
            return;
        case 'adapters':
            cmdAdapters(rest);
            return;
        case 'sessions':
            cmdSessions(rest);
            return;
        case 'overview':
            cmdOverview(rest);
            return;
        case 'cache':
            cmdCache(rest);
            return;
        case 'live':
            await cmdLive(rest);
            return;
        case 'demo':
            await cmdDemo(rest);
            return;
        default:
            process.stderr.write(`未知命令：${cmd}\n\n`);
            process.stdout.write(HELP.trimStart() + '\n');
            process.exit(1);
    }
}
/**
 * 只有被**直接执行**才跑：
 *   · `node src/cli.ts …` / `node dist/cli.js …` → 是入口
 *   · 被 `bin/blackbox.js` 或测试 import → 由调用方决定何时执行 `main()`
 * 这样这个模块同时可以作为 CLI 入口和可 import 的库导出。
 */
const invokedPath = process.argv[1];
const isEntry = invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url;
if (isEntry) {
    main().catch((err) => {
        process.stderr.write(`\x1b[31m✖\x1b[0m ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    });
}
