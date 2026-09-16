import { describe, expect, it } from 'vitest';
import { PAYLOAD_RULE_PROTOCOL_OPTIONS } from './settings/payloadRuleProtocolOptions.js';

describe('payload rule platform options', () => {
  it('lists only the supported upstream protocol families', () => {
    const values = PAYLOAD_RULE_PROTOCOL_OPTIONS.map((option) => option.value);

    expect(values).toEqual([
      '',
      'openai',
      'claude',
      'gemini',
    ]);
  });
});
