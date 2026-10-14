# Security Policy

## Supported version

The latest release (currently 1.3.3) receives security fixes.

## Security rules

Zenith AdBlocker follows these rules:

- No remote JavaScript execution.
- No `eval()`.
- No `new Function()`.
- No inline scripts in extension pages.
- No remote fonts or remote scripts in extension pages.
- Filter lists are treated as text data only, fetched over HTTPS from a fixed
  allowlist of exact URL prefixes; remote lists can never add scriptlet rules.
- User settings are stored locally and, since 1.3.3, `chrome.storage` is
  restricted to trusted contexts (`setAccessLevel`), so content scripts cannot
  read or write settings, the whitelist, or the fingerprint seed.
- Service-worker messages are deny-by-default: content scripts may send only
  the message types they need; settings, filter-list, and dashboard handlers
  are reachable only from the extension's own pages.
- Sensitive dashboard data is only accessible from extension pages.
- Content scripts receive only current-site whitelist status, never the full
  whitelist.
- Scriptlets are injected as functions with validated arguments (a fixed safe
  value set, and no `__proto__` / `prototype` / `constructor` property paths).

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately
through the repository's GitHub "Security" tab (Report a vulnerability /
security advisory), or email **zenithadblocker@gmail.com**. Include steps to
reproduce and the affected version. You can expect an initial reply within a
few days.
