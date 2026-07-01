/**
 * Filter List Manager
 * by roshanxcvi
 *
 * v1.3.2 PERFORMANCE + STORAGE FIX:
 * - Keeps only lightweight core lists enabled by default
 * - Heavy lists are OFF by default and user-controlled from Dashboard
 * - Replaced OISD Big with OISD Small
 * - Prevents huge filter lists from filling chrome.storage.local
 * - Adds clearCache() helper for dashboard cache cleanup
 *
 * v1.1 SECURITY HARDENING:
 * - URL origin allowlist (no fetching from arbitrary URLs)
 * - HTTPS-only enforcement
 * - Content sanitization before parsing
 * - SHA-256 hashing for tamper detection across re-fetches
 *
 * PERFORMANCE:
 * - Disabled huge lists that exceed Chrome storage quota
 * - 5MB max per list
 * - 10 second fetch timeout
 * - Parallel downloads
 */

import {
  sanitizeFilterList,
  isTrustedFilterUrl,
  hashFilterList,
  logError,
  MAX_LIST_BYTES,
} from './security.js';

export const FILTER_LISTS = {
  // ——— Core lists: safe to enable by default ———
  easylist: {
    name: 'EasyList',
    description: 'Primary ad blocking list. Blocks most normal webpage ads and ad network requests.',
    url: 'https://easylist.to/easylist/easylist.txt',
    category: 'ads',
    enabled: true,
    builtin: true,
  },

  easyprivacy: {
    name: 'EasyPrivacy',
    description: 'Privacy-focused list that blocks trackers, analytics scripts, web bugs, and tracking domains.',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    category: 'privacy',
    enabled: true,
    builtin: true,
  },

  peterlowe: {
    name: "Peter Lowe's Ad & Tracking List",
    description: 'Compact hostname blocklist for common advertising and tracking servers.',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    category: 'ads',
    enabled: true,
    builtin: true,
  },

  // ——— Optional annoyance lists: OFF by default to reduce storage pressure ———
  fanboy_annoyance: {
    name: "Fanboy's Annoyance List",
    description: 'Blocks social widgets, in-page popups, newsletter overlays, and other website annoyances. Optional because it can be large.',
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    category: 'annoyances',
    enabled: false,
    builtin: true,
  },

  easylist_cookie: {
    name: 'EasyList Cookie List',
    description: 'Blocks cookie consent banners and GDPR overlays. Optional because it can affect website layout.',
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    category: 'annoyances',
    enabled: false,
    builtin: true,
  },

  // ——— Optional security / anti-adblock lists: OFF by default ———
  malware_domains: {
    name: 'Online Malicious URL Blocklist',
    description: 'Blocks known malware distribution and malicious URL domains. Optional because it may be larger than core lists.',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    category: 'security',
    enabled: false,
    builtin: true,
  },

  adblock_warning: {
    name: 'Adblock Warning Removal List',
    description: 'Attempts to remove anti-adblock warnings. Optional because it can cause false positives on some websites.',
    url: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt',
    category: 'misc',
    enabled: false,
    builtin: true,
  },

  // ——— Optional extended lists: user-controlled from Dashboard ———
  oisd_small: {
    name: 'OISD Small',
    description: 'Lightweight domain blocklist for ads, trackers, telemetry, malware, phishing, and suspicious domains. Better for Chrome MV3 extensions than OISD Big.',
    url: 'https://small.oisd.nl/',
    category: 'extended',
    enabled: false,
    builtin: false,
    source: 'oisd.nl',
  },

  disconnect_tracking: {
    name: 'Disconnect Tracking Protection',
    description: 'Tracker-focused list from Disconnect. Helps block known third-party tracking, analytics, and privacy-invasive domains.',
    url: 'https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt',
    category: 'privacy',
    enabled: false,
    builtin: false,
    source: 'disconnect.me',
  },

  goodbyeads: {
    name: 'GoodbyeAds',
    description: 'Aggressive ads, tracker, malware, and mobile/app advertising list. Stronger blocking, but may use more storage and may break some sites.',
    url: 'https://raw.githubusercontent.com/jerryn70/GoodbyeAds/master/Formats/GoodbyeAds-AdBlock-Filter.txt',
    category: 'extended',
    enabled: false,
    builtin: false,
    source: 'github.com/jerryn70/GoodbyeAds',
  },

  hagezi_pro_mini: {
    name: 'HaGeZi Pro mini',
    description: 'Balanced DNS/browser blocklist for ads, affiliate, tracking, metrics, telemetry, phishing, malware, scams, and cryptojacking. Mini version is better for browser extensions.',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt',
    category: 'security',
    enabled: false,
    builtin: false,
    source: 'github.com/hagezi/dns-blocklists',
  },
};

