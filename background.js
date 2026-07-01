/**
 * Zenith AdBlocker — Chrome Background (MV3)
 * by roshanxcvi
 *
 * v1.3.1 FIXES:
 * - Fixed "Uncaught (in promise) Error: No tab with id"
 * - Fixed badge update Promise handling
 * - Added dead-tab cleanup
 * - Added safer filter-list update parsing for non-cached large lists
 * - Added CLEAR_FILTER_CACHE handler support
 */

import { FilterEngine } from './rules/filter-engine.js';
import { TrackerLearner } from './modules/tracker-learner.js';
import { FilterListManager } from './modules/filter-list-manager.js';
import { SCRIPTLETS, buildScriptletCode, parseScriptletRule } from './modules/scriptlets.js';
import { RULE_CATEGORIES, normalizeRuleCategorySettings } from './rules/rule-categories.js';
import {
  validateSender,
  safeHostname,
  safeSenderHostname,
  sanitizeFilterList,
  isScriptletAllowed,
  logError,
} from './modules/security.js';

const chromeApi = globalThis.chrome?.runtime ? globalThis.chrome : globalThis.browser;

if (!chromeApi?.runtime?.onInstalled) {
  throw new Error('[Zenith] Chrome extension runtime API unavailable. Load this file only through chrome://extensions as the MV3 service worker.');
}

const chrome = chromeApi;

const engine = new FilterEngine();
const trackerLearner = new TrackerLearner();
const filterListManager = new FilterListManager();

let isEnabled = true;
let stats = {};
let whitelist = [];
let globalStats = { totalBlocked: 0, perSite: {} };
let blockedLog = [];
const MAX_LOG = 500;
let tabDoms = {};
let tabUrls = {};
let initDone = false;

const recentBlocks = Object.create(null);
const DEDUP_MAX_PER_TAB = 1000;

let dirty = false;
function markDirty() {
  dirty = true;
}

function sanitizeLogUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (e) {
    return '';
  }
}

async function flushIfDirty() {
  if (!dirty) return;
  dirty = false;

  try {
    await chrome.storage.local.set({
      stats,
      tabDoms,
      tabUrls,
      blockedLog: blockedLog.slice(0, MAX_LOG),
      lastSave: Date.now(),
    });
  } catch (e) {
    logError('flushIfDirty', e);
    dirty = true;
  }
}

async function incrementBlockedCount(count) {
  try {
    const data = await chrome.storage.local.get(['sinceInstall', 'globalStats']);

    const si = data.sinceInstall || {
      totalBlocked: 0,
      installDate: null,
    };

    const gs = data.globalStats || {
      totalBlocked: 0,
      perSite: {},
    };

    si.totalBlocked += count;
    gs.totalBlocked += count;
    globalStats.totalBlocked = gs.totalBlocked;

    await chrome.storage.local.set({
      sinceInstall: si,
      globalStats: gs,
    });

    chrome.storage.sync.set({
      sinceInstall: si,
    }).catch((e) => logError('sync-write', e));
  } catch (e) {
    logError('incrementBlockedCount', e);
  }
}

// ════════════════════════════════════════════════════════════════
// Top-level listeners
// ════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener((details) => {
  try {
    chrome.contextMenus.create({
      id: 'block-element',
      title: 'Block this element',
      contexts: ['all'],
    });
  } catch (e) {
    logError('contextMenu.create', e);
  }

  if (details.reason === 'install') {
    const seed = {
      totalBlocked: 0,
      installDate: new Date().toISOString(),
    };

    chrome.storage.local.set({
      sinceInstall: seed,
    }).catch((e) => logError('install-seed-local', e));

    chrome.storage.sync.set({
      sinceInstall: seed,
    }).catch((e) => logError('install-seed-sync', e));

    chrome.storage.local.get('ruleCategories').then((stored) => {
      const current = stored.ruleCategories || {};
      const normalized = normalizeRuleCategorySettings(current);

      chrome.storage.local.set({
        ruleCategories: normalized,
      });
    });
  }

  updateFilterLists();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  const v = validateSender(sender, type);
  if (!v.ok) {
    logError('msg:sender-rejected', `${type} from ${sender?.url || 'unknown'}: ${v.reason}`);
    sendResponse({
      error: 'forbidden',
    });
    return false;
  }

  const handler = HANDLERS[type];

  if (!handler) {
    sendResponse({
      error: 'unknown_message_type',
    });
    return false;
  }

  try {
    const result = handler(msg, sender, sendResponse);

    if (result && typeof result.then === 'function') {
      result.catch((e) => {
        logError(`handler:${type}`, e);
        try {
          sendResponse({
            error: 'handler_threw',
          });
        } catch (_) {}
      });

      return true;
    }

    return result === true;
  } catch (e) {
    logError(`handler:${type}:sync`, e);

    try {
      sendResponse({
        error: 'handler_threw',
      });
    } catch (_) {}

    return false;
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-element' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'PICK_ELEMENT',
    }).catch((e) => logError('pick-element-send', e));
  }
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;

  const h = safeHostname(d.url);

  if (h) {
    tabUrls[d.tabId] = h;
  }

  stats[d.tabId] = 0;
  tabDoms[d.tabId] = {};
  recentBlocks[d.tabId] = Object.create(null);

  updateBadge(d.tabId, 0);
  markDirty();
});

