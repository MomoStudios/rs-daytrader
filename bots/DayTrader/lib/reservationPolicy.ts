import type { MaterialReservation } from './aiDecision';
import type { AssetMemory } from './assetMemory';
import type { OperatorWorkflow } from './operatorSchema';

function canonical(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function smithingBarCost(product: string): number {
    const value = canonical(product);
    if (/platebody/.test(value)) return 5;
    if (/platelegs|plateskirt|kiteshield|chainbody|two handed|2h/.test(value)) return 3;
    if (/full helm|sq shield|sword|mace/.test(value)) return 2;
    return 1;
}

function workflowFulfillsReservation(
    workflow: OperatorWorkflow,
    product: string,
    reservation: MaterialReservation
): boolean {
    const goal = canonical(workflow.goal);
    const purpose = canonical(reservation.purpose);
    const productWords = canonical(product).split(' ').filter(word => word.length >= 4);
    return (
        productWords.every(word => purpose.includes(word)) &&
        productWords.every(word => goal.includes(word))
    );
}

export function reservationViolations(
    workflow: OperatorWorkflow,
    reservations: MaterialReservation[],
    assets: AssetMemory
): string[] {
    const violations: string[] = [];
    for (const step of workflow.steps) {
        if (step.directive.type !== 'smith_product') continue;
        const bar = canonical(step.directive.bar);
        const held =
            assets.combinedHoldings.find(item => canonical(item.name) === bar)?.count ?? 0;
        const cost = smithingBarCost(step.directive.product);
        for (const reservation of reservations) {
            if (canonical(reservation.item) !== bar) continue;
            if (workflowFulfillsReservation(workflow, step.directive.product, reservation)) {
                continue;
            }
            if (held - cost < reservation.count) {
                violations.push(
                    `${step.directive.product} would consume ${cost} ${step.directive.bar}, leaving ${held - cost} below reservation ${reservation.count} for ${reservation.purpose}`
                );
            }
        }
    }
    return violations;
}
