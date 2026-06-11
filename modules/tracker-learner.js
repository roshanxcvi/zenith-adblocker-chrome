/**
 * Tracker Learning Engine (Privacy Badger-inspired)
 *
 * Automatically learns which third-party domains are tracking users
 * by observing their behavior across multiple first-party sites.
 * If a domain appears on 3+ different sites, it's flagged as a tracker.
 *
 * v1.1 hardening:
 *   M-B: `_isLegitimate` uses dot-anchored suffix match — 'evilgoogleapis.com'
 *        no longer matches 'googleapis.com'
 *   M-C: `domainSightings` capped to 500 most-recently-seen domains with
 *        LRU-style eviction. Sightings older than the cap are evicted.
 *        Also bounds first-party site list per domain.
 *   - Domain length cap to bound storage growth from huge subdomains
 *   - Save() is debounced so we don't hammer storage on bursty pages
 *   - load() is defensive against corrupted storage entries
 */
export class TrackerLearner {
  constructor() {
    this.domainSightings = {};   // { trackerDomain: { sites: Set, lastSeen: ts } }
    this.blockedDomains = new Set();
    this.allowedDomains = new Set();
    this.THRESHOLD = 3;          // Seen on 3+ sites = tracker
    this.MAX_DOMAINS = 500;      // M-C — LRU cap
    this.MAX_SITES_PER_DOMAIN = 20;
    this.MAX_DOMAIN_LEN = 253;   // RFC max DNS hostname length
    this._saveTimer = null;
    this._saveDelayMs = 2000;
  }

  async load() {
    try {
      const data = await chrome.storage.local.get(['trackerLearner']);
      if (!data || !data.trackerLearner) return;
      const saved = data.trackerLearner;
      try { this.blockedDomains = new Set((saved.blockedDomains || []).filter(x => typeof x === 'string')); } catch (e) {}
      try { this.allowedDomains = new Set((saved.allowedDomains || []).filter(x => typeof x === 'string')); } catch (e) {}
      // Sightings can be in either the OLD shape (domain -> string[])
      // or the NEW shape (domain -> { sites: string[], lastSeen: number }).
      // Handle both for forward compatibility.
      for (const [domain, val] of Object.entries(saved.domainSightings || {})) {
        if (typeof domain !== 'string' || domain.length > this.MAX_DOMAIN_LEN) continue;
        if (Array.isArray(val)) {
          this.domainSightings[domain] = { sites: new Set(val.slice(0, this.MAX_SITES_PER_DOMAIN)), lastSeen: 0 };
        } else if (val && typeof val === 'object') {
          this.domainSightings[domain] = {
            sites: new Set((val.sites || []).slice(0, this.MAX_SITES_PER_DOMAIN)),
            lastSeen: Number(val.lastSeen) || 0,
          };
        }
      }
      // If we loaded more than the cap (from old data), trim now.
      this._trimToCap();
    } catch (e) {
      console.warn('[TrackerLearner] Load failed:', e);
    }
  }

  async save() {
    try {
      const serializable = {
        blockedDomains: [...this.blockedDomains],
        allowedDomains: [...this.allowedDomains],
        domainSightings: {},
      };
      for (const [domain, info] of Object.entries(this.domainSightings)) {
        serializable.domainSightings[domain] = {
          sites: [...info.sites],
          lastSeen: info.lastSeen,
        };
      }
      await chrome.storage.local.set({ trackerLearner: serializable });
    } catch (e) {
      console.warn('[TrackerLearner] Save failed:', e);
    }
  }

  // M-C — debounced save instead of fire-and-forget.
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(() => {});
    }, this._saveDelayMs);
  }

  // M-C — evict least-recently-seen domains down to the cap.
  _trimToCap() {
    const entries = Object.entries(this.domainSightings);
    if (entries.length <= this.MAX_DOMAINS) return;
    entries.sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    const toDelete = entries.length - this.MAX_DOMAINS;
    for (let i = 0; i < toDelete; i++) {
      delete this.domainSightings[entries[i][0]];
    }
  }

  /**
   * Record a third-party request seen on a first-party site.
   * Returns true if this domain should now be blocked.
   */
  recordSighting(thirdPartyDomain, firstPartyDomain) {
    // Defensive input validation
    if (typeof thirdPartyDomain !== 'string' || typeof firstPartyDomain !== 'string') return false;
    if (!thirdPartyDomain || !firstPartyDomain) return false;
    if (thirdPartyDomain.length > this.MAX_DOMAIN_LEN || firstPartyDomain.length > this.MAX_DOMAIN_LEN) return false;

    const t = thirdPartyDomain.toLowerCase();
    const f = firstPartyDomain.toLowerCase();

    if (this.allowedDomains.has(t)) return false;
    if (this.blockedDomains.has(t)) return true;
    if (t === f) return false;
    if (this._isLegitimate(t)) return false;

    let info = this.domainSightings[t];
    if (!info) {
      info = this.domainSightings[t] = { sites: new Set(), lastSeen: 0 };
    }

    // Bound per-domain site list
    if (info.sites.size < this.MAX_SITES_PER_DOMAIN) {
      info.sites.add(f);
    }
    info.lastSeen = Date.now();

    // Trim if we've exceeded the global cap
    if (Object.keys(this.domainSightings).length > this.MAX_DOMAINS) {
      this._trimToCap();
    }

    if (info.sites.size >= this.THRESHOLD) {
      this.blockedDomains.add(t);
      this._scheduleSave();
      return true;
    }

    // Periodic save anyway (every ~10s of activity)
    this._scheduleSave();
    return false;
  }

  isBlocked(domain) {
    if (typeof domain !== 'string') return false;
    return this.blockedDomains.has(domain.toLowerCase());
  }

  allowDomain(domain) {
    if (typeof domain !== 'string') return;
    const d = domain.toLowerCase();
    this.blockedDomains.delete(d);
    this.allowedDomains.add(d);
    this._scheduleSave();
  }

  getLearnedTrackers() {
    return [...this.blockedDomains].map(domain => ({
      domain,
      seenOn: this.domainSightings[domain]
        ? [...this.domainSightings[domain].sites]
        : [],
    }));
  }

  getStats() {
    return {
      learnedTrackers: this.blockedDomains.size,
      domainsMonitored: Object.keys(this.domainSightings).length,
      allowedDomains: this.allowedDomains.size,
    };
  }

  // M-B — dot-anchored suffix match. 'sub.googleapis.com' and 'googleapis.com'
  // both match the 'googleapis.com' entry. 'evilgoogleapis.com' does NOT.
  _isLegitimate(domain) {
    const legitimate = [
      'googleapis.com', 'gstatic.com', 'cloudflare.com',
      'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
      'fonts.googleapis.com', 'fonts.gstatic.com',
      'ajax.googleapis.com', 'code.jquery.com',
      'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com',
      'cdn.cloudflare.com', 'fastly.net', 'akamaized.net',
      'gravatar.com', 'wp.com', 'wordpress.com',
      'github.com', 'githubusercontent.com',
      'recaptcha.net', 'hcaptcha.com',
      'stripe.com', 'paypal.com',
    ];
    const h = domain.toLowerCase();
    for (const l of legitimate) {
      if (h === l || h.endsWith('.' + l)) return true;
    }
    return false;
  }

  async reset() {
    this.domainSightings = {};
    this.blockedDomains = new Set();
    this.allowedDomains = new Set();
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    await this.save();
  }
}
