const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { createLoadConfigModels, fetchModels } = require('@librechat/api');
const { getAppConfig } = require('./app');
const db = require('~/models');
const {
  GATEWAY_ENDPOINT_NAME,
  SITE_PROVIDER,
  apiBase,
  getGatewayAllowedAddresses,
  normalizeSiteHost,
} = require('~/server/services/GatewayConfigService');

function extractItems(data) {
  const candidates = [
    data?.data?.items,
    data?.data?.models,
    data?.data?.list,
    data?.data?.rows,
    data?.data?.data,
    data?.data,
    data?.items,
    data?.models,
    data?.list,
    data?.rows,
    data,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
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

function gatewaySiteHostHeaders(siteHost) {
  const host = normalizeSiteHost(siteHost);
  if (!host) {
    return {};
  }
  return {
    'X-Original-Host': host,
    'X-Forwarded-Host': host,
  };
}

function getEffectivePort(protocol, port) {
  if (port) {
    return port;
  }
  return protocol === 'https:' ? '443' : '80';
}

function toAllowedAddress(baseURL) {
  if (!baseURL) {
    return '';
  }
  try {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    const host = url.hostname.includes(':')
      ? `[${url.hostname.replace(/^\[|\]$/g, '')}]`
      : url.hostname;
    return `${host}:${getEffectivePort(url.protocol, url.port)}`;
  } catch {
    return '';
  }
}

function isConfiguredGatewayBaseURL(baseURL) {
  const address = toAllowedAddress(baseURL);
  return address ? getGatewayAllowedAddresses().includes(address) : false;
}

async function fetchGatewaySiteModels(params) {
  if (
    params.name !== GATEWAY_ENDPOINT_NAME ||
    params.gatewayProvider !== SITE_PROVIDER ||
    !params.gatewaySiteHost
  ) {
    return [];
  }

  const baseURL = apiBase(params.gatewayBaseURL || params.baseURL);
  if (!baseURL || !isConfiguredGatewayBaseURL(baseURL)) {
    return [];
  }

  const res = await axios.get(`${baseURL}/api/dist/site/models`, {
    timeout: 30000,
    headers: gatewaySiteHostHeaders(params.gatewaySiteHost),
  });
  if (res.data?.success === false) {
    throw new Error(res.data?.message || 'Failed to fetch gateway site models');
  }
  return normalizeModels(extractItems(res.data));
}

async function fetchGatewayAwareModels(params) {
  try {
    const siteModels = await fetchGatewaySiteModels(params);
    if (siteModels.length > 0) {
      return siteModels;
    }
  } catch (err) {
    logger.warn('[loadConfigModels] Failed to fetch gateway site models:', err);
  }
  return fetchModels(params);
}

const loadConfigModels = createLoadConfigModels({
  getAppConfig,
  getUserKeyValues: db.getUserKeyValues,
  fetchModels: fetchGatewayAwareModels,
});

module.exports = loadConfigModels;
