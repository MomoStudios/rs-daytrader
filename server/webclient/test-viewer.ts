/**
 * Minimal test server for the standalone item viewer PoC.
 * Serves the viewer HTML page and proxies cache endpoints from engine pack data.
 *
 * Usage: bun test-viewer.ts
 * Then open http://localhost:8090/viewer
 */

import fs from 'fs';
import path from 'path';

const PACK_DIR = path.resolve(import.meta.dir, '../engine/data/pack');
const OUT_DIR = path.resolve(import.meta.dir, 'out');

// Build a CRC table matching what the client expects
function buildCrcBuffer(): Uint8Array {
    const cacheFiles = [
        null,                          // 0: unused
        `${PACK_DIR}/client/title`,    // 1: title
        `${PACK_DIR}/client/config`,   // 2: config
        `${PACK_DIR}/client/interface`,// 3: interface
        `${PACK_DIR}/client/media`,    // 4: media
        `${PACK_DIR}/client/versionlist`, // 5: versionlist
        `${PACK_DIR}/client/textures`, // 6: textures
        `${PACK_DIR}/client/wordenc`,  // 7: wordenc
        `${PACK_DIR}/client/sounds`,   // 8: sounds
    ];

    const buf = new ArrayBuffer(9 * 4);
    const view = new DataView(buf);

    for (let i = 0; i < 9; i++) {
        const file = cacheFiles[i];
        if (file && fs.existsSync(file)) {
            const data = fs.readFileSync(file);
            // CRC32 computation
            let crc = crc32(data);
            view.setInt32(i * 4, crc, false);
        } else {
            view.setInt32(i * 4, 0, false);
        }
    }

    return new Uint8Array(buf);
}

// Simple CRC32 (same as Packet.getcrc in the client)
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

const crcBuffer = buildCrcBuffer();

const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>Item Viewer - All Items</title>
    <style>
        body {
            background: #1a1a2e;
            color: #eee;
            font-family: monospace;
            margin: 0;
            padding: 20px;
        }
        h1 { color: #5bf; margin-bottom: 4px; }
        .subtitle { color: #888; margin-bottom: 20px; }
        #status {
            padding: 10px;
            background: #111;
            border: 1px solid #333;
            margin-bottom: 20px;
            min-height: 20px;
        }
        #grid-container {
            display: none;
        }
        #grid-canvas {
            border: 1px solid #333;
            image-rendering: pixelated;
            background: #000;
        }
        #tooltip {
            position: fixed;
            background: #222;
            color: #eee;
            border: 1px solid #5bf;
            padding: 4px 8px;
            font-size: 12px;
            pointer-events: none;
            display: none;
            z-index: 100;
            white-space: nowrap;
        }
    </style>
