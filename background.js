/**
 * Zenith AdBlocker — Chrome Background (MV3)
 * by roshanxcvi
 *
 * v1.3.3 AUDIT FIXES
 * Security:
 * - Messages are deny-by-default (see security.js validateSender): content
 *   scripts can only send the few types content.js uses.
 * - chrome.storage.local/sync are locked to extension pages and this
 *   worker, so a content script can't rewrite settings, the allowlist or
 *   filter-list state behind the message checks.
 * - content.js no longer reads storage: GET_STATE returns its settings and
 *   a per-site fingerprint seed derived here from the browser-reported
 *   origin (the raw install seed never leaves the worker).
 * - Scriptlets run as real functions via executeScript({ func, args }) with
 *   validated arguments (see scriptlets.js). No code strings, works on sites
 *   with a strict Content-Security-Policy.
 * - Cosmetic CSS is applied with scripting.insertCSS (INSERT_CSS), so pages
 *   can't see or delete it.
 * - Remote filter lists are parsed with their own policy (no scriptlets; only
 *   EasyList-family lists may add exceptions).
 * Bugs that users would hit:
 * - The on/off switch, "Allow" on a site, and per-site "disabled" now also
 *   stop network blocking (DNR allowAllRequests rules). Before, they only
 *   stopped cosmetic hiding while every request was still blocked.
 * - Dynamic rules no longer block main_frame, so clicking a link to a
 *   listed domain (affiliate links, company homepages) isn't blocked.
 * - Redirect stubs and allow rules are always installed; before they were
 *   the last rules added and got cut off by the 5,000-rule slice.
 * - Alarms are only created if missing. Recreating them on every worker
 *   start reset the 24 h timer, so filter lists never auto-updated.
 * - Lists are parsed into a fresh engine and swapped in, so scriptlets and
 *   procedural filters don't pile up and pages loaded mid-update still get
 *   filters.
 * - Blocked requests are counted with webRequest.onErrorOccurred
 *   (net::ERR_BLOCKED_BY_CLIENT), which fires in the Chrome Web Store
 *   (packed) build too. The old onRuleMatchedDebug event is unpacked-only,
 *   so it could never populate stats in the published build. This is
 *   observe-only: no webRequestBlocking, no request is modified here.
 * - Blocked-count writes are batched; storage.sync was written on every
 *   blocked request and would hit its per-minute write quota.
 */

import { FilterEngine } from './rules/filter-engine.js';
import { TrackerLearner } from './modules/tracker-learner.js';
import { FilterListManager, getListPolicy } from './modules/filter-list-manager.js';
import { prepareScriptlet } from './modules/scriptlets.js';
import { RULE_CATEGORIES, normalizeRuleCategorySettings } from './rules/rule-categories.js';
import {
  validateSender,
  isExtensionPageSender,
  safeHostname,
  safeSenderHostname,
  sanitizeFilterList,
  domainMatches,
  logError,
} from './modules/security.js';

const chromeApi = globalThis.chrome?.runtime ? globalThis.chrome : globalThis.browser;

if (!chromeApi?.runtime?.onInstalled) {
  throw new Error('[Zenith] Chrome extension runtime API unavailable. Load this file only through chrome://extensions as the MV3 service worker.');
}

const chrome = chromeApi;
const VERSION = chrome.runtime.getManifest().version;

// Lock storage to extension pages + this worker (content scripts get their
// settings through GET_STATE instead).
for (const area of [chrome.storage.local, chrome.storage.sync]) {
  try {
    area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.((e) => logError('setAccessLevel', e));
  } catch (e) {
    logError('setAccessLevel', e);
  }
}

let engine = new FilterEngine();
const trackerLearner = new TrackerLearner();
const filterListManager = new FilterListManager();

// webRequest.onErrorOccurred fires in packed builds, so blocked-request
// stats (counts, top domains, live feed) work in the Chrome Web Store
// build — unlike onRuleMatchedDebug, which is unpacked-only.
const hasWebRequest = !!(chrome.webRequest && chrome.webRequest.onErrorOccurred);

let isEnabled = true;
let stats = {};
let whitelist = [];
let globalStats = { totalBlocked: 0, perSite: {} };
let blockedLog = [];
const MAX_LOG = 500;
let tabDoms = {};
let tabUrls = {};
let initDone = false;
let pendingBlocked = 0;
let packagedCosmetic = { global: [], siteSpecific: {} };

