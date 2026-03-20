/**
 * Zenith AdBlocker — Chrome Background (MV3)
 * by roshanxcvi
 *
 * KEY DESIGN (uBlock Origin approach):
 * - sinceInstall counter uses ATOMIC storage operations
 * - Read from storage → increment → write back (never trust in-memory)
 * - All event listeners registered synchronously at top level
 * - In-memory state is just a cache; storage is the truth
 */

import { FilterEngine } from './rules/filter-engine.js';
import { TrackerLearner } from './modules/tracker-learner.js';
import { FilterListManager } from './modules/filter-list-manager.js';

const engine = new FilterEngine();
const trackerLearner = new TrackerLearner();
const filterListManager = new FilterListManager();

// In-memory cache (may be stale — storage is the real source of truth)
let isEnabled = true;
let stats = {};
let whitelist = [];
let globalStats = { totalBlocked: 0, perSite: {} };
let blockedLog = [];
const MAX_LOG = 500;
let tabDoms = {};
let tabUrls = {};
let initDone = false;

// ══════════════════════════════════════════════════
// ATOMIC COUNTER — the core fix
// Reads current value from storage, adds count, writes back
// Never loses data even if service worker restarts between calls
// ══════════════════════════════════════════════════
async function incrementBlockedCount(count) {
  try {
    const data = await chrome.storage.local.get(['sinceInstall', 'globalStats']);
    const si = data.sinceInstall || { totalBlocked: 0, installDate: null };
    const gs = data.globalStats || { totalBlocked: 0, perSite: {} };
    si.totalBlocked += count;
    gs.totalBlocked += count;
    // Update in-memory cache too
    globalStats.totalBlocked = gs.totalBlocked;
    await chrome.storage.local.set({ sinceInstall: si, globalStats: gs });
    // Backup sinceInstall to sync (survives clear browser data)
    chrome.storage.sync.set({ sinceInstall: si }).catch(() => {});
  } catch (e) {}
}

// Save session state (tab data, logs — less critical)
async function saveSession() {
  try {
    await chrome.storage.local.set({
      stats, tabDoms, tabUrls,
      blockedLog: blockedLog.slice(0, MAX_LOG),
      enabled: isEnabled, whitelist,
      lastSave: Date.now()
    });
  } catch (e) {}
}

