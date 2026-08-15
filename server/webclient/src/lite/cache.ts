// Cache bootstrap for the lite client.
//
// The browser client downloads 8 JagFile archives and unpacks all of them,
// most for art it needs to draw. Headless we need exactly three:
//
//   index 2 'config'    -> ObjType/NpcType/LocType/SeqType/VarpType/... (names, options, stackability)
//   index 3 'interface' -> IfType (inventory, bank, shop, dialogs all live here)
//   index 7 'wordenc'   -> WordFilter, required to decode WordPack'd public chat
//
// We still need all 9 CRCs for the login packet - the engine validates them
// (World.ts, `CrcBuffer32 !== Packet.getcrc(crcs, ...)`) - but CRCs are 36 bytes
// from /crc, not archives.
//
// Archives are cached on disk keyed by CRC, so a fleet of bots on one machine
// downloads each archive once, ever.

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import Packet from '#/io/Packet.js';
import JagFile from '#/io/JagFile.js';

import FloType from '#/config/FloType.js';
import IdkType from '#/config/IdkType.js';
import IfType from '#/config/IfType.js';
import LocType from '#/config/LocType.js';
import NpcType from '#/config/NpcType.js';
import ObjType from '#/config/ObjType.js';
import SeqType from '#/config/SeqType.js';
import SpotType from '#/config/SpotType.js';
import VarBitType from '#/config/VarBitType.js';
import VarpType from '#/config/VarpType.js';
import WordFilter from '#/wordfilter/WordFilter.js';

import { captureBaseInterfaces, resetBaseInterfaces } from './interfaces.js';

/** Archives the lite client actually unpacks, as [filename, crc index]. */
const REQUIRED_ARCHIVES: Array<[string, number]> = [
    ['config', 2],
    ['interface', 3],
    ['wordenc', 7]
];

export interface CacheBootstrapOptions {
    /** Base HTTP origin of the game server, e.g. 'http://localhost:8888'. */
    origin: string;
    /** Directory for the on-disk archive cache. */
    cacheDir: string;
    /**
     * Members world. Must match the server's NODE_MEMBERS - the browser client
     * gets it from the page template, we can't discover it, and getting it wrong
     * makes members-only items vanish from interface reads.
     */
    members?: boolean;
    /** Suppress progress logging. */
    quiet?: boolean;
}

export interface LoadedCache {
    /** All 9 archive CRCs, in the order the login packet wants them. */
    checksums: number[];
}

let loaded: LoadedCache | null = null;

/**
 * Forget the memoized cache so the next loadCache() re-fetches /crc and
 * re-unpacks any archive whose CRC changed. Needed after a server content
 * redeploy: a long-lived process otherwise presents its boot-time CRCs on
 * every reconnect and gets login response 6 forever. Existing clients keep
 * their (copy-on-write) interface tables; only clients created after the
 * reload see the new baseline.
 */
export function invalidateCache(): void {
    loaded = null;
    resetBaseInterfaces();
}

/**
 * Download + unpack the config archives and initialise the shared config type
 * registries. Idempotent: the config types are module-level singletons, so a
 * second call in the same process is a no-op and every bot in the process shares
 * one copy of the item/npc/loc tables.
 */
export async function loadCache(opts: CacheBootstrapOptions): Promise<LoadedCache> {
    if (loaded) {
        return loaded;
    }

    const log = opts.quiet ? () => {} : (m: string) => console.log(`[lite:cache] ${m}`);

    const checksums = await fetchChecksums(opts.origin);
    log(`checksums ok (${checksums.length} archives)`);

    const archives = new Map<string, JagFile>();
    for (const [name, index] of REQUIRED_ARCHIVES) {
        const data = await fetchArchive(opts, name, checksums[index]);
        archives.set(name, new JagFile(data));
        log(`${name} ready (${(data.length / 1024).toFixed(0)}KB)`);
    }

    const config = archives.get('config')!;
    const interfaces = archives.get('interface')!;
    const wordenc = archives.get('wordenc')!;

    // Same order as Client.ts. These are pure Packet decodes - none of them
    // touch a canvas, they just build name/option/param tables.
    SeqType.init(config);
    LocType.init(config);
    FloType.init(config);
    ObjType.init(config, opts.members ?? true);
    NpcType.init(config);
    IdkType.init(config);
    SpotType.init(config);
    VarpType.init(config);
    VarBitType.init(config);
    WordFilter.unpack(wordenc);

    // media=null skips sprite loading (IfType already guards on it); fonts are
    // only assigned to components for text layout, which nothing headless reads.
    IfType.init(interfaces, null, headlessFonts());

    // Freeze this table as the baseline every client copies-on-write from. Must
    // happen before the first LiteClient exists - see interfaces.ts.
    captureBaseInterfaces();

    log(`config unpacked: ${ObjType.numDefinitions} objs, ${NpcType.numDefinitions} npcs, ${LocType.numDefinitions} locs, ${IfType.list.length} components`);

    loaded = { checksums };
    return loaded;
}

async function fetchChecksums(origin: string): Promise<number[]> {
    const res = await fetch(`${origin}/crc`);
    if (!res.ok) {
        throw new Error(`lite: GET ${origin}/crc failed with ${res.status}`);
    }

    const buf = new Packet(new Uint8Array(await res.arrayBuffer()));
    const checksums: number[] = [];
    for (let i = 0; i < 9; i++) {
        checksums[i] = buf.g4();
    }

    // Same validation the browser client does - catches a truncated/proxied response
    // before it turns into an opaque "out of date" rejection at login.
    const expected = buf.g4();
    let calculated = 1234;
    for (let i = 0; i < 9; i++) {
        calculated = ((calculated << 1) + checksums[i]) | 0;
    }
    if (expected !== calculated) {
        throw new Error('lite: /crc checksum mismatch - is something proxying the game server?');
    }

    return checksums;
}

async function fetchArchive(opts: CacheBootstrapOptions, name: string, crc: number): Promise<Uint8Array> {
    const path = join(opts.cacheDir, `${name}${crc >>> 0}.jag`);

    const cached = Bun.file(path);
    if (await cached.exists()) {
        const data = new Uint8Array(await cached.arrayBuffer());
        if (Packet.getcrc(data, 0, data.length) === crc) {
            return data;
        }
    }

    const res = await fetch(`${opts.origin}/${name}${crc}`);
    if (!res.ok) {
        throw new Error(`lite: GET ${opts.origin}/${name}${crc} failed with ${res.status}`);
    }

    const data = new Uint8Array(await res.arrayBuffer());
    if (Packet.getcrc(data, 0, data.length) !== crc) {
        throw new Error(`lite: ${name} archive failed CRC check`);
    }

    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, data);
    return data;
}

/**
 * IfType.init assigns `com.font = fonts[n]` for text components and never calls
 * into the font unless something draws. Four inert placeholders keep the decode
 * honest without pulling PixFont's glyph tables into memory.
 */
function headlessFonts(): never[] {
    return [] as never[];
}
