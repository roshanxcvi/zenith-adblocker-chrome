/**
 * Tracker Learning Engine (Privacy Badger-inspired)
 * 
 * Automatically learns which third-party domains are tracking users
 * by observing their behavior across multiple first-party sites.
 * If a domain appears on 3+ different sites, it's flagged as a tracker.
 * No need for predefined lists — this is behavioral detection.
 */
export class TrackerLearner {
  constructor() {
    this.domainSightings = {};  // { trackerDomain: Set<firstPartySite> }
    this.blockedDomains = new Set();
    this.allowedDomains = new Set();
    this.THRESHOLD = 3; // Seen on 3+ sites = tracker
  }

  async load() {
    try {
      const data = await chrome.storage.local.get(['trackerLearner']);
      if (data.trackerLearner) {
        const saved = data.trackerLearner;
        this.blockedDomains = new Set(saved.blockedDomains || []);
        this.allowedDomains = new Set(saved.allowedDomains || []);
        // Restore sightings (Sets don't serialize, so stored as arrays)
        for (const [domain, sites] of Object.entries(saved.domainSightings || {})) {
          this.domainSightings[domain] = new Set(sites);
        }
      }
    } catch (e) {
      console.warn('[TrackerLearner] Load failed:', e);
    }
  }

  async save() {
    const serializable = {
      blockedDomains: [...this.blockedDomains],
      allowedDomains: [...this.allowedDomains],
      domainSightings: {}
    };
    for (const [domain, sites] of Object.entries(this.domainSightings)) {
      serializable.domainSightings[domain] = [...sites];
    }
    await chrome.storage.local.set({ trackerLearner: serializable });
  }

  /**
   * Record a third-party request seen on a first-party site.
   * Returns true if this domain should now be blocked.
   */
  recordSighting(thirdPartyDomain, firstPartyDomain) {
    // Skip if explicitly allowed
    if (this.allowedDomains.has(thirdPartyDomain)) return false;
    // Skip if already blocked
    if (this.blockedDomains.has(thirdPartyDomain)) return true;

    // Skip same-domain
    if (thirdPartyDomain === firstPartyDomain) return false;
    // Skip common CDNs and legitimate services
    if (this._isLegitimate(thirdPartyDomain)) return false;

    if (!this.domainSightings[thirdPartyDomain]) {
      this.domainSightings[thirdPartyDomain] = new Set();
    }

    this.domainSightings[thirdPartyDomain].add(firstPartyDomain);

    // Check threshold
    if (this.domainSightings[thirdPartyDomain].size >= this.THRESHOLD) {
      this.blockedDomains.add(thirdPartyDomain);
      // Batch save periodically
      if (this.blockedDomains.size % 5 === 0) this.save();
      return true;
    }

    return false;
  }

  isBlocked(domain) {
    return this.blockedDomains.has(domain);
  }

  allowDomain(domain) {
    this.blockedDomains.delete(domain);
    this.allowedDomains.add(domain);
    this.save();
  }

  getLearnedTrackers() {
    return [...this.blockedDomains].map(domain => ({
      domain,
      seenOn: this.domainSightings[domain]
        ? [...this.domainSightings[domain]]
        : []
    }));
  }

  getStats() {
    return {
      learnedTrackers: this.blockedDomains.size,
      domainsMonitored: Object.keys(this.domainSightings).length,
      allowedDomains: this.allowedDomains.size
    };
  }

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
    return legitimate.some(l => domain.endsWith(l));
  }

  async reset() {
    this.domainSightings = {};
    this.blockedDomains = new Set();
    this.allowedDomains = new Set();
    await this.save();
  }
}
