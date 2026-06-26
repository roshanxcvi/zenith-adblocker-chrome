/**
 * Zenith AdBlocker — Chrome Background (MV3)
 * by roshanxcvi
 *
 * v1.2— INJECTION-FOCUSED AUDIT (3 findings):
 *   CI-01 CSS injection via cosmetic selector with braces in an attribute
 *         value — selectors are now validated for CSS-breakout chars
 *         ({ } @ ; </style) before being concatenated into a <style>,
 *         and the injected stylesheet is built from the validated list
 *         (content.js)
 *   SI-01 Scriptlet arg sanitizer hardened — strips backslashes and line
 *         terminators and drops args containing <script (security.js)
 *   WAR-01 web_accessible_resources trimmed — network-logger.html/.js
 *         removed (extension pages don't need web access); resources
 *         split so only what's injected/redirected is exposed (manifest)
 *
 * v1.0 — COMPREHENSIVE HARDENING (third-round audit, 11 findings):
 *   H-A Cookie auto-reject scoped to CMP containers + isSafeToClick guard
 *   H-B XSS-safe DOM rendering in dashboard.js and popup.js
 *   H-C shouldBlock honors real resourceType (typed rules now match)
 *   M-A Whitelist/cosmetic domain match is dot-anchored, not substring
 *   M-B TrackerLearner _isLegitimate dot-anchored suffix match
 *   M-C TrackerLearner domainSightings capped at 500 by recency (LRU)
 *   M-D new RegExp wrapped in try/catch — one bad rule no longer kills parse
 *   M-E Procedural-filter regex sanitized against ReDoS (nested quantifiers)
 *   L-A Procedural-filter MutationObserver disconnects on pagehide
 *   L-B _upward closest() wrapped in try/catch
 *   L-C Element picker refuses to hide structural elements (html/head/body)
 *
 * v1.2 — REFRESH DOUBLE-COUNT FIX
 *   Bug:  Refreshing a page added the same block count to the badge
 *         AND to the lifetime "sinceInstall" total again. Refresh 5
 *         times → counts inflated 5x.
 *   Root: (a) webNavigation transitionType filter excluded 'reload'
 *             so the badge never reset on F5
 *         (b) declarativeNetRequest events fire on every refresh and
 *             went straight to incrementBlockedCount() with no dedup
 *         (c) REPORT_BLOCKED (cosmetic blocks from content.js) had
 *             the same issue and was also called multiple times per
 *             page load by content.js's three countOnce() timers
 *   Fix:  - webNavigation.onCommitted now resets stats[tabId] on
 *           every top-frame navigation, including reloads
 *         - recentBlocks[tabId] map dedupes lifetime credit by
 *           (tab, url) within a navigation, cleared on each new nav
 *         - REPORT_BLOCKED uses the same dedup keyed on (tab, host)
 *           so the three countOnce() calls are credited once
 *
 * v1.0— SECOND-ROUND AUDIT FIXES (kept):
 *   H-01..I-02  ...see CHANGELOG for the full list
 *
 * v1.0 — SECURITY HARDENING (kept):
 *   #1..#6      ...filter integrity, scriptlet allowlist, sender
 *                  validation, explicit CSP, null-safe URL parsing
 */


import { parseFilterList } from './modules/filter-parser.js';
import { 
  compileNetworkRulesToDnr,
  compileAllowRulesToDnr,} from './modules/dnr-compiler.js';
import { FilterEngine } from './rules/filter-engine.js';
import { TrackerLearner } from './modules/tracker-learner.js';
import { FilterListManager } from './modules/filter-list-manager.js';
import { SCRIPTLETS, buildScriptletCode, parseScriptletRule } from './modules/scriptlets.js';
import { RULE_CATEGORIES, getDefaultRuleCategorySettings, normalizeRuleCategorySettings } from './rules/rule-categories.js';
import {
  validateSender,
  safeHostname,
  safeSenderHostname,
  sanitizeFilterList,
  isScriptletAllowed,
  logError,
} from './modules/security.js';

const engine = new FilterEngine();
const trackerLearner = new TrackerLearner();
const filterListManager = new FilterListManager();

// ════════════════════════════════════════════════════════════════
// State (in-memory cache; storage is the source of truth)
// ════════════════════════════════════════════════════════════════

