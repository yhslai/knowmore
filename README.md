# knowmore

Local pi package for web + local knowledge retrieval.

## What it provides

### Tools

- `km_research_web`: search + fetch + distiller model compression (OpenRouter), with optional `intent` guidance
- `km_search_web`: Brave Search web results (title, URL, snippet)
- `km_fetch_url`: fetch/extract readable text from URL (bounded output)
- `km_fetch_url_full`: fetch/extract all readable text from URL without knowmore truncation
- `kb_search`: lexical local KB search over a persistent on-disk index (SQLite FTS5/BM25)
- `kb_union_search`: structured `all[]` + `any[]` local KB search (OR/union), with optional one-shot local context distillation and optional `intent`
  - local KB source catalog is auto-injected into the system prompt in `before_agent_start`
- `kb_retrieve`: semantic/hybrid retrieval (planned)

### Commands

- `/kb-index`: manage local KB index (`update | status | clear`)
  - requires an explicit action (`update`, `status`, or `clear`)
  - `update` builds automatically if index does not exist
  - supports `--scope project|shared|all`, `--all`, and repeated `--source <sourceId>`
- `/km-diagnose`: verify config + KB discovery + Brave + distiller connectivity
- `/km-clear-cache`: clear in-memory web retrieval caches
- `/km-quota-wait [status|cancel|off|on]`: control ChatGPT/Codex quota auto-resume
- `/km-quota [cached]`: check current Codex/OpenRouter quota; `cached` is offline Codex-only

### Checking quota

Run `/km-quota`; it selects the strategy from the **active model's provider**, not
from Knowmore's distiller configuration. Reports are UI-only session entries, not
messages added to the model's context, and never trigger a model call.

- **`openai-codex`:** makes one authenticated read-only
  `GET https://chatgpt.com/backend-api/wham/usage`, the usage endpoint used by
  Codex CLI. This works without waiting for response headers or quota stream events.
  Shows remaining percentages and reset times, including additional metered buckets
  when supplied; usual windows are labeled 5-hour and weekly. Uses Pi's resolved
  model credential and optional account-selection header without reading auth files,
  decoding tokens, or collecting browser cookies. This is an **internal endpoint**,
  not a stable public API; denial/invalid data is reported explicitly, not treated
  as zero usage or a full allowance. If lookup fails and an observation is cached,
  it is shown with a clear failure/staleness label.
  - `/km-quota cached` reads only local observations, with **no auth lookup or
    network request**. Cache is populated by live checks, normal response headers,
    and `codex.rate_limits` stream events when available, separately per model.
    Missing data is unknown; a passed reset does not imply a full allowance.
    Cache clears on reload/shutdown.
- **`openrouter`:** makes one authenticated `GET https://openrouter.ai/api/v1/key`
  metadata request using Pi's resolved credential for the active model (including
  model-specific auth overrides). Shows the key's remaining spending cap and reset
  interval, available spend counters, effective enforced budget, and free-model
  daily request allowance when returned. An uncapped key does **not** mean unlimited
  account credit; the key budget is **not prepaid account balance**. No separate
  credits/account endpoint is called. The request has a 10-second deadline, does not
  follow redirects, and refuses custom gateway URLs. Network/auth/HTTP failures are
  reported without exposing credentials or raw response bodies. Model changes,
  another quota check, and shutdown cancel outstanding checks.
- Other providers report unsupported without performing any network/auth lookup.
  Virtual providers are not guessed from their display name or underlying model.

