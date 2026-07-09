'use strict';

function notFoundHandler(req, res) {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  res.redirect('/');
}

function globalErrorHandler(err, req, res, next) {
  console.error('[UNHANDLED]', err.message, err.stack);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  res.status(500).render('login', { error: 'An unexpected error occurred.' });
}

module.exports = { notFoundHandler, globalErrorHandler };
