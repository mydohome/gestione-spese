/* previsione.js — previsione spese annuali: inserimento voci di budget (mensili
   o annuali), riepilogo con proiezione annua, ripartizione per categoria e
   confronto col consuntivo reale dell'anno. */

const fcForm = $('#fc-form');
$('#fc-month').innerHTML = IT_MONTHS.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');

let fcYear = new Date().getFullYear();
let fcFreq = 'monthly';
let fcEditingId = null;
let fcCache = [];
let fcChart = null;

/* ---------------- Form ---------------- */

function fillForecastCats() {
  const names = [...new Set([
    ...catCache.personal.map((c) => c.name),
    ...catCache.home.map((c) => c.name),
  ])].sort((a, b) => a.localeCompare(b, 'it'));
  $('#fc-cat-list').innerHTML = names.map((n) => `<option value="${escapeAttr(n)}">`).join('');
}
onCatalogChange(fillForecastCats);

function applyForecastFreqUI() {
  $('#fc-month-field').hidden = fcFreq !== 'annual';
  $$('#fc-freq .tab').forEach((b) => b.classList.toggle('active', b.dataset.freq === fcFreq));
}
$$('#fc-freq .tab').forEach((b) =>
  b.addEventListener('click', () => { fcFreq = b.dataset.freq; applyForecastFreqUI(); }));

function fcResetForm() {
  fcEditingId = null;
  fcForm.reset();
  $('#fc-kind-expense').checked = true;
  fcFreq = 'monthly';
  applyForecastFreqUI();
  $('#fc-submit-label').textContent = 'Aggiungi voce';
  $('#fc-cancel').hidden = true;
}

function startFcEdit(id) {
  const it = fcCache.find((x) => x.id === id);
  if (!it) return;
  fcEditingId = id;
  $(it.kind === 'income' ? '#fc-kind-income' : '#fc-kind-expense').checked = true;
  $('#fc-label').value = it.label;
  $('#fc-category').value = it.category;
  $('#fc-amount').value = it.amount;
  $('#fc-note').value = it.note;
  fcFreq = it.frequency;
  $('#fc-month').value = it.month || 1;
  applyForecastFreqUI();
  $('#fc-submit-label').textContent = 'Salva modifiche';
  $('#fc-cancel').hidden = false;
  fcForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#fc-cancel').addEventListener('click', fcResetForm);

fcForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = {
    year: fcYear,
    label: $('#fc-label').value,
    category: $('#fc-category').value,
    kind: document.querySelector('input[name="fc-kind"]:checked').value,
    amount: $('#fc-amount').value,
    frequency: fcFreq,
    month: fcFreq === 'annual' ? $('#fc-month').value : null,
    note: $('#fc-note').value,
  };
  try {
    if (fcEditingId) {
      await apiSend(`/api/forecast/${fcEditingId}`, 'PUT', payload);
      toast('Voce aggiornata');
    } else {
      await apiSend('/api/forecast', 'POST', payload);
      toast('Voce aggiunta');
    }
    fcResetForm();
    reloadView();
  } catch (e) { showError(e.message); }
});

/* ---------------- Selettore anno ---------------- */

function syncFcYear(years) {
  $('#fc-year').textContent = fcYear;
  const prev = fcYear - 1;
  const copyBtn = $('#fc-copy');
  copyBtn.hidden = !(years || []).includes(prev);
  copyBtn.textContent = `Copia da ${prev}`;
  $('#fc-next').disabled = fcYear >= new Date().getFullYear() + 2;
}

$$('#fc-yearnav .period__nav').forEach((b) =>
  b.addEventListener('click', () => { fcYear += Number(b.dataset.step); fcResetForm(); reloadView(); }));

$('#fc-copy').addEventListener('click', async () => {
  const from = fcYear - 1;
  if (!confirm(`Copiare tutte le voci di previsione dal ${from} al ${fcYear}?`)) return;
  try {
    const r = await apiSend('/api/forecast/copy', 'POST', { from, to: fcYear });
    toast(r.copied ? `${r.copied} voci copiate` : 'Nessuna voce da copiare');
    reloadView();
  } catch (e) { showError(e.message); }
});

/* ---------------- Proiezione ---------------- */

