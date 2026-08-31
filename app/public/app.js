const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

const $ = (sel) => document.querySelector(sel);
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Wrapper fetch: se la sessione è scaduta, riporta al login
async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('non autenticato');
  }
  return res;
}

async function doLogout() {
  await jfetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}
document.getElementById('logout').addEventListener('click', doLogout);
document.getElementById('logout-m')?.addEventListener('click', doLogout);

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
const escapeAttr = (str) => String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');

const CAT_COLORS = [
  '#5566ff', '#12b886', '#f08c00', '#e8546b', '#7c3aed', '#0ca678',
  '#e64980', '#4263eb', '#f76707', '#15aabf', '#ae3ec9', '#37b24d',
];
// Colore stabile per la "pastiglia" di un movimento, derivato dal testo
function swatchColor(str) {
  const s = String(str || '');
  if (!s) return 'var(--ink-faint)';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return CAT_COLORS[Math.abs(hash) % CAT_COLORS.length];
}

// Icone inline (stroke, 24x24)
const ic = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

function toast(msg, kind) {
  if (!msg) return;
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

const form = $('#form');
const rowsEl = $('#tx-list');
const catSelect = $('#category');          // categoria spese personali
const catHomeSelect = $('#category-home'); // categoria spese di casa
const accountSelect = $('#account');       // conto (facoltativo, ogni ambito)

// Anagrafiche caricate dal server
let catCache = { personal: [], home: [] }; // [{id, name, count, ...}]
let acctCache = [];                        // [{id, name, count, ...}]

const optList = (names, sel, emptyLabel) =>
  (emptyLabel != null ? `<option value="">${emptyLabel}</option>` : '') +
  names.map((n) =>
    `<option value="${escapeAttr(n)}"${n === sel ? ' selected' : ''}>${escapeHtml(n)}</option>`
  ).join('');

let expenses = [];
let editingId = null;
let dailyChart, monthlyChart, catChart, acctChart;
let predictTimer = null;
let categoryAuto = false; // true se la categoria e' stata compilata dal modello e non ancora toccata

const VIEWS = ['dashboard', 'movimenti', 'categorie', 'conti', 'backup'];
const VIEW_TITLE = {
  dashboard: 'Dashboard', movimenti: 'Movimenti', categorie: 'Categorie',
  conti: 'Conti', backup: 'Backup',
};
const NO_SCOPE_VIEWS = new Set(['conti', 'backup']); // dati globali: niente switch ambito
const SCOPE_LABEL = { personal: 'personali', home: 'di casa', all: 'personali e di casa' };

const readHash = () => (location.hash.replace(/^#\/?/, '') || 'dashboard');
let view = VIEWS.includes(readHash()) ? readHash() : 'dashboard';

let scope = localStorage.getItem('scope') || 'personal';
if (!['personal', 'home', 'all'].includes(scope)) scope = 'personal';

// Aggiunge ?scope= alle chiamate che dipendono dallo switch attivo
const withScope = (url) => url + (url.includes('?') ? '&' : '?') + 'scope=' + scope;

// Errori mostrati come toast
function showError(msg) { toast(msg, 'error'); }

/* ---------- Navigazione fra viste ---------- */

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  movimenti: loadMovimenti,
  categorie: loadCategorieView,
  conti: loadContiView,
  backup: loadBackupView,
};

function setView(next, { push = true } = {}) {
  if (!VIEWS.includes(next)) next = 'dashboard';
  view = next;
  if (push && readHash() !== next) location.hash = `#/${next}`;

  document.querySelectorAll('section[data-view]').forEach((s) => {
    s.hidden = s.dataset.view !== view;
  });
  document.querySelectorAll('.nav-link[data-view], .tabbar button[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  // Lo switch ambito non ha senso su Conti/Backup (dati globali)
  $('#scope-switch').hidden = NO_SCOPE_VIEWS.has(view);
  $('#page-title').textContent = VIEW_TITLE[view];
  const subs = {
    backup: 'Copie CSV e ripristino',
    conti: 'Anagrafica conti correnti',
    categorie: `Categorie ${SCOPE_LABEL[scope]}`,
  };
  $('#page-sub').textContent = subs[view] || `Spese ed entrate ${SCOPE_LABEL[scope]}`;

  editingId = null;
  reloadView();
}

function reloadView() {
  const fn = VIEW_LOADERS[view] || loadDashboard;
  Promise.resolve(fn()).catch((e) => showError(e.message || 'Errore di caricamento'));
}

document.querySelectorAll('.nav-link[data-view], .tabbar button[data-view]').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});
window.addEventListener('hashchange', () => setView(readHash(), { push: false }));

/* ---------- Switch ambito: Personali / Casa / Totale ---------- */

function applyScopeUI() {
  const all = scope === 'all';
  // Il tab "Totale" è di sola lettura: niente form di inserimento
  form.hidden = all;
  $('#cat-field-personal').hidden = scope !== 'personal';
  $('#cat-field-home').hidden = scope !== 'home';
  $('#split-panel').hidden = !all;
  if (scope !== 'personal') $('#model-note').hidden = true;
}

document.querySelectorAll('#scope-switch .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.scope === scope) return;
    scope = btn.dataset.scope;
    localStorage.setItem('scope', scope);
    document.querySelectorAll('#scope-switch .tab').forEach((b) => {
      const on = b.dataset.scope === scope;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const subs = { categorie: `Categorie ${SCOPE_LABEL[scope]}` };
    $('#page-sub').textContent = subs[view] || `Spese ed entrate ${SCOPE_LABEL[scope]}`;
    editingId = null;
    applyScopeUI();
    reloadView();
  });
});

