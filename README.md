# knowmore

Local pi package for web + local knowledge retrieval.

## What it provides

### Tools

- `km_research_web`: search + fetch + distiller model compression (OpenRouter)
- `km_search_web`: Brave Search web results (title, URL, snippet)
- `km_fetch_url`: fetch/extract readable text from URL
- `kb_search`: lexical local KB search over a persistent on-disk index (SQLite FTS5/BM25)
  - local KB source catalog is auto-injected into the system prompt in `before_agent_start`
- `kb_retrieve`: semantic/hybrid retrieval (planned)

### Commands

- `/kb-index`: manage local KB index (`update | status | clear`)
  - requires an explicit action (`update`, `status`, or `clear`)
  - `update` builds automatically if index does not exist
  - supports `--scope project|shared|all`, `--all`, and repeated `--source <sourceId>`
- `/km-diagnose`: verify config + KB discovery + Brave + distiller connectivity
- `/km-clear-cache`: clear in-memory web retrieval caches

### Utility skill triggers

- `flush-commit`: Read uncommitted files and decide if commit is sensible
- `ticket-done`: Mark a ticket as done
- `ticket-not-done`: Mark a ticket as not done

## Requirements

It assumes ripgrep(`rg`) and SQLite3(`sqlite3`) are available in the PATH.

## Configuration

### Main configuration files

Copy the example config file to create a global default config:

```powershell
cp knowmore.config.example.json knowmore.config.default.json
```

Or create a project-specific config file in your project folder:

```powershell
cp ${KNOWMORE_INSTALL_DIR}/knowmore.config.example.json knowmore.config.json
```

You can have global config, project-specific config, or both.

#### Config loading precedence

At least one config file must exist (global or project).

1) `KNOWMORE_CONFIG_PATH` (if set and must point to an existing file)
2) package global default `knowmore.config.default.json` (if present)
3) nearest project `knowmore.config.json` from current working directory (if present; overrides matching fields)

The ones loaded later override fields from earlier ones.

### Local Knowledge Base (KB)

- `PROJECT_KNOWLEDGE_BASE` must be a **relative** path from the project config folder.
- `SHARED_KNOWLEDGE_BASE` must be an **absolute** path.
- Local KB source discovery uses:
  - implicit catalog: top-level entries under each KB root
  - optional explicit catalog: `kb.catalog.json` in each KB root (supports pointing outside root)

Optional `kb.catalog.json` format:

```json5
[
  {
    "localId": "houdini-py-libs", // root-local ID, no prefix needed
    "path": "C:/Program Files/Side Effects Software/Houdini 21.0.631/houdini/python3.11libs",
    "description": "Undocumented Houdini Python libs"
  }
]
```


## Installation

From this `knowmore` directory:

```powershell
pi install .
```

Or from anywhere:

```powershell
pi install /absolute/path/to/knowmore
```

Then in pi:

- Run `/km-diagnose` first to validate setup.
- For local KB retrieval:
  - run `/kb-index update --scope project` (or `--all`)
  - call `kb_search` (prefer passing `sourceIds` from the injected KB catalog)
- For external knowledge, call `km_research_web` first.
- If needed, follow specific source URLs with `km_fetch_url`.

## Development loop

1. Edit files in `extensions/` or `skills/`
2. In pi, run `/reload`
3. Re-test

## Notes

- Fetched URLs are cached in-memory.
- KB index is stored at `.knowmore/kb-index/kb.sqlite` near the active project config (or current working directory if no project config is found).