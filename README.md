# Gestione spese

Applicazione web per annotare spese ed entrate, con riepiloghi, grafici, categorie
e un modello predittivo che suggerisce la categoria delle spese personali.
Gira in Docker con un database PostgreSQL dedicato.

## Funzionalità

- **Navigazione a sezioni** — menu laterale su desktop, barra in basso su smartphone:
  - **Dashboard** — riepiloghi oggi/settimana/mese, andamento 30 giorni e mensile
  - **Movimenti** — inserimento e elenco movimenti (righe con "pastiglia" colorata, modifica inline)
  - **Categorie** — **gestione categorie** (crea / rinomina / elimina) per ambito + torta e riepilogo
  - **Conti** — **anagrafica conti correnti** (crea / rinomina / elimina) + spese per conto
  - **Backup** — export/import CSV e copie di sicurezza
- **Switch ambito** (Personali / Casa / Totale) su Dashboard, Movimenti e Categorie:
  - **Personali** — categoria dall'elenco gestito, con **categoria suggerita** da un
    modello predittivo (Naive Bayes) che si adatta mese dopo mese.
  - **Casa** — categoria obbligatoria dall'elenco gestito (seed: UTENZE / CONDOMINIO / VARIE).
  - **Totale** — sola lettura: spese personali + casa insieme, con confronto (mese e complessivo).
- **Conto** facoltativo, associabile a qualsiasi spesa (personale o di casa).
- Spese ed **entrate** (es. stipendio), con saldo.
- Record **modificabili inline** ed eliminabili. Rinominare una categoria/conto
  aggiorna i movimenti collegati; eliminarla lascia i movimenti senza categoria/conto.
- **Autenticazione** a sessione (cookie firmato), con protezione anti-brute-force.
- **Backup CSV** automatico settimanale (lunedì 03:00, ultime 12 copie) + **import/ripristino** da CSV.

## Stack

- Node.js 22 + Express + EJS
- PostgreSQL 17
- Chart.js (servito localmente, nessuna CDN)
- Docker Compose

## Avvio

Requisiti: Docker e Docker Compose.

```bash
git clone <url-del-repo>
cd webserver
cp .env.example .env
# modifica .env impostando password e SESSION_SECRET
docker compose up -d
```

L'app resta in ascolto su **http://localhost:3005** (mappata sulla porta 3000 del container).
Metterla dietro un reverse proxy (es. Nginx Proxy Manager) per l'accesso esterno;
in quel caso, se il proxy termina HTTPS, impostare `COOKIE_SECURE=true` in `.env`.

## Struttura

```
.
├── docker-compose.yml      # servizi app + db
├── .env.example            # modello di configurazione (copiare in .env)
├── app/
│   ├── Dockerfile
│   ├── server.js           # API Express, rotte, schema DB (migrazioni all'avvio)
│   ├── classifier.js       # modello predittivo delle categorie
│   ├── backup.js           # export CSV settimanale + retention
│   ├── csv.js              # serializzazione/parsing CSV (RFC 4180)
│   ├── import.js
│   ├── auth.js             # login, hashing password (scrypt), rate limit
│   ├── views/              # index.ejs, login.ejs
│   └── public/             # style.css, app.js, vendor/chart.umd.min.js
├── db/                     # dati PostgreSQL — NON versionato
└── backups/                # CSV con dati reali — NON versionato
```

## Note

- Lo schema del database viene creato e migrato automaticamente all'avvio dell'app
  (`initDb` in `server.js`): non servono migrazioni manuali.
- `.env`, `db/` e `backups/` sono esclusi dal versionamento (segreti e dati personali).
