'use strict';

const fs = require('fs/promises');
const path = require('path');
const { toCSV } = require('./csv');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 12; // settimane di storico
const COLUMNS = ['spent_on', 'kind', 'amount', 'description', 'category', 'scope', 'account', 'created_at'];
const FILE_RE = /^expenses-\d{4}-\d{2}-\d{2}\.csv$/;

async function exportRows(pool) {
  const { rows } = await pool.query(`
    SELECT to_char(spent_on, 'YYYY-MM-DD') AS spent_on,
           kind,
           amount::text AS amount,
           description,
           category,
           scope,
           account,
           to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
    FROM expenses
    ORDER BY spent_on, id
  `);
  return { csv: toCSV(rows, COLUMNS), count: rows.length };
}

async function runBackup(pool) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const { csv, count } = await exportRows(pool);
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKUP_DIR, `expenses-${stamp}.csv`);
  await fs.writeFile(file, csv, 'utf8');
  await fs.writeFile(path.join(BACKUP_DIR, 'expenses-latest.csv'), csv, 'utf8');
  await prune();
  return { file: path.basename(file), count };
}

async function prune() {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter((f) => FILE_RE.test(f)).sort();
    const excess = files.slice(0, Math.max(0, files.length - KEEP));
    await Promise.all(excess.map((f) => fs.unlink(path.join(BACKUP_DIR, f)).catch(() => {})));
  } catch { /* directory non ancora creata */ }
}

async function listBackups() {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.csv'));
    const out = [];
    for (const f of files) {
      const st = await fs.stat(path.join(BACKUP_DIR, f));
      let rows = null;
      try {
        const txt = await fs.readFile(path.join(BACKUP_DIR, f), 'utf8');
        rows = Math.max(0, txt.trim().split('\n').length - 1);
      } catch { /* ignora */ }
      out.push({ file: f, size: st.size, mtime: st.mtime, rows });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

async function lastBackup() {
  const list = await listBackups();
  return list.find((b) => FILE_RE.test(b.file)) || null;
}

module.exports = { runBackup, exportRows, listBackups, lastBackup, BACKUP_DIR, COLUMNS };
