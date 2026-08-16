// DayTrader - Persistent State Store
//
// Simple JSON-file persistence under bots/DayTrader/data/ so the bot's
// memory (scam blacklist, ad history, last-trade-chat timestamp, known
// item asks/offers) survives process restarts without needing an LLM to
// reconstruct context each run.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATE_PATH = join(DATA_DIR, 'state.json');

export interface AdAttempt {
    message: string;
    template: string;
    sentAt: number;
    /** Filled in later once we know whether trade-relevant chat followed. */
    gotResponseWithinMs: number | null;
}

export interface ScamRecord {
    sender: string;
    text: string;
    categories: string[];
    at: number;
}

export interface DayTraderState {
    /** Epoch ms of the last trade-relevant chat line observed (ours or others'). */
    lastTradeChatTime: number;
    /** Epoch ms DayTrader itself last sent an advertisement. */
    lastAdTime: number;
    adHistory: AdAttempt[];
    scamRecords: ScamRecord[];
    /** Player names DayTrader will not initiate or accept trades with. */
    blacklist: string[];
    /** Rolling count of trades completed, for quick health checks. */
    tradesCompleted: number;
    /** Rolling net profit estimate (book-value gp), for quick health checks. */
    estimatedNetProfitGp: number;
}

function defaultState(): DayTraderState {
    return {
        lastTradeChatTime: Date.now(),
        lastAdTime: 0,
        adHistory: [],
        scamRecords: [],
        blacklist: [],
        tradesCompleted: 0,
        estimatedNetProfitGp: 0,
    };
}

let state: DayTraderState | null = null;

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadState(): DayTraderState {
    if (state) return state;
    ensureDataDir();
    if (existsSync(STATE_PATH)) {
        try {
            const loaded: DayTraderState = {
                ...defaultState(),
                ...JSON.parse(readFileSync(STATE_PATH, 'utf-8')),
            };
            state = loaded;
            return loaded;
        } catch (e) {
            console.warn(`[stateStore] Failed to read state.json, starting fresh: ${e}`);
        }
    }
    state = defaultState();
    return state;
}

export function saveState(): void {
    if (!state) return;
    ensureDataDir();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function getState(): DayTraderState {
    return loadState();
}

export function updateState(patch: Partial<DayTraderState>): void {
    const s = loadState();
    Object.assign(s, patch);
    saveState();
}

export function recordAd(message: string, template: string): void {
    const s = loadState();
    s.adHistory.push({ message, template, sentAt: Date.now(), gotResponseWithinMs: null });
    s.lastAdTime = Date.now();
    // Keep history bounded.
    if (s.adHistory.length > 200) s.adHistory.splice(0, s.adHistory.length - 200);
    saveState();
}

/** Call when trade-relevant chat is seen, to close out any pending ad's response timer. */
export function noteTradeChatSeen(): void {
    const s = loadState();
    const now = Date.now();
    s.lastTradeChatTime = now;
    for (let i = s.adHistory.length - 1; i >= 0; i--) {
        const ad = s.adHistory[i];
        if (!ad) continue;
        if (ad.gotResponseWithinMs === null) {
            ad.gotResponseWithinMs = now - ad.sentAt;
        } else {
            break; // only the most recent pending ad(s) are relevant
        }
    }
    saveState();
}

export function recordScam(sender: string, text: string, categories: string[]): void {
    const s = loadState();
    s.scamRecords.push({ sender, text, categories, at: Date.now() });
    if (s.scamRecords.length > 500) s.scamRecords.splice(0, s.scamRecords.length - 500);
    saveState();
}

export function isBlacklisted(sender: string): boolean {
    const s = loadState();
    return s.blacklist.some(n => n.toLowerCase() === sender.toLowerCase());
}

export function addToBlacklist(sender: string): void {
    const s = loadState();
    if (!isBlacklisted(sender)) {
        s.blacklist.push(sender);
        saveState();
    }
}

export function recordTradeOutcome(netProfitGp: number): void {
    const s = loadState();
    s.tradesCompleted += 1;
    s.estimatedNetProfitGp += netProfitGp;
    saveState();
}
