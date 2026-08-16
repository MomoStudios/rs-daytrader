import type { BotWorldState } from '../../../sdk/types';
import type { CompletionCondition } from './operatorSchema';

export interface ProgressSnapshot {
    at: number;
    tick: number;
    revision: number;
    position: { x: number; z: number; level: number } | null;
    skills: Record<string, { level: number; xp: number }>;
    inventory: Record<string, number>;
    dialogOpen: boolean;
    interfaceOpen: boolean;
    interfaceId: number;
    modalOpen: boolean;
    modalInterface: number;
    tradeOpen: boolean;
    nearbyPlayerCount: number;
}

export interface ProgressEvaluation {
    complete: boolean;
    progressed: boolean;
    evidence: string[];
}

export function snapshotProgress(state: BotWorldState | null, at = Date.now()): ProgressSnapshot {
    const skills: ProgressSnapshot['skills'] = {};
    const inventory: Record<string, number> = {};
    for (const skill of state?.skills ?? []) {
        skills[skill.name.toLowerCase()] = { level: skill.baseLevel, xp: skill.experience };
    }
    for (const item of state?.inventory ?? []) {
        const key = item.name.toLowerCase();
        inventory[key] = (inventory[key] ?? 0) + item.count;
    }
    return {
        at,
        tick: state?.tick ?? 0,
        revision: state?.revision ?? state?.tick ?? 0,
        position: state?.player
            ? { x: state.player.worldX, z: state.player.worldZ, level: state.player.level }
            : null,
        skills,
        inventory,
        dialogOpen: state?.dialog.isOpen ?? false,
        interfaceOpen: state?.interface.isOpen ?? false,
        interfaceId: state?.interface.interfaceId ?? -1,
        modalOpen: state?.modalOpen ?? false,
        modalInterface: state?.modalInterface ?? -1,
        tradeOpen: state?.trade?.isOpen ?? false,
        nearbyPlayerCount: state?.nearbyPlayers.length ?? 0,
    };
}

export function evaluateProgress(
    before: ProgressSnapshot,
    after: ProgressSnapshot,
    condition: CompletionCondition,
    actionSuccess: boolean
): ProgressEvaluation {
    const evidence: string[] = [];
    let meaningfulProgress = false;
    const positionChanged =
        !!before.position &&
        !!after.position &&
        (before.position.x !== after.position.x ||
            before.position.z !== after.position.z ||
            before.position.level !== after.position.level);
    if (positionChanged) {
        evidence.push('position changed');
        meaningfulProgress = true;
    }
    if (after.revision > before.revision) evidence.push(`state revision +${after.revision - before.revision}`);

    for (const [name, skill] of Object.entries(after.skills)) {
        const prior = before.skills[name];
        if (prior && skill.xp > prior.xp) {
            evidence.push(`${name} xp +${skill.xp - prior.xp}`);
            meaningfulProgress = true;
        }
    }
    for (const [name, count] of Object.entries(after.inventory)) {
        const delta = count - (before.inventory[name] ?? 0);
        if (delta !== 0) {
            evidence.push(`${name} ${delta > 0 ? '+' : ''}${delta}`);
            meaningfulProgress = true;
        }
    }
    if (before.dialogOpen !== after.dialogOpen) meaningfulProgress = true;
    if (before.interfaceOpen !== after.interfaceOpen) meaningfulProgress = true;

    let complete = false;
    switch (condition.type) {
        case 'action_success':
            complete = actionSuccess;
            break;
        case 'position':
            complete =
                !!after.position &&
                Math.hypot(after.position.x - condition.x, after.position.z - condition.z) <= condition.tolerance;
            break;
        case 'inventory':
            complete = (after.inventory[condition.item.toLowerCase()] ?? 0) >= condition.count;
            break;
        case 'skill_level':
            complete = (after.skills[condition.skill.toLowerCase()]?.level ?? 0) >= condition.level;
            break;
        case 'skill_xp_delta':
            complete =
                (after.skills[condition.skill.toLowerCase()]?.xp ?? 0) -
                    (before.skills[condition.skill.toLowerCase()]?.xp ?? 0) >=
                condition.delta;
            break;
        case 'dialog_open':
            complete = after.dialogOpen;
            break;
        case 'dialog_closed':
            complete = !after.dialogOpen;
            break;
        case 'interface_open':
            complete = after.interfaceOpen;
            break;
        case 'interface_closed':
            complete = !after.interfaceOpen;
            break;
    }
    return { complete, progressed: complete || meaningfulProgress, evidence };
}

export interface StallAssessment {
    stalled: boolean;
    reason: 'none' | 'state_stale' | 'repeated_failure' | 'no_progress' | 'blocked_ui' | 'possible_competition';
    evidence: string[];
}

export function assessStall(input: {
    attempts: number;
    lastProgressAt: number;
    now: number;
    stateAgeMs: number;
    sameFailureCount: number;
    snapshot: ProgressSnapshot;
    recentEvidence: string[];
}): StallAssessment {
    if (input.stateAgeMs > 30_000) {
        return { stalled: true, reason: 'state_stale', evidence: [`state age ${input.stateAgeMs}ms`] };
    }
    if (input.snapshot.dialogOpen || input.snapshot.interfaceOpen || input.snapshot.modalOpen) {
        if (input.now - input.lastProgressAt > 20_000) {
            return { stalled: true, reason: 'blocked_ui', evidence: ['blocking UI stayed open without progress'] };
        }
    }
    if (input.sameFailureCount >= 3) {
        return { stalled: true, reason: 'repeated_failure', evidence: [`same failure repeated ${input.sameFailureCount} times`] };
    }
    if (input.attempts >= 3 && input.now - input.lastProgressAt > 45_000) {
        const competition = input.snapshot.nearbyPlayerCount >= 3 && input.recentEvidence.length === 0;
        return {
            stalled: true,
            reason: competition ? 'possible_competition' : 'no_progress',
            evidence: competition
                ? [`${input.snapshot.nearbyPlayerCount} nearby players and no progress`]
                : [`no measurable progress for ${input.now - input.lastProgressAt}ms`],
        };
    }
    return { stalled: false, reason: 'none', evidence: [] };
}
