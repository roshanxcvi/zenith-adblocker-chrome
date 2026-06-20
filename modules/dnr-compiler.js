const DEFAULT_RESOURCE_TYPES = [
  'script',
  'image',
  'xmlhttprequest',
  'sub_frame',
  'stylesheet',
  'media',
  'font',
  'ping',
  'other'
];

export function compileNetworkRulesToDnr(networkRules, startId = 100000) {
  const dnrRules = [];
  let id = startId;

  for (const rule of networkRules) {
    const domain = extractDomainRule(rule);

    if (!domain) {
      continue;
    }

    dnrRules.push({
      id: id++,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: DEFAULT_RESOURCE_TYPES
      }
    });
  }

  return dnrRules;
}

export function compileAllowRulesToDnr(allowRules, startId = 200000) {
  const dnrRules = [];
  let id = startId;

  for (const rule of allowRules) {
    const domain = extractDomainRule(rule);

    if (!domain) {
      continue;
    }

    dnrRules.push({
      id: id++,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: DEFAULT_RESOURCE_TYPES
      }
    });
  }

  return dnrRules;
}

function extractDomainRule(rule) {
  let value = String(rule || '').trim();

  if (!value.startsWith('||')) {
    return null;
  }

  value = value.slice(2);
  value = value.split('^')[0];
  value = value.split('$')[0];

  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(value)) {
    return null;
  }

  return value.toLowerCase();
}