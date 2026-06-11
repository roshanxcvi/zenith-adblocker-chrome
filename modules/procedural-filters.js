/**
 * Zenith Procedural Cosmetic Filters
 * by roshanxcvi
 *
 * Implements uBlock-style procedural selectors that go beyond CSS:
 * - :has-text("Sponsored")   — element contains text
 * - :upward(N)               — climb N parents up
 * - :upward(selector)        — climb until matching selector
 * - :matches-css(prop:value) — match by computed style
 * - :min-text-length(N)      — element has at least N chars of text
 * - :remove()                — remove instead of hide (chained)
 *
 * Example filters:
 *   ##div:has-text(Sponsored)
 *   ##.post:has-text(Promoted):upward(.feed-item)
 *   ##div:matches-css(background-image: /ads/):remove()
 */

export class ProceduralFilters {
  constructor() {
    this.filters = [];
    this.hiddenElements = new WeakSet();
    // L-A — track observer + throttle timer so we can disconnect on unload
    this._observer = null;
    this._timer = null;
    this._pagehideBound = null;
  }

  /**
   * M-E — compile a regex from an untrusted filter argument, but REFUSE
   * patterns that are prone to catastrophic backtracking (ReDoS). A
   * procedural filter like ##div:has-text(/(a+)+$/) would otherwise hang
   * the page on every DOM mutation. Returns a RegExp or null.
   *
   * Heuristics (conservative — better to skip a filter than freeze a tab):
   *   - reject nested quantifiers:    (…+)+   (…*)*   (…+)*   (…*)+
   *   - reject quantified groups that themselves contain a quantifier
   *   - reject quantifier applied to a group containing alternation: (a|aa)+
   *   - cap overall pattern length at 200 chars
   */
  static _safeRegex(pattern, flags = '') {
    if (typeof pattern !== 'string') return null;
    if (pattern.length > 200) return null;

    // Nested quantifier: a quantifier immediately after a ) that closes a
    // group whose body also contained a quantifier. We approximate with a
    // few well-known dangerous shapes.
    const DANGEROUS = [
      /\([^)]*[+*][^)]*\)\s*[+*]/,   // (…+…)+  or (…*…)*  etc — quantifier inside AND after a group
      /\([^)]*\|[^)]*\)\s*[+*]/,     // (a|b)+ style alternation under a quantifier
      /[+*]\s*[+*]/,                 // consecutive quantifiers  a*+ / .*+
      /\{\d{3,}\}/,                  // absurd bounded repetition {1000}
    ];
    for (const d of DANGEROUS) {
      if (d.test(pattern)) return null;
    }

    try {
      return new RegExp(pattern, flags);
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse a procedural filter string into operation chain
   */
  parse(filter) {
    if (!filter || !filter.includes(':')) return null;
    
    // Quick check: does it contain procedural operators?
    if (!/:has-text\(|:upward\(|:matches-css\(|:min-text-length\(|:remove\(/.test(filter)) {
      return null;
    }

    const ops = [];
    let remaining = filter;
    let baseSelector = '';
    let inProcedural = false;

    // Extract base selector (everything before first procedural op)
    const firstProcMatch = remaining.match(/(.*?):(has-text|upward|matches-css|min-text-length|remove)\(/);
    if (!firstProcMatch) return null;
    baseSelector = firstProcMatch[1] || '*';

    // Parse operations
    const opRegex = /:(has-text|upward|matches-css|min-text-length|remove)\(([^)]*)\)/g;
    let m;
    while ((m = opRegex.exec(filter)) !== null) {
      ops.push({ type: m[1], arg: m[2].trim() });
    }

    return { baseSelector, ops };
  }

  /**
   * Apply a parsed filter to find matching elements
   */
  apply(parsed) {
    if (!parsed) return [];
    let elements;
    try {
      elements = Array.from(document.querySelectorAll(parsed.baseSelector));
    } catch (e) {
      return [];
    }

    let shouldRemove = false;

    for (const op of parsed.ops) {
      switch (op.type) {
        case 'has-text':
          elements = elements.filter(el => this._hasText(el, op.arg));
          break;
        case 'upward':
          elements = elements.map(el => this._upward(el, op.arg)).filter(Boolean);
          break;
        case 'matches-css':
          elements = elements.filter(el => this._matchesCss(el, op.arg));
          break;
        case 'min-text-length':
          const min = parseInt(op.arg, 10);
          elements = elements.filter(el => (el.textContent || '').trim().length >= min);
          break;
        case 'remove':
          shouldRemove = true;
          break;
      }
    }

    return { elements: [...new Set(elements)], remove: shouldRemove };
  }

  // Check if element contains given text (string or /regex/)
  _hasText(el, arg) {
    const text = (el.textContent || '').trim();
    if (arg.startsWith('/') && arg.endsWith('/') && arg.length > 2) {
      // M-E — compile via the ReDoS-safe path. If the pattern is rejected,
      // degrade to a literal substring search of the inner pattern so the
      // filter still does *something* instead of silently doing nothing.
      const re = ProceduralFilters._safeRegex(arg.slice(1, -1));
      if (re) {
        try { return re.test(text); } catch (e) { return false; }
      }
      return text.includes(arg.slice(1, -1));
    }
    return text.includes(arg);
  }

  // Climb up the DOM tree N levels OR until selector matches
  _upward(el, arg) {
    if (/^\d+$/.test(arg)) {
      let n = parseInt(arg, 10);
      // sanity cap — nobody climbs 50 levels; prevents a pathological arg
      if (n > 50) n = 50;
      let curr = el;
      while (n-- > 0 && curr) curr = curr.parentElement;
      return curr;
    }
    // L-B — closest() throws a DOMException on a malformed selector. The
    // arg comes from a filter list, so it may be invalid. Guard it.
    try {
      return el.closest(arg);
    } catch (e) {
      return null;
    }
  }

  // Match by computed CSS — e.g. "background-image: /ads/"
  _matchesCss(el, arg) {
    const colon = arg.indexOf(':');
    if (colon === -1) return false;
    const prop = arg.slice(0, colon).trim();
    const valueArg = arg.slice(colon + 1).trim();
    let val;
    try { val = getComputedStyle(el).getPropertyValue(prop); } catch (e) { return false; }
    if (valueArg.startsWith('/') && valueArg.endsWith('/') && valueArg.length > 2) {
      // M-E — ReDoS-safe compile
      const re = ProceduralFilters._safeRegex(valueArg.slice(1, -1));
      if (re) {
        try { return re.test(val); } catch (e) { return false; }
      }
      return val.includes(valueArg.slice(1, -1));
    }
    return val.includes(valueArg);
  }

  // Add a filter to the active set
  add(filter) {
    const parsed = this.parse(filter);
    if (parsed) this.filters.push({ raw: filter, parsed });
  }

  // Run all active filters and hide matched elements
  run() {
    let hiddenCount = 0;
    for (const f of this.filters) {
      const result = this.apply(f.parsed);
      if (!result || !result.elements) continue;
      for (const el of result.elements) {
        if (!el || this.hiddenElements.has(el)) continue;
        this.hiddenElements.add(el);
        if (result.remove) {
          try { el.remove(); } catch (e) {}
        } else {
          try { el.style.setProperty('display', 'none', 'important'); } catch (e) {}
        }
        hiddenCount++;
      }
    }
    return hiddenCount;
  }

  // Start observing DOM for new elements that match filters
  observe(throttle = 1000) {
    if (this.filters.length === 0) return;
    this.run();

    // L-A — disconnect any previous observer/timer before creating new
    // ones. Without this, SPA route changes stack observers that each
    // re-run every filter on every mutation — a steady memory + CPU leak.
    this.disconnect();

    this._observer = new MutationObserver(() => {
      if (this._timer) return;
      this._timer = setTimeout(() => { this._timer = null; this.run(); }, throttle);
    });
    if (document.body) {
      this._observer.observe(document.body, { childList: true, subtree: true });
    }

    // L-A — tear everything down when the page goes away.
    if (!this._pagehideBound) {
      this._pagehideBound = () => this.disconnect();
      window.addEventListener('pagehide', this._pagehideBound);
    }
  }

  // L-A — explicit teardown. Safe to call multiple times.
  disconnect() {
    if (this._observer) {
      try { this._observer.disconnect(); } catch (e) {}
      this._observer = null;
    }
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
