'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');
const { archiveRecord } = require('../services/archiveService');
const { getTenantBalance } = require('../services/rentService');

exports.list = async (req, res) => {
  const cached = getCached('tenants');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT t.tenant_id AS "ID", t.name AS "Name", t.phone AS "Phone",
             t.email AS "Email", t.id_number AS "ID Number",
             t.unit_id AS "Unit ID", u.unit_number AS "Unit Number",
             TO_CHAR(t.lease_start,'YYYY-MM-DD') AS "Lease Start",
             TO_CHAR(t.lease_end,'YYYY-MM-DD')   AS "Lease End",
             t.rent_amount AS "Rent Amount", t.deposit AS "Deposit",
             t.status AS "Status",
             TO_CHAR(t.created_at,'YYYY-MM-DD') AS "Date Added", t.created_by AS "Added By"
      FROM tenants t LEFT JOIN units u ON u.unit_id=t.unit_id ORDER BY t.id DESC`);
    setCache('tenants', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['name','Name'],['phone','Phone'],['unitId','Unit']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone, email='', idNumber='', unitId, leaseStart='', leaseEnd='', rentAmount='0', deposit='0' } = req.body;
    const id = await getNextId('tenants', 'tenant_id', 'TNT');
    await pool.query(
      `INSERT INTO tenants (tenant_id,name,phone,email,id_number,unit_id,lease_start,lease_end,rent_amount,deposit,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active',$11)`,
      [id, name.trim(), phone.trim(), email.trim(), idNumber.trim(), unitId, leaseStart||null, leaseEnd||null, parseFloat(rentAmount)||0, parseFloat(deposit)||0, actor(req)]
    );
    await pool.query(`UPDATE units SET status='Occupied' WHERE unit_id=$1`, [unitId]);
    clearCache('tenants','units','properties','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/tenants]', e.message); res.status(500).json({ error: e.message }); }
};

exports.update = async (req, res) => {
  const err = validate([['name','Name'],['phone','Phone']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone, email='', idNumber='', unitId, leaseStart='', leaseEnd='', rentAmount='0', deposit='0', status='Active' } = req.body;
    const { rows:cur } = await pool.query(`SELECT unit_id FROM tenants WHERE tenant_id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Tenant not found' });
    const oldUnit = cur[0].unit_id;
    await pool.query(
      `UPDATE tenants SET name=$1,phone=$2,email=$3,id_number=$4,unit_id=$5,lease_start=$6,lease_end=$7,rent_amount=$8,deposit=$9,status=$10 WHERE tenant_id=$11`,
      [name.trim(), phone.trim(), email.trim(), idNumber.trim(), unitId||oldUnit, leaseStart||null, leaseEnd||null, parseFloat(rentAmount)||0, parseFloat(deposit)||0, status, req.params.id]
    );
    if (status.toLowerCase() === 'inactive' && oldUnit)
      await pool.query(`UPDATE units SET status='Vacant' WHERE unit_id=$1`, [oldUnit]);
    if (unitId && unitId !== oldUnit) {
      await pool.query(`UPDATE units SET status='Vacant'   WHERE unit_id=$1`, [oldUnit]);
      await pool.query(`UPDATE units SET status='Occupied' WHERE unit_id=$1`, [unitId]);
    }
    clearCache('tenants','units','properties','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/tenants]', e.message); res.status(500).json({ error: e.message }); }
};

// Hard-delete tenant → archive → free unit
exports.remove = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tenants WHERE tenant_id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = rows[0];
    // Archive
    await archiveRecord('tenant', tenant.tenant_id,
      `${tenant.name} (${tenant.tenant_id})`, tenant, actor(req));
    // Free unit
    if (tenant.unit_id) {
      await pool.query(`UPDATE units SET status='Vacant' WHERE unit_id=$1`, [tenant.unit_id]);
    }
    // Hard delete
    await pool.query(`DELETE FROM tenants WHERE tenant_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM rent_balances WHERE tenant_id=$1`, [req.params.id]);
    clearCache('tenants','units','properties','stats');
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /api/tenants]', e.message);
    res.status(500).json({ error: e.message });
  }
};

exports.getBalance = async (req, res) => {
  try {
    const balance = await getTenantBalance(req.params.id);
    res.json({ balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
