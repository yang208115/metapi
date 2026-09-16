import { describe, expect, it } from 'vitest';
import { mapModelDescriptionsFromPayload } from './upstreamModelDescriptionService.js';

describe('upstreamModelDescriptionService', () => {
  it('extracts descriptions from wrapped newapi models payload', () => {
    const descriptions = mapModelDescriptionsFromPayload({
      data: [
        { model_name: 'gpt-4o', description: 'OpenAI flagship model' },
        { model_name: 'claude-sonnet-4-5', description: 'Anthropic balanced model' },
      ],
    });

    expect(descriptions.get('gpt-4o')).toBe('OpenAI flagship model');
    expect(descriptions.get('claude-sonnet-4-5')).toBe('Anthropic balanced model');
  });

  it('accepts alternate model keys and description fields', () => {
    const descriptions = mapModelDescriptionsFromPayload([
      { id: 'Qwen/Qwen3-8B', model_description: 'Qwen open model' },
      { name: 'deepseek-v3.2', desc: 'DeepSeek chat model' },
    ]);

    expect(descriptions.get('qwen/qwen3-8b')).toBe('Qwen open model');
    expect(descriptions.get('deepseek-v3.2')).toBe('DeepSeek chat model');
  });

  it('ignores blank model names and blank descriptions', () => {
    const descriptions = mapModelDescriptionsFromPayload({
      data: [
        { model_name: '  ', description: 'invalid' },
        { model_name: 'gpt-5-nano', description: '   ' },
      ],
    });

    expect(descriptions.size).toBe(0);
  });
});