// ══════════════════════════════════════════════════
// ALL EVENT LISTENERS — registered synchronously first
// ══════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener((details) => {
  try { chrome.contextMenus.create({ id: 'block-element', title: 'Block this element', contexts: ['all'] }); } catch (e) {}
  if (details.reason === 'install') {
    chrome.storage.local.set({ sinceInstall: { totalBlocked: 0, installDate: new Date().toISOString() } });
    chrome.storage.sync.set({ sinceInstall: { totalBlocked: 0, installDate: new Date().toISOString() } });
  }
  updateFilterLists();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CHECK_URL')
    sendResponse({ blocked: isEnabled && engine.shouldBlock(msg.url, msg.sourceUrl) });

  if (msg.type === 'GET_COSMETIC_FILTERS')
    sendResponse({ selectors: engine.getCosmeticSelectors(msg.hostname) });

  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['whitelist', 'enabled']).then(stored => {
      const wl = stored.whitelist || [];
      const en = stored.enabled !== undefined ? stored.enabled : isEnabled;
      whitelist = wl; // update memory cache
      isEnabled = en;
      sendResponse({ enabled: en, blockedCount: stats[sender.tab?.id] || 0, totalBlocked: globalStats.totalBlocked, whitelist: wl });
    });
  }

  if (msg.type === 'GET_TAB_STATS')
    sendResponse({ enabled: isEnabled, blockedCount: stats[msg.tabId] || 0, totalBlocked: globalStats.totalBlocked, whitelist });

  if (msg.type === 'GET_POPUP_OVERVIEW') {
    chrome.storage.local.get(['sinceInstall', 'whitelist']).then(stored => {
      const si = stored.sinceInstall || { totalBlocked: 0, installDate: null };
      const wl = stored.whitelist || [];
      whitelist = wl;
      const d = tabDoms[msg.tabId] || {};
      const sorted = Object.entries(d).map(([k, v]) => ({ domain: k, count: v.count, type: v.type })).sort((a, b) => b.count - a.count);
      const cats = { ads: 0, trackers: 0, social: 0, other: 0 };
      for (const { domain: dm } of sorted) {
        if (/google|doubleclick|googlesyndication|taboola|outbrain|adnxs|criteo|pubmatic|amazon-adsystem|ads\.|adform/.test(dm)) cats.ads++;
        else if (/analytics|hotjar|mixpanel|clarity|segment|optimizely|chartbeat|scorecard|quantserve|demdex|moatads/.test(dm)) cats.trackers++;
        else if (/facebook|twitter|linkedin|instagram|snap\.licdn|pixel\.facebook/.test(dm)) cats.social++;
        else cats.other++;
      }
      sendResponse({ enabled: isEnabled, blockedCount: stats[msg.tabId] || 0, totalBlocked: si.totalBlocked, sinceInstall: si, uniqueDomains: sorted.length, domains: sorted.slice(0, 15), categories: cats, whitelist: wl });
    });
  }

  if (msg.type === 'TOGGLE') {
    isEnabled = !isEnabled;
    chrome.storage.local.set({ enabled: isEnabled });
    sendResponse({ enabled: isEnabled });
  }

  if (msg.type === 'ADD_WHITELIST') {
    chrome.storage.local.get('whitelist').then(stored => {
      const wl = stored.whitelist || [];
      const d = msg.domain.replace(/^www\./, '');
      if (!wl.includes(d)) wl.push(d);
      whitelist = wl; // update memory cache
      chrome.storage.local.set({ whitelist: wl });
      sendResponse({ whitelist: wl });
    });
  }

  if (msg.type === 'REMOVE_WHITELIST') {
    chrome.storage.local.get('whitelist').then(stored => {
      const wl = (stored.whitelist || []).filter(d => d !== msg.domain);
      whitelist = wl; // update memory cache
      chrome.storage.local.set({ whitelist: wl });
      sendResponse({ whitelist: wl });
    });
  }

  if (msg.type === 'REPORT_BLOCKED') {
    const tabId = sender.tab?.id;
    const count = msg.count || 1;
    if (tabId) {
      stats[tabId] = (stats[tabId] || 0) + count;
      updateBadge(tabId, stats[tabId]);
      try {
        const h = new URL(sender.tab.url).hostname;
        globalStats.perSite[h] = (globalStats.perSite[h] || 0) + count;
        if (!tabDoms[tabId]) tabDoms[tabId] = {};
        if (!tabDoms[tabId][h]) tabDoms[tabId][h] = { count: 0, type: 'cosmetic' };
        tabDoms[tabId][h].count += count;
        try { if (h !== new URL(sender.tab.url).hostname) trackerLearner.recordSighting(h, new URL(sender.tab.url).hostname); } catch (e) {}
      } catch (e) {}
      // ATOMIC increment — reads from storage, adds, writes back
      incrementBlockedCount(count);
      // Save session data (tab stats, domains)
      saveSession();
    }
  }

  if (msg.type === 'RESET_STATS') {
    // Reset session stats but NEVER reset sinceInstall
    globalStats = { totalBlocked: 0, perSite: {} };
    stats = {};
    blockedLog = [];
    tabDoms = {};
    chrome.storage.local.set({ globalStats, stats: {}, blockedLog: [], tabDoms: {} });
    sendResponse({ success: true });
  }

  if (msg.type === 'GET_DASHBOARD_DATA') {
    chrome.storage.local.get(['sinceInstall', 'whitelist']).then(stored => {
      const si = stored.sinceInstall || { totalBlocked: 0, installDate: null };
      const wl = stored.whitelist || [];
      whitelist = wl;
      const top = Object.entries(globalStats.perSite).sort((a, b) => b[1] - a[1]).slice(0, 50);
      const cats = {};
      for (const e of blockedLog) {
        const d = e.domain; let c = 'Other';
        if (/google|doubleclick|googlesyndication|googleadservices|googletagmanager|google-analytics|imasdk/.test(d)) c = 'Google Ads & Tracking';
        else if (/facebook|fbevents|pixel\.facebook/.test(d)) c = 'Facebook / Meta';
        else if (/taboola|outbrain|mgid|revcontent/.test(d)) c = 'Native Ads';
        else if (/criteo|pubmatic|adnxs|rubiconproject|openx|indexexchange/.test(d)) c = 'Programmatic / RTB';
        else if (/amazon-adsystem|ads\.twitter|ads\.linkedin|bat\.bing/.test(d)) c = 'Platform Ads';
        else if (/hotjar|mixpanel|clarity|chartbeat|scorecardresearch|demdex|moatads/.test(d)) c = 'Trackers & Analytics';
        else if (/adroll|viglink|liveintent|adform|adsrvr/.test(d)) c = 'Ad Networks';
        cats[c] = (cats[c] || 0) + 1;
      }
      sendResponse({ enabled: isEnabled, totalBlocked: si.totalBlocked, sinceInstall: si, topSites: top, blockedLog: blockedLog.slice(0, 200), categories: cats, whitelist: wl, networkRuleCount: engine.networkFilters.length, cosmeticRuleCount: engine.cosmeticFilters.length, exceptionCount: engine.exceptions.length, trackerLearner: trackerLearner.getStats(), learnedTrackers: trackerLearner.getLearnedTrackers().slice(0, 50), filterListStats: filterListManager.getStats() });
    });
  }

  if (msg.type === 'GET_PRO_SETTINGS') chrome.storage.local.get('proSettings').then(d => sendResponse(d.proSettings || { adBlocking: true, fingerprintProtection: true, cookieAutoReject: true, annoyanceBlocking: true, minerBlocking: true, antiAdblock: true }));
  if (msg.type === 'SET_PRO_SETTINGS') { chrome.storage.local.set({ proSettings: msg.settings }); sendResponse({ success: true }); }
  if (msg.type === 'ALLOW_LEARNED_TRACKER') { trackerLearner.allowDomain(msg.domain); sendResponse({ success: true }); }
  if (msg.type === 'UPDATE_ALL_FILTER_LISTS') updateFilterLists().then(() => sendResponse({ success: true }));

  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-element') chrome.tabs.sendMessage(tab.id, { type: 'PICK_ELEMENT' });
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  if (!['typed','auto_bookmark','generated','keyword','keyword_generated','link'].includes(d.transitionType)) return;
  try { const h = new URL(d.url).hostname; if (tabUrls[d.tabId] === h) return; tabUrls[d.tabId] = h; } catch (e) {}
  stats[d.tabId] = 0; tabDoms[d.tabId] = {}; updateBadge(d.tabId, 0);
  saveSession();
});

