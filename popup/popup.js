/* Browser API polyfill */

document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggle');
  const blockedCount = document.getElementById('blocked-count');
  const domainCountEl = document.getElementById('domain-count');
  const totalBlocked = document.getElementById('total-blocked');
  const currentDomain = document.getElementById('current-domain');
  const whitelistBtn = document.getElementById('whitelist-btn');
  const whitelistDisplay = document.getElementById('whitelist-display');
  const emptyMsg = document.getElementById('empty-msg');
  const domainList = document.getElementById('domain-list');
  const domainsTotal = document.getElementById('domains-total');

  // Category elements
  const segAds = document.getElementById('seg-ads');
  const segTrackers = document.getElementById('seg-trackers');
  const segSocial = document.getElementById('seg-social');
  const segOther = document.getElementById('seg-other');
  const catAds = document.getElementById('cat-ads');
  const catTrackers = document.getElementById('cat-trackers');
  const catSocial = document.getElementById('cat-social');
  const catOther = document.getElementById('cat-other');

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let domain = '—';
  try { domain = new URL(tab.url).hostname; } catch (e) {}
  currentDomain.textContent = domain;

  // Fetch popup overview data
  const data = await chrome.runtime.sendMessage({
    type: 'GET_POPUP_OVERVIEW',
    tabId: tab.id
  });

  // Populate stats
  toggle.checked = data.enabled;
  blockedCount.textContent = data.blockedCount || 0;
  domainCountEl.textContent = data.uniqueDomains || 0;
  totalBlocked.textContent = fmt(data.totalBlocked || 0);
  domainsTotal.textContent = data.uniqueDomains || 0;

  if (!data.enabled) document.body.classList.add('disabled');

  // Category bar
  const cats = data.categories || { ads: 0, trackers: 0, social: 0, other: 0 };
  const catTotal = cats.ads + cats.trackers + cats.social + cats.other || 1;
  segAds.style.width = (cats.ads / catTotal * 100) + '%';
  segTrackers.style.width = (cats.trackers / catTotal * 100) + '%';
  segSocial.style.width = (cats.social / catTotal * 100) + '%';
  segOther.style.width = (cats.other / catTotal * 100) + '%';
  catAds.textContent = cats.ads;
  catTrackers.textContent = cats.trackers;
  catSocial.textContent = cats.social;
  catOther.textContent = cats.other;

  // Domain list
  renderDomains(data.domains || []);

  // Whitelist
  const isWL = data.whitelist.some(d => domain.includes(d));
  if (isWL) { whitelistBtn.textContent = 'Remove'; whitelistBtn.classList.add('active'); }
  renderWhitelist(data.whitelist);

  // ——— HELPERS ———

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function getDomainCategory(d) {
    if (/google|doubleclick|googlesyndication|googleadservices|taboola|outbrain|adnxs|criteo|pubmatic|amazon-adsystem|ads\.|adform|adroll|ad\.|adsrvr|openx|mgid|revcontent|sharethrough/.test(d))
      return { cls: 'ad', label: 'AD' };
    if (/analytics|hotjar|mixpanel|clarity|segment|optimizely|chartbeat|scorecard|quantserve|demdex|bluekai|moatads|doubleverify|adsafeprotected|imrworldwide|krxd|omtrdc/.test(d))
      return { cls: 'tracker', label: 'TR' };
    if (/facebook|twitter|linkedin|instagram|snap\.licdn|pixel\.facebook|connect\.facebook|ads\.twitter|ads\.linkedin/.test(d))
      return { cls: 'social', label: 'SO' };
    return { cls: 'misc', label: '··' };
  }

  function renderDomains(domains) {
    if (!domains || domains.length === 0) {
      domainList.innerHTML = '<div class="domain-empty">Browse a page to see blocked domains</div>';
      return;
    }
    domainList.innerHTML = domains.map(d => {
      const cat = getDomainCategory(d.domain);
      return `<div class="domain-row">
        <span class="domain-icon ${cat.cls}">${cat.label}</span>
        <span class="domain-name" title="${d.domain}">${d.domain}</span>
        <span class="domain-count">${d.count}</span>
      </div>`;
    }).join('');
  }

  function renderWhitelist(list) {
    whitelistDisplay.innerHTML = '';
    emptyMsg.style.display = list.length ? 'none' : 'block';
    for (const d of list) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${d}</span><button data-domain="${d}">✕</button>`;
      whitelistDisplay.appendChild(li);
    }
    whitelistDisplay.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const resp = await chrome.runtime.sendMessage({ type: 'REMOVE_WHITELIST', domain: btn.dataset.domain });
        renderWhitelist(resp.whitelist);
      });
    });
  }

  // ——— EVENT LISTENERS ———

  // Toggle
  toggle.addEventListener('change', async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE' });
    toggle.checked = resp.enabled;
    document.body.classList.toggle('disabled', !resp.enabled);
  });

  // Whitelist
  whitelistBtn.addEventListener('click', async () => {
    if (whitelistBtn.classList.contains('active')) {
      const resp = await chrome.runtime.sendMessage({ type: 'REMOVE_WHITELIST', domain });
      whitelistBtn.textContent = 'Whitelist';
      whitelistBtn.classList.remove('active');
      renderWhitelist(resp.whitelist);
    } else {
      const resp = await chrome.runtime.sendMessage({ type: 'ADD_WHITELIST', domain });
      whitelistBtn.textContent = 'Remove';
      whitelistBtn.classList.add('active');
      renderWhitelist(resp.whitelist);
    }
  });

  // Collapsible whitelist section
  document.getElementById('wl-toggle').addEventListener('click', () => {
    const content = document.getElementById('wl-content');
    const arrow = document.querySelector('.arrow');
    if (content.style.display === 'none') {
      content.style.display = 'block';
      arrow.classList.add('open');
    } else {
      content.style.display = 'none';
      arrow.classList.remove('open');
    }
  });

  // Dashboard
  document.getElementById('open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });
});
