import { describe, expect, test } from 'bun:test';
import {
    DEFAULT_AI_MODEL,
    DEFAULT_AI_REASONING_EFFORT,
    operatorModel,
    strategistModel,
} from '../lib/aiConfig';

describe('AI model configuration', () => {
    test('uses GPT-5.6 Luna medium for both AI layers by default', () => {
        expect(DEFAULT_AI_MODEL).toBe('gpt-5.6-luna');
        expect(DEFAULT_AI_REASONING_EFFORT).toBe('medium');
        expect(strategistModel()).toBe('gpt-5.6-luna');
        expect(operatorModel()).toBe('gpt-5.6-luna');
    });
});
