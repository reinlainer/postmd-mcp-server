# PostMD MCP Server

stdio [Model Context Protocol](https://modelcontextprotocol.io) server for **[PostMD](https://postmd.turink.com)**—hosted Markdown you publish once and share by link, with optional groups, document/group passwords, and share expiry. This server wraps PostMD’s **Agent API** (`/api/agent/v1`) so assistants can list, read, create, and update your documents using scoped API keys instead of raw HTTP.

**HTTP reference:** [postmd.turink.com/docs/api-reference.md](https://postmd.turink.com/docs/api-reference.md)

## Requirements

- **Node.js** 20.x (see `package.json` → `engines`)
- PostMD account and an **API key** (`pmk_…`) with the scopes your tools need

## Authentication

1. Sign in at [postmd.turink.com](https://postmd.turink.com).
2. Open **[Account → API keys](https://postmd.turink.com/account)** and create a key. Pick scopes to match read vs write (they are independent; a `403` usually means a missing scope).
3. Set credentials in the environment (see below). Do **not** commit `.env` or keys.

| Variable | Description |
|----------|-------------|
| `POSTMD_BASE_URL` | Origin only, no trailing slash. Production: `https://postmd.turink.com`. Self‑hosted / local: your base URL (e.g. `http://localhost:8080`). |
| `POSTMD_API_KEY` | `pmk_…` from Account. |
| `POSTMD_DEBUG` | Optional. `1` / `true` / `yes` → extra stderr logging. |

Load order: this repo’s `.env` (if present) is applied via `dotenv` without overwriting variables already set by the host (e.g. MCP `env`).

## Tools

| Tool | Purpose |
|------|---------|
| `postmd_list_groups` | Groups visible to the key (`groups:read`) |
| `postmd_list_group_documents` | Documents in a group (`groups:read`, `documents:read`) |
| `postmd_get_document` | Metadata by `docCode` (`documents:read`) |
| `postmd_get_document_raw` | Stored Markdown body (`documents:read`; optional `password`) |
| `postmd_create_document` | New upload (`documents:write`; body + metadata in one call) |
| `postmd_update_document` | Update content/metadata (`documents:write`) |
| `postmd_delete_document` | Logical delete (`documents:write`) |
| `postmd_create_group` | New group (`groups:write`) |
| `postmd_update_group` | Update group (`groups:write`) |

For uploads, read the source `.md` in the workspace, then pass the full string into `postmd_create_document` / `postmd_update_document`—no separate staging artifact for PostMD.

## Quickstart

```bash
git clone https://github.com/reinlainer/postmd-mcp-server.git
cd postmd-mcp-server
cp .env.example .env   # set POSTMD_BASE_URL and POSTMD_API_KEY
npm ci
node src/index.js      # normally spawned by the MCP client; use for debugging
```

## Cursor (`~/.cursor/mcp.json`)

Restart the IDE after edits.

```json
{
  "mcpServers": {
    "PostMD": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/postmd-mcp-server/src/index.js"],
      "envFile": "/absolute/path/to/postmd-mcp-server/.env"
    }
  }
}
```

Use `"env": { "POSTMD_BASE_URL": "…", "POSTMD_API_KEY": "…" }` instead of `envFile` if you prefer.

## Smoke test

PostMD must be reachable. From this directory:

```bash
export POSTMD_BASE_URL=https://postmd.turink.com
export POSTMD_API_KEY=pmk_…
npm run smoke
```

Creates a passworded group and document, reads raw Markdown, deletes the document. Groups are not deleted via Agent API—remove in the UI if needed.

## Maintainers

When developed inside the private PostMD monorepo, this package lives at `packages/postmd-mcp-server/`. Publish to GitHub with that repo’s `scripts/sync-mcp-github.sh`.

## Stack

`@modelcontextprotocol/sdk` **1.0.4** (pinned). **License:** MIT.
