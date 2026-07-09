const express = require('express');
const router = express.Router();
const landlordController = require('../controllers/landlordController');
const { requireAuth } = require('../middleware/auth');

router.get('/api/landlords', requireAuth, landlordController.list);
router.post('/api/landlords', requireAuth, landlordController.create);
router.put('/api/landlords/:id', requireAuth, landlordController.update);
router.delete('/api/landlords/:id', requireAuth, landlordController.remove);
router.get('/api/landlords/:id/portfolio', requireAuth, landlordController.getPortfolio);

module.exports = router;