/* ---------- Riepiloghi ---------- */

function setBalance(id, value) {
  const el = document.getElementById(id);
  el.textContent = euro.format(value);
  el.classList.toggle('pos', value >= 0);
  el.classList.toggle('neg', value < 0);
}

async function loadSummary() {
  const s = await jfetch(withScope('/api/summary')).then((r) => r.json());
  for (const k of ['day', 'week', 'month']) {
    document.getElementById(`sum-${k}`).textContent = euro.format(s[k].expense);
    document.getElementById(`sum-${k}-in`).textContent = euro.format(s[k].income);
    setBalance(`sum-${k}-bal`, s[k].balance);
  }
  $('#list-total').textContent = s.count
    ? `${s.count} movimenti · spese ${euro.format(s.total.expense)} · entrate ${euro.format(s.total.income)} · saldo ${euro.format(s.total.balance)}`
    : '';

  if (scope === 'all' && s.byScope) {
    const p = s.byScope.personal, h = s.byScope.home;
    $('#split-personal-month').textContent = euro.format(p.month.expense);
    $('#split-personal-total').textContent = euro.format(p.total.expense);
    $('#split-home-month').textContent = euro.format(h.month.expense);
    $('#split-home-total').textContent = euro.format(h.total.expense);
    $('#split-all-month').textContent = euro.format(p.month.expense + h.month.expense);
    $('#split-all-total').textContent = euro.format(p.total.expense + h.total.expense);
  }
}

/* ---------- Categorie e modello predittivo ---------- */

async function loadAnagrafiche() {
  const [cats, accs] = await Promise.all([
    jfetch('/api/categories?scope=all').then((r) => r.json()),
    jfetch('/api/accounts').then((r) => r.json()),
  ]);
  catCache = {
    personal: cats.filter((c) => c.scope === 'personal'),
    home: cats.filter((c) => c.scope === 'home'),
  };
  acctCache = accs;
  fillFormSelects();
}

function fillFormSelects() {
  const pv = catSelect.value, hv = catHomeSelect.value, av = accountSelect.value;
  catSelect.innerHTML = optList(catCache.personal.map((c) => c.name), pv, '— nessuna —');
  catHomeSelect.innerHTML = optList(catCache.home.map((c) => c.name), hv, null);
  accountSelect.innerHTML = optList(acctCache.map((a) => a.name), av, '— nessuno —');
}

