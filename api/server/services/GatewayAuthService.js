const crypto = require('crypto');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { getBalanceConfig } = require('@librechat/api');
const { SystemRoles } = require('librechat-data-provider');
const { findUser, createUser, updateUser, updateUserKey } = require('~/models');
const {
  GATEWAY_ENDPOINT_NAME,
  SESSION_PROVIDER,
  TOKEN_PROVIDER,
  SITE_PROVIDER,
  DEFAULT_MODEL_FALLBACKS,
  apiBase,
  gatewayBase,
  normalizeBaseUrl,
  normalizeSiteHost,
  getPublicGatewayBaseUrl,
  getGatewayLoginProviders,
  isGatewayLoginEnabled,
} = require('~/server/services/GatewayConfigService');

const AUTO_KEY_PREFIX = process.env.GATEWAY_AUTO_KEY_PREFIX || 'librechat-auto';

function bearer(value) {
  return `Bearer ${String(value || '').replace(/^Bearer\s+/i, '')}`;
}

function buildCookie(headers) {
  const cookies = Array.isArray(headers) ? headers : headers ? [String(headers)] : [];
  return cookies
    .map((cookie) => String(cookie).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function getAxios(baseUrl, headers = {}, timeout = 30000) {
  return axios.create({
    baseURL: apiBase(baseUrl),
    timeout,
    headers,
    validateStatus: (status) => status >= 200 && status < 300,
  });
}

function extractItems(data) {
  const candidates = [data?.data?.items, data?.data?.data, data?.data, data?.items, data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function extractUser(data) {
  return data?.data?.user || data?.data || data?.user || {};
}

function extractKey(data) {
  const body = data?.data || data;
  return {
    key: body?.key || body?.api_key || body?.token,
    id: body?.id != null ? String(body.id) : undefined,
  };
}

function extractDistributor(data) {
  const body = data?.data || data || {};
  const distributor = body.distributor || body.site || {};
  const distributorId =
    body.distributor_id ?? body.distributorId ?? distributor.id ?? distributor.distributor_id;
  const belongs =
    body.belongs_to_distributor ??
    body.belongsToDistributor ??
    body.belongs ??
    Number(distributorId || 0) > 0;
  return {
    belongs: Boolean(belongs),
    id: distributorId != null ? String(distributorId) : undefined,
    name: distributor.name,
    slug: distributor.slug,
    status: distributor.status,
    siteHost: normalizeSiteHost(
      body.site_host ||
        body.siteHost ||
        body.api_host ||
        body.apiHost ||
        body.host ||
        distributor.site_host ||
        distributor.siteHost ||
        distributor.api_host ||
        distributor.apiHost ||
        distributor.host ||
        distributor.domain,
    ),
  };
}

function getErrorMessage(err) {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data;
    return String(data?.message || data?.error?.message || data?.reason || err.message);
  }
  return err instanceof Error ? err.message : String(err);
}

function buildSyntheticEmail({ provider, baseUrl, externalUserId, username, email, tenantId }) {
  const hash = crypto
    .createHash('sha256')
    .update(
      [provider, baseUrl, externalUserId || username || email || 'user', tenantId || 'default'].join(
        ':',
      ),
    )
    .digest('hex')
    .slice(0, 24);
  return `${hash}@gateway.local`;
}

function normalizeGatewayKey(value) {
  const key = String(value || '').trim();
  return key ? `sk-${key.replace(/^sk-/, '')}` : '';
}

function buildUsername(value) {
  return String(value || 'gateway-user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
}

function buildEndpointKeyValue(account) {
  return JSON.stringify({
    apiKey: account.apiKey,
    baseURL: getPublicGatewayBaseUrl(account.baseUrl),
  });
}

async function loginGatewaySession({ baseUrl, username, password, timeoutMs }) {
  const client = getAxios(baseUrl, {}, timeoutMs);
  const res = await client.post('/api/user/login', { username, password });
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Gateway login failed');
  }
  const cookie = buildCookie(res.headers['set-cookie']);
  if (!cookie) {
    throw new Error('Gateway login succeeded but no session was returned');
  }
  const user = extractUser(res.data);
  const account = {
    provider: SESSION_PROVIDER,
    baseUrl: normalizeBaseUrl(baseUrl),
    externalUserId: user.id != null ? String(user.id) : undefined,
    username: user.username || username,
    email: user.email,
    displayName: user.display_name || user.displayName || user.username || username,
    sessionCookie: cookie,
  };

  return attachGatewaySite(account, timeoutMs).catch((err) => {
    logger.debug(`[GatewayAuth] Failed to read gateway site ownership: ${getErrorMessage(err)}`);
    return account;
  });
}

async function loginGatewaySite({ baseUrl, siteHost, username, password, timeoutMs }) {
  const client = getAxios(baseUrl, gatewaySiteHostHeaders({ siteHost }), timeoutMs);
  const res = await client.post('/api/dist/user/login', { username, password });
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Gateway site login failed');
  }
  const cookie = buildCookie(res.headers['set-cookie']);
  if (!cookie) {
    throw new Error('Gateway site login succeeded but no session was returned');
  }
  const user = extractUser(res.data);
  return {
    provider: SITE_PROVIDER,
    baseUrl: normalizeBaseUrl(baseUrl),
    siteHost: normalizeSiteHost(siteHost),
    externalUserId: user.id != null ? String(user.id) : undefined,
    username: user.username || username,
    email: user.email,
    displayName: user.display_name || user.displayName || user.username || username,
    sessionCookie: cookie,
  };
}

async function loginGatewayToken({ baseUrl, username, password, timeoutMs }) {
  const client = getAxios(baseUrl, {}, timeoutMs);
  const res = await client.post('/api/v1/auth/login', { email: username, password });
  if (res.data?.code && res.data.code !== 0) {
    throw new Error(res.data?.message || 'Gateway login failed');
  }
  const data = res.data?.data || {};
  const user = data.user || {};
  const accessToken = data.access_token || data.accessToken;
  if (!accessToken) {
    throw new Error('Gateway login succeeded but no access token was returned');
  }
  return {
    provider: TOKEN_PROVIDER,
    baseUrl: normalizeBaseUrl(baseUrl),
    externalUserId: user.id != null ? String(user.id) : undefined,
    username: user.username || user.name || username,
    email: user.email || username,
    displayName: user.display_name || user.displayName || user.name || username,
    accessToken,
    refreshToken: data.refresh_token || data.refreshToken,
  };
}

function gatewayAIHeaders(account) {
  const headers = { ...gatewaySiteHostHeaders(account), Cookie: account.sessionCookie || '' };
  if (account.externalUserId) {
    headers['New-Api-User'] = String(account.externalUserId);
  }
  return headers;
}

function gatewayUserHeaders(account) {
  const headers = { Cookie: account.sessionCookie || '' };
  if (account.externalUserId) {
    headers['New-Api-User'] = String(account.externalUserId);
  }
  return headers;
}

function gatewaySiteHostHeaders(account) {
  const siteHost = normalizeSiteHost(account?.siteHost);
  if (!siteHost) {
    return {};
  }
  return {
    'X-Original-Host': siteHost,
    'X-Forwarded-Host': siteHost,
  };
}

function resolveMappedSiteHost(site) {
  const raw = process.env.GATEWAY_SITE_HOST_MAP || process.env.LIBRECHAT_GATEWAY_SITE_HOST_MAP || '';
  if (!raw.trim()) {
    return '';
  }
  const keys = new Set(
    [site?.id, site?.slug, site?.name]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  for (const entry of raw.split(/[,\n;]/)) {
    const matched = entry.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
    if (!matched || !keys.has(matched[1].trim().toLowerCase())) {
      continue;
    }
    const host = normalizeSiteHost(matched[2]);
    if (host) {
      return host;
    }
  }
  return '';
}

function resolveTemplateSiteHost(site) {
  const template =
    process.env.GATEWAY_SITE_HOST_TEMPLATE || process.env.LIBRECHAT_GATEWAY_SITE_HOST_TEMPLATE || '';
  if (!template.trim()) {
    return '';
  }
  const host = template
    .replace(/\{id\}/g, site?.id || '')
    .replace(/\{slug\}/g, site?.slug || '')
    .replace(/\{name\}/g, site?.name || '');
  return normalizeSiteHost(host);
}

function resolveSuffixSiteHost(site) {
  const suffix =
    process.env.GATEWAY_SITE_HOST_SUFFIX || process.env.LIBRECHAT_GATEWAY_SITE_HOST_SUFFIX || '';
  const slug = String(site?.slug || '').trim();
  if (!suffix.trim() || !slug) {
    return '';
  }
  return normalizeSiteHost(`${slug}.${suffix.replace(/^\.+/, '')}`);
}

function resolveGatewaySiteHost(site, provider = {}) {
  return (
    normalizeSiteHost(provider.siteHost) ||
    normalizeSiteHost(site?.siteHost) ||
    resolveMappedSiteHost(site) ||
    resolveTemplateSiteHost(site) ||
    resolveSuffixSiteHost(site)
  );
}

async function fetchGatewaySelfDistributor(account, timeoutMs) {
  const client = getAxios(account.baseUrl, gatewayAIHeaders(account), timeoutMs);
  const res = await client.get('/api/user/self/distributor');
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Failed to read gateway site ownership');
  }
  return extractDistributor(res.data);
}

async function attachGatewaySite(account, timeoutMs) {
  if (!account.sessionCookie || !account.externalUserId) {
    return account;
  }
  const site = await fetchGatewaySelfDistributor(account, timeoutMs);
  if (!site.belongs) {
    return account;
  }
  return {
    ...account,
    provider: SITE_PROVIDER,
    legacyProvider: account.provider,
    site,
    siteHost: resolveGatewaySiteHost(site, account),
  };
}

async function listGatewayAIKeys(account) {
  const client = getAxios(account.baseUrl, gatewayAIHeaders(account));
  const res = await client.get('/api/token/');
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Failed to list gateway keys');
  }
  return extractItems(res.data);
}

async function ensureGatewayAIKey(account) {
  const existing = (await listGatewayAIKeys(account)).find(
    (item) => String(item.name || '').startsWith(AUTO_KEY_PREFIX) && item.key,
  );
  if (existing?.key) {
    return {
      key: normalizeGatewayKey(existing.key),
      id: existing.id != null ? String(existing.id) : undefined,
    };
  }

  const name = `${AUTO_KEY_PREFIX}-${Date.now()}`;
  const client = getAxios(account.baseUrl, gatewayAIHeaders(account));
  const res = await client.post('/api/token/', {
    name,
    group: process.env.GATEWAY_TOKEN_GROUP || 'default',
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: true,
    model_limits_enabled: false,
  });
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Failed to create gateway key');
  }

  const created = (await listGatewayAIKeys(account)).find((item) => item.name === name && item.key);
  if (!created?.key) {
    throw new Error('Gateway key was created but could not be read back');
  }
  return {
    key: normalizeGatewayKey(created.key),
    id: created.id != null ? String(created.id) : undefined,
  };
}

