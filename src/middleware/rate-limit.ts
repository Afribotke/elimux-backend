import rateLimit from 'express-rate-limit'

export const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Bare `req.headers['x-admin-key'] === process.env.ADMIN_KEY` would bypass
  // rate limiting for EVERY request (not just valid-key ones) if ADMIN_KEY
  // were ever unset, since `undefined === undefined` is true - the same
  // fail-open shape as the pre-guard CRON_SECRET check fixed in Cycle 004.
  // Matches adminAuth's own check (middleware/auth.ts): key must be a
  // non-empty configured value, header must actually be a string, then compare.
  skip: (req) => {
    const expected = process.env.ADMIN_KEY
    const provided = req.headers['x-admin-key']
    return Boolean(expected) && typeof provided === 'string' && provided === expected
  },
  handler: (req, res) => res.status(429).json({ error: 'Too many requests' }),
})
