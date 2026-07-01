/**
 * Zenith Security Utilities
 * by roshanxcvi
 *
 * Centralized security functions. Every security-sensitive path
 * (filter list parsing, scriptlet injection, message handling, URL parsing)
 * goes through this module so we have ONE place to audit.
 */

// ════════════════════════════════════════════════════════════════
// DEBUG LOGGING — replaces silent catch(e){} blocks
// ════════════════════════════════════════════════════════════════
//
// Toggle this to true during development. In production we still see
// the error but it's namespaced so it doesn't pollute the page console.

export const DEBUG = false;

export function logError(where, err) {
  if (DEBUG) console.warn(`[Zenith:${where}]`, err);
  // Even when DEBUG is off, we silently track the count so /debug page
  // can show "247 errors suppressed". Best of both worlds.
  try {
    self.__zenithErrorCount = (self.__zenithErrorCount || 0) + 1;
    self.__zenithLastError = { where, message: String(err?.message || err), ts: Date.now() };
  } catch (_) {}
}

// ════════════════════════════════════════════════════════════════
// FIX #2 — SCRIPTLET ALLOWLIST
// ════════════════════════════════════════════════════════════════
//
// The ONLY scriptlet names we will ever build code for. A malicious
// remote filter list cannot inject arbitrary code because any rule
// referencing a name not in this list is dropped at parse time.

export const SCRIPTLET_ALLOWLIST = Object.freeze(new Set([
  'set-constant',
  'abort-on-property-read',
  'no-addEventListener-if',
  'no-setTimeout-if',
  'no-setInterval-if',
  'remove-attr',
  'remove-class',
  'google-analytics',
  'googletagservices',
  'facebook-pixel',
]));

export function isScriptletAllowed(name) {
  return SCRIPTLET_ALLOWLIST.has(name);
}

// Also limit scriptlet args to prevent absurdly long strings being
// embedded in the injected code (which could lead to a parser-bug RCE).
export const MAX_SCRIPTLET_ARG_LEN = 200;
export const MAX_SCRIPTLET_ARGS = 5;

