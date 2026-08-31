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
const catInput = $('#category');
const catSuggestBtn = $('#cat-suggest');
const catHomeSelect = $('#category-home');
const accountHomeSelect = $('#account-home');

const HOME_CATEGORIES = ['UTENZE', 'CONDOMINIO', 'VARIE'];
const HOME_ACCOUNTS = ['CONTO ANNA', 'CONTO MASSY'];

let expenses = [];
let editingId = null;
let dailyChart, monthlyChart, catChart, acctChart;
let predictTimer = null;
let categoryAuto = false; // true se la categoria e' stata compilata dal modello e non ancora toccata

const VIEWS = ['dashboard', 'movimenti', 'categorie', 'backup'];
const VIEW_TITLE = {
  dashboard: 'Dashboard', movimenti: 'Movimenti', categorie: 'Categorie', backup: 'Backup',
};
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

  // Lo switch ambito non ha senso nella sezione Backup (dati globali)
  $('#scope-switch').hidden = view === 'backup';
  $('#page-title').textContent = VIEW_TITLE[view];
  $('#page-sub').textContent = view === 'backup'
    ? 'Copie CSV e ripristino'
    : `Spese ed entrate ${SCOPE_LABEL[scope]}`;

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
  const home = scope === 'home';
  const all = scope === 'all';
  // Il tab "Totale" è di sola lettura: niente form di inserimento
  form.hidden = all;
  $('#cat-field-personal').hidden = !(scope === 'personal');
  $('#cat-field-home').hidden = !home;
  $('#conto-field-home').hidden = !home;
  $('#split-panel').hidden = !all;
  $('#card-accounts').hidden = !(home || all);
  if (scope !== 'personal') {
    hideSuggestion();
    $('#model-note').hidden = true;
  }
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
    $('#page-sub').textContent = `Spese ed entrate ${SCOPE_LABEL[scope]}`;
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

async function loadCategories() {
  // Il datalist serve solo alle spese personali (categoria libera):
  // le spese di casa hanno categorie fisse e non usano l'autocompletamento.
  const cats = await jfetch('/api/categories?scope=personal').then((r) => r.json());
  $('#cat-list').innerHTML = cats.map((c) => `<option value="${escapeAttr(c)}"></option>`).join('');
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

function hideSuggestion() {
  catSuggestBtn.hidden = true;
  catSuggestBtn.textContent = '';
}

async function runPrediction() {
  if (scope !== 'personal') return hideSuggestion();
  const draft = currentDraft();
  if (!draft.description.trim() && !draft.amount) return hideSuggestion();

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

  if (!pred || !pred.category) return hideSuggestion();

  const pct = Math.round((pred.confidence || 0) * 100);
  catSuggestBtn.textContent = `💡 ${pred.category} · ${pct}%`;
  catSuggestBtn.dataset.value = pred.category;
  catSuggestBtn.hidden = false;

  // Compila in automatico solo se il campo e' vuoto o era gia' un valore automatico
  if (!catInput.value.trim() || categoryAuto) {
    catInput.value = pred.category;
    categoryAuto = true;
  }
}

function schedulePrediction() {
  clearTimeout(predictTimer);
  predictTimer = setTimeout(runPrediction, 350);
}

catSuggestBtn.addEventListener('click', () => {
  if (catSuggestBtn.dataset.value) {
    catInput.value = catSuggestBtn.dataset.value;
    categoryAuto = false;
    catInput.focus();
  }
});
catInput.addEventListener('input', () => { categoryAuto = false; });
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
  const catField = e.scope === 'home'
    ? `<label>Categoria<select data-f="category">${HOME_CATEGORIES
        .map((c) => `<option value="${c}"${e.category === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
       <label>Conto<select data-f="account">${HOME_ACCOUNTS
        .map((a) => `<option value="${a}"${e.account === a ? ' selected' : ''}>${a}</option>`).join('')}</select></label>`
    : `<label>Categoria<input type="text" data-f="category" list="cat-list" maxlength="60" value="${escapeAttr(e.category)}"></label>`;
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
    category: scope === 'home' ? catHomeSelect.value : catInput.value,
    account: scope === 'home' ? accountHomeSelect.value : '',
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
  catInput.value = '';
  categoryAuto = false;
  hideSuggestion();
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

async function loadCategoryCharts(categories, accounts) {
  chartDefaults();
  catChart?.destroy();
  catChart = new Chart($('#chart-categories'), {
    type: 'doughnut',
    data: {
      labels: categories.length ? categories.map((c) => c.category) : ['Nessuna spesa questo mese'],
      datasets: [{
        data: categories.length ? categories.map((c) => c.month_expense || c.expense || 0) : [1],
        backgroundColor: categories.length
          ? categories.map((c) => swatchColor(c.category))
          : [cssVar('--line')],
        borderWidth: 0,
      }],
    },
    options: doughnutOptions(categories.length > 0),
  });

  acctChart?.destroy();
  acctChart = null;
  const wantAccounts = scope === 'home' || scope === 'all';
  if (wantAccounts) {
    const acctColors = { 'CONTO ANNA': '#e64980', 'CONTO MASSY': '#4263eb' };
    acctChart = new Chart($('#chart-accounts'), {
      type: 'doughnut',
      data: {
        labels: accounts.length ? accounts.map((a) => a.account) : ['Nessuna spesa di casa questo mese'],
        datasets: [{
          data: accounts.length ? accounts.map((a) => a.expense) : [1],
          backgroundColor: accounts.length
            ? accounts.map((a, i) => acctColors[a.account] || CAT_COLORS[i % CAT_COLORS.length])
            : [cssVar('--line')],
          borderWidth: 0,
        }],
      },
      options: doughnutOptions(accounts.length > 0),
    });
  }
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
  await Promise.all([loadSummary(), loadExpenses(), loadCategories(), loadModelNote()]);
}

async function loadCategorieView() {
  const wantAccounts = scope === 'home' || scope === 'all';
  const [cats, accounts] = await Promise.all([
    jfetch(withScope('/api/categories/summary')).then((r) => r.json()),
    wantAccounts ? jfetch('/api/chart/accounts').then((r) => r.json()) : Promise.resolve([]),
  ]);

  const box = $('#cat-rows');
  const expenseCats = cats.filter((c) => c.total_expense > 0 || c.month_expense > 0);
  if (!expenseCats.length) {
    box.innerHTML = '<div class="empty">Nessuna spesa categorizzata in questo ambito.</div>';
  } else {
    box.innerHTML = expenseCats.map((c) => `
      <div class="cat-row">
        <span class="dot" style="background:${swatchColor(c.category)}"></span>
        <div>
          <div class="c-name">${escapeHtml(c.category)}</div>
          <div class="c-count">${c.count} moviment${c.count === 1 ? 'o' : 'i'}</div>
        </div>
        <div class="c-amt">
          <b>${euro.format(c.month_expense)}</b>
          <span>mese · ${euro.format(c.total_expense)} totale</span>
        </div>
      </div>`).join('');
  }

  // per le doughnut riuso il formato con month_expense
  await loadCategoryCharts(
    expenseCats.map((c) => ({ category: c.category, month_expense: c.month_expense })),
    accounts,
  );
}

async function loadBackupView() {
  await loadBackups();
}

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