Both live lookups have a 10-second deadline, refuse custom gateway URLs, and do not
follow redirects. Changing models, starting another check, or shutting down cancels
the lookup. The feature uses current Pi's provider-response/stream hooks and UI
entry renderers. Credentials are resolved only in memory for an explicit live
check; they are never displayed, logged, or stored by the feature. There is no
background polling or billed completion. Reference contracts:
[OpenRouter key limits](https://openrouter.ai/docs/api_reference/limits),
[Codex usage endpoint](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs),
and [Codex quota events/headers](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs).

### Quota auto-resume (Windows)

Knowmore automatically waits after an `openai-codex` ChatGPT usage-limit error, then
continues the interrupted conversation. Requires a current Pi host with
`agent_settled` and `provider_stream_event` extension events (legacy peer typings
alone do not indicate host support). Enabled by default in TUI/RPC sessions; it does
not run in print/JSON mode, the MCP server, or the standalone CLI.

- Uses the provider reset timestamp or its rounded retry estimate, plus a one-minute
  buffer. If neither is available, waits five hours plus the buffer. If still
  quota-limited after resuming, waits again; no quota bypass or provider switching.
- Keeps Windows awake **only during the quota wait**, using a temporary thread-scoped
  sleep request. The screen may turn off. No power-plan settings are changed.
- Releases the sleep blocker **before** resuming model work. Escape,
  `/km-quota-wait cancel`, new input, model/session/branch changes, compaction,
  reload, and shutdown cancel the wait and release it too. `off` disables future
  automatic waits for the current extension runtime; `on` re-enables them.
- A hidden Windows PowerShell helper releases its request on stdin EOF (including
  Pi crashing), on helper exit, or within 20 seconds without a Pi heartbeat.
  Failure to acquire/maintain the blocker cancels auto-resume rather than claiming
  the computer will stay awake. Manual sleep, closing a laptop lid, shutdown, and
  OS policy can still override the request.
- Pi must remain running. Waits are intentionally not restored after reload/restart.
  No authentication files or tokens are read by this feature. Tests are offline:
  `npm run test:quota` (includes brief real Windows sleep-request cleanup checks).

### Utility triggers

- `flush-commit`: Read uncommitted files and decide if commit is sensible
- `ticket-done`: Mark a ticket as done
- `ticket-not-done`: Mark a ticket as not done
- `discuss-ticket`: Read a ticket and think about how we should implement it
- `plan-ticket`: Write an implementation plan for a ticket
- `replan-ticket`: Re-plan an implementation plan for a ticket from a specific step
- `implement-ticket`: Implement a ticket step-by-step

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
- KB index locations are fixed:
  - shared index: `~/.pi/.knowmore/kb-index/kb.sqlite`
  - project index: `{project_root}/.knowmore/kb-index/kb.sqlite`
- `kb_search` and `kb_union_search` support `scope: "project" | "shared" | "all"`.
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
  - call `kb_search` or `kb_union_search` (prefer passing `sourceIds` from the injected KB catalog)
- For external knowledge, call `km_research_web` first.
- If needed, follow specific source URLs with `km_fetch_url`.

## Claude Code (MCP server)

The same local KB tools are exposed to Claude Code through a stdio MCP server in `cli/`. It reuses the same
config files (`knowmore.config.default.json` + project `knowmore.config.json`) and the same SQLite indexes as pi,
so documents are indexed once and shared by both harnesses. Requires Node >= 22.18 (runs the `.ts` sources directly).

```powershell
claude mcp add --scope user knowmore -- node C:/path/to/knowmore/cli/knowmore.mjs mcp
```

Tools: `kb_search`, `kb_union_search` (`distill` defaults to false), `kb_catalog`, `kb_index_update`.
The KB catalog is provided to Claude via the MCP server instructions. The project KB is resolved from the
directory Claude Code was started in (override with `KNOWMORE_CWD`).

The same entry point also works as a terminal CLI:

```powershell
node cli/knowmore.mjs catalog
node cli/knowmore.mjs index status
node cli/knowmore.mjs index update --scope shared   # or project / all, --source <id>, --reindex
```

## Development loop

1. Edit files in `extensions/` or `skills/`
2. In pi, run `/reload`
3. Re-test

## Notes

- Fetched URLs are cached in-memory.
- KB index database file is `kb.sqlite`.
- Shared index is always `~/.pi/.knowmore/kb-index/kb.sqlite`.
- Project index is always `{project_root}/.knowmore/kb-index/kb.sqlite`.