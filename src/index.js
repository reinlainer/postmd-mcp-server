#!/usr/bin/env node
/**
 * PostMD Agent API — MCP stdio server
 * Env: POSTMD_BASE_URL, POSTMD_API_KEY (또는 프로젝트 루트 .env)
 */
import "./env.js";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
      "Create/upload a document (multipart). Scope: documents:write",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: { type: "string", description: "File body as UTF-8" },
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
    name: "postmd_update_document",
    description: "Update document. Scope: documents:write",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        title: { type: "string" },
        password: { type: "string" },
        shareEndDate: { type: "string" },
        viewerStyle: { type: "string" },
        markdown: { type: "string", description: "If set, sent as new file body" },
        fileName: { type: "string", default: "document.md" },
      },
      required: ["docCode", "title"],
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
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_list_group_documents": {
      const gid = a.groupId;
      const r = await agentFetch(ctx, `/groups/${gid}/documents`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_get_document": {
      const r = await agentFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}`);
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_get_document_raw": {
      const url = `${ctx.base}/api/agent/v1/documents/${encodeURIComponent(a.docCode)}/raw`;
      const headers = { Authorization: `Bearer ${ctx.key}` };
      if (a.password) headers["X-Document-Password"] = String(a.password);
      const res = await fetch(url, { headers });
      const t = await res.text();
      if (!res.ok) return textErr(`HTTP ${res.status}: ${t}`);
      return textOk(t);
    }
    case "postmd_create_document": {
      const form = new FormData();
      const fn = a.fileName || "document.md";
      const blob = new Blob([String(a.markdown)], { type: "text/markdown" });
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
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_update_document": {
      const form = new FormData();
      form.append("title", String(a.title));
      if (a.password != null) form.append("password", String(a.password));
      if (a.shareEndDate != null) form.append("shareEndDate", String(a.shareEndDate));
      if (a.viewerStyle != null) form.append("viewerStyle", String(a.viewerStyle));
      if (a.markdown != null) {
        const blob = new Blob([String(a.markdown)], { type: "text/markdown" });
        form.append("file", blob, a.fileName || "document.md");
      }
      const r = await agentFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/update`, {
        method: "POST",
        body: form,
      });
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    case "postmd_delete_document": {
      const r = await agentFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/delete`, {
        method: "POST",
      });
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
      if (!r.json) return textErr(`HTTP ${r.status}: ${r.bodyText}`);
      return textOk(JSON.stringify(r.json, null, 2));
    }
    default:
      return textErr(`Unknown tool: ${name}`);
  }
}

async function main() {
  const ctx = requireEnv();

  const server = new Server(
    { name: "postmd-mcp-server", version: "1.0.0" },
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
      const msg = e instanceof Error ? e.message : String(e);
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
