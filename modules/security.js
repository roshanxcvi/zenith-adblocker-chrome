/**
 * Zenith Security Utilities
 * by roshanxcvi
 *
 * Centralized security functions. Every security-sensitive path
 * (filter list parsing, scriptlet injection, message handling, URL parsing)
 * goes through this module so we have ONE place to audit.
 *
 * v1.3.3 audit fixes:
 *   SEC-01 Messages are deny-by-default: extension pages may send anything,
 *          content scripts may only send the few types content.js needs
 *          (CONTENT_SCRIPT_MESSAGES). Before, any new handler was open to
 *          content scripts unless someone remembered to list it as
 *          sensitive — SET_SITE_SETTINGS, SET_FILTER_LIST_ENABLED,
 *          CLEAR_FILTER_CACHE, SET_RULE_CATEGORY and GET_DASHBOARD_DATA
 *          (browsing history) were all open.
 *   SEC-02 Filter-list URLs are checked against full URL prefixes, not just
 *          hostnames. "raw.githubusercontent.com" or "s3.amazonaws.com"
 *          alone would trust any repo or bucket on those hosts. Also fixes
 *          big.oisd.nl vs small.oisd.nl (OISD Small was always refused).
 *   SEC-03 sanitizeFilterList() takes a per-list policy: scriptlets only
 *          from the bundled list, exception (@@) rules only from lists that
 *          need them, and plain domain lists may only add ||domain^ blocks.
 */

// ════════════════════════════════════════════════════════════════
// DEBUG LOGGING — replaces silent catch(e){} blocks
// ════════════════════════════════════════════════════════════════

export const DEBUG = false;

export function logError(where, err) {
  if (DEBUG) console.warn(`[Zenith:${where}]`, err);
  try {
    self.__zenithErrorCount = (self.__zenithErrorCount || 0) + 1;
    self.__zenithLastError = { where, message: String(err?.message || err), ts: Date.now() };
  } catch (_) {}
}

// ════════════════════════════════════════════════════════════════
// SCRIPTLET ALLOWLIST
// ════════════════════════════════════════════════════════════════
//
// The ONLY scriptlet names we will ever inject. Scriptlets are real
// functions bundled in modules/scriptlets.js; filter rules can only pick
// one of these by name and pass it validated arguments.

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

export const MAX_SCRIPTLET_ARG_LEN = 200;
export const MAX_SCRIPTLET_ARGS = 5;

