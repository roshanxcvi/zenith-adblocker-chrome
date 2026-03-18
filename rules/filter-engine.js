/**
 * Filter Engine — parses AdBlock-style filter lists
 * and provides matching methods for URLs and elements.
 */
export class FilterEngine {
  constructor() {
    this.networkFilters = [];
    this.cosmeticFilters = [];
    this.exceptions = [];
  }

  /**
   * Parse a raw filter list string into structured rules.
   */
  parse(rawText) {
    const lines = rawText.split('\n');

    for (let line of lines) {
      line = line.trim();

      // Skip comments and empty lines
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;

      // Exception rules (whitelist)
      if (line.startsWith('@@')) {
        this.exceptions.push(this._buildNetworkRule(line.slice(2)));
        continue;
      }

      // Cosmetic filters (element hiding)
      if (line.includes('##')) {
        const [domains, selector] = line.split('##');
        this.cosmeticFilters.push({
          domains: domains ? domains.split(',') : [],
          selector: selector
        });
        continue;
      }

      // Network filters
      this.networkFilters.push(this._buildNetworkRule(line));
    }
  }

  /**
   * Convert a filter pattern to a regex-based rule object.
   */
  _buildNetworkRule(pattern) {
    let isThirdParty = false;
    let resourceTypes = [];

    // Handle options after $
    if (pattern.includes('$')) {
      const [rawPattern, options] = pattern.split('$');
      pattern = rawPattern;

      for (const opt of options.split(',')) {
        if (opt === 'third-party') isThirdParty = true;
        if (opt === 'script') resourceTypes.push('script');
        if (opt === 'image') resourceTypes.push('image');
        if (opt === 'stylesheet') resourceTypes.push('stylesheet');
        if (opt === 'xmlhttprequest') resourceTypes.push('xmlhttprequest');
      }
    }

    // Convert AdBlock pattern to regex
    let regex = pattern
      .replace(/\*\*/g, '*')                       // collapse double wildcards
      .replace(/[.+?{}()[\]\\]/g, '\\$&')          // escape regex specials
      .replace(/\*/g, '.*')                         // wildcard → .*
      .replace(/\^/g, '([^a-zA-Z0-9_.%-]|$)');     // separator char

    // Handle domain anchoring ||
    if (regex.startsWith('||')) {
      regex = '(^https?://([a-z0-9-]+\\.)*?)' + regex.slice(2);
    }

    return {
      pattern,
      regex: new RegExp(regex, 'i'),
      isThirdParty,
      resourceTypes
    };
  }

  /**
   * Check if a URL should be blocked.
   */
  shouldBlock(url, sourceUrl = '', resourceType = '') {
    // Check exception rules first
    for (const rule of this.exceptions) {
      if (rule.regex.test(url)) return false;
    }

    // Check block rules
    for (const rule of this.networkFilters) {
      if (rule.regex.test(url)) {
        if (rule.resourceTypes.length > 0 &&
            !rule.resourceTypes.includes(resourceType)) {
          continue;
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Get CSS selectors to hide for a given hostname.
   */
  getCosmeticSelectors(hostname) {
    const selectors = [];

    for (const filter of this.cosmeticFilters) {
      if (filter.domains.length === 0) {
        // Global selector
        selectors.push(filter.selector);
      } else if (filter.domains.some(d => hostname.includes(d))) {
        selectors.push(filter.selector);
      }
    }

    return selectors;
  }
}
