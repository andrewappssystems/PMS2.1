'use strict';
const pool = require('../../database/pool');

async function logAudit(action, entityType, entityId, entityLabel, details, actor) {
  const payload = { action, details };
  await pool.query(
    `INSERT INTO archive (entity_type, entity_id, entity_label, data, deleted_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [entityType, entityId, entityLabel, JSON.stringify(payload), actor]
  );
}

// Keep archiveRecord for backwards compatibility for a moment, routing to logAudit
async function archiveRecord(entityType, entityId, entityLabel, data, deletedBy) {
  return logAudit('DELETE', entityType, entityId, entityLabel, data, deletedBy);
}

module.exports = { logAudit, archiveRecord };
