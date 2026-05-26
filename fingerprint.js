(function(){
  'use strict';
  //
  // Zenith Fingerprint Protection — Selective Mode
  // ──────────────────────────────────────────────
  //
  // v1.0 applied canvas noise on EVERY toDataURL() call, which broke
  // legitimate apps (drawing tools, games, screenshot exporters) and was
  // trivially detectable by sites that compare two consecutive toDataURL
  // calls on the same canvas (they would differ by 1 pixel each time).
  //
  // v1.1 uses a heuristic: noise is ONLY applied when the call pattern
  // matches fingerprinting:
  //
  //   1. Canvas is small (<= 300x150 — the standard fingerprint size)
  //   2. Text was drawn on it recently (<100ms ago)
  //   3. toDataURL/getImageData is being called WITHOUT the canvas having
  //      been added to the DOM (fingerprinters keep canvases off-screen)
  //
  // Real drawing apps:
  //   - Use canvases attached to the DOM
  //   - Are usually larger than 300x150
  //   - Don't call toDataURL() within 100ms of drawing text
  //
  // This drastically reduces both false positives (breaking legit apps)
  // AND detectability (sites that test for noise on non-fingerprint canvases
  // see clean output, so they can't fingerprint Zenith's presence).
  //
  try {

    const META = Symbol('zenith.canvas.meta');

    function isLikelyFingerprintCanvas(canvas) {
      if (!canvas) return false;
      // Small canvas?
      const small = canvas.width <= 300 && canvas.height <= 150;
      if (!small) return false;
      // Off-DOM?
      const offDom = !canvas.isConnected;
      if (!offDom) return false;
      // Text drawn recently?
      const meta = canvas[META];
      if (!meta) return false;
      const drewTextRecently = (performance.now() - (meta.lastText || 0)) < 100;
      return drewTextRecently;
    }

    // ── Track fillText / strokeText calls so we know "text was just drawn"
    try {
      const protoFill = CanvasRenderingContext2D.prototype.fillText;
      const protoStroke = CanvasRenderingContext2D.prototype.strokeText;
      CanvasRenderingContext2D.prototype.fillText = function() {
        try {
          const c = this.canvas;
          if (c) {
            if (!c[META]) c[META] = {};
            c[META].lastText = performance.now();
          }
        } catch (e) {}
        return protoFill.apply(this, arguments);
      };
      CanvasRenderingContext2D.prototype.strokeText = function() {
        try {
          const c = this.canvas;
          if (c) {
            if (!c[META]) c[META] = {};
            c[META].lastText = performance.now();
          }
        } catch (e) {}
        return protoStroke.apply(this, arguments);
      };
    } catch (e) {}

    // ── Selective canvas noise
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      if (isLikelyFingerprintCanvas(this)) {
        try {
          const ctx = this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            const d = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
            for (let i = 0; i < Math.min(d.data.length, 64); i += 4) {
              d.data[i] = (d.data[i] + (Math.random() > 0.5 ? 1 : -1)) & 0xFF;
            }
            ctx.putImageData(d, 0, 0);
          }
        } catch (e) {}
      }
      return origToDataURL.apply(this, arguments);
    };

    // Same for getImageData — fingerprinters often read pixels directly
    try {
      const origGID = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function() {
        const result = origGID.apply(this, arguments);
        if (isLikelyFingerprintCanvas(this.canvas)) {
          try {
            for (let i = 0; i < Math.min(result.data.length, 256); i += 4) {
              result.data[i] = (result.data[i] + (Math.random() > 0.5 ? 1 : -1)) & 0xFF;
            }
          } catch (e) {}
        }
        return result;
      };
    } catch (e) {}

    // ── WebGL: always spoof these specific params (they're rarely used for
    //    legit purposes — they're a fingerprinting-specific extension)
    function patchWebGL(proto) {
      try {
        const orig = proto.getParameter;
        proto.getParameter = function(p) {
          // UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL — only used by fingerprinters
          if (p === 0x9245) return 'Generic GPU Vendor';
          if (p === 0x9246) return 'Generic GPU Renderer';
          return orig.apply(this, arguments);
        };
      } catch (e) {}
    }
    try { patchWebGL(WebGLRenderingContext.prototype); } catch (e) {}
    try { if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype); } catch (e) {}

    // ── Navigator normalization (these have no legit use that breaks)
    try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch (e) {}

    // ── GPC & DNT signals
    try { Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true, configurable: true }); } catch (e) {}

    // ── Block Battery API (deprecated, only used for fingerprinting)
    try { if (navigator.getBattery) { delete navigator.getBattery; } } catch (e) {}

  } catch (e) {}
})();
