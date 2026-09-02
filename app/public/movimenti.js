/* movimenti.js — inserimento movimento, switch Personale/Casa, elenco con
   modifica inline, categoria suggerita dal modello. */

const form = $('#form');
const rowsEl = $('#tx-list');
const catSelect = $('#category');          // categoria spese personali
const catHomeSelect = $('#category-home'); // categoria spese di casa
const accountSelect = $('#account');       // conto (facoltativo)

let expenses = [];
let editingId = null;
let categoryAuto = false; // categoria compilata dal modello e non ancora toccata
let predictTimer = null;

// Ambito del movimento in inserimento; indipendente dal tab della Dashboard
let formScope = localStorage.getItem('formScope') || 'personal';
if (!['personal', 'home'].includes(formScope)) formScope = 'personal';

function fillMovimentiSelects() {
  const pv = catSelect.value, hv = catHomeSelect.value, av = accountSelect.value;
  catSelect.innerHTML = optList(catCache.personal.map((c) => c.name), pv, '— nessuna —');
  catHomeSelect.innerHTML = optList(catCache.home.map((c) => c.name), hv, null);
  accountSelect.innerHTML = optList(acctCache.map((a) => a.name), av, '— nessuno —');
}
onCatalogChange(fillMovimentiSelects);

/* ---------------- Switch Personale / Casa ---------------- */

function applyFormScopeUI() {
  $('#cat-field-personal').hidden = formScope !== 'personal';
  $('#cat-field-home').hidden = formScope !== 'home';
  $$('#scope-toggle .tab').forEach((b) => b.classList.toggle('active', b.dataset.fscope === formScope));
  if (formScope !== 'personal') $('#model-note').hidden = true;
}

function setFormScope(next) {
  if (!['personal', 'home'].includes(next) || next === formScope) return;
  formScope = next;
  localStorage.setItem('formScope', formScope);
  categoryAuto = false;
  applyFormScopeUI();
  loadModelNote().catch(() => {});
  runPrediction();
}
$$('#scope-toggle .tab').forEach((b) => b.addEventListener('click', () => setFormScope(b.dataset.fscope)));

/* ---------------- Modello predittivo ---------------- */

async function loadModelNote() {
  const note = $('#model-note');
  if (view !== 'movimenti' || formScope !== 'personal') { note.hidden = true; return; }
  const m = await jfetch('/api/model').then((r) => r.json());
  note.textContent = m.trained
    ? `Modello predittivo attivo: ha imparato da ${m.samples} spese categorizzate su ${m.categories.length} categorie` +
      (m.accuracy != null ? ` · precisione stimata ${Math.round(m.accuracy * 100)}%` : '') +
      '. La categoria viene suggerita mentre scrivi e migliora ogni mese.'
    : `Modello predittivo in apprendimento: servono almeno 6 spese con categoria (finora ${m.samples}). ` +
      'Continua a categorizzare le spese e inizierà a suggerirle da solo.';
  note.hidden = false;
}

async function runPrediction() {
  if (formScope !== 'personal' || view !== 'movimenti') return;
  const draft = {
    description: $('#description').value,
    date: $('#date').value,
    amount: $('#amount').value,
  };
  if (!draft.description.trim() && !draft.amount) return;

  let pred;
  try {
    pred = await jfetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    }).then((r) => r.json());
  } catch { return; }
  if (!pred || !pred.category) return;

  const opt = [...catSelect.options].find(
    (o) => o.value && o.value.toLowerCase() === pred.category.toLowerCase()
  );
  if (opt && (categoryAuto || !catSelect.value)) {
    catSelect.value = opt.value;
    categoryAuto = true;
  }
}

const schedulePrediction = () => {
  clearTimeout(predictTimer);
  predictTimer = setTimeout(runPrediction, 350);
};

catSelect.addEventListener('change', () => { categoryAuto = false; });
$('#description').addEventListener('input', schedulePrediction);
$('#amount').addEventListener('change', schedulePrediction);
$('#date').addEventListener('change', schedulePrediction);

/* ---------------- Elenco movimenti ---------------- */

