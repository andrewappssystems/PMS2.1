'use strict';
/**
 * api/index.js — Vercel Serverless Entry Point
 *
 * Vercel invokes this file as a serverless function.
 * It exports the Express app directly — no app.listen() call.
 * All routes, middleware, sessions, and DB connections work identically.
 */
const app = require('../src/app');

module.exports = app;
