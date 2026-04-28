const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

// Initialize DB structure
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { modpacks: [], codes: [], download_logs: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Minimal SQLite-like API using JSON
const db = {
  prepare: (sql) => ({
    all: (...params) => runQuery(sql, params, 'all'),
    get: (...params) => runQuery(sql, params, 'get'),
    run: (...params) => runQuery(sql, params, 'run'),
  }),
  exec: () => {},
  pragma: () => {},
};

function runQuery(sql, params, mode) {
  const data = loadDB();
  const s = sql.replace(/\s+/g, ' ').trim();

  // ── SELECT ──────────────────────────────────────────────────────────────────
  if (s.toUpperCase().startsWith('SELECT')) {
    // Detect table
    const fromMatch = s.match(/FROM\s+(\w+)/i);
    if (!fromMatch) return mode === 'all' ? [] : null;
    const table = fromMatch[1];
    let rows = data[table] ? [...data[table]] : [];

    // JOIN support (basic: just merge related data)
    const joinMatch = s.match(/JOIN\s+(\w+)\s+\w+\s+ON\s+\w+\.(\w+)\s*=\s*\w+\.(\w+)/i);
    if (joinMatch) {
      const joinTable = joinMatch[1];
      const localKey = joinMatch[2];
      const foreignKey = joinMatch[3];
      rows = rows.map(row => {
        const related = (data[joinTable] || []).find(r => r[foreignKey] === row[localKey]);
        return related ? { ...row, ...Object.fromEntries(Object.entries(related).map(([k,v]) => [`${joinTable}_${k}`, v])) } : row;
      });
    }

    // COUNT(*)
    if (s.match(/SELECT COUNT\(\*\) as count/i)) {
      // WHERE
      rows = applyWhere(rows, s, params, data);
      return mode === 'get' ? { count: rows.length } : [{ count: rows.length }];
    }

    // WHERE
    rows = applyWhere(rows, s, params, data);

    // ORDER BY
    const orderMatch = s.match(/ORDER BY\s+([\w.]+)\s*(DESC|ASC)?/i);
    if (orderMatch) {
      const col = orderMatch[1].split('.').pop();
      const desc = orderMatch[2]?.toUpperCase() === 'DESC';
      rows.sort((a, b) => {
        if (a[col] < b[col]) return desc ? 1 : -1;
        if (a[col] > b[col]) return desc ? -1 : 1;
        return 0;
      });
    }

    // LIMIT
    const limitMatch = s.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1]));

    // Enrich with join aliases used in SELECT
    rows = enrichWithJoinAliases(rows, s, data);

    return mode === 'get' ? (rows[0] || null) : rows;
  }

  // ── INSERT ──────────────────────────────────────────────────────────────────
  if (s.toUpperCase().startsWith('INSERT')) {
    const tableMatch = s.match(/INTO\s+(\w+)/i);
    const colMatch = s.match(/\(([^)]+)\)\s*VALUES/i);
    if (!tableMatch || !colMatch) return;
    const table = tableMatch[1];
    const cols = colMatch[1].split(',').map(c => c.trim());
    const row = {};
    cols.forEach((col, i) => {
      row[col] = params[i] !== undefined ? params[i] : null;
    });
    if (!data[table]) data[table] = [];
    data[table].push(row);
    saveDB(data);
    return;
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────
  if (s.toUpperCase().startsWith('UPDATE')) {
    const tableMatch = s.match(/UPDATE\s+(\w+)/i);
    const setMatch = s.match(/SET\s+(.+?)\s+WHERE/i);
    const whereMatch = s.match(/WHERE\s+(\w+)\s*=\s*\?/i);
    if (!tableMatch) return;
    const table = tableMatch[1];

    if (setMatch && whereMatch) {
      const sets = setMatch[1].split(',').map(s => s.trim());
      const whereCol = whereMatch[1];
      const whereVal = params[params.length - 1];
      let paramIdx = 0;
      data[table] = (data[table] || []).map(row => {
        if (row[whereCol] === whereVal) {
          sets.forEach(set => {
            const [col, val] = set.split('=').map(s => s.trim());
            if (val === '?') {
              row[col] = params[paramIdx++];
            } else if (val.includes('uses + 1')) {
              row[col] = (row[col] || 0) + 1;
            } else if (val === '0' || val === '1') {
              row[col] = parseInt(val);
            }
          });
        }
        return row;
      });
      saveDB(data);
    }
    return;
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  if (s.toUpperCase().startsWith('DELETE')) {
    const tableMatch = s.match(/FROM\s+(\w+)/i);
    const whereMatch = s.match(/WHERE\s+(\w+)\s*=\s*\?/i);
    if (!tableMatch) return;
    const table = tableMatch[1];
    const whereCol = whereMatch ? whereMatch[1] : null;
    const whereVal = params[0];
    if (whereCol) {
      data[table] = (data[table] || []).filter(row => row[whereCol] !== whereVal);
    }
    saveDB(data);
    return;
  }
}

function applyWhere(rows, s, params, data) {
  const whereMatch = s.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
  if (!whereMatch) return rows;
  const conditions = whereMatch[1].trim();
  let paramIdx = 0;
  const parts = conditions.split(/\s+AND\s+/i);
  parts.forEach(part => {
    const m = part.match(/([\w.]+)\s*(=|!=|<>)\s*\?/);
    if (m) {
      const col = m[1].split('.').pop();
      const val = params[paramIdx++];
      if (m[2] === '=' ) rows = rows.filter(r => r[col] === val || String(r[col]) === String(val));
      else rows = rows.filter(r => r[col] !== val && String(r[col]) !== String(val));
    }
  });
  return rows;
}

function enrichWithJoinAliases(rows, sql, data) {
  // For queries like: c.*, m.name as modpack_name
  const asMatches = [...sql.matchAll(/(\w+)\.(\w+)\s+as\s+(\w+)/gi)];
  if (!asMatches.length) return rows;
  return rows.map(row => {
    const enriched = { ...row };
    asMatches.forEach(m => {
      const table = m[1];
      const col = m[2];
      const alias = m[3];
      // Try to find value from joined table data in row
      const key = `${table}_${col}`;
      if (enriched[key] !== undefined) {
        enriched[alias] = enriched[key];
      }
    });
    return enriched;
  });
}

module.exports = db;
