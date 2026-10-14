/**
 * Filter Engine — parses AdBlock-style filter lists
 * and provides matching methods for URLs and elements.
 *
 * v1.2 hardening:
 *   M-D: try/catch around `new RegExp` so one malformed pattern doesn't
 *        lose all subsequent rules
 *   FE-3: cosmetic filter domain match is dot-anchored suffix, not substring
 *   FE-8: exception rules check resourceTypes too
 *   H-C: shouldBlock honors a real resourceType arg
 *
 * v1.3.3 audit fixes:
 *   FE-9  Rules with options Zenith can't enforce ($popup, $csp, $redirect,
 *         $removeparam, $document, $elemhide, ...) are skipped. Before, the
 *         option was ignored and the rule became a plain block, e.g.
 *         ||site.com^$popup blocked site.com entirely.
 *   FE-10 $domain= and $third-party / $first-party are kept (DNR can enforce
 *         them). Before they were dropped, so site-specific rules applied on
 *         every site.
 *   FE-11 Cosmetic "~domain" means "not on this domain". It was treated as
 *         "only on this domain" (the ~ was stripped), which inverted rules.
 *   FE-12 #@#, #?#, #$#, #%#, $$ and ##^ lines are skipped. Before they fell
 *         through to the network parser and became junk DNR rules that used
 *         up the 5,000-rule budget.
 *   FE-13 scriptletRules has no prototype (a "__proto__" domain can't reach
 *         Object.prototype); reset() clears scriptlets and procedural
 *         filters too, so list updates don't pile up duplicates.
 *   FE-14 URL regexes are compiled lazily; only CHECK_URL uses them, so the
 *         service worker no longer compiles every rule on each start.
 */

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

function _domainMatches(hostname, ruleDomain) {
  if (!hostname || !ruleDomain) return false;
  const h = String(hostname).toLowerCase().replace(/^www\./, '');
  const r = String(ruleDomain).toLowerCase().replace(/^www\./, '');
  if (!r) return false;
  return h === r || h.endsWith('.' + r);
}

// Lowercase ASCII hostname, as DNR requires. No wildcards / entities.
const DNR_DOMAIN = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/;

const TYPE_OPTIONS = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  sub_frame: 'sub_frame',
  frame: 'sub_frame',
  media: 'media',
  ping: 'ping',
  beacon: 'ping',
  font: 'font',
  object: 'object',
  websocket: 'websocket',
  other: 'other',
};

// Unsupported cosmetic / snippet syntaxes: #@#, #?#, #$#, #%#, #@?#, #@$#, $$, ##^
const UNSUPPORTED_SYNTAX = /#[@?$%]+#|\$\$|##\^/;

function splitDomains(list) {
  const include = [];
  const exclude = [];
  for (const raw of String(list || '').split(',')) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.startsWith('~')) exclude.push(d.slice(1));
    else include.push(d);
  }
  return { include, exclude };
}

