import { describe, expect, it } from 'vitest';
import { CHAT_MODELS, HEAVY_MODEL_HINT, isHeavyModel, modelOptionLabel } from '@pocketrocket/shared';

describe('model picker cost hint', () => {
  it('marks Opus-class models on any provider, and nothing cheaper', () => {
    expect(isHeavyModel('claude-opus-5')).toBe(true);
    expect(isHeavyModel('opencode/claude-opus-4-6')).toBe(true);
    expect(isHeavyModel('claude-fable-5-1')).toBe(true);
    expect(isHeavyModel('claude-sonnet-5')).toBe(false);
    expect(isHeavyModel('claude-haiku-4-5-20251001')).toBe(false);
    expect(isHeavyModel('auto')).toBe(false);
  });

  it('adds the hint once, after the provider note', () => {
    expect(modelOptionLabel({ id: 'claude-opus-5', label: 'Opus 5', note: 'strong, pricey' })).toBe('Opus 5 — strong, pricey, ' + HEAVY_MODEL_HINT);
    expect(modelOptionLabel({ id: 'claude-opus-5', label: 'Opus 5' })).toBe('Opus 5 — ' + HEAVY_MODEL_HINT);
    const chatOpus = CHAT_MODELS.find((m) => m.id === 'claude-opus-5')!;
    expect(modelOptionLabel(chatOpus).split(HEAVY_MODEL_HINT)).toHaveLength(2);
    expect(modelOptionLabel({ id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'balanced, default' })).toBe('Sonnet 5 — balanced, default');
  });
});
