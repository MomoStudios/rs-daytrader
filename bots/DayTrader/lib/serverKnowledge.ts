import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SEARCH_ROOTS = [
    'server/content/scripts',
    'server/content/pack',
    'server/engine/src',
    'server/engine/tools',
    'wiki',
    'learnings',
    'bots/DayTrader/lib',
];

export interface ServerEvidence {
    query: string;
    source: string;
    lines: string;
}

function safeQuery(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .slice(0, 160);
}

export async function retrieveServerEvidence(
    queries: string[],
    maxResults = 60
): Promise<ServerEvidence[]> {
    const evidence: ServerEvidence[] = [];
    for (const raw of queries.slice(0, 12)) {
        const query = safeQuery(raw);
        if (!query) continue;
        const process = Bun.spawn(
            [
                'rg',
                '--fixed-strings',
                '--ignore-case',
                '--line-number',
                '--context',
                '3',
                '--max-count',
                '12',
                query,
                ...SEARCH_ROOTS,
            ],
            {
                cwd: REPO_ROOT,
                stdout: 'pipe',
                stderr: 'pipe',
            }
        );
        const [stdout] = await Promise.all([
            new Response(process.stdout).text(),
            process.exited,
        ]);
        if (!stdout.trim()) continue;

        const groups = stdout.split(/\n--\n/);
        for (const group of groups) {
            const first = group.split('\n').find(line => line.includes(':'));
            const source = first?.split(/[:-]\d+[:-]/)[0] ?? 'unknown';
            evidence.push({
                query,
                source: relative(REPO_ROOT, resolve(REPO_ROOT, source)),
                lines: group.slice(0, 6_000),
            });
            if (evidence.length >= maxResults) return evidence;
        }
    }
    return evidence;
}