</head>
<body>
    <h1>Item Viewer</h1>
    <p class="subtitle">All items rendered</p>
    <div id="status">Initializing...</div>
    <div id="tooltip"></div>

    <div id="grid-container">
        <canvas id="grid-canvas"></canvas>
    </div>

    <!-- Required: canvas element must exist before viewer module loads -->
    <canvas id="canvas" width="256" height="256" style="display:none;"></canvas>

    <script type="module">
        import { ItemViewer } from './viewer/viewer.js';

        const COLS = 32;
        const ICON = 32;

        const status = document.getElementById('status');
        const viewer = new ItemViewer();
        window._viewer = viewer;

        let totalItems = 0;

        try {
            status.textContent = 'Loading game data (config, textures, models)...';
            await viewer.init('');
            totalItems = viewer.getItemCount();
            status.textContent = 'Rendering ' + totalItems + ' items...';
            status.style.borderColor = '#0a0';
        } catch (err) {
            status.textContent = 'Error: ' + err.message;
            status.style.borderColor = '#a00';
            console.error(err);
        }

        if (totalItems > 0) {
            // Build list of non-noted item IDs
            const itemIds = [];
            for (let id = 0; id < totalItems; id++) {
                if (!viewer.isNoted(id)) {
                    itemIds.push(id);
                }
            }

            const rows = Math.ceil(itemIds.length / COLS);
            const gridCanvas = document.getElementById('grid-canvas');
            gridCanvas.width = COLS * ICON;
            gridCanvas.height = rows * ICON;
            const ctx = gridCanvas.getContext('2d');
            ctx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);

            document.getElementById('grid-container').style.display = 'block';

            // Render in batches to keep the page responsive
            const BATCH = 64;
            let rendered = 0;

            function renderBatch(startIdx) {
                const end = Math.min(startIdx + BATCH, itemIds.length);
                for (let i = startIdx; i < end; i++) {
                    const icon = viewer.renderItemIconAsImageData(itemIds[i]);
                    if (icon) {
                        const col = i % COLS;
                        const row = Math.floor(i / COLS);
                        ctx.putImageData(icon, col * ICON, row * ICON);
                        rendered++;
                    }
                }
                if (end < itemIds.length) {
                    status.textContent = 'Rendering... ' + end + ' / ' + itemIds.length + ' (skipped ' + (totalItems - itemIds.length) + ' noted)';
                    requestAnimationFrame(() => renderBatch(end));
                } else {
                    status.textContent = 'Done! Rendered ' + rendered + ' items (' + (totalItems - itemIds.length) + ' noted skipped).';
                }
            }

            renderBatch(0);

            // Tooltip on hover
            const tooltip = document.getElementById('tooltip');
            gridCanvas.addEventListener('mousemove', (e) => {
                const rect = gridCanvas.getBoundingClientRect();
                const scaleX = gridCanvas.width / rect.width;
                const scaleY = gridCanvas.height / rect.height;
                const px = (e.clientX - rect.left) * scaleX;
                const py = (e.clientY - rect.top) * scaleY;
                const col = Math.floor(px / ICON);
                const row = Math.floor(py / ICON);
                const idx = row * COLS + col;

                if (idx >= 0 && idx < itemIds.length) {
                    const id = itemIds[idx];
                    const name = viewer.getItemName(id) || '(unnamed)';
                    tooltip.textContent = '#' + id + ' ' + name;
                    tooltip.style.left = (e.clientX + 12) + 'px';
                    tooltip.style.top = (e.clientY + 12) + 'px';
                    tooltip.style.display = 'block';
                } else {
                    tooltip.style.display = 'none';
                }
            });
            gridCanvas.addEventListener('mouseleave', () => {
                tooltip.style.display = 'none';
            });
        }
    </script>
</body>
</html>`;

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.zip': 'application/zip',
};

const server = Bun.serve({
    port: 8090,
    async fetch(req) {
        const url = new URL(req.url);

        // Viewer page
        if (url.pathname === '/viewer' || url.pathname === '/viewer/') {
            return new Response(VIEWER_HTML, {
                headers: { 'Content-Type': 'text/html' },
            });
        }

        // CRC endpoint
        if (url.pathname.startsWith('/crc')) {
            return new Response(crcBuffer as BodyInit);
        }

        // Cache archive endpoints
        const archiveMap: Record<string, string> = {
            '/title': 'client/title',
            '/config': 'client/config',
            '/interface': 'client/interface',
            '/media': 'client/media',
            '/versionlist': 'client/versionlist',
            '/textures': 'client/textures',
            '/wordenc': 'client/wordenc',
            '/sounds': 'client/sounds',
        };

        for (const [prefix, file] of Object.entries(archiveMap)) {
            if (url.pathname.startsWith(prefix)) {
                const filePath = `${PACK_DIR}/${file}`;
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

        // Viewer JS assets (from webclient/out/viewer/)
        if (url.pathname.startsWith('/viewer/')) {
            const filePath = `${OUT_DIR}/viewer/${url.pathname.slice('/viewer/'.length)}`;
            if (fs.existsSync(filePath)) {
                const ext = path.extname(filePath);
                return new Response(Bun.file(filePath), {
                    headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
                });
            }
        }

        // Deps (shared)
        if (url.pathname === '/deps.js') {
            return new Response(Bun.file(`${OUT_DIR}/viewer/deps.js`), {
                headers: { 'Content-Type': 'application/javascript' },
            });
        }

        // WASM files
        if (url.pathname.endsWith('.wasm')) {
            const wasmPath = `${OUT_DIR}/viewer/${url.pathname.slice(1)}`;
            if (fs.existsSync(wasmPath)) {
                return new Response(Bun.file(wasmPath), {
                    headers: { 'Content-Type': 'application/wasm' },
                });
            }
        }

        return new Response('Not found', { status: 404 });
    },
});

console.log(`Item Viewer test server running at http://localhost:${server.port}/viewer`);
