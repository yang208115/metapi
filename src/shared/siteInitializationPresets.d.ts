export type SiteInitializationPresetId = string;
export type SiteInitializationPreset = {
  id: SiteInitializationPresetId;
  label: string;
  providerLabel: string;
  description: string;
  platform: string;
  defaultUrl?: string;
  initialSegment: 'session' | 'apikey';
  recommendedSkipModelFetch: boolean;
  recommendedModels: string[];
  docsUrl?: string;
};

export declare function listSiteInitializationPresets(): SiteInitializationPreset[];
export declare function getSiteInitializationPreset(id: string | null | undefined): SiteInitializationPreset | null;
export declare function detectSiteInitializationPreset(url: string, platform?: string | null): SiteInitializationPreset | null;
