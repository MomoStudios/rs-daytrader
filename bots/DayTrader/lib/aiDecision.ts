export const PROGRESSION_ACTIVITIES = [
    'woodcutting',
    'fishing',
    'mining',
    'firemaking',
    'cooking',
    'smithing',
] as const;

export type ProgressionActivity = (typeof PROGRESSION_ACTIVITIES)[number];

export const DESTINATIONS = [
    'lumbridge_market',
    'lumbridge_trees',
    'lumbridge_range',
    'lumbridge_furnace',
    'draynor_fishing',
    'varrock_oaks',
    'draynor_willows',
    'se_varrock_mine',
    'varrock_anvil',
] as const;

export type Destination = (typeof DESTINATIONS)[number];

export interface StrategicGoal {
    kind: 'leveling' | 'item_acquisition' | 'wealth';
    target: string;
    targetValue: number;
    rationale: string;
}

export interface MarketSignal {
    kind: 'demand' | 'supply' | 'trade_offer' | 'market_question';
    topic: string;
    participants: string[];
    evidence: string;
    confidence: number;
    implication: string;
}

export interface MaterialReservation {
    item: string;
    count: number;
    purpose: string;
}

export type StrategicAction =
    | { type: 'train'; activity: ProgressionActivity }
    | { type: 'travel'; destination: Destination }
    | { type: 'sell_excess' }
    | { type: 'pickup' }
    | { type: 'wait' };

export type ChatAction =
    | {
          type: 'reply';
          recipient: string;
          message: string;
          rationale: string;
      }
    | {
          type: 'broadcast';
          message: string;
          rationale: string;
      }
    | {
          type: 'discussion';
          message: string;
          rationale: string;
      }
    | {
          type: 'offer_sell' | 'offer_buy';
          recipient: string;
          item: string;
          priceGp: number;
          rationale: string;
      };

export interface AiDecision {
    summary: string;
    marketSignals: MarketSignal[];
    reservations: MaterialReservation[];
    goal: StrategicGoal;
    chatActions: ChatAction[];
    nextAction: StrategicAction;
}

const ACTIVITY_SET = new Set<string>(PROGRESSION_ACTIVITIES);
const DESTINATION_SET = new Set<string>(DESTINATIONS);
const GOAL_KINDS = new Set(['leveling', 'item_acquisition', 'wealth']);
const MARKET_SIGNAL_KINDS = new Set(['demand', 'supply', 'trade_offer', 'market_question']);
const CHAT_ACTION_TYPES = new Set(['reply', 'broadcast', 'discussion', 'offer_sell', 'offer_buy']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) throw new Error(`${field} must not be empty`);
    if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
    return normalized;
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
    if (value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`);
    return Math.round(value);
}

function validateGoal(value: unknown): StrategicGoal {
    if (!isRecord(value)) throw new Error('goal must be an object');
    if (typeof value.kind !== 'string' || !GOAL_KINDS.has(value.kind)) {
        throw new Error('goal.kind is invalid');
    }
    return {
        kind: value.kind as StrategicGoal['kind'],
        target: boundedString(value.target, 'goal.target', 160),
        targetValue: boundedNumber(value.targetValue, 'goal.targetValue', 1, 10_000_000),
        rationale: boundedString(value.rationale, 'goal.rationale', 240),
    };
}

function validateMarketSignal(value: unknown): MarketSignal {
    if (!isRecord(value)) throw new Error('market signal must be an object');
    if (typeof value.kind !== 'string' || !MARKET_SIGNAL_KINDS.has(value.kind)) {
        throw new Error('marketSignal.kind is invalid');
    }
    if (!Array.isArray(value.participants) || value.participants.length > 5) {
        throw new Error('marketSignal.participants must be an array with at most 5 entries');
    }
    return {
        kind: value.kind as MarketSignal['kind'],
        topic: boundedString(value.topic, 'marketSignal.topic', 100),
        participants: value.participants.map((participant, index) =>
            boundedString(participant, `marketSignal.participants[${index}]`, 32)
        ),
        evidence: boundedString(value.evidence, 'marketSignal.evidence', 180),
        confidence: boundedNumber(value.confidence, 'marketSignal.confidence', 0, 100),
        implication: boundedString(value.implication, 'marketSignal.implication', 220),
    };
}

function validateAction(value: unknown): StrategicAction {
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new Error('nextAction must be an object with a type');
    }
    switch (value.type) {
        case 'train':
            if (typeof value.activity !== 'string' || !ACTIVITY_SET.has(value.activity)) {
                throw new Error('nextAction.activity is invalid');
            }
            return { type: 'train', activity: value.activity as ProgressionActivity };
        case 'travel':
            if (typeof value.destination !== 'string' || !DESTINATION_SET.has(value.destination)) {
                throw new Error('nextAction.destination is invalid');
            }
            return { type: 'travel', destination: value.destination as Destination };
        case 'sell_excess':
        case 'pickup':
        case 'wait':
            return { type: value.type };
        default:
            throw new Error(`nextAction.type '${value.type}' is not allowed`);
    }
}

function validateChatAction(value: unknown): ChatAction {
    if (!isRecord(value) || typeof value.type !== 'string' || !CHAT_ACTION_TYPES.has(value.type)) {
        throw new Error('chat action type is invalid');
    }
    const rationale = boundedString(value.rationale, 'chatAction.rationale', 180);
    if (value.type === 'broadcast' || value.type === 'discussion') {
        return {
            type: value.type,
            message: boundedString(value.message, 'chatAction.message', 140),
            rationale,
        };
    }
    const recipient = boundedString(value.recipient, 'chatAction.recipient', 32);
    if (value.type === 'reply') {
        return {
            type: 'reply',
            recipient,
            message: boundedString(value.message, 'chatAction.message', 140),
            rationale,
        };
    }
    return {
        type: value.type as 'offer_sell' | 'offer_buy',
        recipient,
        item: boundedString(value.item, 'chatAction.item', 80),
        priceGp: boundedNumber(value.priceGp, 'chatAction.priceGp', 1, 100_000_000),
        rationale,
    };
}

export function parseAiDecision(value: unknown): AiDecision {
    if (!isRecord(value)) throw new Error('AI decision must be an object');
    if (!Array.isArray(value.marketSignals)) throw new Error('marketSignals must be an array');
    if (value.marketSignals.length > 6) throw new Error('marketSignals may contain at most 6 entries');
    if (!Array.isArray(value.reservations) || value.reservations.length > 10) {
        throw new Error('reservations must contain at most 10 entries');
    }
    if (!Array.isArray(value.chatActions)) throw new Error('chatActions must be an array');
    if (value.chatActions.length > 3) throw new Error('chatActions may contain at most 3 entries');
    return {
        summary: boundedString(value.summary, 'summary', 300),
        marketSignals: value.marketSignals.map(validateMarketSignal),
        reservations: value.reservations.map((entry, index): MaterialReservation => {
            if (!isRecord(entry)) throw new Error(`reservations[${index}] must be an object`);
            return {
                item: boundedString(entry.item, `reservations[${index}].item`, 80),
                count: boundedNumber(entry.count, `reservations[${index}].count`, 1, 100_000),
                purpose: boundedString(entry.purpose, `reservations[${index}].purpose`, 180),
            };
        }),
        goal: validateGoal(value.goal),
        chatActions: value.chatActions.map(validateChatAction),
        nextAction: validateAction(value.nextAction),
    };
}

export function parseAiDecisionText(text: string): AiDecision {
    const trimmed = text.trim();
    const withoutFence = trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    return parseAiDecision(JSON.parse(withoutFence));
}