function project(items) {
  const months = Array.from({ length: 12 }, () => ({ expense: 0, income: 0 }));
  const byCat = new Map();
  const annual = { expense: 0, income: 0 };

  for (const it of items) {
    const occurrences = it.frequency === 'monthly' ? 12 : 1;
    const yearAmount = it.amount * occurrences;
    annual[it.kind] += yearAmount;

    if (it.frequency === 'monthly') {
      for (const m of months) m[it.kind] += it.amount;
    } else {
      months[(it.month || 1) - 1][it.kind] += it.amount;
    }

    if (it.kind === 'expense') {
      const key = it.category || 'Senza categoria';
      byCat.set(key, (byCat.get(key) || 0) + yearAmount);
    }
  }
  const categories = [...byCat.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  return { months, annual, categories };
}

/* ---------------- Render ---------------- */

function fcItemRow(it) {
  const sign = it.kind === 'income' ? '+ ' : '− ';
  const when = it.frequency === 'monthly'
    ? 'ogni mese'
    : `una volta · ${IT_MONTHS[(it.month || 1) - 1].toLowerCase()}`;
  const meta = [];
  if (it.category) meta.push(`<span class="pill" style="background:${swatchColor(it.category)}22;color:${swatchColor(it.category)}">${escapeHtml(it.category)}</span>`);
  meta.push(when);
  if (it.note) meta.push(escapeHtml(it.note));
  return `
    <div class="tx fc-row" data-id="${it.id}">
      <span class="swatch" style="background:${it.kind === 'income' ? 'var(--income)' : swatchColor(it.category || it.label)}">
        ${escapeHtml((it.label || '?').charAt(0).toUpperCase())}
      </span>
      <div class="meta">
        <div class="name">${escapeHtml(it.label) || '(senza nome)'}</div>
        <div class="cat">${meta.join('<span aria-hidden="true">·</span>')}</div>
      </div>
      <span class="amount ${it.kind}">
        ${sign}${euro.format(it.amount)}
        <span class="fc-freq">${it.frequency === 'monthly' ? `${euro.format(it.amount * 12)}/anno` : 'una tantum'}</span>
      </span>
      <span class="row-actions">
        <button class="icon-btn fc-edit" aria-label="Modifica">${ic.edit}</button>
        <button class="icon-btn fc-del" aria-label="Elimina">${ic.trash}</button>
      </span>
    </div>`;
}

function renderForecastSummary(proj, actual) {
  const bal = proj.annual.income - proj.annual.expense;
  statCard('fc-card-exp', { label: `Spese previste · ${fcYear}`, value: proj.annual.expense, tone: 'expense', sub: `media ${euro.format(proj.annual.expense / 12)} / mese` });
  statCard('fc-card-inc', { label: `Entrate previste · ${fcYear}`, value: proj.annual.income, tone: 'income', sub: proj.annual.income ? `media ${euro.format(proj.annual.income / 12)} / mese` : '' });
  statCard('fc-card-bal', { label: `Saldo previsto · ${fcYear}`, value: bal, tone: bal >= 0 ? 'income' : 'expense', sub: '' });

  // Consuntivo reale
  const realExp = actual.reduce((a, m) => a + m.expense, 0);
  const realInc = actual.reduce((a, m) => a + m.income, 0);
  const pct = proj.annual.expense > 0 ? Math.round((realExp / proj.annual.expense) * 100) : 0;
  $('#fc-consuntivo').innerHTML = `
    <div class="fc-progress">
      <div class="fc-progress__head">
        <span>Speso finora nel ${fcYear}</span>
        <span><b>${euro.format(realExp)}</b> su ${euro.format(proj.annual.expense)} previsti · ${pct}%</span>
      </div>
      <div class="fc-bar"><div class="fc-bar__fill ${pct > 100 ? 'over' : ''}" style="width:${Math.min(100, pct)}%"></div></div>
      ${proj.annual.income || realInc ? `
      <div class="fc-progress__head">
        <span>Entrate incassate</span>
        <span><b>${euro.format(realInc)}</b> su ${euro.format(proj.annual.income)} previste</span>
      </div>` : ''}
    </div>`;

  // Ripartizione per categoria
  const max = proj.categories[0]?.value || 1;
  $('#fc-catlist').innerHTML = proj.categories.length
    ? proj.categories.map((c) => `
      <div class="fc-catrow">
        <div class="fc-catrow__head"><span>${escapeHtml(c.name)}</span><span>${euro.format(c.value)}</span></div>
        <div class="fc-bar"><div class="fc-bar__fill" style="width:${(c.value / max) * 100}%;background:${swatchColor(c.name)}"></div></div>
      </div>`).join('')
    : '<div class="empty">Nessuna spesa prevista.</div>';
}

function renderForecastChart(proj, actual) {
  chartDefaults();
  const actualByMonth = Array.from({ length: 12 }, (_, i) => {
    const row = actual.find((a) => a.month === i + 1);
    return row ? row.expense : 0;
  });
  fcChart?.destroy();
  fcChart = new Chart($('#fc-chart'), {
    type: 'bar',
    data: {
      labels: IT_MONTHS.map((n) => n.slice(0, 3)),
      datasets: [
        { label: 'Previsto', data: proj.months.map((m) => m.expense), backgroundColor: cssVar('--brand'), borderRadius: 4 },
        { label: 'Reale', data: actualByMonth, backgroundColor: cssVar('--expense'), borderRadius: 4 },
      ],
    },
    options: barLineOptions(),
  });
}

async function loadPrevisioneView() {
  await loadCatalog();
  fillForecastCats();
  applyForecastFreqUI();

  const data = await jfetch(`/api/forecast?year=${fcYear}`).then((r) => r.json());
  fcCache = data.items;
  syncFcYear(data.years);

  const proj = project(fcCache);
  renderForecastSummary(proj, data.actual);
  renderForecastChart(proj, data.actual);

  $('#fc-rows').innerHTML = fcCache.length
    ? fcCache.map(fcItemRow).join('')
    : '<div class="empty">Nessuna voce per il ' + fcYear + '. Aggiungine una qui sopra.</div>';
}

$('#fc-rows').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const id = Number(btn.closest('.fc-row').dataset.id);
  if (btn.classList.contains('fc-edit')) { startFcEdit(id); return; }
  if (btn.classList.contains('fc-del')) {
    if (!confirm('Eliminare questa voce di previsione?')) return;
    try {
      await apiSend(`/api/forecast/${id}`, 'DELETE');
      toast('Voce eliminata');
      if (fcEditingId === id) fcResetForm();
      reloadView();
    } catch (e) { showError(e.message); }
  }
});

registerView('previsione', loadPrevisioneView);
