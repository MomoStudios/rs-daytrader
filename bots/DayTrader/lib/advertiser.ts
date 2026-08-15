// DayTrader - Idle Advertiser
//
// If 5 minutes pass with no trade-relevant chat, DayTrader crafts a message
// designed to surface trading opportunities. Templates range from direct
// ("selling iron dagger") to roundabout ("anyone interested in buying iron
// items?") to open-ended ("what sort of things do you all want to buy?").
// We rotate through styles and record which ones got a response so the
// mix can be tuned over time from data/state.json rather than guesswork.

import { getState, recordAd } from './stateStore';
import { log } from './logger';

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

export type AdTemplateStyle = 'direct' | 'roundabout' | 'open_ended';

interface AdTemplate {
    style: AdTemplateStyle;
    /** Build the message text. Receives current sellable items (names) if any are known. */
    build: (context: AdContext) => string;
}

export interface AdContext {
    /** Names of items currently in inventory that look sellable (excess tools/resources). */
    sellableItems: string[];
}

const TEMPLATES: AdTemplate[] = [
    {
        style: 'direct',
        build: ctx =>
            ctx.sellableItems.length > 0
                ? `Selling ${ctx.sellableItems.slice(0, 3).join(', ')} - message me an offer!`
                : `Got some spare gear, message me if you're after something specific.`,
    },
    {
        style: 'roundabout',
        build: ctx =>
            ctx.sellableItems.length > 0
                ? `Anyone interested in buying ${ctx.sellableItems[0]}? Also open to trades.`
                : `Anyone buying or selling anything interesting right now?`,
    },
    {
        style: 'open_ended',
        build: () => `What sort of things do you all want to buy or sell? Trying to find a good trade.`,
    },
];

let templateCursor = 0;

/**
 * Pick the next ad template in rotation. Simple round-robin for now; the
 * response-rate data recorded in state.adHistory (gotResponseWithinMs) can
 * later be used to weight the rotation toward whatever style is working,
 * without needing new code - just a different selection function reading
 * the same data.
 */
function pickTemplate(): AdTemplate {
    const t = TEMPLATES[templateCursor % TEMPLATES.length];
    templateCursor += 1;
    return t;
}

export function shouldAdvertise(): boolean {
    const state = getState();
    const sinceChat = Date.now() - state.lastTradeChatTime;
    const sinceAd = Date.now() - state.lastAdTime;
    // Don't spam: even if silence continues, wait at least 5 minutes between ads too.
    return sinceChat >= FIVE_MINUTES_MS && sinceAd >= FIVE_MINUTES_MS;
}

export function craftAdvertisement(context: AdContext): { message: string; style: AdTemplateStyle } {
    const template = pickTemplate();
    const message = template.build(context);
    return { message, style: template.style };
}

/** Craft and record an ad in one step (recording is what powers response tracking). */
export function craftAndRecordAdvertisement(context: AdContext): string {
    const { message, style } = craftAdvertisement(context);
    recordAd(message, style);
    log('ad_sent', { message, style, context });
    return message;
}
