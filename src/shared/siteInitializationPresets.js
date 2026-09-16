// Vendor-specific initialization presets were intentionally removed. Sites are
// now configured through the three supported upstream protocol families:
// OpenAI, Claude, and Gemini.

const SITE_INITIALIZATION_PRESETS = Object.freeze([]);

function clonePreset(preset) {
  if (!preset) return null;
  return {
    ...preset,
    recommendedModels: [...preset.recommendedModels],
  };
}

export function listSiteInitializationPresets() {
  return SITE_INITIALIZATION_PRESETS.map((preset) => clonePreset(preset));
}

export function getSiteInitializationPreset(id) {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) return null;
  return clonePreset(SITE_INITIALIZATION_PRESETS.find((preset) => preset.id === normalizedId) || null);
}

export function detectSiteInitializationPreset() {
  return null;
}
