'use strict';
const app = require('./app');
const { PORT, isProduction, RENDER_EXTERNAL_URL } = require('./config/env');

app.listen(PORT, () => {
  console.log(`🚀 PMS running on port ${PORT} [${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
});

// Keep Render free tier warm (ping every 14 minutes)
if (isProduction) {
  const SELF_URL = RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setTimeout(() => {
    setInterval(async () => {
      try {
        const res = await fetch(`${SELF_URL}/health`);
        const data = await res.json();
        console.log(`[keep-alive] ok — uptime: ${data.uptime}`);
      } catch (e) {
        console.warn('[keep-alive] ping failed:', e.message);
      }
    }, 14 * 60 * 1000);
  }, 60 * 1000);
}
