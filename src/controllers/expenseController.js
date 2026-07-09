'use strict';
const pool = require('../../database/pool');
const { getCached, setCache, clearCache, clearCachePrefix } = require('../utils/cache');
const { validate } = require('../utils/validation');
const { actor, today } = require('../utils/helpers');
const { getNextId } = require('../utils/idGenerator');
const { getPagination, pageResp } = require('../utils/pagination');

exports.list = async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const key = `expenses_p${page}_l${limit}`;
  const cached = getCached(key);
  if (cached) return res.json(cached);
  try {
    const [data, count] = await Promise.all([
      pool.query(`
        SELECT e.expense_id AS "ID", e.property_id AS "Property ID", p.name AS "Property Name",
               e.category AS "Category", e.description AS "Description", e.amount AS "Amount",
               TO_CHAR(e.expense_date,'YYYY-MM-DD') AS "Date",
               TO_CHAR(e.created_at,'YYYY-MM-DD') AS "Date Added", e.created_by AS "Added By"
        FROM expenses e LEFT JOIN properties p ON p.property_id=e.property_id
        ORDER BY e.id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT COUNT(*) FROM expenses')
    ]);
    const result = pageResp(data.rows, count.rows[0].count, page, limit);
    setCache(key, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
};

exports.create = async (req, res) => {
  const err = validate([['description','Description'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId='', category='Other', description, amount, date='' } = req.body;
    const id = await getNextId('expenses', 'expense_id', 'EXP');
    await pool.query(
      `INSERT INTO expenses (expense_id,property_id,category,description,amount,expense_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, propertyId||null, category, description.trim(), parseFloat(amount), date||today(), actor(req)]
    );
    clearCachePrefix('expenses_'); clearCache('stats');
    res.json({ success:true, id });
  } catch (e) { console.error('[POST /api/expenses]', e.message); res.status(500).json({ error: e.message }); }
};

exports.update = async (req, res) => {
  const err = validate([['description','Description'],['amount','Amount']], req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { propertyId='', category='Other', description, amount, date='' } = req.body;
    const { rowCount } = await pool.query(
      `UPDATE expenses SET property_id=$1,category=$2,description=$3,amount=$4,expense_date=$5 WHERE expense_id=$6`,
      [propertyId||null, category, description.trim(), parseFloat(amount), date||today(), req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Expense not found' });
    clearCachePrefix('expenses_'); clearCache('stats');
    res.json({ success:true });
  } catch (e) { console.error('[PUT /api/expenses]', e.message); res.status(500).json({ error: e.message }); }
};
