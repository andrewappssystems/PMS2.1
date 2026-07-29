'use strict';
const pool = require('../../database/pool');

/**
 * Enterprise Audit Trail Service
 *
 * Logs meaningful business events only — not page views, polling, or static assets.
 *
 * @param {object} opts
 * @param {string}  opts.action        - e.g. 'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'PAYMENT'
 * @param {string}  opts.module        - e.g. 'tenant', 'rent', 'invoice', 'auth'
 * @param {string}  opts.entityType    - e.g. 'tenant', 'invoice', 'user'
 * @param {string}  opts.entityId      - Primary key of the affected record
 * @param {string}  opts.description   - Human-readable sentence describing the change
 * @param {object}  [opts.oldValues]   - Before state (for updates)
 * @param {object}  [opts.newValues]   - After state (for updates)
 * @param {string}  [opts.severity]    - 'INFO' | 'WARNING' | 'CRITICAL'
 * @param {string}  [opts.status]      - 'SUCCESS' | 'FAILED' | 'PARTIAL'
 * @param {object}  [opts.req]         - Express request (for IP, browser, session)
 * @param {string}  [opts.actor]       - Username/ID of who performed the action
 * @param {string}  [opts.tenantId]
 * @param {string}  [opts.landlordId]
 * @param {string}  [opts.propertyId]
 * @param {string}  [opts.referenceNumber]  - Receipt/Invoice/Payment reference
 * @param {object}  [opts.metadata]    - Any extra structured data
 */
async function logEvent({
  action, module, entityType, entityId, description,
  oldValues, newValues,
  severity = 'INFO', status = 'SUCCESS',
  req, actor,
  tenantId, landlordId, propertyId,
  referenceNumber, metadata
} = {}) {
  try {
    const ip       = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '') : '';
    const ua       = req ? (req.headers['user-agent'] || '') : '';
    const route    = req ? `${req.method} ${req.originalUrl}` : '';
    const sessionId = req?.session?.id || '';
    const userId   = req?.session?.userId || actor || '';
    const userName = req?.session?.username || actor || 'System';
    const userRole = req?.session?.role || '';

    await pool.query(
      `INSERT INTO archive
       (entity_type, entity_id, entity_label, data, deleted_by,
        module, action, description,
        old_values, new_values,
        severity, log_status,
        ip_address, user_agent,
        session_id, route,
        ref_tenant_id, ref_landlord_id, ref_property_id,
        reference_number, user_role, metadata)
       VALUES
       ($1,$2,$3,$4,$5,
        $6,$7,$8,
        $9,$10,
        $11,$12,
        $13,$14,
        $15,$16,
        $17,$18,$19,
        $20,$21,$22)`,
      [
        entityType || module,
        entityId || '',
        description || `${action} ${entityType}`,
        JSON.stringify({ action, module, ...(metadata || {}) }),
        userName,
        module || entityType,
        action,
        description || '',
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        severity,
        status,
        ip, ua,
        sessionId, route,
        tenantId || null,
        landlordId || null,
        propertyId || null,
        referenceNumber || null,
        userRole,
        metadata ? JSON.stringify(metadata) : null
      ]
    );
  } catch (err) {
    // Never crash the app due to audit failure — just warn
    console.warn('[AuditService] Failed to write audit log:', err.message);
  }
}

/**
 * Backward-compatible wrapper used by existing controllers.
 * Maps old 4-arg signature → new structured event.
 */
async function logAudit(action, entityType, entityId, entityLabel, details, actor) {
  await logEvent({
    action,
    module: entityType,
    entityType,
    entityId: String(entityId || ''),
    description: `${actor || 'System'} performed ${action} on ${entityType} ${entityLabel || entityId}`,
    newValues: details,
    severity: action === 'DELETE' ? 'WARNING' : 'INFO',
    status: 'SUCCESS',
    actor: actor || 'System'
  });
}

/**
 * Archive (soft-delete) a record — still logs as WARNING.
 */
async function archiveRecord(entityType, entityId, entityLabel, data, deletedBy) {
  await logEvent({
    action: 'DELETE',
    module: entityType,
    entityType,
    entityId: String(entityId || ''),
    description: `${deletedBy || 'System'} archived ${entityType}: ${entityLabel}`,
    oldValues: data,
    severity: 'WARNING',
    status: 'SUCCESS',
    actor: deletedBy || 'System'
  });
}

module.exports = { logEvent, logAudit, archiveRecord };
