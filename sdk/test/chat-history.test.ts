/**
 * Logic tests for the SDK chat system — no bot required.
 *
 * Covers the accumulated ChatHistory buffer (merge/dedup across state-sync
 * snapshots, publication-split edge case, page-reload cursor reset, retention cap) and
 * the SDK surface built on it (getChat, getNewChat cursor, getChatFrom,
 * waitForChat), driving the SDK through its real handleMessage path.
 */

import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { ChatHistory } from '../chat-history';
import type { GameMessage } from '../types';

function msg(tick: number, text: string, opts: Partial<GameMessage> = {}): GameMessage {
    return {
        type: opts.type ?? 2,
        text,
        sender: opts.sender ?? 'partner',
        tick,
        observationId: opts.observationId,
        fromSelf: opts.fromSelf ?? false,
    };
}

function texts(messages: GameMessage[]): string {
    return messages.map(m => m.text).join(',');
}

function pushState(sdk: BotSDK, gameMessages: GameMessage[]): void {
    (sdk as any).handleMessage(JSON.stringify({
        type: 'sdk_state',
        state: { gameMessages },
    }));
}

describe('ChatHistory.record()', () => {
    test('first snapshot recorded verbatim', () => {
        const h = new ChatHistory();
        const fresh = h.record([msg(10, 'a'), msg(11, 'b')]);

        expect(fresh).toHaveLength(2);
        expect(texts(h.all())).toBe('a,b');
    });

    test('overlapping snapshot only appends the new tail', () => {
        const h = new ChatHistory();
        h.record([msg(10, 'a'), msg(11, 'b')]);
        const fresh = h.record([msg(10, 'a'), msg(11, 'b'), msg(12, 'c')]);

        expect(texts(fresh)).toBe('c');
        expect(texts(h.all())).toBe('a,b,c');
    });

    test('identical snapshot (idle tick resync) appends nothing', () => {
        const h = new ChatHistory();
        h.record([msg(10, 'a'), msg(11, 'b')]);
        const fresh = h.record([msg(10, 'a'), msg(11, 'b')]);

        expect(fresh).toHaveLength(0);
        expect(h.all()).toHaveLength(2);
    });

    // A chat packet processed after the PLAYER_INFO that triggered the previous
    // sync shares its loopCycle. The surplus same-tick message must still land.
    test('picks up surplus messages sharing the last-held tick', () => {
        const h = new ChatHistory();
        h.record([msg(10, 'a'), msg(11, 'b1')]);
        const fresh = h.record([msg(10, 'a'), msg(11, 'b1'), msg(11, 'b2'), msg(12, 'c')]);

        expect(texts(fresh)).toBe('b2,c');
        expect(texts(h.all())).toBe('a,b1,b2,c');
    });

    test('keeps identical same-tick messages from later publications', () => {
        const h = new ChatHistory();
        h.record([msg(11, 'same', { observationId: 2 })]);
        const fresh = h.record([
            msg(11, 'same', { observationId: 2 }),
            msg(11, 'same', { observationId: 3 }),
        ]);

        expect(fresh).toHaveLength(1);
        expect(fresh[0]!.observationId).toBe(3);
        expect(h.all()).toHaveLength(2);
    });

    // Heavy spam slides the snapshot window clean past the held history.
    test('disjoint newer snapshot appends everything', () => {
        const h = new ChatHistory();
        h.record([msg(10, 'a'), msg(11, 'b')]);
        const fresh = h.record([msg(20, 'x'), msg(21, 'y')]);

        expect(texts(fresh)).toBe('x,y');
        expect(texts(h.all())).toBe('a,b,x,y');
    });

    // Page reload restarts loopCycle with a fresh ring — everything in the
    // snapshot is new rather than dropped forever.
    test('tick reset re-baselines instead of dropping messages', () => {
        const h = new ChatHistory();
        h.record([msg(30000, 'old1'), msg(30001, 'old2')]);
        const fresh = h.record([msg(5, 'new1'), msg(6, 'new2')]);

        expect(texts(fresh)).toBe('new1,new2');
        expect(texts(h.all())).toBe('old1,old2,new1,new2');
    });

    test('retention cap trims oldest and since() cursors survive trimming', () => {
        const h = new ChatHistory(3);
        h.record([msg(1, 'a'), msg(2, 'b')]);
        const cursor = h.seen;
        h.record([msg(3, 'c'), msg(4, 'd'), msg(5, 'e')]);

        expect(h.all()).toHaveLength(3);
        expect(texts(h.all())).toBe('c,d,e');
        expect(texts(h.since(cursor))).toBe('c,d,e');
        // Clamps when the cursor predates the retained buffer.
        expect(h.since(0)).toHaveLength(3);
    });

    test('empty snapshot is a no-op', () => {
        const h = new ChatHistory();
        h.record([msg(1, 'a')]);
        const fresh = h.record([]);

        expect(fresh).toHaveLength(0);
        expect(h.all()).toHaveLength(1);
    });
});