async function listGatewaySiteKeys(account) {
  const client = getAxios(account.baseUrl, gatewayUserHeaders(account));
  const res = await client.get('/api/user/self/distributor/token/list');
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Failed to list gateway site keys');
  }
  return extractItems(res.data);
}

async function ensureGatewaySiteKey(account) {
  const existing = (await listGatewaySiteKeys(account)).find(
    (item) => String(item.name || '').startsWith(AUTO_KEY_PREFIX) && item.key,
  );
  if (existing?.key) {
    return {
      key: normalizeGatewayKey(existing.key),
      id: existing.id != null ? String(existing.id) : undefined,
    };
  }

  const name = `${AUTO_KEY_PREFIX}-${Date.now()}`;
  const body = { name };
  const keyGroupId = Number(process.env.GATEWAY_SITE_KEY_GROUP_ID || 0);
  if (Number.isInteger(keyGroupId) && keyGroupId > 0) {
    body.key_group_id = keyGroupId;
  }
  const client = getAxios(account.baseUrl, gatewayUserHeaders(account));
  const res = await client.post('/api/user/self/distributor/token/create', body);
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Failed to create gateway site key');
  }

  const created = extractKey(res.data);
  if (created.key) {
    return {
      key: normalizeGatewayKey(created.key),
      id: created.id,
    };
  }

  const listed = (await listGatewaySiteKeys(account)).find((item) => item.name === name && item.key);
  if (!listed?.key) {
    throw new Error('Gateway site key was created but could not be read back');
  }
  return {
    key: normalizeGatewayKey(listed.key),
    id: listed.id != null ? String(listed.id) : undefined,
  };
}

