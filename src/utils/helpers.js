'use strict';
const actor = req => req.session.user?.name || 'System';
const today = () => new Date().toISOString().split('T')[0];

module.exports = { actor, today };
