# Zenith AdBlocker Privacy Policy

_Last updated: 2026-10-09 — applies to version 1.3.3._

Zenith AdBlocker processes blocking rules locally on the user's device.

Zenith does not sell browsing data.

Zenith does not collect page content.

Zenith does not send the websites you visit to any remote server.

Zenith has no analytics, no telemetry, and no remote logging.

## What is stored, and where

Zenith stores extension settings locally (`chrome.storage`), including:
- enabled/disabled status
- whitelist (allowed) domains
- per-site settings
- blocking counters
- local blocked-request logs
- filter list settings

The "blocked since install" counter is also mirrored to `chrome.storage.sync`
so it survives a reinstall and follows your Chrome profile; it contains only a
number and an install date, never URLs. Everything else stays in local storage.

Since version 1.3.3, storage is restricted to trusted contexts, so only the
extension's own pages and service worker can read it — not the content scripts
that run on web pages.

Blocked-request logs are stored locally only and can be cleared at any time
from the dashboard.

## Blocked activity & stats

The **Blocked activity** page, the dashboard and the popup show how many
requests were blocked, the top blocked domains, and a live list of recent
blocks. To produce these, Zenith observes which requests its own rules blocked,
using Chrome's `webRequest` API in observe-only mode — it watches for requests
that failed with a "blocked by client" result. Zenith does not use this to read
request contents, modify or intercept requests, or send anything anywhere.
Every count and list is built and kept on your device, and can be cleared any
time from the dashboard.

## Data sent off the device

The only outbound network requests Zenith makes are downloads of text-based
filter lists from a fixed allowlist of trusted sources (EasyList, EasyPrivacy,
Peter Lowe's list, and the optional lists you enable). These are fetched over
HTTPS with no credentials and are treated as data, not executable code. No
information about you or the pages you visit is included in these requests.

## Privacy signals

When fingerprint protection is on, Zenith reports the Do Not Track and Global
Privacy Control signals to pages. These are standard opt-out signals and are
intentionally the same for every user.

## Permissions

Zenith requests only the permissions it needs to block content and show
per-tab status. This includes `webRequest`, used in observe-only mode to count
the requests Zenith blocks for the on-device stats — it never modifies or
intercepts requests, and never reads their contents. Zenith does not request
access to your bookmarks, history API, downloads, or native messaging.

## Contact

Questions, privacy requests, or security reports: **zenithadblocker@gmail.com**.
You can also open an issue on the project's GitHub repository.
