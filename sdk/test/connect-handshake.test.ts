// connect() must settle for every gateway behavior - the handshake deadline
// covers socket open AND the sdk_connected/sdk_error answer. The old
// implementation cleared its only timer on socket open, so a gateway that
// accepted the socket but never answered (dead session, half-open TCP during
// an outage) parked connect() forever while every liveness signal read
// healthy (bug report mscll1sc).

import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';

import { BotSDK } from '../index';

type GatewayScript = (ws: { send(data: string): void; close(): void }) => void;

let server: Server | null = null;

/** A one-shot fake gateway whose sdk_connect response is scripted per test. */
function fakeGateway(onConnect: GatewayScript): string {
    server = Bun.serve({
        port: 0,
        fetch(req, srv) {
            if (srv.upgrade(req)) return;
            return new Response('not a websocket', { status: 400 });
        },
        websocket: {
            message(ws, raw) {
                const msg = JSON.parse(String(raw));
                if (msg.type === 'sdk_connect') {
                    onConnect(ws);
                }
            }
        }
    });
    return `ws://localhost:${server.port}`;
}

function makeSDK(gatewayUrl: string, connectTimeout: number): BotSDK {
    return new BotSDK({
        botUsername: 'testbot',
        password: 'x',
        gatewayUrl,
        connectTimeout,
        readyTimeout: 0, // settle at the handshake; no game state in these tests
        autoReconnect: false,
        autoLaunchBrowser: false
    });
}

afterEach(() => {
    server?.stop(true);
    server = null;
});

describe('connect() handshake', () => {
    test('resolves when the gateway answers sdk_connected', async () => {
        const url = fakeGateway(ws => ws.send(JSON.stringify({ type: 'sdk_connected', success: true })));
        const sdk = makeSDK(url, 2000);
        await sdk.connect();
        expect(sdk.isConnected()).toBe(true);
        await sdk.disconnect();
    });

    test('rejects when the gateway answers sdk_error', async () => {
        const url = fakeGateway(ws => ws.send(JSON.stringify({ type: 'sdk_error', error: 'Authentication failed: bad password' })));
        const sdk = makeSDK(url, 2000);
        await expect(sdk.connect()).rejects.toThrow(/Authentication failed/);
    });

    test('rejects at the deadline when the gateway accepts the socket but never answers', async () => {
        const url = fakeGateway(() => { /* accept sdk_connect, say nothing */ });
        const sdk = makeSDK(url, 300);
        const start = Date.now();
        await expect(sdk.connect()).rejects.toThrow(/handshake timed out/);
        expect(Date.now() - start).toBeLessThan(2000); // settled by the deadline, not a socket timeout
    });

    test('rejects promptly when the socket closes before the handshake completes', async () => {
        const url = fakeGateway(ws => ws.close());
        const sdk = makeSDK(url, 5000);
        const start = Date.now();
        await expect(sdk.connect()).rejects.toThrow(/closed before the gateway handshake/);
        expect(Date.now() - start).toBeLessThan(1000); // the close settles it, not the deadline
    });
});
