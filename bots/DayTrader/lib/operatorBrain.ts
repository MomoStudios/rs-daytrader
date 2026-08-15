import { CopilotClient, type CopilotSession } from '@github/copilot-sdk';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_AI_MODEL, DEFAULT_AI_REASONING_EFFORT, operatorModel } from './aiConfig';
import type {
    AiDecision,
    MarketSignal,
    MaterialReservation,
    StrategicAction,
    StrategicGoal,
} from './aiDecision';
import type { CollectionStatus } from './collectionPortfolio';
import {
    parseOperatorDecisionText,
    type OperatorDecision,
    type OperatorWorkflow,
} from './operatorSchema';
import type { OperatorRuntimeState } from './operatorStore';
import type { ProgressSnapshot, StallAssessment } from './operatorWatchdog';
import type { StoredWorkflow } from './workflowStore';
import type { ExecutionKnowledge } from './executionKnowledge';
import type { ManagedKnowledge } from './developmentStore';
import type { AssetMemory } from './assetMemory';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(__dirname, '..', 'data', 'copilot-operator-runtime');

export interface OperatorWorldObservation {
    now: number;
    stateAgeMs: number;
    player: {
        position: { x: number; z: number; level: number };
        combatLevel: number;
        hp: number;
        maxHp: number;
        runEnergy: number;
        inCombat: boolean;
    };
    skills: Array<{ name: string; level: number; experience: number }>;
    inventory: Array<{ name: string; count: number }>;
    equipment: Array<{ name: string; count: number }>;
    nearbyNpcs: Array<{ name: string; x: number; z: number; distance: number; options: string[] }>;
    nearbyObjects: Array<{ name: string; x: number; z: number; level: number; distance: number; options: string[] }>;
    groundItems: Array<{ name: string; count: number; x: number; z: number; distance: number }>;
    nearbyPlayerCount: number;
    dialog: { open: boolean; text?: string; options: string[] };
    interface: { open: boolean; id: number; options: string[] };
    bank: { open: boolean; items: Array<{ name: string; count: number }> };
    shop: { open: boolean; title: string; items: Array<{ name: string; count: number; price: number }> };
    combatStyle: {
        currentStyle: number;
        weaponName: string;
        styles: Array<{ index: number; name: string; trainsSkills: string[] }>;
    } | null;
    collectionPortfolio: CollectionStatus;
}

export interface OperatorPlanningRequest {
    strategicGoal: StrategicGoal;
    strategicRecommendation: StrategicAction;
    marketSignals: MarketSignal[];
    strategistSummary: string;
    world: OperatorWorldObservation;
    knownWorkflows: StoredWorkflow[];
    executionKnowledge: ExecutionKnowledge[];
    developmentKnowledge: ManagedKnowledge[];
    assetMemory: AssetMemory;
    materialReservations: MaterialReservation[];
}

export interface OperatorDiagnosisRequest extends OperatorPlanningRequest {
    activeWorkflow: OperatorWorkflow;
    runtime: OperatorRuntimeState;
    before: ProgressSnapshot;
    after: ProgressSnapshot;
    stall: StallAssessment;
}

