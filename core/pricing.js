/**
 * 成本估算
 * ========
 *
 * 日志里**只有 token，没有钱**。所以成本一定是"估算"，这有三个后果：
 *
 *  1. 价格表必须显式、可覆盖、可追溯（每条带 source 字段）；
 *  2. 查不到价格的模型**必须显示"—"**，绝不能凭感觉估一个数；
 *  3. 不同厂商计价币种不同（DeepSeek 人民币、OpenAI/Anthropic 美元），
 *     统一换算需要一个汇率输入，且要标注"按 X 汇率折算"。
 *
 * 宁可不给数字，也不给一个错数字 —— 成本排行是拿来决策的，不是拿来好看的。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 归一化模型名：大小写、点/横线、日期后缀都不影响匹配 */
export function normalizeModel(model) {
    return model
        .toLowerCase()
        .replace(/@.*$/, '')
        .replace(/[-_.\s]+/g, '-')
        .replace(/-(latest|preview)$/, '')
        .trim();
}
/**
 * 内置价格表 —— **只放能追溯来源的条目**。
 *
 * 没有把握的一律不写：查不到就显示 "—"，比编一个数诚实。
 * 用户可以在 `~/.dsh/blackbox/pricing.json` 里覆盖/补充。
 */
const BUILTIN = {
    // 来源：DeepSeek 官方定价页快照（2026-09-10 起生效，高峰时段；单位 CNY / 1M tokens）
    // 空闲时段约为高峰的 5 折，这里取高峰价（保守估计，不会低估成本）
    'deepseek-v4.1-flash': { in: 2.0, out: 8.0, cached: 0.04, currency: 'CNY', source: 'deepseek 官方定价页 2026-09-10 高峰价' },
    // 来源：同上（2026-08-16 起，高峰）
    'deepseek-v4-pro': { in: 9.0, out: 27.0, cached: 0.3, currency: 'CNY', source: 'deepseek 官方定价页 2026-08-16 高峰价' },
    // 来源：OpenAI 官方 changelog（$2 in / $0.20 cached / $10 out）
    'gpt-6-sol': { in: 2, out: 10, cached: 0.2, currency: 'USD', source: 'openai changelog' },
    // 来源：同上（$0.10 / $0.01 / $0.50）
    'gpt-6-luna': { in: 0.1, out: 0.5, cached: 0.01, currency: 'USD', source: 'openai changelog' },
};
function userPricingFile() {
    return process.env['BLACKBOX_PRICING'] ?? join(homedir(), '.dsh', 'blackbox', 'pricing.json');
}
export function loadPricing() {
    // 内置表的 key 也要归一化（'deepseek-v4.1-flash' → 'deepseek-v4-1-flash'），
    // 否则带点号的模型名永远匹配不上 —— 这个 bug 是跑真实数据才发现的。
    const models = {};
    for (const [name, price] of Object.entries(BUILTIN)) {
        models[normalizeModel(name)] = { ...price, currency: price.currency ?? 'USD' };
    }
    let displayCurrency = 'USD';
    let note = '内置表仅含可追溯来源的条目；其余模型请在 ~/.dsh/blackbox/pricing.json 补充';
    let usdRates = { CNY: 7.2, USD: 1 };
    const file = userPricingFile();
    if (existsSync(file)) {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            if (raw.displayCurrency)
                displayCurrency = raw.displayCurrency;
            if (raw.usdRates)
                usdRates = { ...usdRates, ...raw.usdRates };
            if (raw.note)
                note = raw.note;
            for (const [name, price] of Object.entries(raw.models ?? {})) {
                models[normalizeModel(name)] = { ...price, currency: price.currency ?? 'USD' };
            }
        }
        catch {
            /* 文件坏了就用内置表，不因为配置错误让工具不可用 */
        }
    }
    return { displayCurrency, usdRates, models, note };
}
/** 单价换算成美元 / 1M tokens（币种不一致时按 usdRates 折算）。 */
function toUsd(price, rates) {
    const currency = (price.currency ?? 'USD').toUpperCase();
    if (currency === 'USD')
        return price;
    const rate = rates[currency];
    if (!rate || rate <= 0)
        return price; // 不知道怎么换算就按原值，调用方会标注 currency
    return {
        in: price.in / rate,
        out: price.out / rate,
        cached: (price.cached ?? price.in) / rate,
        currency: 'USD',
    };
}
/**
 * 价格查找。
 *
 * 日志里的模型名五花八门：`deepseek-v4.1-flash`、`deepseek/deepseek-v4.1-flash`、
 * `cline-pass/deepseek-v4.1-flash` 都是同一个模型。逐段去掉 provider 前缀再找，
 * 但**绝不做模糊包含匹配** —— 宁可查不到，也不能把 A 模型的价格安到 B 头上。
 */
export function findPrice(pricing, model) {
    const segments = model.split('/');
    for (let i = 0; i < segments.length; i++) {
        const candidate = normalizeModel(segments.slice(i).join('/'));
        const hit = pricing.models[candidate];
        if (hit)
            return hit;
    }
    return pricing.models[normalizeModel(model)];
}
export function estimateCost(pricing, model, tokens) {
    const price = findPrice(pricing, model);
    if (!price)
        return { missing: true };
    const key = normalizeModel(model);
    const usd = toUsd(price, pricing.usdRates);
    const cached = usd.cached ?? usd.in;
    const usdCost = (tokens.in / 1_000_000) * usd.in +
        (tokens.out / 1_000_000) * usd.out +
        (tokens.cached / 1_000_000) * cached;
    const display = pricing.displayCurrency.toUpperCase() === 'USD'
        ? usdCost
        : usdCost * (pricing.usdRates[pricing.displayCurrency.toUpperCase()] ?? 1);
    return { cost: display, price, missing: false };
}
export function formatCurrency(pricing, v) {
    const cur = pricing.displayCurrency.toUpperCase();
    const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : `${cur} `;
    if (v === 0)
        return `${sym}0`;
    if (v < 0.01)
        return `${sym}${v.toFixed(4)}`;
    if (v < 1)
        return `${sym}${v.toFixed(3)}`;
    return `${sym}${v.toFixed(2)}`;
}
