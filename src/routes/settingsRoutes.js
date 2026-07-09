'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/settingsController');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/api/settings',       requireAuth, ctrl.list);
router.get('/api/settings/logo',  requireAuth, ctrl.getLogo);
router.put('/api/settings',       requireAuth, requireAdmin, ctrl.update);
router.post('/api/settings/logo', requireAuth, requireAdmin, ctrl.uploadLogo);

module.exports = router;
