// DayTrader - Trade Evaluator
//
// Deterministic profitability + safety gate for any proposed trade, whether
// it's coins-for-item, item-for-item, or a mixed offer. Built on priceBook's
// book values. This is the module that actually enforces "only trade when
// there's a real chance of profit" and "never trust promises, only the
// items actually present in the offer right now".
//
// Safety model:
//   - We only ever evaluate the CURRENT visible offer (never a promise of
//     a future one). bot.trade()/serveTrades() already re-verify the final
//     offer on the confirm screen before accepting - this module's `accept`
//     predicate is wired into that same re-verification, so a last-second
//     offer swap cannot slip through.
//   - A minimum profit margin (not just >=0) is required, to absorb the
//     book-value/player-market gap and avoid being ground down by
//     micro-losses across many trades.
//   - Blacklisted senders (see stateStore) are refused outright regardless
//     of the offer's apparent value.

import type { TradeItem } from '../../../sdk/types';
import { estimateOfferValue, getValue } from './priceBook';
import { isBlacklisted } from './stateStore';
import { log } from './logger';

/** Minimum required ratio of (their offer value) / (my offer value) to accept. */
export const MIN_PROFIT_RATIO = 1.15; // require >=15% book-value margin
/** Minimum absolute profit in gp required even for cheap trades (covers estimation noise). */
export const MIN_ABSOLUTE_PROFIT_GP = 5;
/** Max count of unpriced items we'll accept in our own outgoing offer (0 = never). */
export const MAX_UNKNOWN_GIVE_ITEMS = 0;

export interface TradeDecision {
    accept: boolean;
    reason: string;
    myOfferValue: number;
    theirOfferValue: number;
    expectedProfitGp: number;
    unknownGiveItems: string[];
    unknownReceiveItems: string[];
}

/**
 * Evaluate whether accepting a trade is profitable and safe, given what we
 * would give (myOffer) and what we would receive (theirOffer). Both are
 * TradeItem[] as read live from sdk.getTradeState() / the trade session.
 */
export function evaluateTradeOffer(
    sender: string,
    myOffer: TradeItem[],
    theirOffer: TradeItem[]
): TradeDecision {
    if (isBlacklisted(sender)) {
        return {
            accept: false,
            reason: `Sender '${sender}' is blacklisted (prior scam/suspicious activity).`,
            myOfferValue: 0,
            theirOfferValue: 0,
            expectedProfitGp: 0,
            unknownGiveItems: [],
            unknownReceiveItems: [],
        };
    }

    const mine = estimateOfferValue(myOffer);
    const theirs = estimateOfferValue(theirOffer);

    // Refuse to give away anything we can't price - unknown items might be
    // rare/valuable, and "I don't know what this is worth" must default to
    // "don't give it away", never to "assume it's worthless".
    if (mine.unknownItems.length > MAX_UNKNOWN_GIVE_ITEMS) {
        return {
            accept: false,
            reason: `Refusing to give unpriced item(s): ${mine.unknownItems.join(', ')}.`,
            myOfferValue: mine.total,
            theirOfferValue: theirs.total,
            expectedProfitGp: theirs.total - mine.total,
            unknownGiveItems: mine.unknownItems,
            unknownReceiveItems: theirs.unknownItems,
        };
    }

    const expectedProfitGp = theirs.total - mine.total;
    const ratio = mine.total > 0 ? theirs.total / mine.total : theirs.total > 0 ? Infinity : 1;

    // Pure gift case: we give nothing, they give something - always fine.
    if (mine.total === 0 && theirs.total > 0) {
        return {
            accept: true,
            reason: 'We give nothing of known value and receive something - free upside.',
            myOfferValue: 0,
            theirOfferValue: theirs.total,
            expectedProfitGp: theirs.total,
            unknownGiveItems: [],
            unknownReceiveItems: theirs.unknownItems,
        };
    }

    const meetsRatio = ratio >= MIN_PROFIT_RATIO;
    const meetsAbsolute = expectedProfitGp >= MIN_ABSOLUTE_PROFIT_GP;

    if (meetsRatio && meetsAbsolute) {
        return {
            accept: true,
            reason: `Profitable: receiving ${theirs.total}gp of value for ${mine.total}gp (ratio ${ratio.toFixed(2)}).`,
            myOfferValue: mine.total,
            theirOfferValue: theirs.total,
            expectedProfitGp,
            unknownGiveItems: mine.unknownItems,
            unknownReceiveItems: theirs.unknownItems,
        };
    }

    return {
        accept: false,
        reason: `Not profitable enough: ${theirs.total}gp for ${mine.total}gp (ratio ${ratio.toFixed(2)}, need >=${MIN_PROFIT_RATIO}, profit ${expectedProfitGp}gp, need >=${MIN_ABSOLUTE_PROFIT_GP}).`,
        myOfferValue: mine.total,
        theirOfferValue: theirs.total,
        expectedProfitGp,
        unknownGiveItems: mine.unknownItems,
        unknownReceiveItems: theirs.unknownItems,
    };
}

