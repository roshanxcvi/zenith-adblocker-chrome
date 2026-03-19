/**
 * Zenith AdBlocker — Chrome Background (MV3)
 * by roshanxcvi
 *
 * ALL data saved to chrome.storage.local (survives browser close)
 * sinceInstall ALSO saved to chrome.storage.sync (survives clear data)
 * Debounced save — writes within 1 second of any change
 */

import { FilterEngine } from './rules/filter-engine.js';
import { TrackerLearner } from './modules/tracker-learner.js';
import { FilterListManager } from './modules/filter-list-manager.js';

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
let sinceInstall = { totalBlocked: 0, installDate: null };
let saveTimer = null;

// ——— INIT ———
async function init() {
  try { const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt')); engine.parse(await r.text()); } catch (e) {}
  try {
    await filterListManager.init();
    for (const l of filterListManager.getEnabledLists()) { try { const c = await filterListManager.getCachedList(l.id); if (c) engine.parse(c); } catch (e) {} }
  } catch (e) {}

  // Restore from local storage
  try {
    const d = await chrome.storage.local.get(['enabled','whitelist','globalStats','blockedLog','sinceInstall','stats','tabDoms','tabUrls']);
    if (d.enabled !== undefined) isEnabled = d.enabled;
    if (d.whitelist) whitelist = d.whitelist;
    if (d.globalStats) globalStats = d.globalStats;
    if (d.blockedLog && Array.isArray(d.blockedLog)) blockedLog = d.blockedLog;
    if (d.sinceInstall) sinceInstall = d.sinceInstall;
    if (d.stats) stats = d.stats;
    if (d.tabDoms) tabDoms = d.tabDoms;
    if (d.tabUrls) tabUrls = d.tabUrls;
  } catch (e) {}

  // Restore sinceInstall from sync (survives clearing browser data)
  try {
    const s = await chrome.storage.sync.get('sinceInstall');
    if (s.sinceInstall && s.sinceInstall.totalBlocked > sinceInstall.totalBlocked) {
      sinceInstall = s.sinceInstall;
      if (globalStats.totalBlocked === 0) globalStats.totalBlocked = sinceInstall.totalBlocked;
    }
    if (s.sinceInstall && !sinceInstall.installDate) sinceInstall.installDate = s.sinceInstall.installDate;
  } catch (e) {}

  await trackerLearner.load();
  await syncDynamicRules();

  // Restore badges
  try { const tabs = await chrome.tabs.query({}); for (const t of tabs) { if (stats[t.id] > 0) updateBadge(t.id, stats[t.id]); } } catch (e) {}

  console.log(`[Zenith] Ready — rules:${engine.networkFilters.length} total:${globalStats.totalBlocked} sinceInstall:${sinceInstall.totalBlocked}`);
}

// ——— DYNAMIC RULES ———
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

// ——— SAVE (debounced 1 second) ———
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await chrome.storage.local.set({
        globalStats, sinceInstall, stats, tabDoms, tabUrls,
        blockedLog: blockedLog.slice(0, MAX_LOG),
        enabled: isEnabled, whitelist, lastSave: Date.now()
      });
    } catch (e) {}
    try { await chrome.storage.sync.set({ sinceInstall }); } catch (e) {}
  }, 1000);
}

async function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    await chrome.storage.local.set({
      globalStats, sinceInstall, stats, tabDoms, tabUrls,
      blockedLog: blockedLog.slice(0, MAX_LOG),
      enabled: isEnabled, whitelist, lastSave: Date.now()
    });
  } catch (e) {}
  try { await chrome.storage.sync.set({ sinceInstall }); } catch (e) {}
}

