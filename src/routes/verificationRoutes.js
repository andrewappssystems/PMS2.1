'use strict';
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/verificationController');

router.get('/verify/:code', ctrl.verifyDocument);

module.exports = router;
