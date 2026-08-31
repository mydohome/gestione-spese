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

document.getElementById('logout').addEventListener('click', async () => {
  await jfetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
const escapeAttr = (str) => String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');

const CAT_COLORS = [
  '#6c5ce7', '#00b894', '#0984e3', '#e17055', '#fdcb6e', '#e84393',
  '#00cec9', '#a29bfe', '#fab1a0', '#55efc4', '#74b9ff', '#ff7675',
];

const form = $('#form');
const errorEl = $('#error');
const rowsEl = $('#rows');
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
let scope = 'personal';   // ambito attivo: 'personal' | 'home' | 'all'

// Aggiunge ?scope= alle chiamate che dipendono dal tab attivo
const withScope = (url) => url + (url.includes('?') ? '&' : '?') + 'scope=' + scope;

/* ---------- Tab Personali / Casa ---------- */

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

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.scope === scope) return;
    scope = btn.dataset.scope;
    document.querySelectorAll('.tab').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    editingId = null;
    showError('');
    applyScopeUI();
    refresh();
  });
});

function showError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}

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
  const sign = e.kind === 'income' ? '+' : '−';
  const label = e.kind === 'income' ? 'Entrata' : 'Spesa';
  const scopeChip = scope === 'all'
    ? `<span class="scope-chip ${e.scope}">${e.scope === 'home' ? 'Casa' : 'Pers.'}</span> `
    : '';
  const cat = e.category
    ? `<span class="cat-tag">${escapeHtml(e.category)}</span>`
    : '<span class="date">—</span>';
  const acct = e.account
    ? `<span class="acct-tag">${escapeHtml(e.account)}</span>`
    : '';
  return `
    <tr data-id="${e.id}">
      <td class="date">${fmtDate(e.spent_on)}</td>
      <td>${scopeChip}<span class="badge ${e.kind}">${label}</span></td>
      <td>${cat}${acct}</td>
      <td>${escapeHtml(e.description) || '<span class="date">—</span>'}</td>
      <td class="num amount ${e.kind}">${sign} ${euro.format(e.amount)}</td>
      <td class="num">
        <div class="actions">
          <button class="icon-btn edit" title="Modifica" aria-label="Modifica">&#9998;</button>
          <button class="icon-btn del" title="Elimina" aria-label="Elimina">&#10005;</button>
        </div>
      </td>
    </tr>`;
}

function editRow(e) {
  const catField = e.scope === 'home'
    ? `<select class="edit-input" data-f="category">${HOME_CATEGORIES
        .map((c) => `<option value="${c}"${e.category === c ? ' selected' : ''}>${c}</option>`)
        .join('')}</select>
       <select class="edit-input edit-input--stack" data-f="account">${HOME_ACCOUNTS
        .map((a) => `<option value="${a}"${e.account === a ? ' selected' : ''}>${a}</option>`)
        .join('')}</select>`
    : `<input type="text" class="edit-input" data-f="category" list="cat-list" maxlength="60" value="${escapeAttr(e.category)}">`;
  return `
    <tr data-id="${e.id}" data-scope="${e.scope}" class="editing">
      <td><input type="date" class="edit-input" data-f="date" value="${e.spent_on}"></td>
      <td>
        <select class="edit-input" data-f="kind">
          <option value="expense"${e.kind === 'expense' ? ' selected' : ''}>Spesa</option>
          <option value="income"${e.kind === 'income' ? ' selected' : ''}>Entrata</option>
        </select>
      </td>
      <td>${catField}</td>
      <td><input type="text" class="edit-input" data-f="description" maxlength="500" value="${escapeAttr(e.description)}"></td>
      <td class="num"><input type="number" step="0.01" min="0" class="edit-input amount-input" data-f="amount" value="${e.amount}"></td>
      <td class="num">
        <div class="actions">
          <button class="icon-btn save" title="Salva" aria-label="Salva">&#10003;</button>
          <button class="icon-btn cancel" title="Annulla" aria-label="Annulla">&#10005;</button>
        </div>
      </td>
    </tr>`;
}

function renderList() {
  if (!expenses.length) {
    rowsEl.innerHTML =
      '<tr class="empty"><td colspan="6">Nessun movimento registrato. Aggiungine uno qui sopra.</td></tr>';
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
  const tr = btn.closest('tr');
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
    if (res.ok) refresh();
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
    showError('');
    editingId = null;
    refresh();
  }
});

/* ---------- Form nuovo movimento ---------- */

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('');

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
  refresh();
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
      y: { beginAtZero: true, grid: { color: cssVar('--border') }, ticks: { callback: (v) => '€' + v } },
    },
  };
}

async function loadCharts() {
  const wantAccounts = scope === 'home' || scope === 'all';
  const [daily, monthly, categories, accounts] = await Promise.all([
    jfetch(withScope('/api/chart/daily?days=30')).then((r) => r.json()),
    jfetch(withScope('/api/chart/monthly?months=12')).then((r) => r.json()),
    jfetch(withScope('/api/chart/categories')).then((r) => r.json()),
    wantAccounts ? jfetch('/api/chart/accounts').then((r) => r.json()) : Promise.resolve([]),
  ]);

  const expenseColor = cssVar('--expense');
  const incomeColor = cssVar('--income');
  const accentColor = cssVar('--accent');

  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = cssVar('--muted');

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

  catChart?.destroy();
  catChart = new Chart($('#chart-categories'), {
    type: 'doughnut',
    data: {
      labels: categories.length ? categories.map((c) => c.category) : ['Nessuna spesa questo mese'],
      datasets: [{
        data: categories.length ? categories.map((c) => c.expense) : [1],
        backgroundColor: categories.length
          ? categories.map((_, i) => CAT_COLORS[i % CAT_COLORS.length])
          : [cssVar('--border')],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: {
          enabled: categories.length > 0,
          callbacks: { label: (ctx) => `${ctx.label}: ${euro.format(ctx.parsed)}` },
        },
      },
    },
  });

  acctChart?.destroy();
  acctChart = null;
  if (wantAccounts) {
    const acctColors = { 'CONTO ANNA': '#e84393', 'CONTO MASSY': '#0984e3' };
    acctChart = new Chart($('#chart-accounts'), {
      type: 'doughnut',
      data: {
        labels: accounts.length ? accounts.map((a) => a.account) : ['Nessuna spesa di casa questo mese'],
        datasets: [{
          data: accounts.length ? accounts.map((a) => a.expense) : [1],
          backgroundColor: accounts.length
            ? accounts.map((a, i) => acctColors[a.account] || CAT_COLORS[i % CAT_COLORS.length])
            : [cssVar('--border')],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } },
          tooltip: {
            enabled: accounts.length > 0,
            callbacks: { label: (ctx) => `${ctx.label}: ${euro.format(ctx.parsed)}` },
          },
        },
      },
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
  refresh();
});

/* ---------- Bootstrap ---------- */

async function refresh() {
  await Promise.all([
    loadSummary(),
    loadExpenses(),
    loadCharts(),
    loadCategories(),
    loadModelNote(),
    loadBackups(),
  ]);
}

$('#date').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD locale
applyScopeUI();
refresh();
