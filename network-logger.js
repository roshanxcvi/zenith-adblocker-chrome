// Zenith Network Logger — by roshanxcvi
(function() {
  'use strict';

  const search = document.getElementById('search');
  const container = document.getElementById('log-container');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const clearBtn = document.getElementById('clear-btn');
  const statTotal = document.getElementById('stat-total');
  const statShowing = document.getElementById('stat-showing');
  const statDomains = document.getElementById('stat-domains');
  const statUpdate = document.getElementById('stat-update');

  let activeType = 'all';
  let searchQuery = '';
  let logData = [];

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      render();
    });
  });

  search.addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    render();
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all logged requests? This only clears the visible log, not blocked counts.')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_BLOCKED_LOG' });
      logData = [];
      render();
    } catch (e) {}
  });

  async function fetchLog() {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' });
      if (data && data.blockedLog) {
        logData = data.blockedLog;
        render();
        statUpdate.textContent = new Date().toLocaleTimeString();
      }
    } catch (e) {}
  }

  function render() {
    // Apply filters
    let filtered = logData;
    if (activeType !== 'all') {
      filtered = filtered.filter(e => e.type === activeType);
    }
    if (searchQuery) {
      filtered = filtered.filter(e => 
        (e.url || '').toLowerCase().includes(searchQuery) ||
        (e.domain || '').toLowerCase().includes(searchQuery)
      );
    }

    // Update stats
    statTotal.textContent = logData.length.toLocaleString();
    statShowing.textContent = filtered.length.toLocaleString();
    statDomains.textContent = new Set(filtered.map(e => e.domain)).size.toLocaleString();

    // Render rows
    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <h2>${logData.length === 0 ? 'Waiting for blocked requests...' : 'No requests match your filter'}</h2>
          <p>${logData.length === 0 ? 'Browse the web in another tab and blocked requests will appear here live.' : 'Try changing the search query or selecting a different type.'}</p>
        </div>`;
      return;
    }

    // Show up to 300 most recent rows (performance)
    const rows = filtered.slice(0, 300).map(e => {
      const age = Date.now() - e.timestamp;
      const timeStr = age < 60000 ? Math.floor(age/1000) + 's ago' :
                      age < 3600000 ? Math.floor(age/60000) + 'm ago' :
                      new Date(e.timestamp).toLocaleTimeString();
      
      const url = e.url || '';
      const domain = e.domain || '';
      const escUrl = url.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      
      return `
        <div class="log-row">
          <span class="col-time">${timeStr}</span>
          <span class="col-type type-${e.type || 'other'}">${(e.type || 'other').slice(0, 5)}</span>
          <span class="col-url" title="${escUrl}"><span class="domain">${domain}</span>${escUrl.replace(domain, '')}</span>
          <span class="col-domain">${domain}</span>
          <span class="col-action act-block">BLOCK</span>
        </div>`;
    }).join('');

    container.innerHTML = rows;
  }

  // Initial fetch + poll every 1 second
  fetchLog();
  setInterval(fetchLog, 1000);
})();