const OPERATOR_SYSTEM = `
You are DayTrader's RuneScape execution operator. A separate strategist gives
you goals and market summaries. You turn them into safe, executable, persistent
declarative workflows and repair those workflows when progress stalls.

ISOLATION:
- You never receive player chat. Do not request it.
- You have no tools and cannot execute code, shell commands, or SDK methods.
- Never output TypeScript, JavaScript, shell, eval, source code, or an arbitrary
  "script" string. A generated script means a declarative JSON workflow using
  only the directives below.
- Do not handle player trades. The deterministic trading subsystem owns them.
- Do not attack players. Avoid combat when HP is below 60% unless escape is the
  goal. Never deposit or sell core tools needed by the workflow.

ROLE:
- Decompose difficult goals into prerequisites: skills, items, access, quests,
  travel, interfaces, and repeatable production loops.
- For goals such as runite ore, reason about level and access requirements,
  formulate training/access workflows, and escalate when the strategic premise
  may be poor (e.g. sustained competition or impractical risk).
- Use exact visible NPC/object/dialog names and options when available.
- executionKnowledge contains trusted, server-specific wiki and tested learning
  documents. Prefer it over generic RuneScape memory for requirements,
  locations, quest facts, and mechanics. Cite its facts in blocker evidence.
- developmentKnowledge contains active evidence-backed notes from the
  omniscient development reviewer. Use these notes to resolve prior capability
  gaps and prefer their cited server-specific facts over generic memory.
- assetMemory contains current inventory/equipment plus last-known bank
  contents. Use combinedHoldings for prerequisite planning. If a required item
  is remembered in the bank, plan a bank withdrawal rather than declaring the
  item unavailable.
- materialReservations are hard account-wide floors for persistent production
  commitments. Do not consume a reserved item for another workflow if doing so
  would reduce combined holdings below the reserved count.
- A reusable workflow may have 1-30 bounded steps. Repetition is represented by
  repeatUntilComplete + a measurable completion condition + maxAttempts.
- On diagnosis, distinguish normal resource respawn/waiting from pathing,
  closed doors, dialog/interface blockers, missing prerequisites, competition,
  stale state, and unsupported capabilities.
- If a quest/access path is not sufficiently known from state, escalate
  missing_capability instead of hallucinating exact quest steps.
- Never return a workflow made only of wait steps. Waiting is only a bounded
  sub-step for a known respawn or animation. If blocked, choose productive
  capability building (including safe combat) or escalate.
- For balanced melee training, select the style that trains the lowest of
  Attack, Strength, and Defence, then attack safe NPCs. Equip better owned
  weapons/armor when doing so is clearly an upgrade.

ALLOWED DIRECTIVES:
- strategic_action: one existing bounded action (train/travel/sell_excess/pickup/wait)
- walk_to {x,z,tolerance}
- open_door {target}
- interact_npc {target,option}; interact_loc {target,option}; talk_to {target}
- dialog_continue; dialog_select {option}
- dismiss_blocking_ui (safe SDK handling for level-up/continuation blockers)
- pickup {item}; use_item_on_loc {item,location}
- bank_open; bank_close; bank_deposit/bank_withdraw {item,amount}
- shop_open {npc}; shop_close; shop_buy {item,amount}
- smith_product {product,bar} (uses the SDK smithing product selector)
- equip_item {item}; set_combat_style {skill: Attack|Strength|Defence}
- attack_npc {target}; wait {ticks 1-20}

COMPLETION CONDITIONS:
action_success, position, inventory, skill_level, skill_xp_delta, dialog_open,
dialog_closed, interface_open, interface_closed.

Return exactly one JSON object:
{
  "summary": "execution reasoning",
  "goal": {
    "kind": "leveling" | "item_acquisition" | "wealth",
    "target": "same or prerequisite-adjusted execution goal",
    "targetValue": 1,
    "rationale": "execution rationale"
  },
  "blockers": [
    {
      "kind": "quest" | "skill" | "access" | "resource" | "competition" | "navigation" | "interface" | "unknown",
      "target": "blocker target",
      "evidence": "state evidence",
      "severity": "low" | "medium" | "high"
    }
  ],
  "workflow": {
    "name": "stable workflow name",
    "goal": "what this workflow achieves",
    "reusable": true,
    "version": 1,
    "successCriteria": ["measurable criteria"],
    "steps": [
      {
        "id": "unique-step-id",
        "description": "bounded step",
        "directive": {"type":"walk_to","x":3200,"z":3200,"tolerance":3},
        "completion": {"type":"position","x":3200,"z":3200,"tolerance":3},
        "repeatUntilComplete": false,
        "maxAttempts": 3
      }
    ]
  },
  "escalation": null
}

If execution should stop and ask the strategist, set workflow to null and use:
{
  "reason": "competition" | "goal_impractical" | "missing_capability" | "unsafe" | "repeated_failure",
  "question": "specific strategic question",
  "evidence": ["facts, no chat"],
  "suggestedOptions": ["bounded alternatives"]
}
`;