async function loadModelNote() {
  const note = $('#model-note');
  if (scope !== 'personal') { note.hidden = true; return; }
  const m = await jfetch('/api/model').then((r) => r.json());
  if (m.trained) {
    const acc = m.accuracy != null ? ` · precisione stimata ${Math.round(m.accuracy * 100)}%` : '';
    note.textContent =
      `Modello predittivo attivo: ha imparato da ${m.samples} spese categorizzate su ${m.categories.length} categorie${acc}. La categoria viene suggerita mentre scrivi e migliora ogni mese.`;
  } else {
    note.textContent =
      `Modello predittivo in apprendimento: servono almeno 6 spese con categoria (finora ${m.samples}). Continua a categorizzare le spese e inizierà a suggerirle da solo.`;
  }
  note.hidden = false;
}

function currentDraft() {
  return {
    description: $('#description').value,
    date: $('#date').value,
    amount: $('#amount').value,
  };
}

async function runPrediction() {
  if (scope !== 'personal' || view !== 'movimenti') return;
  const draft = currentDraft();
  if (!draft.description.trim() && !draft.amount) return;

  let pred;
  try {
    pred = await jfetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).then((r) => r.json());
  } catch {
    return;
  }
  if (!pred || !pred.category) return;

  // Preseleziona la categoria prevista se esiste in anagrafica e l'utente
  // non ha ancora scelto manualmente.
  const opt = [...catSelect.options].find(
    (o) => o.value && o.value.toLowerCase() === pred.category.toLowerCase()
  );
  if (opt && (categoryAuto || !catSelect.value)) {
    catSelect.value = opt.value;
    categoryAuto = true;
  }
}

function schedulePrediction() {
  clearTimeout(predictTimer);
  predictTimer = setTimeout(runPrediction, 350);
}

catSelect.addEventListener('change', () => { categoryAuto = false; });
$('#description').addEventListener('input', schedulePrediction);
$('#amount').addEventListener('change', schedulePrediction);
$('#date').addEventListener('change', schedulePrediction);

/* ---------- Elenco movimenti ---------- */

function viewRow(e) {
  const sign = e.kind === 'income' ? '+ ' : '− ';
  const name = escapeHtml(e.description) || escapeHtml(e.category) || (e.kind === 'income' ? 'Entrata' : 'Spesa');
  const swKey = e.kind === 'income' ? 'income' : (e.category || e.description || 'x');
  const swBg = e.kind === 'income' ? 'var(--income)' : swatchColor(swKey);
  const initial = escapeHtml((e.category || e.description || (e.kind === 'income' ? 'E' : 'S')).charAt(0).toUpperCase());

  const meta = [];
  meta.push(escapeHtml(e.category) || 'Senza categoria');
  meta.push(fmtDate(e.spent_on));
  if (scope === 'all') meta.push(`<span class="pill ${e.scope}">${e.scope === 'home' ? 'Casa' : 'Personale'}</span>`);
  if (e.account) meta.push(`<span class="pill acct">${escapeHtml(e.account)}</span>`);

  return `
    <div class="tx" data-id="${e.id}" data-scope="${e.scope}">
      <span class="swatch" style="background:${swBg}">${initial}</span>
      <div class="meta">
        <div class="name">${name}</div>
        <div class="cat">${meta.join('<span aria-hidden="true">·</span>')}</div>
      </div>
      <span class="amount ${e.kind}">${sign}${euro.format(e.amount)}</span>
      <span class="row-actions">
        <button class="icon-btn edit" aria-label="Modifica">${ic.edit}</button>
        <button class="icon-btn del" aria-label="Elimina">${ic.trash}</button>
      </span>
    </div>`;
}