const recentBlocks = Object.create(null);
const DEDUP_MAX_PER_TAB = 1000;

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

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
  if (!dirty && !pendingBlocked) return;
  dirty = false;
  const add = pendingBlocked;
  pendingBlocked = 0;

  try {
    const toWrite = {
      stats,
      tabDoms,
      tabUrls,
      globalStats,
      blockedLog: blockedLog.slice(0, MAX_LOG),
      lastSave: Date.now(),
    };

    if (add > 0) {
      const { sinceInstall } = await chrome.storage.local.get('sinceInstall');
      const si = sinceInstall || { totalBlocked: 0, installDate: null };
      si.totalBlocked = (si.totalBlocked || 0) + add;
      toWrite.sinceInstall = si;
      chrome.storage.sync.set({ sinceInstall: si }).catch((e) => logError('sync-write', e));
    }

    await chrome.storage.local.set(toWrite);
  } catch (e) {
    logError('flushIfDirty', e);
    dirty = true;
    pendingBlocked += add;
  }
}

function incrementBlockedCount(count) {
  pendingBlocked += count;
  globalStats.totalBlocked = (globalStats.totalBlocked || 0) + count;
  markDirty();
}

// ════════════════════════════════════════════════════════════════
// Top-level listeners
// ════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: 'block-element',
      title: 'Block this element',
      contexts: ['all'],
    }, () => void chrome.runtime.lastError);
  });

  if (details.reason === 'install') {
    const seed = {
      totalBlocked: 0,
      installDate: new Date().toISOString(),
    };

    chrome.storage.local.set({ sinceInstall: seed }).catch((e) => logError('install-seed-local', e));
    chrome.storage.sync.set({ sinceInstall: seed }).catch((e) => logError('install-seed-sync', e));

    chrome.storage.local.get('ruleCategories').then((stored) => {
      chrome.storage.local.set({
        ruleCategories: normalizeRuleCategorySettings(stored.ruleCategories || {}),
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
    sendResponse({ error: 'forbidden' });
    return false;
  }

  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, type) ? HANDLERS[type] : null;

  if (!handler) {
    sendResponse({ error: 'unknown_message_type' });
    return false;
  }

  try {
    const result = handler(msg, sender, sendResponse);

    if (result && typeof result.then === 'function') {
      result.catch((e) => {
        logError(`handler:${type}`, e);
        try { sendResponse({ error: 'handler_threw' }); } catch (_) {}
      });
      return true;
    }

    return result === true;
  } catch (e) {
    logError(`handler:${type}:sync`, e);
    try { sendResponse({ error: 'handler_threw' }); } catch (_) {}
    return false;
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-element' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'PICK_ELEMENT' }).catch((e) => logError('pick-element-send', e));
  }
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;

  const h = safeHostname(d.url);
  if (h) tabUrls[d.tabId] = h;

  stats[d.tabId] = 0;
  tabDoms[d.tabId] = Object.create(null);
  recentBlocks[d.tabId] = Object.create(null);

  updateBadge(d.tabId, 0);
  markDirty();
});

chrome.tabs.onRemoved.addListener((id) => {
  cleanupDeadTab(id);
});

// Create alarms only if missing: re-creating resets their timers, and the
// worker restarts far more often than every 24 h.
async function ensureAlarm(name, periodInMinutes) {
  try {
    const existing = await chrome.alarms.get(name);
    if (!existing || existing.periodInMinutes !== periodInMinutes) {
      await chrome.alarms.create(name, { periodInMinutes });
    }
  } catch (e) {
    logError(`alarm:${name}`, e);
  }
}
ensureAlarm('autoSave', 1);
ensureAlarm('updateFilters', 1440);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoSave') flushIfDirty();
  if (a.name === 'updateFilters') updateFilterLists();
});

// Badge shows our own per-tab blocked count, maintained from
// webRequest.onErrorOccurred below (works in packed + unpacked builds).

// ════════════════════════════════════════════════════════════════
// Dedup helpers
// ════════════════════════════════════════════════════════════════

function shouldDedupLifetime(tabId, url) {
  if (!url) return false;

  let tabMap = recentBlocks[tabId];
  if (!tabMap) tabMap = recentBlocks[tabId] = Object.create(null);

  if (tabMap[url]) return true;
  tabMap[url] = Date.now();

  const keys = Object.keys(tabMap);
  if (keys.length > DEDUP_MAX_PER_TAB) {
    keys.sort((a, b) => tabMap[a] - tabMap[b]);
    for (let i = 0; i < keys.length - DEDUP_MAX_PER_TAB; i++) delete tabMap[keys[i]];
  }
  return false;
}

function bumpDomain(tabId, host, count, type) {
  if (!tabDoms[tabId]) tabDoms[tabId] = Object.create(null);
  const map = tabDoms[tabId];
  if (!own(map, host)) map[host] = { count: 0, type };
  map[host].count += count;
}

function bumpSite(host, count) {
  const per = globalStats.perSite;
  per[host] = (own(per, host) ? per[host] : 0) + count;
}