// Fetch timeout in ms
const FETCH_TIMEOUT = 10000;

// Maximum list size that we safely cache in chrome.storage.local.
// Bigger lists can still be used for the current session, but are not cached.
const SAFE_CACHE_BYTES = 2_000_000;

function normalizeDomainListToAdblock(text) {
  if (typeof text !== 'string') return '';

  const output = [];
  const seen = new Set();

  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) continue;

    // Keep normal AdBlock/uBO syntax as-is.
    if (
      line.startsWith('!') ||
      line.startsWith('[') ||
      line.startsWith('@@') ||
      line.includes('##') ||
      line.includes('#@#') ||
      line.startsWith('||') ||
      line.startsWith('|') ||
      line.includes('$')
    ) {
      output.push(line);
      continue;
    }

    // Remove inline comments from hosts/domain formats.
    line = line.replace(/\s+#.*$/, '').trim();

    // Hosts format: 0.0.0.0 example.com / 127.0.0.1 example.com / ::1 example.com
    const hostMatch = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([^\s#]+)/i);
    if (hostMatch) {
      line = hostMatch[1];
    }

    // AdGuard DNS format: address=/example.com/
    line = line.replace(/^address=\//, '').replace(/\/.*$/, '');

    const domain = line.toLowerCase().replace(/^www\./, '');

    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(domain)) continue;
    if (seen.has(domain)) continue;

    seen.add(domain);
    output.push('||' + domain + '^');
  }

  return output.join('\n');
}

function countRules(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith('!') && !t.startsWith('[') && !t.startsWith('#');
    }).length;
}

export class FilterListManager {
  constructor() {
    this.lists = {};
    this.initialized = false;
  }

  async init() {
    // Load list states from storage.
    try {
      const saved = await chrome.storage.local.get('filterLists');

      if (saved.filterLists) {
        for (const [id, state] of Object.entries(saved.filterLists)) {
          if (FILTER_LISTS[id]) {
            this.lists[id] = {
              ...FILTER_LISTS[id],
              id,
              ...state,
            };
          }
        }
      }
    } catch (e) {
      logError('filter-list:init-load', e);
    }

    // Ensure all current lists exist.
    for (const [id, config] of Object.entries(FILTER_LISTS)) {
      if (!this.lists[id]) {
        this.lists[id] = {
          ...config,
          id,
          lastUpdated: null,
          ruleCount: 0,
          contentHash: null,
          droppedLines: 0,
        };
      }
    }

    // Remove deleted old list ids from memory.
    for (const id of Object.keys(this.lists)) {
      if (!FILTER_LISTS[id]) {
        delete this.lists[id];
      }
    }

    this.initialized = true;
    await this.save();
  }

  async save() {
    const toSave = {};

    for (const [id, list] of Object.entries(this.lists)) {
      toSave[id] = {
        enabled: list.enabled,
        lastUpdated: list.lastUpdated || null,
        ruleCount: list.ruleCount || 0,
        contentHash: list.contentHash || null,
        droppedLines: list.droppedLines || 0,
      };
    }

    try {
      await chrome.storage.local.set({
        filterLists: toSave,
      });
    } catch (e) {
      logError('filter-list:save', e);
    }
  }

  getEnabledLists() {
    return Object.values(this.lists).filter((list) => list.enabled);
  }

  getAllLists() {
    return Object.values(this.lists);
  }

  getStats() {
    const all = Object.values(this.lists);
    const enabled = all.filter((list) => list.enabled);

    return {
      totalLists: all.length,
      enabledLists: enabled.length,
      totalRules: enabled.reduce((sum, list) => sum + (list.ruleCount || 0), 0),
    };
  }

  async toggleList(id, enabled) {
    if (!this.lists[id]) {
      return false;
    }

    this.lists[id].enabled = enabled === true;

    // If user turns a list OFF, remove its cached copy to save storage.
    if (!this.lists[id].enabled) {
      try {
        await chrome.storage.local.remove(`filterCache_${id}`);
      } catch (e) {
        logError('filter-list:remove-disabled-cache', e);
      }

      this.lists[id].lastUpdated = null;
      this.lists[id].ruleCount = 0;
      this.lists[id].contentHash = null;
      this.lists[id].droppedLines = 0;
    }

    await this.save();
    return true;
  }

