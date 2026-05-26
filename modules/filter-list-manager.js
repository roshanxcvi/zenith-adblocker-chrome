/**
 * Filter List Manager
 * by roshanxcvi
 *
 * v1.1SECURITY HARDENING:
 * - URL origin allowlist (no fetching from arbitrary URLs)
 * - HTTPS-only enforcement
 * - Content sanitization before parsing (strips dangerous scriptlet rules
 *   referencing non-allowlisted scriptlet names)
 * - SHA-256 hashing for tamper detection across re-fetches
 *
 * PERFORMANCE:
 * - Removed broken URLs (404)
 * - Disabled huge lists that exceed Chrome storage quota
 * - 5MB max per list (Chrome limit is 10MB per key)
 * - 10 second fetch timeout (prevents hanging)
 * - Parallel downloads (not sequential)
 */

import {
  sanitizeFilterList,
  isTrustedFilterUrl,
  hashFilterList,
  logError,
  MAX_LIST_BYTES,
} from './security.js';

export const FILTER_LISTS = {
  // ——— Core (always enabled, reasonable size) ———
  easylist: {
    name: 'EasyList',
    description: 'Primary ad blocking — removes most ads from webpages',
    url: 'https://easylist.to/easylist/easylist.txt',
    category: 'ads',
    enabled: true,
    builtin: true,
  },
  easyprivacy: {
    name: 'EasyPrivacy',
    description: 'Removes all forms of tracking — web bugs, tracking scripts',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    category: 'privacy',
    enabled: true,
    builtin: true,
  },
  peterlowe: {
    name: "Peter Lowe's Ad & Tracking List",
    description: 'Compact blocklist of ad and tracking hostnames',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    category: 'ads',
    enabled: true,
    builtin: true,
  },

  // ——— Annoyances ———
  fanboy_annoyance: {
    name: "Fanboy's Annoyance List",
    description: 'Blocks social media content, in-page popups, annoyances',
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    category: 'annoyances',
    enabled: true,
    builtin: true,
  },
  easylist_cookie: {
    name: 'EasyList Cookie List',
    description: 'Blocks cookie consent banners, GDPR overlays',
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    category: 'annoyances',
    enabled: true,
    builtin: true,
  },

  // ——— Security ———
  malware_domains: {
    name: 'Online Malicious URL Blocklist',
    description: 'Blocks malware distribution websites',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    category: 'security',
    enabled: true,
    builtin: true,
  },
  adblock_warning: {
    name: 'Adblock Warning Removal List',
    description: 'Removes anti-adblock warnings from websites',
    url: 'https://easylist-downloads.adblockplus.org/antiadblockfilters.txt',
    category: 'misc',
    enabled: true,
    builtin: true,
  },
};

// Max size per cached list — imported from security.js as MAX_LIST_BYTES
// Fetch timeout in ms
const FETCH_TIMEOUT = 10000;

export class FilterListManager {
  constructor() {
    this.lists = {};
    this.initialized = false;
  }

  async init() {
    // Load list states from storage
    try {
      const saved = await chrome.storage.local.get('filterLists');
      if (saved.filterLists) {
        for (const [id, state] of Object.entries(saved.filterLists)) {
          if (FILTER_LISTS[id]) {
            this.lists[id] = { ...FILTER_LISTS[id], id, ...state };
          }
        }
      }
    } catch (e) {}

    // Ensure all built-in lists are present
    for (const [id, config] of Object.entries(FILTER_LISTS)) {
      if (!this.lists[id]) {
        this.lists[id] = { ...config, id, lastUpdated: null, ruleCount: 0 };
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
        contentHash: list.contentHash || null,
        droppedLines: list.droppedLines || 0,
      };
    }
    try { await chrome.storage.local.set({ filterLists: toSave }); } catch (e) { logError('filter-list:save', e); }
  }

  getEnabledLists() {
    return Object.values(this.lists).filter(l => l.enabled);
  }

  getAllLists() {
    return Object.values(this.lists);
  }

  getStats() {
    const all = Object.values(this.lists);
    const enabled = all.filter(l => l.enabled);
    return {
      totalLists: all.length,
      enabledLists: enabled.length,
      totalRules: enabled.reduce((sum, l) => sum + (l.ruleCount || 0), 0),
    };
  }

  async toggleList(id, enabled) {
    if (this.lists[id]) {
      this.lists[id].enabled = enabled;
      await this.save();
      if (!enabled) {
        try { await chrome.storage.local.remove(`filterCache_${id}`); } catch (e) {}
      }
    }
  }

  /**
   * Download a single filter list with timeout, size limit, origin allowlist,
   * and content sanitization. SECURITY-CRITICAL function.
   */
  async fetchList(id) {
    const list = this.lists[id];
    if (!list || !list.url) return null;

    // FIX #1 — origin allowlist + HTTPS only
    if (!isTrustedFilterUrl(list.url)) {
      logError('filter-list:url-rejected', `Untrusted filter URL refused: ${list.url}`);
      return null;
    }

    try {
      // Fetch with timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const resp = await fetch(list.url, {
        signal: controller.signal,
        // Don't send cookies/credentials to filter list servers
        credentials: 'omit',
        // Prevent the response being treated as anything other than text
        headers: { 'Accept': 'text/plain' },
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      let text = await resp.text();

      // Size cap
      if (text.length > MAX_LIST_BYTES) {
        console.warn(`[FilterListManager] ${list.name} truncated from ${(text.length/1024/1024).toFixed(1)}MB to 5MB`);
        text = text.substring(0, MAX_LIST_BYTES);
      }

      // FIX #1 — SANITIZE before storing. Strips scriptlet rules referencing
      // names outside SCRIPTLET_ALLOWLIST + suspicious lines.
      const { text: cleanText, dropped } = sanitizeFilterList(text);
      if (dropped > 0) {
        console.warn(`[FilterListManager] ${list.name}: dropped ${dropped} suspicious lines during sanitization`);
      }

      // FIX #1 — compute hash for tamper detection
      const newHash = await hashFilterList(cleanText);
      const prevHash = list.contentHash;
      if (prevHash && newHash && prevHash !== newHash) {
        // Big drop in rule count after a hash change = suspicious
        const prevCount = list.ruleCount || 0;
        const newCount = cleanText.split('\n').filter(l => {
          const t = l.trim();
          return t && !t.startsWith('!') && !t.startsWith('[') && !t.startsWith('#');
        }).length;
        if (prevCount > 100 && newCount < prevCount * 0.1) {
          logError('filter-list:suspicious-shrink',
            `${list.name} shrank from ${prevCount} to ${newCount} rules — possible mirror compromise`);
        }
      }

      // Cache the sanitized version (not the raw)
      try {
        await chrome.storage.local.set({ [`filterCache_${id}`]: cleanText });
      } catch (e) {
        console.warn(`[FilterListManager] Cannot cache ${list.name} — storage quota exceeded`);
      }

      // Count rules
      const ruleCount = cleanText.split('\n').filter(l => {
        const t = l.trim();
        return t && !t.startsWith('!') && !t.startsWith('[') && !t.startsWith('#');
      }).length;

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
      // Try cached version (already sanitized when it was stored)
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
    } catch (e) { return null; }
  }

  /**
   * Update all enabled lists — PARALLEL (not sequential)
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
