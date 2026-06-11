/**
 * Zenith Scriptlets — Pre-built code injections to neutralize ad/anti-adblock scripts
 * by roshanxcvi
 *
 * Each scriptlet is a string of JS code that runs in the page context.
 * Activated via filter rules: example.com##+js(scriptlet-name, arg1, arg2)
 *
 * v1.2 SECURITY:
 *   - buildScriptletCode() is gated by SCRIPTLET_ALLOWLIST (security.js)
 *   - args are sanitized via sanitizeScriptletArgs() before string interpolation
 *   - Filter list sanitizer strips scriptlet rules using non-allowlisted names
 *     BEFORE they reach the parser, so there's nothing for a remote list
 *     to inject even if the SCRIPTLETS map were extended unsafely.
 */

import { isScriptletAllowed, sanitizeScriptletArgs, logError } from './security.js';

export const SCRIPTLETS = {
  // Replace functions with no-ops
  'set-constant': `(function(name, value) {
    try {
      const v = value === 'true' ? true : value === 'false' ? false : value === 'null' ? null : value === 'undefined' ? undefined : value === 'noopFunc' ? function(){} : value === 'trueFunc' ? function(){return true} : value === 'falseFunc' ? function(){return false} : isNaN(+value) ? value : +value;
      const parts = name.split('.');
      let obj = window;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      Object.defineProperty(obj, parts[parts.length - 1], { get: () => v, set: () => {}, configurable: true });
    } catch(e) {}
  })`,

  // Prevent anti-adblock detection
  'abort-on-property-read': `(function(name) {
    try {
      const parts = name.split('.');
      let obj = window;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) return;
        obj = obj[parts[i]];
      }
      Object.defineProperty(obj, parts[parts.length - 1], { get: () => { throw new ReferenceError(name + ' blocked by Zenith'); }, configurable: false });
    } catch(e) {}
  })`,

  // Block specific addEventListener
  'no-addEventListener-if': `(function(type, pattern) {
    try {
      const orig = EventTarget.prototype.addEventListener;
      const re = new RegExp(pattern);
      EventTarget.prototype.addEventListener = function(t, fn) {
        if (t === type && fn && re.test(fn.toString())) return;
        return orig.apply(this, arguments);
      };
    } catch(e) {}
  })`,

  // Block setTimeout if callback matches
  'no-setTimeout-if': `(function(pattern) {
    try {
      const orig = window.setTimeout;
      const re = new RegExp(pattern);
      window.setTimeout = function(fn, t) {
        if (typeof fn === 'function' && re.test(fn.toString())) return;
        return orig.apply(this, arguments);
      };
    } catch(e) {}
  })`,

  // Block setInterval if callback matches
  'no-setInterval-if': `(function(pattern) {
    try {
      const orig = window.setInterval;
      const re = new RegExp(pattern);
      window.setInterval = function(fn, t) {
        if (typeof fn === 'function' && re.test(fn.toString())) return;
        return orig.apply(this, arguments);
      };
    } catch(e) {}
  })`,

  // Remove an attribute from elements
  'remove-attr': `(function(attr, selector) {
    try {
      const remove = () => document.querySelectorAll(selector || '*').forEach(el => el.removeAttribute(attr));
      remove();
      new MutationObserver(remove).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch(e) {}
  })`,

  // Remove a class
  'remove-class': `(function(cls, selector) {
    try {
      const remove = () => document.querySelectorAll(selector || '.' + cls).forEach(el => el.classList.remove(cls));
      remove();
      new MutationObserver(remove).observe(document.documentElement, { childList: true, subtree: true });
    } catch(e) {}
  })`,

  // Fake Google Analytics
  'google-analytics': `(function() {
    try {
      window.ga = function(){};
      window.ga.create = function(){ return { send: function(){} }; };
      window.ga.getByName = function(){ return { send: function(){} }; };
      window.ga.getAll = function(){ return []; };
      window.ga.remove = function(){};
      window.gtag = function(){};
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push = function(){};
    } catch(e) {}
  })`,

  // Fake Google Publisher Tag (for AdSense bypass)
  'googletagservices': `(function() {
    try {
      window.googletag = window.googletag || {};
      window.googletag.cmd = window.googletag.cmd || [];
      window.googletag.cmd.push = function(fn) { try { fn(); } catch(e){} };
      window.googletag.defineSlot = function(){ return { addService: function(){return this}, setTargeting: function(){return this} }; };
      window.googletag.pubads = function(){ return { enableSingleRequest: function(){}, collapseEmptyDivs: function(){}, refresh: function(){}, addEventListener: function(){} }; };
      window.googletag.enableServices = function(){};
      window.googletag.display = function(){};
    } catch(e) {}
  })`,

  // Fake Facebook Pixel
  'facebook-pixel': `(function() {
    try {
      window.fbq = function(){};
      window.fbq.callMethod = function(){};
      window.fbq.queue = [];
      window._fbq = window.fbq;
    } catch(e) {}
  })`,
};

/**
 * Build a complete scriptlet payload from a filter rule.
 * SECURITY: gated by SCRIPTLET_ALLOWLIST + arg length/char sanitization.
 *
 * Returns null if the scriptlet name is not allowlisted.
 * Example rule: ##+js(set-constant, ads.loaded, true)
 */
export function buildScriptletCode(scriptletName, args) {
  // Defense in depth — allowlist check even though sanitizeFilterList
  // already strips non-allowlisted scriptlet rules upstream.
  if (!isScriptletAllowed(scriptletName)) {
    logError('scriptlet:rejected', `Refused non-allowlisted scriptlet: ${scriptletName}`);
    return null;
  }
  const fn = SCRIPTLETS[scriptletName];
  if (!fn) return null;
  const safeArgs = sanitizeScriptletArgs(args);
  const argStr = safeArgs.map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
  return `(${fn})(${argStr});`;
}

/**
 * Parse a scriptlet filter rule
 * Format: ##+js(name, arg1, arg2)  or  ##+js(name)
 */
export function parseScriptletRule(rule) {
  const match = rule.match(/##\+js\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(',').map(s => s.trim());
  return { name: parts[0], args: parts.slice(1) };
}
