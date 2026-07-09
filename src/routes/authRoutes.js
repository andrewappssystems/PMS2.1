const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { loginLimiter } = require('../config/rateLimiter');
const { requireAuth } = require('../middleware/auth');

router.get('/login', authController.showLogin);
router.post('/login', loginLimiter, authController.doLogin);
router.get('/logout', authController.doLogout);
router.get('/', requireAuth, authController.showDashboard);

module.exports = router;
