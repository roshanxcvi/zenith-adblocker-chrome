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

  // ——— RENDER FUNCTIONS ———

  function renderCategories(categories) {
    const entries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
    catCount.textContent = entries.length + ' types';

    if (entries.length === 0) {
      categoryList.innerHTML = '<div class="empty-state">No data yet — browse some websites to see blocked ad categories</div>';
      return;
    }

    const maxVal = entries[0][1];
    categoryList.innerHTML = entries.map(([name, count]) => {
      const cfg = CAT_CONFIG[name] || CAT_CONFIG['Other'];
      const pct = Math.max(4, (count / maxVal) * 100);
      return `
        <div class="cat-row">
          <div class="cat-icon ${cfg.cls}">${cfg.icon}</div>
          <div class="cat-info">
            <div class="cat-name">${name}</div>
            <div class="cat-bar-wrap">
              <div class="cat-bar" style="width:${pct}%;background:${cfg.color}"></div>
            </div>
          </div>
          <div class="cat-count">${fmt(count)}</div>
        </div>
      `;
    }).join('');
  }

  function renderDomains(topSites) {
    domainCount.textContent = topSites.length + ' domains';

    if (topSites.length === 0) {
      domainList.innerHTML = '<div class="empty-state">No blocked domains yet</div>';
      return;
    }

    domainList.innerHTML = topSites.slice(0, 30).map(([domain, count], i) => `
      <div class="domain-row">
        <span class="domain-rank">${i + 1}</span>
        <span class="domain-name" title="${domain}">${domain}</span>
        <span class="domain-count">${fmt(count)}</span>
      </div>
    `).join('');
  }

  function renderLog(entries) {
    if (!entries || entries.length === 0) {
      logList.innerHTML = '<div class="empty-state">Waiting for blocked requests...<br>Browse a website to see live data</div>';
      return;
    }

    logList.innerHTML = entries.map(entry => {
      const typeLabel = (entry.type || 'unknown').replace('xmlhttprequest', 'xhr').replace('sub_frame', 'iframe').replace('stylesheet', 'css');
      return `
        <div class="log-entry">
          <span class="log-type ${typeLabel}">${typeLabel}</span>
          <span class="log-url" title="${entry.url}">${truncUrl(entry.url)}</span>
          <span class="log-time">${timeAgo(entry.timestamp)}</span>
        </div>
      `;
    }).join('');
  }

  function renderWhitelist(list) {
    whitelistEmpty.style.display = list.length ? 'none' : 'block';
    whitelistList.innerHTML = list.map(domain => `
      <li class="whitelist-item">
        <span>${domain}</span>
        <button class="whitelist-remove" data-domain="${domain}" title="Remove">✕</button>
      </li>
    `).join('');

    // Bind remove buttons
    whitelistList.querySelectorAll('.whitelist-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const resp = await chrome.runtime.sendMessage({
          type: 'REMOVE_WHITELIST',
          domain: btn.dataset.domain
        });
        renderWhitelist(resp.whitelist);
        statWhitelistCount.textContent = resp.whitelist.length;
      });
    });
  }

  // ——— FETCH & RENDER ALL DATA ———
  async function loadDashboard() {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' });

      // Toggle state
      masterToggle.checked = data.enabled;
      updateToggleUI(data.enabled);

      // Hero stats
      statTotal.textContent = fmt(data.totalBlocked);
      statRules.textContent = fmt(data.networkRuleCount + data.cosmeticRuleCount);
      statSites.textContent = fmt(data.topSites.length);
      statWhitelistCount.textContent = data.whitelist.length;

      // Sections
      renderCategories(data.categories);
      renderDomains(data.topSites);
      renderLog(data.blockedLog);
      renderWhitelist(data.whitelist);
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
    masterToggle.checked = resp.enabled;
    updateToggleUI(resp.enabled);
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
    renderWhitelist(resp.whitelist);
    statWhitelistCount.textContent = resp.whitelist.length;
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
