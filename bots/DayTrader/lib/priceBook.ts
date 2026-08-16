// DayTrader - Price Book
//
// Deterministic item value lookup, parsed once from the wiki/items/*.md
// dataset (already generated from the game's real shop-value data) and
// cached to data/prices.json. This gives the bot a fair-value baseline for
// every known item without needing an LLM to "remember" prices at runtime.
//
// The "Value" field on each wiki item page is the game's base value (the
// same number used for high-alch and general-store base pricing). It is not
// a live player market price, but it's a solid, deterministic floor/ceiling
// reference for deciding whether a proposed trade is profitable:
//   - Never pay (in coins or item-value) more than a safety-margin multiple
//     of an item's book value.
//   - Never give away items worth meaningfully more than what's received.
//
// Real player market prices can run above or below book value, but without
// a live GE (this server has none), book value plus a cautious margin is
// the safest deterministic anchor available.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..'); // bots/DayTrader/lib -> repo root
const WIKI_ITEMS_DIR = join(REPO_ROOT, 'wiki', 'items');
const CACHE_PATH = join(__dirname, '..', 'data', 'prices.json');

export interface PriceEntry {
    /** Display name as it appears in the wiki (Title Case). */
    name: string;
    /** Lower-cased name, used as the lookup key. */
    key: string;
    /** Base game value in gp. */
    value: number;
    /** Members-only item (unusable on this F2P-focused bot, flagged for visibility). */
    members: boolean;
}

type PriceMap = Map<string, PriceEntry>;

let cache: PriceMap | null = null;

function parseItemFile(filePath: string, fileBaseName: string): PriceEntry | null {
    const text = readFileSync(filePath, 'utf-8');

    const titleMatch = text.match(/^#\s+(.+)$/m);
    const valueMatch = text.match(/\*\*Value\*\*\s*\|\s*(-?\d+)\s*gp/i);
    const membersMatch = text.match(/\*\*Members\*\*\s*\|\s*(Yes|No)/i);

    if (!valueMatch) return null;

    const name = titleMatch?.[1] ? titleMatch[1].trim() : fileBaseName;
    const value = parseInt(valueMatch[1] ?? '0', 10);
    const members = membersMatch ? membersMatch[1]?.toLowerCase() === 'yes' : false;

    return {
        name,
        key: name.toLowerCase(),
        value,
        members,
    };
}

function buildPriceBook(): PriceEntry[] {
    if (!existsSync(WIKI_ITEMS_DIR)) {
        console.warn(`[priceBook] wiki/items directory not found at ${WIKI_ITEMS_DIR}`);
        return [];
    }

    const files = readdirSync(WIKI_ITEMS_DIR).filter(f => f.endsWith('.md'));
    const entries: PriceEntry[] = [];

    for (const file of files) {
        try {
            const entry = parseItemFile(join(WIKI_ITEMS_DIR, file), file.replace(/\.md$/, ''));
            if (entry) entries.push(entry);
        } catch (e) {
            console.warn(`[priceBook] Failed to parse ${file}: ${e}`);
        }
    }

    // Coins are a special case: their "book value" is listed as 0 gp on the
    // wiki (self-referential), but 1 coin is worth exactly 1 gp.
    const coins = entries.find(e => e.key === 'coins');
    if (coins) coins.value = 1;

    return entries;
}

function loadCache(): PriceMap {
    if (cache) return cache;

    let entries: PriceEntry[];

    if (existsSync(CACHE_PATH)) {
        try {
            entries = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
        } catch {
            entries = buildPriceBook();
            persistCache(entries);
        }
    } else {
        entries = buildPriceBook();
        persistCache(entries);
    }

    cache = new Map(entries.map(e => [e.key, e]));
    return cache;
}

function persistCache(entries: PriceEntry[]): void {
    try {
        writeFileSync(CACHE_PATH, JSON.stringify(entries, null, 2));
    } catch (e) {
        console.warn(`[priceBook] Failed to write cache: ${e}`);
    }
}

/** Force a rebuild of the price book from wiki/items (e.g. after a repo update). */
export function rebuildPriceBook(): void {
    const entries = buildPriceBook();
    persistCache(entries);
    cache = new Map(entries.map(e => [e.key, e]));
}

function normalize(name: string): string {
    return name.toLowerCase().trim();
}

/**
 * Look up the book value of an item by exact (case-insensitive) name.
 * Returns null if unknown - callers should treat unknown items as
 * "cannot verify value, be conservative" rather than assuming 0.
 */
export function getExactValue(name: string): number | null {
    const map = loadCache();
    const entry = map.get(normalize(name));
    return entry ? entry.value : null;
}

/**
 * Fuzzy lookup - tries exact match first, then substring match against the
 * price book (either direction), preferring the closest length match to
 * avoid e.g. "knife" matching "knife dagger blueprint" style noise.
 */
export function getValue(name: string): number | null {
    const map = loadCache();
    const key = normalize(name);

    const exact = map.get(key);
    if (exact) return exact.value;

    let best: PriceEntry | null = null;
    let bestScore = Infinity;
    for (const entry of map.values()) {
        if (entry.key.includes(key) || key.includes(entry.key)) {
            const score = Math.abs(entry.key.length - key.length);
            if (score < bestScore) {
                bestScore = score;
                best = entry;
            }
        }
    }
    return best ? best.value : null;
}

/** Full entry lookup (value + metadata), fuzzy like getValue. */
export function getEntry(name: string): PriceEntry | null {
    const map = loadCache();
    const key = normalize(name);
    const exact = map.get(key);
    if (exact) return exact;

    let best: PriceEntry | null = null;
    let bestScore = Infinity;
    for (const entry of map.values()) {
        if (entry.key.includes(key) || key.includes(entry.key)) {
            const score = Math.abs(entry.key.length - key.length);
            if (score < bestScore) {
                bestScore = score;
                best = entry;
            }
        }
    }
    return best;
}

/**
 * Total book value of a list of named+counted items (e.g. a trade offer or
 * inventory). Unknown items contribute 0 and are returned separately so the
 * caller can decide how to treat trades involving items we can't price.
 */
export function estimateOfferValue(items: Array<{ name: string; count: number }>): {
    total: number;
    unknownItems: string[];
} {
    let total = 0;
    const unknownItems: string[] = [];
    for (const item of items) {
        const value = getValue(item.name);
        if (value === null) {
            unknownItems.push(item.name);
        } else {
            total += value * item.count;
        }
    }
    return { total, unknownItems };
}

export function priceBookSize(): number {
    return loadCache().size;
}
