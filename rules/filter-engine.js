/**
 * Filter Engine — parses AdBlock-style filter lists
 * and provides matching methods for URLs and elements.
 *
 * v1.2hardening:
 *   M-D: try/catch around `new RegExp` so one malformed pattern doesn't
 *        lose all subsequent rules
 *   FE-3: cosmetic filter domain match is now dot-anchored suffix, not
 *         substring (so a filter for 'example.com' doesn't accidentally
 *         apply to 'notexample.com' or 'example.com.attacker.com')
 *   FE-8: exception rules now check resourceTypes too
 *   H-C: shouldBlock honors a real resourceType arg
 */

// Cheap local helpers — avoids creating a hard dependency on security.js
// since this module is also imported into the engine directly.
function _logBadRule(where, line, err) {
  try {
    self.__zenithErrorCount = (self.__zenithErrorCount || 0) + 1;
    self.__zenithLastError = {
      where: 'filter-engine:' + where,
      message: String(err && err.message || err),
      line: String(line || '').slice(0, 200),
      ts: Date.now(),
    };
  } catch (_) {}
}

// FE-3 — dot-anchored suffix match for cosmetic filter domains.
// 'example.com' matches 'example.com' and 'sub.example.com'.
// Does NOT match 'notexample.com' or 'example.com.attacker.com'.
function _domainMatches(hostname, ruleDomain) {
  if (!hostname || !ruleDomain) return false;
  const h = String(hostname).toLowerCase().replace(/^www\./, '');
  const r = String(ruleDomain).toLowerCase().replace(/^~/, '').replace(/^www\./, '');
  if (!r) return false;
  return h === r || h.endsWith('.' + r);
}

export class FilterEngine {
  constructor() {
    this.networkFilters = [];
    this.cosmeticFilters = [];
    this.exceptions = [];
    this.scriptletRules = {};      // { hostname: [{name, args}, ...] }
    this.proceduralFilters = [];   // [{host, selector}, ...]
  }

  /**
   * Parse a raw filter list string into structured rules.
   */
  parse(rawText) {
    const lines = rawText.split('\n');

    for (let line of lines) {
      try {
        line = line.trim();

        // Skip comments and empty lines
        if (!line || line.startsWith('!') || line.startsWith('[')) continue;

        // Exception rules (whitelist)
        if (line.startsWith('@@')) {
          const rule = this._buildNetworkRule(line.slice(2));
          if (rule) this.exceptions.push(rule);
          continue;
        }

        // SCRIPTLET RULES — example.com##+js(set-constant, ads.loaded, true)
        if (line.includes('##+js(')) {
          this._parseScriptletRule(line);
          continue;
        }

        // PROCEDURAL COSMETIC FILTERS
        if (line.includes('##') && /:has-text\(|:upward\(|:matches-css\(|:min-text-length\(|:remove\(/.test(line)) {
          const [domains, selector] = line.split('##');
          if (!selector) continue;
          const hosts = domains ? domains.split(',') : [''];
          for (const h of hosts) {
            this.proceduralFilters.push({ host: h.trim(), selector });
          }
          continue;
        }

        // Cosmetic filters (element hiding)
        if (line.includes('##')) {
          const [domains, selector] = line.split('##');
          if (!selector) continue;
          this.cosmeticFilters.push({
            domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
            selector,
          });
          continue;
        }

        // Network filters
        const rule = this._buildNetworkRule(line);
        if (rule) this.networkFilters.push(rule);
      } catch (e) {
        _logBadRule('parse', line, e);
        // Keep going — one bad rule must not kill the whole list
      }
    }
  }

  /**
   * Parse a scriptlet rule like: example.com##+js(set-constant, name, value)
   */
  _parseScriptletRule(line) {
    try {
      const parts = line.split('##+js(');
      if (parts.length !== 2) return;
      const domains = parts[0] ? parts[0].split(',').map(d => d.trim()).filter(Boolean) : ['*'];
      const argsRaw = parts[1].replace(/\)\s*$/, ''); // strip trailing )
      const argParts = argsRaw.split(',').map(s => s.trim());
      const name = argParts[0];
      if (!name) return;
      const scriptlet = { name, args: argParts.slice(1) };
      for (const host of domains) {
        const key = host || '*';
        if (!this.scriptletRules[key]) this.scriptletRules[key] = [];
        this.scriptletRules[key].push(scriptlet);
      }
    } catch (e) {
      _logBadRule('scriptletRule', line, e);
    }
  }

  /**
   * Convert a filter pattern to a regex-based rule object.
   * M-D — returns null on regex compilation failure rather than throwing,
   * so the caller can skip the rule and continue with the rest.
   */
  _buildNetworkRule(pattern) {
    try {
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
          if (opt === 'sub_frame' || opt === 'subdocument') resourceTypes.push('sub_frame');
          if (opt === 'media') resourceTypes.push('media');
          if (opt === 'ping') resourceTypes.push('ping');
          if (opt === 'font') resourceTypes.push('font');
          if (opt === 'other') resourceTypes.push('other');
        }
      }

      // Refuse trivially-short patterns (nothing left after $)
      if (!pattern || pattern.length < 2) return null;

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

      // M-D — try/catch the actual compile
      const compiled = new RegExp(regex, 'i');

      return {
        pattern,
        regex: compiled,
        isThirdParty,
        resourceTypes,
      };
    } catch (e) {
      _logBadRule('buildNetworkRule', pattern, e);
      return null;
    }
  }

  /**
   * Check if a URL should be blocked.
   * H-C — resourceType is now used meaningfully. If the caller doesn't
   * provide one, type-restricted rules are SKIPPED (not matched) so we
   * err on the side of "don't block" rather than "block everything".
   * FE-8 — exception rules ALSO check resourceTypes.
   */
  shouldBlock(url, sourceUrl = '', resourceType = '') {
    if (!url) return false;

    // Check exception rules first
    for (const rule of this.exceptions) {
      if (!rule || !rule.regex.test(url)) continue;
      // If exception is type-restricted and we know the type, only match
      // when the type lines up.
      if (rule.resourceTypes.length > 0) {
        if (!resourceType) continue; // unknown type — can't trust the exception
        if (!rule.resourceTypes.includes(resourceType)) continue;
      }
      return false;
    }

    // Check block rules
    for (const rule of this.networkFilters) {
      if (!rule || !rule.regex.test(url)) continue;
      if (rule.resourceTypes.length > 0) {
        if (!resourceType) continue; // unknown type → conservative: skip type-restricted
        if (!rule.resourceTypes.includes(resourceType)) continue;
      }
      return true;
    }

    return false;
  }

  /**
   * Get CSS selectors to hide for a given hostname.
   * FE-3 — domain match is now proper suffix matching, not substring.
   */
  getCosmeticSelectors(hostname) {
    const selectors = [];
    for (const filter of this.cosmeticFilters) {
      if (!filter || !filter.selector) continue;
      if (filter.domains.length === 0) {
        // Global selector
        selectors.push(filter.selector);
        continue;
      }
      for (const d of filter.domains) {
        if (_domainMatches(hostname, d)) {
          selectors.push(filter.selector);
          break;
        }
      }
    }
    return selectors;
  }
}
