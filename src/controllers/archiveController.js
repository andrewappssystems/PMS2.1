'use strict';
const pool = require('../../database/pool');

/**
 * Enterprise Audit Log — list with filters.
 * Tries rich enterprise query (migration columns) first.
 * Falls back to basic archive columns automatically if migration hasn't been run.
 */
exports.search = async (req, res) => {
  try {
    const {
      type = '', search = '',
      module = '', severity = '', status = '', action = '',
      from = '', to = '',
      limit = 200
    } = req.query;

    // Build base WHERE from always-present columns
    const params = [];
    const whereParts = ['1=1'];

    if (type || module) {
      params.push(type || module);
      whereParts.push(`(a.entity_type=$${params.length})`);
    }
    if (from) {
      params.push(from);
      whereParts.push(`a.deleted_at >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      whereParts.push(`a.deleted_at < ($${params.length}::date + interval '1 day')`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      whereParts.push(`(
        LOWER(a.entity_label) LIKE $${params.length} OR
        LOWER(a.deleted_by)   LIKE $${params.length} OR
        LOWER(a.entity_type)  LIKE $${params.length} OR
        LOWER(a.entity_id)    LIKE $${params.length}
      )`);
    }

    const where = whereParts.join(' AND ');

    // ── Try rich query (requires migration columns) ────────────────────────────
    try {
      const richParams = [...params];
      const richWhere = [];

      if (severity) {
        richParams.splice(richParams.length, 0, severity);
        richWhere.push(`a.severity=$${richParams.length}`);
      }
      if (status) {
        richParams.splice(richParams.length, 0, status);
        richWhere.push(`a.log_status=$${richParams.length}`);
      }
      if (action) {
        richParams.splice(richParams.length, 0, action);
        richWhere.push(`a.action=$${richParams.length}`);
      }
      if (search) {
        // Extend search to migration columns (description, reference_number)
        richParams.push(`%${search.toLowerCase()}%`);
        richWhere.push(`(
          LOWER(COALESCE(a.description,'')) LIKE $${richParams.length} OR
          LOWER(COALESCE(a.reference_number,'')) LIKE $${richParams.length}
        )`);
      }

      richParams.push(parseInt(limit) || 200);

      const richQuery = `
        SELECT
          a.id,
          TO_CHAR(a.deleted_at,'YYYY-MM-DD HH24:MI:SS') AS timestamp,
          a.deleted_by   AS user_name,
          COALESCE(a.user_role,'') AS user_role,
          COALESCE(a.module, a.entity_type, '') AS module,
          COALESCE(a.action,'LOG') AS action,
          a.entity_type, a.entity_id,
          COALESCE(a.description, a.entity_label, '') AS description,
          a.entity_label,
          a.old_values, a.new_values,
          COALESCE(a.severity,'INFO') AS severity,
          COALESCE(a.log_status,'SUCCESS') AS status,
          a.ip_address, a.user_agent, a.route, a.reference_number,
          a.ref_tenant_id, a.ref_landlord_id, a.ref_property_id,
          a.data, a.metadata
        FROM archive a
        WHERE ${where}${richWhere.length ? ' AND ' + richWhere.join(' AND ') : ''}
        ORDER BY a.id DESC
        LIMIT $${richParams.length}`;

      const { rows } = await pool.query(richQuery, richParams);
      return res.json(rows);

    } catch (richErr) {
      // Migration columns missing — graceful fallback to base archive schema
      console.warn('[archive] Using basic fallback (run migration.sql for full features):', richErr.message.split('\n')[0]);

      params.push(parseInt(limit) || 200);
      const basicQuery = `
        SELECT
          a.id,
          TO_CHAR(a.deleted_at,'YYYY-MM-DD HH24:MI:SS') AS timestamp,
          a.deleted_by AS user_name,
          '' AS user_role,
          a.entity_type AS module,
          'LOG' AS action,
          a.entity_type, a.entity_id,
          COALESCE(a.entity_label, '') AS description,
          a.entity_label,
          NULL::jsonb AS old_values, NULL::jsonb AS new_values,
          'INFO' AS severity, 'SUCCESS' AS status,
          NULL AS ip_address, NULL AS user_agent,
          NULL AS route, NULL AS reference_number,
          NULL AS ref_tenant_id, NULL AS ref_landlord_id, NULL AS ref_property_id,
          a.data, NULL::jsonb AS metadata
        FROM archive a
        WHERE ${where}
        ORDER BY a.id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(basicQuery, params);
      return res.json(rows);
    }
  } catch (e) {
    console.error('[archiveController.search]', e.message);
    res.status(500).json({ error: e.message });
  }
};

/**
 * Summary counts for audit dashboard cards.
 * Falls back gracefully if migration columns don't exist.
 */
exports.summary = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    try {
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
      return res.json(rows[0]);
    } catch {
      // Basic fallback
      const { rows } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE deleted_at::date=$1::date) AS today_total FROM archive`, [today]
      );
      return res.json({
        today_total: rows[0].today_total, today_critical: 0, today_warnings: 0,
        today_logins: 0, today_failed_logins: 0, today_financial: 0, today_reports: 0
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
