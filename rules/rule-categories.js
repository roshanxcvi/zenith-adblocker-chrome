export const RULE_CATEGORIES = {
  ads: {
    id: 'ads',
    shortLabel: 'ADS',
    label: 'Ads',
    enabledByDefault: true,
    description: 'Blocks common ad networks, banners, popups, and ad scripts.'
  },

  trackers: {
    id: 'trackers',
    shortLabel: 'TRACK',
    label: 'Trackers',
    enabledByDefault: true,
    description: 'Blocks analytics, pixels, tracking scripts, and cross-site trackers.'
  },

  fingerprinting: {
    id: 'fingerprinting',
    shortLabel: 'FP',
    label: 'Fingerprinting',
    enabledByDefault: true,
    description: 'Reduces browser fingerprinting and tracking techniques.'
  },

  cookie: {
    id: 'cookie',
    shortLabel: 'COOKIE',
    label: 'Cookie Popups',
    enabledByDefault: true,
    description: 'Blocks or hides cookie banners and consent popups.'
  },

  annoyances: {
    id: 'annoyances',
    shortLabel: 'ANN',
    label: 'Annoyances',
    enabledByDefault: true,
    description: 'Blocks newsletter popups, overlays, floating videos, and other annoyances.'
  },

  miners: {
    id: 'miners',
    shortLabel: 'MINE',
    label: 'Crypto Miners',
    enabledByDefault: true,
    description: 'Blocks browser-based crypto mining scripts.'
  },

  malware: {
    id: 'malware',
    shortLabel: 'MAL',
    label: 'Malware',
    enabledByDefault: true,
    description: 'Blocks known malicious, phishing, and scam domains.'
  },

  social: {
    id: 'social',
    shortLabel: 'SOCIAL',
    label: 'Social Widgets',
    enabledByDefault: false,
    description: 'Blocks social share buttons, embeds, and tracking widgets.'
  }
};

export function getDefaultRuleCategorySettings() {
  const settings = {};

  for (const [key, category] of Object.entries(RULE_CATEGORIES)) {
    settings[key] = category.enabledByDefault;
  }

  return settings;
}

export function normalizeRuleCategorySettings(input = {}) {
  const defaults = getDefaultRuleCategorySettings();
  const output = { ...defaults };

  for (const key of Object.keys(defaults)) {
    if (typeof input[key] === 'boolean') {
      output[key] = input[key];
    }
  }

  return output;
}