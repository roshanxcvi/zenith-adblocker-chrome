/**
 * Zenith AdBlocker — Chrome Background Service Worker (MV3)
 * by roshanxcvi
 * 
 * PERSISTENCE FIX:
 * - chrome.storage.local  → permanent data (survives browser close)
 * - chrome.storage.session → tab data (survives service worker restart, clears on browser close)
 * - All state restored on every service worker wake-up
 */

import { FilterEngine } from './rules/filter-engine.js';
import { TrackerLearner } from './modules/tracker-learner.js';
import { FilterListManager } from './modules/filter-list-manager.js';

const engine = new FilterEngine();
const trackerLearner = new TrackerLearner();
const filterListManager = new FilterListManager();

// ——— STATE ———
let isEnabled = true;
let stats = {};                // per-tab blocked count
let whitelist = [];
let globalStats = { totalBlocked: 0, perSite: {} };
let blockedLog = [];
const MAX_LOG_SIZE = 500;
let tabBlockedDomains = {};    // per-tab domain breakdown

// "Since install" counter — like uBlock Origin
// Stored in BOTH chrome.storage.local AND chrome.storage.sync
// sync survives even if user clears all browsing data
let sinceInstall = { totalBlocked: 0, installDate: null };

// ——— INIT (runs every time service worker wakes up) ———
async function init() {
  // 1. Load filters
  try {
    const resp = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
    engine.parse(await resp.text());
  } catch (e) { console.warn('[Zenith] Default filters load failed:', e); }

  try {
    await filterListManager.init();
    for (const list of filterListManager.getEnabledLists()) {
      try {
        const cached = await filterListManager.getCachedList(list.id);
        if (cached) engine.parse(cached);
      } catch (e) {}
    }
  } catch (e) { console.warn('[Zenith] Filter list manager init failed:', e); }

  // 2. Restore PERMANENT data (survives browser close)
  try {
    const data = await chrome.storage.local.get([
      'enabled', 'whitelist', 'globalStats', 'blockedLog', 'sinceInstall'
    ]);
    if (data.enabled !== undefined) isEnabled = data.enabled;
    if (data.whitelist) whitelist = data.whitelist;
    if (data.globalStats) globalStats = data.globalStats;
    if (data.blockedLog && Array.isArray(data.blockedLog)) blockedLog = data.blockedLog;
    if (data.sinceInstall) sinceInstall = data.sinceInstall;
  } catch (e) {}

  // 2b. Restore sinceInstall from SYNC (survives clearing browsing data!)
  // sync takes priority if it has a higher count (meaning local was cleared)
  try {
    const syncData = await chrome.storage.sync.get('sinceInstall');
    if (syncData.sinceInstall) {
      // Use whichever has the higher count (local might have been cleared)
      if (syncData.sinceInstall.totalBlocked > sinceInstall.totalBlocked) {
        sinceInstall = syncData.sinceInstall;
        // Also restore globalStats totalBlocked if local was cleared
        if (globalStats.totalBlocked === 0 && sinceInstall.totalBlocked > 0) {
          globalStats.totalBlocked = sinceInstall.totalBlocked;
        }
      }
      if (!sinceInstall.installDate && syncData.sinceInstall.installDate) {
        sinceInstall.installDate = syncData.sinceInstall.installDate;
      }
    }
  } catch (e) {}

  // 3. Restore SESSION data (survives service worker restart, clears on browser close)
  try {
    // Allow session storage to hold more data
    if (chrome.storage.session.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
    }
    const session = await chrome.storage.session.get(['stats', 'tabBlockedDomains', 'tabUrls']);
    if (session.stats) stats = session.stats;
    if (session.tabBlockedDomains) tabBlockedDomains = session.tabBlockedDomains;
    if (session.tabUrls) tabUrls = session.tabUrls;
  } catch (e) { console.warn('[Zenith] Session restore failed:', e); }

  await trackerLearner.load();
  await syncDynamicRules();

  // Restore badges for all open tabs
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const count = stats[tab.id] || 0;
      if (count > 0) updateBadge(tab.id, count);
    }
  } catch (e) {}

  console.log(`[Zenith] Ready — ${engine.networkFilters.length} network, ${engine.cosmeticFilters.length} cosmetic, totalBlocked: ${globalStats.totalBlocked}`);
}

