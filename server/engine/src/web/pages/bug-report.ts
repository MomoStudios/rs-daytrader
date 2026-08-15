import fs from 'fs';
import path from 'path';

// Write-only drop box for SDK bug reports / papercuts. One text field per report,
// plus the SDK version the reporter was running. Agents POST here from
// sdk/bug-report.ts.
//
// Nothing is readable over HTTP on purpose - the reports are ours, read them off
// the machine directly:
//
//   fly ssh console -C 'cat /opt/server/data/bug-reports.jsonl'
//
// Storage is a JSONL append log. On fly the path must point at the mounted volume
// (BUG_REPORTS_FILE in fly.toml) - the engine's own data/ dir is ephemeral apart
// from the symlinked players/ dir.
const REPORTS_FILE = process.env.BUG_REPORTS_FILE || 'data/bug-reports.jsonl';

/** Reject oversized posts before parsing. */
const MAX_BODY_BYTES = 64 * 1024;
/** Per-report cap, applied after parsing so a valid report is never silently dropped. */
const MAX_TEXT_CHARS = 8000;
/** Stop accepting writes past this, so an unauthenticated endpoint can't fill the volume. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

export interface BugReport {
    id: string;
    receivedAt: string;
    /** The report itself. */
    text: string;
    /** Git commit the reporter's SDK was running from. See sdk/bug-report.ts. */
    sdkVersion: string | null;
}

/**
 * True if the log's last byte is something other than a newline - i.e. a
 * previous append was cut short (ENOSPC during the 2026-08 disk-full event
 * left one record truncated mid-line, and the next append spliced into it).
 */
function lastLineIsTruncated(): boolean {
    let fd: number | null = null;
    try {
        fd = fs.openSync(REPORTS_FILE, 'r');
        const size = fs.fstatSync(fd).size;
        if (size === 0) {
            return false;
        }
        const tail = Buffer.alloc(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        return tail[0] !== 0x0a;
    } catch {
        return false;
    } finally {
        if (fd !== null) {
            fs.closeSync(fd);
        }
    }
}

function appendReport(report: BugReport): void {
    const dir = path.dirname(REPORTS_FILE);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const prefix = lastLineIsTruncated() ? '\n' : '';
    fs.appendFileSync(REPORTS_FILE, prefix + JSON.stringify(report) + '\n');
}

/**
 * POST /bug-report — file a report; body is the report text, no auth.
 * Any other method gets 405: reports are never served back over HTTP.
 */
export async function handleBugReport(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/bug-report' && url.pathname !== '/bug-report/') {
        return null;
    }

    if (req.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'Write-only: POST a bug report here' }), {
            status: 405, headers: JSON_HEADERS
        });
    }

    try {
        const raw = await req.text();
        if (raw.length > MAX_BODY_BYTES) {
            return new Response(JSON.stringify({ ok: false, error: `Report too large (max ${MAX_BODY_BYTES} bytes)` }), {
                status: 413, headers: JSON_HEADERS
            });
        }
        if (fs.existsSync(REPORTS_FILE) && fs.statSync(REPORTS_FILE).size > MAX_FILE_BYTES) {
            return new Response(JSON.stringify({ ok: false, error: 'Bug report log is full' }), {
                status: 507, headers: JSON_HEADERS
            });
        }

        // Accept {text, sdkVersion} JSON, but fall back to treating the body as
        // the report itself so a bare `curl -d 'thing is broken'` still works.
        let text = raw;
        let sdkVersion: string | null = null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                text = String(parsed.text ?? parsed.report ?? parsed.body ?? '');
                sdkVersion = parsed.sdkVersion ? String(parsed.sdkVersion).slice(0, 100) : null;
            }
        } catch {
            // Plain text body.
        }

        text = text.trim();
        if (!text) {
            return new Response(JSON.stringify({ ok: false, error: 'Empty report' }), {
                status: 400, headers: JSON_HEADERS
            });
        }
        if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]';
        }

        const report: BugReport = {
            id: `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
            receivedAt: new Date().toISOString(),
            text,
            sdkVersion
        };

        appendReport(report);
        console.log(`[BugReport] ${report.id} (sdk ${report.sdkVersion ?? 'unknown'}): ${report.text.split('\n')[0]}`);

        return new Response(JSON.stringify({ ok: true, id: report.id }), {
            status: 201, headers: JSON_HEADERS
        });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: JSON_HEADERS });
    }
}
