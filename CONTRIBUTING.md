# Contributing to Zenith AdBlocker

Thank you for contributing.

## Rules

Do not add:
- remote JavaScript
- `eval()`
- `new Function()`
- inline scripts in extension pages
- remote fonts or other remote resources in extension pages
- unnecessary permissions
- tracking or analytics without clear user consent

Keep the security boundaries intact:
- Do not widen the content-script message allowlist unless the content script
  genuinely needs the new message (messages are deny-by-default).
- Do not loosen `chrome.storage` access back to content scripts.
- Add new scriptlets as functions with validated arguments, never as code
  strings, and keep them on the allowlist.
- Keep remote filter-list URLs on the exact-prefix allowlist.

## Before uploading a new version
- test the extension in Chrome (load unpacked)
- check the service worker console for errors
- check the popup, dashboard, and network-logger consoles
- verify there are no CSP errors on extension pages
- run through the testing checklist in the README (including: toggle-off and
  per-site "Allow" stop network blocking, and a blocked domain still loads as a
  direct navigation)
- remove any temporary testing code

  # Contributors

Thanks to everyone who has helped build Zenith AdBlocker.

- **roshanxcvi** — creator and maintainer
- **Viraj Prajapati** — contributor

See CONTRIBUTING.md for how to get involved.

