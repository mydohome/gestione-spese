# Gestione spese

Applicazione web per annotare spese ed entrate, con riepiloghi, grafici, categorie
e un modello predittivo che suggerisce la categoria delle spese personali.
Gira in Docker con un database PostgreSQL dedicato.

## Funzionalità

- **Due ambiti separati** con tab dedicati:
  - **Personali** — categoria a testo libero con autocompletamento e **categoria suggerita**
    da un modello predittivo (Naive Bayes) che si adatta mese dopo mese.
  - **Casa** — categoria a scelta fissa tra **UTENZE**, **CONDOMINIO**, **VARIE**.
- Spese ed **entrate** (es. stipendio), con saldo.
- Riepiloghi **oggi / settimana / mese** e totale complessivo, filtrati per ambito.
- Grafici: andamento ultimi 30 giorni, andamento mensile con saldo, torta categorie del mese.
- Record **modificabili inline** ed eliminabili.
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
