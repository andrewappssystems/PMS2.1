'use strict';
function getPagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function pageResp(rows, total, page, limit) {
  return { data: rows, total: Number(total), page, pages: Math.ceil(Number(total) / limit) };
}

module.exports = { getPagination, pageResp };