describe('BotSDK chat surface (via handleMessage)', () => {
    test('getChat retains messages evicted from the snapshot window', () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [msg(10, 'first')]);
        pushState(sdk, [msg(10, 'first'), msg(11, 'second')]);
        pushState(sdk, [msg(20, 'third')]); // window slid past 'first'/'second'

        expect(texts(sdk.getChat({ limit: 0 }))).toBe('first,second,third');
    });

    test('getChat defaults exclude system and self', () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [
            msg(10, 'sys', { type: 0, sender: '' }),
            msg(11, 'hello'),
            msg(12, 'me', { fromSelf: true, sender: 'test' }),
        ]);

        expect(texts(sdk.getChat())).toBe('hello');
        expect(texts(sdk.getChat({ types: [0] }))).toBe('sys');
        expect(texts(sdk.getChat({ includeSelf: true }))).toBe('hello,me');
    });

    test('getNewChat cursor never re-shows, and catches messages evicted between polls', () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [msg(10, 'a')]);

        expect(texts(sdk.getNewChat())).toBe('a');
        expect(sdk.getNewChat()).toHaveLength(0);

        pushState(sdk, [msg(10, 'a'), msg(11, 'b')]);
        pushState(sdk, [msg(20, 'c'), msg(21, 'd')]); // 'b' already out of window

        expect(texts(sdk.getNewChat())).toBe('b,c,d');
    });

    // Regression: the old tick-based cursor dropped same-tick late arrivals.
    test('getNewChat does not drop later same-tick messages', () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [msg(10, 'a')]);
        sdk.getNewChat();
        pushState(sdk, [msg(10, 'a'), msg(10, 'a2')]);

        expect(texts(sdk.getNewChat())).toBe('a2');
    });

    test('getChatFrom matches sender substring and ignores system messages', () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [
            msg(10, 'sys', { type: 0, sender: '' }),
            msg(11, 'hi', { sender: 'HelperBot' }),
            msg(12, 'yo', { sender: 'stranger' }),
        ]);

        expect(texts(sdk.getChatFrom('helper'))).toBe('hi');
        expect(sdk.getChatFrom('').every(m => m.sender !== '')).toBe(true);
    });

    test('showChat:false excludes player chat from history', () => {
        const sdk = new BotSDK({ botUsername: 'test', showChat: false });
        pushState(sdk, [msg(10, 'hello'), msg(11, 'sys', { type: 0, sender: '' })]);

        const retained = sdk.getChat({ limit: 0, types: [0, 1, 2, 3, 6, 7] });
        expect(retained.every(m => m.type === 0)).toBe(true);
    });

    test('waitForChat resolves with the first matching message', async () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [msg(10, 'before')]);

        const promise = sdk.waitForChat({ from: 'partner', matching: /ready/i, timeout: 2000 });
        pushState(sdk, [msg(10, 'before'), msg(11, 'noise', { sender: 'stranger' })]);
        pushState(sdk, [
            msg(11, 'noise', { sender: 'stranger' }),
            msg(12, 'READY to go', { sender: 'Partner' }),
        ]);

        const got = await promise;
        expect(got).not.toBeNull();
        expect(got!.text).toBe('READY to go');
    });

    test('waitForChat ignores messages that arrived before the call', async () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, [msg(10, 'ready')]);

        expect(await sdk.waitForChat({ matching: /ready/, timeout: 100 })).toBeNull();
    });

    test('waitForChat excludes own messages by default', async () => {
        const sdk = new BotSDK({ botUsername: 'test' });
        pushState(sdk, []);

        const promise = sdk.waitForChat({ matching: /ping/, timeout: 100 });
        pushState(sdk, [msg(11, 'ping', { fromSelf: true, sender: 'test' })]);

        expect(await promise).toBeNull();
    });
});