chrome.tabs.onRemoved.addListener((id) => {
  cleanupDeadTab(id);
});

chrome.alarms.create('autoSave', {
  periodInMinutes: 1,
});

chrome.alarms.create('updateFilters', {
  periodInMinutes: 1440,
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoSave') {
    flushIfDirty();
  }

  if (a.name === 'updateFilters') {
    updateFilterLists();
  }
});

// ════════════════════════════════════════════════════════════════
// Dedup helpers
// ════════════════════════════════════════════════════════════════

function shouldDedupLifetime(tabId, url) {
  if (!url) return false;

  let tabMap = recentBlocks[tabId];

  if (!tabMap) {
    tabMap = recentBlocks[tabId] = Object.create(null);
  }

  if (tabMap[url]) {
    return true;
  }

  tabMap[url] = Date.now();

  const keys = Object.keys(tabMap);

  if (keys.length > DEDUP_MAX_PER_TAB) {
    keys.sort((a, b) => tabMap[a] - tabMap[b]);

    for (let i = 0; i < keys.length - DEDUP_MAX_PER_TAB; i++) {
      delete tabMap[keys[i]];
    }
  }

  return false;
}

// declarativeNetRequest debug listener
try {
  if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      if (info.request.tabId < 0) return;

      const tabId = info.request.tabId;
      const url = info.request.url;

      stats[tabId] = (stats[tabId] || 0) + 1;
      updateBadge(tabId, stats[tabId]);

      const isRefreshDup = shouldDedupLifetime(tabId, url);
      const h = safeHostname(url);

      if (h) {
        if (!isRefreshDup) {
          globalStats.perSite[h] = (globalStats.perSite[h] || 0) + 1;
        }

        if (!tabDoms[tabId]) {
          tabDoms[tabId] = {};
        }

        if (!tabDoms[tabId][h]) {
          tabDoms[tabId][h] = {
            count: 0,
            type: info.request.type || 'other',
          };
        }

        tabDoms[tabId][h].count++;

        blockedLog.unshift({
          url: sanitizeLogUrl(url),
          domain: h,
          type: info.request.type || 'other',
          timestamp: Date.now(),
          tabId,
        });

        if (blockedLog.length > MAX_LOG) {
          blockedLog.length = MAX_LOG;
        }

        const src = safeHostname(info.request.documentUrl);

        if (src && src !== h) {
          try {
            trackerLearner.recordSighting(h, src);
          } catch (e) {
            logError('learner:onRuleMatched', e);
          }
        }
      }

      if (!isRefreshDup) {
        incrementBlockedCount(1);
      }

      markDirty();
    });
  }
} catch (e) {
  logError('register:onRuleMatchedDebug', e);
}

// ════════════════════════════════════════════════════════════════
// Handler helpers
// ════════════════════════════════════════════════════════════════

function clampStr(value, max = 200) {
  return String(value || '').slice(0, max);
}

function normalizeSiteSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    ads: settings.ads !== false,
    cosmetic: settings.cosmetic !== false,
    trackers: settings.trackers !== false,
    fingerprinting: settings.fingerprinting !== false,
    cookie: settings.cookie !== false,
    annoyances: settings.annoyances !== false,
    miners: settings.miners !== false,
  };
}

function getSiteKeyFromHostname(input) {
  try {
    let value = String(input || '').trim().toLowerCase();

    if (!value) {
      return null;
    }

    if (value.startsWith('http://') || value.startsWith('https://')) {
      value = new URL(value).hostname;
    }

    value = value.replace(/^www\./, '');

    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(value)) {
      return null;
    }

    return value;
  } catch (error) {
    return null;
  }
}

