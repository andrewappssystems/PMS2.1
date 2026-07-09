'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/expenseController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/expenses',       requireAuth, ctrl.list);
router.post('/api/expenses',      requireAuth, ctrl.create);
router.put('/api/expenses/:id',   requireAuth, ctrl.update);

module.exports = router;
