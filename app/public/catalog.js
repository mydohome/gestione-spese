/* catalog.js — anagrafica categorie e conti: cache condivisa, viste di gestione,
   grafici a torta di categorie/conti. */

let catCache = { personal: [], home: [] }; // [{id, name, count, month_expense, total_expense}]
let acctCache = [];                        // [{id, name, count, ...}]

// Carica categorie + conti, aggiorna la cache e notifica i form che li usano
async function loadCatalog() {
  const [cats, accs] = await Promise.all([
    jfetch('/api/categories?scope=all').then((r) => r.json()),
    jfetch('/api/accounts').then((r) => r.json()),
  ]);
  catCache = {
    personal: cats.filter((c) => c.scope === 'personal'),
    home: cats.filter((c) => c.scope === 'home'),
  };
  acctCache = accs;
  notifyCatalogChange();
}

// Crea al volo una categoria/conto (usato dai pulsanti "+ nuova/+ nuovo" nei form).
// Ritorna il nome normalizzato oppure null se annullato.
async function quickAddCatalog(kind, scopeName) {
  const name = (prompt(kind === 'category' ? 'Nome della nuova categoria:' : 'Nome del nuovo conto:') || '').trim();
  if (!name) return null;
  if (kind === 'category') await apiSend('/api/categories', 'POST', { name, scope: scopeName });
  else await apiSend('/api/accounts', 'POST', { name });
  await loadCatalog();
  return kind === 'category' && scopeName === 'home' ? name.toUpperCase() : name;
}

/* ---------------- Viste di gestione ---------------- */

const catRowActions = `
  <div class="row-actions">
    <button class="icon-btn r-edit" aria-label="Rinomina">${ic.edit}</button>
    <button class="icon-btn r-del" aria-label="Elimina">${ic.trash}</button>
  </div>`;

function manageRow(entry, extra) {
  return `
    <div class="cat-row" data-id="${entry.id}" data-name="${escapeAttr(entry.name)}">
      <span class="dot" style="background:${swatchColor(entry.name)}"></span>
      <div class="c-main">
        <div class="c-name">${escapeHtml(entry.name)}${extra || ''}</div>
        <div class="c-count">${entry.count} moviment${entry.count === 1 ? 'o' : 'i'}</div>
      </div>
      <div class="c-amt">
        <b>${euro.format(entry.month_expense)}</b>
        <span>mese · ${euro.format(entry.total_expense)} tot</span>
      </div>
      ${catRowActions}
    </div>`;
}

async function loadCategorieView() {
  const cats = await jfetch(withScope('/api/categories')).then((r) => r.json());
  $('#cat-rows').innerHTML = cats.length
    ? cats.map((c) => manageRow(c,
        scope === 'all' ? ` <span class="pill ${c.scope}">${c.scope === 'home' ? 'Casa' : 'Pers.'}</span>` : ''
      )).join('')
    : '<div class="empty">Nessuna categoria in questo ambito. Creane una.</div>';
  drawShareChart('#chart-categories', cats.map((c) => ({ name: c.name, value: c.month_expense })));
}

async function loadContiView() {
  const accs = await jfetch('/api/accounts').then((r) => r.json());
  acctCache = accs;
  $('#acct-rows').innerHTML = accs.length
    ? accs.map((a) => manageRow(a)).join('')
    : '<div class="empty">Nessun conto. Aggiungine uno.</div>';
  const share = await jfetch('/api/chart/accounts?scope=all').then((r) => r.json());
  drawShareChart('#chart-accounts', share.map((a) => ({ name: a.account, value: a.expense })));
}

// Grafico a ciambella riutilizzabile per categorie/conti
const _shareCharts = {};
function drawShareChart(sel, rows) {
  chartDefaults();
  const data = rows.filter((r) => (r.value || 0) > 0);
  _shareCharts[sel]?.destroy();
  _shareCharts[sel] = new Chart($(sel), {
    type: 'doughnut',
    data: {
      labels: data.length ? data.map((r) => r.name) : ['Nessuna spesa questo mese'],
      datasets: [{
        data: data.length ? data.map((r) => r.value) : [1],
        backgroundColor: data.length ? data.map((r) => swatchColor(r.name)) : [cssVar('--line')],
        borderWidth: 0,
      }],
    },
    options: doughnutOptions(data.length > 0),
  });
}

/* ---------------- Azioni di gestione ---------------- */

$('#cat-add').addEventListener('click', async () => {
  try {
    if (await quickAddCatalog('category', scope === 'home' ? 'home' : 'personal')) {
      toast('Categoria aggiunta');
      reloadView();
    }
  } catch (e) { showError(e.message); }
});

$('#acct-add').addEventListener('click', async () => {
  try {
    if (await quickAddCatalog('account')) { toast('Conto aggiunto'); reloadView(); }
  } catch (e) { showError(e.message); }
});

function bindManageRows(containerSel, base, labelSing) {
  $(containerSel).addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const row = btn.closest('.cat-row');
    const { id, name: cur } = row.dataset;
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

registerView('categorie', loadCategorieView);
registerView('conti', loadContiView);
