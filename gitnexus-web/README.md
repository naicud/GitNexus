# GitNexus Web UI

Web frontend per GitNexus — visualizzazione interattiva del knowledge graph di un codebase con grafo Sigma.js, chat AI, e code navigation.

## Prerequisiti

- Node.js ≥ 18
- GitNexus CLI installato (`npm i -g gitnexus` oppure symlink al repo locale)
- Almeno un repository indicizzato con `npx gitnexus analyze`

## Quick Start

```bash
# 1. Installa le dipendenze
npm install

# 2. Avvia il backend GitNexus (in un terminale separato, dalla directory di un repo indicizzato)
cd ~/workproj/EPAGHE
npx gitnexus serve
# → Backend su http://localhost:4747

# 3. Avvia il dev server frontend
cd ~/private/GitNexus/gitnexus-web
npm run dev
# → Frontend su http://localhost:5173
```

Apri http://localhost:5173 nel browser. La UI si connette automaticamente al backend su `localhost:4747`.

## Modalità di caricamento

La UI supporta 3 modi per caricare un codebase:

| Modalità | Come | Quando usarla |
|----------|------|---------------|
| **Server locale** | Connessione a `gitnexus serve` | Repo già indicizzato localmente (consigliato) |
| **Upload ZIP** | Drag & drop di un `.zip` | Analisi in-browser senza backend |
| **Git clone** | URL di un repo GitHub | Clone + analisi in-browser via isomorphic-git |

### Connessione al server locale

1. Avvia `npx gitnexus serve` nella directory del repo (porta default: 4747)
2. Nella UI, inserisci `http://localhost:4747` nel campo server della pagina iniziale
3. Se il backend ha più repository indicizzati, seleziona quello desiderato dal dropdown

**Shortcut via URL**: `http://localhost:5173?server=http://localhost:4747` — si connette automaticamente.

## Script NPM

| Comando | Descrizione |
|---------|-------------|
| `npm run dev` | Dev server Vite con HMR |
| `npm run build` | Build di produzione (`tsc` + `vite build`) |
| `npm run preview` | Preview della build di produzione |

## Debug in VS Code

La cartella `.vscode/` contiene le configurazioni pronte. Apri il progetto in VS Code e vai su **Run and Debug** (Ctrl+Shift+D / Cmd+Shift+D):

| Configurazione | Descrizione |
|---------------|-------------|
| **Debug FE (Chrome)** | Avvia Vite + apre Chrome con debugger. Breakpoint nei `.tsx` funzionano. |
| **Debug FE (Edge)** | Come sopra, con Microsoft Edge |
| **Attach to Chrome (già avviato)** | Si attacca a Chrome lanciato con `--remote-debugging-port=9222` |
| **Full Stack (FE + Backend)** | Avvia prima `gitnexus serve` (backend), poi Vite + Chrome debug |

### Avvio rapido debug

```
F5 con "Debug FE (Chrome)" selezionato
```

Vite parte in automatico (task `vite:dev`), Chrome si apre con i devtools connessi. I breakpoint nei sorgenti TypeScript/React funzionano direttamente.

### Debug full-stack

Seleziona la configurazione **"Full Stack (FE + Backend GitNexus)"** — avvia sia il backend (`gitnexus serve` sulla porta 4747) che il frontend con debug Chrome.

> **Nota**: la task `gitnexus:serve` esegue `npx gitnexus serve` nella directory `~/workproj/EPAGHE`. Modifica il `cwd` in `.vscode/tasks.json` se il repo è altrove.

### Attach a Chrome esistente

