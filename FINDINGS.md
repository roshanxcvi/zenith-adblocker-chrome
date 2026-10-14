# Zenith AdBlocker — security audit (v1.3.2 → v1.3.3)

Audited every uploaded file and loaded the whole extension in real Chromium
(before vs after). Below, **[verified]** means confirmed in a live browser
test, **[unit]** in a Node test, **[review]** by reading the code.

## Critical / high — could have blocked review or leaked user data

1. **Messages were open to content scripts by default.** `validateSender`
   only guarded an explicit "sensitive" list, so any handler not on it was
   reachable from a content script on any web page — including
   `SET_SITE_SETTINGS`, `SET_FILTER_LIST_ENABLED`, `CLEAR_FILTER_CACHE`,
   `SET_RULE_CATEGORY`, and `GET_DASHBOARD_DATA` (returns your full blocked
   browsing log). Now **deny-by-default**: content scripts may send only the
   6 types content.js needs; everything else is extension pages only. [unit]

2. **`chrome.storage` was writable by content scripts.** With storage open,
   the message checks above could be bypassed by writing settings/allowlist
   directly, and the fingerprint seed could be read. Storage is now locked
   with `setAccessLevel('TRUSTED_CONTEXTS')`; content.js gets what it needs
   through `GET_STATE`. [verified the API exists in Chrome]

3. **Scriptlet injection = arbitrary `Object.prototype` write / could be
   flagged as remote code.** `set-constant` accepted any string value and any
   dotted path, so a filter-list rule like
   `##+js(set-constant, a.__proto__.polluted, <string>)` was possible; code
   was also built as a **string** and injected as an inline `<script>`, which
   reviewers treat as executing arbitrary code and which **fails on sites with
   a strict CSP**. Now scriptlets are real functions run with
   `executeScript({ func, args })`, values limited to uBlock's safe set, and
   paths reject `__proto__`/`prototype`/`constructor`. [unit] + [verified: runs
   under `script-src 'self'` in FIXED, blocked in ORIGINAL]

4. **Remote filter lists were over-trusted.** URLs were checked by hostname
   only, so `raw.githubusercontent.com` / `s3.amazonaws.com` trusted *any*
   repo or bucket; and any list could add `@@` exception rules (switch
   blocking off) — a compromised mirror could disable protection or point
   fetches at attacker content. Now checked against exact URL prefixes, and
   each list has a policy (no scriptlets from remote lists; exceptions only
   from EasyList-family; plain domain lists may only add `||domain^`). [unit]

## Medium — mostly "the feature silently doesn't work"

5. **The on/off switch and "Allow this site" did NOT stop network blocking.**
   They only turned off cosmetic hiding while every ad/tracker request stayed
   blocked by DNR. Now they add `allowAllRequests` rules.
   [verified: ORIGINAL ad still blocked when off/allowlisted; FIXED ad loads
   when off, and on an allowed site only — other sites still blocked]

6. **Dynamic rules blocked `main_frame`.** Navigating to a listed domain
   (affiliate links, a company homepage, a shortened link) was blocked with
   no way through. Now top-level navigations aren't blocked.
   [verified: ORIGINAL `ERR_BLOCKED_BY_CLIENT` on doubleclick.net; FIXED loads]

7. **Redirect stubs and allow rules could be dropped.** They were added last
   and cut off by the 5,000-rule `slice`. Now always added first, before the
   block-rule budget. [review]

8. **Filter-rule options were ignored.** `||site^$popup`, `$csp`, `$redirect`,
   `$removeparam`, `$document`… became plain blocks (e.g. `$popup` blocked the
   whole site); `$domain=` and `$third-party` were dropped so site-specific
   rules ran everywhere. Unsupported options now skip the rule; `$domain=` /
   `$third-party` are enforced via DNR. [unit]

9. **Non-network syntaxes leaked into the network parser** (`#@#`, `#?#`,
   `#$#`, `$$`, `##^`) and became junk rules using up the DNR budget; `~domain`
   cosmetic exclusions were inverted (applied only where they should be
   excluded). Both fixed. [unit]

10. **Alarms were recreated on every worker start**, resetting the 24 h timer,
    so filter lists rarely auto-updated. Created only if missing now. [review]

11. **`storage.sync` was written on every blocked request** — blows through
    its per-minute write quota on a busy page. Writes are now batched. [review]

