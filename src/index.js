#!/usr/bin/env node
/**
 * PostMD Agent API — MCP stdio server
 * Env: POSTMD_BASE_URL, POSTMD_API_KEY (또는 패키지 루트 `.env`)
 */
import "./env.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function isDebug() {
  const v = process.env.POSTMD_DEBUG;
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Host + path only; no query (secrets). */
function safeUrlForLog(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/** Node fetch / TLS / DNS 실패 시 message·cause·code 를 한 줄로. */
function formatNetworkError(err) {
  const parts = [];
  let e = err;
  let depth = 0;
  while (e != null && depth < 10) {
    if (e instanceof Error) {
      let line = e.message;
      if (typeof e.code === "string" && e.code) line += ` [code=${e.code}]`;
      parts.push(line);
      e = e.cause;
    } else {
      parts.push(String(e));
      break;
    }
    depth++;
  }
  return parts.length ? parts.join(" | ") : String(err);
}

/** MCP initialize → serverInfo.instructions (clients may show to the model). */
const SERVER_INSTRUCTIONS =
  "PostMD Agent API via MCP. Use `postmd_*` for all PostMD operations; do not call the Agent API with curl or ad-hoc scripts. Create or update a document in one step: either pass the full Markdown body in `markdown` (postmd_create_document / postmd_update_document), or pass `filePath` only so this process reads the file (postmd_create_document_from_file / postmd_update_document_from_file). `filePath` must exist on the machine running this MCP server; prefer an absolute path.";

function debugStderr(line) {
  if (isDebug()) process.stderr.write(`[postmd-mcp-server] ${line}\n`);
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.replace(/\/+$/, "");
}

function requireEnv() {
  const base = normalizeBaseUrl(process.env.POSTMD_BASE_URL);
  const key = process.env.POSTMD_API_KEY;
  if (!base || !key) {
    process.stderr.write(
      "postmd-mcp-server: set POSTMD_BASE_URL and POSTMD_API_KEY\n"
    );
    process.exit(1);
  }
  return { base, key };
}

function textOk(text) {
  return { content: [{ type: "text", text }] };
}

function textErr(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function agentFetch({ base, key }, path, init = {}) {
  const url = `${base}/api/agent/v1${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  try {
    const res = await fetch(url, { ...init, headers });
    const ct = res.headers.get("content-type") || "";
    let bodyText = await res.text();
    if (ct.includes("application/json")) {
      try {
        return { status: res.status, json: JSON.parse(bodyText), bodyText };
      } catch {
        return { status: res.status, json: null, bodyText };
      }
    }
    return { status: res.status, json: null, bodyText };
  } catch (e) {
    const diag = formatNetworkError(e);
    debugStderr(`fetch ${safeUrlForLog(url)} → ${diag}`);
    return { status: 0, json: null, bodyText: "", networkError: diag };
  }
}

/** Read UTF-8 text from a path on the host running this MCP server (not remote HTTP). */
async function readLocalMarkdownFile(filePath) {
  const raw = String(filePath ?? "").trim();
  if (!raw) throw new Error("filePath is required");
  const resolved = path.resolve(raw);
  const st = await fs.stat(resolved);
  if (!st.isFile()) throw new Error(`Not a regular file: ${resolved}`);
  const buf = await fs.readFile(resolved);
  return {
    text: buf.toString("utf8"),
    suggestedName: path.basename(resolved),
  };
}

async function sendDocumentCreate(ctx, a, markdown) {
  const form = new FormData();
  const fn = a.fileName || "document.md";
  const blob = new Blob([String(markdown)], { type: "text/markdown" });
  form.append("file", blob, fn);
  form.append("title", String(a.title));
  if (a.password != null) form.append("password", String(a.password));
  if (a.shareEndDate != null) form.append("shareEndDate", String(a.shareEndDate));
  if (a.viewerStyle != null) form.append("viewerStyle", String(a.viewerStyle));
  if (a.groupId != null) form.append("groupId", String(a.groupId));
  const r = await agentFetch(ctx, "/documents", {
    method: "POST",
    body: form,
  });
  if (r.networkError) return textErr(`Request failed: ${r.networkError}`);
  if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
  return textOk(JSON.stringify(r.json, null, 2));
}

async function sendDocumentUpdate(ctx, a, markdown) {
  const form = new FormData();
  form.append("title", String(a.title));
  if (a.password != null) form.append("password", String(a.password));
  if (a.shareEndDate != null) form.append("shareEndDate", String(a.shareEndDate));
  if (a.viewerStyle != null) form.append("viewerStyle", String(a.viewerStyle));
  if (markdown != null) {
    const blob = new Blob([String(markdown)], { type: "text/markdown" });
    form.append("file", blob, a.fileName || "document.md");
  }
  const r = await agentFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/update`, {
    method: "POST",
    body: form,
  });
  if (r.networkError) return textErr(`Request failed: ${r.networkError}`);
  if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
  return textOk(JSON.stringify(r.json, null, 2));
}

const TOOL_DEFS = [
  {
    name: "postmd_list_groups",
    description:
      "List groups the API key can access. Scope: groups:read",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "postmd_list_group_documents",
    description:
      "List documents in a group. Scopes: groups:read, documents:read",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "number", description: "Group id" },
      },
      required: ["groupId"],
    },
  },
  {
    name: "postmd_get_document",
    description: "Get document metadata by docCode. Scope: documents:read",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
      },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_get_document_raw",
    description:
      "Get Markdown source. Scope: documents:read. Optional password for protected docs.",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        password: { type: "string", description: "Plain document password if set" },
      },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_create_document",
    description:
      "Create a new PostMD document (multipart upload to the Agent API). Scope: documents:write. Required: title, markdown.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: {
          type: "string",
          description:
            "Full Markdown document as one UTF-8 string (entire source, not a summary).",
        },
        fileName: { type: "string", default: "document.md" },
        password: { type: "string" },
        shareEndDate: { type: "string" },
        viewerStyle: { type: "string" },
        groupId: { type: "number" },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: "postmd_create_document_from_file",
    description:
      "Create a new PostMD document; this process reads the Markdown from `filePath` on the local filesystem (same API as postmd_create_document). Scope: documents:write. Required: filePath, title.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description:
            "Path to the file on the MCP server host; read as UTF-8. Prefer an absolute path.",
        },
        title: { type: "string" },
        fileName: {
          type: "string",
          description:
            "Multipart filename for the upload; defaults to the basename of filePath.",
        },
        password: { type: "string" },
        shareEndDate: { type: "string" },
        viewerStyle: { type: "string" },
        groupId: { type: "number" },
      },
      required: ["filePath", "title"],
    },
  },
  {
    name: "postmd_update_document",
    description:
      "Update a PostMD document (metadata and/or file body). Scope: documents:write. Required: docCode, title. Include markdown to replace the stored Markdown; omit markdown to change metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        title: { type: "string" },
        password: { type: "string" },
        shareEndDate: { type: "string" },
        viewerStyle: { type: "string" },
        markdown: {
          type: "string",
          description:
            "Full new Markdown body as one UTF-8 string when replacing content. Omit if only metadata changes.",
        },
        fileName: { type: "string", default: "document.md" },
      },
      required: ["docCode", "title"],
    },
  },
  {
    name: "postmd_update_document_from_file",
    description:
      "Update a PostMD document’s Markdown from a local file; this process reads `filePath` (same API as postmd_update_document with a new body). Scope: documents:write. Required: filePath, docCode, title.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description:
            "Path to the file on the MCP server host; read as UTF-8. Prefer an absolute path.",
        },
        docCode: { type: "string" },
        title: { type: "string" },
        fileName: {
          type: "string",
          description:
            "Multipart filename for the upload; defaults to the basename of filePath.",
        },
        password: { type: "string" },
        shareEndDate: { type: "string" },
        viewerStyle: { type: "string" },
      },
      required: ["filePath", "docCode", "title"],
    },
  },
  {
    name: "postmd_delete_document",
    description: "Logical delete document. Scope: documents:write",
    inputSchema: {
      type: "object",
      properties: { docCode: { type: "string" } },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_create_group",
    description: "Create group. Scope: groups:write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        groupCode: { type: "string" },
        password: { type: "string" },
        shareEndDate: { type: "string" },
      },
      required: ["name", "groupCode"],
    },
  },
  {
    name: "postmd_update_group",
    description: "Update group. Scope: groups:write",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "number" },
        name: { type: "string" },
        password: { type: "string" },
        shareEndDate: { type: "string" },
      },
      required: ["groupId", "name"],
    },
  },
];

