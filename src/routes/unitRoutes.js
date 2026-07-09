'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/unitController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/units',       requireAuth, ctrl.list);
router.post('/api/units/bulk', requireAuth, ctrl.bulkCreate);
router.post('/api/units',      requireAuth, ctrl.create);
router.put('/api/units/:id',   requireAuth, ctrl.update);

module.exports = router;
