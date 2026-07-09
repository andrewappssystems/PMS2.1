'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/reportController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/reports/portfolio',                requireAuth, ctrl.getPortfolio);
router.get('/api/reports/portfolio/pdf',             requireAuth, ctrl.getPortfolioPdf);
router.get('/api/reports/landlord/:landlordId',      requireAuth, ctrl.getLandlordReport);
router.get('/api/reports/landlord/:landlordId/pdf',  requireAuth, ctrl.getLandlordReportPdf);
router.get('/api/reports/tenant/:tenantId/pdf',      requireAuth, ctrl.getTenantStatement);

module.exports = router;
