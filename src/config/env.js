'use strict';
const isProduction = process.env.NODE_ENV === 'production';
module.exports = {
  isProduction,
  PORT: process.env.PORT || 3000,
  SESSION_SECRET: process.env.SESSION_SECRET || (() => {
    if (isProduction) { console.error('SESSION_SECRET must be set'); process.exit(1); }
    console.warn('Using insecure dev session secret');
    return 'dev-secret-do-not-use-in-production';
  })(),
  DATABASE_URL: process.env.DATABASE_URL,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL
};
