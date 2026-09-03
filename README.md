# PostMD MCP Server

stdio [Model Context Protocol](https://modelcontextprotocol.io) server for **[PostMD](https://postmd.turink.com)** — publish a Markdown document, get a web page you share by link. Optional groups, document passwords, share expiry and viewer themes. This server wraps PostMD's public API (`/api/v1`) so assistants can publish, read, update and organize documents.

**Publishing needs no account and no key.** With zero configuration this server can already turn Markdown into a shareable page. An API key adds management: updating and deleting your documents, attachments, and groups.

**Anonymous documents come with a control token.** Publishing without a key returns `data.controlToken` and `data.retainedUntil`: the document is deleted at that instant, and the token is the only way to update or delete it before then. It is shown once and cannot be reissued, so keep it with the `docCode`. Pass it as `controlToken` to the update and delete tools and they work without an API key.

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

Each of the first three also accepts `controlToken` instead of a key, for a document published anonymously.

| Tool | Purpose |
|------|---------|
| `postmd_update_document` | Replace content and/or metadata; can clear password / end date |
| `postmd_update_document_from_file` | Same, body read from a local `filePath` |
| `postmd_delete_document` | Delete a document (no undo) |
| `postmd_upload_attachment` | Upload an image/PDF, get a URL to embed in Markdown |
| `postmd_create_documents_from_files` | Bulk-publish several `.md` files in one call |
| `postmd_move_document_to_group` | Move a document into a group / folder |

Notes and highlights — key with `documents:read` / `documents:write`. A note is
text anchored to a quoted passage; a highlight is the same object carrying only
a colour. Visibility comes from ownership: on the key member's own document a note
is `PRIVATE` or `SHARED`, and on anyone else's document it is always `SHARED`.
Documents nobody owns — anonymous uploads and service-owned pages — take no notes:

| Tool | Purpose |
|------|---------|
| `postmd_list_notes` | Notes on a document: yours + every `SHARED` one |
| `postmd_add_note` | Attach a note, or a colour-only highlight to a quoted passage |
| `postmd_update_note` | Edit a note you wrote |
| `postmd_resolve_note` | Mark a `SHARED` discussion settled, or reopen it |
| `postmd_delete_note` | Delete yours, or a `SHARED` note on your document |
| `postmd_list_my_notes` | Your notes across every document |

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

Nothing to install. `npx` fetches the package and the MCP client spawns it.

```bash
npx -y postmd-mcp-server
```

Run it by hand only to check that it starts — it speaks MCP over stdin and stdout, so it
will sit there waiting for a client.

## Client configuration

Claude Code:

```bash
claude mcp add postmd -- npx -y postmd-mcp-server
```

Cursor (`~/.cursor/mcp.json`) and most other stdio clients:

```json
{
  "mcpServers": {
    "PostMD": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "postmd-mcp-server"],
      "env": { "POSTMD_API_KEY": "pmk_…" }
    }
  }
}
```

To run a checkout instead — changing the code, or debugging against a local PostMD —
point the client at the file.

```bash
git clone https://github.com/reinlainer/postmd-mcp-server.git
cd postmd-mcp-server && npm ci
claude mcp add postmd-dev -- node "$PWD/src/index.js"
```

Leave `env` out entirely for publish/read-only use. `cp .env.example .env` works too — the server loads its own `.env`.

## Smoke test

Runs the full write path against a live server and cleans up after itself. Needs a key with all four scopes.

```bash
export POSTMD_API_KEY=pmk_…
npm run smoke
```

Creates a group and a passworded document, reads it back, updates it, clears the password, then deletes both. It also publishes one document with no credential and removes it with the control token.

## Stack

`@modelcontextprotocol/sdk` **1.30.0**, `dotenv`. **License:** MIT.
