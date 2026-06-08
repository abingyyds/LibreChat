jest.mock('axios', () => {
  const create = jest.fn();
  return {
    create,
    get: jest.fn(),
    isAxiosError: jest.fn(() => false),
  };
});

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    getTenantId: jest.fn(() => undefined),
  }),
  { virtual: true },
);

jest.mock('@librechat/api', () => ({ getBalanceConfig: jest.fn(() => undefined) }), {
  virtual: true,
});

jest.mock(
  'librechat-data-provider',
  () => ({ SystemRoles: { USER: 'USER', ADMIN: 'ADMIN' } }),
  { virtual: true },
);

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  updateUserKey: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn(async () => ({})) }));

const axios = require('axios');
const { findUser, createUser, updateUser, updateUserKey } = require('~/models');

describe('GatewayAuthService', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...env,
      GATEWAY_LOGIN_ENABLED: 'true',
      GATEWAY_BASE_URL: 'http://gateway.internal:800',
    };
  });

  afterEach(() => {
    process.env = env;
  });

  function mockGatewaySessionLogin() {
    const client = {
      post: jest.fn(async (path) => {
        if (path === '/api/user/login') {
          return {
            headers: { 'set-cookie': ['session=abc; Path=/'] },
            data: { success: true, data: { id: 123, username: 'alice' } },
          };
        }
        if (path === '/api/token/') {
          return { data: { success: true } };
        }
        throw new Error(`unexpected POST ${path}`);
      }),
      get: jest.fn(async (path) => {
        if (path === '/api/token/') {
          return {
            data: {
              success: true,
              data: [{ id: 1, name: 'librechat-auto-existing', key: 'abc123' }],
            },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
    };
    axios.create.mockReturnValue(client);
    axios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-4o-mini' }] } });
    return client;
  }

  it('creates gateway users with the USER role even when they are the first local user', async () => {
    mockGatewaySessionLogin();
    findUser.mockResolvedValue(null);
    createUser.mockResolvedValue({
      _id: { toString: () => 'local-user-id' },
      provider: 'gateway',
      role: 'USER',
    });

    const { loginWithGateway } = require('./GatewayAuthService');
    await loginWithGateway('alice', 'password');

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gateway',
        role: 'USER',
      }),
      undefined,
      true,
      true,
    );
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('downgrades existing gateway admins back to USER on login', async () => {
    mockGatewaySessionLogin();
    findUser.mockResolvedValue({
      _id: { toString: () => 'local-user-id' },
      provider: 'gateway',
      role: 'ADMIN',
    });
    updateUser.mockResolvedValue({
      _id: { toString: () => 'local-user-id' },
      provider: 'gateway',
      role: 'USER',
    });

    const { loginWithGateway } = require('./GatewayAuthService');
    await loginWithGateway('alice', 'password');

    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith('local-user-id', { role: 'USER' });
    expect(updateUserKey).toHaveBeenCalledWith(expect.objectContaining({ userId: 'local-user-id' }));
  });
});
