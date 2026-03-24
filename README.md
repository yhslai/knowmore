# knowmore

Local pi package for web + local knowledge retrieval.

## What it provides

### Tools:

- `km_research_web`: search + fetch + distiller model compression (OpenRouter)
- `km_search_web`: Brave Search web results (title, URL, snippet)
- `km_fetch_url`: fetch/extract readable text from URL
- `km_list_kb`: list local KB sources from config + implicit/explicit TOC (TBD)
- `km_retrieve_kb`: get info from local KB sources via the retrieval layer (TBD)

### Commands:

- `/km-diagnose`: verify config + Brave + distiller connectivity
- `/km-clear-cache`: clear in-memory retrieval caches

### Utility Skill Trigger:

- `flush-commit`: Read uncommitted files and decide if commit is sensible
- `ticket-done`: Mark a ticket as done
- `ticket-not-done`: Mark a ticket as not done


## Requirements

- `rg` (ripgrep) available in PATH for `km_search_local`.

## Configuration

### Main Configuration Files

Copy the example config file to create a global default config:

```powershell
cp knowmore.config.example.json knowmore.config.default.json
```

And edit it as needed.

Alternatively, create a project-specific config file in your project folder:

```powershell
cp ${KNOWMORE_INSTALL_DIR}/knowmore.config.example.json knowmore.config.json
```

And edit it as needed. You can have global config, project-specific config, or both.

#### Config loading precedence:

At least one config file must exist (global or project).

1) `KNOWMORE_CONFIG_PATH` (if set and must point to an existing file)
2) package global default `knowmore.config.default.json` (if present)
3) nearest project `knowmore.config.json` from current working directory (if present; overrides matching fields)

The ones loaded later override fields from earlier ones.

### Local Knowledge Base (KB)

- `PROJECT_KNOWLEDGE_BASE` must be a **relative** path from the project config folder.
- `SHARED_KNOWLEDGE_BASE` must be an **absolute** path.
- Local KB source discovery uses:
  - implicit TOC: top-level entries under each KB root
  - optional explicit TOC: `kb.toc.json` in each KB root (supports pointing outside root)

Optional `kb.toc.json` format:

```json
{
  "sources": [
    {
      "id": "houdini-py-libs",
      "path": "C:/Program Files/Side Effects Software/Houdini 21.0.631/houdini/python3.11libs",
      "description": "Undocumented Houdini Python libs",
      "tags": ["houdini", "python", "api"]
    }
  ]
}
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

- Run `/km-diagnose` first to validate your setup.
- For local KB retrieval:
  - call `km_list_kb`
  - then call `km_search_local` with `sourceId` for precise scope
- For external knowledge, call `km_research_web` first.
- If needed, follow specific source URLs with `km_fetch_url`.

## Development loop

1. Edit files in `extensions/` or `skills/`
2. In pi, run `/reload`
3. Re-test


## Notes

- Fetched URLs are cached in-memory. 