export function parseFilterList(text) {
  const result = {
    network: [],
    allow: [],
    cosmetic: [],
    scriptlets: [],
    unsupported: []
  };

  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('!') || line.startsWith('[')) {
      continue;
    }

    if (line.startsWith('@@')) {
      result.allow.push(line.slice(2));
      continue;
    }

    if (line.includes('##+js(')) {
      result.scriptlets.push(line);
      continue;
    }

    if (line.includes('##')) {
      const parts = line.split('##');
      const domains = parts[0];
      const selector = parts.slice(1).join('##');

      if (!selector || !isSafeSelector(selector)) {
        result.unsupported.push(line);
        continue;
      }

      result.cosmetic.push({
        domains: domains
          ? domains.split(',').map(d => d.trim()).filter(Boolean)
          : [],
        selector: selector.trim()
      });

      continue;
    }

    if (line.startsWith('||') || line.includes('$') || line.includes('*')) {
      result.network.push(line);
      continue;
    }

    result.unsupported.push(line);
  }

  return result;
}

function isSafeSelector(selector) {
  const value = String(selector || '').toLowerCase();

  if (!value || value.length > 500) {
    return false;
  }

  const blocked = [
    '<script',
    '</style',
    'javascript:',
    'data:',
    '@import',
    '{',
    '}'
  ];

  return !blocked.some(token => value.includes(token));
}