// Blocked-request accounting (works in packed + unpacked builds).
// A request blocked by our declarativeNetRequest rules fails with
// net::ERR_BLOCKED_BY_CLIENT; we observe that here. This is observe-only —
// no webRequestBlocking, nothing is modified or read beyond the URL we
// already chose to block. Everything is counted and stored locally.
try {
  if (hasWebRequest) {
    chrome.webRequest.onErrorOccurred.addListener(
      (info) => {
        // Only our client-side blocks — not timeouts, DNS failures or aborts.
        if (info.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
        if (!Number.isInteger(info.tabId) || info.tabId < 0) return;
        // Our rules never block main_frame (top-level navigation); ignore
        // any stray top-level failure so it can't inflate the counts.
        if (info.type === 'main_frame') return;

        const tabId = info.tabId;
        const url = info.url || '';

        stats[tabId] = (stats[tabId] || 0) + 1;
        updateBadge(tabId, stats[tabId]);

        const isRefreshDup = shouldDedupLifetime(tabId, url);
        const h = safeHostname(url);

        if (h) {
          if (!isRefreshDup) bumpSite(h, 1);
          bumpDomain(tabId, h, 1, info.type || 'other');

          blockedLog.unshift({
            url: sanitizeLogUrl(url),
            domain: h,
            type: info.type || 'other',
            timestamp: Date.now(),
            tabId,
          });
          if (blockedLog.length > MAX_LOG) blockedLog.length = MAX_LOG;

          const src = safeHostname(info.initiator);
          if (src && src !== h) {
            try { trackerLearner.recordSighting(h, src); } catch (e) { logError('learner:onErrorOccurred', e); }
          }
        }

        if (!isRefreshDup) incrementBlockedCount(1);
        markDirty();
      },
      { urls: ['<all_urls>'] }
    );
  }
} catch (e) {
  logError('register:onErrorOccurred', e);
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
    if (!value) return null;
    if (value.startsWith('http://') || value.startsWith('https://')) value = new URL(value).hostname;
    value = value.replace(/^www\./, '');
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(value)) return null;
    return value;
  } catch (error) {
    return null;
  }
}

let lastFilterUpdate = 0;
const FILTER_UPDATE_MIN_INTERVAL = 60_000;

function isHostWhitelisted(hostname) {
  if (!hostname) return false;
  return whitelist.some((domain) => domainMatches(hostname, domain));
}

async function loadState() {
  const stored = await chrome.storage.local.get(['whitelist', 'enabled']);
  whitelist = Array.isArray(stored.whitelist) ? stored.whitelist : [];
  isEnabled = stored.enabled !== undefined ? stored.enabled : true;
}

async function getSiteSettingsFor(hostname) {
  const siteKey = getSiteKeyFromHostname(hostname);
  if (!siteKey) return normalizeSiteSettings({});
  const stored = await chrome.storage.local.get('siteSettings');
  const all = stored.siteSettings || {};
  return normalizeSiteSettings(own(all, siteKey) ? all[siteKey] : {});
}

const DEFAULT_PRO_SETTINGS = Object.freeze({
  adBlocking: true,
  fingerprintProtection: true,
  cookieAutoReject: true,
  annoyanceBlocking: true,
  minerBlocking: true,
  antiAdblock: true,
});

