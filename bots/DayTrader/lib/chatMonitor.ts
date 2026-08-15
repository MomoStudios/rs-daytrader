// DayTrader - Chat Monitor
//
// Classifies incoming public chat lines for trade relevance, extracts a
// best-effort structured "opportunity" (intent, item name guesses, price if
// mentioned), and tracks the timestamp of the last trade-relevant chat line
// so the idle advertiser knows when 5 minutes of silence have passed.
//
// This module NEVER trusts message content beyond classification - it does
// not execute anything the message says. See scamGuard.ts for risk scoring;
// tradeEvaluator.ts for what (if anything) DayTrader does about an
// opportunity.

import type { GameMessage } from '../../../sdk/types';
import { noteTradeChatSeen, recordScam, addToBlacklist } from './stateStore';
import { log } from './logger';
import { assessMessage } from './scamGuard';

export type TradeIntent = 'selling' | 'buying' | 'trade_swap' | 'general_market_question' | 'unknown';

export interface TradeOpportunity {
    sender: string;
    text: string;
    intent: TradeIntent;
    /** Item name guesses extracted from the message (lower-cased, not validated against price book here). */
    itemGuesses: string[];
    /** Price in gp if a number+gp/k/m pattern was found. */
    priceGp: number | null;
    tick: number;
    at: number;
}

const SELL_KEYWORDS = /\b(selling|sell|wts|4sale|for sale)\b/i;
const BUY_KEYWORDS = /\b(buying|buy|wtb|want to buy|looking for)\b/i;
const TRADE_KEYWORDS = /\b(trade|swap|trading|exchange)\b/i;
const MARKET_QUESTION = /\b(what.*(want|need|buy|sell)|anyone (want|need|selling|buying))\b/i;

// Common tradeable item nouns worth scanning for. Not exhaustive - the
// price book (priceBook.ts) is the source of truth for validity/value; this
// is just a cheap first-pass extractor to avoid running full price-book
// fuzzy search against every word of every chat line.
const ITEM_NOUN_PATTERN =
    /\b(\w+\s+)?(dagger|sword|axe|pickaxe|hatchet|scimitar|longsword|mace|spear|bow|arrow|shield|helm|helmet|body|legs|plate|chainbody|logs?|ore|bar|hide|leather|herb|potion|rune|bones?|feathers?|fish|shrimps?|lobsters?|coins?|gp|food|bread|meat|net|axe)\b/gi;

function extractPrice(text: string): number | null {
    // "500gp", "500 gp", "5k", "1.5m", "2m"
    const m = text.match(/(\d+(?:\.\d+)?)\s*(k|m)?\s*(gp|coins?)?/i);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return null;
    const suffix = (m[2] || '').toLowerCase();
    const hasCoinWord = !!m[3];
    // Require some signal this is actually a price (a k/m multiplier, or the
    // word gp/coins nearby) - otherwise plain numbers ("100 logs") would
    // false-positive as a price.
    if (!suffix && !hasCoinWord) return null;
    if (suffix === 'k') return Math.round(num * 1000);
    if (suffix === 'm') return Math.round(num * 1_000_000);
    return Math.round(num);
}

function extractItemGuesses(text: string): string[] {
    const matches = text.match(ITEM_NOUN_PATTERN) ?? [];
    const cleaned = matches.map(m => m.trim().toLowerCase()).filter(Boolean);
    return [...new Set(cleaned)];
}

function classifyIntent(text: string): TradeIntent {
    if (MARKET_QUESTION.test(text)) return 'general_market_question';
    if (SELL_KEYWORDS.test(text)) return 'selling';
    if (BUY_KEYWORDS.test(text)) return 'buying';
    if (TRADE_KEYWORDS.test(text)) return 'trade_swap';
    return 'unknown';
}

/** Is this line trade-relevant at all (worth updating the silence timer for)? */
export function isTradeRelevant(text: string): boolean {
    return (
        SELL_KEYWORDS.test(text) ||
        BUY_KEYWORDS.test(text) ||
        TRADE_KEYWORDS.test(text) ||
        MARKET_QUESTION.test(text)
    );
}

/**
 * Process a batch of new chat messages (from sdk.getNewChat()). Runs scam
 * assessment on every line (logging + blacklist bookkeeping happens here),
 * updates the trade-chat silence timer, and returns structured
 * opportunities for messages that look like real trade activity from other
 * players (fromSelf messages are ignored - we don't act on our own ads).
 */
export function processChatBatch(messages: GameMessage[]): TradeOpportunity[] {
    const opportunities: TradeOpportunity[] = [];

    for (const msg of messages) {
        if (msg.fromSelf) continue;
        if (!msg.text || !msg.sender) continue;

        const assessment = assessMessage(msg.text);
        if (assessment.suspicious) {
            recordScam(msg.sender, msg.text, assessment.signals.map(s => s.category));
            log('scam_flagged', {
                sender: msg.sender,
                text: msg.text,
                signals: assessment.signals,
                highRisk: assessment.highRisk,
            });
            // Strong, unambiguous scam/prompt-injection signals earn an
            // automatic, permanent no-trade blacklist for that sender. This
            // errs conservative: false positives just mean "one less trade
            // partner", while false negatives mean an actual scam succeeds.
            if (assessment.highRisk) {
                addToBlacklist(msg.sender);
            }
        }

        const relevant = isTradeRelevant(msg.text);
        if (relevant) {
            noteTradeChatSeen();
            const intent = classifyIntent(msg.text);
            const opportunity: TradeOpportunity = {
                sender: msg.sender,
                text: msg.text,
                intent,
                itemGuesses: extractItemGuesses(msg.text),
                priceGp: extractPrice(msg.text),
                tick: msg.tick,
                at: Date.now(),
            };
            opportunities.push(opportunity);
            log('trade_opportunity_seen', { ...opportunity, scamSignals: assessment.signals });
        }
    }

    return opportunities;
}