12. **Badge in the store build.** `onRuleMatchedDebug` (the per-tab counter)
    only exists for *unpacked* extensions, so in the store build the badge
    never updated. Now falls back to Chrome's built-in blocked-count badge.
    [review, per Chrome docs]

13. **Small "Zenith is installed" tells** removed: the fingerprint `<script>`
    used `data-zenith-seed` (now `data-v`); cosmetic CSS used a
    `<style id="zenith-hide">` a page could find and delete (now applied as a
    USER stylesheet via `insertCSS`, invisible and unremovable). The dead
    `Notification.requestPermission` override in content.js (ran in the wrong
    world, never worked) was removed. [review]

## fingerprint.js
Same file audited earlier: navigator values spoofed on the prototype (delete
can't undo them), canvas noise deterministic/clamped/opaque-only on a copy,
GPU strings matched pairs and Windows-only, values within Chrome's real range,
patched functions look native. [verified in real Chromium earlier]
Its per-site seed is now computed in the service worker (HMAC of the install
seed and the origin) so the raw seed never reaches a page.

## Not changed (reviewed, no security fix needed)
rule-categories.js, tracker-learner.js, procedural-filters.js,
cosmetic-rules.json, static-rules.json, default-filters.txt, popup.css,
logger/network-logger.js (already builds DOM with textContent — safe).

## Please clean up before submitting
- **`modules/dnr-compiler.js` and `modules/filter-parser.js` are never
  imported** (dead code). Remove them, or wire them in. Reviewers ask about
  unused code.
- Replace the placeholder GPU strings in fingerprint.js with strings copied
  from real Chrome-on-Windows machines (current Chrome includes a device ID).
- Still to send: the dashboard page and any other files — I haven't seen them.

## Still can't be fully fixed in JS (documented limits)
- Fingerprint spoofing doesn't reach same-origin iframes, Web Workers, or
  scripts that run before injection. Making it airtight needs a
  `world:"MAIN"`, `run_at:"document_start"` content script (Chrome 111+),
  which then can't read the seed from storage — a redesign, not a patch.

---

## Second pass — redirect stubs, dashboard, logger (final files)

Reviewed and integrated the last 6 files; the build now loads complete and
was exercised end-to-end in Chromium (no page or console errors on any page).

- **redirects/*.js** (fbevents, google-analytics, googletagservices): inert
  API stubs, no eval, no network. Clean. **[verified]** a page's request to
  `google-analytics.com/analytics.js` is redirected to the stub — the real
  script never runs.
- **dashboard.js**: builds all DOM with `textContent` / a safe `el()` helper
  (no `innerHTML`); every message it sends is from an extension page, which
  the new sender check allows. Clean. **[verified]** toggle, whitelist-add and
  reset work with no errors.
- **dashboard.css**: fixed a real bug — `.btn-add:hover` had no `{}` block, so
  it swallowed the next rule and the whitelist list lost its styling. Added a
  colour for the Meta category icon. Bumped version text to 1.3.3.
- **dashboard.html**: logo used `fill="var(--accent)"`, which doesn't work in
  an SVG presentation attribute (rendered black) — set to the real colours.
- **network-logger.html**: was missing (dashboard links to it). Built a page
  to the exact element IDs `network-logger.js` expects. `network-logger.js`
  itself was already safe (DOM via `textContent`).

## Store-build limitation you should know about (not a bug)
Per-request detail — the **Top Blocked Domains**, **Blocked by Category**, and
**Recent Blocked Requests** panels, and the exact "total blocked" number — are
populated from `onRuleMatchedDebug`, which Chrome provides **only to unpacked
extensions**. In the published (packed) build those panels will be sparse or
empty, and the headline counter only counts cosmetic hides. This is an MV3
platform limit, not something the code got wrong: a packed extension cannot see
which URLs its declarative rules blocked. Options: show a total via the action
badge count (already enabled) and label the detail panels as "developer mode
only", or poll `getMatchedRules()` for a count (quota-limited, and it returns
no URL, so it still can't fill the domain/category lists). Decide before launch.

## Note on the packaged zip
- `icons/` in the zip are **placeholder green squares** so the extension
  loads — your real icons weren't in the uploads. Replace `icons/` with yours
  before submitting.
- `modules/dnr-compiler.js` and `modules/filter-parser.js` are still unused;
  left in place, but delete them for a cleaner submission.
