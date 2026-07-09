'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/receiptController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/receipts',          requireAuth, ctrl.list);
router.post('/api/receipts/v2',      requireAuth, ctrl.createV2);
router.post('/api/receipts',         requireAuth, ctrl.create);
router.get('/api/receipts/:id/pdf',  requireAuth, ctrl.getPdf);

module.exports = router;
