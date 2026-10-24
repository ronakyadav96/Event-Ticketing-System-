// server.js ✅ FINAL STABLE VERSION (Express 5 compatible CORS)

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

const app = express();

/* ======================================================
   TRUST PROXY (Render / Vercel)
====================================================== */

app.set('trust proxy', 1);

/* ======================================================
   CORS — Must be the very first middleware.
   Using a manual implementation instead of the `cors`
   package because cors@2.x was built for Express 4 and
   can fail to set headers before Express 5's error
   pipeline sends a response (resulting in 403/429
   responses with no Access-Control-Allow-Origin header,
   which the browser then reports as a "CORS error").
====================================================== */

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // cache preflight for 24 h

  // Handle OPTIONS preflight — respond immediately with 204 No Content
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

/* ======================================================
   STRIPE WEBHOOK RAW BODY
   Must be registered BEFORE express.json(), otherwise signature verification fails.
====================================================== */

app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

/* ======================================================
   BODY PARSERS
====================================================== */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ======================================================
   STATIC FILES
====================================================== */

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.disable('etag');

/* ======================================================
   CACHE CONTROL
   - Event images: cacheable for 10 minutes (reduces re-downloads)
   - All other /api/ routes: no-cache (data must always be fresh)
   - Non-API routes (uploads, health): no restriction
====================================================== */

