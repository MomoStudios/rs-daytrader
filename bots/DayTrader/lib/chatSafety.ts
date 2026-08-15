import { assessMessage } from './scamGuard';

// AI replies are for conversation and clarification only. Anything that forms
// or promises a transaction must use offer_buy/offer_sell, whose inventory and
// price are checked deterministically before a message is sent.
const TRANSACTIONAL_REPLY_PATTERNS = [
    /\b\d+(?:\.\d+)?\s*(?:k|m)?\s*(?:gp|coins?)\b/i,
    /\b(deposit|upfront|meet|bring|deliver|can do)\b/i,
    /\bi(?:'ll| will)\b/i,
    /\b(pay|send|give)\s+(?:me|you|him|her|them)\b/i,
];

export function normalizeOutgoingMessage(message: string): string {
    const normalized = message.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 140) throw new Error('AI message is empty or too long');
    const assessment = assessMessage(normalized);
    if (assessment.suspicious) {
        throw new Error(`AI message triggered safety categories: ${assessment.signals.map(s => s.category).join(', ')}`);
    }
    return normalized;
}

export function validateConversationalReply(message: string): string {
    const normalized = normalizeOutgoingMessage(message);
    if (TRANSACTIONAL_REPLY_PATTERNS.some(pattern => pattern.test(normalized))) {
        throw new Error('AI reply contains a transaction, future commitment, deposit, delivery, or meeting');
    }
    return normalized;
}
