'use strict';
const pool = require('../../database/pool');

exports.search = async (req, res) => {
  try {
    const { type='', search='' } = req.query;
    let query = `SELECT id, entity_type, entity_id, entity_label,
                        data,
                        TO_CHAR(deleted_at,'YYYY-MM-DD HH24:MI') AS deleted_at,
                        deleted_by
                 FROM archive WHERE 1=1`;
    const params = [];
    if (type) { params.push(type); query += ` AND entity_type=$${params.length}`; }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND LOWER(entity_label) LIKE $${params.length}`;
    }
    query += ' ORDER BY id DESC LIMIT 200';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
