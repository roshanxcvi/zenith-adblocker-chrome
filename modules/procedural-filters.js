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
    if (arg.startsWith('/') && arg.endsWith('/')) {
      try { return new RegExp(arg.slice(1, -1)).test(text); } catch (e) { return false; }
    }
    return text.includes(arg);
  }

  // Climb up the DOM tree N levels OR until selector matches
  _upward(el, arg) {
    if (/^\d+$/.test(arg)) {
      let n = parseInt(arg, 10);
      let curr = el;
      while (n-- > 0 && curr) curr = curr.parentElement;
      return curr;
    }
    return el.closest(arg);
  }

  // Match by computed CSS — e.g. "background-image: /ads/"
  _matchesCss(el, arg) {
    const colon = arg.indexOf(':');
    if (colon === -1) return false;
    const prop = arg.slice(0, colon).trim();
    const valueArg = arg.slice(colon + 1).trim();
    let val;
    try { val = getComputedStyle(el).getPropertyValue(prop); } catch (e) { return false; }
    if (valueArg.startsWith('/') && valueArg.endsWith('/')) {
      try { return new RegExp(valueArg.slice(1, -1)).test(val); } catch (e) { return false; }
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
    let timer = null;
    const obs = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; this.run(); }, throttle);
    });
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  }
}
