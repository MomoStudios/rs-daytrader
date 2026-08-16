import type { SkillContext, SkillResult } from './skillLibrary';
import { executeStrategicAction } from './skillLibrary';
import { ESSENTIAL_TOOL_PATTERN } from './tradeEvaluator';
import {
    minimumSafeBundleAsk,
} from './tradeEvaluator';
import type { OperatorDirective } from './operatorSchema';
import { log } from './logger';
import { estimateOfferValue } from './priceBook';
import {
    isBlacklisted,
    recordTradeOutcome,
} from './stateStore';

function exactPattern(value: string): RegExp {
    return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

function optionPattern(value: string): RegExp {
    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function result(action: string, success: boolean, message: string): SkillResult {
    const value = { action, success, message };
    log('operator_step', value);
    return value;
}

export async function executeOperatorDirective(
    ctx: SkillContext,
    directive: OperatorDirective
): Promise<SkillResult> {
    const { bot, sdk } = ctx;
    switch (directive.type) {
        case 'strategic_action':
            return executeStrategicAction(ctx, directive.action);
        case 'walk_to': {
            const action = await bot.walkTo(directive.x, directive.z, directive.tolerance);
            return result('operator:walk_to', action.success, action.message);
        }
        case 'open_door': {
            const action = await bot.openDoor(exactPattern(directive.target));
            return result('operator:open_door', action.success, action.message);
        }
        case 'interact_npc': {
            const action = await bot.interactNpc(exactPattern(directive.target), optionPattern(directive.option));
            return result('operator:interact_npc', action.success, action.message);
        }
        case 'interact_loc': {
            const action = await bot.interactLoc(exactPattern(directive.target), optionPattern(directive.option));
            return result('operator:interact_loc', action.success, action.message);
        }
        case 'talk_to': {
            const action = await bot.talkTo(exactPattern(directive.target));
            return result('operator:talk_to', action.success, action.message);
        }
        case 'dialog_continue': {
            if (!sdk.getState()?.dialog.isOpen) {
                return result('operator:dialog_continue', false, 'No dialog is open');
            }
            const action = await sdk.sendClickDialog(0);
            if (action.success) await sdk.waitForTicks(1);
            return result('operator:dialog_continue', action.success, action.message);
        }
        case 'dialog_select': {
            const action = await sdk.clickDialogByText(optionPattern(directive.option));
            if (action.success) await sdk.waitForTicks(1);
            return result('operator:dialog_select', action.success, action.message);
        }
        case 'dismiss_blocking_ui': {
            await bot.dismissBlockingUI();
            const state = sdk.getState();
            const cleared = !state?.dialog.isOpen && !state?.modalOpen;
            return result(
                'operator:dismiss_blocking_ui',
                cleared,
                cleared ? 'Blocking UI cleared' : 'Blocking UI remains open'
            );
        }
        case 'pickup': {
            const action = await bot.pickupItem(exactPattern(directive.item));
            return result('operator:pickup', action.success, action.message);
        }
        case 'use_item_on_loc': {
            const action = await bot.useItemOnLoc(exactPattern(directive.item), exactPattern(directive.location));
            return result('operator:use_item_on_loc', action.success, action.message);
        }
        case 'bank_open': {
            const action = await bot.openBank();
            return result('operator:bank_open', action.success, action.message);
        }
        case 'bank_close': {
            const action = await bot.closeBank();
            return result('operator:bank_close', action.success, action.message);
        }
        case 'bank_deposit': {
            if (ESSENTIAL_TOOL_PATTERN.test(directive.item)) {
                return result('operator:bank_deposit', false, `Refusing to deposit essential tool: ${directive.item}`);
            }
            if (directive.amount === 0) return result('operator:bank_deposit', false, 'Deposit amount cannot be zero');
            const action = await bot.depositItem(exactPattern(directive.item), directive.amount);
            return result('operator:bank_deposit', action.success, action.message);
        }
        case 'bank_withdraw': {
            if (directive.amount === 0) return result('operator:bank_withdraw', false, 'Withdraw amount cannot be zero');
            const action = await bot.withdrawItem(exactPattern(directive.item), directive.amount);
            return result('operator:bank_withdraw', action.success, action.message);
        }
        case 'shop_open': {
            const action = await bot.openShop(exactPattern(directive.npc));
            return result('operator:shop_open', action.success, action.message);
        }
        case 'shop_close': {
            const action = await bot.closeShop();
            return result('operator:shop_close', action.success, action.message);
        }
        case 'shop_buy': {
            if (directive.amount <= 0) return result('operator:shop_buy', false, 'Shop amount must be positive');
            const action = await bot.buyFromShop(exactPattern(directive.item), directive.amount);
            return result('operator:shop_buy', action.success, action.message);
        }
        case 'smith_product': {
            const action = await bot.smithAtAnvil(directive.product, {
                barPattern: exactPattern(directive.bar),
                timeout: 15_000,
            });
            return result('operator:smith_product', action.success, action.message);
        }
        case 'trade_bundle_sell': {
            if (isBlacklisted(directive.recipient)) {
                return result(
                    'operator:trade_bundle_sell',
                    false,
                    `${directive.recipient} is blacklisted`
                );
            }
            const inventory = sdk.getInventory();
            const resolved = directive.items.map(spec => {
                const pattern = exactPattern(spec.item);
                const matches = inventory.filter(item => pattern.test(item.name));
                const count = matches.reduce((sum, item) => sum + item.count, 0);
                return {
                    requested: spec,
                    name: matches[0]?.name ?? spec.item,
                    available: count,
                };
            });
            const missing = resolved.filter(item => item.available < item.requested.amount);
            if (missing.length > 0) {
                return result(
                    'operator:trade_bundle_sell',
                    false,
                    `Missing trade items: ${missing
                        .map(item => `${item.name} ${item.available}/${item.requested.amount}`)
                        .join(', ')}`
                );
            }
            const essential = resolved.find(item => ESSENTIAL_TOOL_PATTERN.test(item.name));
            if (essential) {
                return result(
                    'operator:trade_bundle_sell',
                    false,
                    `Refusing to trade essential item: ${essential.name}`
                );
            }
            const priced = minimumSafeBundleAsk(
                resolved.map(item => ({
                    name: item.name,
                    count: item.requested.amount,
                })),
                directive.priceGp
            );
            if (priced.unknownItems.length > 0) {
                return result(
                    'operator:trade_bundle_sell',
                    false,
                    `Cannot price trade items: ${priced.unknownItems.join(', ')}`
                );
            }
            const safeAsk = priced.safeAskGp;
            const trade = await bot.trade(exactPattern(directive.recipient), {
                give: resolved.map(item => ({
                    item: exactPattern(item.name),
                    amount: item.requested.amount,
                })),
                want: [{ item: /^coins$/i, amount: safeAsk }],
                timeout: 60_000,
            });
            const receivedValue = estimateOfferValue(trade.received).total;
            const gaveValue = estimateOfferValue(trade.gave).total;
            if (trade.success) recordTradeOutcome(receivedValue - gaveValue);
            log('trade_result', {
                requester: directive.recipient,
                source: 'operator_trade_bundle_sell',
                requestedPriceGp: directive.priceGp,
                safeAskGp: safeAsk,
                success: trade.success,
                message: trade.message,
                gave: trade.gave,
                received: trade.received,
                netProfitGp: receivedValue - gaveValue,
            });
            return result(
                'operator:trade_bundle_sell',
                trade.success,
                `${trade.message} (safe ask ${safeAsk}gp)`
            );
        }
        case 'equip_item': {
            const action = await bot.equipItem(exactPattern(directive.item));
            return result('operator:equip_item', action.success, action.message);
        }
        case 'unequip_item': {
            const action = await bot.unequipItem(exactPattern(directive.item));
            return result('operator:unequip_item', action.success, action.message);
        }
        case 'set_combat_style': {
            const style = sdk
                .getState()
                ?.combatStyle?.styles.find(candidate =>
                    candidate.trainsSkills.includes(directive.skill)
                );
            if (!style) {
                return result(
                    'operator:set_combat_style',
                    false,
                    `No equipped-weapon style trains ${directive.skill}`
                );
            }
            const action = await sdk.sendSetCombatStyle(style.index);
            return result(
                'operator:set_combat_style',
                action.success,
                action.success
                    ? `Selected ${style.name} to train ${directive.skill}`
                    : action.message
            );
        }
        case 'attack_npc': {
            let state = sdk.getState();
            if (!state?.player) return result('operator:attack_npc', false, 'No player state');
            if (state.player.hp / Math.max(1, state.player.maxHp) < 0.6) {
                return result('operator:attack_npc', false, 'Refusing combat below 60% HP');
            }
            if (state.player.combat.inCombat) {
                try {
                    await sdk.waitForCondition(
                        next => !next.player?.combat.inCombat || next.player.isDead,
                        60_000
                    );
                } catch {
                    return result(
                        'operator:combat_wait',
                        false,
                        'Timed out waiting for current fight to complete'
                    );
                }
                state = sdk.getState();
            }
            const player = state?.player;
            if (!player || player.isDead) {
                return result('operator:attack_npc', false, 'Character died during combat');
            }
            if (player.hp / Math.max(1, player.maxHp) < 0.6) {
                return result('operator:attack_npc', false, 'Fight completed below 60% HP');
            }
            const npc = sdk.findNearbyNpc(exactPattern(directive.target), { reachable: true });
            if (!npc) return result('operator:attack_npc', false, `NPC not found: ${directive.target}`);
            if (npc.combatLevel > player.combatLevel + 10) {
                return result(
                    'operator:attack_npc',
                    false,
                    `Refusing NPC level ${npc.combatLevel}; player combat is ${player.combatLevel}`
                );
            }
            if (npc.inCombat && npc.targetIndex !== -1) {
                return result('operator:attack_npc', false, `${npc.name} is already in combat`);
            }
            const action = await bot.attack(npc);
            return result('operator:attack_npc', action.success, action.message);
        }
        case 'wait':
            await sdk.waitForTicks(directive.ticks);
            return result('operator:wait', true, `Waited ${directive.ticks} ticks`);
        default: {
            const exhaustive: never = directive;
            throw new Error(`Unhandled operator directive: ${JSON.stringify(exhaustive)}`);
        }
    }
}