function editRow(e) {
  const catNames = (e.scope === 'home' ? catCache.home : catCache.personal).map((c) => c.name);
  const catField = `<label>Categoria<select data-f="category">${
    optList(catNames, e.category, e.scope === 'home' ? null : '— nessuna —')
  }</select></label>`;
  const acctField = `<label>Conto<select data-f="account">${
    optList(acctCache.map((a) => a.name), e.account, '— nessuno —')
  }</select></label>`;
  return `
    <div class="tx editing" data-id="${e.id}" data-scope="${e.scope}">
      <div class="tx-edit-grid">
        <label>Data<input type="date" data-f="date" value="${e.spent_on}"></label>
        <label>Tipo<select data-f="kind">
          <option value="expense"${e.kind === 'expense' ? ' selected' : ''}>Spesa</option>
          <option value="income"${e.kind === 'income' ? ' selected' : ''}>Entrata</option>
        </select></label>
        <label>Importo (€)<input type="number" step="0.01" min="0" data-f="amount" value="${e.amount}"></label>
        ${catField}
        ${acctField}
        <label style="grid-column:1/-1">Descrizione<input type="text" data-f="description" maxlength="500" value="${escapeAttr(e.description)}"></label>
      </div>
      <div class="tx-edit-actions">
        <button class="btn ghost cancel" type="button">Annulla</button>
        <button class="btn primary save" type="button">Salva</button>
      </div>
    </div>`;
}

function renderList() {
  if (!expenses.length) {
    rowsEl.innerHTML = '<div class="empty">Nessun movimento in questo ambito.</div>';
    return;
  }
  rowsEl.innerHTML = expenses
    .map((e) => (e.id === editingId ? editRow(e) : viewRow(e)))
    .join('');
}

async function loadExpenses() {
  expenses = await jfetch(withScope('/api/expenses')).then((r) => r.json());
  if (editingId && !expenses.some((e) => e.id === editingId)) editingId = null;
  renderList();
}

rowsEl.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const tr = btn.closest('.tx');
  const id = Number(tr.dataset.id);

  if (btn.classList.contains('edit')) {
    editingId = id;
    renderList();
    return;
  }
  if (btn.classList.contains('cancel')) {
    editingId = null;
    renderList();
    return;
  }
  if (btn.classList.contains('del')) {
    if (!confirm('Eliminare questo movimento?')) return;
    const res = await jfetch(`/api/expenses/${id}`, { method: 'DELETE' });
    if (res.ok) { toast("Movimento eliminato"); reloadView(); }
    else showError('Impossibile eliminare il movimento.');
    return;
  }
  if (btn.classList.contains('save')) {
    const val = (f) => {
      const el = tr.querySelector(`[data-f="${f}"]`);
      return el ? el.value : '';
    };
    const payload = {
      date: val('date'),
      kind: val('kind'),
      category: val('category'),
      amount: val('amount'),
      description: val('description'),
      scope: tr.dataset.scope || 'personal',
      account: val('account'),
    };
    const res = await jfetch(`/api/expenses/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error || 'Impossibile salvare le modifiche.');
      return;
    }
    toast('Movimento aggiornato');
    editingId = null;
    reloadView();
  }
});

/* ---------- Form nuovo movimento ---------- */

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();

  const payload = {
    date: $('#date').value,
    kind: document.querySelector('input[name="kind"]:checked').value,
    amount: $('#amount').value,
    description: $('#description').value,
    category: scope === 'home' ? catHomeSelect.value : catSelect.value,
    account: accountSelect.value,
    scope,
  };

  const res = await jfetch('/api/expenses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    showError(data.error || 'Impossibile salvare il movimento.');
    return;
  }

  $('#amount').value = '';
  $('#description').value = '';
  catSelect.value = '';
  categoryAuto = false;
  $('#amount').focus();
  toast('Movimento aggiunto');
  reloadView();
});

/* ---------- Grafici ---------- */

function barLineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } },
      tooltip: {
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${euro.format(ctx.parsed.y)}` },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 14 } },
      y: { beginAtZero: true, grid: { color: cssVar('--line') }, ticks: { callback: (v) => '€' + v } },
    },
  };
}

function chartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = cssVar('--ink-faint');
}

const doughnutOptions = (hasData) => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '58%',
  plugins: {
    legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } },
    tooltip: {
      enabled: hasData,
      callbacks: { label: (ctx) => `${ctx.label}: ${euro.format(ctx.parsed)}` },
    },
  },
});

async function loadDashboardCharts() {
  chartDefaults();
  const [daily, monthly] = await Promise.all([
    jfetch(withScope('/api/chart/daily?days=30')).then((r) => r.json()),
    jfetch(withScope('/api/chart/monthly?months=12')).then((r) => r.json()),
  ]);

  const expenseColor = cssVar('--expense');
  const incomeColor = cssVar('--income');
  const accentColor = cssVar('--brand');

  const dailyLabels = daily.map((d) => {
    const [, m, dd] = d.day.split('-');
    return `${dd}/${m}`;
  });

  dailyChart?.destroy();
  dailyChart = new Chart($('#chart-daily'), {
    type: 'bar',
    data: {
      labels: dailyLabels,
      datasets: [
        { label: 'Spese', data: daily.map((d) => d.expense), backgroundColor: expenseColor, borderRadius: 4 },
        { label: 'Entrate', data: daily.map((d) => d.income), backgroundColor: incomeColor, borderRadius: 4 },
      ],
    },
    options: barLineOptions(),
  });

  const monthlyLabels = monthly.map((d) => {
    const [y, m] = d.month.split('-');
    return new Date(+y, +m - 1, 1).toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
  });
  const balance = monthly.map((d) => +(d.income - d.expense).toFixed(2));

  monthlyChart?.destroy();
  monthlyChart = new Chart($('#chart-monthly'), {
    type: 'bar',
    data: {
      labels: monthlyLabels,
      datasets: [
        { label: 'Spese', data: monthly.map((d) => d.expense), backgroundColor: expenseColor, borderRadius: 4, order: 2 },
        { label: 'Entrate', data: monthly.map((d) => d.income), backgroundColor: incomeColor, borderRadius: 4, order: 2 },
        { label: 'Saldo', data: balance, type: 'line', borderColor: accentColor, backgroundColor: accentColor, borderWidth: 2, tension: 0.3, pointRadius: 3, order: 1 },
      ],
    },
    options: barLineOptions(),
  });
}

function loadCategoryChart(cats) {
  chartDefaults();
  const data = cats.filter((c) => (c.month_expense || 0) > 0);
  catChart?.destroy();
  catChart = new Chart($('#chart-categories'), {
    type: 'doughnut',
    data: {
      labels: data.length ? data.map((c) => c.name) : ['Nessuna spesa questo mese'],
      datasets: [{
        data: data.length ? data.map((c) => c.month_expense) : [1],
        backgroundColor: data.length ? data.map((c) => swatchColor(c.name)) : [cssVar('--line')],
        borderWidth: 0,
      }],
    },
    options: doughnutOptions(data.length > 0),
  });
}

async function loadAccountsChart() {
  chartDefaults();
  const accounts = await jfetch('/api/chart/accounts?scope=all').then((r) => r.json());
  acctChart?.destroy();
  acctChart = new Chart($('#chart-accounts'), {
    type: 'doughnut',
    data: {
      labels: accounts.length ? accounts.map((a) => a.account) : ['Nessuna spesa questo mese'],
      datasets: [{
        data: accounts.length ? accounts.map((a) => a.expense) : [1],
        backgroundColor: accounts.length ? accounts.map((a) => swatchColor(a.account)) : [cssVar('--line')],
        borderWidth: 0,
      }],
    },
    options: doughnutOptions(accounts.length > 0),
  });
}

/* ---------- Backup e ripristino ---------- */

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtDateTime = (d) =>
  new Date(d).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

