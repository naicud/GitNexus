# GitNexus TUI — Interfaccia Terminale Interattiva

La TUI (Terminal User Interface) di GitNexus offre wizard guidati, tabelle formattate, barre di progresso multi-fase e prompt interattivi direttamente nel terminale. Si attiva automaticamente quando i comandi vengono eseguiti in un terminale TTY senza flag espliciti.

---

## Installazione

### Da npm (consigliato)

```bash
npm install -g gitnexus
```

### Da sorgente locale

```bash
cd gitnexus/
npm install
npm run build
npm install -g .
```

### Verifica installazione

```bash
gitnexus --version   # Deve mostrare la versione (es. 1.4.0)
gitnexus --help      # Mostra tutti i comandi disponibili
```

### Requisiti

- **Node.js** >= 18
- **Git** — il repository da analizzare deve essere un repo git
- **Terminale TTY** — la TUI richiede un terminale interattivo (non funziona in pipe o CI)

### Dipendenze TUI

La TUI utilizza internamente:

| Libreria | Versione | Uso |
|----------|----------|-----|
| `@clack/prompts` | 1.1.0 | Prompt interattivi (select, confirm, text, password) |
| `cli-progress` | 3.12.0 | Barre di progresso multi-fase |
| `picocolors` | 1.1.1 | Colorazione output (non richiede configurazione) |

Tutte le dipendenze sono incluse nel pacchetto — nessuna installazione aggiuntiva necessaria.

---

## Quando si attiva la TUI

La TUI si attiva **automaticamente** quando:

1. Lo stdout è un terminale TTY
2. Non si è in ambiente CI (`CI` non è `true` o `1`)
3. Non sono stati passati flag espliciti (es. `--force`, `--db`, ecc.)
4. Non è stato passato `--yes` / `-y`
5. Non ci sono variabili d'ambiente di configurazione (`GITNEXUS_DB_TYPE`, `GITNEXUS_NEPTUNE_ENDPOINT`, ecc.)

### Disattivare la TUI

Per saltare i prompt interattivi e usare i valori predefiniti:

```bash
gitnexus analyze --yes          # Salta la TUI, usa i default
gitnexus analyze --force        # Qualsiasi flag esplicito disattiva la TUI
gitnexus analyze --db kuzu      # Flag esplicito → niente wizard
GITNEXUS_DB_TYPE=kuzu gitnexus analyze   # Variabile d'ambiente → niente wizard
```

---

## Comandi e wizard interattivi

### `gitnexus setup` — Configurazione iniziale

Configura automaticamente MCP per i tuoi editor. Da eseguire una sola volta.

```bash
gitnexus setup
```

**Flusso interattivo:**

1. Rileva gli editor installati (Cursor, Claude Code, OpenCode)
2. Mostra quelli trovati (con segno di spunta verde) e quelli non trovati
3. Chiede per quali editor configurare MCP (selezione multipla con checkbox)
4. Chiede conferma prima di scrivere i file di configurazione
5. Scrive la configurazione MCP per ogni editor selezionato

**Esempio output:**

```
◇  GitNexus Setup

  Detected editors:
    ✓ Cursor       ~/.cursor/mcp.json
    ✓ Claude Code  ~/.claude/mcp.json
    · OpenCode     (not found)

◆  Configure MCP for:
│  ◻ Cursor
│  ◻ Claude Code
└
```

**Modalità non interattiva:**

```bash
gitnexus setup --yes    # Configura tutti gli editor rilevati automaticamente
```

---

### `gitnexus analyze [path]` — Indicizzazione repository

Indicizza un repository costruendo il knowledge graph completo.

```bash
gitnexus analyze              # Indicizza il repo corrente (con wizard)
gitnexus analyze /path/repo   # Indicizza un percorso specifico
```

**Flusso del wizard interattivo:**

1. Conferma il percorso del repository
2. Scelta del database backend:
   - **KuzuDB** (locale, zero-config) — predefinito
   - **AWS Neptune** (cloud)
3. Se Neptune: endpoint, regione AWS, porta HTTP
4. Abilitazione embeddings per ricerca semantica (predefinito: no)
5. Se embeddings: provider (Local/Ollama/OpenAI/Cohere), modello, dimensioni, chiave API
6. Se il repo è già indicizzato: conferma re-indicizzazione forzata
7. Abilitazione log verbosi (predefinito: no)
8. Riepilogo configurazione in una box formattata
9. Conferma finale prima di avviare