export function sanitizeScriptletArgs(args) {
  if (!Array.isArray(args)) return [];
  return args
    .slice(0, MAX_SCRIPTLET_ARGS)
    .map(a => String(a).slice(0, MAX_SCRIPTLET_ARG_LEN))
    // SI-01 (v1.1) — strip every character that could be used to break
    // out of the generated `"arg"` string literal or the surrounding
    // <script> context:
    //   `  $        — template-literal / interpolation lever
    //   \           — backslash is the escape character itself; if an arg
    //                 can smuggle a backslash it can defeat the quote
    //                 escaping in buildScriptletCode. No legitimate
    //                 scriptlet arg (property names, simple values, plain
    //                 regex sources) needs a literal backslash, so we drop
    //                 them entirely rather than try to escape them.
    //   \u2028/9    — JS line terminators (would break the statement)
    //   \r \n       — newlines
    .map(a => a.replace(/[\u2028\u2029\r\n`$\\]/g, ''))
    // Defense in depth: never allow a </script or <script sequence through,
    // even though injection is via element.textContent (not innerHTML).
    .filter(a => !/<\/?script/i.test(a));
}

// ════════════════════════════════════════════════════════════════
// FIX #1 — FILTER LIST INTEGRITY
// ════════════════════════════════════════════════════════════════
//
// We can't SHA-pin daily-updated remote lists, but we CAN:
//  (1) only accept lists from a hardcoded origin allowlist (no rogue URLs)
//  (2) require HTTPS for every fetch
//  (3) strip any scriptlet rules from remote lists whose name isn't allowlisted
//  (4) cap total list size so a compromised mirror can't OOM us
//  (5) hash every successful fetch and warn if a re-fetch differs dramatically
//      from the last cached version (alerts on sudden poisoning)

export const TRUSTED_FILTER_ORIGINS = Object.freeze(new Set([
  'easylist.to',
  'pgl.yoyo.org',
  'secure.fanboy.co.nz',
  'malware-filter.gitlab.io',
  'easylist-downloads.adblockplus.org',
  'big.oisd.nl',
  's3.amazonaws.com',
  'raw.githubusercontent.com',
]));

export function isTrustedFilterUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return TRUSTED_FILTER_ORIGINS.has(u.hostname);
  } catch (e) {
    return false;
  }
}

export const MAX_LIST_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

/**
 * Run a freshly-fetched filter list through a sanitizer BEFORE parsing.
 *
 * Strips:
 *  - Scriptlet rules referencing a name outside SCRIPTLET_ALLOWLIST
 *    (this is the BIG one — without it, any compromised CDN can ship
 *     arbitrary code via ##+js(my-evil-scriptlet, ...))
 *  - Lines longer than 4 KB (filter rules are normally <500 chars;
 *    anything bigger is almost certainly an attempt to smuggle a payload)
 *  - Anything that looks like raw JS that isn't inside a recognised
 *    filter syntax marker
 *
 * Returns { text, dropped } so the caller can warn about poisoning.
 */
export function sanitizeFilterList(text) {
  if (typeof text !== 'string') return { text: '', dropped: 0 };
  if (text.length > MAX_LIST_BYTES) text = text.slice(0, MAX_LIST_BYTES);

  let dropped = 0;
  const out = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.length > 4096 ? '' : rawLine;
    if (!line) { if (rawLine) dropped++; continue; }

    // Scriptlet rule? `domain##+js(name, args...)` or `##+js(...)`
    const m = line.match(/##\+js\(\s*([^,)\s]+)/);
    if (m) {
      const name = m[1];
      if (!SCRIPTLET_ALLOWLIST.has(name)) {
        dropped++;
        continue;
      }
    }

    // Filter rules should not contain `<script>` tags, `javascript:` URIs,
    // or `eval(` — defense in depth in case some unknown rule format
    // is being abused.
    if (/<script|javascript:|\beval\s*\(|\bFunction\s*\(/i.test(line)) {
      dropped++;
      continue;
    }

    out.push(line);
  }

  return { text: out.join('\n'), dropped };
}

/**
 * Cheap content fingerprint for tamper detection across cache reads.
 * Not a security primitive — just a "did the list change?" indicator
 * used to alarm on sudden, drastic changes (a poisoned mirror dropping
 * a 1000-rule list and replacing it with 5 evil rules, for example).
 */
export async function hashFilterList(text) {
  try {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch (e) {
    logError('hashFilterList', e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// FIX #3 — MESSAGE SENDER VALIDATION
// ════════════════════════════════════════════════════════════════
//
// Sensitive handlers (RESET_STATS, ADD_WHITELIST, INJECT_SCRIPTLETS,
// CLEAR_BLOCKED_LOG, SET_PRO_SETTINGS, UPDATE_ALL_FILTER_LISTS) must only
// be callable from our OWN extension pages (popup, dashboard, network
// logger) — never from arbitrary content scripts on random pages.
//
// chrome.runtime.onMessage with `sender.id === chrome.runtime.id` is
// already restricted to the same extension, BUT a compromised content
// script we injected on a malicious page would still pass that check.
// So we ALSO check `sender.url` starts with chrome-extension://OUR_ID/.

const SENSITIVE_TYPES = new Set([
  // These mutate state and must only come from our own extension pages
  // (popup, dashboard, network logger). A malicious page can't directly
  // send messages to our SW, but a compromised content script we injected
  // could; sender.url checks prevent that escalation.
  'RESET_STATS',
  'ADD_WHITELIST',
  'REMOVE_WHITELIST',
  'TOGGLE',
  'CLEAR_BLOCKED_LOG',
  'SET_PRO_SETTINGS',
  'UPDATE_ALL_FILTER_LISTS',
  'ALLOW_LEARNED_TRACKER',
  // NOTE: INJECT_SCRIPTLETS is NOT here — it's called from content.js
  // by design. Its security boundary is the scriptlet name allowlist
  // (see SCRIPTLET_ALLOWLIST). content.js is restricted to scriptlets
  // already approved in our codebase, and the hostname it claims must
  // match its tab's URL (the SW cross-checks via sender.tab.url).
]);

export function isSensitiveMessage(type) {
  return SENSITIVE_TYPES.has(type);
}

/**
 * Validate that `sender` is allowed to invoke the given message type.
 * Returns { ok, reason }.
 *
 * Rules:
 *   - sender.id must equal our extension ID (Chrome enforces this already
 *     but explicit > implicit)
 *   - For SENSITIVE_TYPES, sender.url must be one of our own pages
 *     (popup, dashboard, network logger). Content scripts have a tab.url
 *     pointing at the page, NOT our extension origin, so this blocks them.
 */
export function validateSender(sender, msgType) {
  if (!sender) return { ok: false, reason: 'no_sender' };
  if (sender.id && sender.id !== chrome.runtime.id) {
    return { ok: false, reason: 'wrong_extension_id' };
  }

  // Non-sensitive messages (CHECK_URL, GET_COSMETIC_FILTERS, REPORT_BLOCKED)
  // can come from content scripts on any page.
  if (!isSensitiveMessage(msgType)) return { ok: true };

  // Sensitive: must come from our own extension page
  const url = sender.url || '';
  const ourOrigin = `chrome-extension://${chrome.runtime.id}/`;
  if (!url.startsWith(ourOrigin)) {
    return { ok: false, reason: 'sensitive_from_content_script' };
  }
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════
// FIX #5 — NULL-SAFE URL/HOSTNAME PARSING
// ════════════════════════════════════════════════════════════════
//
// `new URL(undefined)` throws. `new URL("chrome://newtab")` returns
// a URL with empty hostname. Wrap both so callers can't trigger
// silent failures that cascade through the request pipeline.

export function safeHostname(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.hostname;
  } catch (e) {
    return null;
  }
}

export function safeSenderHostname(sender) {
  if (!sender || !sender.tab) return null;
  return safeHostname(sender.tab.url);
}
