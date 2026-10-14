# Changelog

## 1.3.3
### Security
- Locked `chrome.storage.local`/`sync` to trusted contexts so content scripts can no longer read or write settings, the whitelist, or the fingerprint seed.
- Made service-worker messages deny-by-default; content scripts may send only the message types they need. Settings, filter-list, and dashboard handlers are now extension-page only.
- Replaced string-built scriptlets with real functions injected via `chrome.scripting.executeScript`, with validated arguments and blocked prototype-pollution paths. Works under strict page CSP.
- Restricted remote filter lists to exact URL prefixes and gave each list a rule policy (no scriptlets from remote lists; exceptions only from EasyList-family lists).
- Derived the per-site fingerprint seed in the service worker (HMAC of the install seed and origin); the raw seed never reaches a page.
- Removed "extension is installed" tells: neutral injected-script attribute, and cosmetic CSS applied as an unreadable user stylesheet instead of a labelled `<style>`.

### Fixed
- The on/off switch and per-site "Allow" now also stop network blocking (`allowAllRequests`), not just cosmetic hiding.
- Dynamic rules no longer block top-level navigation, so links to listed domains load.
- Redirect and allow rules are always installed (no longer dropped by the rule-count cap).
- Filter-rule options are handled correctly ($popup/$csp/etc. skipped; $domain= and $third-party enforced; non-network syntaxes no longer become junk rules).
- Alarms are created only when missing, so the daily filter-list update actually fires.
- storage.sync writes are batched instead of one per blocked request (avoids the write quota).
- Per-tab badge count is maintained from observed blocks, so it works in the packed (Web Store) build, not only unpacked.
- Fixed a `dashboard.css` rule that dropped whitelist styling; corrected the dashboard logo colors; added the missing `network-logger.html`.

### Changed
- Count blocked requests with the observe-only `webRequest` API (`net::ERR_BLOCKED_BY_CLIENT`) instead of the unpacked-only `onRuleMatchedDebug`, so counts, top blocked domains, categories and the live feed all work in the published Web Store build. `declarativeNetRequestFeedback` is not used — Chrome ignores it for Web Store installs, so it would only add a permission warning without enabling anything.
- Renamed the "Network Logger" to **Blocked activity**. It shows real blocked counts, top blocked domains and a live feed (with URLs) in the published build. The dashboard shows a protection overview until the first block, then switches to real blocked data; the popup shows per-tab counts and top blocked domains.
- Replaced the store description with a shorter, non-superlative one.
- Added a bundled Privacy Policy page (`privacy.html`), linked from the popup and dashboard footers, now documenting the observe-only `webRequest` stats.

### Notes
- Blocked-activity stats are built from the `webRequest` API in observe-only mode and are counted and stored only on your device — nothing is uploaded. Only *blocked* requests are observed (there is no full log of allowed requests the way uBlock Origin MV2 offers); the per-tab toolbar badge is the exact count.


## 1.3.0
### Added
- Added rule category settings for ads, trackers, fingerprinting, cookie popups, annoyances, crypto miners, malware, and social widgets.
- Added a filter parser for network, allow, cosmetic, and scriptlet-style rules.
- Added a DNR compiler for simple network and allow rules.
- Added packaged cosmetic rules from `rules/cosmetic-rules.json`.
- Added per-site settings support.
- Added site-specific controls so protection can be changed per domain.

### Improved
- Improved cosmetic rule loading in content scripts.
- Improved Chrome MV3 compatibility.
- Improved dashboard and popup version consistency.
- Improved release readiness and extension cleanup.

### Security
- Removed remote Google Fonts from extension pages.
- Kept extension pages compatible with strict Content Security Policy.
- Reduced unnecessary manifest permissions.
- Added safer packaged cosmetic rule loading through `web_accessible_resources`.

### Security (privacy hardening)
- Removed remote resources from extension pages.
- Moved inline scripts into local files.
- Hardened whitelist domain validation.
- Protected dashboard data from content-script access.
- Reduced privacy leakage from content-script state responses.

### Improvements
- Added security and privacy documentation.


## v1.3.1

### Added

* Added a cleaner, more professional popup interface for Zenith.
* Added a redesigned dashboard layout with improved spacing, cleaner cards, and better readability.
* Added a refreshed Network Logger interface with a calmer dark UI and clearer request rows.
* Added improved visual consistency across popup, dashboard, and network logger pages.

### Improved

* Improved popup readability with clearer stats, protection badges, current-site controls, and dashboard access.
* Improved dashboard presentation with a more professional instrument-panel layout.
* Improved Network Logger layout for blocked request visibility, filtering, and live status display.
* Improved typography by switching extension pages to local system fonts.
* Improved Chrome extension CSP compatibility by removing remote Google Fonts from extension pages.
* Improved UI consistency for Zenith v1.3.1 branding.

### Security

* Removed remote Google Fonts from dashboard and network logger pages.
* Kept extension pages compatible with strict Chrome extension Content Security Policy.
* Continued avoiding remote JavaScript, inline external dependencies, and unnecessary remote resources.

### Notes

* This update focuses mainly on UI polish, Chrome Web Store readiness, and CSP-safe extension pages.

## v1.3.2-filter-lists

### Added
- Added optional dashboard toggles for OISD Big, Disconnect Tracking Protection, GoodbyeAds, and HaGeZi Pro mini.
- Added short user-facing descriptions for each filter list so users understand what each list blocks.
- Added filter list rule counts, update time, source labels, and enabled/disabled status in the dashboard.

### Improved
- Added trusted origins and CSP connect permissions for the new remote filter lists.
- Added conversion support for simple hosts/domain blocklists into AdBlock-style `||domain^` rules before parsing.

### Notes
- Extra lists are disabled by default because aggressive DNS/domain lists may break some websites. Users can enable them from the dashboard.
