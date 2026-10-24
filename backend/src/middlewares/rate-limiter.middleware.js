// src/middlewares/rate-limiter.middleware.js
// Lightweight in-memory Rate Limiting Middleware

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60000; // 1 minute window
  const maxRequests = options.max || 60;       // max requests per window
  const message = options.message || 'Too many requests, please try again later.';

  const ipHits = new Map();

  // Cleanup old IP entries every 2 minutes (unref timer so it doesn't block process exit)
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipHits.entries()) {
      if (now - data.startTime > windowMs) {
        ipHits.delete(ip);
      }
    }
  }, 120000);
  if (timer.unref) timer.unref();

  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let record = ipHits.get(ip);
    if (!record || (now - record.startTime > windowMs)) {
      record = { count: 1, startTime: now };
      ipHits.set(ip, record);
      return next();
    }

    record.count += 1;

    if (record.count > maxRequests) {
      return res.status(429).json({ message, status: 429 });
    }

    next();
  };
}

module.exports = {
  authLimiter: createRateLimiter({ windowMs: 60000, max: 20, message: 'Too many authentication attempts. Please wait 1 minute.' }),
  paymentLimiter: createRateLimiter({ windowMs: 60000, max: 15, message: 'Too many payment requests. Please wait 1 minute.' }),
  apiLimiter: createRateLimiter({ windowMs: 60000, max: 120, message: 'API rate limit exceeded.' }),
};

