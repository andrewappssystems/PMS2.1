'use strict';
const express    = require('express');
const helmet     = require('helmet');
const compression = require('compression');
const path       = require('path');
const { isProduction } = require('./config/env');
const createSessionMiddleware = require('./config/session');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, globalErrorHandler } = require('./middleware/errorHandler');
const mountRoutes = require('./routes');
const pool       = require('../database/pool');

const app = express();

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// App setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
if (isProduction) app.set('trust proxy', 1);

// Request logger
app.use(requestLogger);

// Session
app.use(createSessionMiddleware(pool));

// Routes
mountRoutes(app);

// Error handlers (must be last)
app.use(notFoundHandler);
app.use(globalErrorHandler);

module.exports = app;
