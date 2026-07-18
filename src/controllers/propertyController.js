'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');
const { logAudit } = require('../services/auditService');

exports.list = async (req, res) => {
  const cached = getCached('properties');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT p.property_id AS "ID", p.name AS "Name",
             p.landlord_id AS "Landlord ID", l.name AS "Landlord Name",
             p.address AS "Address", p.type AS "Type",
             (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id)::int AS "Total Units",
             (SELECT COUNT(*) FROM units u WHERE u.property_id=p.property_id AND LOWER(u.status)='occupied')::int AS "Occupied",
             p.status AS "Status",
             TO_CHAR(p.created_at,'YYYY-MM-DD') AS "Date Added", p.created_by AS "Added By"
      FROM properties p LEFT JOIN landlords l ON l.landlord_id=p.landlord_id ORDER BY p.id DESC`);
    setCache('properties', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['name','Property name'],['landlordId','Landlord']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, landlordId, address='', type='Residential' } = req.body;
    const id = await getNextId('properties', 'property_id', 'PRP');
    await pool.query(
      `INSERT INTO properties (property_id,name,landlord_id,address,type,status,created_by) VALUES ($1,$2,$3,$4,$5,'Active',$6)`,
      [id, name.trim(), landlordId, address.trim(), type, actor(req)]
    );
    await logAudit('CREATE', 'property', id, name.trim(), req.body, actor(req));
    clearCache('properties','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/properties]', e.message); res.status(500).json({ error: e.message }); }
};

exports.update = async (req, res) => {
  const err = validate([['name','Property name'],['landlordId','Landlord']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { name, landlordId, address='', type='Residential', status='Active' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE properties SET name=$1,landlord_id=$2,address=$3,type=$4,status=$5 WHERE property_id=$6`,
      [name.trim(), landlordId, address.trim(), type, status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Property not found' });
    await logAudit('UPDATE', 'property', req.params.id, name.trim(), req.body, actor(req));
    clearCache('properties','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/properties]', e.message); res.status(500).json({ error: e.message }); }
};
