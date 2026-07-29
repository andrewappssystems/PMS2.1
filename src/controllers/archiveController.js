'use strict';
const pool = require('../../database/pool');

/**
 * Enterprise Audit Log — list with filters
 * Supports: date range, user, module, action, severity, status, text search
 */
exports.search = async (req, res) => {
  try {
    const {
      type='', search='',
      module='', severity='', status='', action='',
      from='', to='',
      limit=200
    } = req.query;

    let query = `
      SELECT
        a.id,
        TO_CHAR(a.deleted_at,'YYYY-MM-DD HH24:MI:SS') AS timestamp,
        a.deleted_by   AS user_name,
        COALESCE(a.user_role,'') AS user_role,
        COALESCE(a.module, a.entity_type, '') AS module,
        COALESCE(a.action,'LOG') AS action,
        a.entity_type,
        a.entity_id,
        COALESCE(a.description, a.entity_label, '') AS description,
        a.entity_label,
        a.old_values,
        a.new_values,
        COALESCE(a.severity,'INFO') AS severity,
        COALESCE(a.log_status,'SUCCESS') AS status,
        a.ip_address,
        a.user_agent,
        a.route,
        a.reference_number,
        a.ref_tenant_id, a.ref_landlord_id, a.ref_property_id,
        a.data,
        a.metadata
      FROM archive a
      WHERE 1=1`;

    const params = [];

    if (type || module) {
      params.push(type || module);
      query += ` AND (a.entity_type=$${params.length} OR a.module=$${params.length})`;
    }
    if (severity) {
      params.push(severity);
      query += ` AND a.severity=$${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND a.log_status=$${params.length}`;
    }
    if (action) {
      params.push(action);
      query += ` AND a.action=$${params.length}`;
    }
    if (from) {
      params.push(from);
      query += ` AND a.deleted_at >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      query += ` AND a.deleted_at < ($${params.length}::date + interval '1 day')`;
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND (
        LOWER(a.entity_label) LIKE $${params.length} OR
        LOWER(a.description)  LIKE $${params.length} OR
        LOWER(a.deleted_by)   LIKE $${params.length} OR
        LOWER(a.entity_type)  LIKE $${params.length} OR
        LOWER(a.reference_number) LIKE $${params.length}
      )`;
    }

    query += ` ORDER BY a.id DESC LIMIT $${params.length+1}`;
    params.push(parseInt(limit) || 200);

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    console.error('[archiveController.search]', e.message);
    res.status(500).json({ error: e.message });
  }
};

/**
 * Summary counts for the audit log dashboard cards
 */
exports.summary = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE deleted_at::date = $1::date) AS today_total,
        COUNT(*) FILTER (WHERE severity='CRITICAL' AND deleted_at::date = $1::date) AS today_critical,
        COUNT(*) FILTER (WHERE severity='WARNING' AND deleted_at::date = $1::date) AS today_warnings,
        COUNT(*) FILTER (WHERE (action='LOGIN' OR action='LOGOUT') AND deleted_at::date = $1::date) AS today_logins,
        COUNT(*) FILTER (WHERE action='LOGIN_FAILED' AND deleted_at::date = $1::date) AS today_failed_logins,
        COUNT(*) FILTER (WHERE module IN ('rent','invoice','receipt') AND deleted_at::date = $1::date) AS today_financial,
        COUNT(*) FILTER (WHERE module='report' AND deleted_at::date = $1::date) AS today_reports
      FROM archive`, [today]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