let isEnabled = true;
let stats = {};
let whitelist = [];
let globalStats = { totalBlocked: 0, perSite: {} };
let blockedLog = [];
const MAX_LOG = 500;
let tabDoms = {};
let tabUrls = {};
let initDone = false;

// refresh dedup state. See the long comment block below for why.
const recentBlocks = Object.create(null);    // { [tabId]: { [urlOrKey]: timestamp } }
const DEDUP_MAX_PER_TAB = 1000;              // memory cap per tab

// ════════════════════════════════════════════════════════════════
// Throttled persistence (fixes "saveSession on every block")
// ════════════════════════════════════════════════════════════════

let dirty = false;
function markDirty() { dirty = true; }

// H-03 FIX — strip query strings + fragments from URLs before they're
// stored in blockedLog. Request URLs commonly contain session tokens,
// OAuth codes, search queries, user IDs and API keys; persisting them
// to local storage is a privacy leak even though the data never leaves
// the browser (other extensions, XSS on the dashboard, etc. could harvest it).
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
      stats, tabDoms, tabUrls,
      blockedLog: blockedLog.slice(0, MAX_LOG),
      lastSave: Date.now(),
    });
  } catch (e) { logError('flushIfDirty', e); dirty = true; /* retry next tick */ }
}

async function incrementBlockedCount(count) {
  try {
    const data = await chrome.storage.local.get(['sinceInstall', 'globalStats']);
    const si = data.sinceInstall || { totalBlocked: 0, installDate: null };
    const gs = data.globalStats || { totalBlocked: 0, perSite: {} };
    si.totalBlocked += count;
    gs.totalBlocked += count;
    globalStats.totalBlocked = gs.totalBlocked;
    await chrome.storage.local.set({ sinceInstall: si, globalStats: gs });
    chrome.storage.sync.set({ sinceInstall: si }).catch(e => logError('sync-write', e));
  } catch (e) { logError('incrementBlockedCount', e); }
}

// ════════════════════════════════════════════════════════════════
// Top-level listeners (MUST be registered synchronously for MV3)
// ════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener((details) => {
  try { chrome.contextMenus.create({ id: 'block-element', title: 'Block this element', contexts: ['all'] }); }
  catch (e) { logError('contextMenu.create', e); }
  if (details.reason === 'install') {
    const seed = { totalBlocked: 0, installDate: new Date().toISOString() };
    chrome.storage.local.set({ sinceInstall: seed }).catch(e => logError('install-seed-local', e));
    chrome.storage.sync.set({ sinceInstall: seed }).catch(e => logError('install-seed-sync', e));
    // Handle the retrieved rule category settings
    chrome.storage.local.get('ruleCategories').then((stored) => {
      const current = stored.ruleCategories || {};
      const normalized = normalizeRuleCategorySettings(current);

      chrome.storage.local.set({
        ruleCategories: normalized
      });
    });
  }
  updateFilterLists();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  // FIX #3 — validate sender BEFORE dispatching
  const v = validateSender(sender, type);
  if (!v.ok) {
    logError('msg:sender-rejected', `${type} from ${sender?.url || 'unknown'}: ${v.reason}`);
    sendResponse({ error: 'forbidden' });
    return false;
  }

  const handler = HANDLERS[type];
  if (!handler) {
    sendResponse({ error: 'unknown_message_type' });
    return false;
  }
  try {
    const result = handler(msg, sender, sendResponse);
    // If handler returned a Promise, await it for async response.
    if (result && typeof result.then === 'function') {
      result.catch(e => {
        logError(`handler:${type}`, e);
        try { sendResponse({ error: 'handler_threw' }); } catch (_) {}
      });
      return true; // keep the channel open
    }
    // Otherwise the handler called sendResponse synchronously (or didn't respond)
    return result === true;
  } catch (e) {
    logError(`handler:${type}:sync`, e);
    try { sendResponse({ error: 'handler_threw' }); } catch (_) {}
    return false;
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-element' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'PICK_ELEMENT' }).catch(e => logError('pick-element-send', e));
  }
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;

  // v2.0.5 FIX — reset per-tab badge on EVERY top-frame navigation,
  // including refresh. The previous filter excluded 'reload', which
  // meant refreshing a page accumulated counts across refreshes.
  //
  // We don't filter by transitionType anymore — top-frame navigation
  // means "the user is loading a new page", end of story.
  const h = safeHostname(d.url);
  if (h) tabUrls[d.tabId] = h;
  stats[d.tabId] = 0;
  tabDoms[d.tabId] = {};

  // v2.0.5 — clear per-tab dedup state on navigation. Same URL re-blocked
  // on the same tab after this point will be credited to the lifetime
  // counter fresh, as it should be.
  recentBlocks[d.tabId] = Object.create(null);

  updateBadge(d.tabId, 0);
  markDirty();
});

