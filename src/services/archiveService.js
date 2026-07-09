'use strict';
const pool = require('../../database/pool');

async function archiveRecord(entityType, entityId, entityLabel, data, deletedBy) {
  await pool.query(
    `INSERT INTO archive (entity_type, entity_id, entity_label, data, deleted_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [entityType, entityId, entityLabel, JSON.stringify(data), deletedBy]
  );
}

module.exports = { archiveRecord };
