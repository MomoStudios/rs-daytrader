import type { TradeItem } from '../../../sdk/types';

export type InventorySummary = Map<
    number,
    { id: number; name: string; count: number }
>;

export function summarizeInventory(
    items: Array<{ id: number; name: string; count: number }>
): InventorySummary {
    const summary: InventorySummary = new Map();
    for (const item of items) {
        const existing = summary.get(item.id);
        if (existing) existing.count += item.count;
        else summary.set(item.id, { id: item.id, name: item.name, count: item.count });
    }
    return summary;
}

export function inventoryDelta(
    before: InventorySummary,
    after: InventorySummary
): { gave: TradeItem[]; received: TradeItem[] } {
    const gave: TradeItem[] = [];
    const received: TradeItem[] = [];
    const ids = new Set([...before.keys(), ...after.keys()]);
    for (const id of ids) {
        const prior = before.get(id);
        const current = after.get(id);
        const delta = (current?.count ?? 0) - (prior?.count ?? 0);
        if (delta > 0) {
            received.push({
                slot: -1,
                id,
                name: current?.name ?? prior?.name ?? `Item ${id}`,
                count: delta,
            });
        } else if (delta < 0) {
            gave.push({
                slot: -1,
                id,
                name: prior?.name ?? current?.name ?? `Item ${id}`,
                count: -delta,
            });
        }
    }
    return { gave, received };
}
