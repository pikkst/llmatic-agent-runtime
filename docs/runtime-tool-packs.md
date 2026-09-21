# Runtime tool packs

M10 adds a whitelisted execution layer for common local engineering runtimes.

## Packs

### Docker

Read-only:

    llmatic runtime run docker status

Mutation:

    llmatic runtime run docker up --approve
    llmatic runtime run docker down --approve

Docker mutation uses `permissions.docker`.

The runtime intentionally does not expose generic `docker run`, `docker exec`, volume deletion, image push, or arbitrary argument passthrough.

### Supabase

Read-only:

    llmatic runtime run supabase status

Local stack:

    llmatic runtime run supabase start --approve
    llmatic runtime run supabase stop --approve

Local database reset:

    llmatic runtime run supabase db-reset-local --approve

The reset command is hard-coded to:

    supabase db reset --local

It cannot target a linked or arbitrary remote database.

Supabase output is sanitized before it is returned or recorded. Secret/key/token/password fields and URL passwords are redacted.

Local stack start/stop uses `permissions.docker`.
Local database reset uses `permissions.databaseMigration`.

Remote `db push`, remote reset, link, deploy, secrets, and production operations are deliberately not exposed in M10.

### Python

    llmatic runtime run python run-script \
      --script scripts/check.py \
      --arg --fast \
      --approve

Only repository-contained `.py` / `.pyw` files are accepted.

Execution preference:

1. `uv run -- <script>`
2. `python <script>`
3. `python3 <script>`
4. Windows `py -3 <script>`

Python execution uses `permissions.localProcess`.

### Ollama

Read-only:

    llmatic runtime run ollama list
    llmatic runtime run ollama ps

Model execution:

    llmatic runtime run ollama run \
      --model qwen3:8b \
      --prompt "Review this change" \
      --approve

Model execution uses `permissions.localProcess`.

M10 deliberately does not expose model pull/delete/copy/create operations.

## Inspection

    llmatic runtime inspect
    llmatic runtime inspect --json

This checks Docker, Supabase CLI, Python/uv, and Ollama through structured process calls.

## MCP

MCP exposes:

- `llmatic_runtime_inspect`
- `llmatic_runtime_run`

MCP does not self-approve `ask` permissions. Unattended automation requires the user to opt the relevant permission into `auto`.

## Audit

Every attempted runtime operation made while a workflow is active writes a generic ACTION checkpoint:

- provider: `runtime-tools`
- action: `<pack>.<operation>`
- success
- command on successful command resolution
- pack/operation metadata

No shell command strings are accepted from the model. The runtime constructs executable + argument arrays from a fixed operation whitelist.
