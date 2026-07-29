'use strict';
/**
 * src/server.js — Local development server entry point.
 *
 * This file is used when running locally: `npm start` or `npm run dev`.
 * On Vercel, this file is NOT used. Vercel uses api/index.js instead.
 */
const app = require('./app');
const { PORT, isProduction } = require('./config/env');

app.listen(PORT, () => {
  console.log(`🚀 PMS running on port ${PORT} [${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
});
