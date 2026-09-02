# Gestione spese

Applicazione web per annotare spese ed entrate, con riepiloghi, grafici, categorie
e un modello predittivo che suggerisce la categoria delle spese personali.
Gira in Docker con un database PostgreSQL dedicato.

## Funzionalità

- **Navigazione a sezioni** — menu laterale su desktop, barra in basso su smartphone:
  - **Dashboard** — card *Oggi* / *Questa settimana* / *mese selezionato*, andamento
    giornaliero e mensile. Il **filtro mese/anno** in cima cambia solo la card del mese
    e i grafici: i totali di oggi e della settimana restano sempre sul periodo reale.
  - **Movimenti** — inserimento e elenco (righe con "pastiglia" colorata, modifica inline).
    Uno **switch Personale / Casa a due colori** (indaco / ambra) decide l'ambito del
    movimento in inserimento; la lista mostra sempre tutto.
  - **Spese fisse** — regole ricorrenti (mutuo, finanziamenti, addebiti, stipendio…):
    ogni mese, a inizio mese, generano il movimento datato al giorno indicato, finché
    non le disattivi. I movimenti già generati restano.
  - **Previsione** — budget annuale: voci di spesa/entrata *mensili* o *annuali*, con
    proiezione sull'anno, ripartizione per categoria e **confronto col consuntivo reale**.
    Selettore anno e copia da un anno all'altro.
  - **Categorie** — gestione categorie (crea / rinomina / elimina) per ambito + torta e riepilogo.
  - **Conti** — anagrafica conti correnti (crea / rinomina / elimina) + spese per conto.
  - **Backup** — export/import CSV e copie di sicurezza.
- **Switch ambito** (Personali / Casa / Totale) su Dashboard e Categorie:
  - **Personali** — categoria dall'elenco gestito, con **categoria suggerita** da un
    modello predittivo (Naive Bayes) che si adatta mese dopo mese.
  - **Casa** — categoria obbligatoria dall'elenco gestito (seed: UTENZE / CONDOMINIO / VARIE).
  - **Totale** — sola lettura: spese personali + casa insieme, con confronto (mese e complessivo).
- **Conto** facoltativo, associabile a qualsiasi spesa (personale o di casa).
- Spese ed **entrate** (es. stipendio), con saldo.
- Record **modificabili inline** ed eliminabili. Rinominare una categoria/conto
  aggiorna i movimenti e le spese fisse collegate; eliminarla li lascia senza categoria/conto.
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
│   └── public/             # front-end (nessun bundler: <script> classici in ordine)
│       ├── style.css
│       ├── core.js         # helper, routing fra viste, stato ambito, config grafici
│       ├── catalog.js      # anagrafica categorie/conti + viste di gestione
│       ├── movimenti.js    # form movimento, switch Personale/Casa, elenco
│       ├── dashboard.js    # riepilogo, selettore mese/anno, grafici
│       ├── fisse.js        # spese fisse ricorrenti
│       ├── previsione.js   # previsione spese annuali
│       ├── backup.js       # copie CSV e import
│       ├── app.js          # bootstrap (caricato per ultimo)
│       └── vendor/chart.umd.min.js
├── db/                     # dati PostgreSQL — NON versionato
└── backups/                # CSV con dati reali — NON versionato
```

I moduli front-end condividono lo scope globale (niente `import`/`export`): `core.js`
espone gli helper e il router, ogni vista si registra con `registerView(nome, fn)` e i
form che mostrano categorie/conti si agganciano a `onCatalogChange(fn)`. `app.js` va
caricato per ultimo.

## Note

- Lo schema del database viene creato e migrato automaticamente all'avvio dell'app
  (`initDb` in `server.js`): non servono migrazioni manuali. Tabelle: `expenses`,
  `categories`, `accounts`, `recurring` (spese fisse), `forecast` (previsione annuale).
- La generazione delle spese fisse gira all'avvio e ogni giorno alle 00:05 (Europe/Rome),
  oltre che subito dopo aver creato o riattivato una regola.
- Il backup CSV salva i **movimenti** (`expenses`). Le regole delle spese fisse e le
  voci di previsione non sono nel CSV: le prime rigenerano i movimenti da sole, i secondi
  sono un piano, non un dato storico.
- `.env`, `db/` e `backups/` sono esclusi dal versionamento (segreti e dati personali).
