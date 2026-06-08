describe('GatewayConfigService', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it('adds configured gateway private hosts as precise allowedAddresses entries', () => {
    process.env.GATEWAY_BASE_URL = 'http://ai-gateway.railway.internal:800';
    process.env.GATEWAY_PUBLIC_BASE_URL = 'https://gateway.example.com/v1';

    const { getGatewayAllowedAddresses } = require('./GatewayConfigService');

    expect(getGatewayAllowedAddresses()).toEqual([
      'ai-gateway.railway.internal:800',
      'gateway.example.com:443',
    ]);
  });

  it('deduplicates providers and normalizes default ports', () => {
    process.env.GATEWAY_LOGIN_PROVIDERS = [
      'gateway=http://ai-gateway.railway.internal:800',
      'gateway-v1=http://ai-gateway.railway.internal:800/v1',
      'gateway=https://gateway.example.com/v1',
    ].join(';');

    const { getGatewayAllowedAddresses } = require('./GatewayConfigService');

    expect(getGatewayAllowedAddresses()).toEqual([
      'ai-gateway.railway.internal:800',
      'gateway.example.com:443',
    ]);
  });
});
