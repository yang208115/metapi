import { detectPlatform } from './platforms/index.js';
import { detectSiteInitializationPreset } from '../../shared/siteInitializationPresets.js';
import { analyzePrimarySiteUrl } from '../../shared/sitePrimaryUrl.js';
import { logOperation, operationalUrlHost } from '../shared/operationalLog.js';

export async function detectSite(url: string) {
  const host = operationalUrlHost(url);
  return logOperation('site.detect', { host, strategy: 'url_rules' }, () => detectSiteInternal(url), (result) => ({
    status: result ? 'succeeded' : 'failed',
    platform: result?.platform,
    reason: result ? 'matched_url_rule' : 'no_supported_platform_matched',
  }));
}

async function detectSiteInternal(url: string) {
  const analyzed = analyzePrimarySiteUrl(url);
  const detectionUrl = analyzed.canonicalUrl;
  const persistedUrl = analyzed.persistedUrl || detectionUrl;
  const preset = detectSiteInitializationPreset(detectionUrl);
  if (preset) {
    return {
      url: persistedUrl,
      platform: preset.platform,
      initializationPresetId: preset.id,
    };
  }
  const adapter = await detectPlatform(detectionUrl);
  if (!adapter) return null;
  return { url: persistedUrl, platform: adapter.platformName };
}
