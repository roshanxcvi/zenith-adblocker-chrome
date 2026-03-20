(function(){
  'use strict';
  try {
    // Canvas fingerprint noise
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        try {
          const d = ctx.getImageData(0, 0, Math.min(this.width, 16), Math.min(this.height, 16));
          for (let i = 0; i < Math.min(d.data.length, 64); i += 4) {
            d.data[i] = (d.data[i] + (Math.random() > 0.5 ? 1 : -1)) & 0xFF;
          }
          ctx.putImageData(d, 0, 0);
        } catch (e) {}
      }
      return origToDataURL.apply(this, arguments);
    };

    // WebGL spoofing
    const origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 0x9245) return 'Generic GPU Vendor';
      if (p === 0x9246) return 'Generic GPU Renderer';
      return origGetParam.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(p) {
        if (p === 0x9245) return 'Generic GPU Vendor';
        if (p === 0x9246) return 'Generic GPU Renderer';
        return origGetParam2.apply(this, arguments);
      };
    }

    // Navigator normalization
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

    // GPC & DNT signals
    Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true });
    Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true, configurable: true });

    // Block Battery API
    if (navigator.getBattery) { navigator.getBattery = undefined; delete navigator.getBattery; }
  } catch (e) {}
})();
