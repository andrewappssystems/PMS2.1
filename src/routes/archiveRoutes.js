'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/archiveController');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/api/archive',         requireAuth, requireAdmin, ctrl.search);
router.get('/api/archive/summary', requireAuth, requireAdmin, ctrl.summary);

module.exports = router;