chrome.tabs.onRemoved.addListener((id) => {
  delete stats[id];
  delete tabDoms[id];
  delete tabUrls[id];
  delete recentBlocks[id];
  markDirty();
});

chrome.alarms.create('autoSave', { periodInMinutes: 0.5 });
chrome.alarms.create('updateFilters', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoSave') flushIfDirty();
  if (a.name === 'updateFilters') updateFilterLists();
});

// ════════════════════════════════════════════════════════════════
// v1.0— REFRESH DEDUP STATE
// ════════════════════════════════════════════════════════════════
//
// recentBlocks[tabId][url] — map of URLs blocked on this tab, cleared
// on navigation by webNavigation.onCommitted. Used to dedup the LIFETIME
// counter so refreshing a page with 50 ads adds 50 to `sinceInstall`,
// not 100 (one refresh) or 250 (five refreshes).
//
// The per-tab BADGE still increments for every block on the current
// page load — users want to see "47 blocked here" — but stats[tabId]
// is reset to 0 on navigation, so refreshing doesn't double the badge.
//
// (recentBlocks is declared at the top of the file with the rest of
// the in-memory cache.)

function shouldDedupLifetime(tabId, url) {
  if (!url) return false;
  let tabMap = recentBlocks[tabId];
  if (!tabMap) {
    tabMap = recentBlocks[tabId] = Object.create(null);
  }
  if (tabMap[url]) {
    // We've already counted this URL on this tab since the last
    // navigation — it's a refresh hit. Don't bump lifetime again.
    return true;
  }
  tabMap[url] = Date.now();
  // Trim if the tab is unusually busy (memory safety, not correctness)
  const keys = Object.keys(tabMap);
  if (keys.length > DEDUP_MAX_PER_TAB) {
    keys.sort((a, b) => tabMap[a] - tabMap[b]);
    for (let i = 0; i < keys.length - DEDUP_MAX_PER_TAB; i++) {
      delete tabMap[keys[i]];
    }
  }
  return false;
}

// declarativeNetRequest debug listener — guard registration
try {
  if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      if (info.request.tabId < 0) return;
      const tabId = info.request.tabId;
      const url = info.request.url;

      // v1.0— per-tab badge counts every block, BUT it resets on
      // navigation via webNavigation.onCommitted above. No more
      // accumulation across refreshes.
      stats[tabId] = (stats[tabId] || 0) + 1;
      updateBadge(tabId, stats[tabId]);

      // v1.0 — lifetime counter (`sinceInstall.totalBlocked`)
      // dedupes per (tab, url) since the last navigation. So:
      //   - Page A blocks 50 ads → +50 lifetime
      //   - User refreshes → +0 lifetime (same URLs re-blocked)
      //   - User refreshes again → +0 lifetime
      //   - User clicks a link to Page B → recentBlocks[tab] cleared
      //   - Page B blocks 30 ads → +30 lifetime
      //   - User refreshes Page B → +0 lifetime
      const isRefreshDup = shouldDedupLifetime(tabId, url);

      const h = safeHostname(url);
      if (h) {
        // Per-site stats and the "top blocked domains" view are per-tab
        // displays, but we ALSO dedupe their increment so the dashboard's
        // top-sites bar chart doesn't get rocket-fueled by F5 spam.
        if (!isRefreshDup) {
          globalStats.perSite[h] = (globalStats.perSite[h] || 0) + 1;
        }
        if (!tabDoms[tabId]) tabDoms[tabId] = {};
        if (!tabDoms[tabId][h]) tabDoms[tabId][h] = { count: 0, type: info.request.type || 'other' };
        // Per-tab domain count IS allowed to grow across refreshes within
        // the same page session — the popup shows what's been blocked
        // since the last navigation, which is reset by the nav handler.
        tabDoms[tabId][h].count++;

        // Blocked log is a chronological feed — keep every entry so the
        // network logger shows refresh activity, but it's bounded by
        // MAX_LOG so it can't grow unbounded.
        blockedLog.unshift({
          url: sanitizeLogUrl(url),
          domain: h,
          type: info.request.type || 'other',
          timestamp: Date.now(),
          tabId,
        });
        if (blockedLog.length > MAX_LOG) blockedLog.length = MAX_LOG;

        const src = safeHostname(info.request.documentUrl);
        if (src && src !== h) {
          try { trackerLearner.recordSighting(h, src); } catch (e) { logError('learner:onRuleMatched', e); }
        }
      }

      // Only bump the lifetime counter for first-time blocks.
      if (!isRefreshDup) incrementBlockedCount(1);

      markDirty();
    });
  }
} catch (e) { logError('register:onRuleMatchedDebug', e); }

