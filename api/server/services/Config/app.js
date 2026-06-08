const { CacheKeys } = require('librechat-data-provider');
const { AppService, logger } = require('@librechat/data-schemas');
const { createAppConfigService, clearMcpConfigCache } = require('@librechat/api');
const { setCachedTools, invalidateCachedTools } = require('./getCachedTools');
const { loadAndFormatTools } = require('~/server/services/start/tools');
const loadCustomConfig = require('./loadCustomConfig');
const getLogStores = require('~/cache/getLogStores');
const paths = require('~/config/paths');
const db = require('~/models');
const {
  GATEWAY_ENDPOINT_NAME,
  DEFAULT_MODEL_FALLBACKS,
  getGatewayAllowedAddresses,
  isGatewayEndpointEnabled,
} = require('~/server/services/GatewayConfigService');

function injectGatewayEndpoint(config) {
  if (!isGatewayEndpointEnabled()) {
    return config;
  }

  const gatewayEndpoint = {
    name: GATEWAY_ENDPOINT_NAME,
    apiKey: 'user_provided',
    baseURL: 'user_provided',
    models: {
      fetch: true,
      default: (process.env.GATEWAY_DEFAULT_MODELS || DEFAULT_MODEL_FALLBACKS.join(','))
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    },
    titleConvo: true,
    titleModel: process.env.GATEWAY_TITLE_MODEL || 'gpt-4o-mini',
    modelDisplayLabel: process.env.GATEWAY_MODEL_DISPLAY_LABEL || 'Gateway',
  };

  const endpoints = { ...(config.endpoints || {}) };
  const custom = Array.isArray(endpoints.custom) ? [...endpoints.custom] : [];
  const existing = custom.findIndex((endpoint) => endpoint?.name === GATEWAY_ENDPOINT_NAME);

  if (existing >= 0) {
    custom[existing] = {
      ...gatewayEndpoint,
      ...custom[existing],
      apiKey: custom[existing].apiKey || gatewayEndpoint.apiKey,
      baseURL: custom[existing].baseURL || gatewayEndpoint.baseURL,
      models: custom[existing].models || gatewayEndpoint.models,
    };
  } else {
    custom.unshift(gatewayEndpoint);
  }

  endpoints.custom = custom;
  const allowedAddresses = [
    ...(Array.isArray(endpoints.allowedAddresses) ? endpoints.allowedAddresses : []),
    ...getGatewayAllowedAddresses(),
  ];
  endpoints.allowedAddresses = [...new Set(allowedAddresses)];

  return {
    ...config,
    endpoints,
  };
}

const loadBaseConfig = async () => {
  /** @type {TCustomConfig} */
  const config = injectGatewayEndpoint((await loadCustomConfig()) ?? {});
  /** @type {Record<string, FunctionTool>} */
  const systemTools = loadAndFormatTools({
    adminFilter: config.filteredTools,
    adminIncluded: config.includedTools,
    directory: paths.structuredTools,
  });
  return AppService({ config, paths, systemTools });
};

const { getAppConfig, clearAppConfigCache, clearOverrideCache } = createAppConfigService({
  loadBaseConfig,
  setCachedTools,
  getCache: getLogStores,
  cacheKeys: CacheKeys,
  getApplicableConfigs: db.getApplicableConfigs,
  getUserPrincipals: db.getUserPrincipals,
});

/**
 * Invalidate all config-related caches after an admin config mutation.
 * Clears the base config, per-principal override caches, tool caches,
 * and the MCP config-source server cache.
 * @param {string} [tenantId] - Optional tenant ID to scope override cache clearing.
 */
async function invalidateConfigCaches(tenantId) {
  const results = await Promise.allSettled([
    clearAppConfigCache(),
    clearOverrideCache(tenantId),
    invalidateCachedTools({ invalidateGlobal: true }),
    clearMcpConfigCache(),
  ]);
  const labels = [
    'clearAppConfigCache',
    'clearOverrideCache',
    'invalidateCachedTools',
    'clearMcpConfigCache',
  ];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      logger.error(`[invalidateConfigCaches] ${labels[i]} failed:`, results[i].reason);
    }
  }
}

module.exports = {
  getAppConfig,
  clearAppConfigCache,
  invalidateConfigCaches,
};
