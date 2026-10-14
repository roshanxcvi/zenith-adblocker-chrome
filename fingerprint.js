(function () {
  'use strict';
  //
  // Zenith Fingerprint Protection — Selective Mode (v2.1.0)
  // ────────────────────────────────────────────────────────
  //
  // v2.1 audit fixes:
  //   F-01 Navigator values are spoofed on Navigator.prototype, where Chrome
  //        keeps them, not as own properties of `navigator`. Before,
  //        `delete navigator.hardwareConcurrency` brought back the real value
  //        and Object.getOwnPropertyNames(navigator) listed every patch.
  //        Properties Chrome hides on http:// pages (deviceMemory, Battery)
  //        are no longer invented there.
  //   F-02 Nothing names Zenith. getBattery() no longer rejects with
  //        "Battery API disabled by Zenith"; it now reports what a plugged-in
  //        desktop reports (full, charging). Canvas bookkeeping lives in
  //        WeakMaps instead of a Symbol on every canvas.
  //   F-03 Patched functions are Proxies around the originals, so name,
  //        length and toString() match, and calling one on the wrong object
  //        still throws "Illegal invocation" like Chrome.
  //   F-04 Only values real Chrome reports: deviceMemory 4 or 8 (valid on
  //        every Chrome version and platform); GPU vendor and renderer picked
  //        as a matching pair; Direct3D GPU strings only on Windows.
  //   F-05 Canvas noise is deterministic (same pixel → same nudge on this
  //        site), clamped (no 0↔255 wraparound), only on fully opaque pixels
  //        (no impossible values), applied to a copy (the page's own canvas is
  //        never changed), kept for a canvas's lifetime once it is flagged,
  //        and covers toBlob as well as toDataURL / getImageData.
  //
  // Kept: per-install seed (I-01), Battery handled on the prototype (L-03) and
  // Selective Mode (only small, off-DOM canvases that just had text drawn).
  //
  // Known limits (need manifest/content.js changes, not this file): this
  // script only patches the top frame's main thread, and only from the moment
  // it runs. Same-origin iframes, Web Workers and OffscreenCanvas still see
  // real values, and page scripts that run before injection see them too.
  //
  // The seed arrives in the script tag's data-v attribute (a neutral name, so
  // the tag doesn't announce Zenith). It's a per-site value: HMAC of the
  // install seed and the page origin, computed in the service worker.
  //
  try {

    // ── Stealth helpers (F-03) ───────────────────────────────────
    const nativeOf = new WeakMap();     // Proxy → the original function it wraps
    const nativeText = new WeakMap();   // new function → the native-looking text it prints

    function wrap(nativeFn, apply) {
      const proxy = new Proxy(nativeFn, { apply });
      nativeOf.set(proxy, nativeFn);
      return proxy;
    }

    // toString() on a patched function prints the original's own text.
    try {
      Function.prototype.toString = wrap(Function.prototype.toString, (target, thisArg, args) => {
        if (nativeText.has(thisArg)) return nativeText.get(thisArg);
        return Reflect.apply(target, nativeOf.get(thisArg) || thisArg, args);
      });
    } catch (e) {}

    // Replace a native getter. The native runs first, so calling it on the
    // wrong object still throws exactly like Chrome does.
    function spoofGetter(proto, prop, value) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.get !== 'function') return false;
      Object.defineProperty(proto, prop, {
        get: wrap(desc.get, (target, thisArg, args) => {
          Reflect.apply(target, thisArg, args);
          return value;
        }),
        set: desc.set,
        enumerable: desc.enumerable,
        configurable: desc.configurable,
      });
      return true;
    }

    // ── Seed → deterministic PRNG (I-01) ─────────────────────────
    let seed = '';
    try {
      const me = document.currentScript;
      seed = (me && me.dataset && me.dataset.v) || '';
    } catch (e) {}

    // FNV-1a. Math.imul keeps the multiply exact in 32 bits.
    function seedToInt(s) {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h || 0x12345678;
    }

    const baseSeed = seedToInt(seed);

    // xorshift32 — fast, deterministic, good enough for choice indices
    let prngState = baseSeed;
    function prng() {
      let x = prngState;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      prngState = x >>> 0;
      return prngState;
    }
    function pick(arr) {
      if (!seed) return arr[0];   // no seed → stable default
      return arr[prng() % arr.length];
    }

    // ── Value pools — only values real Chrome reports (F-04) ─────
    const HW_CONCURRENCY_VALUES = [4, 6, 8, 12, 16];
    // Older Chrome and Chrome on Android never report more than 8; newer
    // desktop Chrome can also report 16 or 32. 4 and 8 are valid everywhere.
    const DEVICE_MEMORY_VALUES = [4, 8];

    // [vendor, renderer] pairs, always picked together so they match.
    // These are Windows (Direct3D11) strings, so they are only used on
    // Windows. Best practice: replace them with strings copied verbatim from
    // real Chrome-on-Windows machines, since current Chrome usually includes
    // the GPU's device ID too, e.g. "... UHD Graphics (0x00009BC4) Direct3D11 ...".
    const WINDOWS_GPU_PROFILES = [
      ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (Intel)',  'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
      ['Google Inc. (AMD)',    'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
    ];

    let isWindows = false;
    try {
      const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
      isWindows = /^win/i.test(plat);
    } catch (e) {}

    const gpu = pick(WINDOWS_GPU_PROFILES);
    const fpValues = {
      hwConcurrency: pick(HW_CONCURRENCY_VALUES),
      deviceMemory:  pick(DEVICE_MEMORY_VALUES),
      gpuVendor:     gpu[0],
      gpuRenderer:   gpu[1],
    };

    // ── Canvas (Selective Mode + F-02, F-05) ─────────────────────
    try {
      const C2D = CanvasRenderingContext2D.prototype;
      const HCE = HTMLCanvasElement.prototype;

      // Keep the originals we call ourselves, so later page patches of these
      // functions can't see or change our internal calls.
      const nGetImageData  = C2D.getImageData;
      const nPutImageData  = C2D.putImageData;
      const nDrawImage     = C2D.drawImage;
      const nGetContext    = HCE.getContext;
      const nCreateElement = document.createElement;
      const now = performance.now.bind(performance);

      const lastTextAt = new WeakMap();   // canvas → when text was last drawn
      const flagged = new WeakSet();      // canvases already treated as fingerprinting

      function isLikelyFingerprintCanvas(canvas) {
        if (!canvas || typeof canvas !== 'object') return false;
        if (flagged.has(canvas)) return true;   // stay consistent for this canvas's lifetime
        if (!(canvas.width <= 300 && canvas.height <= 150)) return false;   // small
        if (canvas.isConnected) return false;                               // off-DOM
        const t = lastTextAt.get(canvas);                                   // text just drawn
        if (t === undefined || now() - t >= 100) return false;
        flagged.add(canvas);
        return true;
      }

      // Remember when text was drawn on a canvas.
      for (const name of ['fillText', 'strokeText']) {
        try {
          C2D[name] = wrap(C2D[name], (target, thisArg, args) => {
            const result = Reflect.apply(target, thisArg, args);
            try { lastTextAt.set(thisArg.canvas, now()); } catch (e) {}
            return result;
          });
        } catch (e) {}
      }

      // Deterministic ±1 for one pixel position, keyed by the per-site seed.
      function noiseFor(px, py) {
        let h = (baseSeed ^ Math.imul(px + 1, 0x9E3779B1) ^ Math.imul(py + 1, 0x85EBCA6B)) >>> 0;
        h ^= h >>> 16;
        h = Math.imul(h, 0x7FEB352D);
        h ^= h >>> 15;
        return (h & 1) ? 1 : -1;
      }

      // Nudge the red channel of fully opaque pixels by ±1. (x0, y0) is where
      // this ImageData starts on the canvas, so a canvas pixel always gets
      // the same nudge however it is read. Pixels that aren't fully opaque
      // are left alone: Chrome can't return arbitrary colours for them, so
      // changing them would create values real Chrome never produces.
      function applyNoise(imageData, x0, y0) {
        const data = imageData.data;
        const width = imageData.width;
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          if (data[i + 3] !== 255) continue;
          const v = data[i] + noiseFor(x0 + (p % width), y0 + ((p / width) | 0));
          data[i] = v < 0 ? 0 : (v > 255 ? 255 : v);   // clamp — never wrap 0↔255
        }
      }

      // A noised copy of the canvas. The page's own canvas is never touched.
      function noisedCopy(canvas) {
        const copy = Reflect.apply(nCreateElement, document, ['canvas']);
        copy.width = canvas.width;
        copy.height = canvas.height;
        const cctx = Reflect.apply(nGetContext, copy, ['2d']);
        Reflect.apply(nDrawImage, cctx, [canvas, 0, 0]);
        const d = Reflect.apply(nGetImageData, cctx, [0, 0, copy.width, copy.height]);
        applyNoise(d, 0, 0);
        Reflect.apply(nPutImageData, cctx, [d, 0, 0]);
        return copy;
      }

      // getImageData: noise the returned pixels only. They match what
      // toDataURL/toBlob export, without writing into the page's canvas.
      C2D.getImageData = wrap(nGetImageData, (target, thisArg, args) => {
        const result = Reflect.apply(target, thisArg, args);
        try {
          const x = args[0], y = args[1], w = args[2], h = args[3];
          // Plain numbers only: converting other values ourselves would run
          // the page's valueOf() a second time, which a page can notice.
          if (typeof x === 'number' && typeof y === 'number' &&
              typeof w === 'number' && typeof h === 'number' &&
              isLikelyFingerprintCanvas(thisArg.canvas)) {
            const X = x | 0, Y = y | 0, W = w | 0, H = h | 0;   // same rounding as Chrome
            applyNoise(result, W < 0 ? X + W : X, H < 0 ? Y + H : Y);
          }
        } catch (e) {}
        return result;
      });

      // toDataURL / toBlob: export a noised copy instead of the original.
      for (const name of ['toDataURL', 'toBlob']) {
        try {
          if (typeof HCE[name] !== 'function') continue;
          HCE[name] = wrap(HCE[name], (target, thisArg, args) => {
            let source = thisArg;
            try {
              if (isLikelyFingerprintCanvas(thisArg) && thisArg.width > 0 && thisArg.height > 0) {
                source = noisedCopy(thisArg);
              }
            } catch (e) { source = thisArg; }
            return Reflect.apply(target, source, args);
          });
        } catch (e) {}
      }
    } catch (e) {}

    // ── WebGL vendor/renderer (Windows only, F-04) ───────────────
    function patchWebGL(proto) {
      try {
        proto.getParameter = wrap(proto.getParameter, (target, thisArg, args) => {
          const real = Reflect.apply(target, thisArg, args);
          if (real == null) return real;                        // unavailable → same as native
          if (args[0] === 0x9245) return fpValues.gpuVendor;    // UNMASKED_VENDOR_WEBGL
          if (args[0] === 0x9246) return fpValues.gpuRenderer;  // UNMASKED_RENDERER_WEBGL
          return real;
        });
      } catch (e) {}
    }
    if (isWindows) {
      try { patchWebGL(WebGLRenderingContext.prototype); } catch (e) {}
      try { if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype); } catch (e) {}
    }

    // ── Navigator — on the prototype, like the real getters (F-01) ──
    try { spoofGetter(Navigator.prototype, 'hardwareConcurrency', fpValues.hwConcurrency); } catch (e) {}
    try { spoofGetter(Navigator.prototype, 'deviceMemory', fpValues.deviceMemory); } catch (e) {}

    // GPC & DNT: uniform on purpose — the point of GPC is that everyone
    // sends the same opt-out. Pair them with `Sec-GPC: 1` / `DNT: 1` request
    // headers (declarativeNetRequest modifyHeaders) so JS and network agree.
    try { spoofGetter(Navigator.prototype, 'doNotTrack', '1'); } catch (e) {}
    try {
      if (!spoofGetter(Navigator.prototype, 'globalPrivacyControl', true) && self.isSecureContext) {
        const get = Object.getOwnPropertyDescriptor(
          { get globalPrivacyControl() { return true; } }, 'globalPrivacyControl').get;
        nativeText.set(get, 'function get globalPrivacyControl() { [native code] }');
        Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
          get, set: undefined, enumerable: true, configurable: true,
        });
      }
    } catch (e) {}

    // ── Battery (L-03, F-02) ─────────────────────────────────────
    // Report what a plugged-in desktop reports. Rejecting getBattery() was
    // itself a tell (real Chrome doesn't reject it on a normal page), and the
    // old error message named Zenith.
    try {
      if (typeof BatteryManager !== 'undefined') {
        const B = BatteryManager.prototype;
        spoofGetter(B, 'charging', true);
        spoofGetter(B, 'chargingTime', 0);
        spoofGetter(B, 'dischargingTime', Infinity);
        spoofGetter(B, 'level', 1);
      }
    } catch (e) {}

  } catch (e) {}
})();