// ════════════════════════════════════════════════════════════════
// HANDLERS — dispatch map (was 200+ lines of if/else)
// ════════════════════════════════════════════════════════════════

// M-02 helper — clamp untrusted string fields. A malicious page can send
// a 500,000-character hostname and cause excessive string-matching on
// every load.
function clampStr(value, max = 200) {
  return String(value || '').slice(0, max);
}

// L-01 — rate-limit state for UPDATE_ALL_FILTER_LISTS
function normalizeSiteSettings(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    ads: settings.ads !== false,
    cosmetic: settings.cosmetic !== false,
    trackers: settings.trackers !== false,
    fingerprinting: settings.fingerprinting !== false,
    cookie: settings.cookie !== false,
    annoyances: settings.annoyances !== false,
    miners: settings.miners !== false
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


const HANDLERS = {

  GET_SITE_SETTINGS: async (msg, sender, sendResponse) => {
  try {
    const siteKey = getSiteKeyFromHostname(msg.hostname);

    if (!siteKey) {
      sendResponse({
        success: false,
        error: 'invalid_site',
        received: msg.hostname
      });
      return;
    }

    const stored = await chrome.storage.local.get('siteSettings');
    const allSettings = stored.siteSettings || {};
    const settings = normalizeSiteSettings(allSettings[siteKey] || {});

    sendResponse({
      success: true,
      hostname: siteKey,
      settings
    });
  } catch (error) {
    console.error('[Zenith] GET_SITE_SETTINGS failed:', error);

    sendResponse({
      success: false,
      error: 'get_site_settings_failed',
      message: error?.message || String(error)
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
        received: msg.hostname
      });
      return;
    }

    const stored = await chrome.storage.local.get('siteSettings');
    const allSettings = stored.siteSettings || {};

    allSettings[siteKey] = normalizeSiteSettings(msg.settings || {});

    await chrome.storage.local.set({
      siteSettings: allSettings
    });

    sendResponse({
      success: true,
      hostname: siteKey,
      settings: allSettings[siteKey]
    });
  } catch (error) {
    console.error('[Zenith] SET_SITE_SETTINGS failed:', error);

    sendResponse({
      success: false,
      error: 'set_site_settings_failed',
      message: error?.message || String(error)
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
      settings
    });
  } catch (error) {
    console.error('[Zenith] GET_RULE_CATEGORIES failed:', error);

    sendResponse({
      success: false,
      error: 'get_rule_categories_failed',
      message: error?.message || String(error)
    });
  }
},
//old set_rule_category handler
  //SET_RULE_CATEGORY: async (msg, sender, sendResponse) => {
    //const category = String(msg.category || '');
    //const enabled = Boolean(msg.enabled);

SET_RULE_CATEGORY: async (msg, sender, sendResponse) => {
  try {
  
    const category = String(msg.category || '').trim();
    const enabled = msg.enabled === true;

    if (!Object.prototype.hasOwnProperty.call(RULE_CATEGORIES, category)) {
      sendResponse({
        success: false,
        error: 'invalid_category',
        received: category,
        available: Object.keys(RULE_CATEGORIES)
      });
      return;
    }

    const stored = await chrome.storage.local.get('ruleCategories');
    const settings = normalizeRuleCategorySettings(stored.ruleCategories || {});

    settings[category] = enabled;

    await chrome.storage.local.set({
      ruleCategories: settings
    });

    sendResponse({
      success: true,
      category,
      enabled,
      settings
    });
  } catch (error) {
    console.error('[Zenith] SET_RULE_CATEGORY failed:', error);

    sendResponse({
      success: false,
      error: 'set_rule_category_failed',
      message: error?.message || String(error)
    });
  }
},

  CHECK_URL: (msg, sender, sendResponse) => {
    const url = clampStr(msg.url, 2048);
    const src = clampStr(msg.sourceUrl, 2048);
    const rt = clampStr(msg.resourceType, 32); // optional; engine handles ''
    sendResponse({ blocked: isEnabled && engine.shouldBlock(url, src, rt) });
  },

  GET_COSMETIC_FILTERS: (msg, sender, sendResponse) => {
    const host = clampStr(msg.hostname); // M-02 — was passed raw before
    sendResponse({ selectors: engine.getCosmeticSelectors(host) });
  },

  GET_STATE: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get(['whitelist', 'enabled']);
    whitelist = stored.whitelist || [];
    isEnabled = stored.enabled !== undefined ? stored.enabled : true;
    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[sender.tab?.id] || 0,
      totalBlocked: globalStats.totalBlocked,
      whitelist,
    });
  },

  GET_TAB_STATS: (msg, sender, sendResponse) => {
    // M-01 — same tab cross-check as GET_POPUP_OVERVIEW
    let tabId;
    if (sender.tab) {
      if (msg.tabId != null && msg.tabId !== sender.tab.id) {
        sendResponse({ error: 'tab_mismatch' });
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
    // M-01 FIX — when called from a content script (sender.tab is set),
    // msg.tabId must match sender.tab.id. Otherwise a content script in
    // tab 5 could read tabDoms[10] and learn which trackers are on a tab
    // the user has open elsewhere.
    // The popup runs in an extension page (sender.tab == null) so it can
    // legitimately request data for any tab the user is viewing.
    let tabId;
    if (sender.tab) {
      if (msg.tabId != null && msg.tabId !== sender.tab.id) {
        sendResponse({ error: 'tab_mismatch' });
        return;
      }
      tabId = sender.tab.id;
    } else {
      tabId = msg.tabId;
    }

    const stored = await chrome.storage.local.get(['sinceInstall', 'whitelist']);
    const si = stored.sinceInstall || { totalBlocked: 0, installDate: null };
    whitelist = stored.whitelist || [];
    const d = tabDoms[tabId] || {};
    const sorted = Object.entries(d)
      .map(([k, v]) => ({ domain: k, count: v.count, type: v.type }))
      .sort((a, b) => b.count - a.count);
    const cats = { ads: 0, trackers: 0, social: 0, other: 0 };
    for (const { domain: dm } of sorted) {
      if (/google|doubleclick|googlesyndication|taboola|outbrain|adnxs|criteo|pubmatic|amazon-adsystem|ads\.|adform/.test(dm)) cats.ads++;
      else if (/analytics|hotjar|mixpanel|clarity|segment|optimizely|chartbeat|scorecard|quantserve|demdex|moatads/.test(dm)) cats.trackers++;
      else if (/facebook|twitter|linkedin|instagram|snap\.licdn|pixel\.facebook/.test(dm)) cats.social++;
      else cats.other++;
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
    await chrome.storage.local.set({ enabled: isEnabled });
    sendResponse({ enabled: isEnabled });
  },

  ADD_WHITELIST: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get('whitelist');
    const wl = stored.whitelist || [];
    const d = String(msg.domain || '').replace(/^www\./, '').trim();
    if (!d) { sendResponse({ whitelist: wl, error: 'empty_domain' }); return; }
    if (!wl.includes(d)) wl.push(d);
    await chrome.storage.local.set({ whitelist: wl });
    whitelist = wl;
    sendResponse({ whitelist: wl });
  },

  REMOVE_WHITELIST: async (msg, sender, sendResponse) => {
    // L-02 FIX — mirror ADD_WHITELIST's sanitization. The old version
    // used msg.domain directly in the filter, so null/undefined/object
    // would silently remove nothing.
    const domain = String(msg.domain || '').replace(/^www\./, '').trim();
    if (!domain) { sendResponse({ whitelist, error: 'empty_domain' }); return; }
    const stored = await chrome.storage.local.get('whitelist');
    const wl = (stored.whitelist || []).filter(d => d !== domain);
    await chrome.storage.local.set({ whitelist: wl });
    whitelist = wl;
    sendResponse({ whitelist: wl });
  },

  REPORT_BLOCKED: (msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (tabId == null) return;

    // M-05 FIX — parse and validate before clamping. Math.max/min with
    // NaN returns NaN which corrupts stats and produces a "NaN" badge.
    const raw = parseInt(msg.count, 10);
    const count = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 1;

    // Per-tab badge counts every cosmetic-block report. Reset is handled
    // by webNavigation.onCommitted (stats[tabId] = 0).
    stats[tabId] = (stats[tabId] || 0) + count;
    updateBadge(tabId, stats[tabId]);

    const h = safeSenderHostname(sender);
    if (h) {
      // Per-tab domain count is OK to grow within the same page session
      if (!tabDoms[tabId]) tabDoms[tabId] = {};
      if (!tabDoms[tabId][h]) tabDoms[tabId][h] = { count: 0, type: 'cosmetic' };
      tabDoms[tabId][h].count += count;

      // v2.0.5 — only count cosmetic blocks toward LIFETIME once per
      // (tab, hostname) since the last navigation. content.js calls
      // countOnce() multiple times (at load, +500ms, +3s) so without
      // this we'd triple-count even on a single page load — and on
      // refresh we'd add the count all over again.
      //
      // We reuse the recentBlocks map with a synthetic key prefixed
      // 'cosmetic:' so it shares the navigation-reset path.
      const dedupKey = 'cosmetic:' + h;
      if (!shouldDedupLifetime(tabId, dedupKey)) {
        globalStats.perSite[h] = (globalStats.perSite[h] || 0) + count;
        incrementBlockedCount(count);
      }
    }

    markDirty();
  },

  RESET_STATS: async (msg, sender, sendResponse) => {
    globalStats = { totalBlocked: 0, perSite: {} };
    stats = {};
    blockedLog = [];
    tabDoms = {};
    await chrome.storage.local.set({ globalStats, stats: {}, blockedLog: [], tabDoms: {} });
    sendResponse({ success: true });
  },

  GET_DASHBOARD_DATA: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get(['sinceInstall', 'whitelist']);
    const si = stored.sinceInstall || { totalBlocked: 0, installDate: null };
    whitelist = stored.whitelist || [];
    const top = Object.entries(globalStats.perSite).sort((a, b) => b[1] - a[1]).slice(0, 50);
    const cats = {};
    for (const e of blockedLog) {
      const d = e.domain || ''; let c = 'Other';
      if (/google|doubleclick|googlesyndication|googleadservices|googletagmanager|google-analytics|imasdk/.test(d)) c = 'Google Ads & Tracking';
      else if (/facebook|fbevents|pixel\.facebook/.test(d)) c = 'Facebook / Meta';
      else if (/taboola|outbrain|mgid|revcontent/.test(d)) c = 'Native Ads';
      else if (/criteo|pubmatic|adnxs|rubiconproject|openx|indexexchange/.test(d)) c = 'Programmatic / RTB';
      else if (/amazon-adsystem|ads\.twitter|ads\.linkedin|bat\.bing/.test(d)) c = 'Platform Ads';
      else if (/hotjar|mixpanel|clarity|chartbeat|scorecardresearch|demdex|moatads/.test(d)) c = 'Trackers & Analytics';
      else if (/adroll|viglink|liveintent|adform|adsrvr/.test(d)) c = 'Ad Networks';
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
    });
  },

  GET_PRO_SETTINGS: async (msg, sender, sendResponse) => {
    const d = await chrome.storage.local.get('proSettings');
    sendResponse(d.proSettings || {
      adBlocking: true, fingerprintProtection: true, cookieAutoReject: true,
      annoyanceBlocking: true, minerBlocking: true, antiAdblock: true,
    });
  },

  SET_PRO_SETTINGS: async (msg, sender, sendResponse) => {
    // H-02 FIX — allow-list known keys and validate types. Without this,
    // a compromised extension page could write arbitrary keys/values
    // into storage (including masquerading as whitelist/enabled/sinceInstall).
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
    await chrome.storage.local.set({ proSettings: safe });
    sendResponse({ success: true, settings: safe });
  },

  ALLOW_LEARNED_TRACKER: (msg, sender, sendResponse) => {
    trackerLearner.allowDomain(msg.domain);
    sendResponse({ success: true });
  },

  UPDATE_ALL_FILTER_LISTS: async (msg, sender, sendResponse) => {
    // L-01 — rate limit. Without this, any extension page can hammer
    // updateFilterLists() which fetches up to 35MB of filter data and
    // calls syncDynamicRules() each time.
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
    sendResponse({ success: true });
  },

  CLEAR_BLOCKED_LOG: async (msg, sender, sendResponse) => {
    blockedLog = [];
    await chrome.storage.local.set({ blockedLog: [] });
    sendResponse({ success: true });
  },

  INJECT_SCRIPTLETS: async (msg, sender, sendResponse) => {
    // FIX #2 — allowlist-gated. buildScriptletCode returns null for
    // anything not in SCRIPTLET_ALLOWLIST.
    const claimedHost = String(msg.hostname || '').slice(0, 200);
    const tabId = sender.tab?.id;
    if (tabId == null) { sendResponse({ injected: 0 }); return; }

    // FIX #3 (defense in depth) — content script's claimed hostname must
    // match its actual tab URL. A compromised content script can't pretend
    // it's on a different site to trigger scriptlets meant for that site.
    const actualHost = safeSenderHostname(sender);
    if (!actualHost || actualHost !== claimedHost) {
      logError('inject:host-mismatch', `claimed=${claimedHost} actual=${actualHost}`);
      sendResponse({ injected: 0, error: 'host_mismatch' });
      return;
    }

    const rules = (engine.scriptletRules && engine.scriptletRules[claimedHost]) || [];
    const globalRules = (engine.scriptletRules && engine.scriptletRules['*']) || [];
    const allRules = [...globalRules, ...rules];

    let injected = 0;
    for (const r of allRules) {
      if (!isScriptletAllowed(r.name)) continue; // belt-and-braces
      const code = buildScriptletCode(r.name, r.args);
      if (!code) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
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
      } catch (e) { logError('injectScriptlet', e); }
    }
    sendResponse({ injected });
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
      if (code) codes.push(code);
    }
    sendResponse({ scriptlets: codes });
  },

  GET_PROCEDURAL_FILTERS: (msg, sender, sendResponse) => {
    const host = String(msg.hostname || '').slice(0, 200);
    const filters = [];
    if (engine.proceduralFilters) {
      for (const pf of engine.proceduralFilters) {
        if (!pf.host || pf.host === '' || host.includes(pf.host)) filters.push(pf.selector);
      }
    }
    sendResponse({ filters });
  },

  GET_DEBUG_INFO: (msg, sender, sendResponse) => {
    // I-02 — restrict to our own extension pages. This exposes filter
    // rule counts, error logs and uptime which help fingerprint Zenith's
    // exact version and which lists are active. Even though arbitrary
    // pages can't sendMessage to us directly, a compromised content
    // script could; this gates that route off.
    const ourOrigin = `chrome-extension://${chrome.runtime.id}/`;
    if (!sender.url || !sender.url.startsWith(ourOrigin)) {
      sendResponse({ error: 'forbidden' });
      return;
    }
    sendResponse({
      version: '2.0.7',
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

function updateBadge(tabId, count) {
  try {
    chrome.action.setBadgeText({ text: count > 999 ? '999+' : String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
  } catch (e) { logError('updateBadge', e); }
}

async function syncDynamicRules() {
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    const T = ['main_frame','sub_frame','stylesheet','script','image','font','xmlhttprequest','ping','media','other'];
    const rules = []; let id = 1000;
    for (const f of engine.networkFilters) {
      if (id >= 5999 || !f.pattern || f.pattern.length < 3) continue;
      rules.push({
        id: id++, priority: 1, action: { type: 'block' },
        condition: { urlFilter: f.pattern, resourceTypes: f.resourceTypes?.length ? f.resourceTypes : T },
      });
    }
    for (const f of engine.exceptions) {
      if (id >= 5999 || !f.pattern || f.pattern.length < 3) continue;
      rules.push({
        id: id++, priority: 2, action: { type: 'allow' },
        condition: { urlFilter: f.pattern, resourceTypes: T },
      });
    }
    const redirects = [
      { id: 9001, urlFilter: 'google-analytics.com/analytics.js', file: 'redirects/google-analytics.js' },
      { id: 9002, urlFilter: 'google-analytics.com/ga.js', file: 'redirects/google-analytics.js' },
      { id: 9003, urlFilter: 'googletagmanager.com/gtag/js', file: 'redirects/google-analytics.js' },
      { id: 9004, urlFilter: 'googletagservices.com/tag/js/gpt.js', file: 'redirects/googletagservices.js' },
      { id: 9005, urlFilter: 'connect.facebook.net/*/fbevents.js', file: 'redirects/fbevents.js' },
    ];
    for (const r of redirects) {
      rules.push({
        id: r.id, priority: 100,
        action: { type: 'redirect', redirect: { extensionPath: '/' + r.file } },
        condition: { urlFilter: r.urlFilter, resourceTypes: ['script'] },
      });
    }
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: old.map(r => r.id),
      addRules: rules.slice(0, 5000),
    });
  } catch (e) { logError('syncDynamicRules', e); }
}

async function updateFilterLists() {
  try {
    engine.networkFilters = [];
    engine.cosmeticFilters = [];
    engine.exceptions = [];

    // Default rules (bundled) — also sanitized for consistency, even though
    // they're not network-fetched.
    try {
      const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
      const { text } = sanitizeFilterList(await r.text());
      engine.parse(text);
    } catch (e) { logError('updateFilterLists:default', e); }

    // Remote lists — fetched via FilterListManager which already
    // sanitizes via sanitizeFilterList() in fetchList().
    const res = await filterListManager.updateAll();
    for (const x of res) {
      if (!x.success) continue;
      try {
        const t = await filterListManager.getCachedList(x.id);
        if (!t) continue;
        // Defense in depth — sanitize again even though it's pre-sanitized.
        const { text } = sanitizeFilterList(t);
        engine.parse(text);
      } catch (e) { logError(`updateFilterLists:parse:${x.id}`, e); }
    }
    await syncDynamicRules();
  } catch (e) { logError('updateFilterLists', e); }
}

async function init() {
  self.__zenithStart = Date.now();

  // Load default filters (sanitized)
  try {
    const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
    const { text } = sanitizeFilterList(await r.text());
    engine.parse(text);
  } catch (e) { logError('init:default-filters', e); }

  // Load cached remote lists (sanitized again — defense in depth)
  try {
    await filterListManager.init();
    for (const l of filterListManager.getEnabledLists()) {
      try {
        const c = await filterListManager.getCachedList(l.id);
        if (!c) continue;
        const { text } = sanitizeFilterList(c);
        engine.parse(text);
      } catch (e) { logError(`init:cached:${l.id}`, e); }
    }
  } catch (e) { logError('init:filterListManager', e); }

  // Restore session state
  try {
    const d = await chrome.storage.local.get(['enabled','whitelist','globalStats','blockedLog','stats','tabDoms','tabUrls']);
    if (d.enabled !== undefined) isEnabled = d.enabled;
    if (d.whitelist) whitelist = d.whitelist;
    if (d.globalStats) globalStats = d.globalStats;
    if (d.blockedLog && Array.isArray(d.blockedLog)) blockedLog = d.blockedLog;
    if (d.stats) stats = d.stats;
    if (d.tabDoms) tabDoms = d.tabDoms;
    if (d.tabUrls) tabUrls = d.tabUrls;
  } catch (e) { logError('init:restore-session', e); }

  // Reconcile sinceInstall from sync (handles browser-data-clear)
  try {
    const local = await chrome.storage.local.get('sinceInstall');
    const sync  = await chrome.storage.sync.get('sinceInstall');
    const localSI = local.sinceInstall || { totalBlocked: 0, installDate: null };
    const syncSI  = sync.sinceInstall  || { totalBlocked: 0, installDate: null };
    if (syncSI.totalBlocked > localSI.totalBlocked) {
      await chrome.storage.local.set({ sinceInstall: syncSI });
      globalStats.totalBlocked = Math.max(globalStats.totalBlocked, syncSI.totalBlocked);
    }
    if (!localSI.installDate && syncSI.installDate) {
      await chrome.storage.local.set({ sinceInstall: { ...localSI, installDate: syncSI.installDate } });
    }
  } catch (e) { logError('init:sinceInstall-reconcile', e); }

  try { await trackerLearner.load(); } catch (e) { logError('init:trackerLearner.load', e); }
  await syncDynamicRules();

  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (stats[t.id] > 0) updateBadge(t.id, stats[t.id]);
  } catch (e) { logError('init:badge-restore', e); }

  initDone = true;
  console.log(`[Zenith] v1.3.1 ready — network:${engine.networkFilters.length} cosmetic:${engine.cosmeticFilters.length}`);
}

init();
