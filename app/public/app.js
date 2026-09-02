/* app.js — avvio: stato iniziale dei controlli e prima vista.
   Caricato per ultimo, quando tutti i moduli hanno registrato viste e listener. */

$('#date').value = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD locale

syncScopeSwitch();
applyFormScopeUI();
applyRecScopeUI();
applyForecastFreqUI();
buildPeriodOptions();

setView(view, { push: false });
