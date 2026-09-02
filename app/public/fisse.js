/* fisse.js — spese fisse ricorrenti: form (con switch Personale/Casa), elenco
   con attiva/disattiva, modifica inline nel form. */

const recForm = $('#rec-form');
const recCat = $('#rec-category');
const recCatHome = $('#rec-category-home');
const recAccount = $('#rec-account');
let recFormScope = 'personal';
let recEditingId = null;
let recCache = [];

function fillRecSelects() {
  const pv = recCat.value, hv = recCatHome.value, av = recAccount.value;
  recCat.innerHTML = optList(catCache.personal.map((c) => c.name), pv, '— nessuna —');
  recCatHome.innerHTML = optList(catCache.home.map((c) => c.name), hv, null);
  recAccount.innerHTML = optList(acctCache.map((a) => a.name), av, '— nessuno —');
}
onCatalogChange(fillRecSelects);

function applyRecScopeUI() {
  $('#rec-cat-personal').hidden = recFormScope !== 'personal';
  $('#rec-cat-home').hidden = recFormScope !== 'home';
  $$('#rec-scope-toggle .tab').forEach((b) => b.classList.toggle('active', b.dataset.fscope === recFormScope));
}
$$('#rec-scope-toggle .tab').forEach((b) =>
  b.addEventListener('click', () => { recFormScope = b.dataset.fscope; applyRecScopeUI(); }));

function recResetForm() {
  recEditingId = null;
  recForm.reset();
  $('#rec-kind-expense').checked = true;
  $('#rec-day').value = 1;
  recFormScope = 'personal';
  applyRecScopeUI();
  fillRecSelects();
  $('#rec-submit-label').textContent = 'Aggiungi spesa fissa';
  $('#rec-cancel').hidden = true;
}

function startRecEdit(id) {
  const r = recCache.find((x) => x.id === id);
  if (!r) return;
  recEditingId = id;
  $(r.kind === 'income' ? '#rec-kind-income' : '#rec-kind-expense').checked = true;
  recFormScope = r.scope;
  applyRecScopeUI();
  fillRecSelects();
  $('#rec-amount').value = r.amount;
  $('#rec-day').value = r.day_of_month;
  $('#rec-description').value = r.description;
  (r.scope === 'home' ? recCatHome : recCat).value = r.category || '';
  recAccount.value = r.account || '';
  $('#rec-submit-label').textContent = 'Salva modifiche';
  $('#rec-cancel').hidden = false;
  recForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#rec-cancel').addEventListener('click', recResetForm);

recForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = {
    description: $('#rec-description').value,
    amount: $('#rec-amount').value,
    kind: document.querySelector('input[name="rec-kind"]:checked').value,
    scope: recFormScope,
    category: recFormScope === 'home' ? recCatHome.value : recCat.value,
    account: recAccount.value,
    day_of_month: $('#rec-day').value,
    active: true,
  };
  try {
    if (recEditingId) {
      const cur = recCache.find((x) => x.id === recEditingId);
      payload.active = cur ? cur.active : true;
      await apiSend(`/api/recurring/${recEditingId}`, 'PUT', payload);
      toast('Spesa fissa aggiornata');
    } else {
      await apiSend('/api/recurring', 'POST', payload);
      toast('Spesa fissa aggiunta');
    }
    recResetForm();
    reloadView();
  } catch (e) { showError(e.message); }
});

recForm.querySelectorAll('.mini-add').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const norm = await quickAddCatalog(btn.dataset.add, recFormScope);
      if (!norm) return;
      if (btn.dataset.add === 'category') (recFormScope === 'home' ? recCatHome : recCat).value = norm;
      else recAccount.value = norm;
      toast('Aggiunto');
    } catch (e) { showError(e.message); }
  });
});

function recRow(r) {
  const sign = r.kind === 'income' ? '+ ' : '− ';
  const name = escapeHtml(r.description) || escapeHtml(r.category) || (r.kind === 'income' ? 'Entrata' : 'Spesa');
  const meta = [
    `<span class="pill ${r.scope}">${r.scope === 'home' ? 'Casa' : 'Personale'}</span>`,
    escapeHtml(r.category) || 'senza categoria',
  ];
  if (r.account) meta.push(`<span class="pill acct">${escapeHtml(r.account)}</span>`);
  meta.push(`giorno ${r.day_of_month}`);
  return `
    <div class="tx rec-row${r.active ? '' : ' is-off'}" data-id="${r.id}">
      <label class="switch" title="${r.active ? 'Attiva' : 'Disattivata'}">
        <input type="checkbox" class="rec-toggle"${r.active ? ' checked' : ''}>
        <span class="switch__track"></span>
      </label>
      <div class="meta">
        <div class="name">${name}</div>
        <div class="cat">${meta.join('<span aria-hidden="true">·</span>')}</div>
      </div>
      <span class="amount ${r.kind}">${sign}${euro.format(r.amount)}</span>
      <span class="row-actions">
        <button class="icon-btn rec-edit" aria-label="Modifica">${ic.edit}</button>
        <button class="icon-btn rec-del" aria-label="Elimina">${ic.trash}</button>
      </span>
    </div>`;
}

async function loadFisseView() {
  await loadCatalog();
  applyRecScopeUI();
  recCache = await jfetch('/api/recurring').then((r) => r.json());
  $('#rec-rows').innerHTML = recCache.length
    ? recCache.map(recRow).join('')
    : '<div class="empty">Nessuna spesa fissa. Aggiungine una qui sopra.</div>';

  const active = recCache.filter((r) => r.active);
  const perMonth = (k) => active.filter((r) => r.kind === k).reduce((a, r) => a + r.amount, 0);
  const exp = perMonth('expense');
  const inc = perMonth('income');
  $('#rec-total').textContent = recCache.length
    ? `${active.length} attive · ${euro.format(exp)}/mese di spese` +
      (inc ? ` · ${euro.format(inc)}/mese di entrate` : '')
    : '';
}

$('#rec-rows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const id = Number(btn.closest('.rec-row').dataset.id);
  if (btn.classList.contains('rec-edit')) { startRecEdit(id); return; }
  if (btn.classList.contains('rec-del')) {
    if (!confirm('Eliminare questa spesa fissa? I movimenti già registrati restano.')) return;
    try {
      await apiSend(`/api/recurring/${id}`, 'DELETE');
      toast('Spesa fissa eliminata');
      if (recEditingId === id) recResetForm();
      reloadView();
    } catch (e) { showError(e.message); }
  }
});

$('#rec-rows').addEventListener('change', async (ev) => {
  const cb = ev.target.closest('.rec-toggle');
  if (!cb) return;
  const id = Number(cb.closest('.rec-row').dataset.id);
  try {
    const r = await apiSend(`/api/recurring/${id}/toggle`, 'POST');
    toast(r.active ? 'Spesa fissa attivata' : 'Spesa fissa disattivata');
    reloadView();
  } catch (e) { showError(e.message); cb.checked = !cb.checked; }
});

registerView('fisse', loadFisseView);
