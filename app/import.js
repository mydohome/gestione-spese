'use strict';

/*
 * Ripristino delle spese da un file CSV (formato prodotto dall'export del webserver).
 *
 *   docker compose exec app node import.js /app/backups/expenses-latest.csv           # unisce (salta i duplicati)
 *   docker compose exec app node import.js /app/backups/expenses-2026-08-31.csv --replace   # svuota e ricarica
 */

const fs = require('fs');
const { Pool } = require('pg');
const { parseCSV } = require('./csv');

function normalize(rec) {
  const date = String(rec.spent_on || rec.date || '').trim();
  const amount = String(rec.amount || '').replace(',', '.').trim();
  const kind = String(rec.kind || 'expense').trim() === 'income' ? 'income' : 'expense';
  const description = String(rec.description || '').trim().slice(0, 500);
  const category = String(rec.category || '').trim().slice(0, 60);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  return { date, amount: n.toFixed(2), description, kind, category };
}

async function main() {
  const file = process.argv[2];
  const mode = process.argv.includes('--replace') ? 'replace' : 'merge';
  if (!file) {
    console.error('Uso: node import.js <file.csv> [--replace]');
    process.exit(1);
  }

  const records = parseCSV(fs.readFileSync(file, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  let bad = 0;

  try {
    await client.query('BEGIN');
    if (mode === 'replace') await client.query('TRUNCATE expenses RESTART IDENTITY');

    for (const rec of records) {
      const v = normalize(rec);
      if (!v) { bad++; continue; }
      if (mode === 'merge') {
        const dup = await client.query(
          `SELECT 1 FROM expenses
           WHERE spent_on=$1 AND kind=$2 AND amount=$3 AND description=$4 AND category=$5 LIMIT 1`,
          [v.date, v.kind, v.amount, v.description, v.category]
        );
        if (dup.rowCount) { skipped++; continue; }
      }
      await client.query(
        `INSERT INTO expenses (spent_on, amount, description, kind, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [v.date, v.amount, v.description, v.kind, v.category]
      );
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`Import (${mode}): ${inserted} inserite, ${skipped} saltate (duplicati), ${bad} scartate (non valide).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Import fallito, nessuna modifica applicata:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
