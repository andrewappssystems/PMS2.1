const pool = require('../../database/pool');
const { getCached, setCache } = require('../utils/cache');

exports.getStats = async (req, res) => {
  const cached = getCached('stats');
  if (cached) return res.json(cached);
  try {
    const [ll,pr,un,tn,rn,ex,occ,vac,arr] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM landlords'),
      pool.query('SELECT COUNT(*) FROM properties'),
      pool.query('SELECT COUNT(*) FROM units'),
      pool.query('SELECT COUNT(*) FROM tenants'),
      pool.query('SELECT COALESCE(SUM(amount),0) AS t FROM rent_collection'),
      pool.query('SELECT COALESCE(SUM(amount),0) AS t FROM expenses'),
      pool.query("SELECT COUNT(*) FROM units WHERE LOWER(status)='occupied'"),
      pool.query("SELECT COUNT(*) FROM units WHERE LOWER(status)='vacant'"),
      pool.query('SELECT COALESCE(SUM(carried_balance),0) AS t FROM rent_balances WHERE carried_balance > 0')
    ]);
    const result = {
      landlords:Number(ll.rows[0].count), properties:Number(pr.rows[0].count),
      units:Number(un.rows[0].count), tenants:Number(tn.rows[0].count),
      occupied:Number(occ.rows[0].count), vacant:Number(vac.rows[0].count),
      totalRent:Number(rn.rows[0].t), totalExpenses:Number(ex.rows[0].t),
      totalArrears:Number(arr.rows[0].t)
    };
    setCache('stats', result);
    res.json(result);
  } catch (e) { console.error('[/api/stats]', e.message); res.status(500).json({ error: e.message }); }
};
