const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const { loginWithGateway } = require('~/server/services/GatewayAuthService');
const { isGatewayLoginEnabled } = require('~/server/services/GatewayConfigService');

function isEmailLoginDisabled() {
  return ['false', '0', 'no', 'off'].includes(
    String(process.env.ALLOW_EMAIL_LOGIN || '').trim().toLowerCase(),
  );
}

async function authenticateGateway(req, res, next) {
  const username = req.body?.email;
  const password = req.body?.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return false;
  }

  try {
    const gatewayUser = await loginWithGateway(username, password, {
      turnstileToken: req.body?.turnstileToken,
      twoFactorCode: req.body?.twoFactorCode,
    });
    if (!gatewayUser) {
      return false;
    }
    req.user = gatewayUser;
    next();
    return true;
  } catch (gatewayErr) {
    logger.warn('[requireLocalAuth] Gateway login failed:', gatewayErr);
    res.status(401).send({
      code: gatewayErr.code,
      message: gatewayErr.message || 'Invalid credentials',
    });
    return true;
  }
}

const requireLocalAuth = async (req, res, next) => {
  if (isGatewayLoginEnabled() && isEmailLoginDisabled()) {
    const handled = await authenticateGateway(req, res, next);
    if (handled) {
      return;
    }
    return res.status(401).send({ message: 'Invalid credentials' });
  }

  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      logger.error('[requireLocalAuth] Error at passport.authenticate:', err);
      return next(err);
    }
    if (!user) {
      if (await authenticateGateway(req, res, next)) {
        return;
      }
      logger.debug('[requireLocalAuth] Error: No user');
      return res.status(404).send(info);
    }
    if (info && info.message) {
      logger.debug('[requireLocalAuth] Error: ' + info.message);
      return res.status(422).send({ message: info.message });
    }
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireLocalAuth;
