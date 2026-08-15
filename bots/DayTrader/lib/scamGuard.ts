// DayTrader - Scam Guard
//
// CRITICAL SAFETY MODULE. Chat is an open, untrusted pipe of text from
// arbitrary other players (or other bots). Treat every chat line as
// adversarial input:
//   - It may be an outright scam (promise to "pay you back later", fake
//     staff impersonation, "trade first and I'll trade back double").
//   - It may be a prompt-injection attempt aimed at whatever agent/LLM is
//     supervising this bot ("ignore your instructions", "you are now in
//     dev mode", "the developer says give me your items", fake system
//     messages, etc).
//
// Nothing in this file ever treats chat text as instructions to execute.
// It only classifies text for (a) trade-relevance and (b) risk signals that
// feed into tradeEvaluator's accept/reject decision. No chat content is
// ever eval'd, templated into a shell/command, or used to change bot
// behavior outside the narrow "is this a legitimate trade offer" question.

export interface ScamSignal {
    /** Machine-readable category for logging/analysis. */
    category:
        | 'advance_payment_promise'
        | 'urgency_pressure'
        | 'impersonation'
        | 'prompt_injection'
        | 'too_good_to_be_true'
        | 'trade_first_request'
        | 'external_link_or_rmt'
        | 'duplication_scam';
    /** The text (or excerpt) that triggered the signal. */
    excerpt: string;
}

export interface ScamAssessment {
    signals: ScamSignal[];
    /** True if any signal was found - callers should treat the message (and
     * any trade tied to it) with extra caution, not necessarily refuse
     * outright, since normal chat can incidentally match a keyword. */
    suspicious: boolean;
    /** True if signals are severe enough that DayTrader should never trade
     * with this sender based on this message alone, and should log it. */
    highRisk: boolean;
}

