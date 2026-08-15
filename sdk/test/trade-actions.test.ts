import { describe, expect, test } from 'bun:test';
import { BotActions } from '../actions';
import type { NearbyPlayer, TradeItem, TradeState } from '../types';

const partner: NearbyPlayer = {
    kind: 'player',
    index: 7,
    name: 'MuleBot',
    combatLevel: 3,
    x: 3222,
    z: 3222,
    distance: 1,
    reachable: true,
};

const CLOSED_TRADE: TradeState = {
    isOpen: false,
    screen: null,
    partner: null,
    myOffer: [],
    theirOffer: [],
    myAccepted: false,
    partnerAccepted: false,
};

const item = (slot: number, id: number, name: string, count: number): TradeItem => ({ slot, id, name, count });

interface Frame {
    trade?: Partial<TradeState>;
    inventory?: Array<{ slot: number; id: number; name: string; count: number }>;
    message?: string;
    tick?: number;
}

function state(frame: Frame, tick: number) {
    const trade: TradeState = { ...CLOSED_TRADE, ...(frame.trade ?? {}) };
    return {
        tick,
        revision: tick,
        player: { worldX: 3222, worldZ: 3222, lifeId: 1, isDead: false },
        inventory: frame.inventory ?? [],
        nearbyPlayers: [partner],
        nearbyNpcs: [],
        skills: [],
        gameMessages: frame.message
            ? [{ tick, text: frame.message, type: 0, sender: '', fromSelf: false }]
            : [],
        combatEvents: [],
        dialog: { isOpen: false, options: [], isWaiting: false },
        interface: trade.isOpen
            ? { isOpen: true, interfaceId: trade.screen === 'confirm' ? 3443 : 3323, options: [] }
            : { isOpen: false, interfaceId: -1, options: [] },
        shop: { isOpen: false },
        bank: { isOpen: false },
        trade,
    } as any;
}

/**
 * A bot whose state advances one frame per wait call. Messages accumulate is
 * not simulated - each frame carries its own gameMessages. sendDeclineTrade
 * fast-forwards to the last frame (the trade being closed), mirroring the
 * server closing both screens.
 */
function createHarness(frames: Frame[]) {
    const sequence = frames.map((frame, i) => state(frame, i + 1));
    let idx = 0;
    const dispatched: Array<{ call: string; args: unknown[] }> = [];
    const advance = () => {
        if (idx < sequence.length - 1) idx++;
        return sequence[idx];
    };
    const record = (call: string, effect?: () => void) => async (...args: unknown[]) => {
        dispatched.push({ call, args });
        effect?.();
        return { success: true, message: 'dispatched' };
    };
    const sdk: any = {
        getState: () => sequence[idx],
        getTradeState: () => sequence[idx].trade ?? CLOSED_TRADE,
        waitForStateChange: async () => advance(),
        waitForTicks: async () => advance(),
        waitForCondition: async (pred: (s: any) => boolean) => {
            for (let guard = 0; guard < sequence.length + 1; guard++) {
                if (pred(sequence[idx])) return sequence[idx];
                if (idx >= sequence.length - 1) break;
                idx++;
            }
            throw new Error('waitForCondition timed out');
        },
        findNearbyPlayer: (pattern: string | RegExp) => {
            const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
            return regex.test(partner.name) ? partner : null;
        },
        findInventoryItem: (pattern: string | RegExp) => {
            const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
            return sequence[idx].inventory.find((i: any) => regex.test(i.name)) ?? null;
        },
        sendTradeRequest: record('sendTradeRequest'),
        sendOfferItem: record('sendOfferItem'),
        sendAcceptTrade: record('sendAcceptTrade'),
        sendDeclineTrade: record('sendDeclineTrade', () => { idx = sequence.length - 1; }),
        waitForTradeRequest: async () => null,
    };
    return { bot: new BotActions(sdk), sdk, dispatched };
}

const logs = (count: number) => item(0, 1511, 'Logs', count);

describe('bot.trade gift flow', () => {
    test('offers, double-accepts, and reports the inventory delta', async () => {
        const inventoryBefore = [{ slot: 0, id: 1511, name: 'Logs', count: 1 }];
        const harness = createHarness([
            // 0: no trade yet, partner nearby
            { inventory: inventoryBefore },
            // 1: request answered, offer screen open
            { trade: { isOpen: true, screen: 'offer', partner: 'MuleBot' }, inventory: inventoryBefore },
            // 2: our logs are in the offer window
            { trade: { isOpen: true, screen: 'offer', partner: 'MuleBot', myOffer: [logs(1)] }, inventory: [] },
            // 3: both accepted -> confirm screen
            { trade: { isOpen: true, screen: 'confirm', partner: 'MuleBot', myOffer: [logs(1)] }, inventory: [] },
            // 4: trade completed
            { message: 'Accepted trade.', inventory: [] },
        ]);

        const result = await harness.bot.trade(partner, {
            give: [{ item: 'logs', amount: -1 }],
            timeout: 3_000,
        });

        expect(result.success).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(result.partner).toBe('MuleBot');
        expect(result.gave).toEqual([{ slot: -1, id: 1511, name: 'Logs', count: 1 }]);
        expect(result.received).toEqual([]);
        expect(harness.dispatched.map(d => d.call)).toEqual([
            'sendTradeRequest',
            'sendOfferItem',
            'sendAcceptTrade', // offer screen
            'sendAcceptTrade', // confirm screen
        ]);
        expect(harness.dispatched[1]).toEqual({ call: 'sendOfferItem', args: [0, -1] });
        expect(harness.dispatched[0]).toEqual({ call: 'sendTradeRequest', args: [partner.index] });
    });
});

