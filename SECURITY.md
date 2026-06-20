# Security Policy

## Security Rules

Zenith AdBlocker follows these rules:

- No remote JavaScript execution.
- No eval().
- No new Function().
- No inline scripts in extension pages.
- No remote fonts or remote scripts in extension pages.
- Filter lists are treated as text data only.
- User settings are stored locally.
- Sensitive dashboard data is only accessible from extension pages.
- Content scripts must not receive the full whitelist.