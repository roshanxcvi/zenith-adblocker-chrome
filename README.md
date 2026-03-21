<div align="center">

# 🛡️ Zenith AdBlocker

### The Ultimate Ad Blocker & Privacy Guard for Chrome

**Developed by [roshanxcvi](https://github.com/roshanxcvi)**

![Version](https://img.shields.io/badge/version-1.0.0-00e676?style=for-the-badge)
![Chrome](https://img.shields.io/badge/Chrome-Supported-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white)

Block ads, trackers, fingerprinting, crypto miners, cookie popups & annoyances. Zero acceptable ads. Zero compromise.

</div>

---

## 📥 How to Install

### Method 1 — Download ZIP
1. Go to [zenith-adblocker-chrome](https://github.com/roshanxcvi/zenith-adblocker-chrome) → Download the ZIP
2. Unzip the file
3. Open Chrome → go to `chrome://extensions/`
4. Turn ON **Developer mode** (top-right toggle)
5. Click **Load unpacked** → select the unzipped folder
6. ✅ Done! Green shield icon appears in your toolbar

### Method 2 — Clone from GitHub

```
git clone https://github.com/roshanxcvi/zenith-adblocker-chrome.git
```

Then load in Chrome: `chrome://extensions/` → Developer mode → Load unpacked → select folder

---

## ⚡ What Does Zenith Block?

| Feature | Zenith | uBlock Origin | AdBlock Plus | Ghostery | Privacy Badger |
|---|:---:|:---:|:---:|:---:|:---:|
| Ad Blocking | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| Tracker Blocking | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Auto-Learning Trackers | ✅ | ❌ | ❌ | ❌ | ✅ |
| Fingerprint Protection | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cookie Auto-Reject | ✅ | ❌ | ❌ | ✅ | ❌ |
| Annoyance Blocking | ✅ | ✅ | ❌ | ❌ | ❌ |
| Crypto Miner Blocking | ✅ | ✅ | ❌ | ❌ | ❌ |
| YouTube Ad Killer | ✅ | ✅ | ❌ | ❌ | ❌ |
| Dashboard Analytics | ✅ | ❌ | ❌ | ⚠️ | ❌ |
| Since Install Counter | ✅ | ✅ | ❌ | ❌ | ❌ |
| Zero "Acceptable Ads" | ✅ | ✅ | ❌ | ✅ | — |

*AdBlock Plus allows "acceptable ads" by default — advertisers pay to get whitelisted.

---

## 🛡️ 6 Protection Modules

All enabled by default. No configuration needed.

**🚫 Ad Blocking** — 551+ built-in rules. 7 community filter lists (EasyList, EasyPrivacy, Peter Lowe's, Fanboy's Annoyance, EasyList Cookie, Malware URL Blocklist, Adblock Warning Removal). 100,000+ rules total. Chrome `declarativeNetRequest` static rules for instant blocking.

**🔍 Smart Tracker Learning** — Auto-detects third-party domains that track you across 3+ websites and blocks them. No predefined list needed — behavioral detection like Privacy Badger.

**🔒 Fingerprint Protection** — Canvas noise injection, WebGL renderer spoofing, AudioContext randomization, Battery API blocking, Navigator normalization, GPC & DNT signals.

**🍪 Cookie Auto-Reject** — Auto-clicks "Reject All" on 20+ CMP frameworks: OneTrust, Cookiebot, Didomi, TrustArc, Quantcast, Klaro. Multi-language.

**🧹 Annoyance Blocking** — Kills newsletter popups, chat widgets (Intercom, Drift, Tidio, Tawk, Crisp, HubSpot), push notification prompts, app banners, sticky videos.

**⛏️ Crypto Miner Blocking** — Blocks CoinHive, CryptoLoot, JSECoin, CoinImp and 15+ mining services.

---

## 🎬 YouTube Ad Blocking

Zenith includes a dedicated YouTube ad killer that runs only on `youtube.com`:

- **Auto-clicks skip button** instantly when it appears
- **Speeds through unskippable ads** by jumping to end
- **Mutes audio during ads** so you're never interrupted
- **Closes overlay ads** automatically
- **Hides promoted content** in feed and sidebar
- **Zero performance impact** — only watches the player element, not the entire page

---

## 💾 Data Persistence — Your Data is Safe

All your data is stored in `chrome.storage.local` and stays safe across browser restarts, laptop reboots, and Chrome updates. **Nothing is lost unless you manually clear your browser data.**

| Data | Storage | Survives Restart? | Survives Clear Data? |
|---|---|:---:|:---:|
| **Ads blocked since install** | `chrome.storage.local` + `chrome.storage.sync` | ✅ | ✅ (sync backup) |
| **Install date** | `chrome.storage.local` + `chrome.storage.sync` | ✅ | ✅ (sync backup) |
| **Whitelisted sites** | `chrome.storage.local` | ✅ | ❌ |
| **Enabled/disabled state** | `chrome.storage.local` | ✅ | ❌ |
| **Blocked request log** | `chrome.storage.local` | ✅ | ❌ |
| **Per-site statistics** | `chrome.storage.local` | ✅ | ❌ |

**How it works:**
- Every whitelist change and blocked count uses **atomic storage operations** — reads from storage, modifies, writes back. No in-memory caching that could be lost.
- The **"Ads blocked since install"** counter is backed up to `chrome.storage.sync` (tied to your Google account), so it survives even if you clear all browsing data.
- Data is saved **immediately** on every action, not on a timer. Chrome's service worker can die at any time — your data is already written.
- **Reset Stats** in the dashboard clears session data but **never** resets the lifetime "since install" counter.

---

## ⚙️ How It Works

- **Network blocking:** Chrome's `declarativeNetRequest` API blocks ads at the network level before they load
- **Cosmetic filtering:** CSS injection hides ad elements instantly with zero JavaScript cost
- **YouTube targeting:** Dedicated ad killer watches only the video player element, not the full DOM
- **Dynamic rules:** Filter engine parses AdBlock-style lists and syncs up to 5,000 dynamic rules
- **Atomic saves:** All data written directly to `chrome.storage.local` — no debouncing, no data loss
- **Filter updates:** 7 community lists auto-update every 24 hours with 10s timeout and 5MB size limit

---

## 📝 Philosophy

🚫 **Zero acceptable ads.** No paid whitelists. No corporate partners.

🔒 **Privacy first.** All data stays local. Nothing collected. Nothing sent.

💾 **Your data persists.** Blocked counts, whitelisted sites, settings — all saved to `chrome.storage.local` and remain until you choose to clear them.

⚡ **Just install and browse.** Everything enabled by default.

---

<div align="center">

Made with ❤️ by **roshanxcvi**

Zenith AdBlocker v1.0.0 — Chrome

⭐ **Star this repo if Zenith helps you browse ad-free!**

</div>
