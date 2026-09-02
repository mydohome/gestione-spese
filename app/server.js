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

// Mese selezionato in un riepilogo, come 'YYYY-MM'; null = mese corrente
const monthParam = (req) => {
  const m = String(req.query.month || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : null;
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

    -- Spese fisse ricorrenti (mutuo, finanziamenti, addebiti, stipendio...)
    CREATE TABLE IF NOT EXISTS recurring (
      id           SERIAL PRIMARY KEY,
      description  TEXT NOT NULL DEFAULT '',
      amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      kind         TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
      category     TEXT NOT NULL DEFAULT '',
      scope        TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'home')),
      account      TEXT NOT NULL DEFAULT '',
      day_of_month INT NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
      active       BOOLEAN NOT NULL DEFAULT true,
      last_run_ym  TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring_id INT REFERENCES recurring(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS expenses_recurring_idx ON expenses (recurring_id);

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

    -- Previsione spese annuali: voci di budget per anno
    CREATE TABLE IF NOT EXISTS forecast (
      id         SERIAL PRIMARY KEY,
      year       INT  NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      category   TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
      amount     NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      frequency  TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'annual')),
      month      INT CHECK (month BETWEEN 1 AND 12),
      note       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS forecast_year_idx ON forecast (year);
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
  account,
  recurring_id
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
    await client.query(
      'UPDATE recurring SET category = $1 WHERE scope = $2 AND lower(category) = lower($3)',
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
    await client.query(
      "UPDATE recurring SET category = '' WHERE scope = $1 AND lower(category) = lower($2)",
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
    await client.query('UPDATE recurring SET account = $1 WHERE lower(account) = lower($2)', [name, cur.rows[0].name]);
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
    await client.query("UPDATE recurring SET account = '' WHERE lower(account) = lower($1)", [cur.rows[0].name]);
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

/* ---------------- Spese fisse ricorrenti ---------------- */

const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
const currentYm = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

const REC_ROW =
  'id, description, amount::float8 AS amount, kind, category, scope, account, day_of_month, active, last_run_ym';

function parseRecurringBody(body) {
  const { description, amount, kind, category, scope, account, day_of_month, active } = body || {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) {
    return { error: 'Importo non valido: dev\'essere un numero >= 0.' };
  }
  let dom = Math.trunc(Number(day_of_month));
  if (!Number.isFinite(dom) || dom < 1) dom = 1;
  if (dom > 31) dom = 31;
  const sc = catScope(scope);
  let cat = String(category || '').trim().slice(0, 60);
  if (sc === 'home') cat = cat.toUpperCase();
  const acc = String(account || '').trim().slice(0, 60);
  if (sc === 'home' && !cat) return { error: 'Per le spese di casa scegli una categoria.' };
  return {
    value: {
      description: String(description || '').trim().slice(0, 500),
      amount: amt.toFixed(2),
      kind: kind === 'income' ? 'income' : 'expense',
      category: cat,
      scope: sc,
      account: acc,
      day_of_month: dom,
      active: active === undefined ? true : !!active,
    },
  };
}

// Crea i movimenti del mese corrente per le regole attive non ancora eseguite questo mese.
// Nessuno storico retroattivo: si genera solo per il mese in corso.
async function generateRecurring() {
  const ym = currentYm();
  const dateFor = (dom) =>
    `${ym}-${String(Math.min(dom, daysInMonth(ym))).padStart(2, '0')}`;
  const { rows } = await pool.query(
    `SELECT id, description, amount::text AS amount, kind, category, scope, account, day_of_month
     FROM recurring WHERE active AND last_run_ym < $1`,
    [ym]
  );
  let created = 0;
  for (const r of rows) {
    const dup = await pool.query(
      `SELECT 1 FROM expenses WHERE recurring_id = $1 AND to_char(spent_on, 'YYYY-MM') = $2 LIMIT 1`,
      [r.id, ym]
    );
    if (!dup.rowCount) {
      await pool.query(
        `INSERT INTO expenses (spent_on, amount, description, kind, category, scope, account, recurring_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [dateFor(r.day_of_month), r.amount, r.description, r.kind, r.category, r.scope, r.account, r.id]
      );
      created++;
    }
    await pool.query('UPDATE recurring SET last_run_ym = $1 WHERE id = $2', [ym, r.id]);
  }
  if (created) modelDirty = true;
  return created;
}

async function runGeneration(tag) {
  try {
    const n = await generateRecurring();
    if (n) console.log(`Spese fisse${tag ? ` (${tag})` : ''}: ${n} movimenti generati per ${currentYm()}`);
  } catch (err) {
    console.error('Generazione spese fisse fallita:', err.message);
  }
}

app.get('/api/recurring', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${REC_ROW} FROM recurring ORDER BY active DESC, lower(description), id`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post('/api/recurring', async (req, res, next) => {
  try {
    const parsed = parseRecurringBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const refErr = await checkRefs(parsed.value);
    if (refErr) return res.status(400).json({ error: refErr });
    const v = parsed.value;
    const { rows } = await pool.query(
      `INSERT INTO recurring (description, amount, kind, category, scope, account, day_of_month, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${REC_ROW}`,
      [v.description, v.amount, v.kind, v.category, v.scope, v.account, v.day_of_month, v.active]
    );
    await runGeneration('nuova');
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.put('/api/recurring/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    const parsed = parseRecurringBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const refErr = await checkRefs(parsed.value);
    if (refErr) return res.status(400).json({ error: refErr });
    const v = parsed.value;
    const { rows } = await pool.query(
      `UPDATE recurring
       SET description = $1, amount = $2, kind = $3, category = $4, scope = $5, account = $6, day_of_month = $7, active = $8
       WHERE id = $9
       RETURNING ${REC_ROW}`,
      [v.description, v.amount, v.kind, v.category, v.scope, v.account, v.day_of_month, v.active, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spesa fissa non trovata' });
    if (rows[0].active) await runGeneration();
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Attiva / disattiva una spesa fissa
app.post('/api/recurring/:id/toggle', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    const { rows } = await pool.query(
      `UPDATE recurring SET active = NOT active WHERE id = $1 RETURNING ${REC_ROW}`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spesa fissa non trovata' });
    if (rows[0].active) await runGeneration('riattivata');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Elimina la regola. I movimenti già generati restano (recurring_id -> NULL).
app.delete('/api/recurring/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    const r = await pool.query('DELETE FROM recurring WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Spesa fissa non trovata' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------- Previsione spese annuali ---------------- */

const FC_ROW =
  'id, year, label, category, kind, amount::float8 AS amount, frequency, month, note';

function parseForecastBody(body) {
  const { year, label, category, kind, amount, frequency, month, note } = body || {};
  const y = Math.trunc(Number(year));
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return { error: 'Anno non valido.' };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) {
    return { error: 'Importo non valido: dev\'essere un numero >= 0.' };
  }
  const freq = frequency === 'annual' ? 'annual' : 'monthly';
  let m = null;
  if (freq === 'annual') {
    m = Math.trunc(Number(month));
    if (!Number.isFinite(m) || m < 1 || m > 12) m = 1;
  }
  return {
    value: {
      year: y,
      label: String(label || '').trim().slice(0, 120),
      category: String(category || '').trim().slice(0, 60),
      kind: kind === 'income' ? 'income' : 'expense',
      amount: amt.toFixed(2),
      frequency: freq,
      month: m,
      note: String(note || '').trim().slice(0, 300),
    },
  };
}

app.get('/api/forecast', async (req, res, next) => {
  try {
    const y = Math.trunc(Number(req.query.year)) || new Date().getFullYear();

    const items = (await pool.query(
      `SELECT ${FC_ROW} FROM forecast
       WHERE year = $1 ORDER BY kind DESC, lower(category), lower(label), id`,
      [y]
    )).rows;

    // Consuntivo reale dell'anno, ripartito per mese
    const actual = (await pool.query(`
      SELECT EXTRACT(MONTH FROM spent_on)::int AS month,
             COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float8 AS expense,
             COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::float8  AS income
      FROM expenses
      WHERE EXTRACT(YEAR FROM spent_on)::int = $1
      GROUP BY 1 ORDER BY 1
    `, [y])).rows;

    // Anni che hanno una previsione o dei movimenti (per il selettore)
    const years = (await pool.query(`
      SELECT DISTINCT y FROM (
        SELECT year AS y FROM forecast
        UNION SELECT EXTRACT(YEAR FROM spent_on)::int FROM expenses
      ) t WHERE y IS NOT NULL ORDER BY y DESC
    `)).rows.map((r) => r.y);

    res.json({ year: y, items, actual, years });
  } catch (err) {
    next(err);
  }
});

app.post('/api/forecast', async (req, res, next) => {
  try {
    const parsed = parseForecastBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;
    const { rows } = await pool.query(
      `INSERT INTO forecast (year, label, category, kind, amount, frequency, month, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${FC_ROW}`,
      [v.year, v.label, v.category, v.kind, v.amount, v.frequency, v.month, v.note]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.put('/api/forecast/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    const parsed = parseForecastBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;
    const { rows } = await pool.query(
      `UPDATE forecast
       SET year = $1, label = $2, category = $3, kind = $4, amount = $5, frequency = $6, month = $7, note = $8
       WHERE id = $9 RETURNING ${FC_ROW}`,
      [v.year, v.label, v.category, v.kind, v.amount, v.frequency, v.month, v.note, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Voce non trovata' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/forecast/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID non valido' });
    const r = await pool.query('DELETE FROM forecast WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Voce non trovata' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Copia tutte le voci di previsione da un anno all'altro
app.post('/api/forecast/copy', async (req, res, next) => {
  try {
    const from = Math.trunc(Number(req.body?.from));
    const to = Math.trunc(Number(req.body?.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
      return res.status(400).json({ error: 'Anni non validi.' });
    }
    const { rowCount } = await pool.query(
      `INSERT INTO forecast (year, label, category, kind, amount, frequency, month, note)
       SELECT $2, label, category, kind, amount, frequency, month, note
       FROM forecast WHERE year = $1`,
      [from, to]
    );
    res.json({ ok: true, copied: rowCount });
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
    const month = monthParam(req);
    const { rows } = await pool.query(`
      WITH b AS (
        SELECT COALESCE(to_date($2::text, 'YYYY-MM'), date_trunc('month', CURRENT_DATE)::date) AS ms
      )
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on = CURRENT_DATE), 0)::float8                       AS day_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on = CURRENT_DATE), 0)::float8                       AS day_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on >= date_trunc('week', CURRENT_DATE) AND spent_on < date_trunc('week', CURRENT_DATE) + interval '1 week'), 0)::float8 AS week_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on >= date_trunc('week', CURRENT_DATE) AND spent_on < date_trunc('week', CURRENT_DATE) + interval '1 week'), 0)::float8 AS week_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on >= (SELECT ms FROM b) AND spent_on < (SELECT ms FROM b) + interval '1 month'), 0)::float8 AS month_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on >= (SELECT ms FROM b) AND spent_on < (SELECT ms FROM b) + interval '1 month'), 0)::float8 AS month_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float8                                                   AS total_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::float8                                                    AS total_income,
        COUNT(*)::int                                                                                                     AS count,
        to_char(MIN(spent_on), 'YYYY-MM-DD')                                                                              AS first_date
      FROM expenses
      WHERE ($1 = 'all' OR scope = $1)
    `, [scopeParam(req), month]);
    const r = rows[0];
    const period = (e, i) => ({ expense: e, income: i, balance: +(i - e).toFixed(2) });

    // Ripartizione Personali / Casa (mese selezionato e complessivo), per il tab Totale
    const { rows: split } = await pool.query(`
      WITH b AS (
        SELECT COALESCE(to_date($1::text, 'YYYY-MM'), date_trunc('month', CURRENT_DATE)::date) AS ms
      )
      SELECT scope,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND spent_on >= (SELECT ms FROM b) AND spent_on < (SELECT ms FROM b) + interval '1 month'), 0)::float8 AS month_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'  AND spent_on >= (SELECT ms FROM b) AND spent_on < (SELECT ms FROM b) + interval '1 month'), 0)::float8 AS month_income,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float8 AS total_expense,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::float8  AS total_income
      FROM expenses GROUP BY scope
    `, [month]);
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
      firstDate: r.first_date,
      selectedMonth: month,
      byScope,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/chart/daily', async (req, res, next) => {
  try {
    const month = monthParam(req);
    if (month) {
      // Un punto per ogni giorno del mese selezionato
      const { rows } = await pool.query(`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense'), 0)::float8 AS expense,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'income'), 0)::float8  AS income
        FROM generate_series(
               to_date($1::text, 'YYYY-MM'),
               (to_date($1::text, 'YYYY-MM') + interval '1 month' - interval '1 day')::date,
               interval '1 day') d
        LEFT JOIN expenses e ON e.spent_on = d::date AND ($2 = 'all' OR e.scope = $2)
        GROUP BY d ORDER BY d
      `, [month, scopeParam(req)]);
      return res.json(rows);
    }
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
    const month = monthParam(req);
    const { rows } = await pool.query(`
      WITH b AS (
        SELECT COALESCE(to_date($2::text, 'YYYY-MM'), date_trunc('month', CURRENT_DATE)::date) AS anchor
      )
      SELECT to_char(m, 'YYYY-MM') AS month,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'expense'), 0)::float8 AS expense,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'income'), 0)::float8  AS income
      FROM generate_series((SELECT anchor FROM b) - make_interval(months => $1::int - 1),
                           (SELECT anchor FROM b),
                           interval '1 month') m
      LEFT JOIN expenses e ON date_trunc('month', e.spent_on) = m AND ($3 = 'all' OR e.scope = $3)
      GROUP BY m ORDER BY m
    `, [months, month, scopeParam(req)]);
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

  // Spese fisse: genera i movimenti del mese corrente all'avvio e ogni giorno alle 00:05
  await runGeneration('avvio');
  cron.schedule('5 0 * * *', () => runGeneration('cron'), { timezone: 'Europe/Rome' });

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