// ——— DEBUG TRACKING ———
try {
  if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      if (info.request.tabId < 0) return;
      const tabId = info.request.tabId;
      stats[tabId] = (stats[tabId] || 0) + 1;
      updateBadge(tabId, stats[tabId]);
      try {
        const h = new URL(info.request.url).hostname;
        globalStats.totalBlocked++; sinceInstall.totalBlocked++;
        globalStats.perSite[h] = (globalStats.perSite[h] || 0) + 1;
        if (!tabDoms[tabId]) tabDoms[tabId] = {};
        if (!tabDoms[tabId][h]) tabDoms[tabId][h] = { count: 0, type: info.request.type || 'other' };
        tabDoms[tabId][h].count++;
        blockedLog.unshift({ url: info.request.url, domain: h, type: info.request.type || 'other', timestamp: Date.now(), tabId });
        if (blockedLog.length > MAX_LOG) blockedLog.length = MAX_LOG;
        // Feed tracker learner
        try { const srcHost = info.request.documentUrl ? new URL(info.request.documentUrl).hostname : ''; if (srcHost && srcHost !== h) trackerLearner.recordSighting(h, srcHost); } catch (e) {}
        save();
      } catch (e) {}
    });
  }
} catch (e) {}

// ——— INSTALL ———
chrome.runtime.onInstalled.addListener((d) => {
  try { chrome.contextMenus.create({ id: 'block-element', title: 'Block this element', contexts: ['all'] }); } catch (e) {}
  if (d.reason === 'install') { sinceInstall.installDate = new Date().toISOString(); saveNow(); }
  updateFilterLists();
});
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'block-element') chrome.tabs.sendMessage(tab.id, { type: 'PICK_ELEMENT' }); });

// ——— MESSAGES ———
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CHECK_URL')
    sendResponse({ blocked: isEnabled && engine.shouldBlock(msg.url, msg.sourceUrl) });

  if (msg.type === 'GET_COSMETIC_FILTERS')
    sendResponse({ selectors: engine.getCosmeticSelectors(msg.hostname) });

  if (msg.type === 'GET_STATE')
    sendResponse({ enabled: isEnabled, blockedCount: stats[sender.tab?.id] || 0, totalBlocked: globalStats.totalBlocked, whitelist });

  if (msg.type === 'GET_TAB_STATS')
    sendResponse({ enabled: isEnabled, blockedCount: stats[msg.tabId] || 0, totalBlocked: globalStats.totalBlocked, whitelist });

  if (msg.type === 'GET_POPUP_OVERVIEW') {
    const d = tabDoms[msg.tabId] || {};
    const sorted = Object.entries(d).map(([k, v]) => ({ domain: k, count: v.count, type: v.type })).sort((a, b) => b.count - a.count);
    const cats = { ads: 0, trackers: 0, social: 0, other: 0 };
    for (const { domain: dm } of sorted) {
      if (/google|doubleclick|googlesyndication|taboola|outbrain|adnxs|criteo|pubmatic|amazon-adsystem|ads\.|adform/.test(dm)) cats.ads++;
      else if (/analytics|hotjar|mixpanel|clarity|segment|optimizely|chartbeat|scorecard|quantserve|demdex|moatads/.test(dm)) cats.trackers++;
      else if (/facebook|twitter|linkedin|instagram|snap\.licdn|pixel\.facebook/.test(dm)) cats.social++;
      else cats.other++;
    }
    sendResponse({ enabled: isEnabled, blockedCount: stats[msg.tabId] || 0, totalBlocked: globalStats.totalBlocked, sinceInstall, uniqueDomains: sorted.length, domains: sorted.slice(0, 15), categories: cats, whitelist });
  }

  if (msg.type === 'TOGGLE') { isEnabled = !isEnabled; saveNow(); sendResponse({ enabled: isEnabled }); }

  if (msg.type === 'ADD_WHITELIST') {
    const d = msg.domain.replace(/^www\./, '');
    if (!whitelist.includes(d)) whitelist.push(d);
    saveNow(); sendResponse({ whitelist });
  }

  if (msg.type === 'REMOVE_WHITELIST') {
    whitelist = whitelist.filter(d => d !== msg.domain);
    saveNow(); sendResponse({ whitelist });
  }

  if (msg.type === 'REPORT_BLOCKED') {
    const tabId = sender.tab?.id; const count = msg.count || 1;
    if (tabId) {
      stats[tabId] = (stats[tabId] || 0) + count;
      updateBadge(tabId, stats[tabId]);
      try {
        const h = new URL(sender.tab.url).hostname;
        globalStats.totalBlocked += count;
        sinceInstall.totalBlocked += count;
        globalStats.perSite[h] = (globalStats.perSite[h] || 0) + count;
        if (!tabDoms[tabId]) tabDoms[tabId] = {};
        if (!tabDoms[tabId][h]) tabDoms[tabId][h] = { count: 0, type: 'cosmetic' };
        tabDoms[tabId][h].count += count;
        // Feed tracker learner
        try { const pageHost = new URL(sender.tab.url).hostname; if (pageHost !== h) trackerLearner.recordSighting(h, pageHost); } catch (e) {}
      } catch (e) {}
      save();
    }
  }

  if (msg.type === 'RESET_STATS') {
    globalStats = { totalBlocked: 0, perSite: {} }; stats = {}; blockedLog = []; tabDoms = {};
    // sinceInstall is NEVER reset
    saveNow(); sendResponse({ success: true });
  }

  if (msg.type === 'GET_DASHBOARD_DATA') {
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
    sendResponse({ enabled: isEnabled, totalBlocked: globalStats.totalBlocked, sinceInstall, topSites: top, blockedLog: blockedLog.slice(0, 200), categories: cats, whitelist, networkRuleCount: engine.networkFilters.length, cosmeticRuleCount: engine.cosmeticFilters.length, exceptionCount: engine.exceptions.length, trackerLearner: trackerLearner.getStats(), learnedTrackers: trackerLearner.getLearnedTrackers().slice(0, 50), filterListStats: filterListManager.getStats() });
  }

  if (msg.type === 'GET_PRO_SETTINGS') chrome.storage.local.get('proSettings').then(d => sendResponse(d.proSettings || { adBlocking: true, fingerprintProtection: true, cookieAutoReject: true, annoyanceBlocking: true, minerBlocking: true, antiAdblock: true }));
  if (msg.type === 'SET_PRO_SETTINGS') { chrome.storage.local.set({ proSettings: msg.settings }); sendResponse({ success: true }); }
  if (msg.type === 'ALLOW_LEARNED_TRACKER') { trackerLearner.allowDomain(msg.domain); sendResponse({ success: true }); }
  if (msg.type === 'UPDATE_ALL_FILTER_LISTS') updateFilterLists().then(() => sendResponse({ success: true }));

  return true;
});