**Esempio riepilogo configurazione:**

```
┌─ Configuration ────────────────────────┐
│ Repository     my-project              │
│ Path           /home/user/my-project   │
│ Database       KuzuDB (local)          │
│ Embeddings     off                     │
│ Force          no                      │
│ Verbose        no                      │
└────────────────────────────────────────┘
```

**Barra di progresso multi-fase:**

Durante l'analisi, una barra di progresso mostra l'avanzamento attraverso 5 fasi:

```
  ████████████████░░░░░░░░░░░░░░ 53% | Running pipeline | 3,245 files · 12,340 symbols | 45s
  ✓ Pipeline                                                                          42.3s
  ██████░░░░░░░░░░░░░░░░░░░░░░░░ 68% | Loading into KuzuDB | 12,340 nodes
```

Le fasi sono:
1. **Pipeline** (60%) — scansione file, parsing, risoluzione dipendenze
2. **DB** (25%) — caricamento nel database (KuzuDB o Neptune)
3. **FTS** (5%) — creazione indici di ricerca full-text
4. **Embeddings** (8%) — generazione embeddings (se abilitati)
5. **Finalize** (2%) — finalizzazione

**Modalità non interattiva:**

```bash
gitnexus analyze --yes                    # Default: KuzuDB, no embeddings
gitnexus analyze --force --embeddings     # Re-indicizza con embeddings
gitnexus analyze --db neptune \
  --neptune-endpoint host.amazonaws.com \
  --neptune-region us-east-1              # Neptune diretto, niente wizard
```

---

### `gitnexus wiki [path]` — Generazione wiki

Genera documentazione automatica dal knowledge graph usando un LLM.

```bash
gitnexus wiki             # Wiki del repo corrente (con wizard)
gitnexus wiki /path/repo  # Wiki di un percorso specifico
```

**Flusso del wizard interattivo:**

1. Verifica che il repo sia indicizzato (suggerisce `gitnexus analyze` se necessario)
2. Scelta del provider LLM:
   - **OpenAI** (api.openai.com) — predefinito
   - **OpenRouter** (openrouter.ai — accesso a molti modelli)
   - **Custom endpoint** (qualsiasi API compatibile OpenAI)