// Per-site fingerprint seed: HMAC(install seed, origin). The origin comes
// from the browser (sender.origin), not from the page.
async function getSiteFingerprintSeed(origin) {
  if (!origin || origin === 'null') return null;
  let { zenithFpSeed: seed } = await chrome.storage.local.get('zenithFpSeed');
  if (!seed) {
    const a = new Uint32Array(4);
    crypto.getRandomValues(a);
    seed = Array.from(a, (n) => n.toString(36)).join('');
    await chrome.storage.local.set({ zenithFpSeed: seed });
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(origin));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function senderOrigin(sender) {
  if (sender.origin) return sender.origin;
  try { return new URL(sender.url).origin; } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════════════
// Allow rules: global pause, allowlisted sites, sites set to disabled
// ════════════════════════════════════════════════════════════════

const RULE_ID_PAUSE_ALL = 1;
const RULE_ID_ALLOWLIST = 2;
const ALLOW_PRIORITY = 10000;   // above redirects (100) and blocks (1–2)

async function buildAllowRules() {
  await loadState();
  const rules = [];

  if (!isEnabled) {
    rules.push({
      id: RULE_ID_PAUSE_ALL,
      priority: ALLOW_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }

  const { siteSettings = {} } = await chrome.storage.local.get('siteSettings');
  const domains = new Set();
  for (const d of whitelist) {
    const key = getSiteKeyFromHostname(d);
    if (key) domains.add(key);
  }
  for (const [site, s] of Object.entries(siteSettings)) {
    if (s && s.enabled === false) {
      const key = getSiteKeyFromHostname(site);
      if (key) domains.add(key);
    }
  }
  if (domains.size) {
    rules.push({
      id: RULE_ID_ALLOWLIST,
      priority: ALLOW_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [...domains], resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  return rules;
}

// All dynamic-rule updates go through one queue: two overlapping updates
// can each read the old rule list and then collide on the same ids.
let dnrQueue = Promise.resolve();
function queueDnr(task) {
  const run = dnrQueue.then(task, task);
  dnrQueue = run.catch(() => {});
  return run;
}

function refreshAllowRules() {
  return queueDnr(doRefreshAllowRules);
}

async function doRefreshAllowRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID_PAUSE_ALL, RULE_ID_ALLOWLIST],
      addRules: await buildAllowRules(),
    });
  } catch (e) {
    logError('refreshAllowRules', e);
  }
}

function scriptletRulesFor(host) {
  const rules = engine.scriptletRules || {};
  const out = [];
  const seen = new Set();
  const add = (list) => {
    for (const r of list || []) {
      const k = r.name + '\u0000' + r.args.join('\u0000');
      if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
  };
  add(own(rules, '*') ? rules['*'] : null);
  for (const key of Object.keys(rules)) {
    if (key !== '*' && domainMatches(host, key)) add(rules[key]);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Message handlers
// Content scripts may only call the types in CONTENT_SCRIPT_MESSAGES
// (security.js); every other handler is extension pages only.
// ════════════════════════════════════════════════════════════════

const HANDLERS = {
  // ── Content-script handlers ─────────────────────────────────────

  GET_STATE: async (msg, sender, sendResponse) => {
    await loadState();

    if (isExtensionPageSender(sender)) {
      sendResponse({
        enabled: isEnabled,
        blockedCount: stats[sender.tab?.id] || 0,
        totalBlocked: globalStats.totalBlocked,
        whitelist,
      });
      return;
    }

    const host = safeSenderHostname(sender);
    const whitelisted = isHostWhitelisted(host);
    const siteSettings = await getSiteSettingsFor(host);
    const { proSettings } = await chrome.storage.local.get('proSettings');
    const active = isEnabled && !whitelisted && siteSettings.enabled !== false;

    let fpSeed = null;
    if (active) {
      try { fpSeed = await getSiteFingerprintSeed(senderOrigin(sender)); } catch (e) { logError('fpSeed', e); }
    }

    sendResponse({
      enabled: isEnabled,
      whitelisted,
      siteSettings,
      proSettings: { ...DEFAULT_PRO_SETTINGS, ...(proSettings || {}) },
      fpSeed,
    });
  },

  GET_COSMETIC_FILTERS: (msg, sender, sendResponse) => {
    const host = safeSenderHostname(sender) || clampStr(msg.hostname);
    const selectors = engine.getCosmeticSelectors(host);
    selectors.push(...packagedCosmetic.global);
    for (const [domain, list] of Object.entries(packagedCosmetic.siteSpecific)) {
      if (domainMatches(host, domain) && Array.isArray(list)) selectors.push(...list);
    }
    sendResponse({ selectors });
  },

  GET_PROCEDURAL_FILTERS: (msg, sender, sendResponse) => {
    const host = safeSenderHostname(sender) || clampStr(msg.hostname);
    const filters = [];
    for (const pf of engine.proceduralFilters || []) {
      if (!pf.host) filters.push(pf.selector);
      else if (!pf.host.startsWith('~') && domainMatches(host, pf.host)) filters.push(pf.selector);
    }
    sendResponse({ filters });
  },

  INJECT_SCRIPTLETS: async (msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    const actualHost = safeSenderHostname(sender);

    if (tabId == null || !actualHost) {
      sendResponse({ injected: 0 });
      return;
    }

    const claimedHost = clampStr(msg.hostname);
    if (claimedHost && claimedHost !== actualHost) {
      logError('inject:host-mismatch', `claimed=${claimedHost} actual=${actualHost}`);
      sendResponse({ injected: 0, error: 'host_mismatch' });
      return;
    }

    await loadState();
    const siteSettings = await getSiteSettingsFor(actualHost);
    if (!isEnabled || isHostWhitelisted(actualHost) || !siteSettings.enabled || !siteSettings.ads) {
      sendResponse({ injected: 0 });
      return;
    }

    let injected = 0;
    for (const r of scriptletRulesFor(actualHost)) {
      const prepared = prepareScriptlet(r.name, r.args);
      if (!prepared) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [sender.frameId ?? 0] },
          world: 'MAIN',
          injectImmediately: true,
          func: prepared.func,
          args: prepared.args,
        });
        injected++;
      } catch (e) {
        logError('injectScriptlet', e);
      }
    }

    sendResponse({ injected });
  },

  // Cosmetic CSS as a user stylesheet: invisible to the page and can't be
  // removed by it (a <style id="zenith-hide"> could be found and deleted).
  INSERT_CSS: async (msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    const css = typeof msg.css === 'string' ? msg.css : '';
    if (tabId == null || !css || css.length > 4_000_000) {
      sendResponse({ ok: false });
      return;
    }
    try {
      await chrome.scripting.insertCSS({
        target: { tabId, frameIds: [sender.frameId ?? 0] },
        css,
        origin: 'USER',
      });
      sendResponse({ ok: true });
    } catch (e) {
      logError('insertCSS', e);
      sendResponse({ ok: false });
    }
  },

  REPORT_BLOCKED: (msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return;
    }

    const raw = parseInt(msg.count, 10);
    const count = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 1;

    stats[tabId] = (stats[tabId] || 0) + count;
    updateBadge(tabId, stats[tabId]);

    const h = safeSenderHostname(sender);
    if (h) {
      bumpDomain(tabId, h, count, 'cosmetic');
      if (!shouldDedupLifetime(tabId, 'cosmetic:' + h)) {
        bumpSite(h, count);
        incrementBlockedCount(count);
      }
    }

    markDirty();
    sendResponse({ ok: true });
  },

  // ── Extension-page handlers ─────────────────────────────────────

  GET_SITE_SETTINGS: async (msg, sender, sendResponse) => {
    const siteKey = getSiteKeyFromHostname(msg.hostname);
    if (!siteKey) {
      sendResponse({ success: false, error: 'invalid_site' });
      return;
    }
    sendResponse({ success: true, hostname: siteKey, settings: await getSiteSettingsFor(siteKey) });
  },

  SET_SITE_SETTINGS: async (msg, sender, sendResponse) => {
    const siteKey = getSiteKeyFromHostname(msg.hostname);
    if (!siteKey) {
      sendResponse({ success: false, error: 'invalid_site' });
      return;
    }

    const stored = await chrome.storage.local.get('siteSettings');
    const allSettings = stored.siteSettings || {};
    allSettings[siteKey] = normalizeSiteSettings(msg.settings || {});
    await chrome.storage.local.set({ siteSettings: allSettings });
    await refreshAllowRules();

    sendResponse({ success: true, hostname: siteKey, settings: allSettings[siteKey] });
  },

  GET_FILTER_LISTS: async (msg, sender, sendResponse) => {
    if (!filterListManager.initialized) await filterListManager.init();
    sendResponse({
      success: true,
      lists: filterListManager.getAllLists(),
      stats: filterListManager.getStats(),
    });
  },

  SET_FILTER_LIST_ENABLED: async (msg, sender, sendResponse) => {
    if (!filterListManager.initialized) await filterListManager.init();

    const id = String(msg.id || '').trim();
    const enabled = msg.enabled === true;

    if (!filterListManager.getAllLists().some((list) => list.id === id)) {
      sendResponse({ success: false, error: 'invalid_filter_list' });
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
  },

  CLEAR_FILTER_CACHE: async (msg, sender, sendResponse) => {
    if (!filterListManager.initialized) await filterListManager.init();
    const ok = await filterListManager.clearCache();
    await updateFilterLists();
    sendResponse({
      success: ok,
      lists: filterListManager.getAllLists(),
      stats: filterListManager.getStats(),
    });
  },

  GET_RULE_CATEGORIES: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get('ruleCategories');
    sendResponse({
      success: true,
      categories: RULE_CATEGORIES,
      settings: normalizeRuleCategorySettings(stored.ruleCategories || {}),
    });
  },

  SET_RULE_CATEGORY: async (msg, sender, sendResponse) => {
    const category = String(msg.category || '').trim();
    const enabled = msg.enabled === true;

    if (!Object.prototype.hasOwnProperty.call(RULE_CATEGORIES, category)) {
      sendResponse({ success: false, error: 'invalid_category', available: Object.keys(RULE_CATEGORIES) });
      return;
    }

    const stored = await chrome.storage.local.get('ruleCategories');
    const settings = normalizeRuleCategorySettings(stored.ruleCategories || {});
    settings[category] = enabled;
    await chrome.storage.local.set({ ruleCategories: settings });

    sendResponse({ success: true, category, enabled, settings });
  },

  CHECK_URL: (msg, sender, sendResponse) => {
    const url = clampStr(msg.url, 2048);
    const src = clampStr(msg.sourceUrl, 2048);
    const rt = clampStr(msg.resourceType, 32);
    sendResponse({ blocked: isEnabled && engine.shouldBlock(url, src, rt) });
  },

  GET_TAB_STATS: (msg, sender, sendResponse) => {
    const tabId = msg.tabId;
    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[tabId] || 0,
      totalBlocked: globalStats.totalBlocked,
      whitelist,
    });
  },

  GET_POPUP_OVERVIEW: async (msg, sender, sendResponse) => {
    const tabId = msg.tabId;
    const stored = await chrome.storage.local.get(['sinceInstall', 'whitelist', 'enabled']);
    const si = { ...(stored.sinceInstall || { totalBlocked: 0, installDate: null }) };
    si.totalBlocked = (si.totalBlocked || 0) + pendingBlocked;

    whitelist = Array.isArray(stored.whitelist) ? stored.whitelist : [];
    if (stored.enabled !== undefined) isEnabled = stored.enabled;

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
      detailedStats: hasWebRequest,
    });
  },

  TOGGLE: async (msg, sender, sendResponse) => {
    await loadState();
    isEnabled = !isEnabled;
    await chrome.storage.local.set({ enabled: isEnabled });
    await refreshAllowRules();
    sendResponse({ enabled: isEnabled });
  },

  ADD_WHITELIST: async (msg, sender, sendResponse) => {
    const stored = await chrome.storage.local.get('whitelist');
    const wl = Array.isArray(stored.whitelist) ? stored.whitelist : [];
    const d = getSiteKeyFromHostname(msg.domain);

    if (!d) {
      sendResponse({ whitelist: wl, error: 'invalid_domain' });
      return;
    }

    if (!wl.includes(d)) wl.push(d);
    await chrome.storage.local.set({ whitelist: wl });
    whitelist = wl;
    await refreshAllowRules();

    sendResponse({ whitelist: wl });
  },

  REMOVE_WHITELIST: async (msg, sender, sendResponse) => {
    const raw = String(msg.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (!raw) {
      sendResponse({ whitelist, error: 'empty_domain' });
      return;
    }
    const key = getSiteKeyFromHostname(raw) || raw;

    const stored = await chrome.storage.local.get('whitelist');
    const wl = (stored.whitelist || []).filter((d) => d !== raw && d !== key);
    await chrome.storage.local.set({ whitelist: wl });
    whitelist = wl;
    await refreshAllowRules();

    sendResponse({ whitelist: wl });
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
    if (!filterListManager.initialized) await filterListManager.init();

    const stored = await chrome.storage.local.get(['sinceInstall', 'whitelist', 'proSettings']);
    const si = { ...(stored.sinceInstall || { totalBlocked: 0, installDate: null }) };
    si.totalBlocked = (si.totalBlocked || 0) + pendingBlocked;
    whitelist = Array.isArray(stored.whitelist) ? stored.whitelist : [];

    const top = Object.entries(globalStats.perSite).sort((a, b) => b[1] - a[1]).slice(0, 50);

    const cats = {};
    for (const e of blockedLog) {
      const d = e.domain || '';
      let c = 'Other';
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
      filterLists: filterListManager.getAllLists(),
      proSettings: { ...DEFAULT_PRO_SETTINGS, ...(stored.proSettings || {}) },
      detailedStats: hasWebRequest,
    });
  },

  GET_PRO_SETTINGS: async (msg, sender, sendResponse) => {
    const d = await chrome.storage.local.get('proSettings');
    sendResponse(d.proSettings || { ...DEFAULT_PRO_SETTINGS });
  },

  SET_PRO_SETTINGS: async (msg, sender, sendResponse) => {
    const incoming = (msg && typeof msg.settings === 'object' && msg.settings) || {};
    const safe = {};
    for (const k of Object.keys(DEFAULT_PRO_SETTINGS)) {
      if (k in incoming && typeof incoming[k] === 'boolean') safe[k] = incoming[k];
    }
    await chrome.storage.local.set({ proSettings: safe });
    sendResponse({ success: true, settings: safe });
  },

  ALLOW_LEARNED_TRACKER: (msg, sender, sendResponse) => {
    const d = getSiteKeyFromHostname(msg.domain);
    if (!d) {
      sendResponse({ success: false, error: 'invalid_domain' });
      return;
    }
    trackerLearner.allowDomain(d);
    sendResponse({ success: true });
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
    await chrome.storage.local.set({ blockedLog: [] });
    sendResponse({ success: true });
  },

  // Returns rule data only (no code), for the dashboard.
  GET_SCRIPTLETS: (msg, sender, sendResponse) => {
    const host = clampStr(msg.hostname);
    sendResponse({
      scriptlets: scriptletRulesFor(host)
        .filter((r) => prepareScriptlet(r.name, r.args))
        .map((r) => ({ name: r.name, args: r.args })),
    });
  },

  GET_DEBUG_INFO: (msg, sender, sendResponse) => {
    sendResponse({
      version: VERSION,
      initDone,
      networkRules: engine.networkFilters.length,
      cosmeticRules: engine.cosmeticFilters.length,
      scriptletRuleHosts: Object.keys(engine.scriptletRules || {}).length,
      errorCount: self.__zenithErrorCount || 0,
      lastError: self.__zenithLastError || null,
      uptime: Date.now() - (self.__zenithStart || Date.now()),
      detailedStats: hasWebRequest,
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
  if (!Number.isInteger(tabId)) return;
  delete stats[tabId];
  delete tabDoms[tabId];
  delete tabUrls[tabId];
  delete recentBlocks[tabId];
  markDirty();
}

// Per-tab blocked count on the toolbar badge, from webRequest observations
// (available in packed + unpacked builds).
function updateBadge(tabId, count) {
  if (!hasWebRequest) return;
  if (!Number.isInteger(tabId) || tabId < 0) return;

  const text = count > 999 ? '999+' : String(count);

  chrome.action.setBadgeText({ text, tabId }).catch((error) => {
    if (isMissingTabError(error)) { cleanupDeadTab(tabId); return; }
    logError('updateBadge:setBadgeText', error);
  });

  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId }).catch((error) => {
    if (isMissingTabError(error)) { cleanupDeadTab(tabId); return; }
    logError('updateBadge:setBadgeBackgroundColor', error);
  });
}