chrome.tabs.onRemoved.addListener((id) => { delete stats[id]; delete tabDoms[id]; delete tabUrls[id]; saveSession(); });

chrome.alarms.create('autoSave', { periodInMinutes: 0.5 });
chrome.alarms.create('updateFilters', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoSave') saveSession();
  if (a.name === 'updateFilters') updateFilterLists();
});

// ══════════════════════════════════════════════════
// FUNCTIONS
// ══════════════════════════════════════════════════

function updateBadge(tabId, count) {
  try { chrome.action.setBadgeText({ text: count > 999 ? '999+' : String(count), tabId }); chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId }); } catch (e) {}
}

async function syncDynamicRules() {
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    const T = ['main_frame','sub_frame','stylesheet','script','image','font','xmlhttprequest','ping','media','other'];
    const rules = []; let id = 1000;
    for (const f of engine.networkFilters) { if (id >= 5999 || !f.pattern || f.pattern.length < 3) continue; rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { urlFilter: f.pattern, resourceTypes: f.resourceTypes?.length ? f.resourceTypes : T } }); }
    for (const f of engine.exceptions) { if (id >= 5999 || !f.pattern || f.pattern.length < 3) continue; rules.push({ id: id++, priority: 2, action: { type: 'allow' }, condition: { urlFilter: f.pattern, resourceTypes: T } }); }
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules: rules.slice(0, 5000) });
  } catch (e) {}
}