Se preferisci avviare Chrome manualmente con il debugging remoto:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  http://localhost:5173
```

Poi usa la configurazione **"Attach to Chrome (già avviato)"**.

## Architettura

```
src/
├── main.tsx                    # Entry point React
├── App.tsx                     # Root component, routing tra viste
├── components/                 # Componenti UI
│   ├── DropZone.tsx            # Pagina iniziale (upload/clone/connect)
│   ├── GraphCanvas.tsx         # Visualizzazione grafo (Sigma.js + graphology)
│   ├── Header.tsx              # Barra superiore con search e repo switcher
│   ├── RightPanel.tsx          # Pannello destro (code viewer + chat AI)
│   ├── FileTreePanel.tsx       # Albero file navigabile
│   ├── CodeReferencesPanel.tsx # Riferimenti al codice dal grafo
│   ├── SettingsPanel.tsx       # Configurazione LLM (OpenAI/Anthropic/Ollama)
│   ├── StatusBar.tsx           # Barra di stato in basso
│   ├── ProcessesPanel.tsx      # Visualizzazione execution flows
│   ├── ProcessFlowModal.tsx    # Dettaglio flusso con diagramma Mermaid
│   └── QueryFAB.tsx            # Floating action button per query
├── hooks/
│   ├── useAppState.tsx         # State globale dell'app (React Context)
│   ├── useBackend.ts           # Connessione al backend GitNexus
│   ├── useSettings.ts          # Settings LLM
│   └── useSigma.ts             # Hook per Sigma.js graph rendering
├── services/
│   ├── backend.ts              # Client HTTP per API backend GitNexus
│   ├── server-connection.ts    # Connessione e download grafo dal server
│   ├── git-clone.ts            # Clone in-browser via isomorphic-git
│   └── zip.ts                  # Estrazione ZIP in-browser
├── core/
│   ├── graph/                  # Struttura dati grafo (KnowledgeGraph)
│   ├── kuzu/                   # KuzuDB WASM (query Cypher in-browser)
│   ├── ingestion/              # Pipeline analisi in-browser
│   ├── tree-sitter/            # Parsing AST in-browser
│   ├── llm/                    # Integrazione LLM (Anthropic/OpenAI/Ollama)
│   ├── embeddings/             # Embeddings in-browser (WebGPU/WASM)
│   └── search/                 # Ricerca semantica
├── lib/
│   ├── constants.ts            # Costanti app
│   ├── graph-adapter.ts        # Adattatore graphology ↔ KnowledgeGraph
│   ├── mermaid-generator.ts    # Generazione diagrammi Mermaid
│   └── utils.ts                # Utility generiche
├── config/
│   ├── supported-languages.ts  # Linguaggi supportati dal parser
│   └── ignore-service.ts       # Pattern di file da ignorare
├── types/                      # Type definitions
├── vendor/leiden/              # Algoritmo Leiden per community detection
└── workers/
    └── ingestion.worker.ts     # Web Worker per analisi in background
```

## API Backend

Quando connessa al server locale (`gitnexus serve`), la UI usa queste API:

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/api/repos` | GET | Lista repository indicizzati |
| `/api/repo?repo=NAME` | GET | Info su un repository |
| `/api/graph?repo=NAME` | GET | Grafo completo (nodi + relazioni) |
| `/api/file?repo=NAME&path=PATH` | GET | Contenuto sorgente di un file |
| `/api/processes?repo=NAME` | GET | Lista execution flows |
| `/api/process?repo=NAME&name=NAME` | GET | Dettaglio di un execution flow |
| `/api/clusters?repo=NAME` | GET | Lista functional area clusters |
| `/api/cluster?repo=NAME&name=NAME` | GET | Dettaglio di un cluster |
| `/api/query` | POST | Query Cypher (`{cypher, repo}`) |
| `/api/search` | POST | Ricerca semantica (`{query, repo, limit}`) |

## Stack tecnologico

- **Framework**: React 18 + TypeScript
- **Build**: Vite 5
- **Styling**: Tailwind CSS 4
- **Grafo**: Sigma.js 3 + graphology
- **Database**: KuzuDB WASM (query Cypher in-browser)
- **Parsing**: tree-sitter WASM (AST in-browser)
- **LLM**: LangChain (Anthropic, OpenAI, Google GenAI, Ollama)
- **Embeddings**: HuggingFace Transformers.js (WebGPU/WASM)
- **Diagrammi**: Mermaid
- **Git in-browser**: isomorphic-git
- **Deploy**: Vercel (con CORS proxy per git clone)

## Deploy su Vercel

Il progetto è configurato per Vercel:

- `vercel.json` — header Cross-Origin Isolation (necessari per SharedArrayBuffer / KuzuDB WASM)
- `api/proxy.ts` — CORS proxy serverless per isomorphic-git (solo URL GitHub)

```bash
npx vercel
```

## Variabili d'ambiente

Nessuna variabile d'ambiente richiesta per lo sviluppo locale. Il backend URL di default è `http://localhost:4747` (configurabile dalla UI).

Per il deploy Vercel, le API key LLM vengono inserite dall'utente nel pannello Settings della UI (salvate in localStorage, mai inviate al server).
