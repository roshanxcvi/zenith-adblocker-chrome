<div align="center">

# 🛡️ Zenith AdBlocker

### A Chrome MV3 Ad Blocker & Privacy Guard

**Developed by [roshanxcvi](https://github.com/roshanxcvi)**

![Version](https://img.shields.io/badge/version-1.3.0-00e676?style=for-the-badge)
![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?style=for-the-badge\&logo=google-chrome\&logoColor=white)
![Privacy](https://img.shields.io/badge/privacy-local--first-00e676?style=for-the-badge)

Zenith is a Chrome Manifest V3 privacy-focused ad blocker with network blocking, cosmetic filtering, tracker protection, fingerprint protection, cookie popup handling, per-site controls, and local-only settings.

</div>

---

## 📌 About Zenith

Zenith AdBlocker is a Chrome MV3 extension built to block ads, trackers, cookie popups, crypto miners, annoying page elements, and selected fingerprinting techniques.

The goal of Zenith is to provide a clean, privacy-first browsing experience while keeping user data local.

Zenith is inspired by mature privacy tools such as uBlock Origin, Privacy Badger, Ghostery, and AdBlock Plus, but it is an independent project with its own Chrome MV3-focused architecture.

---

## ✨ Key Features

* Network-level ad blocking with Chrome `declarativeNetRequest`
* Cosmetic filtering for hiding ad containers and sponsored elements
* Packaged cosmetic rules from `rules/cosmetic-rules.json`
* Per-site controls for enabling or disabling protection features by domain
* Tracker blocking and smart tracker learning
* Fingerprint protection helpers
* Cookie popup auto-reject/hide logic
* Annoyance blocking for popups, newsletter prompts, and floating widgets
* Crypto miner blocking
* YouTube-specific ad handling
* Live network logger
* Dashboard statistics
* Local-only settings and logs
* No acceptable ads program
* No remote JavaScript execution
* No `eval()` or `new Function()`

---

## 📥 Installation

### Method 1 — Download ZIP

1. Download the Zenith project ZIP.
2. Unzip the file.
3. Open Chrome.
4. Go to:

```text
chrome://extensions/
```

5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the unzipped Zenith folder.
8. The Zenith shield icon should appear in your Chrome toolbar.

### Method 2 — Clone from GitHub

```bash
git clone https://github.com/roshanxcvi/zenith-adblocker-chrome.git
```

Then load the folder in Chrome:

```text
chrome://extensions/ → Developer mode → Load unpacked
```

---

## 🛡️ Protection Modules

### 🚫 Ad Blocking

Zenith blocks ads at the network level using Chrome’s `declarativeNetRequest` API. It also applies cosmetic filtering to hide ad containers that are already present on the page.

### 🔍 Tracker Protection

Zenith blocks known tracker domains and includes smart tracker learning to detect repeated third-party tracking behavior across websites.

### 🔒 Fingerprint Protection

Zenith includes protections for selected fingerprinting surfaces such as canvas, WebGL, audio, navigator properties, and privacy signals.

### 🍪 Cookie Popup Handling

Zenith can reject or hide supported cookie consent banners and common consent management popups.

### 🧹 Annoyance Blocking

Zenith hides common newsletter popups, app banners, chat widgets, floating videos, push notification prompts, and other distracting page elements.

### ⛏️ Crypto Miner Blocking

Zenith blocks common browser-based crypto mining services and removes miner scripts when detected.

---

## 🎯 Per-Site Controls

Zenith v1.3.0 adds per-site settings.

Each website can have its own protection settings, including:

* Protection enabled/disabled
* Ads
* Cosmetic filtering
* Trackers
* Fingerprinting
* Cookie popups
* Annoyances
* Crypto miners

Example:

```text
youtube.com
├── Ads: enabled
├── Cosmetic filtering: enabled
├── Cookie popups: disabled
└── Fingerprinting: enabled
```

This allows users to reduce breakage on specific websites without turning off Zenith everywhere.

---

## 🧩 Filter Rule Support

Zenith includes a rule parser and DNR compiler for simple blocking rules.

Supported rule types include:

* Network rules
* Allow rules
* Cosmetic rules
* Basic scriptlet-style rules
* Packaged cosmetic selectors
* Simple DNR conversion for compatible network rules

Example rules:

```text
||doubleclick.net^
@@||example.com^
example.com##.ad-banner
example.com##+js(set-constant, ads.loaded, true)
```

Zenith does not yet support the full advanced filter syntax supported by mature blockers such as uBlock Origin. Filter compatibility is being improved gradually.

---

## 📡 Live Network Logger

Zenith includes a live network logger that displays blocked requests and cosmetic reports.

The logger can show:

* Blocked request type
* Blocked URL/domain
* Time of block
* Request category
* Recent blocking activity

This helps users understand what Zenith is blocking.

---

## 🎬 YouTube Handling

Zenith includes YouTube-specific logic that runs only on `youtube.com`.

It can:

* Hide YouTube ad containers
* Close overlay ads
* Attempt to skip skippable ads
* Reduce ad-related interruptions
* Keep YouTube-specific selectors scoped to avoid hiding the main header or layout

YouTube changes frequently, so YouTube blocking may require ongoing maintenance.

---

## 🔐 Privacy

Zenith is designed to be local-first.

Zenith does not:

* Sell browsing data
* Send visited websites to a remote analytics server
* Collect page content
* Use remote JavaScript
* Use remote tracking or analytics

Zenith stores settings locally using Chrome storage, including:

* Enabled/disabled status
* Whitelist domains
* Per-site settings
* Blocking counters
* Local blocked request logs
* Filter list settings

Blocked request logs are stored locally and can be cleared by the user.

---

## 💾 Data Storage

| Data                   | Storage                                        | Purpose                        |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| Enabled/disabled state | `chrome.storage.local`                         | Saves protection state         |
| Whitelist domains      | `chrome.storage.local`                         | Stores excluded websites       |
| Per-site settings      | `chrome.storage.local`                         | Saves domain-specific controls |
| Block counters         | `chrome.storage.local`                         | Shows blocking statistics      |
| Since-install counter  | `chrome.storage.local` / `chrome.storage.sync` | Preserves long-term count      |
| Blocked request logs   | `chrome.storage.local`                         | Powers the network logger      |

---

## ⚙️ How Zenith Works

Zenith uses several layers of protection:

1. **Network blocking**
   Uses Chrome `declarativeNetRequest` rules to block compatible network requests before they load.

2. **Dynamic rules**
   Converts supported filter rules into Chrome DNR rules.

3. **Cosmetic filtering**
   Injects safe CSS selectors to hide ads, banners, sponsored cards, and annoying elements.

4. **Content script protection**
   Runs page-level privacy and annoyance protections.

5. **Scriptlet support**
   Uses allowlisted scriptlets for selected anti-adblock and tracker behaviors.

6. **Per-site settings**
   Applies domain-specific protection settings before enabling page-level modules.

---

## 🧪 Testing Checklist

Before releasing a new version, test:

```text
1. Extension loads with no red errors
2. Service worker starts correctly
3. Popup opens
4. Dashboard opens
5. BBC or another news site loads without cosmetic rule errors
6. YouTube loads without breaking the header or player
7. Per-site ads OFF disables cosmetic CSS
8. Per-site ads ON enables cosmetic CSS
9. Whitelist add/remove works
10. Network logger opens
11. No CSP errors in extension pages
12. No temporary testing code remains
```

---

## 🔒 Security Rules

Zenith follows these project rules:

* No remote JavaScript
* No `eval()`
* No `new Function()`
* No inline scripts in extension pages
* No unnecessary permissions
* No remote fonts in extension pages
* Filter lists are treated as text data, not executable code
* Content scripts should receive only the minimum data needed
* Sensitive dashboard data should only be available to extension pages

---

## 📁 Project Structure

```text
zenith-adblocker-chrome/
├── manifest.json
├── background.js
├── content.js
├── fingerprint.js
├── popup/
├── dashboard/
├── modules/
├── rules/
├── redirects/
├── icons/
├── README.md
├── CHANGELOG.md
├── PRIVACY.md
├── SECURITY.md
└── CONTRIBUTING.md
```

---

## 🆚 Comparison

Zenith is not a full replacement for uBlock Origin yet.

uBlock Origin is a mature, highly optimized, widely trusted blocker with years of filter compatibility, advanced dynamic filtering, scriptlets, redirects, and logger features.

Zenith is a newer Chrome MV3-focused project that combines ad blocking with additional privacy-focused features such as fingerprint protection, cookie popup handling, local dashboard stats, and per-site controls.

| Feature                       | Zenith v1.3.0 |              uBlock Origin              |
| ----------------------------- | :-----------: | :-------------------------------------: |
| Chrome MV3 support            |       ✅       | Limited/full support depends on version |
| Network blocking              |       ✅       |                    ✅                    |
| Cosmetic filtering            |       ✅       |                    ✅                    |
| Advanced filter compatibility |    Partial    |                    ✅                    |
| Scriptlets                    |     Basic     |                 Advanced                |
| Redirect rules                |     Basic     |                 Advanced                |
| Per-site controls             |       ✅       |                    ✅                    |
| Fingerprint protection        |       ✅       |                    ❌                    |
| Cookie popup handling         |       ✅       |                    ❌                    |
| Live logger                   |       ✅       |                    ✅                    |
| Local-only settings           |       ✅       |                    ✅                    |
| Long-term maturity            | Early project |            Industry standard            |

---

## 📋 Changelog

### v1.3.0

#### Added

* Rule category settings
* Filter parser for network, allow, cosmetic, and scriptlet-style rules
* DNR compiler for simple network and allow rules
* Packaged cosmetic rules from `rules/cosmetic-rules.json`
* Per-site settings support
* Site-specific controls for changing protection by domain

#### Improved

* Cosmetic rule loading in content scripts
* Chrome MV3 compatibility
* Dashboard and popup version consistency
* Release readiness and cleanup

#### Security

* Removed remote Google Fonts from extension pages
* Kept extension pages compatible with strict Content Security Policy
* Reduced unnecessary manifest permissions
* Added safer packaged cosmetic rule loading through `web_accessible_resources`

---

## 🧭 Roadmap

Planned improvements:

* Popup UI for per-site controls
* Automated tests for parser, DNR compiler, and settings
* Better filter syntax compatibility
* More robust cosmetic exceptions
* Improved rule update dashboard
* Build/release script
* Performance benchmark tools
* More complete documentation

---

## 🤝 Contributing

Contributions are welcome.

Please follow the project security rules:

* Do not add remote JavaScript
* Do not add `eval()`
* Do not add `new Function()`
* Do not add inline scripts
* Do not add unnecessary permissions
* Test popup, dashboard, service worker, and content scripts before submitting changes

---

## 📄 License

See the `LICENSE` file for details.

---

<div align="center">

Made with ❤️ by **roshanxcvi**

**Zenith AdBlocker v1.3.0 — Chrome MV3**

⭐ Star the project if Zenith helps you browse with fewer ads and trackers.

</div>
