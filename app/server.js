const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const cookieSession = require('cookie-session');
const { Pool } = require('pg');
const { Classifier } = require('./classifier');
const { parseCSV } = require('./csv');
const { runBackup, exportRows, listBackups, lastBackup, BACKUP_DIR } = require('./backup');
const auth = require('./auth');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Categorie fisse per le spese di casa
const HOME_CATEGORIES = ['UTENZE', 'CONDOMINIO', 'VARIE'];

// Ambito richiesto da una query di lettura: 'personal' (default), 'home' o 'all'
const scopeParam = (req) => {
  const s = req.query.scope;
  return s === 'home' || s === 'all' ? s : 'personal';
};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // dietro il reverse proxy (NPM)

// Asset statici pubblici (CSS/JS di client, libreria grafici): non contengono dati
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.use(cookieSession({
  name: 'spese_sess',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  httpOnly: true,
  sameSite: 'lax',
  secure: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 giorni
}));

/* ---------------- Autenticazione ---------------- */

// Endpoint pubblico di stato (per monitoraggio / healthcheck)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'down', message: err.message });
  }
});

app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.render('login');
});

app.post('/api/login', (req, res) => {
  if (auth.tooMany(req.ip)) {
    return res.status(429).json({ error: 'Troppi tentativi falliti. Riprova tra qualche minuto.' });
  }
  const { username, password } = req.body || {};
  if (!auth.verify(username, password)) {
    auth.noteFailure(req.ip);
    return res.status(401).json({ error: 'Credenziali non valide.' });
  }
  auth.clearFailures(req.ip);
  req.session.user = auth.USERNAME;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// Da qui in poi ogni richiesta richiede una sessione valida
app.use((req, res, next) => {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  res.redirect('/login');
});

/* ---------------- Database ---------------- */

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id          SERIAL PRIMARY KEY,
      spent_on    DATE NOT NULL,
      amount      NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      description TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'expense';
    ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_kind_check;
    ALTER TABLE expenses ADD CONSTRAINT expenses_kind_check CHECK (kind IN ('expense', 'income'));
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';
    ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_scope_check;
    ALTER TABLE expenses ADD CONSTRAINT expenses_scope_check CHECK (scope IN ('personal', 'home'));
    CREATE INDEX IF NOT EXISTS expenses_spent_on_idx ON expenses (spent_on);
    CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses (category);
    CREATE INDEX IF NOT EXISTS expenses_scope_idx ON expenses (scope);
  `);
}

const SELECT_ROW = `
  id,
  to_char(spent_on, 'YYYY-MM-DD') AS spent_on,
  amount::float8 AS amount,
  description,
  kind,
  category,
  scope
`;

/* ---------------- Modello predittivo ---------------- */

const clf = new Classifier();
let modelDirty = true;

async function refreshModel() {
  // Il modello impara solo dalle spese personali; quelle di casa hanno categorie fisse.
  const { rows } = await pool.query(`SELECT ${SELECT_ROW} FROM expenses WHERE scope = 'personal'`);
  clf.train(rows);
  modelDirty = false;
}

async function ensureModel() {
  if (modelDirty) await refreshModel();
}

/* ---------------- Validazione ---------------- */

function parseBody(body) {
  const { date, amount, description, kind, category, scope } = body || {};
  const amt = Number(amount);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'Data non valida (formato YYYY-MM-DD).' };
  }
  if (!Number.isFinite(amt) || amt < 0) {
    return { error: 'Importo non valido: dev\'essere un numero >= 0.' };
  }
  const sc = scope === 'home' ? 'home' : 'personal';
  let cat = String(category || '').trim().slice(0, 60);
  if (sc === 'home') {
    cat = cat.toUpperCase();
    if (!HOME_CATEGORIES.includes(cat)) {
      return { error: 'Per le spese di casa scegli una categoria: UTENZE, CONDOMINIO o VARIE.' };
    }
  }
  return {
    value: {
      date,
      amount: amt.toFixed(2),
      description: String(description || '').trim().slice(0, 500),
      kind: kind === 'income' ? 'income' : 'expense',
      category: cat,
      scope: sc,
    },
  };
}

/* ---------------- Rotte ---------------- */

app.get('/', (req, res) => res.render('index'));

app.get('/api/expenses', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_ROW} FROM expenses
       WHERE ($1 = 'all' OR scope = $1)
       ORDER BY spent_on DESC, id DESC`,
      [scopeParam(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/expenses', async (req, res, next) => {
  try {
    const parsed = parseBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { date, amount, description, kind, category, scope } = parsed.value;
    const { rows } = await pool.query(
      `INSERT INTO expenses (spent_on, amount, description, kind, category, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_ROW}`,
      [date, amount, description, kind, category, scope]
    );
    modelDirty = true;
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.put('/api/expenses/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    const parsed = parseBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { date, amount, description, kind, category, scope } = parsed.value;
    const { rows } = await pool.query(
      `UPDATE expenses
       SET spent_on = $1, amount = $2, description = $3, kind = $4, category = $5, scope = $6
       WHERE id = $7
       RETURNING ${SELECT_ROW}`,
      [date, amount, description, kind, category, scope, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Movimento non trovato' });
    modelDirty = true;
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/expenses/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
    modelDirty = true;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Categorie gia' usate (per autocompletamento e filtri)
app.get('/api/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT category, COUNT(*)::int AS n
       FROM expenses WHERE category <> '' AND ($1 = 'all' OR scope = $1)
       GROUP BY category ORDER BY n DESC, category`,
      [scopeParam(req)]
    );
    res.json(rows.map((r) => r.category));
  } catch (err) {
    next(err);
  }
});

// Previsione categoria per una spesa in corso di inserimento
app.post('/api/predict', async (req, res, next) => {
  try {
    await ensureModel();
    const { description, date, amount } = req.body || {};
    const pred = clf.predict({
      description: description || '',
      spent_on: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10),
      amount: Number(amount) || 0,
    });
    res.json(pred || { category: null });
  } catch (err) {
    next(err);
  }
});

// Stato del modello predittivo
app.get('/api/model', async (req, res, next) => {
  try {
    await ensureModel();
    res.json({
      trained: clf.trained,
      samples: clf.samples,
      accuracy: clf.accuracy,
      categories: clf.categories,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- Riepiloghi e grafici ---------------- */

app.get('/api/summary', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on = CURRENT_DATE), 0)::float8                       AS day_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on = CURRENT_DATE), 0)::float8                       AS day_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on >= date_trunc('week',  CURRENT_DATE)), 0)::float8 AS week_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on >= date_trunc('week',  CURRENT_DATE)), 0)::float8 AS week_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS month_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS month_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float8                                                   AS total_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::float8                                                    AS total_income,
        COUNT(*)::int                                                                                                     AS count
      FROM expenses
      WHERE ($1 = 'all' OR scope = $1)
    `, [scopeParam(req)]);
    const r = rows[0];
    const period = (e, i) => ({ expense: e, income: i, balance: +(i - e).toFixed(2) });
    res.json({
      day: period(r.day_expense, r.day_income),
      week: period(r.week_expense, r.week_income),
      month: period(r.month_expense, r.month_income),
      total: period(r.total_expense, r.total_income),
      count: r.count,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/chart/daily', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const { rows } = await pool.query(`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense'), 0)::float8 AS expense,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'income'), 0)::float8  AS income
      FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day') d
      LEFT JOIN expenses e ON e.spent_on = d::date AND ($2 = 'all' OR e.scope = $2)
      GROUP BY d ORDER BY d
    `, [days, scopeParam(req)]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/chart/monthly', async (req, res, next) => {
  try {
    const months = Math.min(24, Math.max(3, Number(req.query.months) || 12));
    const { rows } = await pool.query(`
      SELECT to_char(m, 'YYYY-MM') AS month,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense'), 0)::float8 AS expense,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'income'), 0)::float8  AS income
      FROM generate_series(date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
                           date_trunc('month', CURRENT_DATE),
                           interval '1 month') m
      LEFT JOIN expenses e ON date_trunc('month', e.spent_on) = m AND ($2 = 'all' OR e.scope = $2)
      GROUP BY m ORDER BY m
    `, [months, scopeParam(req)]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Spese per categoria nel mese corrente
app.get('/api/chart/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(NULLIF(category, ''), 'Senza categoria') AS category,
             SUM(amount)::float8 AS expense
      FROM expenses
      WHERE kind = 'expense' AND spent_on >= date_trunc('month', CURRENT_DATE)
        AND ($1 = 'all' OR scope = $1)
      GROUP BY 1 ORDER BY expense DESC
    `, [scopeParam(req)]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ---------------- Backup / ripristino CSV ---------------- */

// Export immediato (download)
app.get('/api/export.csv', async (req, res, next) => {
  try {
    const { csv } = await exportRows(pool);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="spese-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// Elenco dei backup settimanali salvati su disco
app.get('/api/backups', async (req, res, next) => {
  try {
    const list = await listBackups();
    res.json({
      dir: BACKUP_DIR,
      last: await lastBackup(),
      files: list,
    });
  } catch (err) {
    next(err);
  }
});

// Download di un backup specifico
app.get('/api/backups/:file', async (req, res, next) => {
  const name = path.basename(req.params.file || '');
  if (!/^expenses-[\w.-]+\.csv$/.test(name)) {
    return res.status(400).json({ error: 'Nome file non valido' });
  }
  res.download(path.join(BACKUP_DIR, name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Backup non trovato' });
  });
});

// Forza subito un backup su disco
app.post('/api/backups/run', async (req, res, next) => {
  try {
    const r = await runBackup(pool);
    res.json({ ok: true, ...r });
  } catch (err) {
    next(err);
  }
});

// Ripristino / import da CSV.  mode=merge (default) salta i duplicati; mode=replace svuota e ricarica.
app.post('/api/import', express.text({ type: '*/*', limit: '15mb' }), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
    const records = parseCSV(req.body || '');
    if (!records.length) return res.status(400).json({ error: 'CSV vuoto o non riconosciuto.' });

    const valid = [];
    const invalid = [];
    records.forEach((rec, i) => {
      const p = parseBody({
        date: String(rec.spent_on || rec.date || '').trim(),
        amount: String(rec.amount || '').replace(',', '.').trim(),
        description: rec.description || '',
        kind: String(rec.kind || 'expense').trim(),
        category: rec.category || '',
        scope: String(rec.scope || 'personal').trim(),
      });
      if (p.error) invalid.push({ line: i + 2, error: p.error });
      else valid.push(p.value);
    });
    if (!valid.length) {
      return res.status(400).json({ error: 'Nessuna riga valida nel CSV.', invalid });
    }

    await client.query('BEGIN');
    if (mode === 'replace') await client.query('TRUNCATE expenses RESTART IDENTITY');

    let inserted = 0;
    let skipped = 0;
    for (const v of valid) {
      if (mode === 'merge') {
        const dup = await client.query(
          `SELECT 1 FROM expenses
           WHERE spent_on=$1 AND kind=$2 AND amount=$3 AND description=$4 AND category=$5 AND scope=$6 LIMIT 1`,
          [v.date, v.kind, v.amount, v.description, v.category, v.scope]
        );
        if (dup.rowCount) { skipped++; continue; }
      }
      await client.query(
        `INSERT INTO expenses (spent_on, amount, description, kind, category, scope)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [v.date, v.amount, v.description, v.kind, v.category, v.scope]
      );
      inserted++;
    }
    await client.query('COMMIT');
    modelDirty = true;
    res.json({ mode, inserted, skipped, invalid });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Errore interno del server' });
});

/* ---------------- Avvio ---------------- */

async function start() {
  for (let attempt = 1; ; attempt++) {
    try {
      await initDb();
      break;
    } catch (err) {
      if (attempt >= 15) throw err;
      console.error(`Init DB fallita (tentativo ${attempt}/15): ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (auth.generatedPassword) {
    console.warn(
      `\n  ATTENZIONE: AUTH_PASSWORD non impostata. Password temporanea generata:\n` +
      `      utente: ${auth.USERNAME}\n` +
      `      password: ${auth.generatedPassword}\n` +
      `  Impostala in .env e riavvia per renderla stabile.\n`
    );
  } else {
    console.log(`Autenticazione attiva per l'utente "${auth.USERNAME}".`);
  }

  try {
    await refreshModel();
    console.log(`Modello: ${clf.samples} campioni, addestrato=${clf.trained}`);
  } catch (err) {
    console.error('Addestramento iniziale del modello fallito:', err.message);
  }

  // Backup automatico: ogni lunedì alle 03:00 (Europe/Rome)
  cron.schedule('0 3 * * 1', async () => {
    try {
      const r = await runBackup(pool);
      console.log(`Backup settimanale: ${r.count} righe -> ${r.file}`);
    } catch (err) {
      console.error('Backup settimanale fallito:', err.message);
    }
  }, { timezone: 'Europe/Rome' });

  // Auto-riparazione: se manca un backup da più di 7 giorni, creane uno all'avvio
  try {
    const last = await lastBackup();
    const stale = !last || Date.now() - new Date(last.mtime).getTime() > 7 * 86400 * 1000;
    if (stale) {
      const r = await runBackup(pool);
      console.log(`Backup di avvio: ${r.count} righe -> ${r.file}`);
    }
  } catch (err) {
    console.error('Backup di avvio fallito:', err.message);
  }

  app.listen(port, () => console.log(`webserver in ascolto sulla porta ${port}`));
}

start().catch((err) => {
  console.error('Impossibile avviare il webserver:', err);
  process.exit(1);
});
