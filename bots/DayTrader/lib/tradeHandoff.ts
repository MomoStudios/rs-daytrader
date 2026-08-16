import type { AssetMemory } from './assetMemory';
import type { AiDecision, TradeOrder } from './aiDecision';
import type { OperatorDecision, OperatorWorkflowStep } from './operatorSchema';
import { ESSENTIAL_TOOL_PATTERN } from './tradeEvaluator';

function count(items: Array<{ name: string; count: number }>, name: string): number {
    return items
        .filter(item => item.name.toLowerCase() === name.toLowerCase())
        .reduce((sum, item) => sum + item.count, 0);
}

export function compileTradeHandoff(
    decision: AiDecision,
    assets: AssetMemory,
    position?: { x: number; z: number }
): OperatorDecision | null {
    const order = decision.tradeOrders[0];
    if (!order) return null;
    const missing = order.items.filter(
        item => count(assets.combinedHoldings, item.item) < item.amount
    );
    if (missing.length > 0) return null;

    const withdrawals = order.items.filter(
        item =>
            count(assets.inventory, item.item) +
                count(assets.equipment, item.item) <
            item.amount
    );
    const unequips = order.items.filter(
        item =>
            count(assets.inventory, item.item) +
                count(assets.bank, item.item) <
                item.amount &&
            count(assets.equipment, item.item) > 0
    );
    const steps: OperatorWorkflowStep[] = [];
    const needsStaging = withdrawals.length > 0 || unequips.length > 0;
    if (needsStaging) {
        const banks = [
            { x: 3185, z: 3436, name: 'Varrock West Bank' },
            { x: 3092, z: 3243, name: 'Draynor Bank' },
        ];
        const bank = position
            ? [...banks].sort(
                  (a, b) =>
                      Math.hypot(position.x - a.x, position.z - a.z) -
                      Math.hypot(position.x - b.x, position.z - b.z)
              )[0]!
            : banks[0]!;
        steps.push({
            id: 'walk-to-bank-for-trade',
            description: `Walk to ${bank.name} before staging the bundle.`,
            directive: { type: 'walk_to', x: bank.x, z: bank.z, tolerance: 5 },
            completion: { type: 'position', x: bank.x, z: bank.z, tolerance: 5 },
            repeatUntilComplete: false,
            maxAttempts: 8,
        });
        steps.push({
            id: 'open-bank-for-trade',
            description: 'Open a nearby bank to stage the strategist-authorized trade bundle.',
            directive: { type: 'bank_open' },
            completion: { type: 'interface_open' },
            repeatUntilComplete: false,
            maxAttempts: 3,
        });
        const bundleNames = new Set(order.items.map(item => item.item.toLowerCase()));
        const freeSlots = 28 - assets.inventory.length;
        const requiredSlots =
            withdrawals.reduce(
                (sum, item) =>
                    sum +
                    Math.max(
                        0,
                        item.amount -
                            count(assets.inventory, item.item) -
                            count(assets.equipment, item.item)
                    ),
                0
            ) + unequips.length;
        if (requiredSlots > freeSlots) {
            const depositCandidates = [
                ...new Map(
                    assets.inventory
                        .filter(
                            item =>
                                !bundleNames.has(item.name.toLowerCase()) &&
                                !ESSENTIAL_TOOL_PATTERN.test(item.name)
                        )
                        .map(item => [item.name.toLowerCase(), item] as const)
                ).values(),
            ];
            let recovered = freeSlots;
            for (const [index, item] of depositCandidates.entries()) {
                steps.push({
                    id: `deposit-for-trade-space-${index + 1}`,
                    description: `Deposit ${item.name} to make room for the authorized trade bundle.`,
                    directive: {
                        type: 'bank_deposit',
                        item: item.name,
                        amount: -1,
                    },
                    completion: { type: 'action_success' },
                    repeatUntilComplete: false,
                    maxAttempts: 3,
                });
                recovered += assets.inventory.filter(
                    slot => slot.name.toLowerCase() === item.name.toLowerCase()
                ).length;
                if (recovered >= requiredSlots) break;
            }
            if (recovered < requiredSlots) return null;
        }
        if (unequips.length > 0) {
            steps.push({
                id: 'close-bank-before-unequip',
                description: 'Close the bank before unequipping trade items.',
                directive: { type: 'bank_close' },
                completion: { type: 'interface_closed' },
                repeatUntilComplete: false,
                maxAttempts: 3,
            });
            for (const [index, item] of unequips.entries()) {
                steps.push({
                    id: `unequip-trade-item-${index + 1}`,
                    description: `Unequip ${item.item} for the authorized bundle.`,
                    directive: { type: 'unequip_item', item: item.item },
                    completion: { type: 'action_success' },
                    repeatUntilComplete: false,
                    maxAttempts: 3,
                });
            }
            if (withdrawals.length > 0) {
                steps.push({
                    id: 'reopen-bank-for-trade',
                    description: 'Reopen the bank to withdraw remaining bundle items.',
                    directive: { type: 'bank_open' },
                    completion: { type: 'interface_open' },
                    repeatUntilComplete: false,
                    maxAttempts: 3,
                });
            }
        }
        for (const [index, item] of withdrawals.entries()) {
            const needed = item.amount - count(assets.inventory, item.item);
            steps.push({
                id: `withdraw-trade-item-${index + 1}`,
                description: `Withdraw ${needed} ${item.item} for the authorized bundle.`,
                directive: {
                    type: 'bank_withdraw',
                    item: item.item,
                    amount: needed,
                },
                completion: { type: 'action_success' },
                repeatUntilComplete: false,
                maxAttempts: 3,
            });
        }
        if (withdrawals.length > 0 || unequips.length === 0) {
            steps.push({
                id: 'close-bank-for-trade',
                description: 'Close the bank before initiating the player trade.',
                directive: { type: 'bank_close' },
                completion: { type: 'interface_closed' },
                repeatUntilComplete: false,
                maxAttempts: 3,
            });
        }
    }
    steps.push(tradeStep(order));

    return {
        summary: `Stage and atomically sell the strategist-authorized bundle to ${order.recipient}; deterministic policy will raise the ask if required.`,
        goal: decision.goal,
        blockers: [],
        workflow: {
            name: `trade-bundle-${order.recipient.toLowerCase()}`,
            goal: `Sell the held authorized bundle to ${order.recipient} atomically.`,
            reusable: false,
            version: 1,
            successCriteria: [`Atomic trade with ${order.recipient} succeeds`],
            steps,
        },
        escalation: null,
    };
}

function tradeStep(order: TradeOrder): OperatorWorkflowStep {
    return {
        id: 'execute-atomic-player-trade',
        description: `Atomically trade the authorized bundle to ${order.recipient}.`,
        directive: {
            type: 'trade_bundle_sell',
            recipient: order.recipient,
            items: order.items,
            priceGp: order.priceGp,
        },
        completion: { type: 'action_success' },
        repeatUntilComplete: false,
        maxAttempts: 3,
    };
}