export function sanitizeScriptletArgs(args) {
  if (!Array.isArray(args)) return [];
  return args
    .slice(0, MAX_SCRIPTLET_ARGS)
    .map(a => String(a).slice(0, MAX_SCRIPTLET_ARG_LEN))
    .map(a => a.replace(/[\u2028\u2029\r\n`$\\]/g, ''))
    .filter(a => !/<\/?script/i.test(a));
}

// ════════════════════════════════════════════════════════════════
// FILTER LIST INTEGRITY
// ════════════════════════════════════════════════════════════════
//
//  (1) only fetch lists from exact, hardcoded URL prefixes
//  (2) HTTPS only, no credentials or custom ports in the URL
//  (3) per-list policy: what kinds of rules a list is allowed to add
//  (4) size caps, and hash every fetch to spot sudden poisoning

export const TRUSTED_FILTER_URL_PREFIXES = Object.freeze([
  'https://easylist.to/easylist/',
  'https://pgl.yoyo.org/adservers/',
  'https://secure.fanboy.co.nz/',
  'https://malware-filter.gitlab.io/malware-filter/',
  'https://easylist-downloads.adblockplus.org/',
  'https://small.oisd.nl/',
  'https://s3.amazonaws.com/lists.disconnect.me/',
  'https://raw.githubusercontent.com/jerryn70/GoodbyeAds/',
  'https://raw.githubusercontent.com/hagezi/dns-blocklists/',
]);

// Kept for any code that imported it before (hostnames only).
export const TRUSTED_FILTER_ORIGINS = Object.freeze(new Set(
  TRUSTED_FILTER_URL_PREFIXES.map(p => new URL(p).hostname)
));

export function isTrustedFilterUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password || u.port) return false;
    return TRUSTED_FILTER_URL_PREFIXES.some(p => u.href.startsWith(p));
  } catch (e) {
    return false;
  }
}

export const MAX_LIST_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

const DOMAIN_RULE = /^\|\|[a-z0-9-]+(?:\.[a-z0-9-]+)+\^?$/i;

/**
 * Clean a filter list BEFORE parsing.
 *
 * policy.allowScriptlets  keep ##+js(...) rules (allowlisted names only).
 *                         Only the bundled default list should get this.
 * policy.allowExceptions  keep @@ exception rules. A list that can add
 *                         exceptions can switch blocking off everywhere.
 * policy.domainsOnly      keep only ||domain^ block rules (and comments).
 *
 * Always drops lines over 4 KB and lines that look like raw JS.
 * Returns { text, dropped }.
 */
export function sanitizeFilterList(text, policy = {}) {
  const {
    allowScriptlets = false,
    allowExceptions = true,
    domainsOnly = false,
  } = policy;

  if (typeof text !== 'string') return { text: '', dropped: 0 };
  if (text.length > MAX_LIST_BYTES) text = text.slice(0, MAX_LIST_BYTES);

  let dropped = 0;
  const out = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.length > 4096 ? '' : rawLine;
    if (!line) { if (rawLine) dropped++; continue; }

    const t = line.trim();
    if (t.startsWith('!') || t.startsWith('[')) { out.push(line); continue; }

    if (domainsOnly && !DOMAIN_RULE.test(t)) { dropped++; continue; }

    const m = t.match(/##\+js\(\s*([^,)\s]+)/);
    if (m && (!allowScriptlets || !SCRIPTLET_ALLOWLIST.has(m[1]))) { dropped++; continue; }

    if (t.startsWith('@@') && !allowExceptions) { dropped++; continue; }

    if (/<script|javascript:|\beval\s*\(|\bFunction\s*\(/i.test(t)) { dropped++; continue; }

    out.push(line);
  }

  return { text: out.join('\n'), dropped };
}

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
// MESSAGE SENDER VALIDATION (deny by default)
// ════════════════════════════════════════════════════════════════
//
// A normal website cannot message the service worker. Content scripts can,
// and Chrome's guidance is to treat them as less trusted: a renderer bug in
// one tab could let a page drive them. So content scripts get only the
// message types content.js actually uses; everything else (settings,
// allowlist, filter lists, dashboard data) is extension pages only.

export const CONTENT_SCRIPT_MESSAGES = Object.freeze(new Set([
  'GET_STATE',
  'GET_COSMETIC_FILTERS',
  'GET_PROCEDURAL_FILTERS',
  'INJECT_SCRIPTLETS',
  'INSERT_CSS',
  'REPORT_BLOCKED',
]));

export function isSensitiveMessage(type) {
  return !CONTENT_SCRIPT_MESSAGES.has(type);
}

export function isExtensionPageSender(sender) {
  if (!sender) return false;
  const ourOrigin = `chrome-extension://${chrome.runtime.id}`;
  if (sender.origin) return sender.origin === ourOrigin;
  return String(sender.url || '').startsWith(ourOrigin + '/');
}

/**
 * Returns { ok, reason }.
 *   - sender.id must be our extension
 *   - extension pages (popup, dashboard, logger) may send any type
 *   - content scripts may send CONTENT_SCRIPT_MESSAGES only
 */
export function validateSender(sender, msgType) {
  if (!sender) return { ok: false, reason: 'no_sender' };
  if (sender.id !== chrome.runtime.id) return { ok: false, reason: 'wrong_extension_id' };
  if (isExtensionPageSender(sender)) return { ok: true };
  if (sender.tab && CONTENT_SCRIPT_MESSAGES.has(msgType)) return { ok: true };
  return { ok: false, reason: 'extension_pages_only' };
}

// ════════════════════════════════════════════════════════════════
// NULL-SAFE URL/HOSTNAME PARSING
// ════════════════════════════════════════════════════════════════

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
  return safeHostname(sender.url || sender.tab.url);
}

// Dot-anchored suffix match: 'example.com' matches 'example.com' and
// 'sub.example.com', never 'notexample.com' or 'example.com.evil.net'.
export function domainMatches(hostname, ruleDomain) {
  if (!hostname || !ruleDomain) return false;
  const h = String(hostname).toLowerCase().replace(/^www\./, '');
  const r = String(ruleDomain).toLowerCase().replace(/^www\./, '');
  if (!r) return false;
  return h === r || h.endsWith('.' + r);
}
