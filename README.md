<div align="center">

# 🛡️ Zenith AdBlocker

### The Ultimate Ad Blocker & Privacy Guard for Chrome

**Developed by [roshanxcvi](https://github.com/roshanxcvi)**

![Version](https://img.shields.io/badge/version-2.0.0-00e676?style=for-the-badge)
![Chrome](https://img.shields.io/badge/Chrome-Supported-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white)

*Block ads, trackers, fingerprinting, crypto miners, cookie popups & annoyances.*
*Zero acceptable ads. Zero compromise.*

[**🌐 Visit Website**](https://roshanxcvi.github.io/zenith-adblocker-public/) · [**🐛 Report Bug**](https://github.com/roshanxcvi/zenith-adblocker-public/issues)

</div>

---

## 📥 How to Install

### Method 1 — Download ZIP

1. Go to [**Releases**](https://github.com/roshanxcvi/zenith-adblocker-public/releases/latest) → Download the ZIP
2. Unzip the file
3. Open Chrome → go to `chrome://extensions/`
4. Turn ON **Developer mode** (top-right toggle)
5. Click **Load unpacked** → select the unzipped folder
6. ✅ Done! Green shield icon appears in your toolbar

### Method 2 — Clone from GitHub

```bash
git clone https://github.com/roshanxcvi/zenith-adblocker-public.git
```
Then load in Chrome: `chrome://extensions/` → Developer mode → Load unpacked → select folder

---

## ⚡ What Does Zenith Block?

| Feature | Zenith | uBlock Origin | AdBlock Plus | Ghostery | Privacy Badger |
|---------|:------:|:------------:|:------------:|:--------:|:--------------:|
| Ad Blocking | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| Tracker Blocking | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Auto-Learning Trackers | ✅ | ❌ | ❌ | ❌ | ✅ |
| Fingerprint Protection | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cookie Auto-Reject | ✅ | ❌ | ❌ | ✅ | ❌ |
| Annoyance Blocking | ✅ | ✅ | ❌ | ❌ | ❌ |
| Crypto Miner Blocking | ✅ | ✅ | ❌ | ❌ | ❌ |
| Dashboard Analytics | ✅ | ❌ | ❌ | ⚠️ | ❌ |
| Zero "Acceptable Ads" | ✅ | ✅ | ❌ | ✅ | — |

*\*AdBlock Plus allows "acceptable ads" by default — advertisers pay to get whitelisted.*

---

## 🛡️ 6 Protection Modules

All enabled by default. No configuration needed.

### 🚫 Ad Blocking
500+ built-in rules. 15 community filter lists (EasyList, EasyPrivacy, HaGeZi, Peter Lowe's, Fanboy's, StevenBlack, OISD). 100,000+ rules total. 100 Chrome `declarativeNetRequest` static rules for instant blocking. MutationObserver catches lazy-loaded ads.

### 🔍 Smart Tracker Learning
Auto-detects third-party domains that track you across 3+ websites and blocks them. No predefined list needed — behavioral detection like Privacy Badger.

### 🔒 Fingerprint Protection
Canvas noise injection, WebGL renderer spoofing, AudioContext randomization, Battery API blocking, Navigator normalization, GPC & DNT signals.

### 🍪 Cookie Auto-Reject
Auto-clicks "Reject All" on 20+ CMP frameworks: OneTrust, Cookiebot, Didomi, TrustArc, Quantcast, Klaro. Multi-language.

### 🧹 Annoyance Blocking
Kills newsletter popups, chat widgets (Intercom, Drift, Tidio, Tawk, Crisp, HubSpot), push notification prompts, app banners, sticky videos.

### ⛏️ Crypto Miner Blocking
Blocks CoinHive, CryptoLoot, JSECoin, CoinImp and 15+ mining services.

---

## 💾 How It Works

- **Network blocking:** Chrome's `declarativeNetRequest` API blocks ads at the network level before they load
- **Cosmetic filtering:** Content script hides ad elements using CSS injection + DOM scanning
- **Dynamic rules:** Filter engine parses AdBlock-style lists and syncs up to 5,000 dynamic rules
- **Auto-save:** Stats persist every 30 seconds + every 25 blocks
- **Filter updates:** 15 community lists auto-update every 24 hours

---

## 📝 Philosophy

🚫 **Zero acceptable ads.** No paid whitelists. No corporate partners.

🔒 **Privacy first.** All data stays local. Nothing collected. Nothing sent.

⚡ **Just install and browse.** Everything enabled by default.

---

<div align="center">

### Made with ❤️ by [roshanxcvi](https://github.com/roshanxcvi)

**Zenith AdBlocker v2.0.0** — Chrome

⭐ **Star this repo if Zenith helps you browse ad-free!**

</div>