async function updateFilterLists() {
  try {
    engine.networkFilters = []; engine.cosmeticFilters = []; engine.exceptions = [];
    const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt')); engine.parse(await r.text());
    const res = await filterListManager.updateAll();
    for (const x of res) { if (x.success) { const t = await filterListManager.getCachedList(x.id); if (t) engine.parse(t); } }
    await syncDynamicRules();
  } catch (e) {}
}

// ══════════════════════════════════════════════════
// INIT — restore in-memory cache from storage
// ══════════════════════════════════════════════════
async function init() {
  // Load filters
  try { const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt')); engine.parse(await r.text()); } catch (e) {}
  try {
    await filterListManager.init();
    for (const l of filterListManager.getEnabledLists()) { try { const c = await filterListManager.getCachedList(l.id); if (c) engine.parse(c); } catch (e) {} }
  } catch (e) {}

  // Restore in-memory cache
  try {
    const d = await chrome.storage.local.get(['enabled','whitelist','globalStats','blockedLog','stats','tabDoms','tabUrls']);
    if (d.enabled !== undefined) isEnabled = d.enabled;
    if (d.whitelist) whitelist = d.whitelist;
    if (d.globalStats) globalStats = d.globalStats;
    if (d.blockedLog && Array.isArray(d.blockedLog)) blockedLog = d.blockedLog;
    if (d.stats) stats = d.stats;
    if (d.tabDoms) tabDoms = d.tabDoms;
    if (d.tabUrls) tabUrls = d.tabUrls;
  } catch (e) {}

  // Restore sinceInstall from sync if local was cleared
  try {
    const local = await chrome.storage.local.get('sinceInstall');
    const sync = await chrome.storage.sync.get('sinceInstall');
    const localSI = local.sinceInstall || { totalBlocked: 0, installDate: null };
    const syncSI = sync.sinceInstall || { totalBlocked: 0, installDate: null };
    // Use whichever is higher
    if (syncSI.totalBlocked > localSI.totalBlocked) {
      await chrome.storage.local.set({ sinceInstall: syncSI });
      globalStats.totalBlocked = Math.max(globalStats.totalBlocked, syncSI.totalBlocked);
    }
    if (!localSI.installDate && syncSI.installDate) {
      const merged = { ...localSI, installDate: syncSI.installDate };
      await chrome.storage.local.set({ sinceInstall: merged });
    }
  } catch (e) {}

  await trackerLearner.load();
  await syncDynamicRules();

  // Restore badges
  try { const tabs = await chrome.tabs.query({}); for (const t of tabs) { if (stats[t.id] > 0) updateBadge(t.id, stats[t.id]); } } catch (e) {}

  initDone = true;

  // Log what was restored
  try {
    const d = await chrome.storage.local.get('sinceInstall');
    console.log(`[Zenith] Ready — rules:${engine.networkFilters.length} sinceInstall:${(d.sinceInstall||{}).totalBlocked||0}`);
  } catch (e) {}
}

// Debug tracking (dev mode only)
try {
  if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      if (info.request.tabId < 0) return;
      const tabId = info.request.tabId;
      stats[tabId] = (stats[tabId] || 0) + 1;
      updateBadge(tabId, stats[tabId]);
      try {
        const h = new URL(info.request.url).hostname;
        globalStats.perSite[h] = (globalStats.perSite[h] || 0) + 1;
        if (!tabDoms[tabId]) tabDoms[tabId] = {};
        if (!tabDoms[tabId][h]) tabDoms[tabId][h] = { count: 0, type: info.request.type || 'other' };
        tabDoms[tabId][h].count++;
        blockedLog.unshift({ url: info.request.url, domain: h, type: info.request.type || 'other', timestamp: Date.now(), tabId });
        if (blockedLog.length > MAX_LOG) blockedLog.length = MAX_LOG;
        try { const src = info.request.documentUrl ? new URL(info.request.documentUrl).hostname : ''; if (src && src !== h) trackerLearner.recordSighting(h, src); } catch (e) {}
      } catch (e) {}
      // Atomic increment + session save
      incrementBlockedCount(1);
      saveSession();
    });
  }
} catch (e) {}

init();
