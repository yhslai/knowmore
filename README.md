# knowmore

Local pi package for external web knowledge retrieval.

## What it provides

- `km_research_web` tool: search + fetch + distiller model compression (OpenRouter)
- `km_search_web` tool: Brave Search web results (title, URL, snippet)
- `km_fetch_url` tool: fetch/extract readable text from URL
- `/km-diagnose` command: verify config + Brave + distiller connectivity
- `/km-clear-cache` command: clear in-memory retrieval caches

## Requirements

Create a local config file:

```powershell
cp knowmore.config.example.json knowmore.config.json
```

Then edit `knowmore.config.json`:

```json
{
  "web": {
    "braveApiKey": "your_brave_api_key"
  },
  "distiller": {
    "openrouterApiKey": "your_openrouter_api_key",
    "model": "google/gemini-3-flash-preview"
  }
}
```

Notes:
- `knowmore.config.json` is gitignored.
- Config precedence:
  1) global config (this package folder, or `KNOWMORE_CONFIG_PATH`)
  2) nearest project `knowmore.config.json` from current working directory (overrides matching fields)

## Use locally with pi

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
- For external knowledge, call `km_research_web` first.
- If needed, follow specific source URLs with `km_fetch_url`.

## Development loop

1. Edit files in `extensions/` or `skills/`
2. In pi, run `/reload`
3. Re-test

## Notes

- Fetched urls are cached in-memory. 


## Utility skill triggers

- `flush-commit`
  - Run: `flush-commit`

- `ticket-done`
  - Mark done: `ticket-done <ticket-name>` or `td <ticket-name>`
  - Mark not done: `ticket-not-done <ticket-name>`