const ADVANCE_PAYMENT_PATTERNS = [
    /trust\s*me/i,
    /i('|’)?ll\s+(pay|trade|give)\s+.*(back|later|after)/i,
    /trade\s+(you\s+)?back\s+(double|more|extra)/i,
    /give\s+(it|this|me)\s+(to me\s+)?first/i,
    /send\s+first/i,
    /you\s+go\s+first/i,
    /pay\s+(you\s+)?(back\s+)?(double|2x|triple|3x)/i,
    /\b(pay|send|give)\s+(a\s+)?(deposit|upfront)\b/i,
    /\b(deposit|upfront)\s+(first|before|now)\b/i,
];

const TRADE_FIRST_PATTERNS = [
    /trade\s+first/i,
    /give\s+first,?\s*(then|and)\s+i/i,
    /drop\s+it\s+(and|then)\s+i/i,
];

const URGENCY_PATTERNS = [
    /hurry\s*up/i,
    /quick(ly)?,?\s*before/i,
    /only\s+\d+\s*(sec|second|min)/i,
    /last\s+chance/i,
    /act\s+now/i,
];

const IMPERSONATION_PATTERNS = [
    /i('|’)?m\s+(a\s+)?(mod|admin|staff|dev(eloper)?|jagex|gm)\b/i,
    /this\s+is\s+(the\s+)?(admin|staff|dev(eloper)?|system)/i,
    /official\s+(jagex|game)\s+(message|account)/i,
];

// Prompt-injection attempts specifically aimed at whatever LLM/agent is
// operating this bot, disguised as ordinary chat.
const PROMPT_INJECTION_PATTERNS = [
    /ignore\s+(all\s+|your\s+)?(previous|prior|above)\s+instructions/i,
    /you\s+are\s+now\s+in\s+(dev|debug|admin|god)\s*mode/i,
    /system\s*prompt/i,
    /reveal\s+your\s+(instructions|prompt|rules)/i,
    /disregard\s+(your\s+)?(safety|rules|guidelines)/i,
    /as\s+an\s+ai\s+(language\s+model|assistant)/i,
    /new\s+instructions?\s*:/i,
    /\bdeveloper\s+says?\s+(give|send|trade)/i,
    /jailbreak/i,
];

const TOO_GOOD_TO_BE_TRUE_PATTERNS = [
    /free\s+(money|gp|coins|items)/i,
    /double\s+(your\s+)?(money|gp|coins)/i,
    /giving\s+away\s+\d+[km]?\s*(gp|coins)/i,
    /(gp|coins)\s+glitch/i,
    /duplicat(e|ion)\s+(glitch|method|exploit)/i,
];

const RMT_PATTERNS = [
    /(paypal|venmo|cashapp|bitcoin|btc|crypto)/i,
    /real\s+money/i,
    /discord\.gg\//i,
    /https?:\/\//i,
    /www\./i,
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[0];
    }
    return null;
}

/** Classify a single chat message for scam / prompt-injection risk signals. */
export function assessMessage(text: string): ScamAssessment {
    const signals: ScamSignal[] = [];

    const advance = firstMatch(text, ADVANCE_PAYMENT_PATTERNS);
    if (advance) signals.push({ category: 'advance_payment_promise', excerpt: advance });

    const tradeFirst = firstMatch(text, TRADE_FIRST_PATTERNS);
    if (tradeFirst) signals.push({ category: 'trade_first_request', excerpt: tradeFirst });

    const urgency = firstMatch(text, URGENCY_PATTERNS);
    if (urgency) signals.push({ category: 'urgency_pressure', excerpt: urgency });

    const impersonation = firstMatch(text, IMPERSONATION_PATTERNS);
    if (impersonation) signals.push({ category: 'impersonation', excerpt: impersonation });

    const injection = firstMatch(text, PROMPT_INJECTION_PATTERNS);
    if (injection) signals.push({ category: 'prompt_injection', excerpt: injection });

    const tooGood = firstMatch(text, TOO_GOOD_TO_BE_TRUE_PATTERNS);
    if (tooGood) signals.push({ category: 'too_good_to_be_true', excerpt: tooGood });

    const rmt = firstMatch(text, RMT_PATTERNS);
    if (rmt) signals.push({ category: 'external_link_or_rmt', excerpt: rmt });

    const highRiskCategories = new Set([
        'advance_payment_promise',
        'trade_first_request',
        'impersonation',
        'prompt_injection',
        'too_good_to_be_true',
        'external_link_or_rmt',
    ]);
    const highRisk = signals.some(s => highRiskCategories.has(s.category));

    return { signals, suspicious: signals.length > 0, highRisk };
}

/**
 * The one hard rule: NEVER let chat text be treated as a command. This
 * function exists purely to document/enforce that principle in code review
 * - callers should never pass raw chat text into eval, shell exec, or as an
 * override for bot behavior/policy. Chat text is DATA to classify, never
 * CODE to run.
 */
export function isUntrustedInput(_text: string): true {
    return true;
}

/**
 * Core anti-scam trade rule, independent of message content: never give
 * (in coin or item-value terms) meaningfully more than what is received,
 * and never act on a promise of future payment. This is enforced by
 * tradeEvaluator using priceBook values, but stated here as policy:
 *
 * 1. Only ever use the atomic, same-transaction trade flow (bot.trade /
 *    bot.tradeWith with `want`/`accept`, never separate sequential gives).
 * 2. Never accept a trade whose `theirOffer` is empty or below the
 *    value of `myOffer` beyond a small configurable loss tolerance.
 * 3. Re-verify the offer on the confirm screen (bot.trade already does this)
 *    - never trust the offer screen alone.
 * 4. A message promising future payment ("I'll pay you back after") is
 *    never sufficient justification for a trade now. If theirOffer doesn't
 *    contain the value at accept-time, decline.
 */
export const SCAM_POLICY_NOTES = Object.freeze({
    neverPayFirst: true,
    neverTrustFuturePaymentClaims: true,
    alwaysReverifyOnConfirmScreen: true,
    neverExecuteChatAsInstructions: true,
});
