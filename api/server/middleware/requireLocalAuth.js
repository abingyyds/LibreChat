const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const { loginWithGateway } = require('~/server/services/GatewayAuthService');

const requireLocalAuth = (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      logger.error('[requireLocalAuth] Error at passport.authenticate:', err);
      return next(err);
    }
    if (!user) {
      const username = req.body?.email;
      const password = req.body?.password;
      if (typeof username === 'string' && typeof password === 'string') {
        try {
          const gatewayUser = await loginWithGateway(username, password);
          if (gatewayUser) {
            req.user = gatewayUser;
            return next();
          }
        } catch (gatewayErr) {
          logger.warn('[requireLocalAuth] Gateway login failed:', gatewayErr);
          return res.status(401).send({ message: gatewayErr.message || 'Invalid credentials' });
        }
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
