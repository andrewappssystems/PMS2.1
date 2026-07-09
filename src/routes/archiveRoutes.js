'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/archiveController');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/api/archive', requireAuth, requireAdmin, ctrl.search);

module.exports = router;
