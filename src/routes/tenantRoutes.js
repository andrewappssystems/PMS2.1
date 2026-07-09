'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/tenantController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/tenants',              requireAuth, ctrl.list);
router.post('/api/tenants',             requireAuth, ctrl.create);
router.put('/api/tenants/:id',          requireAuth, ctrl.update);
router.delete('/api/tenants/:id',       requireAuth, ctrl.remove);
router.get('/api/tenants/:id/balance',  requireAuth, ctrl.getBalance);

module.exports = router;
