import type { AssetMemory } from './assetMemory';
import type { AiDecision, TradeOrder } from './aiDecision';
import type { OperatorDecision, OperatorWorkflowStep } from './operatorSchema';

function count(items: Array<{ name: string; count: number }>, name: string): number {
    return items
        .filter(item => item.name.toLowerCase() === name.toLowerCase())
        .reduce((sum, item) => sum + item.count, 0);
}

export function compileTradeHandoff(
    decision: AiDecision,
    assets: AssetMemory
): OperatorDecision | null {
    const order = decision.tradeOrders[0];
    if (!order) return null;
    const missing = order.items.filter(
        item => count(assets.combinedHoldings, item.item) < item.amount
    );
    if (missing.length > 0) return null;

    const withdrawals = order.items.filter(
        item => count(assets.inventory, item.item) < item.amount
    );
    const steps: OperatorWorkflowStep[] = [];
    if (withdrawals.length > 0) {
        steps.push({
            id: 'open-bank-for-trade',
            description: 'Open a nearby bank to stage the strategist-authorized trade bundle.',
            directive: { type: 'bank_open' },
            completion: { type: 'interface_open' },
            repeatUntilComplete: false,
            maxAttempts: 3,
        });
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
        steps.push({
            id: 'close-bank-for-trade',
            description: 'Close the bank before initiating the player trade.',
            directive: { type: 'bank_close' },
            completion: { type: 'interface_closed' },
            repeatUntilComplete: false,
            maxAttempts: 3,
        });
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