let lastFilterUpdate = 0;
const FILTER_UPDATE_MIN_INTERVAL = 60_000;

// ════════════════════════════════════════════════════════════════
// Message handlers
// ════════════════════════════════════════════════════════════════


function isUrlWhitelisted(url) {
  const hostname = safeHostname(url);

  if (!hostname) {
    return false;
  }

  return whitelist.some((domain) => {
    const cleanDomain = String(domain || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');

    return hostname === cleanDomain || hostname.endsWith('.' + cleanDomain);
  });
}











const HANDLERS = {
  GET_SITE_SETTINGS: async (msg, sender, sendResponse) => {
    try {
      const siteKey = getSiteKeyFromHostname(msg.hostname);

      if (!siteKey) {
        sendResponse({
          success: false,
          error: 'invalid_site',
          received: msg.hostname,
        });
        return;
      }

      const stored = await chrome.storage.local.get('siteSettings');
      const allSettings = stored.siteSettings || {};
      const settings = normalizeSiteSettings(allSettings[siteKey] || {});

      sendResponse({
        success: true,
        hostname: siteKey,
        settings,
      });
    } catch (error) {
      console.error('[Zenith] GET_SITE_SETTINGS failed:', error);

      sendResponse({
        success: false,
        error: 'get_site_settings_failed',
        message: error?.message || String(error),
      });
    }
  },

  SET_SITE_SETTINGS: async (msg, sender, sendResponse) => {
    try {
      const siteKey = getSiteKeyFromHostname(msg.hostname);

      if (!siteKey) {
        sendResponse({
          success: false,
          error: 'invalid_site',
          received: msg.hostname,
        });
        return;
      }

      const stored = await chrome.storage.local.get('siteSettings');
      const allSettings = stored.siteSettings || {};

      allSettings[siteKey] = normalizeSiteSettings(msg.settings || {});

      await chrome.storage.local.set({
        siteSettings: allSettings,
      });

      sendResponse({
        success: true,
        hostname: siteKey,
        settings: allSettings[siteKey],
      });
    } catch (error) {
      console.error('[Zenith] SET_SITE_SETTINGS failed:', error);

      sendResponse({
        success: false,
        error: 'set_site_settings_failed',
        message: error?.message || String(error),
      });
    }
  },

  GET_FILTER_LISTS: async (msg, sender, sendResponse) => {
    try {
      if (!filterListManager.initialized) {
        await filterListManager.init();
      }

      sendResponse({
        success: true,
        lists: filterListManager.getAllLists(),
        stats: filterListManager.getStats(),
      });
    } catch (error) {
      logError('GET_FILTER_LISTS', error);

      sendResponse({
        success: false,
        error: 'get_filter_lists_failed',
        message: String(error?.message || error),
      });
    }
  },

  SET_FILTER_LIST_ENABLED: async (msg, sender, sendResponse) => {
    try {
      if (!filterListManager.initialized) {
        await filterListManager.init();
      }

      const id = String(msg.id || '').trim();
      const enabled = msg.enabled === true;

      const found = filterListManager.getAllLists().some((list) => list.id === id);

      if (!found) {
        sendResponse({
          success: false,
          error: 'invalid_filter_list',
          received: id,
        });
        return;
      }

      await filterListManager.toggleList(id, enabled);
      await updateFilterLists();

      sendResponse({
        success: true,
        id,
        enabled,
        lists: filterListManager.getAllLists(),
        stats: filterListManager.getStats(),
      });
    } catch (error) {
      logError('SET_FILTER_LIST_ENABLED', error);

      sendResponse({
        success: false,
        error: 'set_filter_list_failed',
        message: String(error?.message || error),
      });
    }
  },

  CLEAR_FILTER_CACHE: async (msg, sender, sendResponse) => {
    try {
      if (!filterListManager.initialized) {
        await filterListManager.init();
      }

      const ok = await filterListManager.clearCache();
      await updateFilterLists();

      sendResponse({
        success: ok,
        lists: filterListManager.getAllLists(),
        stats: filterListManager.getStats(),
      });
    } catch (error) {
      logError('CLEAR_FILTER_CACHE', error);

      sendResponse({
        success: false,
        error: 'clear_filter_cache_failed',
        message: String(error?.message || error),
      });
    }
  },

  GET_RULE_CATEGORIES: async (msg, sender, sendResponse) => {
    try {
      const stored = await chrome.storage.local.get('ruleCategories');
      const settings = normalizeRuleCategorySettings(stored.ruleCategories || {});

      sendResponse({
        success: true,
        categories: RULE_CATEGORIES,
        settings,
      });
    } catch (error) {
      console.error('[Zenith] GET_RULE_CATEGORIES failed:', error);

      sendResponse({
        success: false,
        error: 'get_rule_categories_failed',
        message: error?.message || String(error),
      });
    }
  },

  SET_RULE_CATEGORY: async (msg, sender, sendResponse) => {
    try {
      const category = String(msg.category || '').trim();
      const enabled = msg.enabled === true;

      if (!Object.prototype.hasOwnProperty.call(RULE_CATEGORIES, category)) {
        sendResponse({
          success: false,
          error: 'invalid_category',
          received: category,
          available: Object.keys(RULE_CATEGORIES),
        });
        return;
      }

      const stored = await chrome.storage.local.get('ruleCategories');
      const settings = normalizeRuleCategorySettings(stored.ruleCategories || {});

      settings[category] = enabled;

      await chrome.storage.local.set({
        ruleCategories: settings,
      });

      sendResponse({
        success: true,
        category,
        enabled,
        settings,
      });
    } catch (error) {
      console.error('[Zenith] SET_RULE_CATEGORY failed:', error);

      sendResponse({
        success: false,
        error: 'set_rule_category_failed',
        message: error?.message || String(error),
      });
    }
  },

  CHECK_URL: (msg, sender, sendResponse) => {
    const url = clampStr(msg.url, 2048);
    const src = clampStr(msg.sourceUrl, 2048);
    const rt = clampStr(msg.resourceType, 32);

    sendResponse({
      blocked: isEnabled && engine.shouldBlock(url, src, rt),
    });
  },

  GET_COSMETIC_FILTERS: (msg, sender, sendResponse) => {
    const host = clampStr(msg.hostname);

    sendResponse({
      selectors: engine.getCosmeticSelectors(host),
    });
  },

  GET_STATE: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get(['whitelist', 'enabled']);

    whitelist = stored.whitelist || [];
    isEnabled = stored.enabled !== undefined ? stored.enabled : true;

    const tabUrl = sender?.tab?.url || '';
    const isWhitelisted = isUrlWhitelisted(tabUrl);

    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[sender.tab?.id] || 0,
      totalBlocked: globalStats.totalBlocked,
      whitelist,
    });
  },

  GET_TAB_STATS: (msg, sender, sendResponse) => {
    let tabId;

    if (sender.tab) {
      if (msg.tabId != null && msg.tabId !== sender.tab.id) {
        sendResponse({
          error: 'tab_mismatch',
        });
        return;
      }

      tabId = sender.tab.id;
    } else {
      tabId = msg.tabId;
    }

    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[tabId] || 0,
      totalBlocked: globalStats.totalBlocked,
      whitelist,
    });
  },

  GET_POPUP_OVERVIEW: async (msg, sender, sendResponse) => {
    let tabId;

    if (sender.tab) {
      if (msg.tabId != null && msg.tabId !== sender.tab.id) {
        sendResponse({
          error: 'tab_mismatch',
        });
        return;
      }

      tabId = sender.tab.id;
    } else {
      tabId = msg.tabId;
    }

    const stored = await chrome.storage.local.get(['sinceInstall', 'whitelist']);
    const si = stored.sinceInstall || {
      totalBlocked: 0,
      installDate: null,
    };

    whitelist = stored.whitelist || [];

    const d = tabDoms[tabId] || {};

    const sorted = Object.entries(d)
      .map(([k, v]) => ({
        domain: k,
        count: v.count,
        type: v.type,
      }))
      .sort((a, b) => b.count - a.count);

    const cats = {
      ads: 0,
      trackers: 0,
      social: 0,
      other: 0,
    };

    for (const { domain: dm } of sorted) {
      if (/google|doubleclick|googlesyndication|taboola|outbrain|adnxs|criteo|pubmatic|amazon-adsystem|ads\.|adform/.test(dm)) {
        cats.ads++;
      } else if (/analytics|hotjar|mixpanel|clarity|segment|optimizely|chartbeat|scorecard|quantserve|demdex|moatads/.test(dm)) {
        cats.trackers++;
      } else if (/facebook|twitter|linkedin|instagram|snap\.licdn|pixel\.facebook/.test(dm)) {
        cats.social++;
      } else {
        cats.other++;
      }
    }

    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[tabId] || 0,
      totalBlocked: si.totalBlocked,
      sinceInstall: si,
      uniqueDomains: sorted.length,
      domains: sorted.slice(0, 15),
      categories: cats,
      whitelist,
    });
  },

  TOGGLE: async (msg, sender, sendResponse) => {
    isEnabled = !isEnabled;

    await chrome.storage.local.set({
      enabled: isEnabled,
    });

    sendResponse({
      enabled: isEnabled,
    });
  },

  ADD_WHITELIST: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get('whitelist');
    const wl = stored.whitelist || [];
    const d = String(msg.domain || '').replace(/^www\./, '').trim();

    if (!d) {
      sendResponse({
        whitelist: wl,
        error: 'empty_domain',
      });
      return;
    }

    if (!wl.includes(d)) {
      wl.push(d);
    }

    await chrome.storage.local.set({
      whitelist: wl,
    });

    whitelist = wl;

    sendResponse({
      whitelist: wl,
    });
  },

  REMOVE_WHITELIST: async (msg, sender, sendResponse) => {
    const domain = String(msg.domain || '').replace(/^www\./, '').trim();

    if (!domain) {
      sendResponse({
        whitelist,
        error: 'empty_domain',
      });
      return;
    }

    const stored = await chrome.storage.local.get('whitelist');
    const wl = (stored.whitelist || []).filter((d) => d !== domain);

    await chrome.storage.local.set({
      whitelist: wl,
    });

    whitelist = wl;

    sendResponse({
      whitelist: wl,
    });
  },

  REPORT_BLOCKED: (msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (tabId == null) {
      return;
    }

    const raw = parseInt(msg.count, 10);
    const count = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 1;

    stats[tabId] = (stats[tabId] || 0) + count;
    updateBadge(tabId, stats[tabId]);

    const h = safeSenderHostname(sender);

    if (h) {
      if (!tabDoms[tabId]) {
        tabDoms[tabId] = {};
      }

      if (!tabDoms[tabId][h]) {
        tabDoms[tabId][h] = {
          count: 0,
          type: 'cosmetic',
        };
      }

      tabDoms[tabId][h].count += count;

      const dedupKey = 'cosmetic:' + h;

      if (!shouldDedupLifetime(tabId, dedupKey)) {
        globalStats.perSite[h] = (globalStats.perSite[h] || 0) + count;
        incrementBlockedCount(count);
      }
    }

    markDirty();
  },

  RESET_STATS: async (msg, sender, sendResponse) => {
    globalStats = {
      totalBlocked: 0,
      perSite: {},
    };

    stats = {};
    blockedLog = [];
    tabDoms = {};

    await chrome.storage.local.set({
      globalStats,
      stats: {},
      blockedLog: [],
      tabDoms: {},
    });

    sendResponse({
      success: true,
    });
  },

  GET_DASHBOARD_DATA: async (msg, sender, sendResponse) => {
    if (!filterListManager.initialized) {
      await filterListManager.init();
    }

    const stored = await chrome.storage.local.get(['sinceInstall', 'whitelist']);

    const si = stored.sinceInstall || {
      totalBlocked: 0,
      installDate: null,
    };

    whitelist = stored.whitelist || [];

    const top = Object.entries(globalStats.perSite)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50);

    const cats = {};

    for (const e of blockedLog) {
      const d = e.domain || '';
      let c = 'Other';

      if (/google|doubleclick|googlesyndication|googleadservices|googletagmanager|google-analytics|imasdk/.test(d)) {
        c = 'Google Ads & Tracking';
      } else if (/facebook|fbevents|pixel\.facebook/.test(d)) {
        c = 'Facebook / Meta';
      } else if (/taboola|outbrain|mgid|revcontent/.test(d)) {
        c = 'Native Ads';
      } else if (/criteo|pubmatic|adnxs|rubiconproject|openx|indexexchange/.test(d)) {
        c = 'Programmatic / RTB';
      } else if (/amazon-adsystem|ads\.twitter|ads\.linkedin|bat\.bing/.test(d)) {
        c = 'Platform Ads';
      } else if (/hotjar|mixpanel|clarity|chartbeat|scorecardresearch|demdex|moatads/.test(d)) {
        c = 'Trackers & Analytics';
      } else if (/adroll|viglink|liveintent|adform|adsrvr/.test(d)) {
        c = 'Ad Networks';
      }

      cats[c] = (cats[c] || 0) + 1;
    }

    sendResponse({
      enabled: isEnabled,
      totalBlocked: si.totalBlocked,
      sinceInstall: si,
      topSites: top,
      blockedLog: blockedLog.slice(0, 200),
      categories: cats,
      whitelist,
      networkRuleCount: engine.networkFilters.length,
      cosmeticRuleCount: engine.cosmeticFilters.length,
      exceptionCount: engine.exceptions.length,
      trackerLearner: trackerLearner.getStats(),
      learnedTrackers: trackerLearner.getLearnedTrackers().slice(0, 50),
      filterListStats: filterListManager.getStats(),
      filterLists: filterListManager.getAllLists(),
    });
  },

  GET_PRO_SETTINGS: async (msg, sender, sendResponse) => {
    const d = await chrome.storage.local.get('proSettings');

    sendResponse(d.proSettings || {
      adBlocking: true,
      fingerprintProtection: true,
      cookieAutoReject: true,
      annoyanceBlocking: true,
      minerBlocking: true,
      antiAdblock: true,
    });
  },

  SET_PRO_SETTINGS: async (msg, sender, sendResponse) => {
    const ALLOWED_SETTINGS = {
      adBlocking: 'boolean',
      fingerprintProtection: 'boolean',
      cookieAutoReject: 'boolean',
      annoyanceBlocking: 'boolean',
      minerBlocking: 'boolean',
      antiAdblock: 'boolean',
    };

    const incoming = (msg && typeof msg.settings === 'object' && msg.settings) || {};
    const safe = {};

    for (const [k, expectedType] of Object.entries(ALLOWED_SETTINGS)) {
      if (k in incoming && typeof incoming[k] === expectedType) {
        safe[k] = incoming[k];
      }
    }

    await chrome.storage.local.set({
      proSettings: safe,
    });

    sendResponse({
      success: true,
      settings: safe,
    });
  },

  ALLOW_LEARNED_TRACKER: (msg, sender, sendResponse) => {
    trackerLearner.allowDomain(msg.domain);

    sendResponse({
      success: true,
    });
  },

  UPDATE_ALL_FILTER_LISTS: async (msg, sender, sendResponse) => {
    const now = Date.now();

    if (now - lastFilterUpdate < FILTER_UPDATE_MIN_INTERVAL) {
      sendResponse({
        success: false,
        reason: 'rate_limited',
        retryAfterMs: FILTER_UPDATE_MIN_INTERVAL - (now - lastFilterUpdate),
      });
      return;
    }

    lastFilterUpdate = now;

    await updateFilterLists();

    sendResponse({
      success: true,
      lists: filterListManager.getAllLists(),
      stats: filterListManager.getStats(),
    });
  },

  CLEAR_BLOCKED_LOG: async (msg, sender, sendResponse) => {
    blockedLog = [];

    await chrome.storage.local.set({
      blockedLog: [],
    });

    sendResponse({
      success: true,
    });
  },

  INJECT_SCRIPTLETS: async (msg, sender, sendResponse) => {
    const claimedHost = String(msg.hostname || '').slice(0, 200);
    const tabId = sender.tab?.id;

    if (tabId == null) {
      sendResponse({
        injected: 0,
      });
      return;
    }

    const actualHost = safeSenderHostname(sender);

    if (!actualHost || actualHost !== claimedHost) {
      logError('inject:host-mismatch', `claimed=${claimedHost} actual=${actualHost}`);

      sendResponse({
        injected: 0,
        error: 'host_mismatch',
      });
      return;
    }

    const rules = (engine.scriptletRules && engine.scriptletRules[claimedHost]) || [];
    const globalRules = (engine.scriptletRules && engine.scriptletRules['*']) || [];
    const allRules = [...globalRules, ...rules];

    let injected = 0;

    for (const r of allRules) {
      if (!isScriptletAllowed(r.name)) continue;

      const code = buildScriptletCode(r.name, r.args);

      if (!code) continue;

      try {
        await chrome.scripting.executeScript({
          target: {
            tabId,
            allFrames: false,
          },
          world: 'MAIN',
          func: function(scriptletCode) {
            try {
              const s = document.createElement('script');
              s.textContent = scriptletCode;
              (document.head || document.documentElement).appendChild(s);
              s.remove();
            } catch (e) {}
          },
          args: [code],
        });

        injected++;
      } catch (e) {
        logError('injectScriptlet', e);
      }
    }

    sendResponse({
      injected,
    });
  },

  GET_SCRIPTLETS: (msg, sender, sendResponse) => {
    const host = String(msg.hostname || '').slice(0, 200);
    const rules = (engine.scriptletRules && engine.scriptletRules[host]) || [];
    const globalRules = (engine.scriptletRules && engine.scriptletRules['*']) || [];
    const allRules = [...globalRules, ...rules];
    const codes = [];

    for (const r of allRules) {
      if (!isScriptletAllowed(r.name)) continue;

      const code = buildScriptletCode(r.name, r.args);

      if (code) {
        codes.push(code);
      }
    }

    sendResponse({
      scriptlets: codes,
    });
  },

  GET_PROCEDURAL_FILTERS: (msg, sender, sendResponse) => {
    const host = String(msg.hostname || '').slice(0, 200);
    const filters = [];

    if (engine.proceduralFilters) {
      for (const pf of engine.proceduralFilters) {
        if (!pf.host || pf.host === '' || host.includes(pf.host)) {
          filters.push(pf.selector);
        }
      }
    }

    sendResponse({
      filters,
    });
  },

  GET_DEBUG_INFO: (msg, sender, sendResponse) => {
    const ourOrigin = `chrome-extension://${chrome.runtime.id}/`;

    if (!sender.url || !sender.url.startsWith(ourOrigin)) {
      sendResponse({
        error: 'forbidden',
      });
      return;
    }

    sendResponse({
      version: '1.3.1',
      initDone,
      networkRules: engine.networkFilters.length,
      cosmeticRules: engine.cosmeticFilters.length,
      scriptletRuleHosts: Object.keys(engine.scriptletRules || {}).length,
      errorCount: self.__zenithErrorCount || 0,
      lastError: self.__zenithLastError || null,
      uptime: Date.now() - (self.__zenithStart || Date.now()),
    });
  },
};

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function isMissingTabError(error) {
  const message = String(error?.message || error || '');

  return (
    message.includes('No tab with id') ||
    message.includes('Tabs cannot be edited right now') ||
    message.includes('Invalid tab ID')
  );
}

function cleanupDeadTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  delete stats[tabId];
  delete tabDoms[tabId];
  delete tabUrls[tabId];
  delete recentBlocks[tabId];

  markDirty();
}

function updateBadge(tabId, count) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  const text = count > 999 ? '999+' : String(count);

  chrome.action.setBadgeText({
    text,
    tabId,
  }).catch((error) => {
    if (isMissingTabError(error)) {
      cleanupDeadTab(tabId);
      return;
    }

    logError('updateBadge:setBadgeText', error);
  });

  chrome.action.setBadgeBackgroundColor({
    color: '#e74c3c',
    tabId,
  }).catch((error) => {
    if (isMissingTabError(error)) {
      cleanupDeadTab(tabId);
      return;
    }

    logError('updateBadge:setBadgeBackgroundColor', error);
  });
}

async function syncDynamicRules() {
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();

    const T = [
      'main_frame',
      'sub_frame',
      'stylesheet',
      'script',
      'image',
      'font',
      'xmlhttprequest',
      'ping',
      'media',
      'other',
    ];

    const rules = [];
    let id = 1000;

    for (const f of engine.networkFilters) {
      if (id >= 5999 || !f.pattern || f.pattern.length < 3) continue;

      rules.push({
        id: id++,
        priority: 1,
        action: {
          type: 'block',
        },
        condition: {
          urlFilter: f.pattern,
          resourceTypes: f.resourceTypes?.length ? f.resourceTypes : T,
        },
      });
    }

    for (const f of engine.exceptions) {
      if (id >= 5999 || !f.pattern || f.pattern.length < 3) continue;

      rules.push({
        id: id++,
        priority: 2,
        action: {
          type: 'allow',
        },
        condition: {
          urlFilter: f.pattern,
          resourceTypes: T,
        },
      });
    }

    const redirects = [
      {
        id: 9001,
        urlFilter: 'google-analytics.com/analytics.js',
        file: 'redirects/google-analytics.js',
      },
      {
        id: 9002,
        urlFilter: 'google-analytics.com/ga.js',
        file: 'redirects/google-analytics.js',
      },
      {
        id: 9003,
        urlFilter: 'googletagmanager.com/gtag/js',
        file: 'redirects/google-analytics.js',
      },
      {
        id: 9004,
        urlFilter: 'googletagservices.com/tag/js/gpt.js',
        file: 'redirects/googletagservices.js',
      },
      {
        id: 9005,
        urlFilter: 'connect.facebook.net/*/fbevents.js',
        file: 'redirects/fbevents.js',
      },
    ];

    for (const r of redirects) {
      rules.push({
        id: r.id,
        priority: 100,
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: '/' + r.file,
          },
        },
        condition: {
          urlFilter: r.urlFilter,
          resourceTypes: ['script'],
        },
      });
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: old.map((r) => r.id),
      addRules: rules.slice(0, 5000),
    });
  } catch (e) {
    logError('syncDynamicRules', e);
  }
}