// ════════════════════════════════════════════════════════════════
// Dynamic DNR rules
// ════════════════════════════════════════════════════════════════

// No main_frame: blocking top-level navigation broke clicked links (affiliate
// links, company homepages) with no way through.
const DEFAULT_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

const MAX_DYNAMIC_RULES = 5000;   // Chrome 110–120 limit for dynamic rules
const MAX_EXCEPTION_RULES = 1000;
const REDIRECT_RULES = [
  { id: 9001, urlFilter: '||google-analytics.com/analytics.js', file: 'redirects/google-analytics.js' },
  { id: 9002, urlFilter: '||google-analytics.com/ga.js', file: 'redirects/google-analytics.js' },
  { id: 9003, urlFilter: '||googletagmanager.com/gtag/js', file: 'redirects/google-analytics.js' },
  { id: 9004, urlFilter: '||googletagservices.com/tag/js/gpt.js', file: 'redirects/googletagservices.js' },
  { id: 9005, urlFilter: '||connect.facebook.net/*/fbevents.js', file: 'redirects/fbevents.js' },
];

// DNR urlFilter must be printable ASCII; skip real regex rules (/.../ with
// regex syntax) since DNR would treat them as literal text.
function usableUrlFilter(pattern) {
  if (!pattern || pattern.length < 3 || pattern.length > 1000) return false;
  if (!/^[\x21-\x7e]+$/.test(pattern)) return false;
  if (pattern.startsWith('||*') || pattern === '||' || pattern === '|') return false;
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/') && /[\\()[\]{}+?|]/.test(pattern.slice(1, -1))) return false;
  return true;
}

