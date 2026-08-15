import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const COLLECTION_PATH = join(DATA_DIR, 'collection.json');
const TEMP_PATH = `${COLLECTION_PATH}.tmp`;

export type CollectionCategory = 'craftable_armor' | 'production_ingredient' | 'gatherable_resource';

export interface AcquisitionGuide {
    skill: string;
    location: string;
    prerequisites: string[];
    method: string;
    automatedActions: string[];
}

export interface CollectionTarget {
    item: string;
    category: CollectionCategory;
    targetCount: number;
    acquisition: AcquisitionGuide;
}

const bronzeSmithing = (product: string, bars: number): AcquisitionGuide => ({
    skill: 'Smithing',
    location: 'Varrock west anvil',
    prerequisites: [`Hammer`, `Bronze bar x${bars}`],
    method: `Smith ${product} at an anvil using ${bars} bronze bar(s). Mine copper and tin at SE Varrock, then smelt bronze bars at Lumbridge furnace.`,
    automatedActions: ['train:mining', 'train:smithing', 'travel:se_varrock_mine', 'travel:lumbridge_furnace', 'travel:varrock_anvil'],
});

const ironSmithing = (product: string, bars: number, level: number): AcquisitionGuide => ({
    skill: 'Smithing',
    location: 'Varrock west anvil',
    prerequisites: [`Smithing level ${level}`, `Hammer`, `Iron bar x${bars}`],
    method: `Smith ${product} at an anvil using ${bars} iron bar(s). Mine iron at SE Varrock, smelt at Lumbridge furnace, then use the Varrock anvil.`,
    automatedActions: ['train:mining', 'train:smithing', 'travel:se_varrock_mine', 'travel:lumbridge_furnace', 'travel:varrock_anvil'],
});

