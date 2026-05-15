// Zenith neutered Google Analytics (analytics.js + gtag.js + ga.js stub)
window.ga = function(){if(typeof arguments[arguments.length-1]==='function')try{arguments[arguments.length-1]()}catch(e){}};
window.ga.create = function(){return{send:function(){}}};
window.ga.getByName = function(){return{send:function(){}}};
window.ga.getAll = function(){return[]};
window.ga.remove = function(){};
window.ga.loaded = true;
window.gtag = function(){if(typeof arguments[arguments.length-1]==='function')try{arguments[arguments.length-1]()}catch(e){}};
window.dataLayer = window.dataLayer || [];
window.dataLayer.push = function(){};
if (typeof window.GoogleAnalyticsObject === 'undefined') window.GoogleAnalyticsObject = 'ga';
