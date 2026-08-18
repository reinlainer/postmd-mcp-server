# PostMD MCP Server

stdio [Model Context Protocol](https://modelcontextprotocol.io) server for **[PostMD](https://postmd.turink.com)** — publish a Markdown document, get a web page you share by link. Optional groups, document passwords, share expiry and viewer themes. This server wraps PostMD's public API (`/api/v1`) so assistants can publish, read, update and organize documents.

**Publishing needs no account and no key.** With zero configuration this server can already turn Markdown into a shareable page. An API key adds management: updating and deleting your documents, attachments, and groups.

**HTTP reference:** [postmd.turink.com/docs/api](https://postmd.turink.com/docs/api) · machine-readable spec at [/api-docs](https://postmd.turink.com/api-docs)

## Requirements

- **Node.js** 20 or later
- Nothing else. An **API key** (`pmk_…`) only for the management tools.

## Configuration

All variables are optional.

| Variable | Description |
|----------|-------------|
| `POSTMD_BASE_URL` | Defaults to `https://postmd.turink.com`. Set for a self-hosted / local instance. Origin only, no trailing slash. |
| `POSTMD_API_KEY` | `pmk_…` for the tools marked with a scope below. Sign in at [postmd.turink.com](https://postmd.turink.com), open **Account → API keys**, pick the scopes you need — read and write are independent, and a `403` usually means a missing scope. |
| `POSTMD_DEBUG` | `1` / `true` / `yes` → extra stderr logging. |

Load order: this repo's `.env` (if present) is applied via `dotenv` without overwriting variables already set by the host (e.g. MCP `env`). Do **not** commit `.env` or keys.

## Tools

Publishing and reading — no key needed:

| Tool | Purpose |
|------|---------|
| `postmd_create_document` | Publish Markdown, get `docCode` + share URL |
| `postmd_create_document_from_file` | Same, but this server reads a local `filePath` (large files) |
| `postmd_get_document` | Metadata by `docCode` |
| `postmd_get_document_raw` | Stored Markdown body (optional `password`) |

Managing documents — key with `documents:write`:

| Tool | Purpose |
|------|---------|
| `postmd_update_document` | Replace content and/or metadata; can clear password / end date |
| `postmd_update_document_from_file` | Same, body read from a local `filePath` |
| `postmd_delete_document` | Delete (recoverable for 30 days) |
| `postmd_upload_attachment` | Upload an image/PDF, get a URL to embed in Markdown |
| `postmd_create_documents_from_files` | Bulk-publish several `.md` files in one call |
| `postmd_add_document_to_group` | File a document into a group / folder |
| `postmd_remove_document_from_group` | Take it out again |

Groups — key with `groups:read` / `groups:write`:

| Tool | Purpose |
|------|---------|
| `postmd_list_groups` | Groups visible to the key (paged) |
| `postmd_list_group_documents` | Documents in a group (paged, searchable, sortable) |
| `postmd_create_group` | New group |
| `postmd_update_group` | Rename / change expiry |
| `postmd_delete_group` | Delete a group (documents survive) |

For uploads: either pass the full Markdown as the `markdown` argument, or pass a local `filePath` only so this server reads the file. The path must exist on the machine running the MCP server.

## Quickstart

```bash
git clone https://github.com/reinlainer/postmd-mcp-server.git
cd postmd-mcp-server
npm ci
node src/index.js      # normally spawned by the MCP client; use for debugging
```

## Client configuration

Claude Code:

```bash
claude mcp add postmd -- node /absolute/path/to/postmd-mcp-server/src/index.js
```

Cursor (`~/.cursor/mcp.json`) and most other stdio clients:

```json
{
  "mcpServers": {
    "PostMD": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/postmd-mcp-server/src/index.js"],
      "env": { "POSTMD_API_KEY": "pmk_…" }
    }
  }
}
```

Leave `env` out entirely for publish/read-only use. `cp .env.example .env` works too — the server loads its own `.env`.

## Smoke test

Runs the full write path against a live server and cleans up after itself. Needs a key with all four scopes.

```bash
export POSTMD_API_KEY=pmk_…
npm run smoke
```

Creates a group and a passworded document, reads it back, updates it, clears the password, then deletes both.

## Stack

`@modelcontextprotocol/sdk` **1.30.0**, `dotenv`. **License:** MIT.
