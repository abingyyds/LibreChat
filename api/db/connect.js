require('dotenv').config();
const { isEnabled, instrumentMongooseQueryMetrics } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const mongoose = require('mongoose');
const mongoEnv = (() => {
  if (process.env.MONGO_URI) {
    return { name: 'MONGO_URI', value: process.env.MONGO_URI };
  }
  if (process.env.MONGODB_URI) {
    return { name: 'MONGODB_URI', value: process.env.MONGODB_URI };
  }
  if (process.env.MONGO_URL) {
    return { name: 'MONGO_URL', value: process.env.MONGO_URL };
  }
  return { name: null, value: null };
})();

const normalizeMongoUri = (mongoUri) => {
  if (!mongoUri) {
    return mongoUri;
  }

  try {
    const url = new URL(mongoUri);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/LibreChat';
    }
    if ((url.username || url.password) && !url.searchParams.has('authSource')) {
      url.searchParams.set('authSource', process.env.MONGO_AUTH_SOURCE || 'admin');
    }
    return url.toString();
  } catch {
    return mongoUri;
  }
};

const redactMongoUri = (mongoUri) => {
  if (!mongoUri) {
    return '';
  }

  try {
    const url = new URL(mongoUri);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid MongoDB URI>';
  }
};

const MONGO_URI = normalizeMongoUri(mongoEnv.value);

instrumentMongooseQueryMetrics(mongoose);

if (!MONGO_URI) {
  throw new Error('Please define the MONGO_URI, MONGODB_URI, or MONGO_URL environment variable');
}
/** The maximum number of connections in the connection pool. */
const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL_SIZE) || undefined;
/** The minimum number of connections in the connection pool. */
const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE) || undefined;
/** The maximum number of connections that may be in the process of being established concurrently by the connection pool. */
const maxConnecting = parseInt(process.env.MONGO_MAX_CONNECTING) || undefined;
/** The maximum number of milliseconds that a connection can remain idle in the pool before being removed and closed. */
const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS) || undefined;
/** The maximum time in milliseconds that a thread can wait for a connection to become available. */
const waitQueueTimeoutMS = parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS) || undefined;
/** Set to false to disable automatic index creation for all models associated with this connection. */
const autoIndex =
  process.env.MONGO_AUTO_INDEX != undefined
    ? isEnabled(process.env.MONGO_AUTO_INDEX) || false
    : undefined;

/** Set to `false` to disable Mongoose automatically calling `createCollection()` on every model created on this connection. */
const autoCreate =
  process.env.MONGO_AUTO_CREATE != undefined
    ? isEnabled(process.env.MONGO_AUTO_CREATE) || false
    : undefined;
/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

mongoose.connection.on('error', (err) => {
  logger.error('[connectDb] MongoDB connection error:', err);
});

async function connectDb() {
  if (cached.conn && cached.conn?._readyState === 1) {
    return cached.conn;
  }

  const disconnected = cached.conn && cached.conn?._readyState !== 1;
  if (!cached.promise || disconnected) {
    const opts = {
      bufferCommands: false,
      ...(maxPoolSize ? { maxPoolSize } : {}),
      ...(minPoolSize ? { minPoolSize } : {}),
      ...(maxConnecting ? { maxConnecting } : {}),
      ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
      ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
      ...(autoIndex != undefined ? { autoIndex } : {}),
      ...(autoCreate != undefined ? { autoCreate } : {}),
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
      // bufferMaxEntries: 0,
      // useFindAndModify: true,
      // useCreateIndex: true
    };
    logger.info('Mongo Connection options');
    logger.info(JSON.stringify(opts, null, 2));
    logger.info(
      `[connectDb] MongoDB URI source: ${mongoEnv.name}; target: ${redactMongoUri(MONGO_URI)}`,
    );
    mongoose.set('strictQuery', true);
    cached.promise = mongoose
      .connect(MONGO_URI, opts)
      .then((mongoose) => {
        return mongoose;
      })
      .catch((err) => {
        logger.error(
          `[connectDb] MongoDB connection failed: ${JSON.stringify({
            message: err?.message,
            code: err?.code,
            codeName: err?.codeName,
            errorLabels: err?.errorLabels,
            target: redactMongoUri(MONGO_URI),
          })}`,
        );
        throw err;
      });
  }
  cached.conn = await cached.promise;

  return cached.conn;
}

module.exports = {
  connectDb,
};
