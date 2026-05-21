const crypto = require('crypto');

const password = 'YourPasswordHere'; // ← change this to what you want
const salt = crypto.randomUUID().substring(0, 8);
const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
console.log(`${salt}:${hash}`);