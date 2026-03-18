/**
 * Filter List Manager
 * 
 * Manages multiple community filter lists with auto-download/update.
 * Equivalent to uBlock Origin's filter list system.
 * 
 * Included lists:
 * - EasyList (ads)
 * - EasyPrivacy (trackers)
 * - Peter Lowe's Ad & Tracking server list
 * - Fanboy's Annoyance List (social, popups)
 * - Fanboy's Social Blocking List
 * - EasyList Cookie List
 * - Online Malicious URL Blocklist
 * - HaGeZi Multi Pro DNS Blocklist
 * - StevenBlack Unified Hosts
 * - uBlock filters
 */

export const FILTER_LISTS = {
  // ——— Core Ad Blocking ———
  easylist: {
    name: 'EasyList',
    description: 'Primary ad blocking list — removes most ads from international webpages',
    url: 'https://easylist.to/easylist/easylist.txt',
    category: 'ads',
    enabled: true,
    builtin: true,
  },
  peterlowe: {
    name: "Peter Lowe's Ad & Tracking List",
    description: 'Blocklist of hostnames for blocking ads, trackers and other annoyances',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    category: 'ads',
    enabled: true,
    builtin: true,
  },

  // ——— Privacy / Tracker Blocking ———
  easyprivacy: {
    name: 'EasyPrivacy',
    description: 'Removes all forms of tracking from the internet — web bugs, tracking scripts, info collectors',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    category: 'privacy',
    enabled: true,
    builtin: true,
  },

  // ——— Annoyances ———
  fanboy_annoyance: {
    name: "Fanboy's Annoyance List",
    description: 'Blocks social media content, in-page popups, and other annoyances',
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    category: 'annoyances',
    enabled: true,
    builtin: true,
  },
  fanboy_social: {
    name: "Fanboy's Social Blocking List",
    description: 'Removes social media widgets — Facebook like buttons, Twitter widgets, etc.',
    url: 'https://easylist.to/easylist/fanboy-social.txt',
    category: 'annoyances',
    enabled: false, // Included in Fanboy's Annoyance already
    builtin: true,
  },
  easylist_cookie: {
    name: 'EasyList Cookie List',
    description: 'Blocks cookie consent banners, GDPR overlays, and privacy notices',
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    category: 'annoyances',
    enabled: true,
    builtin: true,
  },
  fanboy_notifications: {
    name: "Fanboy's Notifications Blocking List",
    description: 'Blocks push notification and subscription popups',
    url: 'https://easylist.to/easylist/fanboy-notifications.txt',
    category: 'annoyances',
    enabled: true,
    builtin: true,
  },

  // ——— Security / Malware ———
  malware_domains: {
    name: 'Online Malicious URL Blocklist',
    description: 'Blocks websites used for malware distribution',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    category: 'security',
    enabled: true,
    builtin: true,
  },
  dandelion_antimalware: {
    name: "Dandelion Sprout's Anti-Malware List",
    description: 'Blocks malware, phishing, and other dangerous sites',
    url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Dandelion%20Sprout%27s%20Anti-Malware%20List.txt',
    category: 'security',
    enabled: true,
    builtin: true,
  },

  // ——— DNS-Style Blocklists ———
  hagezi_pro: {
    name: 'HaGeZi Multi Pro DNS Blocklist',
    description: 'For a better internet! Blocks ads, tracking, metrics, telemetry, phishing, malware, scam, fake & crypto',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt',
    category: 'dns',
    enabled: true,
    builtin: true,
  },
  hagezi_tif: {
    name: 'HaGeZi Threat Intelligence Feeds',
    description: 'Real-time threat intelligence — blocks known malicious domains from multiple feeds',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/tif.txt',
    category: 'dns',
    enabled: true,
    builtin: true,
  },
  stevenblack: {
    name: 'StevenBlack Unified Hosts',
    description: 'Consolidating and extending hosts files from several well-curated sources (81,000+ entries)',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
    category: 'dns',
    enabled: false, // Large list — optional
    builtin: true,
    hostsFormat: true, // Needs special parsing
  },
  oisd: {
    name: 'OISD Blocklist (Small)',
    description: 'The best curated compact blocklist — Internet ads, phishing, malware & tracking',
    url: 'https://small.oisd.nl/',
    category: 'dns',
    enabled: false, // Optional
    builtin: true,
    hostsFormat: true,
  },

  // ——— Anti-Adblock ———
  adblock_warning: {
    name: 'Adblock Warning Removal List',
    description: 'Removes anti-adblock warnings and nag screens from websites',
    url: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt',
    category: 'misc',
    enabled: true,
    builtin: true,
  },
};

export class FilterListManager {
  constructor() {
    this.lists = {};    // { id: { ...FILTER_LISTS[id], lastUpdated, ruleCount } }
    this.initialized = false;
  }

