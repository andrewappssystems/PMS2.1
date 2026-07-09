'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');

exports.list = async (req, res) => {
  const cached = getCached('units');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(`
      SELECT u.unit_id AS "ID", u.property_id AS "Property ID",
             p.name AS "Property Name", u.unit_number AS "Unit Number",
             u.type AS "Type", u.rent AS "Rent", u.description AS "Description",
             u.status AS "Status",
             TO_CHAR(u.created_at,'YYYY-MM-DD') AS "Date Added", u.created_by AS "Added By"
      FROM units u LEFT JOIN properties p ON p.property_id=u.property_id ORDER BY u.id DESC`);
    setCache('units', rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['propertyId','Property'],['unitNumber','Unit number']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId, unitNumber, type='Studio', rent='0', description='' } = req.body;
    const id = await getNextId('units', 'unit_id', 'UNT');
    await pool.query(
      `INSERT INTO units (unit_id,property_id,unit_number,type,rent,description,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,'Vacant',$7)`,
      [id, propertyId, unitNumber.trim(), type, parseFloat(rent)||0, description.trim(), actor(req)]
    );
    clearCache('units','properties','stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/units]', e.message); res.status(500).json({ error: e.message }); }
};

exports.update = async (req, res) => {
  const err = validate([['propertyId','Property'],['unitNumber','Unit number']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId, unitNumber, type='Studio', rent='0', description='', status='Vacant' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE units SET property_id=$1,unit_number=$2,type=$3,rent=$4,description=$5,status=$6 WHERE unit_id=$7`,
      [propertyId, unitNumber.trim(), type, parseFloat(rent)||0, description.trim(), status, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Unit not found' });
    clearCache('units','properties','stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/units]', e.message); res.status(500).json({ error: e.message }); }
};

exports.bulkCreate = async (req, res) => {
  const err = validate([['propertyId','Property'],['units','Units']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId, units: unitList } = req.body;
    if (!Array.isArray(unitList) || !unitList.length)
      return res.status(400).json({ error: 'No units provided' });
    const created = [];
    for (const u of unitList) {
      const id = await getNextId('units', 'unit_id', 'UNT');
      await pool.query(
        `INSERT INTO units (unit_id,property_id,unit_number,type,rent,description,status,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'Vacant',$7)`,
        [id, propertyId, u.unitNumber, u.type||'Studio', parseFloat(u.rent)||0, u.description||'', actor(req)]
      );
      created.push(id);
    }
    clearCache('units','properties','stats');
    res.json({ success: true, count: created.length, ids: created });
  } catch (e) {
    console.error('[POST /api/units/bulk]', e.message);
    res.status(500).json({ error: e.message });
  }
};