async function loadBackups() {
  const data = await jfetch('/api/backups').then((r) => r.json());
  const status = $('#backup-status');
  if (data.last) {
    status.textContent = `Ultimo backup: ${fmtDateTime(data.last.mtime)} · ${data.last.rows ?? '?'} righe`;
  } else {
    status.textContent = 'Nessun backup ancora salvato';
  }

  const list = $('#backup-list');
  list.innerHTML = (data.files || [])
    .map(
      (f) => `<li>
        <a href="/api/backups/${encodeURIComponent(f.file)}">${f.file}</a>
        <span>${f.rows ?? '?'} righe · ${fmtBytes(f.size)} · ${fmtDateTime(f.mtime)}</span>
      </li>`
    )
    .join('');
}

function showBackupResult(msg, isError) {
  const el = $('#backup-result');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
}

$('#backup-run').addEventListener('click', async () => {
  showBackupResult('Salvataggio in corso…');
  const res = await jfetch('/api/backups/run', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    showBackupResult(`Backup salvato: ${data.file} (${data.count} righe).`);
    loadBackups();
  } else {
    showBackupResult(data.error || 'Backup non riuscito.', true);
  }
});

$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;

  const mode = $('#import-mode').value;
  const label =
    mode === 'replace'
      ? `Sostituire TUTTI i movimenti con il contenuto di "${file.name}"?`
      : `Importare "${file.name}" unendo ai movimenti esistenti?`;
  if (!confirm(label)) return;

  showBackupResult('Import in corso…');
  const text = await file.text();
  const res = await jfetch(`/api/import?mode=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: text,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showBackupResult(data.error || 'Import non riuscito.', true);
    return;
  }
  const bad = data.invalid && data.invalid.length ? ` · ${data.invalid.length} righe scartate` : '';
  showBackupResult(
    `Import (${data.mode}): ${data.inserted} inserite` +
      (data.skipped ? ` · ${data.skipped} duplicati saltati` : '') +
      bad + '.'
  );
  toast('Import completato');
});

/* ---------- Caricamento per vista ---------- */

async function loadDashboard() {
  await Promise.all([loadSummary(), loadDashboardCharts()]);
}

async function loadMovimenti() {
  await Promise.all([loadSummary(), loadExpenses(), loadAnagrafiche(), loadModelNote()]);
}

const rowActions = `
  <div class="row-actions">
    <button class="icon-btn r-edit" aria-label="Rinomina">${ic.edit}</button>
    <button class="icon-btn r-del" aria-label="Elimina">${ic.trash}</button>
  </div>`;

async function loadCategorieView() {
  const cats = await jfetch(withScope('/api/categories')).then((r) => r.json());
  const box = $('#cat-rows');
  box.innerHTML = cats.length
    ? cats.map((c) => `
      <div class="cat-row" data-id="${c.id}" data-name="${escapeAttr(c.name)}">
        <span class="dot" style="background:${swatchColor(c.name)}"></span>
        <div class="c-main">
          <div class="c-name">${escapeHtml(c.name)}${
            scope === 'all' ? ` <span class="pill ${c.scope}">${c.scope === 'home' ? 'Casa' : 'Pers.'}</span>` : ''
          }</div>
          <div class="c-count">${c.count} moviment${c.count === 1 ? 'o' : 'i'}</div>
        </div>
        <div class="c-amt"><b>${euro.format(c.month_expense)}</b><span>mese · ${euro.format(c.total_expense)} tot</span></div>
        ${rowActions}
      </div>`).join('')
    : '<div class="empty">Nessuna categoria in questo ambito. Creane una.</div>';
  loadCategoryChart(cats);
}

async function loadContiView() {
  const accs = await jfetch('/api/accounts').then((r) => r.json());
  acctCache = accs;
  const box = $('#acct-rows');
  box.innerHTML = accs.length
    ? accs.map((a) => `
      <div class="cat-row" data-id="${a.id}" data-name="${escapeAttr(a.name)}">
        <span class="dot" style="background:${swatchColor(a.name)}"></span>
        <div class="c-main">
          <div class="c-name">${escapeHtml(a.name)}</div>
          <div class="c-count">${a.count} moviment${a.count === 1 ? 'o' : 'i'}</div>
        </div>
        <div class="c-amt"><b>${euro.format(a.month_expense)}</b><span>mese · ${euro.format(a.total_expense)} tot</span></div>
        ${rowActions}
      </div>`).join('')
    : '<div class="empty">Nessun conto. Aggiungine uno.</div>';
  await loadAccountsChart();
}

async function loadBackupView() {
  await loadBackups();
}

/* ---------- Gestione categorie e conti ---------- */

async function apiSend(url, method, body) {
  const res = await jfetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Operazione non riuscita');
  return data;
}

$('#cat-add').addEventListener('click', async () => {
  const name = (prompt('Nome della nuova categoria:') || '').trim();
  if (!name) return;
  const sc = scope === 'home' ? 'home' : 'personal';
  try {
    await apiSend('/api/categories', 'POST', { name, scope: sc });
    toast('Categoria aggiunta');
    reloadView();
  } catch (e) { showError(e.message); }
});

$('#acct-add').addEventListener('click', async () => {
  const name = (prompt('Nome del nuovo conto:') || '').trim();
  if (!name) return;
  try {
    await apiSend('/api/accounts', 'POST', { name });
    toast('Conto aggiunto');
    reloadView();
  } catch (e) { showError(e.message); }
});

function bindManageRows(containerSel, base, labelSing) {
  $(containerSel).addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const row = btn.closest('.cat-row');
    const id = row.dataset.id;
    const cur = row.dataset.name;
    if (btn.classList.contains('r-edit')) {
      const name = (prompt(`Nuovo nome per "${cur}":`, cur) || '').trim();
      if (!name || name === cur) return;
      try { await apiSend(`${base}/${id}`, 'PUT', { name }); toast('Rinominato'); reloadView(); }
      catch (e) { showError(e.message); }
    } else if (btn.classList.contains('r-del')) {
      if (!confirm(`Eliminare ${labelSing} "${cur}"? I movimenti collegati restano, senza ${labelSing}.`)) return;
      try {
        const r = await apiSend(`${base}/${id}`, 'DELETE');
        toast(r.cleared ? `Eliminato · ${r.cleared} movimenti aggiornati` : 'Eliminato');
        reloadView();
      } catch (e) { showError(e.message); }
    }
  });
}
bindManageRows('#cat-rows', '/api/categories', 'la categoria');
bindManageRows('#acct-rows', '/api/accounts', 'il conto');

// "+ nuova / + nuovo" accanto ai campi del form
document.querySelectorAll('.mini-add').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.add; // 'category' | 'account'
    const name = (prompt(kind === 'category' ? 'Nome della nuova categoria:' : 'Nome del nuovo conto:') || '').trim();
    if (!name) return;
    try {
      if (kind === 'category') {
        const sc = scope === 'home' ? 'home' : 'personal';
        await apiSend('/api/categories', 'POST', { name, scope: sc });
      } else {
        await apiSend('/api/accounts', 'POST', { name });
      }
      await loadAnagrafiche();
      if (kind === 'category') {
        (scope === 'home' ? catHomeSelect : catSelect).value =
          scope === 'home' ? name.toUpperCase() : name;
      } else {
        accountSelect.value = name;
      }
      toast('Aggiunto');
    } catch (e) { showError(e.message); }
  });
});

/* ---------- Bootstrap ---------- */

$('#date').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD locale

// stato iniziale dello switch ambito
document.querySelectorAll('#scope-switch .tab').forEach((b) => {
  const on = b.dataset.scope === scope;
  b.classList.toggle('active', on);
  b.setAttribute('aria-selected', on ? 'true' : 'false');
});
applyScopeUI();
setView(view, { push: false });
