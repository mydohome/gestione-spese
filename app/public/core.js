/* core.js — helper condivisi, routing fra viste, stato ambito, configurazione grafici.
   Caricato per primo: definisce i simboli globali usati dagli altri file. */

/* ---------------- Formattazione ---------------- */

const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

const IT_MONTHS = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];

const ymNow = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
};

// 'YYYY-MM' spostato di `delta` mesi
const monthShift = (ym, delta) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1 + delta, 1).toLocaleDateString('sv-SE').slice(0, 7);
};

/* ---------------- DOM e rete ---------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
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

// Chiamata JSON con gestione errori uniforme; lancia Error(messaggio) sui 4xx/5xx
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

async function doLogout() {
  await jfetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}
$('#logout')?.addEventListener('click', doLogout);
$('#logout-m')?.addEventListener('click', doLogout);

/* ---------------- Testo ---------------- */

const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
const escapeAttr = (str) => String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');

const optList = (names, sel, emptyLabel) =>
  (emptyLabel != null ? `<option value="">${emptyLabel}</option>` : '') +
  names.map((n) =>
    `<option value="${escapeAttr(n)}"${n === sel ? ' selected' : ''}>${escapeHtml(n)}</option>`
  ).join('');

const CAT_COLORS = [
  '#5566ff', '#12b886', '#f08c00', '#e8546b', '#7c3aed', '#0ca678',
  '#e64980', '#4263eb', '#f76707', '#15aabf', '#ae3ec9', '#37b24d',
];
// Colore stabile per la "pastiglia" di un elemento, derivato dal testo
function swatchColor(str) {
  const s = String(str || '');
  if (!s) return 'var(--ink-faint)';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return CAT_COLORS[Math.abs(hash) % CAT_COLORS.length];
}

// Icone inline (stroke, 24x24)
const ic = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

function toast(msg, kind) {
  if (!msg) return;
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}
const showError = (msg) => toast(msg, 'error');

/* ---------------- Anagrafiche: notifica di aggiornamento ---------------- */

// I form che mostrano categorie/conti si registrano qui e vengono richiamati
// ogni volta che l'anagrafica cambia (vedi catalog.js).
const _catalogListeners = [];
const onCatalogChange = (fn) => _catalogListeners.push(fn);
const notifyCatalogChange = () => _catalogListeners.forEach((fn) => {
  try { fn(); } catch (err) { console.error(err); }
});

/* ---------------- Navigazione fra viste ---------------- */

const VIEWS = ['dashboard', 'movimenti', 'fisse', 'previsione', 'categorie', 'conti', 'backup'];
const VIEW_TITLE = {
  dashboard: 'Dashboard', movimenti: 'Movimenti', fisse: 'Spese fisse',
  previsione: 'Previsione', categorie: 'Categorie', conti: 'Conti', backup: 'Backup',
};
const VIEW_SUB = {
  dashboard: null, // dinamico: dipende dall'ambito
  movimenti: 'Personali e di casa',
  fisse: 'Addebiti automatici ogni mese',
  previsione: 'Budget e consuntivo annuale',
  categorie: null, // dinamico
  conti: 'Anagrafica conti correnti',
  backup: 'Copie CSV e ripristino',
};
// Viste con dati globali o con selettore ambito proprio: niente tab Personali/Casa/Totale
const NO_SCOPE_VIEWS = new Set(['fisse', 'previsione', 'conti', 'backup']);
const SCOPE_LABEL = { personal: 'personali', home: 'di casa', all: 'personali e di casa' };

const readHash = () => (location.hash.replace(/^#\/?/, '') || 'dashboard');
let view = VIEWS.includes(readHash()) ? readHash() : 'dashboard';

// Ambito del tab a 3 vie (Dashboard, Categorie)
let scope = localStorage.getItem('scope') || 'personal';
if (!['personal', 'home', 'all'].includes(scope)) scope = 'personal';

// Aggiunge ?scope= alle chiamate che dipendono dal tab attivo
const withScope = (url) => url + (url.includes('?') ? '&' : '?') + 'scope=' + scope;

// Ogni vista registra il proprio loader: registerView('nome', fn)
const VIEW_LOADERS = {};
const registerView = (name, loader) => { VIEW_LOADERS[name] = loader; };

function reloadView() {
  const fn = VIEW_LOADERS[view];
  if (fn) Promise.resolve(fn()).catch((e) => showError(e.message || 'Errore di caricamento'));
}

function pageSub() {
  if (view === 'dashboard') return `Spese ed entrate ${SCOPE_LABEL[scope]}`;
  if (view === 'categorie') return `Categorie ${SCOPE_LABEL[scope]}`;
  return VIEW_SUB[view] || '';
}

function setView(next, { push = true } = {}) {
  if (!VIEWS.includes(next)) next = 'dashboard';
  view = next;
  if (push && readHash() !== next) location.hash = `#/${next}`;

  $$('section[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
  $$('.nav-link[data-view], .tabbar button[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });

  // Nei Movimenti si usa lo switch Personale/Casa; altrove il tab a 3 vie dove ha senso
  const isMov = view === 'movimenti';
  $('#scope-switch').hidden = isMov || NO_SCOPE_VIEWS.has(view);
  $('#scope-toggle').hidden = !isMov;
  $('#page-title').textContent = VIEW_TITLE[view];
  $('#page-sub').textContent = pageSub();

  reloadView();
}

$$('.nav-link[data-view], .tabbar button[data-view]').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view));
});
window.addEventListener('hashchange', () => setView(readHash(), { push: false }));

/* ---------------- Tab a 3 vie: Personali / Casa / Totale ---------------- */

function syncScopeSwitch() {
  $$('#scope-switch .tab').forEach((b) => {
    const on = b.dataset.scope === scope;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

$$('#scope-switch .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.scope === scope) return;
    scope = btn.dataset.scope;
    localStorage.setItem('scope', scope);
    syncScopeSwitch();
    $('#page-sub').textContent = pageSub();
    reloadView();
  });
});

/* ---------------- Configurazione grafici (Chart.js) ---------------- */

function chartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = cssVar('--ink-faint');
}

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
