import { describe, expect, it } from 'vitest';

import {
  detectSiteInitializationPreset,
  getSiteInitializationPreset,
  listSiteInitializationPresets,
} from './siteInitializationPresets.js';

describe('siteInitializationPresets', () => {
  it('does not expose vendor-specific presets', () => {
    expect(listSiteInitializationPresets()).toEqual([]);
    expect(getSiteInitializationPreset('deepseek-openai')).toBeNull();
    expect(detectSiteInitializationPreset('https://api.deepseek.com/v1')).toBeNull();
  });
});