function viewRow(e) {
  const sign = e.kind === 'income' ? '+ ' : '− ';
  const name = escapeHtml(e.description) || escapeHtml(e.category) || (e.kind === 'income' ? 'Entrata' : 'Spesa');
  const swKey = e.kind === 'income' ? 'income' : (e.category || e.description || 'x');
  const swBg = e.kind === 'income' ? 'var(--income)' : swatchColor(swKey);
  const initial = escapeHtml((e.category || e.description || (e.kind === 'income' ? 'E' : 'S')).charAt(0).toUpperCase());

  const meta = [
    escapeHtml(e.category) || 'Senza categoria',
    fmtDate(e.spent_on),
    `<span class="pill ${e.scope}">${e.scope === 'home' ? 'Casa' : 'Personale'}</span>`,
  ];
  if (e.account) meta.push(`<span class="pill acct">${escapeHtml(e.account)}</span>`);
  if (e.recurring_id) meta.push('<span class="pill recur">↻ fissa</span>');

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
  return `
    <div class="tx editing" data-id="${e.id}" data-scope="${e.scope}">
      <div class="tx-edit-grid">
        <label>Data<input type="date" data-f="date" value="${e.spent_on}"></label>
        <label>Tipo<select data-f="kind">
          <option value="expense"${e.kind === 'expense' ? ' selected' : ''}>Spesa</option>
          <option value="income"${e.kind === 'income' ? ' selected' : ''}>Entrata</option>
        </select></label>
        <label>Importo (€)<input type="number" step="0.01" min="0" data-f="amount" value="${e.amount}"></label>
        <label>Categoria<select data-f="category">${
          optList(catNames, e.category, e.scope === 'home' ? null : '— nessuna —')
        }</select></label>
        <label>Conto<select data-f="account">${
          optList(acctCache.map((a) => a.name), e.account, '— nessuno —')
        }</select></label>
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
    rowsEl.innerHTML = '<div class="empty">Nessun movimento registrato.</div>';
    $('#list-total').textContent = '';
    return;
  }
  rowsEl.innerHTML = expenses.map((e) => (e.id === editingId ? editRow(e) : viewRow(e))).join('');

  const t = expenses.reduce((a, e) => {
    a[e.kind === 'income' ? 'income' : 'expense'] += e.amount;
    return a;
  }, { expense: 0, income: 0 });
  $('#list-total').textContent =
    `${expenses.length} movimenti · spese ${euro.format(t.expense)} · entrate ${euro.format(t.income)} · saldo ${euro.format(t.income - t.expense)}`;
}

async function loadExpenses() {
  // La lista Movimenti mostra sempre tutto (personali + casa)
  expenses = await jfetch('/api/expenses?scope=all').then((r) => r.json());
  if (editingId && !expenses.some((e) => e.id === editingId)) editingId = null;
  renderList();
}

rowsEl.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const tr = btn.closest('.tx');
  const id = Number(tr.dataset.id);

  if (btn.classList.contains('edit')) { editingId = id; renderList(); return; }
  if (btn.classList.contains('cancel')) { editingId = null; renderList(); return; }

  if (btn.classList.contains('del')) {
    if (!confirm('Eliminare questo movimento?')) return;
    const res = await jfetch(`/api/expenses/${id}`, { method: 'DELETE' });
    if (res.ok) { toast('Movimento eliminato'); reloadView(); }
    else showError('Impossibile eliminare il movimento.');
    return;
  }

  if (btn.classList.contains('save')) {
    const val = (f) => tr.querySelector(`[data-f="${f}"]`)?.value ?? '';
    const payload = {
      date: val('date'), kind: val('kind'), category: val('category'),
      amount: val('amount'), description: val('description'),
      scope: tr.dataset.scope || 'personal', account: val('account'),
    };
    try {
      await apiSend(`/api/expenses/${id}`, 'PUT', payload);
      toast('Movimento aggiornato');
      editingId = null;
      reloadView();
    } catch (e) { showError(e.message || 'Impossibile salvare le modifiche.'); }
  }
});

/* ---------------- Nuovo movimento ---------------- */

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = {
    date: $('#date').value,
    kind: document.querySelector('input[name="kind"]:checked').value,
    amount: $('#amount').value,
    description: $('#description').value,
    category: formScope === 'home' ? catHomeSelect.value : catSelect.value,
    account: accountSelect.value,
    scope: formScope,
  };
  try {
    await apiSend('/api/expenses', 'POST', payload);
  } catch (e) { showError(e.message || 'Impossibile salvare il movimento.'); return; }

  $('#amount').value = '';
  $('#description').value = '';
  catSelect.value = '';
  categoryAuto = false;
  $('#amount').focus();
  toast('Movimento aggiunto');
  reloadView();
});

// "+ nuova / + nuovo" accanto ai campi
form.querySelectorAll('.mini-add').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const norm = await quickAddCatalog(btn.dataset.add, formScope);
      if (!norm) return;
      if (btn.dataset.add === 'category') (formScope === 'home' ? catHomeSelect : catSelect).value = norm;
      else accountSelect.value = norm;
      toast('Aggiunto');
    } catch (e) { showError(e.message); }
  });
});

async function loadMovimenti() {
  editingId = null;
  applyFormScopeUI();
  await Promise.all([loadExpenses(), loadCatalog(), loadModelNote()]);
}

registerView('movimenti', loadMovimenti);
