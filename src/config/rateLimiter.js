'use strict';
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (req.accepts('html')) return res.render('login', { error: 'Too many login attempts. Wait 15 minutes.' });
    res.status(429).json({ error: 'Too many requests' });
  }
});

module.exports = { loginLimiter };
