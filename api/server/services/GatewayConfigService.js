const GATEWAY_ENDPOINT_NAME = process.env.GATEWAY_ENDPOINT_NAME || 'AI Gateway';
const SESSION_PROVIDER = 'gateway';
const TOKEN_PROVIDER = 'gateway-v1';
const SITE_PROVIDER = 'gateway-site';
const DEFAULT_MODEL_FALLBACKS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'];

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function apiBase(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/, '');
}

function gatewayBase(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function getEffectivePort(protocol, port) {
  if (port) {
    return port;
  }
  return protocol === 'https:' ? '443' : '80';
}

function toAllowedAddress(baseUrl) {
  if (!baseUrl) {
    return null;
  }
  try {
    const url = new URL(gatewayBase(baseUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const host = url.hostname.includes(':')
      ? `[${url.hostname.replace(/^\[|\]$/g, '')}]`
      : url.hostname;
    return `${host}:${getEffectivePort(url.protocol, url.port)}`;
  } catch {
    return null;
  }
}

function normalizeSiteHost(value) {
  let host = String(value || '').trim();
  if (!host || /[\r\n]/.test(host)) {
    return '';
  }
  if (host.includes(',')) {
    host = host.split(',')[0].trim();
  }
  try {
    if (/^https?:\/\//i.test(host)) {
      host = new URL(host).host;
    } else {
      host = host.replace(/^\/\//, '');
      const pathIndex = host.search(/[/?#]/);
      if (pathIndex >= 0) {
        host = host.slice(0, pathIndex);
      }
    }
  } catch {
    return '';
  }

  host = host.toLowerCase().replace(/\.$/, '');
  if (
    !/^[a-z0-9.-]+(?::\d+)?$/i.test(host) &&
    !/^\[[0-9a-f:.]+\](?::\d+)?$/i.test(host)
  ) {
    return '';
  }
  return host;
}

function parseSiteHosts(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(/[,\n;]/)
        .map((item) => normalizeSiteHost(item))
        .filter(Boolean),
    ),
  ];
}

function parseProviderTarget(value) {
  const parts = String(value || '')
    .trim()
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
  const baseUrl = parts.shift() || '';
  let siteHost = '';
  for (const part of parts) {
    const matched = part.match(
      /^(?:host|siteHost|site_host|originalHost|original_host|x-original-host|forwardedHost|forwarded_host)\s*=\s*(.+)$/i,
    );
    if (matched) {
      siteHost = normalizeSiteHost(matched[1]);
    }
  }
  return { baseUrl, siteHost };
}

function parseProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === SESSION_PROVIDER || provider === 'newapi') {
    return SESSION_PROVIDER;
  }
  if (provider === TOKEN_PROVIDER || provider === 'gateway_v1' || provider === 'v1') {
    return TOKEN_PROVIDER;
  }
  if (
    provider === SITE_PROVIDER ||
    provider === 'gateway_site' ||
    provider === 'site' ||
    provider === 'branch'
  ) {
    return SITE_PROVIDER;
  }
  return undefined;
}

function normalizeProviders(rows) {
  const seen = new Set();
  const providers = [];
  for (const row of rows || []) {
    const provider = parseProvider(row?.provider);
    const target = parseProviderTarget(row?.baseUrl);
    const baseUrl = normalizeBaseUrl(target.baseUrl);
    const siteHost = normalizeSiteHost(
      row?.siteHost || row?.host || row?.originalHost || row?.xOriginalHost || target.siteHost,
    );
    if (!provider || !baseUrl) {
      continue;
    }
    const key = `${provider}:${baseUrl}:${provider === SITE_PROVIDER ? siteHost : ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const normalized = { provider, baseUrl };
    if (provider === SITE_PROVIDER && siteHost) {
      normalized.siteHost = siteHost;
    }
    providers.push(normalized);
  }
  return providers;
}

function parseProviderList(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  const raw = value.trim();
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return normalizeProviders(rows);
  } catch {
    // Compact syntax is supported below: gateway=https://a;gateway-v1=https://b
  }

  return normalizeProviders(
    raw.split(/[,\n;]/).flatMap((entry) => {
      const text = entry.trim();
      if (!text) {
        return [];
      }
      const matched = text.match(
        /^(gateway|gateway-v1|gateway_v1|newapi|v1|gateway-site|gateway_site|site|branch)\s*=\s*(.+)$/i,
      );
      if (matched) {
        const target = parseProviderTarget(matched[2].trim());
        return [
          {
            provider: matched[1].toLowerCase(),
            baseUrl: target.baseUrl,
            siteHost: target.siteHost,
          },
        ];
      }
      if (/^https?:\/\//i.test(text)) {
        return [
          { provider: SESSION_PROVIDER, baseUrl: text },
          { provider: TOKEN_PROVIDER, baseUrl: text },
        ];
      }
      return [];
    }),
  );
}

function readGatewayValue(name) {
  return process.env[name] ?? process.env[`LIBRECHAT_${name}`];
}

function getGatewayLoginProviders() {
  const providers = [
    ...parseProviderList(process.env.GATEWAY_LOGIN_PROVIDERS),
    ...parseProviderList(process.env.LIBRECHAT_GATEWAY_LOGIN_PROVIDERS),
  ];

  const sharedBaseUrl = process.env.GATEWAY_BASE_URL || process.env.LIBRECHAT_GATEWAY_BASE_URL;
  const siteBaseUrl =
    readGatewayValue('GATEWAY_SITE_BASE_URL') ||
    readGatewayValue('GATEWAY_BRANCH_BASE_URL') ||
    (sharedBaseUrl && (readGatewayValue('GATEWAY_SITE_HOST') || readGatewayValue('GATEWAY_SITE_HOSTS'))
      ? sharedBaseUrl
      : undefined);
  const siteHosts = [
    ...parseSiteHosts(readGatewayValue('GATEWAY_SITE_HOST')),
    ...parseSiteHosts(readGatewayValue('GATEWAY_SITE_HOSTS')),
  ];

  if (siteBaseUrl) {
    if (siteHosts.length > 0) {
      for (const siteHost of siteHosts) {
        providers.push({ provider: SITE_PROVIDER, baseUrl: siteBaseUrl, siteHost });
      }
    } else {
      providers.push({ provider: SITE_PROVIDER, baseUrl: siteBaseUrl });
    }
  }

  if (sharedBaseUrl) {
    providers.push(
      { provider: SESSION_PROVIDER, baseUrl: sharedBaseUrl },
      { provider: TOKEN_PROVIDER, baseUrl: sharedBaseUrl },
    );
  }

  providers.push(
    {
      provider: SESSION_PROVIDER,
      baseUrl: process.env.GATEWAY_SESSION_BASE_URL,
    },
    {
      provider: TOKEN_PROVIDER,
      baseUrl: process.env.GATEWAY_TOKEN_BASE_URL,
    },
  );

  return normalizeProviders(providers);
}

function getPublicGatewayBaseUrl(accountBaseUrl) {
  const baseUrl =
    process.env.GATEWAY_PUBLIC_BASE_URL ||
    process.env.LIBRECHAT_GATEWAY_PUBLIC_BASE_URL ||
    accountBaseUrl;
  return baseUrl ? gatewayBase(baseUrl) : '';
}

function getGatewayAllowedAddresses() {
  const addresses = new Set();
  const add = (baseUrl) => {
    const address = toAllowedAddress(baseUrl);
    if (address) {
      addresses.add(address);
    }
  };

  for (const provider of getGatewayLoginProviders()) {
    add(provider.baseUrl);
  }
  add(process.env.GATEWAY_PUBLIC_BASE_URL);
  add(process.env.LIBRECHAT_GATEWAY_PUBLIC_BASE_URL);

  return [...addresses];
}

function readGatewayFlag(name) {
  return readGatewayValue(name);
}

function parseBooleanFlag(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function isGatewayLoginEnabled() {
  const enabled = parseBooleanFlag(readGatewayFlag('GATEWAY_LOGIN_ENABLED'));
  return enabled !== false && getGatewayLoginProviders().length > 0;
}

function isGatewayEndpointEnabled() {
  const enabled = parseBooleanFlag(readGatewayFlag('GATEWAY_ENDPOINT_ENABLED'));
  if (enabled !== undefined) {
    return enabled;
  }
  return getGatewayLoginProviders().length > 0;
}

module.exports = {
  GATEWAY_ENDPOINT_NAME,
  SESSION_PROVIDER,
  TOKEN_PROVIDER,
  SITE_PROVIDER,
  DEFAULT_MODEL_FALLBACKS,
  normalizeBaseUrl,
  normalizeSiteHost,
  apiBase,
  gatewayBase,
  getPublicGatewayBaseUrl,
  getGatewayAllowedAddresses,
  getGatewayLoginProviders,
  isGatewayLoginEnabled,
  isGatewayEndpointEnabled,
};
