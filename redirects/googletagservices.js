// Zenith neutered Google Publisher Tag (gpt.js)
window.googletag = window.googletag || {};
window.googletag.cmd = window.googletag.cmd || [];
window.googletag.cmd.push = function(fn) { try { fn(); } catch(e) {} return 0; };
window.googletag.defineSlot = function(){
  var slot = {
    addService: function(){return slot},
    setTargeting: function(){return slot},
    setCollapseEmptyDiv: function(){return slot},
    setForceSafeFrame: function(){return slot},
    setSafeFrameConfig: function(){return slot},
    defineSizeMapping: function(){return slot},
    getSlotElementId: function(){return ''},
  };
  return slot;
};
window.googletag.defineOutOfPageSlot = window.googletag.defineSlot;
window.googletag.pubads = function(){
  return {
    enableSingleRequest: function(){return true},
    disableInitialLoad: function(){},
    collapseEmptyDivs: function(){return true},
    refresh: function(){},
    addEventListener: function(){return this},
    setTargeting: function(){return this},
    setRequestNonPersonalizedAds: function(){return this},
    set: function(){return this},
    getSlots: function(){return []},
  };
};
window.googletag.enableServices = function(){};
window.googletag.display = function(){};
window.googletag.destroySlots = function(){return true};
window.googletag.apiReady = true;
window.googletag.pubadsReady = true;
