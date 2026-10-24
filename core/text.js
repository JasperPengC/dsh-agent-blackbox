/**
 * 文本清洗
 * ========
 * 各家 runtime 都会往"用户消息"里塞系统注入内容（Codex 的 AGENTS.md 指令、
 * Claude Code 的 <command-name> 包裹等）。标题/目标不能拿这些当用户输入。
 */
/** 明显的系统注入/包装文本 */
export function isInstructionLike(text) {
    const t = text.trim();
    if (t === '')
        return true;
    if (/^#\s*AGENTS\.md/i.test(t))
        return true;
    if (t.includes('<INSTRUCTIONS>') || t.includes('</INSTRUCTIONS>'))
        return true;
    // 长且以 XML 标签开头的（Claude Code 的包装消息）
    if (/^<[a-z-]+[\s>]/i.test(t) && t.length > 120)
        return true;
    return false;
}
/** 去掉包裹标签，压成单行 */
export function stripWrappers(text) {
    return text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 从一段"疑似用户消息"里提取可用文本；系统注入返回空串 */
export function cleanUserText(text) {
    const raw = text.trim();
    if (raw === '' || isInstructionLike(raw))
        return '';
    const clean = stripWrappers(raw);
    return isInstructionLike(clean) ? '' : clean;
}