async function ensureGatewayTokenKey(account) {
  const client = getAxios(account.baseUrl, { Authorization: bearer(account.accessToken) });
  const listRes = await client.get('/api/v1/keys');
  const existing = extractItems(listRes.data).find(
    (item) => String(item.name || '').startsWith(AUTO_KEY_PREFIX) && item.key,
  );
  if (existing?.key) {
    return { key: existing.key, id: existing.id != null ? String(existing.id) : undefined };
  }

  const name = `${AUTO_KEY_PREFIX}-${Date.now()}`;
  const groupsRes = await client
    .get('/api/v1/groups/available')
    .catch(() => ({ data: { data: [] } }));
  const groups = extractItems(groupsRes.data);
  const gatewayGroup = groups.find((group) =>
    /gateway|router|default|智能|订阅/i.test(`${group.name || ''} ${group.description || ''}`),
  );
  const body = { name, quota: 0 };
  if (gatewayGroup?.id != null) {
    body.group_id = Number(gatewayGroup.id);
  }

  const createRes = await client.post('/api/v1/keys', body);
  const created = extractKey(createRes.data);
  if (!created.key) {
    throw new Error('Gateway key was created but no key was returned');
  }
  return created;
}

function normalizeModels(rows) {
  const models = new Set();
  for (const row of rows || []) {
    const id = String(
      row?.id || row?.model || row?.name || row?.model_name || row?.modelName || '',
    ).trim();
    if (id) {
      models.add(id);
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b));
}