export const COLLECTION_TARGETS: readonly CollectionTarget[] = Object.freeze([
    { item: 'Bronze med helm', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a medium helm', 1) },
    { item: 'Bronze full helm', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a full helm', 2) },
    { item: 'Bronze chainbody', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a chainbody', 3) },
    { item: 'Bronze platebody', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a platebody', 5) },
    { item: 'Bronze platelegs', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('platelegs', 3) },
    { item: 'Bronze plateskirt', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a plateskirt', 3) },
    { item: 'Bronze sq shield', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a square shield', 2) },
    { item: 'Bronze kiteshield', category: 'craftable_armor', targetCount: 1, acquisition: bronzeSmithing('a kiteshield', 3) },
    { item: 'Iron med helm', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a medium helm', 1, 15) },
    { item: 'Iron full helm', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a full helm', 2, 22) },
    { item: 'Iron chainbody', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a chainbody', 3, 26) },
    { item: 'Iron platebody', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a platebody', 5, 33) },
    { item: 'Iron platelegs', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('platelegs', 3, 31) },
    { item: 'Iron plateskirt', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a plateskirt', 3, 31) },
    { item: 'Iron sq shield', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a square shield', 2, 23) },
    { item: 'Iron kiteshield', category: 'craftable_armor', targetCount: 1, acquisition: ironSmithing('a kiteshield', 3, 30) },

    {
        item: 'Bronze bar',
        category: 'production_ingredient',
        targetCount: 10,
        acquisition: {
            skill: 'Smithing',
            location: 'Lumbridge furnace',
            prerequisites: ['Copper ore', 'Tin ore'],
            method: 'Use copper ore on the usable Lumbridge furnace; one tin ore is consumed automatically.',
            automatedActions: ['train:mining', 'train:smithing', 'travel:lumbridge_furnace'],
        },
    },
    {
        item: 'Iron bar',
        category: 'production_ingredient',
        targetCount: 10,
        acquisition: {
            skill: 'Smithing',
            location: 'Lumbridge furnace',
            prerequisites: ['Smithing level 15', 'Iron ore'],
            method: 'Mine iron ore at SE Varrock and smelt it at the usable Lumbridge furnace.',
            automatedActions: ['train:mining', 'train:smithing', 'travel:lumbridge_furnace'],
        },
    },
    {
        item: 'Leather',
        category: 'production_ingredient',
        targetCount: 10,
        acquisition: {
            skill: 'Crafting',
            location: 'Al Kharid tanner',
            prerequisites: ['Cowhide', 'Coins'],
            method: 'Collect cowhide, take it to the Al Kharid tanner, and pay to tan it into leather.',
            automatedActions: [],
        },
    },
    {
        item: 'Ball of wool',
        category: 'production_ingredient',
        targetCount: 10,
        acquisition: {
            skill: 'Crafting',
            location: 'Lumbridge spinning wheel',
            prerequisites: ['Wool'],
            method: 'Shear sheep for wool and spin the wool at a spinning wheel.',
            automatedActions: [],
        },
    },
    {
        item: 'Bow string',
        category: 'production_ingredient',
        targetCount: 10,
        acquisition: {
            skill: 'Crafting',
            location: 'Lumbridge spinning wheel',
            prerequisites: ['Flax'],
            method: 'Pick flax and spin it into bow string at a spinning wheel.',
            automatedActions: [],
        },
    },
    {
        item: 'Soft clay',
        category: 'production_ingredient',
        targetCount: 10,
        acquisition: {
            skill: 'Crafting',
            location: 'Any water source',
            prerequisites: ['Clay', 'Bucket or jug of water'],
            method: 'Mine clay and use water on it to make soft clay.',
            automatedActions: ['train:mining'],
        },
    },

    {
        item: 'Logs',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Woodcutting',
            location: 'Lumbridge trees',
            prerequisites: ['Axe'],
            method: 'Chop regular trees around Lumbridge.',
            automatedActions: ['train:woodcutting', 'travel:lumbridge_trees'],
        },
    },
    {
        item: 'Oak logs',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Woodcutting',
            location: 'Varrock oaks',
            prerequisites: ['Woodcutting level 15', 'Axe'],
            method: 'Chop oak trees near Varrock.',
            automatedActions: ['train:woodcutting', 'travel:varrock_oaks'],
        },
    },
    {
        item: 'Copper ore',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Mining',
            location: 'SE Varrock mine',
            prerequisites: ['Pickaxe'],
            method: 'Mine copper rocks at SE Varrock mine.',
            automatedActions: ['train:mining', 'travel:se_varrock_mine'],
        },
    },
    {
        item: 'Tin ore',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Mining',
            location: 'SE Varrock mine',
            prerequisites: ['Pickaxe'],
            method: 'Mine tin rocks at SE Varrock mine.',
            automatedActions: ['train:mining', 'travel:se_varrock_mine'],
        },
    },
    {
        item: 'Iron ore',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Mining',
            location: 'SE Varrock mine',
            prerequisites: ['Mining level 15', 'Pickaxe'],
            method: 'Mine iron rocks at SE Varrock mine.',
            automatedActions: ['train:mining', 'travel:se_varrock_mine'],
        },
    },
    {
        item: 'Raw shrimps',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Fishing',
            location: 'Draynor fishing spots',
            prerequisites: ['Small fishing net'],
            method: 'Net fish at the Draynor net/bait fishing spots.',
            automatedActions: ['train:fishing', 'travel:draynor_fishing'],
        },
    },
    {
        item: 'Raw anchovies',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Fishing',
            location: 'Draynor fishing spots',
            prerequisites: ['Fishing level 15', 'Small fishing net'],
            method: 'Net fish at Draynor; anchovies become available with sufficient Fishing level.',
            automatedActions: ['train:fishing', 'travel:draynor_fishing'],
        },
    },
    {
        item: 'Cowhide',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'Combat',
            location: 'Lumbridge cow field',
            prerequisites: ['Combat equipment'],
            method: 'Defeat cows and pick up their cowhide drops.',
            automatedActions: [],
        },
    },
    {
        item: 'Wool',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'None',
            location: 'Lumbridge sheep field',
            prerequisites: ['Shears'],
            method: 'Use shears on sheep around Lumbridge.',
            automatedActions: [],
        },
    },
    {
        item: 'Flax',
        category: 'gatherable_resource',
        targetCount: 10,
        acquisition: {
            skill: 'None',
            location: 'Seers Village flax field',
            prerequisites: [],
            method: 'Pick flax from a flax field.',
            automatedActions: [],
        },
    },
    {
        item: 'Feather',
        category: 'gatherable_resource',
        targetCount: 50,
        acquisition: {
            skill: 'Combat',
            location: 'Lumbridge chicken field',
            prerequisites: ['Combat equipment'],
            method: 'Defeat chickens and pick up feather drops, or buy feathers from another player.',
            automatedActions: [],
        },
    },
]);

interface CollectionLedger {
    observed: Record<string, { firstSeenAt: number; maxHeld: number }>;
}

export interface CollectionStatus {
    mission: string;
    totalTargets: number;
    targetsCurrentlyStocked: number;
    targetsEverObserved: number;
    categoryProgress: Record<CollectionCategory, { stocked: number; total: number }>;
    priorityMissing: Array<CollectionTarget & { currentCount: number; everObserved: boolean }>;
}

function loadLedger(): CollectionLedger {
    if (!existsSync(COLLECTION_PATH)) return { observed: {} };
    try {
        return JSON.parse(readFileSync(COLLECTION_PATH, 'utf8')) as CollectionLedger;
    } catch (error) {
        console.warn(`[collectionPortfolio] Could not read collection ledger: ${error}`);
        return { observed: {} };
    }
}

function persistLedger(ledger: CollectionLedger): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(ledger, null, 2));
    renameSync(TEMP_PATH, COLLECTION_PATH);
}

export function updateCollectionStatus(inventory: Array<{ name: string; count: number }>): CollectionStatus {
    const ledger = loadLedger();
    const counts = new Map<string, number>();
    for (const item of inventory) {
        const key = item.name.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + item.count);
        const previous = ledger.observed[key];
        ledger.observed[key] = {
            firstSeenAt: previous?.firstSeenAt ?? Date.now(),
            maxHeld: Math.max(previous?.maxHeld ?? 0, item.count),
        };
    }
    persistLedger(ledger);

    const categories: CollectionStatus['categoryProgress'] = {
        craftable_armor: { stocked: 0, total: 0 },
        production_ingredient: { stocked: 0, total: 0 },
        gatherable_resource: { stocked: 0, total: 0 },
    };
    let stocked = 0;
    let observed = 0;
    const missing: CollectionStatus['priorityMissing'] = [];

    for (const target of COLLECTION_TARGETS) {
        const currentCount = counts.get(target.item.toLowerCase()) ?? 0;
        const everObserved = !!ledger.observed[target.item.toLowerCase()];
        categories[target.category].total += 1;
        if (currentCount >= target.targetCount) {
            stocked += 1;
            categories[target.category].stocked += 1;
        } else {
            missing.push({ ...target, currentCount, everObserved });
        }
        if (everObserved) observed += 1;
    }

    return {
        mission:
            'Maintain a useful stock of the reasonable F2P collection: all listed bronze/iron craftable armor, core production ingredients, and common gatherable resources. Use current market demand to prioritize which missing stock to acquire next.',
        totalTargets: COLLECTION_TARGETS.length,
        targetsCurrentlyStocked: stocked,
        targetsEverObserved: observed,
        categoryProgress: categories,
        priorityMissing: missing
            .sort((a, b) => {
                const automatedDelta = Number(b.acquisition.automatedActions.length > 0) - Number(a.acquisition.automatedActions.length > 0);
                if (automatedDelta !== 0) return automatedDelta;
                return a.category.localeCompare(b.category);
            })
            .slice(0, 24),
    };
}
