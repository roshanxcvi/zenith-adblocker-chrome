/**
 * Zenith Scriptlets — small page-context patches that neutralize ad and
 * anti-adblock scripts.
 * by roshanxcvi
 *
 * Activated via filter rules: example.com##+js(scriptlet-name, arg1, arg2)
 *
 * v1.3.3 audit fixes:
 *   SC-01 Scriptlets are real functions, run with
 *         chrome.scripting.executeScript({ world: 'MAIN', func, args }).
 *         Before, code was built as a string and injected as an inline
 *         <script>, which (a) looks like executing arbitrary strings to a
 *         Chrome Web Store reviewer and (b) was blocked by any site whose
 *         Content-Security-Policy disallows inline scripts.
 *   SC-02 set-constant only accepts the safe value set uBlock Origin uses
 *         (true, false, null, undefined, noopFunc, trueFunc, falseFunc, '',
 *         small integers). Before it accepted any string, and a path like
 *         __proto__.__proto__.__proto__.__proto__.x let a filter list add
 *         an attacker-chosen string to Object.prototype on any site — a
 *         known way to turn a library bug into XSS.
 *   SC-03 Property paths refuse __proto__, prototype and constructor.
 *   SC-04 remove-attr refuses security attributes (sandbox, integrity,
 *         nonce, rel, ...); regex arguments go through a ReDoS check.
 *   SC-05 No "Zenith" in any error a page can see.
 *
 * Every function below runs in the page (MAIN world). Chrome serializes it,
 * so it must not use anything from this module's scope.
 */

import { isScriptletAllowed, sanitizeScriptletArgs, logError } from './security.js';

// ── Page-side functions ──────────────────────────────────────────

function setConstant(path, value) {
  try {
    const v = value === 'true' ? true
      : value === 'false' ? false
      : value === 'null' ? null
      : value === 'undefined' ? undefined
      : value === 'noopFunc' ? function () {}
      : value === 'trueFunc' ? function () { return true; }
      : value === 'falseFunc' ? function () { return false; }
      : value === '' || value === "''" ? ''
      : Number(value);
    const parts = path.split('.');
    let obj = window;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null) obj[parts[i]] = {};
      obj = obj[parts[i]];
      if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return;
    }
    Object.defineProperty(obj, parts[parts.length - 1], {
      get: () => v, set: () => {}, configurable: true,
    });
  } catch (e) {}
}

function abortOnPropertyRead(path) {
  try {
    const parts = path.split('.');
    let obj = window;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
      if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return;
    }
    const prop = parts[parts.length - 1];
    Object.defineProperty(obj, prop, {
      get: () => { throw new ReferenceError(prop + ' is not defined'); },
      set: () => {},
      configurable: false,
    });
  } catch (e) {}
}

// matcher: { re: 'source' } for /regex/ args, or { text: 'literal' }
function noAddEventListenerIf(type, matcher) {
  try {
    const orig = EventTarget.prototype.addEventListener;
    const re = matcher.re != null ? new RegExp(matcher.re) : null;
    const test = s => (re ? re.test(s) : s.includes(matcher.text));
    EventTarget.prototype.addEventListener = function (t, fn) {
      try {
        if ((!type || t === type) && fn && test(String(fn))) return;
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  } catch (e) {}
}

function noTimerIf(timerName, matcher) {
  try {
    const orig = window[timerName];
    const re = matcher.re != null ? new RegExp(matcher.re) : null;
    const test = s => (re ? re.test(s) : s.includes(matcher.text));
    window[timerName] = function (fn) {
      try {
        if (fn != null && test(String(fn))) return 0;
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  } catch (e) {}
}

function removeAttr(attr, selector) {
  try {
    const sel = selector || '[' + attr + ']';
    const remove = () => {
      try { document.querySelectorAll(sel).forEach(el => el.removeAttribute(attr)); } catch (e) {}
    };
    remove();
    new MutationObserver(remove).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: [attr],
    });
  } catch (e) {}
}

function removeClass(cls, selector) {
  try {
    const sel = selector || '.' + cls;
    const remove = () => {
      try { document.querySelectorAll(sel).forEach(el => el.classList.remove(cls)); } catch (e) {}
    };
    remove();
    new MutationObserver(remove).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    });
  } catch (e) {}
}

function fakeGoogleAnalytics() {
  try {
    const noop = function () {};
    const tracker = { send: noop, set: noop, get: noop };
    const ga = function () {};
    ga.create = function () { return tracker; };
    ga.getByName = function () { return tracker; };
    ga.getAll = function () { return []; };
    ga.remove = noop;
    ga.loaded = true;
    window.ga = window.ga || ga;
    window.gtag = window.gtag || noop;
    window.dataLayer = window.dataLayer || [];
  } catch (e) {}
}

function fakeGoogletag() {
  try {
    const noop = function () {};
    const slot = { addService() { return this; }, setTargeting() { return this; }, defineSizeMapping() { return this; } };
    const pubads = { enableSingleRequest: noop, collapseEmptyDivs: noop, refresh: noop, addEventListener: noop, setTargeting() { return this; }, disableInitialLoad: noop };
    const gt = window.googletag = window.googletag || {};
    const queued = Array.isArray(gt.cmd) ? gt.cmd : [];
    gt.cmd = { push(fn) { try { fn(); } catch (e) {} return 1; } };
    gt.defineSlot = function () { return slot; };
    gt.defineOutOfPageSlot = function () { return slot; };
    gt.pubads = function () { return pubads; };
    gt.enableServices = noop;
    gt.display = noop;
    gt.destroySlots = noop;
    queued.forEach(fn => { try { fn(); } catch (e) {} });
  } catch (e) {}
}

