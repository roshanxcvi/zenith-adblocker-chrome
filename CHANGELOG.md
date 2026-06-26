# Changelog

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

### Security
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