// ——— DYNAMIC RULES ———
async function syncDynamicRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map(r => r.id);
    const ALL_TYPES = ['main_frame','sub_frame','stylesheet','script','image','font','xmlhttprequest','ping','media','other'];
    const addRules = [];
    let id = 1000;

    for (const f of engine.networkFilters) {
      if (id >= 5999) break;
      if (!f.pattern || f.pattern.length < 3) continue;
      let types = ALL_TYPES;
      if (f.resourceTypes && f.resourceTypes.length > 0) types = f.resourceTypes;
      addRules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { urlFilter: f.pattern, resourceTypes: types } });
    }
    for (const f of engine.exceptions) {
      if (id >= 5999) break;
      if (!f.pattern || f.pattern.length < 3) continue;
      addRules.push({ id: id++, priority: 2, action: { type: 'allow' }, condition: { urlFilter: f.pattern, resourceTypes: ALL_TYPES } });
    }

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: addRules.slice(0, 5000) });
    console.log(`[Zenith] Synced ${Math.min(addRules.length, 5000)} dynamic rules`);
  } catch (e) { console.warn('[Zenith] Dynamic rules sync failed:', e); }
}

// ——— SAVE PERMANENT DATA (survives browser close) ———
async function savePermanent() {
  try {
    await chrome.storage.local.set({
      globalStats,
      blockedLog: blockedLog.slice(0, MAX_LOG_SIZE),
      enabled: isEnabled,
      whitelist,
      sinceInstall,
      lastSave: Date.now()
    });
  } catch (e) {}
  // Also save sinceInstall to sync — this survives clearing browsing data
  try {
    await chrome.storage.sync.set({ sinceInstall });
  } catch (e) {}
}

// ——— SAVE SESSION DATA (survives service worker restart) ———
async function saveSession() {
  try {
    await chrome.storage.session.set({ stats, tabBlockedDomains, tabUrls });
  } catch (e) {}
}

// ——— SAVE ALL ———
async function saveAll() {
  await savePermanent();
  await saveSession();
}

// ——— TRACK BLOCKED REQUESTS ———
// onRuleMatchedDebug only works in dev mode — but we track anyway as a bonus
try {
  if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      if (info.request.tabId < 0) return;
      const tabId = info.request.tabId;
      stats[tabId] = (stats[tabId] || 0) + 1;
      updateBadge(tabId, stats[tabId]);
      try {
        const hostname = new URL(info.request.url).hostname;
        globalStats.totalBlocked += 1;
        sinceInstall.totalBlocked += 1;
        globalStats.perSite[hostname] = (globalStats.perSite[hostname] || 0) + 1;
        if (!tabBlockedDomains[tabId]) tabBlockedDomains[tabId] = {};
        if (!tabBlockedDomains[tabId][hostname]) tabBlockedDomains[tabId][hostname] = { count: 0, type: info.request.type || 'unknown' };
        tabBlockedDomains[tabId][hostname].count += 1;
        blockedLog.unshift({ url: info.request.url, domain: hostname, type: info.request.type || 'unknown', timestamp: Date.now(), tabId });
        if (blockedLog.length > MAX_LOG_SIZE) blockedLog = blockedLog.slice(0, MAX_LOG_SIZE);
        if (globalStats.totalBlocked % 10 === 0) saveAll();
      } catch (e) {}
    });
  }
} catch (e) {}

// ——— INSTALL ———
chrome.runtime.onInstalled.addListener((details) => {
  try { chrome.contextMenus.create({ id: 'block-element', title: 'Block this element', contexts: ['all'] }); } catch (e) {}
  updateFilterLists();
  // Record install date (only on first install, not updates)
  if (details.reason === 'install') {
    sinceInstall.installDate = new Date().toISOString();
    savePermanent();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'block-element') chrome.tabs.sendMessage(tab.id, { type: 'PICK_ELEMENT' });
});

