'use strict';
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const { isProduction, SESSION_SECRET } = require('./env');

function createSessionMiddleware(pool) {
  return session({
    store: new pgSession({
      pool,
      createTableIfMissing: true,
      tableName: 'session'
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, secure: isProduction, sameSite: 'lax' }
  });
}

module.exports = createSessionMiddleware;