async function runTool(ctx, name, args) {
  const a = args && typeof args === "object" ? args : {};

  switch (name) {
    case "postmd_list_groups": {
      const r = await agentFetch(ctx, "/groups");
      if (r.networkError)
        return textErr(`Request failed: ${r.networkError}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_list_group_documents": {
      const gid = a.groupId;
      const r = await agentFetch(ctx, `/groups/${gid}/documents`);
      if (r.networkError)
        return textErr(`Request failed: ${r.networkError}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_get_document": {
      const r = await agentFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}`);
      if (r.networkError)
        return textErr(`Request failed: ${r.networkError}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_get_document_raw": {
      const url = `${ctx.base}/api/agent/v1/documents/${encodeURIComponent(a.docCode)}/raw`;
      const headers = { Authorization: `Bearer ${ctx.key}` };
      if (a.password) headers["X-Document-Password"] = String(a.password);
      try {
        const res = await fetch(url, { headers });
        const t = await res.text();
        if (!res.ok) return textErr(`HTTP ${res.status}: ${t}`);
        return textOk(t);
      } catch (e) {
        const diag = formatNetworkError(e);
        debugStderr(`fetch ${safeUrlForLog(url)} → ${diag}`);
        return textErr(`Request failed: ${diag}`);
      }
    }
    case "postmd_create_document": {
      return await sendDocumentCreate(ctx, a, a.markdown);
    }
    case "postmd_create_document_from_file": {
      try {
        const { filePath, ...rest } = a;
        const { text, suggestedName } = await readLocalMarkdownFile(filePath);
        const payload = { ...rest, fileName: rest.fileName ?? suggestedName };
        return await sendDocumentCreate(ctx, payload, text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return textErr(msg);
      }
    }
    case "postmd_update_document": {
      return await sendDocumentUpdate(ctx, a, a.markdown);
    }
    case "postmd_update_document_from_file": {
      try {
        const { filePath, ...rest } = a;
        const { text, suggestedName } = await readLocalMarkdownFile(filePath);
        const payload = { ...rest, fileName: rest.fileName ?? suggestedName };
        return await sendDocumentUpdate(ctx, payload, text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return textErr(msg);
      }
    }
    case "postmd_delete_document": {
      const r = await agentFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/delete`, {
        method: "POST",
      });
      if (r.networkError)
        return textErr(`Request failed: ${r.networkError}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_create_group": {
      const body = Object.fromEntries(
        Object.entries({
          name: a.name,
          groupCode: a.groupCode,
          password: a.password,
          shareEndDate: a.shareEndDate,
        }).filter(([, v]) => v !== undefined)
      );
      const r = await agentFetch(ctx, "/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.networkError)
        return textErr(`Request failed: ${r.networkError}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_update_group": {
      const body = Object.fromEntries(
        Object.entries({
          name: a.name,
          password: a.password,
          shareEndDate: a.shareEndDate,
        }).filter(([, v]) => v !== undefined)
      );
      const r = await agentFetch(ctx, `/groups/${a.groupId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.networkError)
        return textErr(`Request failed: ${r.networkError}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    default:
      return textErr(`Unknown tool: ${name}`);
  }
}

async function main() {
  const ctx = requireEnv();
  if (isDebug()) {
    try {
      const u = new URL(ctx.base);
      debugStderr(
        `debug on | API origin: ${u.protocol}//${u.host} (path /api/agent/v1/...)`
      );
    } catch {
      debugStderr("debug on | POSTMD_BASE_URL is not a valid URL");
    }
  }

  const server = new Server(
    {
      name: "postmd-mcp-server",
      version: "1.0.0",
      instructions: SERVER_INSTRUCTIONS,
    },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments;
    try {
      return await runTool(ctx, name, args);
    } catch (e) {
      const msg = formatNetworkError(e);
      debugStderr(`tool ${name} threw: ${msg}`);
      return textErr(msg);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
  process.exit(1);
});
