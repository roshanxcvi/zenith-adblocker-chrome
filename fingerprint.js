(function(){
  'use strict';
  //
  // Zenith Fingerprint Protection — Selective Mode (v2.0.4)
  // ────────────────────────────────────────────────────────
  //
  // v1.1 audit fixes:
  //   M-04 getImageData noise is committed back to the canvas via
  //        putImageData so a subsequent toDataURL() returns a result
  //        consistent with the noised pixels (fingerprinters test the
  //        two APIs against each other).
  //   L-03 Battery API is overridden on Navigator.prototype instead of
  //        being deleted from the instance (delete fails silently on
  //        non-configurable prototype properties).
  //   I-01 Per-install seed makes spoofed values realistic-but-unique
  //        per Zenith install. The seed is generated once by content.js
  //        and passed via `<script data-zenith-seed="...">`.
  //
  // v1.1 Selective Mode (kept):
  //   Canvas noise applies only when the call pattern matches
  //   fingerprinting (small + off-DOM + text-just-drawn).
  //
  try {

    // ── I-01: per-install seed → deterministic PRNG ──────────────
    // The seed is on the script tag's dataset (or window.__zenithFpSeed
    // as a fallback for testing). If absent, fall back to old hardcoded
    // values so we degrade safely rather than fail.
    let seed = '';
    try {
      const me = document.currentScript;
      seed = (me && me.dataset && me.dataset.zenithSeed) || '';
    } catch (e) {}

    function seedToInt(s) {
      // Simple FNV-1a so different seeds produce different starting points
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
      }
      return h || 0x12345678;
    }

    // xorshift32 — fast, deterministic, good enough for choice indices
    let prngState = seedToInt(seed);
    function prng() {
      let x = prngState;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      prngState = x >>> 0;
      return prngState;
    }
    function pick(arr) {
      // If we have no seed, return a stable default (the first element);
      // it's the same as the old behavior, just per-install when seeded.
      if (!seed) return arr[0];
      return arr[prng() % arr.length];
    }

    // Realistic value pools — common machine specs in 2025
    const HW_CONCURRENCY_VALUES  = [4, 6, 8, 12, 16];
    const DEVICE_MEMORY_VALUES   = [4, 8, 16];
    const GPU_VENDORS = [
      'Google Inc. (Intel)',
      'Google Inc. (AMD)',
      'Google Inc. (NVIDIA)',
      'Intel Inc.',
    ];
    const GPU_RENDERERS = [
      'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ];

    const fpValues = {
      hwConcurrency: pick(HW_CONCURRENCY_VALUES),
      deviceMemory: pick(DEVICE_MEMORY_VALUES),
      gpuVendor: pick(GPU_VENDORS),
      gpuRenderer: pick(GPU_RENDERERS),
    };

    // ── Selective-mode canvas state (v2.0.3 carryover) ───────────
    const META = Symbol('zenith.canvas.meta');

    function isLikelyFingerprintCanvas(canvas) {
      if (!canvas) return false;
      const small = canvas.width <= 300 && canvas.height <= 150;
      if (!small) return false;
      const offDom = !canvas.isConnected;
      if (!offDom) return false;
      const meta = canvas[META];
      if (!meta) return false;
      return (performance.now() - (meta.lastText || 0)) < 100;
    }

    // ── Track fillText / strokeText so we know "text was just drawn"
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

    // ── Selective canvas noise (toDataURL) ───────────────────────
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

    // ── M-04 FIX: getImageData noise is committed back to the canvas
    //    so a follow-up toDataURL() produces a consistent result.
    try {
      const origGID = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
        const result = origGID.apply(this, arguments);
        if (isLikelyFingerprintCanvas(this.canvas)) {
          try {
            for (let i = 0; i < Math.min(result.data.length, 256); i += 4) {
              result.data[i] = (result.data[i] + (Math.random() > 0.5 ? 1 : -1)) & 0xFF;
            }
            // M-04 — write the noise back so toDataURL agrees with getImageData
            this.putImageData(result, x, y);
          } catch (e) {}
        }
        return result;
      };
    } catch (e) {}

    // ── WebGL: always spoof unmasked vendor/renderer (per-install) ──
    function patchWebGL(proto) {
      try {
        const orig = proto.getParameter;
        proto.getParameter = function(p) {
          if (p === 0x9245) return fpValues.gpuVendor;   // UNMASKED_VENDOR_WEBGL
          if (p === 0x9246) return fpValues.gpuRenderer; // UNMASKED_RENDERER_WEBGL
          return orig.apply(this, arguments);
        };
      } catch (e) {}
    }
    try { patchWebGL(WebGLRenderingContext.prototype); } catch (e) {}
    try { if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype); } catch (e) {}

    // ── Navigator normalization (per-install values, not hardcoded) ──
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => fpValues.hwConcurrency,
        configurable: true,
      });
    } catch (e) {}
    try {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => fpValues.deviceMemory,
        configurable: true,
      });
    } catch (e) {}

    // ── GPC & DNT signals (these are fine to be uniform; the whole
    //    point of GPC is that everyone signals the same opt-out)
    try { Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true, configurable: true }); } catch (e) {}

    // ── L-03 FIX: Battery API on prototype, not delete from instance.
    //    `delete navigator.getBattery` silently fails because getBattery
    //    lives on Navigator.prototype and is non-configurable. Override
    //    it instead with a Promise.reject stub.
    try {
      Object.defineProperty(Navigator.prototype, 'getBattery', {
        value: function() {
          return Promise.reject(new Error('Battery API disabled by Zenith'));
        },
        configurable: true,
        writable: true,
      });
    } catch (e) {}

  } catch (e) {}
})();
