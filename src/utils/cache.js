'use strict';
const _cache = new Map();

function getCached(key) {
  const e = _cache.get(key);
  if (e && (Date.now() - e.t) < 30000) return e.d;
  return null;
}

function setCache(key, data) { _cache.set(key, { d: data, t: Date.now() }); }

function clearCache(...keys) {
  if (!keys.length) _cache.clear();
  else keys.forEach(k => _cache.delete(k));
}

function clearCachePrefix(prefix) {
  [..._cache.keys()].filter(k => k.startsWith(prefix)).forEach(k => _cache.delete(k));
}

module.exports = { getCached, setCache, clearCache, clearCachePrefix };
