'use strict';
function validate(fields, body) {
  for (const [key, label] of fields)
    if (!body[key] || String(body[key]).trim() === '') return `${label} is required`;
  return null;
}

module.exports = { validate };