function toDnrCondition(f) {
  const condition = { urlFilter: f.pattern };
  if (f.resourceTypes?.length) condition.resourceTypes = [...new Set(f.resourceTypes)];
  else if (f.excludedResourceTypes?.length) condition.excludedResourceTypes = [...new Set([...f.excludedResourceTypes, 'main_frame'])];
  else condition.resourceTypes = DEFAULT_TYPES;
  if (f.domainType) condition.domainType = f.domainType;
  if (f.initiatorDomains?.length) condition.initiatorDomains = f.initiatorDomains;
  if (f.excludedInitiatorDomains?.length) condition.excludedInitiatorDomains = f.excludedInitiatorDomains;
  return condition;
}

function syncDynamicRules() {
  return queueDnr(doSyncDynamicRules);
}

async function doSyncDynamicRules() {
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();

    // Always-present rules first so the size cap can never drop them.
    const rules = [...await buildAllowRules()];
    for (const r of REDIRECT_RULES) {
      rules.push({
        id: r.id,
        priority: 100,
        action: { type: 'redirect', redirect: { extensionPath: '/' + r.file } },
        condition: { urlFilter: r.urlFilter, resourceTypes: ['script'] },
      });
    }

    const seen = new Set();
    let id = 10000;
    let exceptions = 0;
    for (const f of engine.exceptions) {
      if (exceptions >= MAX_EXCEPTION_RULES || rules.length >= MAX_DYNAMIC_RULES) break;
      if (!usableUrlFilter(f.pattern)) continue;
      const condition = toDnrCondition(f);
      const key = 'a' + JSON.stringify(condition);
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ id: id++, priority: 2, action: { type: 'allow' }, condition });
      exceptions++;
    }

    id = 20000;
    for (const f of engine.networkFilters) {
      if (rules.length >= MAX_DYNAMIC_RULES) break;
      if (!usableUrlFilter(f.pattern)) continue;
      const condition = toDnrCondition(f);
      const key = 'b' + JSON.stringify(condition);
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition });
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: old.map((r) => r.id),
      addRules: rules,
    });
  } catch (e) {
    logError('syncDynamicRules', e);
  }
}

