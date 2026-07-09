'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/propertyController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/properties',     requireAuth, ctrl.list);
router.post('/api/properties',    requireAuth, ctrl.create);
router.put('/api/properties/:id', requireAuth, ctrl.update);

module.exports = router;
