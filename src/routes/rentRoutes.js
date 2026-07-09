'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/rentController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/rent',                    requireAuth, ctrl.list);
router.post('/api/rent/v2',                requireAuth, ctrl.createV2);
router.post('/api/rent/whatsapp-message',  requireAuth, ctrl.generateWhatsApp);
router.get('/api/rent/due-status',         requireAuth, ctrl.getDueStatus);
router.post('/api/rent',                   requireAuth, ctrl.create);
router.post('/api/rent-increase',          requireAuth, ctrl.createIncrease);
router.get('/api/rent-increase/history',   requireAuth, ctrl.getIncreaseHistory);

module.exports = router;