// ════════════════════════════════════════════════════════════════
// Filter lists
// ════════════════════════════════════════════════════════════════

const BUNDLED_POLICY = Object.freeze({ allowScriptlets: true, allowExceptions: true, domainsOnly: false });

async function loadPackagedCosmetic() {
  try {
    const r = await fetch(chrome.runtime.getURL('rules/cosmetic-rules.json'));
    const rules = await r.json();
    packagedCosmetic = {
      global: Array.isArray(rules.global) ? rules.global.filter((s) => typeof s === 'string') : [],
      siteSpecific: rules.siteSpecific && typeof rules.siteSpecific === 'object' ? rules.siteSpecific : {},
    };
  } catch (e) {
    logError('loadPackagedCosmetic', e);
  }
}

async function parseBundled(target) {
  const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
  const { text } = sanitizeFilterList(await r.text(), BUNDLED_POLICY);
  target.parse(text);
}

let updating = null;
function updateFilterLists() {
  if (!updating) {
    updating = doUpdateFilterLists().finally(() => { updating = null; });
  }
  return updating;
}

// Build into a fresh engine, then swap: no empty window for pages loading
// during an update, and nothing is parsed twice.
async function doUpdateFilterLists() {
  try {
    const next = new FilterEngine();

    try { await parseBundled(next); } catch (e) { logError('updateFilterLists:default', e); }

    if (!filterListManager.initialized) await filterListManager.init();

    for (const list of filterListManager.getEnabledLists()) {
      try {
        const text = (await filterListManager.fetchList(list.id)) || (await filterListManager.getCachedList(list.id));
        if (!text) continue;
        next.parse(sanitizeFilterList(text, getListPolicy(list.id)).text);
      } catch (e) {
        logError(`updateFilterLists:parse:${list.id}`, e);
      }
    }

    engine = next;
    await syncDynamicRules();
  } catch (e) {
    logError('updateFilterLists', e);
  }
}