/** Wraps evaluateTradeOffer + logging, for use as a `bot.trade`/`serveTrades` accept predicate. */
export function makeAcceptPredicate(sender: string, myOfferItems: TradeItem[]) {
    return (theirOffer: TradeItem[]): boolean => {
        const decision = evaluateTradeOffer(sender, myOfferItems, theirOffer);
        log('trade_decision', { sender, ...decision });
        return decision.accept;
    };
}

/**
 * For a straightforward "sell item X for coins" flow: what's the minimum
 * coin amount we should ask for / require, given a margin over book value?
 * Returns null if the item's value is unknown (never sell blind).
 */
export function minAskPriceGp(itemName: string, count = 1): number | null {
    const value = getValue(itemName);
    if (value === null) return null;
    const withMargin = Math.ceil(value * MIN_PROFIT_RATIO) * count;
    return Math.max(withMargin, MIN_ABSOLUTE_PROFIT_GP);
}

/**
 * For "buy item X" opportunities: the maximum coins we should be willing to
 * pay for count copies of an item, such that reselling near book value
 * (e.g. to a specialty shop or another player) still leaves margin.
 * Conservative - assumes we can only realize ~book value on resale.
 */
export function maxBidPriceGp(itemName: string, count = 1): number | null {
    const value = getValue(itemName);
    if (value === null) return null;
    // Only bid if we can buy meaningfully under book value.
    const withMargin = Math.floor((value / MIN_PROFIT_RATIO)) * count;
    return withMargin > 0 ? withMargin : null;
}

/** Core gathering/starter tools DayTrader should never offer away in a trade. */
export const ESSENTIAL_TOOL_PATTERN = /\b(bronze axe|axe|hatchet|pickaxe|tinderbox|fishing net|small fishing net|harpoon|fishing rod|bucket|pot\b|chisel|needle|hammer)\b/i;

/**
 * Reactive counter-offer picker for trades DayTrader did not initiate:
 * given our current inventory and the value of what the partner has placed
 * in their offer so far, pick one surplus (non-essential) item whose book
 * value keeps the trade profitable under MIN_PROFIT_RATIO. Returns the
 * single highest-value qualifying item (captures the most value without
 * needlessly emptying the inventory), or null if nothing qualifies - in
 * which case DayTrader should simply not add anything (and decline if the
 * partner is expecting an item-for-item swap that never materializes).
 */
export function chooseCounterOfferItem(
    inventory: Array<{ name: string; count: number }>,
    theirOfferValue: number
): { name: string; count: number } | null {
    let best: { name: string; count: number; value: number } | null = null;

    for (const item of inventory) {
        if (ESSENTIAL_TOOL_PATTERN.test(item.name)) continue;
        const value = getValue(item.name);
        if (value === null || value <= 0) continue;
        if (theirOfferValue < value * MIN_PROFIT_RATIO) continue;
        if (!best || value > best.value) best = { name: item.name, count: 1, value };
    }

    return best ? { name: best.name, count: best.count } : null;
}