3. Se custom: URL base dell'endpoint
4. Nome del modello (predefiniti: `gpt-4o-mini` per OpenAI, `minimax/minimax-m2.5` per OpenRouter)
5. Chiave API (input mascherato, rileva chiavi salvate o da variabili d'ambiente)
6. Concorrenza: numero di chiamate LLM parallele (1-10, predefinito: 3)
7. Se la wiki esiste già: conferma rigenerazione forzata
8. Riepilogo configurazione
9. Conferma finale
10. Salva la configurazione in `~/.gitnexus/config.json` per sessioni future

**Modalità non interattiva:**

```bash
gitnexus wiki --yes                                    # Usa config salvata
gitnexus wiki --model gpt-4o-mini --api-key sk-xxx     # Flag espliciti
```

---

### `gitnexus query [ricerca]` — Ricerca nel knowledge graph

Cerca flussi di esecuzione correlati a un concetto.

```bash
gitnexus query                    # Modalità interattiva
gitnexus query "authentication"   # Ricerca diretta
```

**Modalità interattiva (senza argomenti):**

1. Selezione repository (se più di uno indicizzato)
2. Input della query di ricerca (es. "authentication flow", "error handling")
3. Contesto opzionale (es. "sto lavorando sul login")

**Output:**

```
  Query Results (5 flows)

  #  Process              Relevance  Symbols
  ── ──────────────────── ────────── ────────
  1  UserAuthFlow         0.92       12
  2  TokenValidation      0.87       8
  3  PermissionCheck      0.81       6
```

---

### `gitnexus context [nome]` — Vista 360° di un simbolo

Mostra callers, callees e partecipazione ai processi di un simbolo.

```bash
gitnexus context                    # Modalità interattiva
gitnexus context "validateUser"     # Ricerca diretta
```

**Modalità interattiva:**

1. Selezione repository
2. Input del nome del simbolo (es. "validateUser", "AuthService")

**Output:**

```
┌─ Symbol Context ───────────────────────┐
│ Name               validateUser        │
│ Type               Function            │
│ File               src/auth.ts         │
│ Callers            5                   │
│ Callees            3                   │
│ Processes          2                   │
└────────────────────────────────────────┘

  Callers:
    ← loginHandler (src/routes.ts)
    ← apiMiddleware (src/app.ts)

  Callees:
    → hashPassword (src/crypto.ts)
    → findUser (src/db.ts)
```

---

### `gitnexus impact [target]` — Analisi blast radius

Analizza cosa si rompe se modifichi un simbolo.

```bash
gitnexus impact                     # Modalità interattiva
gitnexus impact "AuthService"       # Analisi diretta
```

**Modalità interattiva:**

1. Selezione repository
2. Input del simbolo target
3. Scelta direzione: **upstream** (chi dipende da me) o **downstream** (da chi dipendo)

**Output con livelli di rischio colorati:**

```
  Impact Analysis (8 affected)

  Symbol               Type       Depth  Risk          File
  ──────────────────── ────────── ────── ──────────── ──────────
  loginHandler         Function   1      WILL BREAK   auth.ts
  requestMiddleware    Function   1      WILL BREAK   app.ts
  tokenValidator       Function   2      LIKELY       utils.ts
  cacheService         Class      3      MAY          cache.ts
```

| Profondità | Rischio | Colore | Significato |
|------------|---------|--------|-------------|
| d=1 | WILL BREAK | Rosso | Dipendenti diretti — si romperanno sicuramente |
| d=2 | LIKELY | Giallo | Dipendenze indirette — probabilmente impattate |
| d=3 | MAY | Verde | Dipendenze transitive — da testare se percorso critico |

---

### `gitnexus cypher [query]` — Console Cypher

Esegui query Cypher raw contro il knowledge graph.

```bash
gitnexus cypher                                              # Modalità interattiva
gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"  # Query diretta
```

**Modalità interattiva:**

1. Selezione repository
2. Input della query Cypher

**Output:** Tabella dinamica con colonne auto-rilevate dal risultato.

```
  Results (10 rows)

  name                type       file
  ──────────────────── ────────── ──────────
  validateUser        Function   auth.ts
  hashPassword        Function   crypto.ts
```

---

### `gitnexus list` — Lista repository indicizzati

```bash
gitnexus list
```

**Output:**

```
  Indexed Repositories (3)

  Name        Path                        Indexed      Commit   Symbols   Edges
  ─────────── ─────────────────────────── ──────────── ──────── ───────── ─────────
  my-project  /home/user/projects/my-p... 14/3/2026    a1b2c3d  1,245     6,789
  api-server  /home/user/projects/api-... 12/3/2026    def456e  892       3,421
```

---

### `gitnexus status` — Stato del repository corrente

```bash
gitnexus status
```

**Output:**

```
┌─ Repository Status ────────────────────┐
│ Repository         my-project          │
│ Indexed            14/3/2026 14:30     │
│ Indexed commit     a1b2c3d             │
│ Current commit     a1b2c3d             │
│ Status             Up to date          │
│ Files              245                 │
│ Symbols            1,245               │
│ Edges              6,789               │
│ Communities        42                  │
│ Processes          18                  │
└────────────────────────────────────────┘
```

Lo stato è verde se "Up to date", giallo se "Stale" (il commit corrente non corrisponde a quello indicizzato).

---

### `gitnexus clean` — Eliminazione indice

```bash
gitnexus clean              # Elimina l'indice del repo corrente (con conferma)
gitnexus clean --all        # Elimina tutti gli indici (con conferma)
gitnexus clean --force      # Senza conferma
gitnexus clean --all --yes  # Tutti, senza conferma
```

**Conferma distruttiva (operazione irreversibile):**

```
WARNING: Delete GitNexus indexes for 2 repo(s)?
  • my-project (/home/user/.gitnexus/storage/my-project)
  • api-server (/home/user/.gitnexus/storage/api-server)

◆  Are you sure?
│  ○ Yes  / ● No
└
```

Dopo l'eliminazione:

```
  ✓ Deleted: my-project
  ✓ Deleted: api-server
```

---

### `gitnexus serve` — Server web locale

```bash
gitnexus serve                  # Porta predefinita 4747
gitnexus serve --port 8080      # Porta personalizzata
gitnexus serve --host 0.0.0.0   # Accessibile dalla rete
```

**Banner di avvio:**

```
  ◊ GitNexus Web Server ◊
  ℹ Listening at http://127.0.0.1:4747
  ℹ Press Ctrl+C to stop
```

---

## Componenti TUI riutilizzabili

La TUI è costruita con componenti modulari in `gitnexus/src/cli/tui/`:

### Struttura directory

```
src/cli/tui/
├── index.ts                  # Re-export di tutti i componenti
├── shared.ts                 # Logica di attivazione TUI e serializzazione env
├── components/
│   ├── repo-picker.ts        # Selettore repository interattivo
│   ├── multi-progress.ts     # Barra di progresso multi-fase
│   ├── formatted-table.ts    # Tabelle ASCII formattate
│   ├── summary-box.ts        # Box riepilogo chiave-valore
│   ├── confirm-destructive.ts # Conferma per operazioni distruttive
│   ├── config-display.ts     # Visualizzazione configurazione
│   └── log-panel.ts          # Pannello log con contatori errori/warning
├── formatters/
│   ├── list-formatter.ts     # Output del comando `list`
│   ├── status-formatter.ts   # Output del comando `status`
│   ├── clean-tui.ts          # Flusso interattivo del comando `clean`
│   ├── serve-banner.ts       # Banner di avvio del server
│   └── ai-context-tui.ts     # Output contesto AI
├── interactive/
│   ├── query-tui.ts          # TUI interattiva per `query`
│   ├── context-tui.ts        # TUI interattiva per `context`
│   ├── impact-tui.ts         # TUI interattiva per `impact`
│   ├── cypher-tui.ts         # TUI interattiva per `cypher`
│   └── augment-tui.ts        # TUI per `augment`
└── wizards/
    ├── analyze-wizard.ts     # Wizard multi-step per `analyze`
    ├── wiki-wizard.ts        # Wizard multi-step per `wiki`
    └── setup-wizard.ts       # Wizard configurazione iniziale
```

### Componenti principali

| Componente | Import | Descrizione |
|------------|--------|-------------|
| `pickRepo` | `tui/components/repo-picker` | Selettore repository con auto-selezione se uno solo |
| `createMultiProgress` | `tui/components/multi-progress` | Barra progresso con fasi pesate e tempo trascorso |
| `renderTable` | `tui/components/formatted-table` | Tabelle con colonne auto-dimensionate e allineamento |
| `renderSummaryBox` | `tui/components/summary-box` | Box con bordi per dati chiave-valore |
| `confirmDestructive` | `tui/components/confirm-destructive` | Warning rosso + lista items + conferma |
| `renderConfig` | `tui/components/config-display` | Riepilogo configurazione con valori booleani colorati |
| `createLogPanel` | `tui/components/log-panel` | Log bufferizzato con conteggio errori/warning |

---

## Variabili d'ambiente

Variabili che influenzano il comportamento della TUI:

| Variabile | Effetto |
|-----------|---------|
| `CI=true` | Disattiva la TUI (modalità non interattiva) |
| `GITNEXUS_DB_TYPE` | Disattiva il wizard analyze (configurazione esplicita) |
| `GITNEXUS_NEPTUNE_ENDPOINT` | Disattiva il wizard analyze |
| `GITNEXUS_EMBED_PROVIDER` | Disattiva il wizard analyze |
| `GITNEXUS_FORCE` | Disattiva il wizard analyze |
| `GITNEXUS_TUI_DONE=1` | Flag interno: impedisce loop di re-exec del wizard |
| `GITNEXUS_VERBOSE=1` | Abilita log dettagliati durante l'analisi |

---

## Output JSON per scripting

Quando l'output non è un TTY (pipe, redirect, CI), i comandi `query`, `context`, `impact` e `cypher` emettono JSON raw su stderr invece dell'output formattato. Questo permette l'integrazione con script e pipeline:

```bash
gitnexus query "auth" 2> results.json     # JSON output
gitnexus impact "AuthService" | jq .       # Pipe a jq
```

---

## Convenzioni colori

| Colore | Significato |
|--------|-------------|
| Verde | Successo, conferma, valori attivi |
| Rosso | Errori, warning distruttivi, rischio alto |
| Giallo | Attenzione, rischio medio, stato "stale" |
| Ciano | Banner informativi, URL, titoli |
| Magenta | Banner wiki e cypher |
| Dim (grigio) | Percorsi, valori secondari, placeholder |
| Bold | Nomi, valori importanti |
