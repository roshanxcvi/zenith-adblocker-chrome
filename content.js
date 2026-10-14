/**
 * Zenith AdBlocker — Content Script (Chrome Only)
 * by roshanxcvi
 *
 * v1.3.3 audit fixes:
 *   CS-01 No chrome.storage access here. Storage is locked to extension
 *         pages; GET_STATE returns the settings this script needs, plus a
 *         per-site fingerprint seed computed by the service worker.
 *   CS-02 Hiding CSS is applied by the service worker with insertCSS
 *         (INSERT_CSS). Pages can't see it or delete it. Before, a page
 *         could run document.getElementById('zenith-hide').remove() to
 *         undo all cosmetic filtering, and the id told it Zenith was there.
 *   CS-03 Scriptlets are requested first, so they run before most page
 *         scripts.
 *   CS-04 YouTube check uses a dot-anchored domain match.
 *   CS-05 Removed the Notification.requestPermission override: it ran in
 *         this isolated world, so pages never saw it (it never worked).
 */

(async function () {
  'use strict';

  const hostname = window.location.hostname;
  if (!hostname) return;

  function domainMatches(hostname, ruleDomain) {
    if (!hostname || !ruleDomain) return false;
    const h = String(hostname).toLowerCase().replace(/^www\./, '');
    const r = String(ruleDomain).toLowerCase().replace(/^www\./, '');
    return h === r || h.endsWith('.' + r);
  }

  function send(data) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(data, r => {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Apply CSS as a user stylesheet via the service worker; fall back to a
  // plain <style> (no id) if that fails.
  async function applyCss(css) {
    if (!css) return;
    const r = await send({ type: 'INSERT_CSS', css });
    if (r && r.ok) return;
    try {
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement)?.appendChild(style);
    } catch (e) {}
  }

  const state = await send({ type: 'GET_STATE' });
  if (!state || !state.enabled || state.whitelisted) return;

  const siteSettings = state.siteSettings || {};
  if (siteSettings.enabled === false) return;

  const settings = state.proSettings || {};
  const F = {
    ads: settings.adBlocking !== false && siteSettings.ads !== false,
    fp: settings.fingerprintProtection !== false && siteSettings.fingerprinting !== false,
    cookie: settings.cookieAutoReject !== false && siteSettings.cookie !== false,
    annoy: settings.annoyanceBlocking !== false && siteSettings.annoyances !== false,
    miner: settings.minerBlocking !== false && siteSettings.miners !== false,
    antiAb: settings.antiAdblock !== false,
  };

  const isYouTube = domainMatches(hostname, 'youtube.com');

  // ═══════════════════════════════════
  // FINGERPRINT PROTECTION
  // ═══════════════════════════════════
  // The seed is already per-site (HMAC of the install seed and this origin,
  // computed in the service worker).
  if (F.fp) {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('fingerprint.js');
      if (state.fpSeed) s.dataset.v = state.fpSeed;
      s.onload = () => s.remove();
      (document.head || document.documentElement)?.appendChild(s);
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // SCRIPTLETS — injected by the service worker as real functions
  // (chrome.scripting.executeScript, CSP-safe). Ask first so they run early.
  // ═══════════════════════════════════
  if (F.ads) send({ type: 'INJECT_SCRIPTLETS', hostname });

  // ═══════════════════════════════════
  // AD BLOCKING
  // ═══════════════════════════════════
  if (F.ads) {
    let selectors = [];
    try {
      const r = await send({ type: 'GET_COSMETIC_FILTERS', hostname });
      if (r && Array.isArray(r.selectors)) selectors = r.selectors;
    } catch (e) {}

    // ═══════════════════════════════════
    // PROCEDURAL COSMETIC FILTERS
    // (:has-text, :upward, :matches-css, etc.)
    // ═══════════════════════════════════
    try {
      const procResp = await send({ type: 'GET_PROCEDURAL_FILTERS', hostname });
      if (procResp && procResp.filters && procResp.filters.length > 0) {
        const startProcedural = async () => {
          try {
            const mod = await import(chrome.runtime.getURL('modules/procedural-filters.js'));
            const proc = new mod.ProceduralFilters();
            for (const f of procResp.filters) proc.add(f);
            proc.observe(1500);
          } catch (e) {}
        };
        if (document.readyState === 'complete') startProcedural();
        else window.addEventListener('load', startProcedural);
      }
    } catch (e) {}

    // Generic selectors — SAFE on all sites including YouTube
    const GENERIC = [
      'ins.adsbygoogle',
      '[id^="google_ads"]',
      '[id^="div-gpt-ad"]',
      '[data-google-query-id]',
      '[data-ad-slot]',
      '[data-ad-client]',
      '[data-native-ad]',
      '[class*="gpt-ad"]',
      '.dfp-ad',
      'iframe[src*="doubleclick"]',
      'iframe[src*="googlesyndication"]',
      'iframe[src*="amazon-adsystem"]',
      'iframe[id*="google_ads"]',
      '.OUTBRAIN',
      '[id*="taboola"]',
      '[class*="taboola"]',
      '[id*="outbrain"]',
      '[class*="outbrain"]',
    ];

    // Too generic for YouTube (can match its UI)
    const NON_YOUTUBE_ONLY = [
      '.ad-banner','.ad-container','.ad-wrapper','.ad-slot','.ad-unit',
      '.ad-placement','.ad-leaderboard','.ad-sidebar','.ad-footer','.ad-box',
      '.advertisement','.advertise',
      '.sponsored-content','.sponsored','.promoted-post','.promoted',
      '.sidebar-ad','.sticky-ad','.floating-ad','.interstitial-ad','.overlay-ad',
    ];

    let allSel = [...new Set([...selectors, ...GENERIC])];
    if (!isYouTube) allSel = [...new Set([...allSel, ...NON_YOUTUBE_ONLY])];

    // CI-01 — validate selectors BEFORE building CSS and reject anything
    // that could break out of a CSS rule ({ } @ ; or </style), then require
    // querySelector() to accept it.
    const CSS_BREAKOUT = /[{}@;]|<\/?style/i;
    const validSelectors = [];
    for (const s of allSel) {
      if (typeof s !== 'string' || !s.trim()) continue;
      if (s.length > 500) continue;
      if (CSS_BREAKOUT.test(s)) continue;
      try {
        document.querySelector(s);
        validSelectors.push(s);
      } catch (_) {}
    }

    // Grouped rules (50 selectors each) keep the stylesheet small; each
    // selector was validated above, so one group can't break another.
    const HIDE = '{display:none!important}';
    const groups = [];
    for (let i = 0; i < validSelectors.length; i += 50) {
      groups.push(validSelectors.slice(i, i + 50).join(',\n') + HIDE);
    }
    let css = groups.join('\n');

    // YouTube-specific: SCOPED to safe containers only
    if (isYouTube) {
      css += `
.ytp-ad-module,.ytp-ad-overlay-slot,.ytp-ad-overlay-container,.ytp-ad-text-overlay,
.ytp-ad-message-slot,.ytp-ad-image-overlay,.video-ads{display:none!important}
#contents ytd-ad-slot-renderer,#contents ytd-promoted-sparkles-web-renderer,
#contents ytd-promoted-video-renderer,#contents ytd-in-feed-ad-layout-renderer,
#contents ytd-display-ad-renderer,#related ytd-promoted-sparkles-web-renderer,
#related ytd-ad-slot-renderer,#below ytd-ad-slot-renderer{display:none!important}
#player-ads,#player ytd-player-legacy-desktop-watch-ads-renderer,
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]{display:none!important}
#masthead-ad,ytd-video-masthead-ad-v3-renderer{display:none!important}
#content .ytd-mealbar-promo-renderer,#content ytd-primetime-promo-renderer{display:none!important}
`;
    }

    applyCss(css);

    const countSelector = validSelectors.join(',');

    function countOnce() {
      if (!countSelector) return;
      try {
        const count = document.querySelectorAll(countSelector).length;
        if (count > 0) send({ type: 'REPORT_BLOCKED', count });
      } catch (e) {}
    }
    if (document.readyState === 'complete') {
      setTimeout(countOnce, 500);
      setTimeout(countOnce, 3000);
    } else {
      window.addEventListener('load', () => {
        setTimeout(countOnce, 500);
        setTimeout(countOnce, 3000);
      });
    }

    // YouTube ad killer — only on youtube.com
    if (isYouTube) {
      let ytInterval = null;
      let ytObserver = null;

      function killYouTubeAd() {
        let killed = 0;
        const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
        if (skip) { skip.click(); killed++; }
        const video = document.querySelector('video.html5-main-video');
        if (video && document.querySelector('.ad-showing')) {
          if (video.duration > 0 && video.currentTime < video.duration - 0.5) {
            video.currentTime = video.duration;
          }
          video.muted = true;
          killed++;
        }
        const close = document.querySelector('.ytp-ad-overlay-close-button');
        if (close) { close.click(); killed++; }
        if (killed > 0) send({ type: 'REPORT_BLOCKED', count: killed });
      }

      function startYT() {
        const player = document.querySelector('#movie_player');
        if (!player) { setTimeout(startYT, 2000); return; }

        try { if (ytObserver) ytObserver.disconnect(); } catch (_) {}
        if (ytInterval) { clearInterval(ytInterval); ytInterval = null; }

        ytObserver = new MutationObserver(() => {
          if (player.classList.contains('ad-showing')) killYouTubeAd();
        });
        ytObserver.observe(player, { attributes: true, attributeFilter: ['class'] });

        ytInterval = setInterval(() => {
          if (document.querySelector('.ad-showing')) killYouTubeAd();
        }, 1500);
      }

      window.addEventListener('pagehide', () => {
        try { if (ytObserver) ytObserver.disconnect(); } catch (_) {}
        if (ytInterval) { clearInterval(ytInterval); ytInterval = null; }
      });

      if (document.readyState === 'complete') setTimeout(startYT, 1000);
      else window.addEventListener('load', () => setTimeout(startYT, 1000));
    }
  }

  // ═══════════════════════════════════
  // COOKIE AUTO-REJECT
  // ═══════════════════════════════════
  if (F.cookie) {
    const BTNS = [
      '#onetrust-reject-all-handler','#CybotCookiebotDialogBodyButtonDecline',
      '#didomi-notice-disagree-button','.qc-cmp2-summary-buttons button[mode="secondary"]',
    ];
    const BANNERS = [
      '#onetrust-banner-sdk','#CybotCookiebotDialog','.truste_overlay','.qc-cmp2-container',
      '#didomi-host','[class*="cookie-banner"]','[class*="cookie-consent"]',
      '[class*="cookie-notice"]','[id*="cookie-consent"]','[class*="gdpr"]',
      '[class*="consent-banner"]','[class*="cc-window"]','.fc-consent-root',
      '[role="dialog"][aria-label*="cookie" i]','[role="dialog"][aria-label*="consent" i]',
    ];
    const RE = [/^reject\s*(all)?$/i,/^deny\s*(all)?$/i,/^decline\s*(all)?$/i,/^no,?\s*thanks?$/i,/^only\s*(essential|necessary)/i];

    function isSafeToClick(b) {
      if (!b || b.offsetParent === null) return false;
      const evtAttrs = ['onclick','onmousedown','onmouseup','onpointerdown','onpointerup','onauxclick'];
      for (const a of evtAttrs) if (b.hasAttribute(a)) return false;
      if (b.tagName === 'A' && b.href) {
        try {
          const u = new URL(b.href, location.href);
          if (u.origin !== location.origin && !u.href.startsWith('javascript:void')) return false;
          if (u.href.startsWith('javascript:') && !u.href.startsWith('javascript:void')) return false;
        } catch (e) { return false; }
      }
      return true;
    }

    function reject() {
      for (const s of BTNS) {
        try {
          const b = document.querySelector(s);
          if (b && b.offsetParent !== null) { b.click(); return; }
        } catch (e) {}
      }

      const bannerEls = [];
      for (const s of BANNERS) {
        try {
          for (const e of document.querySelectorAll(s)) bannerEls.push(e);
        } catch (e) {}
      }
      for (const banner of bannerEls) {
        const candidates = banner.querySelectorAll('button, a[role="button"], [role="button"]');
        for (const b of candidates) {
          const t = (b.textContent || '').trim();
          if (t.length === 0 || t.length > 50) continue;
          if (RE.some(r => r.test(t)) && isSafeToClick(b)) { b.click(); return; }
        }
        const ariaBtns = banner.querySelectorAll('button[aria-label*="reject" i], button[aria-label*="deny" i], button[aria-label*="decline" i]');
        for (const b of ariaBtns) {
          if (isSafeToClick(b)) { b.click(); return; }
        }
      }

      for (const s of BANNERS) {
        try {
          const e = document.querySelector(s);
          if (e) e.style.setProperty('display','none','important');
        } catch (e) {}
      }
      try { document.body.style.overflow=''; document.documentElement.style.overflow=''; } catch (e) {}
    }
    const go = () => { setTimeout(reject, 800); setTimeout(reject, 3000); };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
  }

  // ═══════════════════════════════════
  // ANNOYANCE BLOCKING — CSS only, skip on YouTube
  // ═══════════════════════════════════
  if (F.annoy && !isYouTube) {
    applyCss([
      '[class*="newsletter-popup"]','[class*="subscribe-popup"]','[class*="signup-modal"]',
      '[class*="email-popup"]','[class*="exit-intent"]','[class*="push-notification"]',
      '#intercom-container','#intercom-frame','[class*="intercom-"]',
      '#drift-widget','#hubspot-messages-iframe-container',
      '[class*="crisp-client"]','#tidio-chat','[class*="tawk-"]','[class*="freshchat"]',
      '[class*="app-banner"]','[class*="smart-banner"]','[class*="sticky-video"]',
    ].join(',\n') + '{display:none!important}');
  }

  // ═══════════════════════════════════
  // CRYPTO MINER — watches <head> only
  // ═══════════════════════════════════
  if (F.miner) {
    const M = ['coinhive.com','coin-hive.com','crypto-loot.com','jsecoin.com','coinimp.com','minero.cc','mineralt.io','cryptonoter.com'];
    try {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeName === 'SCRIPT' && n.src && M.some(d => n.src.includes(d))) n.remove();
        }
      });
      if (document.head) obs.observe(document.head, { childList: true });
    } catch(e){}
  }

  // ═══════════════════════════════════
  // ANTI-ADBLOCK — CSS only, skip on YouTube
  // ═══════════════════════════════════
  if (F.antiAb && !isYouTube) {
    applyCss([
      '[class*="adblock-notice"]','[class*="anti-adblock"]','[id*="adblock-message"]',
      '[class*="ad-blocker-detected"]','[class*="adblock-overlay"]',
      '[class*="adblock-modal"]','[class*="adblock-warning"]',
    ].join(',\n') + '{display:none!important}');
    setTimeout(() => { try { document.body.style.overflow=''; document.documentElement.style.overflow=''; } catch(e){} }, 3000);
  }

  // ═══════════════════════════════════
  // ELEMENT PICKER
  // ═══════════════════════════════════
  try {
    const STRUCTURAL = new Set(['HTML','HEAD','BODY','MAIN']);
    function isStructural(el) {
      if (!el || !el.tagName) return true;
      if (STRUCTURAL.has(el.tagName)) return true;
      try { if (el.contains(document.body)) return true; } catch (e) {}
      return false;
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'PICK_ELEMENT') {
        document.body.style.cursor = 'crosshair';
        let last = null;
        const hover = (e) => {
          if (last) last.style.outline = '';
          if (isStructural(e.target)) { last = null; return; }
          e.target.style.outline = '3px solid #e74c3c';
          last = e.target;
        };
        const pick = (e) => {
          e.preventDefault(); e.stopPropagation();
          const target = e.target;
          if (isStructural(target)) {
            document.body.style.cursor = 'default';
            document.removeEventListener('click', pick, true);
            document.removeEventListener('mouseover', hover, true);
            return;
          }
          target.style.outline = '';
          target.style.setProperty('display', 'none', 'important');
          document.body.style.cursor = 'default';
          document.removeEventListener('click', pick, true);
          document.removeEventListener('mouseover', hover, true);
          send({ type: 'REPORT_BLOCKED', count: 1 });
        };
        document.addEventListener('mouseover', hover, true);
        document.addEventListener('click', pick, true);
        document.addEventListener('keydown', function esc(e) {
          if (e.key === 'Escape') {
            if (last) last.style.outline = '';
            document.body.style.cursor = 'default';
            document.removeEventListener('click', pick, true);
            document.removeEventListener('mouseover', hover, true);
            document.removeEventListener('keydown', esc, true);
          }
        }, true);
      }
    });
  } catch (e) {}

})();
