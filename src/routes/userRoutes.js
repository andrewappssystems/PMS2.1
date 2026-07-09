'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/userController');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/api/users',               requireAuth, requireAdmin, ctrl.list);
router.post('/api/users',              requireAuth, requireAdmin, ctrl.create);
router.put('/api/users/:id/password',  requireAuth, requireAdmin, ctrl.updatePassword);
router.put('/api/users/:id',           requireAuth, requireAdmin, ctrl.update);
router.delete('/api/users/:id',        requireAuth, requireAdmin, ctrl.remove);

module.exports = router;