// ——— BADGE ———
function updateBadge(tabId, count) { try { chrome.action.setBadgeText({ text: count > 999 ? '999+' : String(count), tabId }); chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId }); } catch (e) {} }

// ——— NAV ———
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  if (!['typed','auto_bookmark','generated','keyword','keyword_generated','link'].includes(d.transitionType)) return;
  try { const h = new URL(d.url).hostname; if (tabUrls[d.tabId] === h) return; tabUrls[d.tabId] = h; } catch (e) {}
  stats[d.tabId] = 0; tabDoms[d.tabId] = {}; updateBadge(d.tabId, 0); save();
});
chrome.tabs.onRemoved.addListener((id) => { delete stats[id]; delete tabDoms[id]; delete tabUrls[id]; save(); });

// ——— FILTER UPDATE ———
async function updateFilterLists() {
  try {
    engine.networkFilters = []; engine.cosmeticFilters = []; engine.exceptions = [];
    const r = await fetch(chrome.runtime.getURL('rules/default-filters.txt')); engine.parse(await r.text());
    const res = await filterListManager.updateAll();
    for (const x of res) { if (x.success) { const t = await filterListManager.getCachedList(x.id); if (t) engine.parse(t); } }
    await syncDynamicRules();
  } catch (e) {}
}

// ——— ALARMS ———
chrome.alarms.create('autoSave', { periodInMinutes: 0.5 });
chrome.alarms.create('updateFilters', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'autoSave') saveNow(); if (a.name === 'updateFilters') updateFilterLists(); });

init();