app.use('/api', (req, res, next) => {
  // Allow event images to be cached by the browser for 10 minutes.
  // Without this, the global no-store header forces a full re-download
  // of every image on every page visit.
  if (/^\/events\/[^/]+\/image(\?.*)?$/.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=600');
    return next();
  }

  // All other API responses (event lists, bookings, auth, etc.) must never be cached.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

const { authLimiter, paymentLimiter, apiLimiter } = require('./middlewares/rate-limiter.middleware');
const { rollExpiredMovieSchedules } = require('./services/movie-schedule.service');

/* ======================================================
   DATABASE AVAILABILITY

   The API must remain reachable while MongoDB is temporarily
   unavailable. Previously the process waited for MongoDB before
   calling listen() and exited on the first DNS/network failure.
====================================================== */

const MONGO_RETRY_INTERVAL_MS = Number(process.env.MONGO_RETRY_INTERVAL_MS || 5000);
const MONGO_CONNECT_TIMEOUT_MS = Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 5000);
let mongoRetryTimer = null;
let mongoConnecting = false;
let mongoState = 'disconnected';

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

function mongoStateName() {
  if (isMongoReady()) return 'connected';
  if (mongoose.connection.readyState === 2 || mongoConnecting) return 'connecting';
  return mongoState;
}

function requireMongo(req, res, next) {
  if (isMongoReady()) return next();

  return res.status(503).json({
    message: 'Database is temporarily unavailable. Please try again shortly.',
    code: 'DATABASE_UNAVAILABLE',
  });
}

function getStandardUriFromSrv(srvUri) {
  if (srvUri && srvUri.includes('cluster0.llrngnt.mongodb.net')) {
    return srvUri
      .replace('mongodb+srv://', 'mongodb://')
      .replace(
        'cluster0.llrngnt.mongodb.net',
        'ac-japtlrw-shard-00-00.llrngnt.mongodb.net:27017,ac-japtlrw-shard-00-01.llrngnt.mongodb.net:27017,ac-japtlrw-shard-00-02.llrngnt.mongodb.net:27017'
      ) + (srvUri.includes('?') ? '&' : '?') + 'ssl=true&replicaSet=atlas-cg5h8o-shard-0&authSource=admin';
  }
  return null;
}

async function connectMongo() {
  if (!process.env.MONGO_URI || isMongoReady() || mongoConnecting) return isMongoReady();

  mongoConnecting = true;
  mongoState = 'connecting';

  let uriToTry = process.env.MONGO_URI;
  try {
    await mongoose.connect(uriToTry, {
      serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
      connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
      socketTimeoutMS: 10000,
    });
    mongoState = 'connected';
    console.log('✅ MongoDB connected');
    return true;
  } catch (error) {
    if (uriToTry.startsWith('mongodb+srv://') && (error.message.includes('querySrv') || error.message.includes('EBADRESP') || error.message.includes('ECONNREFUSED'))) {
      const fallbackUri = getStandardUriFromSrv(uriToTry);
      if (fallbackUri) {
        console.warn('⚠️ SRV DNS lookup failed; falling back to direct replica set hosts...');
        try {
          await mongoose.connect(fallbackUri, {
            serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
            connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
            socketTimeoutMS: 10000,
          });
          mongoState = 'connected';
          console.log('✅ MongoDB connected via fallback hosts');
          return true;
        } catch (fallbackError) {
          console.error('❌ MongoDB fallback hosts also failed:', fallbackError.message);
        }
      }
    }
    mongoState = 'disconnected';
    console.error(`❌ MongoDB unavailable; retrying in ${MONGO_RETRY_INTERVAL_MS}ms:`, error.message);
    try {
      await mongoose.disconnect();
    } catch {
      // The connection may already be closed.
    }
    return false;
  } finally {
    mongoConnecting = false;
  }
}

function scheduleMongoRetry() {
  if (mongoRetryTimer || isMongoReady()) return;

  mongoRetryTimer = setTimeout(async () => {
    mongoRetryTimer = null;
    const connected = await connectMongo();
    if (!connected) scheduleMongoRetry();
  }, MONGO_RETRY_INTERVAL_MS);
  mongoRetryTimer.unref?.();
}

function startMongoConnection() {
  if (!process.env.MONGO_URI) {
    mongoState = 'not_configured';
    console.error('❌ MONGO_URI missing; database-backed API routes are disabled');
    return;
  }

  connectMongo().then((connected) => {
    if (!connected) scheduleMongoRetry();
  });
}

mongoose.connection.on('connected', () => {
  mongoState = 'connected';
  refreshMovieSchedules();
});

/* ======================================================
   MOVIE CATALOG UPKEEP
   Imported movies run in rolling 30-day windows; without this the whole
   catalog expires and nothing can be booked. Disable with MOVIE_AUTO_REFRESH=false.
====================================================== */

const MOVIE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
let movieRefreshTimer = null;

async function refreshMovieSchedules() {
  if (String(process.env.MOVIE_AUTO_REFRESH || 'true').toLowerCase() === 'false') return;
  try {
    // Refresh a few days early so a run never visibly ends between two refreshes.
    const rolled = await rollExpiredMovieSchedules({ minDaysLeft: 3 });
    if (rolled) console.log(`🎬 Rolled ${rolled} imported movie schedules forward`);
  } catch (error) {
    console.error('Movie schedule refresh failed:', error.message);
  }
  if (!movieRefreshTimer) {
    movieRefreshTimer = setInterval(refreshMovieSchedules, MOVIE_REFRESH_INTERVAL_MS);
    movieRefreshTimer.unref?.();
  }
}

mongoose.connection.on('disconnected', () => {
  mongoState = 'disconnected';
  if (serverStarted) scheduleMongoRetry();
});

let serverStarted = false;

/* ======================================================
   ROUTES WITH RATE LIMITING HARDENING
====================================================== */

app.use('/api/auth', requireMongo, authLimiter, require('./routes/auth.routes'));
app.use('/api/payments', requireMongo, paymentLimiter, require('./routes/payment.routes'));
app.use('/api/events', requireMongo, apiLimiter, require('./routes/event.routes'));
app.use('/api/bookings', requireMongo, apiLimiter, require('./routes/booking.routes'));
app.use('/api/admin', requireMongo, require('./routes/admin.routes'));
app.use('/api/dashboard', requireMongo, require('./routes/dashboard.routes'));
app.use('/api/hero-images', requireMongo, require('./routes/heroImage.routes'));
app.use('/api/movies', require('./routes/movie.routes'));
app.use('/api/chat-history', apiLimiter, require('./routes/chatHistory.routes'));

/* ======================================================
   HEALTH CHECK
====================================================== */

app.get('/', (req, res) => {
  res.send('✅ Backend running OK');
});

app.get('/health', (req, res) => {
  const connected = isMongoReady();
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'degraded',
    database: mongoStateName(),
    uptime: Math.round(process.uptime()),
  });
});

/* ======================================================
   GLOBAL ERROR HANDLER
====================================================== */

app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err);
  res.status(500).json({
    message: err.message || 'Internal Server Error',
  });
});

/* ======================================================
   START SERVER
====================================================== */

const PORT = process.env.PORT || 5001;

function start() {
  if (!process.env.JWT_SECRET) {
    console.error('❌ JWT_SECRET missing; authentication routes may fail');
  }

  const server = app.listen(PORT, () => {
    serverStarted = true;
    console.log(`🚀 Server running on port ${PORT}`);
    startMongoConnection();
  });

  server.on('error', (error) => {
    console.error('❌ HTTP server error:', error.message);
    process.exitCode = 1;
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received; shutting down`);
    if (mongoRetryTimer) clearTimeout(mongoRetryTimer);
    server.close(async () => {
      await mongoose.disconnect().catch(() => undefined);
      process.exit(0);
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start();
