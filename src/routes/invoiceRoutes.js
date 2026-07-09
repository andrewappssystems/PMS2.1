'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/invoiceController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/invoices',           requireAuth, ctrl.list);
router.post('/api/invoices/v2',       requireAuth, ctrl.createV2);
router.post('/api/invoices/bulk',     requireAuth, ctrl.bulkCreate);
router.post('/api/invoices/custom',   requireAuth, ctrl.createCustom);
router.post('/api/invoices',          requireAuth, ctrl.create);
router.put('/api/invoices/:id/pay',   requireAuth, ctrl.markPaid);
router.get('/api/invoices/:id/pdf',   requireAuth, ctrl.getPdf);

module.exports = router;