async function fetchGatewayModels(account) {
  if (!account.apiKey) {
    return [];
  }
  const res = await axios.get(`${gatewayBase(account.baseUrl)}/models`, {
    timeout: 30000,
    headers: { Authorization: bearer(account.apiKey) },
  });
  return normalizeModels(extractItems(res.data));
}

function pickDefaultModels(models) {
  return models.length > 0 ? models : DEFAULT_MODEL_FALLBACKS;
}

async function authenticateWithProvider(provider, username, password) {
  const params = { ...provider, username, password, timeoutMs: 10000 };
  if (provider.provider === SITE_PROVIDER) {
    return loginGatewaySite(params);
  }
  if (provider.provider === SESSION_PROVIDER) {
    return loginGatewaySession(params);
  }
  return loginGatewayToken(params);
}

async function ensureGatewayKey(account) {
  if (account.provider === SITE_PROVIDER) {
    return ensureGatewaySiteKey(account);
  }
  if (account.provider === SESSION_PROVIDER) {
    return ensureGatewayAIKey(account);
  }
  return ensureGatewayTokenKey(account);
}

async function authenticateGatewayAccount(username, password) {
  let lastLoginError;
  let lastAccountError;
  const providers = getGatewayLoginProviders();
  for (const provider of providers) {
    let login;
    try {
      login = await authenticateWithProvider(provider, username, password);
    } catch (err) {
      lastLoginError = err;
      continue;
    }

    try {
      const key = await ensureGatewayKey(login);
      return {
        ...login,
        apiKey: key.key,
        apiKeyId: key.id,
      };
    } catch (err) {
      lastAccountError = err;
      logger.debug(`[GatewayAuth] External key setup failed: ${getErrorMessage(err)}`);
    }
  }

  if (lastAccountError) {
    throw lastAccountError;
  }
  if (lastLoginError) {
    logger.debug(`[GatewayAuth] External login failed: ${getErrorMessage(lastLoginError)}`);
  }
  return null;
}

