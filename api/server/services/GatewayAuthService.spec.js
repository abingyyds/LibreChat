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
      GATEWAY_SITE_HOST: '',
      GATEWAY_SITE_HOSTS: '',
      GATEWAY_SITE_HOST_SUFFIX: '',
      GATEWAY_SITE_HOST_TEMPLATE: '',
      GATEWAY_SITE_HOST_MAP: '',
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
        if (path === '/api/user/self/distributor') {
          return {
            data: {
              success: true,
              data: {
                belongs_to_distributor: false,
                distributor_id: 0,
                distributor: null,
              },
            },
          };
        }
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

  it('uses the site key API when a session login belongs to a site', async () => {
    const client = {
      post: jest.fn(async (path, body) => {
        if (path === '/api/user/login') {
          return {
            headers: { 'set-cookie': ['session=site; Path=/'] },
            data: { success: true, data: { id: 456, username: 'branch-user' } },
          };
        }
        if (path === '/api/user/self/distributor/token/create') {
          return {
            data: { success: true, data: { id: 9, name: body.name, key: 'site-key-raw' } },
          };
        }
        throw new Error(`unexpected POST ${path}`);
      }),
      get: jest.fn(async (path) => {
        if (path === '/api/user/self/distributor') {
          return {
            data: {
              success: true,
              data: {
                belongs_to_distributor: true,
                distributor_id: 7,
                distributor: { id: 7, name: 'Alpha', slug: 'alpha', status: 1 },
              },
            },
          };
        }
        if (path === '/api/user/self/distributor/token/list') {
          return { data: { success: true, data: [] } };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
    };
    axios.create.mockReturnValue(client);
    axios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-4o-mini' }] } });
    findUser.mockResolvedValue(null);
    createUser.mockResolvedValue({
      _id: { toString: () => 'local-site-user-id' },
      provider: 'gateway',
      role: 'USER',
    });

    const { loginWithGateway } = require('./GatewayAuthService');
    await loginWithGateway('branch-user', 'password');

    expect(client.post).toHaveBeenCalledWith('/api/user/self/distributor/token/create', {
      name: expect.stringMatching(/^librechat-auto-/),
    });
    expect(axios.create.mock.calls.some(([config]) => config.headers?.['X-Original-Host'])).toBe(
      false,
    );
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local-site-user-id',
        value: expect.stringContaining('sk-site-key-raw'),
      }),
    );
  });

  it('supports direct site username/password login providers', async () => {
    process.env.GATEWAY_BASE_URL = '';
    process.env.GATEWAY_LOGIN_PROVIDERS = 'gateway-site=http://gateway.internal:800|host=alpha.example.com';
    const client = {
      post: jest.fn(async (path) => {
        if (path === '/api/dist/user/login') {
          return {
            headers: { 'set-cookie': ['session=direct-site; Path=/'] },
            data: { success: true, data: { id: 789, username: 'direct-site-user' } },
          };
        }
        throw new Error(`unexpected POST ${path}`);
      }),
      get: jest.fn(async (path) => {
        if (path === '/api/user/self/distributor/token/list') {
          return {
            data: {
              success: true,
              data: [{ id: 11, name: 'librechat-auto-existing', key: 'existing-site-key' }],
            },
          };
        }
        throw new Error(`unexpected GET ${path}`);
      }),
    };
    axios.create.mockReturnValue(client);
    axios.get.mockResolvedValue({ data: { data: [{ id: 'gpt-4o-mini' }] } });
    findUser.mockResolvedValue(null);
    createUser.mockResolvedValue({
      _id: { toString: () => 'direct-site-local-user-id' },
      provider: 'gateway',
      role: 'USER',
    });

    const { loginWithGateway } = require('./GatewayAuthService');
    await loginWithGateway('direct-site-user', 'password');

    expect(client.post).toHaveBeenCalledWith('/api/dist/user/login', {
      username: 'direct-site-user',
      password: 'password',
    });
    expect(client.post).not.toHaveBeenCalledWith('/api/user/login', expect.anything());
    expect(client.get).not.toHaveBeenCalledWith('/api/dist/token/list');
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'direct-site-local-user-id',
        value: expect.stringContaining('sk-existing-site-key'),
      }),
    );
  });
});
