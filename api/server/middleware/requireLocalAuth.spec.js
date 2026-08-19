jest.mock('passport', () => ({ authenticate: jest.fn() }));

jest.mock(
  '@librechat/data-schemas',
  () => ({ logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }),
  { virtual: true },
);

jest.mock('~/server/services/GatewayAuthService', () => ({ loginWithGateway: jest.fn() }));
jest.mock('~/server/services/GatewayConfigService', () => ({
  isGatewayLoginEnabled: jest.fn(),
}));

const passport = require('passport');
const { loginWithGateway } = require('~/server/services/GatewayAuthService');
const { isGatewayLoginEnabled } = require('~/server/services/GatewayConfigService');
const requireLocalAuth = require('./requireLocalAuth');

describe('requireLocalAuth', () => {
  const originalAllowEmailLogin = process.env.ALLOW_EMAIL_LOGIN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOW_EMAIL_LOGIN = 'false';
    isGatewayLoginEnabled.mockReturnValue(true);
  });

  afterAll(() => {
    if (originalAllowEmailLogin === undefined) {
      delete process.env.ALLOW_EMAIL_LOGIN;
      return;
    }
    process.env.ALLOW_EMAIL_LOGIN = originalAllowEmailLogin;
  });

  it('authenticates with SubRouter before local Passport when email login is disabled', async () => {
    const gatewayUser = { id: 'gateway-user', provider: 'gateway' };
    loginWithGateway.mockResolvedValue(gatewayUser);
    const req = {
      body: {
        email: 'alice',
        password: 'password',
        turnstileToken: 'captcha-token',
        twoFactorCode: '123456',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const next = jest.fn();

    await requireLocalAuth(req, res, next);

    expect(passport.authenticate).not.toHaveBeenCalled();
    expect(loginWithGateway).toHaveBeenCalledWith('alice', 'password', {
      turnstileToken: 'captcha-token',
      twoFactorCode: '123456',
    });
    expect(req.user).toBe(gatewayUser);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable SubRouter error without falling back to Passport', async () => {
    const error = Object.assign(new Error('Two-factor code required'), {
      code: 'GATEWAY_TWO_FACTOR_REQUIRED',
    });
    loginWithGateway.mockRejectedValue(error);
    const req = { body: { email: 'alice', password: 'password' } };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const next = jest.fn();

    await requireLocalAuth(req, res, next);

    expect(passport.authenticate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({
      code: 'GATEWAY_TWO_FACTOR_REQUIRED',
      message: 'Two-factor code required',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