export class FilterEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.networkFilters = [];
    this.cosmeticFilters = [];
    this.exceptions = [];
    this.scriptletRules = Object.create(null);   // { hostname: [{name, args}, ...] }
    this.proceduralFilters = [];                 // [{host, selector}, ...]
  }

  /**
   * Parse a raw filter list string into structured rules.
   */
  parse(rawText) {
    const lines = String(rawText || '').split('\n');

    for (let line of lines) {
      try {
        line = line.trim();

        if (!line || line.startsWith('!') || line.startsWith('[')) continue;
        if (UNSUPPORTED_SYNTAX.test(line)) continue;

        if (line.startsWith('@@')) {
          const rule = this._buildNetworkRule(line.slice(2));
          if (rule) this.exceptions.push(rule);
          continue;
        }

        if (line.includes('##+js(')) {
          this._parseScriptletRule(line);
          continue;
        }

        if (line.includes('##') && /:has-text\(|:upward\(|:matches-css\(|:min-text-length\(|:remove\(/.test(line)) {
          const idx = line.indexOf('##');
          const domains = line.slice(0, idx);
          const selector = line.slice(idx + 2);
          if (!selector) continue;
          const hosts = domains ? domains.split(',') : [''];
          for (const h of hosts) {
            this.proceduralFilters.push({ host: h.trim().toLowerCase(), selector });
          }
          continue;
        }

        if (line.includes('##')) {
          const idx = line.indexOf('##');
          const selector = line.slice(idx + 2);
          if (!selector) continue;
          const { include, exclude } = splitDomains(line.slice(0, idx));
          this.cosmeticFilters.push({ domains: include, excludeDomains: exclude, selector });
          continue;
        }

        // Anything else containing '#' is a syntax we don't understand.
        if (line.includes('#')) continue;

        const rule = this._buildNetworkRule(line);
        if (rule) this.networkFilters.push(rule);
      } catch (e) {
        _logBadRule('parse', line, e);
      }
    }
  }

  _parseScriptletRule(line) {
    try {
      const parts = line.split('##+js(');
      if (parts.length !== 2) return;
      const domains = parts[0] ? parts[0].split(',').map(d => d.trim().toLowerCase()).filter(Boolean) : ['*'];
      const argsRaw = parts[1].replace(/\)\s*$/, '');
      const argParts = argsRaw.split(',').map(s => s.trim());
      const name = argParts[0];
      if (!name) return;
      const scriptlet = { name, args: argParts.slice(1) };
      for (const host of domains) {
        if (host.startsWith('~')) continue;   // exclusions not supported: skip rather than misapply
        const key = host || '*';
        if (!this.scriptletRules[key]) this.scriptletRules[key] = [];
        this.scriptletRules[key].push(scriptlet);
      }
    } catch (e) {
      _logBadRule('scriptletRule', line, e);
    }
  }

  /**
   * Parse "pattern$options" into a rule the DNR converter can enforce, or
   * null if it uses an option we can't honor.
   */
  _buildNetworkRule(pattern) {
    try {
      let domainType = null;
      const resourceTypes = [];
      const excludedResourceTypes = [];
      let initiatorDomains = [];
      let excludedInitiatorDomains = [];

      const dollar = pattern.lastIndexOf('$');
      // "/ads$/" is a regex ending in $, not an options separator.
      const dollarInRegex = pattern.startsWith('/') && pattern.endsWith('/') && dollar === pattern.length - 2;
      if (dollar > 0 && !dollarInRegex) {
        const options = pattern.slice(dollar + 1);
        pattern = pattern.slice(0, dollar);

        for (const raw of options.split(',')) {
          const opt = raw.trim().toLowerCase();
          if (!opt || opt === 'match-case' || opt === 'important') continue;
          if (opt === 'third-party' || opt === '3p') { domainType = 'thirdParty'; continue; }
          if (opt === 'first-party' || opt === '1p' || opt === '~third-party') { domainType = 'firstParty'; continue; }
          if (opt.startsWith('domain=')) {
            const { include, exclude } = splitDomains(opt.slice(7).replace(/\|/g, ','));
            if (![...include, ...exclude].every(d => DNR_DOMAIN.test(d))) return null;
            initiatorDomains = include;
            excludedInitiatorDomains = exclude;
            continue;
          }
          const neg = opt.startsWith('~');
          const type = TYPE_OPTIONS[neg ? opt.slice(1) : opt];
          if (type) { (neg ? excludedResourceTypes : resourceTypes).push(type); continue; }
          return null;   // popup, csp, redirect, removeparam, document, ... — can't enforce
        }
      }

      if (!pattern || pattern.length < 2) return null;

      return {
        pattern,
        regex: null,   // compiled on first use by shouldBlock()
        isThirdParty: domainType === 'thirdParty',
        domainType,
        resourceTypes,
        excludedResourceTypes,
        initiatorDomains,
        excludedInitiatorDomains,
      };
    } catch (e) {
      _logBadRule('buildNetworkRule', pattern, e);
      return null;
    }
  }

  _regexFor(rule) {
    if (rule.regex !== null) return rule.regex;
    try {
      let regex = rule.pattern
        .replace(/\*\*/g, '*')
        .replace(/[.+?{}()[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\^/g, '([^a-zA-Z0-9_.%-]|$)');
      if (regex.startsWith('||')) {
        regex = '(^https?://([a-z0-9-]+\\.)*?)' + regex.slice(2);
      }
      rule.regex = new RegExp(regex, 'i');
    } catch (e) {
      _logBadRule('buildNetworkRule', rule.pattern, e);
      rule.regex = false;
    }
    return rule.regex;
  }

  /**
   * Check if a URL should be blocked (used by the CHECK_URL message).
   */
  shouldBlock(url, sourceUrl = '', resourceType = '') {
    if (!url) return false;

    const matches = (rule) => {
      const re = this._regexFor(rule);
      if (!re || !re.test(url)) return false;
      if (rule.resourceTypes.length > 0) {
        if (!resourceType || !rule.resourceTypes.includes(resourceType)) return false;
      }
      if (resourceType && rule.excludedResourceTypes.includes(resourceType)) return false;
      return true;
    };

    for (const rule of this.exceptions) {
      if (rule && matches(rule)) return false;
    }
    for (const rule of this.networkFilters) {
      if (rule && matches(rule)) return true;
    }
    return false;
  }

  /**
   * CSS selectors to hide for a hostname.
   * Applies when the host isn't excluded, and either the rule has no
   * domain list or the host matches one of its domains.
   */
  getCosmeticSelectors(hostname) {
    const selectors = [];
    for (const filter of this.cosmeticFilters) {
      if (!filter || !filter.selector) continue;
      const exclude = filter.excludeDomains || [];
      if (exclude.some(d => _domainMatches(hostname, d))) continue;
      if (filter.domains.length === 0 || filter.domains.some(d => _domainMatches(hostname, d))) {
        selectors.push(filter.selector);
      }
    }
    return selectors;
  }
}
