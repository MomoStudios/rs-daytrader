import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { handleHiscoresPage, handleHiscoresPlayerPage, handleHiscoresOutfitPage, handleHiscoresBankPage, handleHiscoresKothPage } from './pages/hiscores.js';
import { handlePublicFiles } from './pages/static.js';

const PACK_DIR = path.resolve(import.meta.dir, '../../data/pack');
const VIEWER_OUT_DIR = path.resolve(import.meta.dir, '../../../webclient/out/viewer');

const VIEWER_MIME: Record<string, string> = {
    '.js': 'application/javascript',
    '.wasm': 'application/wasm',
};

// CRC32 (matches Packet.getcrc in the client)
function crc32(data: Uint8Array): number {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xedb88320;
            } else {
                crc = crc >>> 1;
            }
        }
        table[i] = crc;
    }
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
    }
    return ~crc;
}

function buildCrcBuffer(): Uint8Array {
    const cacheFiles = [
        null,
        `${PACK_DIR}/client/title`,
        `${PACK_DIR}/client/config`,
        `${PACK_DIR}/client/interface`,
        `${PACK_DIR}/client/media`,
        `${PACK_DIR}/client/versionlist`,
        `${PACK_DIR}/client/textures`,
        `${PACK_DIR}/client/wordenc`,
        `${PACK_DIR}/client/sounds`,
    ];
    const buf = new ArrayBuffer(9 * 4);
    const view = new DataView(buf);
    for (let i = 0; i < 9; i++) {
        const file = cacheFiles[i];
        if (file && fs.existsSync(file)) {
            const data = fs.readFileSync(file);
            view.setInt32(i * 4, crc32(data), false);
        } else {
            view.setInt32(i * 4, 0, false);
        }
    }
    return new Uint8Array(buf);
}

let crcBuffer: Uint8Array | null = null;

export function handleViewerAssets(url: URL): Response | null {
    // CRC endpoint
    if (url.pathname.startsWith('/crc')) {
        if (!crcBuffer) crcBuffer = buildCrcBuffer();
        return new Response(Buffer.from(crcBuffer));
    }

    // Cache archive endpoints
    const archiveNames = ['config', 'textures', 'versionlist', 'title', 'interface', 'media', 'sounds'];
    for (const name of archiveNames) {
        if (url.pathname.startsWith(`/${name}`)) {
            const filePath = `${PACK_DIR}/client/${name}`;
            if (fs.existsSync(filePath)) {
                return new Response(Bun.file(filePath));
            }
            return new Response(null, { status: 404 });
        }
    }

    // Ondemand.zip
    if (url.pathname.startsWith('/ondemand.zip')) {
        const zipPath = `${PACK_DIR}/ondemand.zip`;
        if (fs.existsSync(zipPath)) {
            return new Response(Bun.file(zipPath), {
                headers: { 'Content-Type': 'application/zip' },
            });
        }
        return new Response(null, { status: 404 });
    }

    // Viewer JS/WASM assets
    if (url.pathname.startsWith('/viewer/')) {
        const fileName = url.pathname.slice('/viewer/'.length);
        const filePath = path.join(VIEWER_OUT_DIR, fileName);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            return new Response(Bun.file(filePath), {
                headers: { 'Content-Type': VIEWER_MIME[ext] || 'application/octet-stream' },
            });
        }
        // Audio assets (soundfonts, etc.) are not needed for icon rendering — return empty to avoid 404 noise
        return new Response(new Uint8Array(0), { status: 200 });
    }

    return null;
}

export function startHiscoresWeb() {
    Bun.serve({
        port: Environment.HISCORES_WEB_PORT,
        async fetch(req) {
            const url = new URL(req.url ?? '', `http://${req.headers.get('host')}`);

            // Hiscores pages
            const hiscoresResponse = await handleHiscoresPage(url);
            if (hiscoresResponse) return hiscoresResponse;

            const hiscoresPlayerResponse = await handleHiscoresPlayerPage(url);
            if (hiscoresPlayerResponse) return hiscoresPlayerResponse;

            const hiscoresOutfitResponse = await handleHiscoresOutfitPage(url);
            if (hiscoresOutfitResponse) return hiscoresOutfitResponse;

            const hiscoresBankResponse = await handleHiscoresBankPage(url);
            if (hiscoresBankResponse) return hiscoresBankResponse;

            const hiscoresKothResponse = await handleHiscoresKothPage(url);
            if (hiscoresKothResponse) return hiscoresKothResponse;

            // Static files (decoration images)
            const publicFilesResponse = handlePublicFiles(url);
            if (publicFilesResponse) return publicFilesResponse;

            // Viewer assets (cache data, JS, WASM)
            const viewerResponse = handleViewerAssets(url);
            if (viewerResponse) return viewerResponse;

            return new Response('Not found', { status: 404 });
        }
    });

    console.log(`Hiscores server listening on port ${Environment.HISCORES_WEB_PORT}`);
}
