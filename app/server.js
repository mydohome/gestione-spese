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

// Categorie di casa create in automatico al primo avvio (poi gestibili dall'utente)
const SEED_HOME_CATEGORIES = ['UTENZE', 'CONDOMINIO', 'VARIE'];
const SEED_ACCOUNTS = ['CONTO ANNA', 'CONTO MASSY'];

// Ambito di scrittura valido per una categoria
const catScope = (s) => (s === 'home' ? 'home' : 'personal');

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
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS account TEXT NOT NULL DEFAULT '';
    ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_account_check;
    CREATE INDEX IF NOT EXISTS expenses_spent_on_idx ON expenses (spent_on);
    CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses (category);
    CREATE INDEX IF NOT EXISTS expenses_scope_idx ON expenses (scope);
    CREATE INDEX IF NOT EXISTS expenses_account_idx ON expenses (account);

    -- Anagrafica categorie (gestita dall'utente), per ambito
    CREATE TABLE IF NOT EXISTS categories (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      scope      TEXT NOT NULL CHECK (scope IN ('personal', 'home')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS categories_scope_name_uidx ON categories (scope, lower(name));

    -- Anagrafica conti correnti (gestita dall'utente), globale
    CREATE TABLE IF NOT EXISTS accounts (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_name_uidx ON accounts (lower(name));
  `);

  // Seed iniziale (idempotente)
  for (const name of SEED_HOME_CATEGORIES) {
    await pool.query(
      `INSERT INTO categories (name, scope) VALUES ($1, 'home') ON CONFLICT DO NOTHING`, [name]
    );
  }
  await pool.query(`
    INSERT INTO categories (name, scope)
    SELECT DISTINCT category, 'personal' FROM expenses WHERE scope = 'personal' AND category <> ''
    ON CONFLICT DO NOTHING
  `);
  await pool.query(`
    INSERT INTO categories (name, scope)
    SELECT DISTINCT category, 'home' FROM expenses WHERE scope = 'home' AND category <> ''
    ON CONFLICT DO NOTHING
  `);
  for (const name of SEED_ACCOUNTS) {
    await pool.query(`INSERT INTO accounts (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
  }
  await pool.query(`
    INSERT INTO accounts (name)
    SELECT DISTINCT account FROM expenses WHERE account <> ''
    ON CONFLICT DO NOTHING
  `);
}

/* Nomi validi (in minuscolo) per categorie di un ambito e per i conti */
async function validCategoryNames(scope) {
  const { rows } = await pool.query('SELECT lower(name) AS n FROM categories WHERE scope = $1', [scope]);
  return new Set(rows.map((r) => r.n));
}
async function validAccountNames() {
  const { rows } = await pool.query('SELECT lower(name) AS n FROM accounts');
  return new Set(rows.map((r) => r.n));
}
// Crea la categoria/conto se non esiste (usato in import)
async function ensureCategory(client, name, scope) {
  if (name) await client.query(
    `INSERT INTO categories (name, scope) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [name, scope]
  );
}
async function ensureAccount(client, name) {
  if (name) await client.query(
    `INSERT INTO accounts (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]
  );
}

const SELECT_ROW = `
  id,
  to_char(spent_on, 'YYYY-MM-DD') AS spent_on,
  amount::float8 AS amount,
  description,
  kind,
  category,
  scope,
  account
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
  const { date, amount, description, kind, category, scope, account } = body || {};
  const amt = Number(amount);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'Data non valida (formato YYYY-MM-DD).' };
  }
  if (!Number.isFinite(amt) || amt < 0) {
    return { error: 'Importo non valido: dev\'essere un numero >= 0.' };
  }
  const sc = catScope(scope);
  let cat = String(category || '').trim().slice(0, 60);
  if (sc === 'home') cat = cat.toUpperCase();
  const acc = String(account || '').trim().slice(0, 60);
  if (sc === 'home' && !cat) {
    return { error: 'Per le spese di casa scegli una categoria.' };
  }
  return {
    value: {
      date,
      amount: amt.toFixed(2),
      description: String(description || '').trim().slice(0, 500),
      kind: kind === 'income' ? 'income' : 'expense',
      category: cat,
      scope: sc,
      account: acc,
    },
  };
}

// Verifica che categoria (se presente) e conto (se presente) esistano in anagrafica
async function checkRefs({ scope, category, account }) {
  if (category) {
    const cats = await validCategoryNames(scope);
    if (!cats.has(category.toLowerCase())) {
      return `Categoria "${category}" non presente. Aggiungila dal menu Categorie.`;
    }
  }
  if (account) {
    const accs = await validAccountNames();
    if (!accs.has(account.toLowerCase())) {
      return `Conto "${account}" non presente. Aggiungilo dal menu Conti.`;
    }
  }
  return null;
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
    const refErr = await checkRefs(parsed.value);
    if (refErr) return res.status(400).json({ error: refErr });
    const { date, amount, description, kind, category, scope, account } = parsed.value;
    const { rows } = await pool.query(
      `INSERT INTO expenses (spent_on, amount, description, kind, category, scope, account)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SELECT_ROW}`,
      [date, amount, description, kind, category, scope, account]
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
    const refErr = await checkRefs(parsed.value);
    if (refErr) return res.status(400).json({ error: refErr });
    const { date, amount, description, kind, category, scope, account } = parsed.value;
    const { rows } = await pool.query(
      `UPDATE expenses
       SET spent_on = $1, amount = $2, description = $3, kind = $4, category = $5, scope = $6, account = $7
       WHERE id = $8
       RETURNING ${SELECT_ROW}`,
      [date, amount, description, kind, category, scope, account, id]
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

/* ---------------- Anagrafica categorie ---------------- */

// Elenco categorie di un ambito, con conteggio e importi (per form e per la vista Categorie).
// scope: 'personal' | 'home' | 'all'
app.get('/api/categories', async (req, res, next) => {
  try {
    const sc = scopeParam(req);
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.scope,
             COUNT(e.id)::int AS count,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense'), 0)::float8 AS total_expense,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense' AND e.spent_on >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS month_expense
      FROM categories c
      LEFT JOIN expenses e ON e.scope = c.scope AND lower(e.category) = lower(c.name)
      WHERE ($1 = 'all' OR c.scope = $1)
      GROUP BY c.id, c.name, c.scope
      ORDER BY c.scope, c.name
    `, [sc]);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/categories', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const scope = catScope(req.body?.scope);
    if (!name) return res.status(400).json({ error: 'Nome categoria mancante.' });
    const norm = scope === 'home' ? name.toUpperCase() : name;
    const { rows } = await pool.query(
      `INSERT INTO categories (name, scope) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id, name, scope`,
      [norm, scope]
    );
    if (!rows.length) return res.status(409).json({ error: 'Categoria già esistente in questo ambito.' });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.put('/api/categories/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    if (!name) return res.status(400).json({ error: 'Nome categoria mancante.' });
    await client.query('BEGIN');
    const cur = await client.query('SELECT name, scope FROM categories WHERE id = $1', [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria non trovata' }); }
    const { name: oldName, scope } = cur.rows[0];
    const norm = scope === 'home' ? name.toUpperCase() : name;
    const dup = await client.query(
      'SELECT 1 FROM categories WHERE scope = $1 AND lower(name) = lower($2) AND id <> $3',
      [scope, norm, id]
    );
    if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Esiste già una categoria con questo nome.' }); }
    await client.query('UPDATE categories SET name = $1 WHERE id = $2', [norm, id]);
    await client.query(
      'UPDATE expenses SET category = $1 WHERE scope = $2 AND lower(category) = lower($3)',
      [norm, scope, oldName]
    );
    await client.query('COMMIT');
    modelDirty = true;
    res.json({ id, name: norm, scope });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/categories/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    await client.query('BEGIN');
    const cur = await client.query('SELECT name, scope FROM categories WHERE id = $1', [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoria non trovata' }); }
    const { name, scope } = cur.rows[0];
    // I movimenti restano, senza categoria
    const upd = await client.query(
      "UPDATE expenses SET category = '' WHERE scope = $1 AND lower(category) = lower($2)",
      [scope, name]
    );
    await client.query('DELETE FROM categories WHERE id = $1', [id]);
    await client.query('COMMIT');
    modelDirty = true;
    res.json({ ok: true, cleared: upd.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/* ---------------- Anagrafica conti ---------------- */

app.get('/api/accounts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.name,
             COUNT(e.id)::int AS count,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense'), 0)::float8 AS total_expense,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense' AND e.spent_on >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS month_expense
      FROM accounts a
      LEFT JOIN expenses e ON lower(e.account) = lower(a.name)
      GROUP BY a.id, a.name
      ORDER BY a.name
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/accounts', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Nome conto mancante.' });
    const { rows } = await pool.query(
      `INSERT INTO accounts (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id, name`,
      [name]
    );
    if (!rows.length) return res.status(409).json({ error: 'Conto già esistente.' });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.put('/api/accounts/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    if (!name) return res.status(400).json({ error: 'Nome conto mancante.' });
    await client.query('BEGIN');
    const cur = await client.query('SELECT name FROM accounts WHERE id = $1', [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Conto non trovato' }); }
    const dup = await client.query('SELECT 1 FROM accounts WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Esiste già un conto con questo nome.' }); }
    await client.query('UPDATE accounts SET name = $1 WHERE id = $2', [name, id]);
    await client.query('UPDATE expenses SET account = $1 WHERE lower(account) = lower($2)', [name, cur.rows[0].name]);
    await client.query('COMMIT');
    res.json({ id, name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/accounts/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    await client.query('BEGIN');
    const cur = await client.query('SELECT name FROM accounts WHERE id = $1', [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Conto non trovato' }); }
    const upd = await client.query("UPDATE expenses SET account = '' WHERE lower(account) = lower($1)", [cur.rows[0].name]);
    await client.query('DELETE FROM accounts WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ ok: true, cleared: upd.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
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

    // Ripartizione Personali / Casa (mese corrente e complessivo), per il tab Totale
    const { rows: split } = await pool.query(`
      SELECT scope,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS month_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS month_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float8 AS total_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::float8  AS total_income
      FROM expenses GROUP BY scope
    `);
    const byScope = { personal: null, home: null };
    for (const s of split) {
      byScope[s.scope] = {
        month: period(s.month_expense, s.month_income),
        total: period(s.total_expense, s.total_income),
      };
    }
    const empty = { month: period(0, 0), total: period(0, 0) };
    byScope.personal = byScope.personal || empty;
    byScope.home = byScope.home || empty;

    res.json({
      day: period(r.day_expense, r.day_income),
      week: period(r.week_expense, r.week_income),
      month: period(r.month_expense, r.month_income),
      total: period(r.total_expense, r.total_income),
      count: r.count,
      byScope,
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

// Spese per conto nel mese corrente (per la vista Conti e i grafici)
app.get('/api/chart/accounts', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT account, SUM(amount)::float8 AS expense
      FROM expenses
      WHERE kind = 'expense' AND account <> ''
        AND spent_on >= date_trunc('month', CURRENT_DATE)
        AND ($1 = 'all' OR scope = $1)
      GROUP BY account ORDER BY expense DESC
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
        account: rec.account || '',
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
           WHERE spent_on=$1 AND kind=$2 AND amount=$3 AND description=$4 AND category=$5 AND scope=$6 AND account=$7 LIMIT 1`,
          [v.date, v.kind, v.amount, v.description, v.category, v.scope, v.account]
        );
        if (dup.rowCount) { skipped++; continue; }
      }
      // Categorie/conti dal CSV vengono create in anagrafica se non esistono
      await ensureCategory(client, v.category, v.scope);
      await ensureAccount(client, v.account);
      await client.query(
        `INSERT INTO expenses (spent_on, amount, description, kind, category, scope, account)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [v.date, v.amount, v.description, v.kind, v.category, v.scope, v.account]
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