// ——— MESSAGE HANDLER ———
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CHECK_URL') {
    sendResponse({ blocked: isEnabled && engine.shouldBlock(msg.url, msg.sourceUrl) });
  }

  if (msg.type === 'GET_COSMETIC_FILTERS') {
    sendResponse({ selectors: engine.getCosmeticSelectors(msg.hostname) });
  }

  if (msg.type === 'GET_STATE') {
    const tabId = sender.tab?.id;
    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[tabId] || 0,
      totalBlocked: globalStats.totalBlocked,
      whitelist
    });
  }

  if (msg.type === 'GET_TAB_STATS') {
    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[msg.tabId] || 0,
      totalBlocked: globalStats.totalBlocked,
      whitelist
    });
  }

  if (msg.type === 'GET_POPUP_OVERVIEW') {
    const doms = tabBlockedDomains[msg.tabId] || {};
    const sorted = Object.entries(doms).map(([d, i]) => ({ domain: d, count: i.count, type: i.type })).sort((a, b) => b.count - a.count);
    const cats = { ads: 0, trackers: 0, social: 0, other: 0 };
    for (const { domain } of sorted) {
      if (/google|doubleclick|googlesyndication|taboola|outbrain|adnxs|criteo|pubmatic|amazon-adsystem|ads\.|adform/.test(domain)) cats.ads++;
      else if (/analytics|hotjar|mixpanel|clarity|segment|optimizely|chartbeat|scorecard|quantserve|demdex|moatads/.test(domain)) cats.trackers++;
      else if (/facebook|twitter|linkedin|instagram|snap\.licdn|pixel\.facebook/.test(domain)) cats.social++;
      else cats.other++;
    }
    sendResponse({
      enabled: isEnabled,
      blockedCount: stats[msg.tabId] || 0,
      totalBlocked: globalStats.totalBlocked,
      sinceInstall,
      uniqueDomains: sorted.length,
      domains: sorted.slice(0, 15),
      categories: cats,
      whitelist
    });
  }

  if (msg.type === 'TOGGLE') {
    isEnabled = !isEnabled;
    savePermanent();
    sendResponse({ enabled: isEnabled });
  }

  if (msg.type === 'ADD_WHITELIST') {
    const d = msg.domain.replace(/^www\./, '');
    if (!whitelist.includes(d)) whitelist.push(d);
    savePermanent();
    sendResponse({ whitelist });
  }

  if (msg.type === 'REMOVE_WHITELIST') {
    whitelist = whitelist.filter(d => d !== msg.domain);
    savePermanent();
    sendResponse({ whitelist });
  }

  if (msg.type === 'REPORT_BLOCKED') {
    const tabId = sender.tab?.id;
    const count = msg.count || 1;
    if (tabId) {
      stats[tabId] = (stats[tabId] || 0) + count;
      updateBadge(tabId, stats[tabId]);
      try {
        const hostname = new URL(sender.tab.url).hostname;
        globalStats.totalBlocked += count;
        sinceInstall.totalBlocked += count;
        globalStats.perSite[hostname] = (globalStats.perSite[hostname] || 0) + count;
        if (!tabBlockedDomains[tabId]) tabBlockedDomains[tabId] = {};
        if (!tabBlockedDomains[tabId][hostname]) tabBlockedDomains[tabId][hostname] = { count: 0, type: 'cosmetic' };
        tabBlockedDomains[tabId][hostname].count += count;
        // Save session data so tab counts survive service worker restart
        if (globalStats.totalBlocked % 5 === 0) saveAll();
      } catch (e) {}
    }
  }

  if (msg.type === 'RESET_STATS') {
    globalStats = { totalBlocked: 0, perSite: {} };
    stats = {};
    blockedLog = [];
    tabBlockedDomains = {};
    saveAll();
    sendResponse({ success: true });
  }

  if (msg.type === 'GET_DASHBOARD_DATA') {
    const topSites = Object.entries(globalStats.perSite).sort((a, b) => b[1] - a[1]).slice(0, 50);
    const categories = {};
    for (const e of blockedLog) {
      const d = e.domain; let cat = 'Other';
      if (/google|doubleclick|googlesyndication|googleadservices|googletagmanager|google-analytics|imasdk/.test(d)) cat = 'Google Ads & Tracking';
      else if (/facebook|fbevents|pixel\.facebook/.test(d)) cat = 'Facebook / Meta';
      else if (/taboola|outbrain|mgid|revcontent/.test(d)) cat = 'Native Ads';
      else if (/criteo|pubmatic|adnxs|rubiconproject|openx|indexexchange|bidswitch|sharethrough|triplelift/.test(d)) cat = 'Programmatic / RTB';
      else if (/amazon-adsystem|ads\.twitter|ads\.linkedin|bat\.bing/.test(d)) cat = 'Platform Ads';
      else if (/hotjar|mixpanel|clarity|chartbeat|quantserve|scorecardresearch|demdex|moatads|doubleverify/.test(d)) cat = 'Trackers & Analytics';
      else if (/popads|popcash|propellerads|exoclick/.test(d)) cat = 'Popup / Aggressive Ads';
      else if (/adroll|viglink|liveintent|advertising\.com|adform|adsrvr/.test(d)) cat = 'Ad Networks';
      categories[cat] = (categories[cat] || 0) + 1;
    }
    sendResponse({
      enabled: isEnabled,
      totalBlocked: globalStats.totalBlocked,
      topSites,
      blockedLog: blockedLog.slice(0, 200),
      categories,
      whitelist,
      networkRuleCount: engine.networkFilters.length,
      cosmeticRuleCount: engine.cosmeticFilters.length,
      exceptionCount: engine.exceptions.length,
      trackerLearner: trackerLearner.getStats(),
      learnedTrackers: trackerLearner.getLearnedTrackers().slice(0, 50),
      filterListStats: filterListManager.getStats(),
      sinceInstall
    });
  }

  if (msg.type === 'GET_PRO_SETTINGS') {
    chrome.storage.local.get('proSettings').then(d => {
      sendResponse(d.proSettings || {
        adBlocking: true, fingerprintProtection: true, cookieAutoReject: true,
        annoyanceBlocking: true, minerBlocking: true, antiAdblock: true
      });
    });
  }

  if (msg.type === 'SET_PRO_SETTINGS') {
    chrome.storage.local.set({ proSettings: msg.settings });
    sendResponse({ success: true });
  }

  if (msg.type === 'ALLOW_LEARNED_TRACKER') {
    trackerLearner.allowDomain(msg.domain);
    sendResponse({ success: true });
  }

  if (msg.type === 'UPDATE_ALL_FILTER_LISTS') {
    updateFilterLists().then(() => sendResponse({ success: true }));
  }

  return true; // keep message channel open for async responses
});

