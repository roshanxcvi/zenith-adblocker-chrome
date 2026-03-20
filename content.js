/**
 * Zenith AdBlocker — Content Script (Chrome Only)
 * by roshanxcvi
 */

(async function () {
  'use strict';

  const hostname = window.location.hostname;
  if (!hostname) return;

  // Safe message sender
  function send(data) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage(data, r => resolve(r || null)); }
      catch (e) { resolve(null); }
    });
  }

  // ——— CHECK STATE ———
  const state = await send({ type: 'GET_STATE' });
  if (!state || !state.enabled) return;
  if (state.whitelist && state.whitelist.some(d => hostname.includes(d))) return;

  // ——— SETTINGS ———
  let settings = {};
  try { const d = await chrome.storage.local.get('proSettings'); settings = (d && d.proSettings) || {}; } catch (e) {}
  const F = {
    ads: settings.adBlocking !== false,
    fp: settings.fingerprintProtection !== false,
    cookie: settings.cookieAutoReject !== false,
    annoy: settings.annoyanceBlocking !== false,
    miner: settings.minerBlocking !== false,
    antiAb: settings.antiAdblock !== false,
  };

  // ═══════════════════════════════════
  // FINGERPRINT PROTECTION
  // ═══════════════════════════════════
  if (F.fp) {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('fingerprint.js');
      s.onload = () => s.remove();
      const parent = document.head || document.documentElement;
      if (parent) parent.appendChild(s);
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // AD BLOCKING (Cosmetic Filtering)
  // ═══════════════════════════════════
  if (F.ads) {
    // Get selectors from background
    let selectors = [];
    try {
      const r = await send({ type: 'GET_COSMETIC_FILTERS', hostname });
      if (r && r.selectors) selectors = r.selectors;
    } catch (e) {}

    const BUILTIN = [
      'ins.adsbygoogle','[id^="google_ads"]','[id^="div-gpt-ad"]','[data-google-query-id]',
      '[data-ad-slot]','[data-ad-client]',
      '.ad-banner','.ad-container','.ad-wrapper','.ad-slot','.ad-unit','.ad-placement',
      '.ad-leaderboard','.ad-sidebar','.ad-footer','.ad-header','.ad-block','.ad-box',
      '.ad-content','.advertisement','.advertise',
      '[id*="ad-container"]','[id*="ad-wrapper"]','[id*="ad-banner"]',
      '[id*="ad_container"]','[id*="ad_wrapper"]',
      '.sponsored-content','.sponsored','.promoted-post','.promoted',
      '[class*="sponsored"]','[class*="promoted"]',
      '[id*="taboola"]','[class*="taboola"]','[id*="outbrain"]','[class*="outbrain"]','.OUTBRAIN',
      '.dfp-ad','[class*="dfp"]','[class*="gpt-ad"]',
      '[data-ad]','[data-ad-slot]','[data-native-ad]',
      '.sidebar-ad','.sticky-ad','.floating-ad','.interstitial-ad','.overlay-ad',
      'iframe[src*="doubleclick"]','iframe[src*="googlesyndication"]','iframe[src*="amazon-adsystem"]',
      'iframe[id*="google_ads"]','img[src*="/ad/"]','img[src*="/ads/"]',
      '[class*="ad-break"]','[class*="advert-"]',
    ];

    const allSel = [...new Set([...selectors, ...BUILTIN])];

    // Inject hiding CSS immediately
    try {
      const style = document.createElement('style');
      style.id = 'zenith-hide';
      style.textContent = allSel.map(s =>
        `${s}{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}`
      ).join('\n');
      const target = document.head || document.documentElement;
      if (target) {
        if (target.firstChild) target.insertBefore(style, target.firstChild);
        else target.appendChild(style);
      }
    } catch (e) {}

    // Active DOM scanner
    function scanAds() {
      let count = 0;
      for (const sel of allSel) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (!el.dataset.zb) {
              el.style.setProperty('display', 'none', 'important');
              el.dataset.zb = '1';
              count++;
            }
          }
        } catch (e) {}
      }
      if (count > 0) send({ type: 'REPORT_BLOCKED', count });
    }

    // MutationObserver for dynamic ads
    let scanTimer = null;
    const observer = new MutationObserver(() => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanAds, 100);
    });

    function startObserver() {
      scanAds();
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);
    window.addEventListener('load', () => { scanAds(); setTimeout(scanAds, 1500); setTimeout(scanAds, 4000); });

    // Block document.write ads
    try {
      const origWrite = document.write.bind(document);
      document.write = function(markup) {
        if (/ad[s]?[_\-.]|banner|sponsor|doubleclick|googlesyndication|taboola|outbrain/i.test(markup)) {
          send({ type: 'REPORT_BLOCKED', count: 1 });
          return;
        }
        origWrite(markup);
      };
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // COOKIE AUTO-REJECT
  // ═══════════════════════════════════
  if (F.cookie) {
    const REJECT_BTNS = [
      '#onetrust-reject-all-handler',
      '#CybotCookiebotDialogBodyButtonDecline',
      '#didomi-notice-disagree-button',
      '.qc-cmp2-summary-buttons button[mode="secondary"]',
      'button[aria-label*="reject"]',
      'button[aria-label*="deny"]',
      'button[aria-label*="decline"]',
    ];
    const BANNERS = [
      '#onetrust-banner-sdk','#CybotCookiebotDialog','.truste_overlay',
      '.qc-cmp2-container','#didomi-host',
      '[class*="cookie-banner"]','[class*="cookie-consent"]','[class*="cookie-notice"]',
      '[id*="cookie-consent"]','[class*="gdpr"]','[class*="consent-banner"]',
      '[class*="cc-window"]','.fc-consent-root',
    ];
    const TEXT_PATTERNS = [/^reject\s*(all)?$/i, /^deny\s*(all)?$/i, /^decline\s*(all)?$/i, /^no,?\s*thanks?$/i, /^only\s*(essential|necessary)/i];

    function rejectCookies() {
      // Try direct selectors
      for (const sel of REJECT_BTNS) {
        try { const b = document.querySelector(sel); if (b && b.offsetParent !== null) { b.click(); return; } } catch (e) {}
      }
      // Try text matching
      for (const btn of document.querySelectorAll('button, a[role="button"]')) {
        const t = (btn.textContent || '').trim();
        if (t.length > 50) continue;
        if (TEXT_PATTERNS.some(r => r.test(t)) && btn.offsetParent !== null) { btn.click(); return; }
      }
      // Fallback: hide banners
      for (const sel of BANNERS) { try { const el = document.querySelector(sel); if (el) el.style.setProperty('display', 'none', 'important'); } catch (e) {} }
      try { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; } catch (e) {}
    }

    const scheduleCookies = () => { setTimeout(rejectCookies, 500); setTimeout(rejectCookies, 2000); setTimeout(rejectCookies, 5000); };
    if (document.readyState === 'complete') scheduleCookies();
    else window.addEventListener('load', scheduleCookies);
  }

  // ═══════════════════════════════════
  // ANNOYANCE BLOCKING
  // ═══════════════════════════════════
  if (F.annoy) {
    const ANN_SEL = [
      '[class*="newsletter-popup"]','[class*="subscribe-popup"]','[class*="signup-modal"]',
      '[class*="email-popup"]','[class*="exit-intent"]','[class*="push-notification"]',
      '#intercom-container','#intercom-frame','[class*="intercom-"]',
      '#drift-widget','#hubspot-messages-iframe-container',
      '[class*="crisp-client"]','#tidio-chat','[class*="tawk-"]','[class*="freshchat"]',
      '[class*="app-banner"]','[class*="smart-banner"]','[class*="sticky-video"]',
    ];
    function hideAnnoyances() {
      for (const sel of ANN_SEL) {
        try { for (const el of document.querySelectorAll(sel)) { if (!el.dataset.za) { el.style.setProperty('display', 'none', 'important'); el.dataset.za = '1'; } } } catch (e) {}
      }
    }
    // Block notification prompts
    try { if (typeof Notification !== 'undefined') Notification.requestPermission = () => Promise.resolve('denied'); } catch (e) {}

    const scheduleAnn = () => { hideAnnoyances(); setTimeout(hideAnnoyances, 2000); setTimeout(hideAnnoyances, 6000); };
    if (document.readyState === 'complete') scheduleAnn();
    else window.addEventListener('load', scheduleAnn);
  }

  // ═══════════════════════════════════
  // CRYPTO MINER BLOCKING
  // ═══════════════════════════════════
  if (F.miner) {
    const MINER_DOMS = ['coinhive.com','coin-hive.com','crypto-loot.com','jsecoin.com','coinimp.com','minero.cc','mineralt.io','cryptonoter.com'];
    const MINER_RE = [/coinhive/i, /cryptonight/i, /cryptoloot/i, /CoinHive\./i, /deepMiner/i];
    try {
      const minerObs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeName === 'SCRIPT') {
            if (n.src && MINER_DOMS.some(d => n.src.includes(d))) { n.remove(); continue; }
            if (n.textContent && MINER_RE.some(r => r.test(n.textContent))) n.remove();
          }
        }
      });
      if (document.documentElement) minerObs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // ANTI-ADBLOCK BYPASS
  // ═══════════════════════════════════
  if (F.antiAb) {
    function bypassAntiAdblock() {
      const sels = [
        '[class*="adblock-notice"]','[class*="anti-adblock"]','[id*="adblock-message"]',
        '[class*="ad-blocker-detected"]','[class*="adblock-overlay"]',
        '[class*="adblock-modal"]','[class*="adblock-warning"]',
      ];
      for (const sel of sels) { try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {} }
      try { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; } catch (e) {}
    }
    if (document.readyState === 'complete') bypassAntiAdblock();
    else window.addEventListener('load', bypassAntiAdblock);
    setTimeout(bypassAntiAdblock, 3000);
    setTimeout(bypassAntiAdblock, 8000);
  }

  // ═══════════════════════════════════
  // ELEMENT PICKER (Right-click block)
  // ═══════════════════════════════════
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PICK_ELEMENT') {
        document.body.style.cursor = 'crosshair';
        let lastEl = null;
        function onHover(e) {
          if (lastEl) lastEl.style.outline = '';
          e.target.style.outline = '3px solid #e74c3c';
          lastEl = e.target;
        }
        function onPick(e) {
          e.preventDefault(); e.stopPropagation();
          e.target.style.outline = '';
          e.target.style.setProperty('display', 'none', 'important');
          document.body.style.cursor = 'default';
          document.removeEventListener('click', onPick, true);
          document.removeEventListener('mouseover', onHover, true);
          send({ type: 'REPORT_BLOCKED', count: 1 });
        }
        document.addEventListener('mouseover', onHover, true);
        document.addEventListener('click', onPick, true);
        document.addEventListener('keydown', function esc(e) {
          if (e.key === 'Escape') {
            if (lastEl) lastEl.style.outline = '';
            document.body.style.cursor = 'default';
            document.removeEventListener('click', onPick, true);
            document.removeEventListener('mouseover', onHover, true);
            document.removeEventListener('keydown', esc, true);
          }
        }, true);
      }
    });
  } catch (e) {}

})();
