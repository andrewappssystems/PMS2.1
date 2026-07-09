'use strict';
const crypto = require('crypto');

function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomUUID().substring(0, 8);
  const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expected] = storedHash.split(':');
  if (!salt || !expected) return false;
  try {
    const actual = crypto.createHash('sha256').update(password + salt).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch { return false; }
}

module.exports = { hashPassword, verifyPassword };
