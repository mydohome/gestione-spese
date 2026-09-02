/* backup.js — copie CSV, download e import/ripristino. */

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtDateTime = (d) =>
  new Date(d).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

async function loadBackups() {
  const data = await jfetch('/api/backups').then((r) => r.json());
  $('#backup-status').textContent = data.last
    ? `Ultimo backup: ${fmtDateTime(data.last.mtime)} · ${data.last.rows ?? '?'} righe`
    : 'Nessun backup ancora salvato';

  $('#backup-list').innerHTML = (data.files || []).map((f) => `
    <li>
      <a href="/api/backups/${encodeURIComponent(f.file)}">${f.file}</a>
      <span>${f.rows ?? '?'} righe · ${fmtBytes(f.size)} · ${fmtDateTime(f.mtime)}</span>
    </li>`).join('');
}

function showBackupResult(msg, isError) {
  const el = $('#backup-result');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
}

$('#backup-run').addEventListener('click', async () => {
  showBackupResult('Salvataggio in corso…');
  try {
    const data = await apiSend('/api/backups/run', 'POST');
    showBackupResult(`Backup salvato: ${data.file} (${data.count} righe).`);
    loadBackups();
  } catch (e) { showBackupResult(e.message || 'Backup non riuscito.', true); }
});

$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;

  const mode = $('#import-mode').value;
  const label = mode === 'replace'
    ? `Sostituire TUTTI i movimenti con il contenuto di "${file.name}"?`
    : `Importare "${file.name}" unendo ai movimenti esistenti?`;
  if (!confirm(label)) return;

  showBackupResult('Import in corso…');
  const res = await jfetch(`/api/import?mode=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: await file.text(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showBackupResult(data.error || 'Import non riuscito.', true); return; }

  const bad = data.invalid?.length ? ` · ${data.invalid.length} righe scartate` : '';
  showBackupResult(
    `Import (${data.mode}): ${data.inserted} inserite` +
    (data.skipped ? ` · ${data.skipped} duplicati saltati` : '') + bad + '.'
  );
  toast('Import completato');
});

registerView('backup', loadBackups);