async function updateFilterLists() {
  try {
    engine.networkFilters = [];
    engine.cosmeticFilters = [];
    engine.exceptions = [];

    try {
      const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
      const { text } = sanitizeFilterList(await r.text());
      engine.parse(text);
    } catch (e) {
      logError('updateFilterLists:default', e);
    }

    if (!filterListManager.initialized) {
      await filterListManager.init();
    }

    const enabledLists = filterListManager.getEnabledLists();

    for (const list of enabledLists) {
      try {
        const fetchedText = await filterListManager.fetchList(list.id);
        const cachedText = fetchedText || await filterListManager.getCachedList(list.id);

        if (!cachedText) {
          continue;
        }

        const { text } = sanitizeFilterList(cachedText);
        engine.parse(text);
      } catch (e) {
        logError(`updateFilterLists:parse:${list.id}`, e);
      }
    }

    await syncDynamicRules();
  } catch (e) {
    logError('updateFilterLists', e);
  }
}

async function init() {
  self.__zenithStart = Date.now();

  try {
    const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
    const { text } = sanitizeFilterList(await r.text());
    engine.parse(text);
  } catch (e) {
    logError('init:default-filters', e);
  }

  try {
    await filterListManager.init();

    for (const l of filterListManager.getEnabledLists()) {
      try {
        const c = await filterListManager.getCachedList(l.id);

        if (!c) {
          continue;
        }

        const { text } = sanitizeFilterList(c);
        engine.parse(text);
      } catch (e) {
        logError(`init:cached:${l.id}`, e);
      }
    }
  } catch (e) {
    logError('init:filterListManager', e);
  }

  try {
    const d = await chrome.storage.local.get([
      'enabled',
      'whitelist',
      'globalStats',
      'blockedLog',
      'stats',
      'tabDoms',
      'tabUrls',
    ]);

    if (d.enabled !== undefined) {
      isEnabled = d.enabled;
    }

    if (d.whitelist) {
      whitelist = d.whitelist;
    }

    if (d.globalStats) {
      globalStats = d.globalStats;
    }

    if (d.blockedLog && Array.isArray(d.blockedLog)) {
      blockedLog = d.blockedLog;
    }

    if (d.stats) {
      stats = d.stats;
    }

    if (d.tabDoms) {
      tabDoms = d.tabDoms;
    }

    if (d.tabUrls) {
      tabUrls = d.tabUrls;
    }
  } catch (e) {
    logError('init:restore-session', e);
  }

  try {
    const local = await chrome.storage.local.get('sinceInstall');
    const sync = await chrome.storage.sync.get('sinceInstall');

    const localSI = local.sinceInstall || {
      totalBlocked: 0,
      installDate: null,
    };

    const syncSI = sync.sinceInstall || {
      totalBlocked: 0,
      installDate: null,
    };

    if (syncSI.totalBlocked > localSI.totalBlocked) {
      await chrome.storage.local.set({
        sinceInstall: syncSI,
      });

      globalStats.totalBlocked = Math.max(globalStats.totalBlocked, syncSI.totalBlocked);
    }

    if (!localSI.installDate && syncSI.installDate) {
      await chrome.storage.local.set({
        sinceInstall: {
          ...localSI,
          installDate: syncSI.installDate,
        },
      });
    }
  } catch (e) {
    logError('init:sinceInstall-reconcile', e);
  }

  try {
    await trackerLearner.load();
  } catch (e) {
    logError('init:trackerLearner.load', e);
  }

  await syncDynamicRules();

  try {
    const tabs = await chrome.tabs.query({});

    for (const t of tabs) {
      if (stats[t.id] > 0) {
        updateBadge(t.id, stats[t.id]);
      }
    }
  } catch (e) {
    logError('init:badge-restore', e);
  }

  initDone = true;

  console.log(`[Zenith] v1.3.1 ready — network:${engine.networkFilters.length} cosmetic:${engine.cosmeticFilters.length}`);
}

init();
