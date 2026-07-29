'use strict';
const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  isProduction,
  PORT:           process.env.PORT || 3000,
  DATABASE_URL:   process.env.DATABASE_URL,
  // Session secret — required in production. Will exit the process if missing.
  SESSION_SECRET: process.env.SESSION_SECRET || (() => {
    if (isProduction) {
      console.error('[ENV] FATAL: SESSION_SECRET must be set in production');
      process.exit(1);
    }
    console.warn('[ENV] WARNING: Using insecure dev session secret. Set SESSION_SECRET in .env');
    return 'dev-secret-do-not-use-in-production';
  })(),
  // VERCEL_URL is auto-injected by Vercel on every deployment.
  // Use this instead of RENDER_EXTERNAL_URL when deployed to Vercel.
  VERCEL_URL: process.env.VERCEL_URL
};
