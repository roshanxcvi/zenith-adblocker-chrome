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

  // H-B helpers (same as dashboard) — build DOM elements safely
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      if (props.cls) node.className = props.cls;
      if (props.text != null) node.textContent = String(props.text);
      if (props.title != null) node.title = String(props.title);
      if (props.data) for (const k in props.data) node.dataset[k] = String(props.data[k]);
      if (props.on) for (const k in props.on) node.addEventListener(k, props.on[k]);
    }
    if (children) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // M-A — proper dot-anchored suffix match. Whitelist entry 'ads.com'
  // matches 'ads.com' and 'sub.ads.com', but NOT 'ads.com.evil.com' or
  // 'notads.com'. Single-letter entries like 'co' no longer match every
  // .co domain.
  function whitelistMatches(host, wlEntry) {
    if (!host || !wlEntry) return false;
    const h = String(host).toLowerCase().replace(/^www\./, '');
    const w = String(wlEntry).toLowerCase().replace(/^www\./, '');
    return h === w || h.endsWith('.' + w);
  }

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

  // Safety check — if service worker was dead, data might be null
  if (!data || data.error) {
    blockedCount.textContent = '—';
    totalBlocked.textContent = '—';
    return;
  }

  // Populate stats
  toggle.checked = !!data.enabled;
  blockedCount.textContent = data.blockedCount || 0;
  domainCountEl.textContent = data.uniqueDomains || 0;
  totalBlocked.textContent = fmt(data.totalBlocked || 0);
  domainsTotal.textContent = data.uniqueDomains || 0;

  // Since install counter (like uBlock Origin)
  const siCount = document.getElementById('since-install-count');
  const siDate = document.getElementById('since-install-date');
  if (data.sinceInstall) {
    siCount.textContent = fmtFull(data.sinceInstall.totalBlocked || 0);
    if (data.sinceInstall.installDate) {
      const d = new Date(data.sinceInstall.installDate);
      const now = new Date();
      const days = Math.floor((now - d) / 86400000);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      siDate.textContent = `Since ${dateStr} — ${days} day${days !== 1 ? 's' : ''} ago`;
    }
  }

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

  // Whitelist (M-A — dot-anchored suffix match instead of includes())
  const isWL = (data.whitelist || []).some(d => whitelistMatches(domain, d));
  if (isWL) { whitelistBtn.textContent = 'Remove'; whitelistBtn.classList.add('active'); }
  renderWhitelist(data.whitelist || []);

  // ——— HELPERS ———

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function fmtFull(n) {
    return n.toLocaleString('en-US');
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
    clearChildren(domainList);
    if (!domains || domains.length === 0) {
      domainList.appendChild(el('div', { cls: 'domain-empty', text: 'Browse a page to see blocked domains' }));
      return;
    }
    for (const d of domains) {
      const dom = String(d.domain || '');
      const cat = getDomainCategory(dom);
      // Sanitize cat.cls — it's already from our hardcoded map so safe,
      // but be defensive in case CAT logic changes.
      const safeCls = cat.cls.replace(/[^a-z0-9_-]/gi, '');
      const row = el('div', { cls: 'domain-row' }, [
        el('span', { cls: 'domain-icon ' + safeCls, text: cat.label }),
        el('span', { cls: 'domain-name', text: dom, title: dom }),
        el('span', { cls: 'domain-count', text: String(d.count || 0) }),
      ]);
      domainList.appendChild(row);
    }
  }

  function renderWhitelist(list) {
    clearChildren(whitelistDisplay);
    emptyMsg.style.display = list.length ? 'none' : 'block';
    for (const d of list) {
      const dom = String(d);
      const removeBtn = el('button', {
        text: '✕',
        data: { domain: dom },
        on: {
          click: async () => {
            const resp = await chrome.runtime.sendMessage({ type: 'REMOVE_WHITELIST', domain: dom });
            if (resp && Array.isArray(resp.whitelist)) renderWhitelist(resp.whitelist);
          },
        },
      });
      const li = el('li', null, [
        el('span', { text: dom }),
        removeBtn,
      ]);
      whitelistDisplay.appendChild(li);
    }
  }

  // ——— EVENT LISTENERS ———

  // Toggle
  toggle.addEventListener('change', async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE' });
    if (!resp) return;
    toggle.checked = !!resp.enabled;
    document.body.classList.toggle('disabled', !resp.enabled);
  });

  // Whitelist
  whitelistBtn.addEventListener('click', async () => {
    if (whitelistBtn.classList.contains('active')) {
      const resp = await chrome.runtime.sendMessage({ type: 'REMOVE_WHITELIST', domain });
      whitelistBtn.textContent = 'Whitelist';
      whitelistBtn.classList.remove('active');
      if (resp && Array.isArray(resp.whitelist)) renderWhitelist(resp.whitelist);
    } else {
      const resp = await chrome.runtime.sendMessage({ type: 'ADD_WHITELIST', domain });
      whitelistBtn.textContent = 'Remove';
      whitelistBtn.classList.add('active');
      if (resp && Array.isArray(resp.whitelist)) renderWhitelist(resp.whitelist);
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