function fakeFacebookPixel() {
  try {
    const fbq = function () {};
    fbq.callMethod = function () {};
    fbq.queue = [];
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    window.fbq = window.fbq || fbq;
    window._fbq = window._fbq || window.fbq;
  } catch (e) {}
}

// name → page function. Kept under the old export name for compatibility.
export const SCRIPTLETS = Object.freeze({
  'set-constant': setConstant,
  'abort-on-property-read': abortOnPropertyRead,
  'no-addEventListener-if': noAddEventListenerIf,
  'no-setTimeout-if': noTimerIf,
  'no-setInterval-if': noTimerIf,
  'remove-attr': removeAttr,
  'remove-class': removeClass,
  'google-analytics': fakeGoogleAnalytics,
  'googletagservices': fakeGoogletag,
  'facebook-pixel': fakeFacebookPixel,
});

// ── Argument validation (runs in the service worker) ─────────────

const IDENT = /^[A-Za-z_$][\w$]*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function validPath(path) {
  if (typeof path !== 'string' || !path || path.length > 120) return false;
  const parts = path.split('.');
  if (parts.length > 8) return false;
  return parts.every(p => IDENT.test(p) && !FORBIDDEN_SEGMENTS.has(p));
}

const SAFE_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'noopFunc', 'trueFunc', 'falseFunc', '', "''"]);

function validConstant(value) {
  if (SAFE_CONSTANTS.has(value)) return true;
  if (!/^-?\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= -1 && n <= 32767;
}

const DANGEROUS_REGEX = [
  /\([^)]*[+*][^)]*\)\s*[+*{]/,   // (a+)+  (a*)*  (a+){2,}
  /\([^)]*\|[^)]*\)\s*[+*{]/,     // (a|aa)+
  /[+*]\s*[+*]/,                  // a*+
  /\{\d{3,}/,                     // {1000}
];

// uBO semantics: /.../ is a regex, anything else is a literal substring.
function toMatcher(arg) {
  const s = String(arg || '');
  if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) {
    const src = s.slice(1, -1);
    if (src.length > 200 || DANGEROUS_REGEX.some(d => d.test(src))) return null;
    try { new RegExp(src); } catch (e) { return null; }
    return { re: src };
  }
  return { text: s };
}

const PROTECTED_ATTRS = new Set([
  'sandbox', 'integrity', 'nonce', 'csp', 'crossorigin', 'referrerpolicy',
  'rel', 'http-equiv', 'content', 'allow', 'credentialless', 'srcdoc',
]);

function validAttr(attr) {
  return typeof attr === 'string' && /^[a-z][a-z0-9_:-]{0,49}$/i.test(attr) && !PROTECTED_ATTRS.has(attr.toLowerCase());
}

function validSelector(sel) {
  return typeof sel === 'string' && sel.length <= 200 && !/[{};@]|<\/?style/i.test(sel);
}

/**
 * Turn a parsed rule into { func, args } for chrome.scripting.executeScript,
 * or null if the name isn't allowlisted or the arguments aren't safe.
 */
export function prepareScriptlet(name, rawArgs) {
  if (!isScriptletAllowed(name)) {
    logError('scriptlet:rejected', `Refused non-allowlisted scriptlet: ${name}`);
    return null;
  }
  const func = SCRIPTLETS[name];
  if (!func) return null;
  const a = sanitizeScriptletArgs(rawArgs);

  switch (name) {
    case 'set-constant':
      if (!validPath(a[0]) || !validConstant(a[1] ?? '')) return null;
      return { func, args: [a[0], a[1] ?? ''] };
    case 'abort-on-property-read':
      if (!validPath(a[0])) return null;
      return { func, args: [a[0]] };
    case 'no-addEventListener-if': {
      const type = a[0] || '';
      if (type && !/^[a-z][a-z0-9_-]{0,39}$/i.test(type)) return null;
      const m = toMatcher(a[1] || '');
      return m ? { func, args: [type, m] } : null;
    }
    case 'no-setTimeout-if':
    case 'no-setInterval-if': {
      const m = toMatcher(a[0] || '');
      const timer = name === 'no-setTimeout-if' ? 'setTimeout' : 'setInterval';
      return m ? { func, args: [timer, m] } : null;
    }
    case 'remove-attr':
      if (!validAttr(a[0]) || (a[1] && !validSelector(a[1]))) return null;
      return { func, args: [a[0], a[1] || ''] };
    case 'remove-class':
      if (!/^[\w-]{1,60}$/.test(a[0] || '') || (a[1] && !validSelector(a[1]))) return null;
      return { func, args: [a[0], a[1] || ''] };
    default:
      return { func, args: [] };
  }
}

/**
 * @deprecated Scriptlets are no longer built as code strings. Kept so old
 * imports don't break; always returns null. Use prepareScriptlet().
 */
export function buildScriptletCode() {
  return null;
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
