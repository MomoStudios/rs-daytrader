import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { BotWorldState } from '../../../sdk/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const ASSETS_PATH = join(DATA_DIR, 'assets.json');
const TEMP_PATH = `${ASSETS_PATH}.tmp`;

export interface RememberedItem {
    name: string;
    count: number;
}

export interface AssetMemory {
    inventory: RememberedItem[];
    equipment: RememberedItem[];
    bank: RememberedItem[];
    inventoryObservedAt: number;
    bankObservedAt: number | null;
    bankObservationSource: 'live_open_bank' | 'never_observed';
    combinedHoldings: RememberedItem[];
}

function defaults(): AssetMemory {
    return {
        inventory: [],
        equipment: [],
        bank: [],
        inventoryObservedAt: 0,
        bankObservedAt: null,
        bankObservationSource: 'never_observed',
        combinedHoldings: [],
    };
}

function load(): AssetMemory {
    if (!existsSync(ASSETS_PATH)) return defaults();
    try {
        return { ...defaults(), ...(JSON.parse(readFileSync(ASSETS_PATH, 'utf8')) as Partial<AssetMemory>) };
    } catch (error) {
        console.warn(`[assetMemory] Could not read asset memory: ${error}`);
        return defaults();
    }
}

export function combineHoldings(groups: RememberedItem[][]): RememberedItem[] {
    const counts = new Map<string, { name: string; count: number }>();
    for (const group of groups) {
        for (const item of group) {
            const key = item.name.toLowerCase();
            const existing = counts.get(key);
            if (existing) existing.count += item.count;
            else counts.set(key, { name: item.name, count: item.count });
        }
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function persist(value: AssetMemory): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TEMP_PATH, JSON.stringify(value, null, 2));
    renameSync(TEMP_PATH, ASSETS_PATH);
}

export function updateAssetMemory(state: BotWorldState): AssetMemory {
    const value = load();
    const now = Date.now();
    value.inventory = state.inventory.map(item => ({ name: item.name, count: item.count }));
    value.equipment = state.equipment.map(item => ({ name: item.name, count: item.count }));
    value.inventoryObservedAt = now;
    if (state.bank.isOpen) {
        value.bank = state.bank.items.map(item => ({ name: item.name, count: item.count }));
        value.bankObservedAt = now;
        value.bankObservationSource = 'live_open_bank';
    }
    value.combinedHoldings = combineHoldings([value.inventory, value.equipment, value.bank]);
    persist(value);
    return value;
}

export function getAssetMemory(): AssetMemory {
    return load();
}
