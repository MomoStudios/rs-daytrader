import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AiDecision } from './aiDecision';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

export interface ExecutionKnowledge {
    source: string;
    content: string;
}

const ACTIVITY_DOCS: Record<string, string[]> = {
    mining: ['wiki/skills/mining.md', 'learnings/mining.md', 'learnings/walking.md'],
    smithing: ['wiki/skills/smithing.md', 'learnings/smithing.md', 'learnings/banking.md'],
    woodcutting: ['wiki/skills/woodcutting.md', 'learnings/woodcutting.md'],
    fishing: ['wiki/skills/fishing.md', 'learnings/fishing.md'],
    cooking: ['wiki/skills/cooking.md', 'learnings/cooking.md'],
    firemaking: ['wiki/skills/firemaking.md', 'learnings/woodcutting.md'],
};

const GOAL_DOCS: Array<{ pattern: RegExp; docs: string[] }> = [
    { pattern: /runite|rune ore/i, docs: ['wiki/skills/mining.md', 'wiki/items/runite-ore.md', 'learnings/mining.md'] },
    { pattern: /hero'?s? quest|heroes guild/i, docs: ['wiki/quests/heros-quest.md'] },
    { pattern: /shilo/i, docs: ['wiki/quests/shilo-village.md'] },
    { pattern: /dragon slayer/i, docs: ['wiki/quests/dragon-slayer.md'] },
    { pattern: /iron|steel|mithril|adamant|smith/i, docs: ['wiki/skills/smithing.md', 'learnings/smithing.md'] },
    { pattern: /bank|stock|inventory/i, docs: ['learnings/banking.md'] },
];

export function retrieveExecutionKnowledge(decision: AiDecision): ExecutionKnowledge[] {
    const paths = new Set<string>();
    if (decision.nextAction.type === 'train') {
        for (const path of ACTIVITY_DOCS[decision.nextAction.activity] ?? []) paths.add(path);
    }
    const query = [
        decision.goal.target,
        decision.goal.rationale,
        decision.summary,
        ...(decision.marketSignals ?? []).map(signal => `${signal.topic} ${signal.implication}`),
    ].join(' ');
    for (const entry of GOAL_DOCS) {
        if (entry.pattern.test(query)) entry.docs.forEach(path => paths.add(path));
    }

    const results: ExecutionKnowledge[] = [];
    for (const path of paths) {
        const absolute = join(REPO_ROOT, path);
        if (!existsSync(absolute)) continue;
        const content = readFileSync(absolute, 'utf8').slice(0, 12_000);
        results.push({ source: path, content });
        if (results.length >= 8) break;
    }
    return results;
}
