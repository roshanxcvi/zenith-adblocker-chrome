/* Browser API polyfill */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const masterToggle = document.getElementById('master-toggle');
  const powerLabel = document.getElementById('power-label');
  const statusBar = document.getElementById('status-bar');
  const statTotal = document.getElementById('stat-total');
  const statRules = document.getElementById('stat-rules');
  const statSites = document.getElementById('stat-sites');
  const statWhitelistCount = document.getElementById('stat-whitelist-count');
  const catCount = document.getElementById('cat-count');
  const categoryList = document.getElementById('category-list');
  const domainCount = document.getElementById('domain-count');
  const domainList = document.getElementById('domain-list');
  const logList = document.getElementById('log-list');
  const whitelistInput = document.getElementById('whitelist-input');
  const whitelistAddBtn = document.getElementById('whitelist-add-btn');
  const whitelistList = document.getElementById('whitelist-list');
  const whitelistEmpty = document.getElementById('whitelist-empty');
  const refreshBtn = document.getElementById('refresh-btn');
  const resetBtn = document.getElementById('reset-btn');
  const sibCount = document.getElementById('sib-count');
  const sibDate = document.getElementById('sib-date');

  // Category config
  const CAT_CONFIG = {
    'Google Ads & Tracking': { icon: 'G', cls: 'google', color: '#ff5252' },
    'Facebook / Meta':       { icon: 'M', cls: 'meta',   color: '#40c4ff' },
    'Native Ads':            { icon: 'N', cls: 'native', color: '#ffab40' },
    'Programmatic / RTB':    { icon: 'P', cls: 'rtb',    color: '#b388ff' },
    'Platform Ads':          { icon: 'A', cls: 'platform', color: '#ffd740' },
    'Trackers & Analytics':  { icon: 'T', cls: 'tracker', color: '#00e676' },
    'Popup / Aggressive Ads':{ icon: '!', cls: 'popup',  color: '#ff5252' },
    'Ad Networks':           { icon: 'N', cls: 'adnet',  color: '#84ffff' },
    'Other':                 { icon: '?', cls: 'other',  color: '#6b7d93' },
  };

  // Format numbers
  function fmt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  // Time ago
  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 5000) return 'just now';
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // Truncate URL for display
  function truncUrl(url, max = 80) {
    try {
      const u = new URL(url);
      let display = u.hostname + u.pathname;
      if (u.search) display += u.search.slice(0, 20);
      return display.length > max ? display.slice(0, max) + '...' : display;
    } catch {
      return url.length > max ? url.slice(0, max) + '...' : url;
    }
  }

  // H-B helper — build DOM elements safely. Properties go via attribute
  // setters and textContent so no value ever passes through HTML parsing.
  // `props` keys: text (textContent), title, value, type, cls (className),
  // attrs (object of additional attributes via setAttribute), style (object),
  // data (dataset object), on (event listeners object).
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      if (props.cls) node.className = props.cls;
      if (props.text != null) node.textContent = String(props.text);
      if (props.title != null) node.title = String(props.title);
      if (props.value != null) node.value = String(props.value);
      if (props.type != null) node.type = String(props.type);
      if (props.attrs) for (const k in props.attrs) node.setAttribute(k, String(props.attrs[k]));
      if (props.style) for (const k in props.style) node.style.setProperty(k, props.style[k]);
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

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ——— RENDER FUNCTIONS ———

  function renderCategories(categories) {
    const entries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
    catCount.textContent = entries.length + ' types';

    clearChildren(categoryList);

    if (entries.length === 0) {
      categoryList.appendChild(el('div', { cls: 'empty-state', text: 'No data yet — browse some websites to see blocked ad categories' }));
      return;
    }

    const maxVal = entries[0][1];
    for (const [name, count] of entries) {
      const cfg = CAT_CONFIG[name] || CAT_CONFIG['Other'];
      const pct = Math.max(4, (count / maxVal) * 100);

      const bar = el('div', { cls: 'cat-bar', style: { width: pct + '%', background: cfg.color } });
      const barWrap = el('div', { cls: 'cat-bar-wrap' }, [bar]);
      const info = el('div', { cls: 'cat-info' }, [
        el('div', { cls: 'cat-name', text: name }),
        barWrap,
      ]);
      const row = el('div', { cls: 'cat-row' }, [
        el('div', { cls: 'cat-icon ' + cfg.cls, text: cfg.icon }),
        info,
        el('div', { cls: 'cat-count', text: fmt(count) }),
      ]);
      categoryList.appendChild(row);
    }
  }

  function renderDomains(topSites) {
    domainCount.textContent = topSites.length + ' domains';
    clearChildren(domainList);

    if (topSites.length === 0) {
      domainList.appendChild(el('div', { cls: 'empty-state', text: 'No blocked domains yet' }));
      return;
    }

    topSites.slice(0, 30).forEach(([domain, count], i) => {
      const row = el('div', { cls: 'domain-row' }, [
        el('span', { cls: 'domain-rank', text: i + 1 }),
        el('span', { cls: 'domain-name', text: String(domain), title: String(domain) }),
        el('span', { cls: 'domain-count', text: fmt(count) }),
      ]);
      domainList.appendChild(row);
    });
  }

  function renderLog(entries) {
    clearChildren(logList);

    if (!entries || entries.length === 0) {
      const empty = el('div', { cls: 'empty-state' });
      empty.appendChild(document.createTextNode('Waiting for blocked requests...'));
      empty.appendChild(document.createElement('br'));
      empty.appendChild(document.createTextNode('Browse a website to see live data'));
      logList.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const url = String(entry.url || '');
      const typeLabel = String(entry.type || 'unknown')
        .replace('xmlhttprequest', 'xhr')
        .replace('sub_frame', 'iframe')
        .replace('stylesheet', 'css')
        .replace(/[^a-z0-9_-]/gi, ''); // strip anything weird before using as className

      const row = el('div', { cls: 'log-entry' }, [
        el('span', { cls: 'log-type ' + typeLabel, text: typeLabel }),
        el('span', { cls: 'log-url', text: truncUrl(url), title: url }),
        el('span', { cls: 'log-time', text: timeAgo(entry.timestamp) }),
      ]);
      logList.appendChild(row);
    }
  }

  function renderWhitelist(list) {
    whitelistEmpty.style.display = list.length ? 'none' : 'block';
    clearChildren(whitelistList);

    for (const domain of list) {
      const d = String(domain);
      const removeBtn = el('button', {
        cls: 'whitelist-remove',
        text: '✕',
        title: 'Remove',
        data: { domain: d },
        on: {
          click: async () => {
            const resp = await chrome.runtime.sendMessage({ type: 'REMOVE_WHITELIST', domain: d });
            // Null-safety on response — service worker may have died, or
            // backend returned an error envelope.
            if (resp && Array.isArray(resp.whitelist)) {
              renderWhitelist(resp.whitelist);
              statWhitelistCount.textContent = resp.whitelist.length;
            }
          },
        },
      });
      const item = el('li', { cls: 'whitelist-item' }, [
        el('span', { text: d }),
        removeBtn,
      ]);
      whitelistList.appendChild(item);
    }
  }

  // ——— FETCH & RENDER ALL DATA ———
  async function loadDashboard() {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' });
      if (!data || data.error) return;

      // Toggle state
      masterToggle.checked = !!data.enabled;
      updateToggleUI(!!data.enabled);

      // Hero stats — defensive defaults for every field
      statTotal.textContent = fmt(data.totalBlocked || 0);
      statRules.textContent = fmt((data.networkRuleCount || 0) + (data.cosmeticRuleCount || 0));
      statSites.textContent = fmt((data.topSites || []).length);
      statWhitelistCount.textContent = (data.whitelist || []).length;

      // Since install banner
      if (data.sinceInstall && sibCount) {
        sibCount.textContent = (data.sinceInstall.totalBlocked || 0).toLocaleString('en-US');
        if (data.sinceInstall.installDate && sibDate) {
          const d = new Date(data.sinceInstall.installDate);
          const now = new Date();
          const days = Math.floor((now - d) / 86400000);
          const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          sibDate.textContent = 'Since ' + dateStr + ' — ' + days + ' day' + (days !== 1 ? 's' : '') + ' ago';
        }
      }

      // Sections — pass safe defaults so renderers never crash
      renderCategories(data.categories || {});
      renderDomains(data.topSites || []);
      renderLog(data.blockedLog || []);
      renderWhitelist(data.whitelist || []);
    } catch (err) {
      console.error('[Dashboard] Failed to load:', err);
    }
  }

  function updateToggleUI(enabled) {
    if (enabled) {
      powerLabel.textContent = 'Protection Active';
      powerLabel.classList.remove('off');
      statusBar.classList.remove('disabled');
      statusBar.querySelector('span').textContent = 'Blocking ads and trackers across all sites';
    } else {
      powerLabel.textContent = 'Protection Off';
      powerLabel.classList.add('off');
      statusBar.classList.add('disabled');
      statusBar.querySelector('span').textContent = 'Ad blocking is disabled — ads are not being blocked';
    }
  }

  // ——— EVENT LISTENERS ———

  // Master toggle
  masterToggle.addEventListener('change', async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE' });
    if (!resp) return;
    masterToggle.checked = !!resp.enabled;
    updateToggleUI(!!resp.enabled);
  });

  // Add to whitelist
  async function addWhitelist() {
    const domain = whitelistInput.value.trim().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
    if (!domain) return;

    const resp = await chrome.runtime.sendMessage({
      type: 'ADD_WHITELIST',
      domain
    });
    whitelistInput.value = '';
    if (resp && Array.isArray(resp.whitelist)) {
      renderWhitelist(resp.whitelist);
      statWhitelistCount.textContent = resp.whitelist.length;
    }
  }

  whitelistAddBtn.addEventListener('click', addWhitelist);
  whitelistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWhitelist();
  });

  // Refresh
  refreshBtn.addEventListener('click', loadDashboard);

  // Reset stats
  resetBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to reset all statistics? This cannot be undone.')) {
      await chrome.runtime.sendMessage({ type: 'RESET_STATS' });
      loadDashboard();
    }
  });

  // Auto-refresh every 5 seconds
  setInterval(loadDashboard, 5000);

  // Initial load
  loadDashboard();
});