  async init() {
    // Load saved list states
    const saved = await chrome.storage.local.get('filterLists');
    const savedLists = saved.filterLists || {};

    // Merge built-in defaults with saved states
    for (const [id, config] of Object.entries(FILTER_LISTS)) {
      this.lists[id] = {
        ...config,
        enabled: savedLists[id]?.enabled ?? config.enabled,
        lastUpdated: savedLists[id]?.lastUpdated || null,
        ruleCount: savedLists[id]?.ruleCount || 0,
      };
    }

    // Add any custom lists the user saved
    for (const [id, config] of Object.entries(savedLists)) {
      if (!FILTER_LISTS[id] && config.custom) {
        this.lists[id] = config;
      }
    }

    this.initialized = true;
  }

  async save() {
    const toSave = {};
    for (const [id, list] of Object.entries(this.lists)) {
      toSave[id] = {
        enabled: list.enabled,
        lastUpdated: list.lastUpdated,
        ruleCount: list.ruleCount,
        custom: list.custom || false,
        url: list.url,
        name: list.name,
        category: list.category,
      };
    }
    await chrome.storage.local.set({ filterLists: toSave });
  }

  getEnabledLists() {
    return Object.entries(this.lists)
      .filter(([_, l]) => l.enabled)
      .map(([id, l]) => ({ id, ...l }));
  }

  getAllLists() {
    return Object.entries(this.lists).map(([id, l]) => ({ id, ...l }));
  }

  async toggleList(id, enabled) {
    if (this.lists[id]) {
      this.lists[id].enabled = enabled;
      await this.save();
    }
  }

  async addCustomList(url, name) {
    const id = 'custom_' + Date.now();
    this.lists[id] = {
      name: name || url,
      description: 'Custom filter list',
      url,
      category: 'custom',
      enabled: true,
      builtin: false,
      custom: true,
      lastUpdated: null,
      ruleCount: 0,
    };
    await this.save();
    return id;
  }

  async removeCustomList(id) {
    if (this.lists[id]?.custom) {
      delete this.lists[id];
      await chrome.storage.local.remove(`filterCache_${id}`);
      await this.save();
    }
  }

  /**
   * Download and parse a single filter list.
   * Returns the raw text or null on failure.
   */
  async fetchList(id) {
    const list = this.lists[id];
    if (!list || !list.url) return null;

    try {
      const resp = await fetch(list.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      let text = await resp.text();

      // Convert hosts-format files to AdBlock format
      if (list.hostsFormat) {
        text = this._convertHostsToAdblock(text);
      }

      // Cache it
      await chrome.storage.local.set({ [`filterCache_${id}`]: text });
      
      // Count rules
      const lines = text.split('\n').filter(l => {
        l = l.trim();
        return l && !l.startsWith('!') && !l.startsWith('[') && !l.startsWith('#');
      });
      
      list.lastUpdated = Date.now();
      list.ruleCount = lines.length;
      await this.save();

      return text;
    } catch (err) {
      console.warn(`[FilterListManager] Failed to fetch ${list.name}:`, err);
      // Try to use cached version
      const cached = await chrome.storage.local.get(`filterCache_${id}`);
      return cached[`filterCache_${id}`] || null;
    }
  }

  /**
   * Get cached list text (no network request)
   */
  async getCachedList(id) {
    const cached = await chrome.storage.local.get(`filterCache_${id}`);
    return cached[`filterCache_${id}`] || null;
  }

  /**
   * Update all enabled lists
   */
  async updateAll() {
    const enabled = this.getEnabledLists();
    const results = [];
    for (const list of enabled) {
      const text = await this.fetchList(list.id);
      results.push({
        id: list.id,
        name: list.name,
        success: !!text,
        ruleCount: list.ruleCount || this.lists[list.id]?.ruleCount || 0,
      });
    }
    return results;
  }

  /**
   * Convert hosts-format (0.0.0.0 domain.com) to AdBlock format (||domain.com^)
   */
  _convertHostsToAdblock(hostsText) {
    const lines = hostsText.split('\n');
    const adblockLines = [];

    for (let line of lines) {
      line = line.trim();
      // Skip comments and empty lines
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      
      // Parse hosts format: "0.0.0.0 domain.com" or "127.0.0.1 domain.com"
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
        const domain = parts[1].trim();
        if (domain && domain !== 'localhost' && domain !== 'localhost.localdomain'
            && !domain.startsWith('#') && domain.includes('.')) {
          adblockLines.push(`||${domain}^`);
        }
      }
    }

    return adblockLines.join('\n');
  }

  getStats() {
    const all = Object.values(this.lists);
    const enabled = all.filter(l => l.enabled);
    const totalRules = enabled.reduce((sum, l) => sum + (l.ruleCount || 0), 0);
    return {
      totalLists: all.length,
      enabledLists: enabled.length,
      totalRules,
      byCategory: {
        ads: enabled.filter(l => l.category === 'ads').length,
        privacy: enabled.filter(l => l.category === 'privacy').length,
        annoyances: enabled.filter(l => l.category === 'annoyances').length,
        security: enabled.filter(l => l.category === 'security').length,
        dns: enabled.filter(l => l.category === 'dns').length,
        misc: enabled.filter(l => l.category === 'misc').length,
        custom: enabled.filter(l => l.category === 'custom').length,
      }
    };
  }
}