describe('bot.trade want enforcement', () => {
    test('declines on the confirm screen when the final offer shrank', async () => {
        const lobsters = (n: number) => item(0, 379, 'Lobster', n);
        const harness = createHarness([
            { },
            // Offer screen shows 5 lobsters - passes the want check.
            { trade: { isOpen: true, screen: 'offer', partner: 'MuleBot', theirOffer: [lobsters(5)] } },
            // Confirm screen shows only 4 - the re-verification must catch this.
            { trade: { isOpen: true, screen: 'confirm', partner: 'MuleBot', theirOffer: [lobsters(4)] } },
            // Frame declineTrade jumps to: closed with the decline message.
            { message: 'Other player declined trade.' },
        ]);

        const result = await harness.bot.trade(partner, {
            want: [{ item: 'lobster', amount: 5 }],
            timeout: 3_000,
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('want_not_met');
        expect(harness.dispatched.map(d => d.call)).toEqual([
            'sendTradeRequest',
            'sendAcceptTrade',   // offer screen accept (offer looked fine there)
            'sendDeclineTrade',  // confirm screen re-check refused
        ]);
    });

    test('does not accept the offer screen until want is met', async () => {
        const harness = createHarness([
            { },
            // Offer screen with nothing offered - must NOT accept.
            { trade: { isOpen: true, screen: 'offer', partner: 'MuleBot' } },
            // Partner closes the trade.
            { message: 'Other player declined trade.' },
        ]);

        const result = await harness.bot.trade(partner, {
            want: [{ item: 'coins', amount: 100 }],
            timeout: 3_000,
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('declined');
        expect(harness.dispatched.map(d => d.call)).toEqual(['sendTradeRequest']);
    });
});

describe('bot.tradeWith failure modes', () => {
    test('reports a busy partner instead of waiting out the clock', async () => {
        const harness = createHarness([
            { },
            { message: 'MuleBot is busy at the moment.' },
        ]);

        const result = await harness.bot.tradeWith(partner, 3_000);
        expect(result).toMatchObject({ success: false, reason: 'busy' });
    });

    test('fails fast when the player is not nearby', async () => {
        const harness = createHarness([{ }]);
        const result = await harness.bot.tradeWith('NoSuchPlayer', 500);
        expect(result).toMatchObject({ success: false, reason: 'player_not_found' });
        expect(harness.dispatched).toEqual([]);
    });
});

describe('bot.serveTrades', () => {
    test('serves an incoming gift and stops on the until condition', async () => {
        const coins = (n: number) => item(0, 995, 'Coins', n);
        const harness = createHarness([
            { },
            { trade: { isOpen: true, screen: 'offer', partner: 'MuleBot', theirOffer: [coins(250)] } },
            { trade: { isOpen: true, screen: 'confirm', partner: 'MuleBot', theirOffer: [coins(250)] } },
            { message: 'Accepted trade.', inventory: [{ slot: 0, id: 995, name: 'Coins', count: 250 }] },
        ]);
        harness.sdk.waitForTradeRequest = async () => 'MuleBot';

        let served = false;
        const result = await harness.bot.serveTrades({
            from: /mule/i,
            onTrade: r => { served = r.success; },
            until: () => served,
            timeout: 5_000,
        });

        expect(result.success).toBe(true);
        expect(result.reason).toBe('until');
        expect(result.trades).toHaveLength(1);
        expect(result.trades[0]!.received).toEqual([{ slot: -1, id: 995, name: 'Coins', count: 250 }]);
        expect(harness.dispatched.map(d => d.call)).toEqual([
            'sendTradeRequest',  // requesting back = accepting
            'sendAcceptTrade',
            'sendAcceptTrade',
        ]);
    });

    test('ignores requesters that fail the from filter', async () => {
        const harness = createHarness([{ }]);
        let calls = 0;
        harness.sdk.waitForTradeRequest = async () => {
            calls++;
            return calls === 1 ? 'Stranger' : null;
        };

        const result = await harness.bot.serveTrades({ from: /^fleet_/i, timeout: 300 });
        expect(result.trades).toHaveLength(0);
        expect(harness.dispatched).toEqual([]);
    });
});