async function authenticateGatewayUser(username, password) {
  return authenticateGatewayAccount(username, password);
}

async function ensureLocalUser(account, password) {
  const tenantId = getTenantId();
  const externalId = account.externalUserId || account.email || account.username;
  const issuer = ['gateway', account.provider, account.baseUrl, account.siteHost]
    .filter(Boolean)
    .join(':');
  const email = buildSyntheticEmail({
    provider: account.provider,
    baseUrl: account.baseUrl,
    externalUserId: externalId,
    username: account.username,
    email: account.email,
    tenantId,
  });
  const lookups = [{
    provider: 'gateway',
    openidIssuer: issuer,
    idOnTheSource: String(externalId || email),
  }];

  if (account.legacyProvider) {
    lookups.push({
      provider: 'gateway',
      openidIssuer: ['gateway', account.legacyProvider, account.baseUrl].filter(Boolean).join(':'),
      idOnTheSource: String(externalId || email),
    });
  }

  let user = null;
  for (const lookup of lookups) {
    user = await findUser(lookup);
    if (user) {
      break;
    }
  }
  if (!user) {
    user = await findUser({ email });
  }

  const username = buildUsername(account.username || account.displayName || email.split('@')[0]);
  const { getAppConfig } = require('~/server/services/Config');
  const appConfig = await getAppConfig({ tenantId });

  if (!user) {
    const salt = bcrypt.genSaltSync(10);
    user = await createUser(
      {
        provider: 'gateway',
        email,
        username,
        name: account.displayName || account.username || email,
        avatar: null,
        role: SystemRoles.USER,
        password: bcrypt.hashSync(password, salt),
        emailVerified: true,
        openidIssuer: issuer,
        idOnTheSource: String(externalId || email),
      },
      getBalanceConfig(appConfig),
      true,
      true,
    );
  } else if (user.provider === 'gateway' && user.role !== SystemRoles.USER) {
    user = await updateUser(user._id.toString(), { role: SystemRoles.USER });
  }

  return user;
}

async function syncGatewayEndpointKey(userId, account) {
  await updateUserKey({
    userId,
    name: GATEWAY_ENDPOINT_NAME,
    value: buildEndpointKeyValue(account),
    expiresAt: null,
  });
}

async function loginWithGateway(username, password) {
  if (!isGatewayLoginEnabled()) {
    return null;
  }

  const login = await authenticateGatewayUser(username, password);
  if (!login) {
    return null;
  }

  const localUser = await ensureLocalUser(login, password);
  const account = { ...login, userId: localUser._id?.toString?.() || localUser.id };

  const models = pickDefaultModels(
    await fetchGatewayModels(account).catch((err) => {
      logger.warn(`[GatewayAuth] Failed to fetch gateway models: ${getErrorMessage(err)}`);
      return [];
    }),
  );
  account.models = models;

  await syncGatewayEndpointKey(account.userId, account);
  localUser.gatewayAuth = {
    provider: account.provider,
    username: account.username,
    email: account.email,
    displayName: account.displayName,
    site: account.site
      ? { id: account.site.id, name: account.site.name, slug: account.site.slug }
      : undefined,
    modelCount: models.length,
  };

  return localUser;
}

module.exports = {
  GATEWAY_ENDPOINT_NAME,
  DEFAULT_MODEL_FALLBACKS,
  getPublicGatewayBaseUrl,
  getGatewayLoginProviders,
  isGatewayLoginEnabled,
  loginWithGateway,
};
