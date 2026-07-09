'use strict';
const express = require('express');
const router  = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()) + 's'
  });
});

module.exports = router;