// ——— BADGE ———
function updateBadge(tabId, count) {
  try {
    chrome.action.setBadgeText({ text: count > 999 ? '999+' : String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
  } catch (e) {}
}

// ——— TAB LIFECYCLE ———
// Track current hostname per tab to avoid resetting on same-page navigations
let tabUrls = {};

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return; // ignore iframes

  // Only reset on real navigations, not SPA pushState or reloads
  const resetTypes = ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated'];
  const isNewNavigation = resetTypes.includes(d.transitionType) || d.transitionType === 'link';

  if (!isNewNavigation) return;

  // Only reset if the hostname actually changed
  try {
    const newHost = new URL(d.url).hostname;
    const oldHost = tabUrls[d.tabId];
    if (oldHost && oldHost === newHost) return; // same site, don't reset
    tabUrls[d.tabId] = newHost;
  } catch (e) {}

  stats[d.tabId] = 0;
  tabBlockedDomains[d.tabId] = {};
  updateBadge(d.tabId, 0);
  saveSession();
});

chrome.tabs.onRemoved.addListener((id) => {
  delete stats[id];
  delete tabBlockedDomains[id];
  delete tabUrls[id];
  saveSession();
});

// ——— FILTER LIST UPDATE ———
async function updateFilterLists() {
  try {
    engine.networkFilters = []; engine.cosmeticFilters = []; engine.exceptions = [];
    const defResp = await fetch(chrome.runtime.getURL('rules/default-filters.txt'));
    engine.parse(await defResp.text());
    const results = await filterListManager.updateAll();
    for (const r of results) {
      if (r.success) {
        const t = await filterListManager.getCachedList(r.id);
        if (t) engine.parse(t);
      }
    }
    await syncDynamicRules();
    console.log(`[Zenith] Lists updated — ${engine.networkFilters.length} rules`);
  } catch (e) { console.warn('[Zenith] Update failed:', e); }
}

// ——— ALARMS (keep service worker alive + auto-save) ———
chrome.alarms.create('autoSave', { periodInMinutes: 1 });
chrome.alarms.create('updateFilters', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'autoSave') saveAll();
  if (a.name === 'updateFilters') updateFilterLists();
});

// ——— START ———
init();
