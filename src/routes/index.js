'use strict';
const authRoutes         = require('./authRoutes');
const dashboardRoutes    = require('./dashboardRoutes');
const landlordRoutes     = require('./landlordRoutes');
const propertyRoutes     = require('./propertyRoutes');
const unitRoutes         = require('./unitRoutes');
const tenantRoutes       = require('./tenantRoutes');
const rentRoutes         = require('./rentRoutes');
const expenseRoutes      = require('./expenseRoutes');
const invoiceRoutes      = require('./invoiceRoutes');
const receiptRoutes      = require('./receiptRoutes');
const userRoutes         = require('./userRoutes');
const settingsRoutes     = require('./settingsRoutes');
const archiveRoutes      = require('./archiveRoutes');
const reportRoutes       = require('./reportRoutes');
const verificationRoutes = require('./verificationRoutes');
const healthRoutes       = require('./healthRoutes');

function mountRoutes(app) {
  app.use('/', authRoutes);
  app.use('/', dashboardRoutes);
  app.use('/', landlordRoutes);
  app.use('/', propertyRoutes);
  app.use('/', unitRoutes);
  app.use('/', tenantRoutes);
  app.use('/', rentRoutes);
  app.use('/', expenseRoutes);
  app.use('/', invoiceRoutes);
  app.use('/', receiptRoutes);
  app.use('/', userRoutes);
  app.use('/', settingsRoutes);
  app.use('/', archiveRoutes);
  app.use('/', reportRoutes);
  app.use('/', verificationRoutes);
  app.use('/', healthRoutes);
}

module.exports = mountRoutes;