export class DayTraderOperatorBrain {
    private client: CopilotClient | null = null;
    private session: CopilotSession | null = null;
    private model = operatorModel();

    async start(): Promise<void> {
        if (this.session) return;
        mkdirSync(RUNTIME_DIR, { recursive: true });
        const client = new CopilotClient({
            mode: 'empty',
            workingDirectory: join(__dirname, '..'),
            baseDirectory: RUNTIME_DIR,
            logLevel: 'error',
        });
        try {
            await client.start();
            const models = await client.listModels();
            if (!models.some(candidate => candidate.id === this.model)) {
                const fallback = models.find(candidate => candidate.id === DEFAULT_AI_MODEL) ?? models[0];
                if (!fallback) throw new Error('Copilot returned no operator models');
                this.model = fallback.id;
            }
            this.session = await client.createSession({
                model: this.model,
                reasoningEffort: DEFAULT_AI_REASONING_EFFORT,
                availableTools: [],
                enableConfigDiscovery: false,
                enableSessionStore: false,
                systemMessage: { content: OPERATOR_SYSTEM },
                onPermissionRequest: () => ({
                    kind: 'reject',
                    feedback: 'DayTrader operator sessions never permit tool execution.',
                }),
            });
            this.client = client;
        } catch (error) {
            await client.stop().catch(() => []);
            throw error;
        }
    }

    getModel(): string {
        return this.model;
    }

    async plan(request: OperatorPlanningRequest): Promise<OperatorDecision> {
        return this.requestDecision('Create or update the execution workflow for this strategic goal.', request);
    }

    async diagnose(request: OperatorDiagnosisRequest): Promise<OperatorDecision> {
        return this.requestDecision(
            'The current workflow stalled. Diagnose the evidence, then return a repaired replacement workflow or an escalation.',
            request
        );
    }

    private async requestDecision(instruction: string, request: object): Promise<OperatorDecision> {
        if (!this.session) throw new Error('DayTraderOperatorBrain has not been started');
        // request is built only from sanitized state and strategist structures;
        // it intentionally has no gameMessages/recentChat field.
        const response = await this.session.sendAndWait(
            {
                prompt: [
                    instruction,
                    '<operator_observation>',
                    JSON.stringify(request),
                    '</operator_observation>',
                    'Return only the required JSON object.',
                ].join('\n'),
            },
            90_000
        );
        if (!response?.data.content) throw new Error('Copilot operator returned no decision content');
        try {
            return parseOperatorDecisionText(response.data.content);
        } catch (firstError) {
            const repaired = await this.session.sendAndWait(
                {
                    prompt: [
                        `Your prior operator JSON failed deterministic validation: ${firstError}`,
                        'Repair only the schema/enum/bounds error. Return exactly one corrected JSON object.',
                    ].join('\n'),
                },
                90_000
            );
            if (!repaired?.data.content) throw firstError;
            return parseOperatorDecisionText(repaired.data.content);
        }
    }

    async stop(): Promise<void> {
        const session = this.session;
        const client = this.client;
        this.session = null;
        this.client = null;
        if (session) await session.disconnect().catch(() => undefined);
        if (client) await client.stop().catch(() => []);
    }
}

export function operatorRequestFromStrategist(
    decision: AiDecision,
    world: OperatorWorldObservation,
    knownWorkflows: StoredWorkflow[]
): OperatorPlanningRequest {
    return {
        strategicGoal: decision.goal,
        strategicRecommendation: decision.nextAction,
        marketSignals: decision.marketSignals ?? [],
        strategistSummary: decision.summary,
        world,
        knownWorkflows,
        executionKnowledge: [],
        developmentKnowledge: [],
        assetMemory: {
            inventory: world.inventory,
            equipment: world.equipment,
            bank: world.bank.items,
            inventoryObservedAt: world.now,
            bankObservedAt: world.bank.open ? world.now : null,
            bankObservationSource: world.bank.open ? 'live_open_bank' : 'never_observed',
            combinedHoldings: [...world.inventory, ...world.equipment, ...world.bank.items],
        },
        materialReservations: decision.reservations ?? [],
    };
}