  /**
   * Download a single filter list with timeout, size limit, origin allowlist,
   * and content sanitization.
   */
  async fetchList(id) {
    const list = this.lists[id];

    if (!list || !list.url) {
      return null;
    }

    // Trusted URL allowlist + HTTPS-only validation.
    if (!isTrustedFilterUrl(list.url)) {
      logError('filter-list:url-rejected', `Untrusted filter URL refused: ${list.url}`);
      return null;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const resp = await fetch(list.url, {
        signal: controller.signal,
        credentials: 'omit',
        headers: {
          Accept: 'text/plain',
        },
      });

      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      let text = await resp.text();

      // Convert hosts/domain lists into AdBlock style rules.
      text = normalizeDomainListToAdblock(text);

      // Hard size cap before sanitization.
      if (text.length > MAX_LIST_BYTES) {
        console.warn(
          `[FilterListManager] ${list.name} truncated from ${(text.length / 1024 / 1024).toFixed(1)}MB to ${(MAX_LIST_BYTES / 1024 / 1024).toFixed(1)}MB`
        );
        text = text.substring(0, MAX_LIST_BYTES);
      }

      // Sanitize before using/storing.
      const { text: cleanText, dropped } = sanitizeFilterList(text);

      if (dropped > 0) {
        console.warn(`[FilterListManager] ${list.name}: dropped ${dropped} suspicious lines during sanitization`);
      }

      const newHash = await hashFilterList(cleanText);
      const prevHash = list.contentHash;

      if (prevHash && newHash && prevHash !== newHash) {
        const prevCount = list.ruleCount || 0;
        const newCount = countRules(cleanText);

        if (prevCount > 100 && newCount < prevCount * 0.1) {
          logError(
            'filter-list:suspicious-shrink',
            `${list.name} shrank from ${prevCount} to ${newCount} rules — possible mirror compromise`
          );
        }
      }

      // Cache only smaller lists. Large lists are used for this session only.
      try {
        if (cleanText.length <= SAFE_CACHE_BYTES) {
          await chrome.storage.local.set({
            [`filterCache_${id}`]: cleanText,
          });
        } else {
          await chrome.storage.local.remove(`filterCache_${id}`);
          console.warn(
            `[FilterListManager] ${list.name} is too large to cache safely; using it for this session only`
          );
        }
      } catch (e) {
        console.warn(`[FilterListManager] Cannot cache ${list.name} — storage quota exceeded`);
      }

      const ruleCount = countRules(cleanText);

      list.lastUpdated = Date.now();
      list.ruleCount = ruleCount;
      list.contentHash = newHash;
      list.droppedLines = dropped;

      await this.save();

      return cleanText;
    } catch (err) {
      if (err.name !== 'AbortError') {
        logError('filter-list:fetch', `${list.name}: ${err.message}`);
      }

      // Try cached version if available.
      try {
        const cached = await chrome.storage.local.get(`filterCache_${id}`);
        return cached[`filterCache_${id}`] || null;
      } catch (e) {
        logError('filter-list:cache-read', e);
        return null;
      }
    }
  }

  async getCachedList(id) {
    try {
      const cached = await chrome.storage.local.get(`filterCache_${id}`);
      return cached[`filterCache_${id}`] || null;
    } catch (e) {
      return null;
    }
  }

  async clearCache() {
    try {
      const keys = Object.keys(FILTER_LISTS).map((id) => `filterCache_${id}`);
      await chrome.storage.local.remove(keys);

      for (const list of Object.values(this.lists)) {
        list.lastUpdated = null;
        list.ruleCount = 0;
        list.contentHash = null;
        list.droppedLines = 0;
      }

      await this.save();
      return true;
    } catch (e) {
      logError('filter-list:clear-cache', e);
      return false;
    }
  }

  /**
   * Update all enabled lists in parallel.
   */
  async updateAll() {
    const enabled = this.getEnabledLists();

    const promises = enabled.map(async (list) => {
      const text = await this.fetchList(list.id);

      return {
        id: list.id,
        name: list.name,
        success: !!text,
        ruleCount: this.lists[list.id]?.ruleCount || 0,
      };
    });

    return Promise.all(promises);
  }
}