async function init() {
  self.__zenithStart = Date.now();

  const next = new FilterEngine();
  try { await parseBundled(next); } catch (e) { logError('init:default-filters', e); }
  await loadPackagedCosmetic();

  try {
    await filterListManager.init();
    for (const l of filterListManager.getEnabledLists()) {
      try {
        const c = await filterListManager.getCachedList(l.id);
        if (c) next.parse(sanitizeFilterList(c, getListPolicy(l.id)).text);
      } catch (e) {
        logError(`init:cached:${l.id}`, e);
      }
    }
  } catch (e) {
    logError('init:filterListManager', e);
  }
  engine = next;

  try {
    const d = await chrome.storage.local.get(['enabled', 'whitelist', 'globalStats', 'blockedLog', 'stats', 'tabDoms', 'tabUrls']);
    if (d.enabled !== undefined) isEnabled = d.enabled;
    if (Array.isArray(d.whitelist)) whitelist = d.whitelist;
    if (d.globalStats && typeof d.globalStats === 'object') {
      globalStats = { totalBlocked: d.globalStats.totalBlocked || 0, perSite: d.globalStats.perSite || {} };
    }
    if (Array.isArray(d.blockedLog)) blockedLog = d.blockedLog;
    if (d.stats) stats = d.stats;
    if (d.tabDoms) tabDoms = d.tabDoms;
    if (d.tabUrls) tabUrls = d.tabUrls;
  } catch (e) {
    logError('init:restore-session', e);
  }

  try {
    const local = await chrome.storage.local.get('sinceInstall');
    const sync = await chrome.storage.sync.get('sinceInstall');
    const localSI = local.sinceInstall || { totalBlocked: 0, installDate: null };
    const syncSI = sync.sinceInstall || { totalBlocked: 0, installDate: null };

    if (syncSI.totalBlocked > localSI.totalBlocked) {
      await chrome.storage.local.set({ sinceInstall: syncSI });
      globalStats.totalBlocked = Math.max(globalStats.totalBlocked, syncSI.totalBlocked);
    }
    if (!localSI.installDate && syncSI.installDate) {
      await chrome.storage.local.set({ sinceInstall: { ...localSI, installDate: syncSI.installDate } });
    }
  } catch (e) {
    logError('init:sinceInstall-reconcile', e);
  }

  try { await trackerLearner.load(); } catch (e) { logError('init:trackerLearner.load', e); }

  // Dynamic rules survive worker restarts; only rebuild when they're missing
  // (first run) or the extension was updated.
  try {
    const { rulesVersion } = await chrome.storage.local.get('rulesVersion');
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (rulesVersion !== VERSION || !existing.some((r) => r.id === 9001)) {
      await syncDynamicRules();
      await chrome.storage.local.set({ rulesVersion: VERSION });
    } else {
      await refreshAllowRules();
    }
  } catch (e) {
    logError('init:dynamic-rules', e);
  }

  if (hasWebRequest) {
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (stats[t.id] > 0) updateBadge(t.id, stats[t.id]);
    } catch (e) {
      logError('init:badge-restore', e);
    }
  }

  initDone = true;
  console.log(`[Zenith] v${VERSION} ready — network:${engine.networkFilters.length} cosmetic:${engine.cosmeticFilters.length}`);
}

init();
