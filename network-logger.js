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

    // H-01 FIX — clear and rebuild with DOM APIs (no innerHTML for any
    // network-origin value). This was previously interpolating URLs and
    // domains into a template string, with a fragile escape that broke
    // if the domain contained characters that were re-encoded during
    // HTML-escape (e.g. ampersands).
    while (container.firstChild) container.removeChild(container.firstChild);

    // Empty state
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const h2 = document.createElement('h2');
      h2.textContent = logData.length === 0
        ? 'Waiting for blocked requests...'
        : 'No requests match your filter';
      const p = document.createElement('p');
      p.textContent = logData.length === 0
        ? 'Browse the web in another tab and blocked requests will appear here live.'
        : 'Try changing the search query or selecting a different type.';
      empty.appendChild(h2);
      empty.appendChild(p);
      container.appendChild(empty);
      return;
    }

    // Build row DOM nodes (max 300 for performance). Every value is
    // injected via textContent — there is NO path from a network-origin
    // string into HTML parsing.
    const frag = document.createDocumentFragment();
    const slice = filtered.slice(0, 300);
    for (const e of slice) {
      const age = Date.now() - e.timestamp;
      const timeStr = age < 60000 ? Math.floor(age/1000) + 's ago' :
                      age < 3600000 ? Math.floor(age/60000) + 'm ago' :
                      new Date(e.timestamp).toLocaleTimeString();

      const url = String(e.url || '');
      const domain = String(e.domain || '');
      const type = String(e.type || 'other');

      const row = document.createElement('div');
      row.className = 'log-row';

      const timeCol = document.createElement('span');
      timeCol.className = 'col-time';
      timeCol.textContent = timeStr;
      row.appendChild(timeCol);

      const typeCol = document.createElement('span');
      typeCol.className = 'col-type type-' + type.replace(/[^a-z0-9_-]/gi, '');
      typeCol.textContent = type.slice(0, 5);
      row.appendChild(typeCol);

      const urlCol = document.createElement('span');
      urlCol.className = 'col-url';
      urlCol.title = url;
      // Split the URL visually into "domain | rest" using separate text nodes
      // — this gives us the "highlighted domain" effect without any HTML
      // interpolation.
      const domainSpan = document.createElement('span');
      domainSpan.className = 'domain';
      domainSpan.textContent = domain;
      urlCol.appendChild(domainSpan);
      // The remainder of the URL after the domain. We use indexOf instead
      // of replace() because String#replace on a non-regex needle replaces
      // only the first match and can leave stray characters from re-encoding.
      const idx = url.indexOf(domain);
      const remainder = idx === -1 ? url : url.slice(idx + domain.length);
      if (remainder) {
        urlCol.appendChild(document.createTextNode(remainder));
      }
      row.appendChild(urlCol);

      const domainCol = document.createElement('span');
      domainCol.className = 'col-domain';
      domainCol.textContent = domain;
      row.appendChild(domainCol);

      const actCol = document.createElement('span');
      actCol.className = 'col-action act-block';
      actCol.textContent = 'BLOCK';
      row.appendChild(actCol);

      frag.appendChild(row);
    }

    container.appendChild(frag);
  }

  // Initial fetch + poll every 1 second
  fetchLog();
  setInterval(fetchLog, 1000);
})();
