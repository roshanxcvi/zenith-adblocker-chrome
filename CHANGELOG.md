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