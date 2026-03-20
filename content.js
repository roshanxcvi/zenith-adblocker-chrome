/**
 * Zenith AdBlocker — Content Script (Chrome Only)
 * by roshanxcvi
 *
 * ULTRA-LIGHTWEIGHT DESIGN:
 * - CSS stylesheet hides ALL ads (zero JS overhead per frame)
 * - NO MutationObserver for ad counting (biggest perf killer)
 * - Count hidden elements only TWICE: on load + 3 sec after
 * - Miner observer only watches <head> not entire DOM
 * - Annoyances + anti-adblock are CSS-only
 * - Total JS work on YouTube: near zero
 */

(async function () {
  'use strict';

  const hostname = window.location.hostname;
  if (!hostname) return;

  function send(data) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage(data, r => resolve(r || null)); }
      catch (e) { resolve(null); }
    });
  }

  const state = await send({ type: 'GET_STATE' });
  if (!state || !state.enabled) return;
  if (state.whitelist && state.whitelist.some(d => hostname.includes(d))) return;

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
      (document.head || document.documentElement)?.appendChild(s);
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // AD BLOCKING — 100% CSS, minimal JS
  // ═══════════════════════════════════
  if (F.ads) {
    let selectors = [];
    try {
      const r = await send({ type: 'GET_COSMETIC_FILTERS', hostname });
      if (r && r.selectors) selectors = r.selectors;
    } catch (e) {}

    const BUILTIN = [
      'ins.adsbygoogle','[id^="google_ads"]','[id^="div-gpt-ad"]','[data-google-query-id]',
      '[data-ad-slot]','[data-ad-client]',
      '.ad-banner','.ad-container','.ad-wrapper','.ad-slot','.ad-unit','.ad-placement',
      '.ad-leaderboard','.ad-sidebar','.ad-footer','.ad-header','.ad-box',
      '.advertisement','.advertise',
      '.sponsored-content','.sponsored','.promoted-post','.promoted',
      '[id*="taboola"]','[class*="taboola"]','[id*="outbrain"]','[class*="outbrain"]','.OUTBRAIN',
      '.dfp-ad','[class*="gpt-ad"]','[data-native-ad]',
      '.sidebar-ad','.sticky-ad','.floating-ad','.interstitial-ad','.overlay-ad',
      'iframe[src*="doubleclick"]','iframe[src*="googlesyndication"]','iframe[src*="amazon-adsystem"]',
      'iframe[id*="google_ads"]',
    ];

    const allSel = [...new Set([...selectors, ...BUILTIN])];

    // CSS does ALL the hiding — zero JS cost per frame
    try {
      const style = document.createElement('style');
      style.id = 'zenith-hide';
      style.textContent = allSel.map(s =>
        `${s}{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}`
      ).join('\n');
      (document.head || document.documentElement)?.appendChild(style);
    } catch (e) {}

    // Count hidden elements only TWICE (not continuously)
    // This is just for the badge number — CSS already hid everything
    const countSelector = allSel.join(',');

    function countOnce() {
      try {
        const count = document.querySelectorAll(countSelector).length;
        if (count > 0) send({ type: 'REPORT_BLOCKED', count });
      } catch (e) {}
    }

    // Count after DOM is ready, and once more after dynamic content loads
    if (document.readyState === 'complete') {
      setTimeout(countOnce, 500);
      setTimeout(countOnce, 3000);
    } else {
      window.addEventListener('load', () => {
        setTimeout(countOnce, 500);
        setTimeout(countOnce, 3000);
      });
    }
  }

  // ═══════════════════════════════════
  // COOKIE AUTO-REJECT
  // ═══════════════════════════════════
  if (F.cookie) {
    const REJECT_BTNS = [
      '#onetrust-reject-all-handler','#CybotCookiebotDialogBodyButtonDecline',
      '#didomi-notice-disagree-button','.qc-cmp2-summary-buttons button[mode="secondary"]',
      'button[aria-label*="reject"]','button[aria-label*="deny"]','button[aria-label*="decline"]',
    ];
    const BANNERS = [
      '#onetrust-banner-sdk','#CybotCookiebotDialog','.truste_overlay','.qc-cmp2-container',
      '#didomi-host','[class*="cookie-banner"]','[class*="cookie-consent"]',
      '[class*="cookie-notice"]','[id*="cookie-consent"]','[class*="gdpr"]',
      '[class*="consent-banner"]','[class*="cc-window"]','.fc-consent-root',
    ];
    const RE = [/^reject\s*(all)?$/i,/^deny\s*(all)?$/i,/^decline\s*(all)?$/i,/^no,?\s*thanks?$/i,/^only\s*(essential|necessary)/i];

    function rejectCookies() {
      for (const sel of REJECT_BTNS) {
        try { const b = document.querySelector(sel); if (b && b.offsetParent !== null) { b.click(); return; } } catch (e) {}
      }
      for (const btn of document.querySelectorAll('button, a[role="button"]')) {
        const t = (btn.textContent || '').trim();
        if (t.length > 50) continue;
        if (RE.some(r => r.test(t)) && btn.offsetParent !== null) { btn.click(); return; }
      }
      for (const sel of BANNERS) { try { const el = document.querySelector(sel); if (el) el.style.setProperty('display','none','important'); } catch (e) {} }
      try { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; } catch (e) {}
    }

    const schedule = () => { setTimeout(rejectCookies, 800); setTimeout(rejectCookies, 3000); };
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule);
  }

  // ═══════════════════════════════════
  // ANNOYANCE BLOCKING — CSS only
  // ═══════════════════════════════════
  if (F.annoy) {
    try {
      const style = document.createElement('style');
      style.id = 'zenith-annoy';
      style.textContent = [
        '[class*="newsletter-popup"]','[class*="subscribe-popup"]','[class*="signup-modal"]',
        '[class*="email-popup"]','[class*="exit-intent"]','[class*="push-notification"]',
        '#intercom-container','#intercom-frame','[class*="intercom-"]',
        '#drift-widget','#hubspot-messages-iframe-container',
        '[class*="crisp-client"]','#tidio-chat','[class*="tawk-"]','[class*="freshchat"]',
        '[class*="app-banner"]','[class*="smart-banner"]','[class*="sticky-video"]',
      ].map(s => `${s}{display:none!important}`).join('\n');
      (document.head || document.documentElement)?.appendChild(style);
    } catch (e) {}
    try { if (typeof Notification !== 'undefined') Notification.requestPermission = () => Promise.resolve('denied'); } catch (e) {}
  }

  // ═══════════════════════════════════
  // CRYPTO MINER BLOCKING — lightweight
  // Only watches <head> for script tags, not entire DOM
  // ═══════════════════════════════════
  if (F.miner) {
    const MINERS = ['coinhive.com','coin-hive.com','crypto-loot.com','jsecoin.com','coinimp.com','minero.cc','mineralt.io','cryptonoter.com'];
    try {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeName === 'SCRIPT' && n.src && MINERS.some(d => n.src.includes(d))) n.remove();
        }
      });
      // Only watch <head> — miners inject scripts there, not in body
      const target = document.head || document.documentElement;
      if (target) obs.observe(target, { childList: true });
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // ANTI-ADBLOCK — CSS only
  // ═══════════════════════════════════
  if (F.antiAb) {
    try {
      const style = document.createElement('style');
      style.id = 'zenith-antiab';
      style.textContent = [
        '[class*="adblock-notice"]','[class*="anti-adblock"]','[id*="adblock-message"]',
        '[class*="ad-blocker-detected"]','[class*="adblock-overlay"]',
        '[class*="adblock-modal"]','[class*="adblock-warning"]',
      ].map(s => `${s}{display:none!important}`).join('\n');
      (document.head || document.documentElement)?.appendChild(style);
    } catch (e) {}
    setTimeout(() => { try { document.body.style.overflow=''; document.documentElement.style.overflow=''; } catch(e){} }, 3000);
  }

  // ═══════════════════════════════════
  // ELEMENT PICKER
  // ═══════════════════════════════════
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PICK_ELEMENT') {
        document.body.style.cursor = 'crosshair';
        let last = null;
        const hover = (e) => { if (last) last.style.outline=''; e.target.style.outline='3px solid #e74c3c'; last=e.target; };
        const pick = (e) => {
          e.preventDefault(); e.stopPropagation();
          e.target.style.outline=''; e.target.style.setProperty('display','none','important');
          document.body.style.cursor='default';
          document.removeEventListener('click',pick,true); document.removeEventListener('mouseover',hover,true);
          send({ type:'REPORT_BLOCKED', count:1 });
        };
        document.addEventListener('mouseover',hover,true);
        document.addEventListener('click',pick,true);
        document.addEventListener('keydown', function esc(e) {
          if (e.key==='Escape') { if(last)last.style.outline=''; document.body.style.cursor='default'; document.removeEventListener('click',pick,true); document.removeEventListener('mouseover',hover,true); document.removeEventListener('keydown',esc,true); }
        }, true);
      }
    });
  } catch (e) {}

})();
