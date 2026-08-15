import type { SkillContext, SkillResult } from './skillLibrary';
import { executeStrategicAction } from './skillLibrary';
import { ESSENTIAL_TOOL_PATTERN } from './tradeEvaluator';
import type { OperatorDirective } from './operatorSchema';
import { log } from './logger';

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
        case 'attack_npc': {
            const state = sdk.getState();
            if (!state?.player) return result('operator:attack_npc', false, 'No player state');
            if (state.player.hp / Math.max(1, state.player.maxHp) < 0.6) {
                return result('operator:attack_npc', false, 'Refusing combat below 60% HP');
            }
            const npc = sdk.findNearbyNpc(exactPattern(directive.target), { reachable: true });
            if (!npc) return result('operator:attack_npc', false, `NPC not found: ${directive.target}`);
            if (npc.combatLevel > state.player.combatLevel + 10) {
                return result(
                    'operator:attack_npc',
                    false,
                    `Refusing NPC level ${npc.combatLevel}; player combat is ${state.player.combatLevel}`
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
