const pool = require('../../database/pool');
const { getCached, setCache, clearCache } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');
const { archiveRecord } = require('../services/archiveService');

exports.list = async (req, res) => {
  const cached = getCached('landlords');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT landlord_id AS "ID", name AS "Name", phone AS "Phone", email AS "Email",
             address AS "Address", bank_name AS "Bank Name", bank_account AS "Bank Account",
             commission_rate AS "Commission Rate", status AS "Status",
             TO_CHAR(created_at,'YYYY-MM-DD') AS "Date Added", created_by AS "Added By"
      FROM landlords ORDER BY id DESC`);
    setCache('landlords', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['name','Name']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone='', email='', address='', bankName='', bankAccount='', commissionRate='10' } = req.body;
    const id = await getNextId('landlords', 'landlord_id', 'LLD');
    await pool.query(
      `INSERT INTO landlords (landlord_id,name,phone,email,address,bank_name,bank_account,commission_rate,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$9)`,
      [id, name.trim(), phone.trim(), email.trim(), address.trim(), bankName.trim(), bankAccount.trim(), parseFloat(commissionRate)||10, actor(req)]
    );
    clearCache('landlords','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/landlords]', e.message); res.status(500).json({ error: e.message }); }
};

exports.update = async (req, res) => {
  const err = validate([['name','Name']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, phone='', email='', address='', bankName='', bankAccount='', commissionRate='10', status='Active' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE landlords SET name=$1,phone=$2,email=$3,address=$4,bank_name=$5,bank_account=$6,commission_rate=$7,status=$8 WHERE landlord_id=$9`,
      [name.trim(), phone.trim(), email.trim(), address.trim(), bankName.trim(), bankAccount.trim(), parseFloat(commissionRate)||10, status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Landlord not found' });
    clearCache('landlords','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/landlords]', e.message); res.status(500).json({ error: e.message }); }
};

exports.remove = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Landlord not found' });
    await archiveRecord('landlord', rows[0].landlord_id,
      rows[0].name, rows[0], actor(req));
    await pool.query(`DELETE FROM landlords WHERE landlord_id=$1`, [req.params.id]);
    clearCache('landlords','stats');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getPortfolio = async (req, res) => {
  try {
    const { rows: llRows } = await pool.query(`SELECT * FROM landlords WHERE landlord_id=$1`, [req.params.id]);
    if (!llRows.length) return res.status(404).json({ error: 'Landlord not found' });
    const l = llRows[0];
    const { rows: propRows } = await pool.query(`
      SELECT p.*,
        COUNT(u.unit_id)::int AS total_units,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='occupied')::int AS occupied,
        COUNT(u.unit_id) FILTER (WHERE LOWER(u.status)='vacant')::int AS vacant,
        COALESCE(SUM(u.rent) FILTER (WHERE LOWER(u.status)='occupied'),0) AS monthly_rent_roll
      FROM properties p
      LEFT JOIN units u ON u.property_id=p.property_id
      WHERE p.landlord_id=$1
      GROUP BY p.property_id ORDER BY p.name`, [req.params.id]
    );
    const { rows: arrearsRows } = await pool.query(`
      SELECT COALESCE(SUM(rb.carried_balance),0) AS total
      FROM rent_balances rb
      JOIN tenants t ON t.tenant_id=rb.tenant_id
      JOIN units u ON u.unit_id=t.unit_id
      JOIN properties p ON p.property_id=u.property_id
      WHERE p.landlord_id=$1 AND rb.carried_balance>0`, [req.params.id]
    );
    const totalUnits    = propRows.reduce((s,p)=>s+p.total_units,0);
    const totalOccupied = propRows.reduce((s,p)=>s+p.occupied,0);
    const totalVacant   = propRows.reduce((s,p)=>s+p.vacant,0);
    const monthlyRoll   = propRows.reduce((s,p)=>s+parseFloat(p.monthly_rent_roll||0),0);
    res.json({
      landlord: l, properties: propRows,
      summary: { totalProperties: propRows.length, totalUnits, totalOccupied, totalVacant, monthlyRoll, totalArrears: parseFloat(arrearsRows[0].total||0) }
    });
  } catch(e) { console.error('[landlord portfolio]',e.message); res.status(500).json({ error: e.message }); }
};
