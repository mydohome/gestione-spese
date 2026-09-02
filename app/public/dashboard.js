/* dashboard.js — riepilogo con card Oggi / Settimana / Mese selezionato,
   selettore mese-anno (filtra solo la card del mese e i grafici) e grafici. */

let dailyChart, monthlyChart;
let dashYm = ymNow();       // 'YYYY-MM' mostrato dai grafici e dalla card "mese"
let dashFirstDate = null;   // data del primo movimento, per il range degli anni

const balClass = (v) => (v >= 0 ? 'pos' : 'neg');

function statCard(id, { label, value, tone, sub }) {
  const c = document.getElementById(id);
  c.querySelector('.label').textContent = label;
  c.querySelector('.value').textContent = euro.format(value);
  c.classList.remove('expense', 'income');
  if (tone) c.classList.add(tone);
  c.querySelector('.sub').innerHTML = sub || '';
}

function renderDashCards(s) {
  const balSub = (p) =>
    `entrate <b>${euro.format(p.income)}</b> · saldo <b class="bal ${balClass(p.balance)}">${euro.format(p.balance)}</b>`;

  // Giornaliero e settimanale restano sempre sul periodo reale
  statCard('card-a', { label: 'Oggi', value: s.day.expense, tone: 'expense', sub: balSub(s.day) });
  statCard('card-b', { label: 'Questa settimana', value: s.week.expense, tone: 'expense', sub: balSub(s.week) });
  // La terza card segue il mese scelto nel filtro
  const atCurrent = dashYm === ymNow();
  statCard('card-c', {
    label: atCurrent ? 'Questo mese' : monthLabel(dashYm),
    value: s.month.expense, tone: 'expense', sub: balSub(s.month),
  });
}

async function loadSummary() {
  const month = dashYm === ymNow() ? null : dashYm;
  const q = new URLSearchParams({ scope });
  if (month) q.set('month', month);
  const s = await jfetch('/api/summary?' + q).then((r) => r.json());
  if (s.firstDate) dashFirstDate = s.firstDate;

  renderDashCards(s);

  $('#split-panel').hidden = scope !== 'all';
  if (scope === 'all' && s.byScope) {
    const { personal: p, home: h } = s.byScope;
    $('#split-personal-month').textContent = euro.format(p.month.expense);
    $('#split-personal-total').textContent = euro.format(p.total.expense);
    $('#split-home-month').textContent = euro.format(h.month.expense);
    $('#split-home-total').textContent = euro.format(h.total.expense);
    $('#split-all-month').textContent = euro.format(p.month.expense + h.month.expense);
    $('#split-all-total').textContent = euro.format(p.total.expense + h.total.expense);
  }
}

async function loadDashboardCharts() {
  chartDefaults();
  const month = dashYm === ymNow() ? null : dashYm;
  const dailyUrl = month ? `/api/chart/daily?month=${month}` : '/api/chart/daily?days=30';
  const monthlyUrl = `/api/chart/monthly?months=12${month ? `&month=${month}` : ''}`;
  const [daily, monthly] = await Promise.all([
    jfetch(withScope(dailyUrl)).then((r) => r.json()),
    jfetch(withScope(monthlyUrl)).then((r) => r.json()),
  ]);

  $('#chart-daily-title').textContent = month ? `Giorno per giorno · ${monthLabel(month)}` : 'Ultimi 30 giorni';
  $('#chart-monthly-title').textContent = month ? `12 mesi fino a ${monthLabel(month)}` : 'Andamento mensile';

  const expenseColor = cssVar('--expense');
  const incomeColor = cssVar('--income');
  const accentColor = cssVar('--brand');

  dailyChart?.destroy();
  dailyChart = new Chart($('#chart-daily'), {
    type: 'bar',
    data: {
      labels: daily.map((d) => { const [, m, dd] = d.day.split('-'); return `${dd}/${m}`; }),
      datasets: [
        { label: 'Spese', data: daily.map((d) => d.expense), backgroundColor: expenseColor, borderRadius: 4 },
        { label: 'Entrate', data: daily.map((d) => d.income), backgroundColor: incomeColor, borderRadius: 4 },
      ],
    },
    options: barLineOptions(),
  });

  const balance = monthly.map((d) => +(d.income - d.expense).toFixed(2));
  monthlyChart?.destroy();
  monthlyChart = new Chart($('#chart-monthly'), {
    type: 'bar',
    data: {
      labels: monthly.map((d) => {
        const [y, m] = d.month.split('-');
        return new Date(+y, +m - 1, 1).toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
      }),
      datasets: [
        { label: 'Spese', data: monthly.map((d) => d.expense), backgroundColor: expenseColor, borderRadius: 4, order: 2 },
        { label: 'Entrate', data: monthly.map((d) => d.income), backgroundColor: incomeColor, borderRadius: 4, order: 2 },
        { label: 'Saldo', data: balance, type: 'line', borderColor: accentColor, backgroundColor: accentColor, borderWidth: 2, tension: 0.3, pointRadius: 3, order: 1 },
      ],
    },
    options: barLineOptions(),
  });
}

/* ---------------- Selettore mese / anno ---------------- */

function buildPeriodOptions() {
  $('#period-month').innerHTML = IT_MONTHS
    .map((n, i) => `<option value="${String(i + 1).padStart(2, '0')}">${n}</option>`).join('');

  const nowY = new Date().getFullYear();
  let startY = dashFirstDate ? +dashFirstDate.slice(0, 4) : nowY;
  if (!Number.isFinite(startY) || startY > nowY) startY = nowY;
  if (nowY - startY > 15) startY = nowY - 15;
  const years = new Set([+dashYm.slice(0, 4)]);
  for (let y = startY; y <= nowY; y++) years.add(y);
  $('#period-year').innerHTML = [...years].sort((a, b) => b - a)
    .map((y) => `<option value="${y}">${y}</option>`).join('');

  syncPeriodInputs();
}

function syncPeriodInputs() {
  $('#period-month').value = dashYm.slice(5, 7);
  $('#period-year').value = dashYm.slice(0, 4);
  const atCurrent = dashYm === ymNow();
  $('#period-today').hidden = atCurrent;
  $('#dash-period .period__nav[data-step="1"]').disabled = atCurrent;
}

function setDashYm(ym) {
  if (ym > ymNow()) ym = ymNow();
  if (ym === dashYm) return;
  dashYm = ym;
  buildPeriodOptions();
  if (view === 'dashboard') loadDashboard();
}

const periodFromSelects = () => `${$('#period-year').value}-${$('#period-month').value}`;
$('#period-month').addEventListener('change', () => setDashYm(periodFromSelects()));
$('#period-year').addEventListener('change', () => setDashYm(periodFromSelects()));
$('#period-today').addEventListener('click', () => setDashYm(ymNow()));
$$('#dash-period .period__nav').forEach((b) =>
  b.addEventListener('click', () => setDashYm(monthShift(dashYm, Number(b.dataset.step)))));

async function loadDashboard() {
  await Promise.all([loadSummary(), loadDashboardCharts()]);
  buildPeriodOptions(); // il range anni si allarga quando arriva la data del primo movimento
}

registerView('dashboard', loadDashboard);
