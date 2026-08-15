#!/usr/bin/env bun
// SDK Chat CLI - send and read chat without taking control of the bot
//
// Connects in 'observe' mode: the gateway lets observers dispatch 'say' (and
// nothing else), and observers neither pre-empt nor get pre-empted by whatever
// controller currently owns the bot. Safe to use while a script is running.
//
// Usage:
//   bun sdk/chat.ts <botname>                    # Show recent chat
//   bun sdk/chat.ts <botname> <message...>       # Send a message
//   bun sdk/chat.ts <botname> --watch            # Tail chat live (Ctrl+C to stop)

import { BotSDK, deriveGatewayUrl } from './index';
import type { GameMessage } from './types';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function printUsage() {
    console.log(`
SDK Chat CLI - send and read chat without stealing bot control

Usage:
  bun sdk/chat.ts <botname>                 # Show recent chat
  bun sdk/chat.ts <botname> <message...>    # Send a message
  bun sdk/chat.ts <botname> --watch         # Tail chat live (Ctrl+C to stop)

Options:
  --limit <n>       Messages of history to show (default: 20)
  --system          Include system/game messages, not just player chat
  --server <host>   Server hostname (default: from bot.env or rs-sdk-demo.fly.dev)
  --timeout <ms>    Budget for connecting / first state (default: 5000)
  --help            Show this help

Examples:
  bun sdk/chat.ts mybot "meet me at the bank"
  bun sdk/chat.ts mybot --watch
  bun sdk/chat.ts mybot --limit 50 --system

Sending requires a game client (browser or lite) to be logged in as the bot;
this tool only relays chat through it. Reading works off the same state feed
observers get.
`.trim());
}

/** Same bot.env resolution as sdk/cli.ts. */
function tryLoadBotEnv(botName: string): { username: string; password: string; server?: string } | null {
    const envPath = join(process.cwd(), 'bots', botName, 'bot.env');
    if (!existsSync(envPath)) return null;

    const content = readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
        }
    }

    if (!env.BOT_USERNAME || !env.PASSWORD) return null;

    return {
        username: env.BOT_USERNAME,
        password: env.PASSWORD,
        server: env.SERVER
    };
}

function formatMessage(m: GameMessage): string {
    if (m.type === 0) return `* ${m.text}`;
    if (m.type === 3 || m.type === 7) return `[PM from ${m.sender}] ${m.text}`;
    if (m.type === 6) return `[PM to ${m.sender}] ${m.text}`;
    return `${m.sender}: ${m.text}`;
}

const PLAYER_AND_SYSTEM_TYPES = [0, 1, 2, 3, 6, 7] as const;

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        process.exit(args.length === 0 ? 1 : 0);
    }

    let server = '';
    let timeout = 5000;
    let limit = 20;
    let watch = false;
    let system = false;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else if (arg === '--watch') {
            watch = true;
        } else if (arg === '--system') {
            system = true;
        } else if (arg === '--server') {
            server = args[++i] || '';
        } else if (arg === '--timeout') {
            timeout = parseInt(args[++i] || '', 10) || timeout;
        } else if (arg === '--limit') {
            limit = parseInt(args[++i] || '', 10) || limit;
        } else {
            positional.push(arg);
        }
    }

    const botName = positional[0];
    if (!botName) {
        console.error('Error: Bot name required');
        process.exit(1);
    }
    const messageToSend = positional.slice(1).join(' ');

    let username = botName;
    let password = process.env.PASSWORD || '';
    const botEnv = tryLoadBotEnv(botName);
    if (botEnv) {
        username = botEnv.username;
        password = botEnv.password;
        if (botEnv.server && !server) server = botEnv.server;
    }
    if (!server) server = process.env.SERVER || 'rs-sdk-demo.fly.dev';

    const isLocal = server === 'localhost' || server.startsWith('localhost:');
    if (!password && !isLocal) {
        console.error('Error: Password required for remote servers');
        process.exit(1);
    }

    const gatewayUrl = deriveGatewayUrl(server);

    const sdk = new BotSDK({
        botUsername: username,
        password,
        gatewayUrl,
        connectionMode: 'observe',
        autoReconnect: watch,       // one-shots fail fast; watch survives blips
        autoLaunchBrowser: false,
        readyTimeout: 0,
        showChat: true
    });

    try {
        const connectTimeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout')), timeout);
        });
        await Promise.race([sdk.connect(), connectTimeout]);
    } catch (err: any) {
        console.error(`Error: Failed to connect to ${gatewayUrl}`);
        console.error(`  ${err.message}`);
        process.exit(1);
    }

    if (messageToSend) {
        const results = await sdk.say(messageToSend);
        let ok = true;
        for (const result of results) {
            if (result.success) {
                const data = result.data as { finalText?: string; truncated?: boolean; filtered?: boolean } | undefined;
                console.log(`Sent: ${data?.finalText ?? messageToSend}`);
                if (data?.truncated) console.log('  (truncated by server cap)');
                if (data?.filtered) console.log('  (altered by word filter)');
            } else {
                ok = false;
                console.error(`Error: Failed to send: ${result.message}`);
                if (/bot not connected/i.test(result.message)) {
                    console.error(`  No game client is logged in as '${username}' - chat is relayed through it.`);
                    console.error(`  Log the bot in (browser or lite client), then retry.`);
                }
            }
        }
        sdk.disconnect();
        process.exit(ok ? 0 : 1);
    }

    // Reading (history or watch) needs the state feed.
    const types = system ? PLAYER_AND_SYSTEM_TYPES : undefined;
    try {
        await sdk.waitForCondition(s => s !== null, timeout);
    } catch {
        if (sdk.isAuthenticated()) {
            console.error(`Error: No game state for '${username}' - nothing is logged in as this bot, so there's no chat feed.`);
        } else {
            console.error(`Error: No state received for '${username}'`);
        }
        sdk.disconnect();
        process.exit(1);
    }

    const history = sdk.getChat({ limit, types, includeSelf: true });
    if (history.length === 0) {
        console.log('(no chat in recent history)');
    }
    for (const m of history) {
        console.log(formatMessage(m));
    }
    // Drain the new-message cursor so watch mode only prints what arrives next.
    sdk.getNewChat({ types, includeSelf: true });

    if (!watch) {
        sdk.disconnect();
        process.exit(0);
    }

    console.log(`--- watching chat for '${username}' (Ctrl+C to stop) ---`);
    setInterval(() => {
        for (const m of sdk.getNewChat({ types, includeSelf: true })) {
            const time = new Date().toTimeString().slice(0, 8);
            console.log(`[${time}] ${formatMessage(m)}`);
        }
    }, 500);
}

main();
