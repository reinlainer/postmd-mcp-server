#!/usr/bin/env node
/**
 * PostMD 공개 API(/api/v1) — MCP stdio 서버.
 *
 * 필수 환경변수는 없다. POSTMD_BASE_URL 이 없으면 운영(https://postmd.turink.com)을
 * 부르고, POSTMD_API_KEY 가 없으면 발행과 읽기만 할 수 있다 — 그것만으로도 PostMD 의
 * 기본 쓰임은 다 된다. 문서 관리(수정·삭제)·첨부·그룹에는 키가 필요하며, 키 없이
 * 그런 도구를 부르면 어느 스코프가 왜 필요한지 알려 준다.
 *
 * 도구 설명과 오류 문구는 영어다. 이 문장들은 사람이 아니라 에이전트가 읽는다.
 */
import "./env.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "2.0.0";

/** 기본은 운영이다. 대부분의 사용자는 설정 없이 바로 쓰면 된다. */
const DEFAULT_BASE_URL = "https://postmd.turink.com";

/** initialize 때 클라이언트에 전달되어, 모델이 도구를 고르기 전에 읽는다. */
const SERVER_INSTRUCTIONS =
  "PostMD publishes Markdown as web pages. Use the postmd_* tools instead of calling " +
  "the HTTP API directly. Creating a document needs no API key; updating, deleting, " +
  "attachments and groups need POSTMD_API_KEY with the matching scope. Pass the full " +
  "Markdown in `markdown`, or pass a local `filePath` so this server reads the file " +
  "itself. A successful create returns data.shareUrl — hand that URL to people.";

function isDebug() {
  const v = process.env.POSTMD_DEBUG;
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function debugStderr(line) {
  if (isDebug()) process.stderr.write(`[postmd-mcp-server] ${line}\n`);
}

/** 로그에는 호스트와 경로만. 쿼리에 비밀이 실릴 수 있다. */
function safeUrlForLog(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/** fetch·TLS·DNS 실패의 message·cause·code 를 한 줄로 편다. */
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

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return "";
  return url.trim().replace(/\/+$/, "");
}

function resolveConfig() {
  const base = normalizeBaseUrl(process.env.POSTMD_BASE_URL) || DEFAULT_BASE_URL;
  const key = (process.env.POSTMD_API_KEY || "").trim() || null;
  return { base, key };
}

function textOk(text) {
  return { content: [{ type: "text", text }] };
}

function textErr(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 키가 필요한 도구의 문지기. 키가 없으면 네트워크에 나가지 않고 여기서 알려 준다. */
function missingKey(ctx, scopes) {
  if (ctx.key) return null;
  return textErr(
    `This tool requires an API key with scope ${scopes}. ` +
      `Set POSTMD_API_KEY — a signed-in member creates keys at ${ctx.base}/account.`
  );
}

function truncate(text, max = 2000) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars total)` : s;
}

/**
 * /api/v1 호출. 키가 있으면 실어 보낸다 — 익명 발행 엔드포인트도 키를 받으면
 * 그 회원 소유로 만들어 주므로, 있는 키를 숨길 이유가 없다.
 */
async function apiFetch(ctx, apiPath, init = {}) {
  const url = `${ctx.base}/api/v1${apiPath}`;
  const headers = new Headers(init.headers);
  if (ctx.key) headers.set("Authorization", `Bearer ${ctx.key}`);
  try {
    const res = await fetch(url, { ...init, headers });
    const ct = res.headers.get("content-type") || "";
    const bodyText = await res.text();
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

/**
 * 응답 봉투를 도구 결과로 바꾼다.
 *
 * API 는 실패도 JSON 봉투로 준다. HTTP 상태가 아니라 resultCode 로 갈라야 하고,
 * 실패는 isError 로 표시해야 에이전트가 성공으로 오독하지 않는다 — 예전 서버는
 * 오류 봉투를 성공처럼 돌려주는 문제가 있었다.
 */
function fromEnvelope(r) {
  if (r.networkError) return textErr(`Request failed: ${r.networkError}`);
  if (!r.json) return textErr(`HTTP ${r.status}: ${truncate(r.bodyText)}`);
  const text = JSON.stringify(r.json, null, 2);
  return r.json.resultCode === "200" ? textOk(text) : { ...textErr(text) };
}

function query(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** 이 서버가 도는 기기의 파일을 읽는다. 원격 경로가 아니다. */
async function readLocalFile(filePath) {
  const raw = String(filePath ?? "").trim();
  if (!raw) throw new Error("filePath is required");
  const resolved = path.resolve(raw);
  const st = await fs.stat(resolved);
  if (!st.isFile()) throw new Error(`Not a regular file: ${resolved}`);
  return { buffer: await fs.readFile(resolved), suggestedName: path.basename(resolved) };
}

/** 첨부는 서버가 확장자로 받아 준다. Content-Type 은 예의상 맞춰 보낸다. */
const ATTACHMENT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
};

/** 만든 문서에는 나눠 줄 주소를 붙여 준다. 에이전트의 다음 행동이 바로 그것이다. */
function addShareUrl(ctx, data) {
  if (data && typeof data.docCode === "string" && data.docCode) {
    data.shareUrl = `${ctx.base}/share/${encodeURIComponent(data.docCode)}`;
  }
}

function documentForm(a, markdownBuffer) {
  const form = new FormData();
  if (markdownBuffer != null) {
    const fileName = a.fileName || "document.md";
    form.append("file", new Blob([markdownBuffer], { type: "text/markdown" }), fileName);
  }
  if (a.title != null) form.append("title", String(a.title));
  if (a.password != null) form.append("password", String(a.password));
  if (a.shareEndDate != null) form.append("shareEndDate", String(a.shareEndDate));
  if (a.viewerStyle != null) form.append("viewerStyle", String(a.viewerStyle));
  return form;
}

async function createDocument(ctx, a, markdownBuffer) {
  const form = documentForm(a, markdownBuffer);
  if (a.groupId != null) form.append("groupId", String(a.groupId));
  const r = await apiFetch(ctx, "/documents", { method: "POST", body: form });
  if (r.json?.resultCode === "200") addShareUrl(ctx, r.json.data);
  return fromEnvelope(r);
}

async function updateDocument(ctx, a, markdownBuffer) {
  const form = documentForm(a, markdownBuffer);
  if (a.clearPassword === true) form.append("clearPassword", "true");
  if (a.clearShareEndDate === true) form.append("clearShareEndDate", "true");
  if ([...form.keys()].length === 0) {
    return textErr("Nothing to update: pass new markdown, or at least one metadata field.");
  }
  const r = await apiFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/update`, {
    method: "POST",
    body: form,
  });
  return fromEnvelope(r);
}

/** 문서 메타데이터 공통 속성. 만들기·고치기 스키마가 나눠 쓴다. */
const DOC_META_PROPS = {
  password: { type: "string", description: "Readers must supply this password to see the content." },
  shareEndDate: {
    type: "string",
    description: "yyyyMMdd. The document stops being served after this date. Omit for no end date.",
  },
  viewerStyle: {
    type: "string",
    description:
      "Viewer theme: readable (default), github, minimal, report, pamphlet or dark. Unknown values fall back to readable.",
  },
};

const TOOL_DEFS = [
  {
    name: "postmd_create_document",
    description:
      "Publish Markdown as a PostMD web page. No API key required — anyone can publish. " +
      "Returns docCode and data.shareUrl; hand shareUrl to people. With an API key the " +
      "document belongs to that member and can be updated later; groupId files it into " +
      "that group instead of the default one (key with documents:write).",
    inputSchema: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description: "Full Markdown document as one UTF-8 string (the entire source, not a summary).",
        },
        title: {
          type: "string",
          description: "Shown in the viewer and link previews. Defaults to fileName without .md.",
        },
        fileName: { type: "string", description: "Upload filename, must end in .md. Default document.md." },
        ...DOC_META_PROPS,
        groupId: { type: "number", description: "File the document in this group instead of the default group (needs an API key)." },
      },
      required: ["markdown"],
    },
  },
  {
    name: "postmd_create_document_from_file",
    description:
      "Same as postmd_create_document, but reads the Markdown from filePath on the machine " +
      "running this MCP server — use it for large files instead of pasting the body.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Path to a .md file on the MCP server host, read as UTF-8. Prefer an absolute path.",
        },
        title: { type: "string", description: "Defaults to the file name without .md." },
        fileName: { type: "string", description: "Upload filename. Defaults to the basename of filePath." },
        ...DOC_META_PROPS,
        groupId: { type: "number", description: "File the document in this group instead of the default group (needs an API key)." },
      },
      required: ["filePath"],
    },
  },
  {
    name: "postmd_create_documents_from_files",
    description:
      "Publish several .md files in one call (bulk upload). Requires an API key with " +
      "documents:write. The outer resultCode is 200 even if some files failed — check " +
      "data.succeeded and each entry in data.results.",
    inputSchema: {
      type: "object",
      properties: {
        filePaths: {
          type: "array",
          items: { type: "string" },
          description: "Paths to .md files on the MCP server host. Each becomes its own document.",
        },
        ...DOC_META_PROPS,
        groupId: { type: "number", description: "File every document in this group instead of the default group." },
      },
      required: ["filePaths"],
    },
  },
  {
    name: "postmd_get_document",
    description:
      "Get document metadata by docCode: title, fileName, hasPassword, shareEndDate, " +
      "viewerStyle, timestamps. Public — no API key needed. Content is not included; " +
      "use postmd_get_document_raw for the Markdown source.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { docCode: { type: "string", description: "Document code, e.g. P-123-456-789." } },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_get_document_raw",
    description:
      "Get the stored Markdown source of a document. Public — no API key needed. " +
      "Password-protected documents need `password`; expired documents cannot be read.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        password: { type: "string", description: "Plain document password, if the document has one." },
      },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_update_document",
    description:
      "Update a document you own. Requires an API key with documents:write. Include " +
      "`markdown` to replace the stored content; any metadata field replaces that field. " +
      "clearPassword / clearShareEndDate remove the password / end date.",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        markdown: {
          type: "string",
          description: "Full new Markdown body as one UTF-8 string. Omit if only metadata changes.",
        },
        title: { type: "string" },
        fileName: { type: "string", description: "Upload filename when replacing content. Default document.md." },
        ...DOC_META_PROPS,
        clearPassword: { type: "boolean", description: "true removes the password." },
        clearShareEndDate: { type: "boolean", description: "true removes the end date, making sharing open-ended." },
      },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_update_document_from_file",
    description:
      "Same as postmd_update_document, but reads the new Markdown from filePath on the " +
      "machine running this MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        filePath: {
          type: "string",
          description: "Path to a .md file on the MCP server host, read as UTF-8. Prefer an absolute path.",
        },
        title: { type: "string" },
        fileName: { type: "string", description: "Upload filename. Defaults to the basename of filePath." },
        ...DOC_META_PROPS,
        clearPassword: { type: "boolean", description: "true removes the password." },
        clearShareEndDate: { type: "boolean", description: "true removes the end date, making sharing open-ended." },
      },
      required: ["docCode", "filePath"],
    },
  },
  {
    name: "postmd_delete_document",
    description:
      "Delete a document you own (recoverable for 30 days, then purged). Requires an API " +
      "key with documents:write.",
    inputSchema: {
      type: "object",
      properties: { docCode: { type: "string" } },
      required: ["docCode"],
    },
  },
  {
    name: "postmd_upload_attachment",
    description:
      "Upload an image or PDF to reference from a document. Requires an API key with " +
      "documents:write. Allowed types: png, jpg, jpeg, gif, webp, svg, bmp, pdf. Use the " +
      "returned data.url as the image/link target in your Markdown, then publish the " +
      "Markdown with postmd_create_document.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Path to the file on the MCP server host. Prefer an absolute path.",
        },
        fileName: { type: "string", description: "Upload filename. Defaults to the basename of filePath." },
      },
      required: ["filePath"],
    },
  },
  {
    name: "postmd_list_groups",
    description: "List groups the key's member belongs to. Requires an API key with groups:read. Paged.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "1-based page number." },
        size: { type: "number", description: "Items per page." },
      },
      required: [],
    },
  },
  {
    name: "postmd_list_group_documents",
    description:
      "List documents in a group. Requires an API key with groups:read and documents:read. " +
      "Paged; q searches title and file name (substring, case-insensitive).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "number" },
        folderId: { type: "number", description: "Only documents filed in this folder." },
        rootOnly: { type: "boolean", description: "true → only documents not in any folder." },
        q: { type: "string", description: "Search text for title and file name." },
        sort: {
          type: "string",
          description: "recent (default), oldest, name, name_desc, created or created_asc.",
        },
        page: { type: "number" },
        size: { type: "number" },
      },
      required: ["groupId"],
    },
  },
  {
    name: "postmd_move_document_to_group",
    description:
      "Move a document you own into a group you can use, optionally into a folder of that " +
      "group. A document belongs to exactly one group, so this replaces its current group. " +
      "Requires an API key with documents:write.",
    inputSchema: {
      type: "object",
      properties: {
        docCode: { type: "string" },
        groupId: { type: "number" },
        folderId: { type: "number", description: "File it into this folder of that group." },
      },
      required: ["docCode", "groupId"],
    },
  },
  {
    name: "postmd_create_group",
    description:
      "Create a group. Requires an API key with groups:write. Documents can then be filed " +
      "into it and members invited from the web app.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        expireDate: { type: "string", description: "yyyyMMdd. The group stops working after this date." },
      },
      required: ["name"],
    },
  },
  {
    name: "postmd_update_group",
    description:
      "Rename a group or change its expiry. Owner only. Requires an API key with " +
      "groups:write. clearExpireDate removes the expiry.",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "number" },
        name: { type: "string" },
        expireDate: { type: "string", description: "yyyyMMdd." },
        clearExpireDate: { type: "boolean", description: "true removes the expiry date." },
      },
      required: ["groupId"],
    },
  },
  {
    name: "postmd_delete_group",
    description:
      "Delete a group. Owner only; the default group cannot be deleted. Documents in it " +
      "are not deleted. Requires an API key with groups:write.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "number" } },
      required: ["groupId"],
    },
  },
];

async function runTool(ctx, name, args) {
  const a = args && typeof args === "object" ? args : {};

  switch (name) {
    case "postmd_create_document": {
      if (typeof a.markdown !== "string" || a.markdown.length === 0) {
        return textErr("markdown is required: the full document source as one string.");
      }
      return await createDocument(ctx, a, a.markdown);
    }
    case "postmd_create_document_from_file": {
      try {
        const { buffer, suggestedName } = await readLocalFile(a.filePath);
        return await createDocument(ctx, { ...a, fileName: a.fileName ?? suggestedName }, buffer);
      } catch (e) {
        return textErr(e instanceof Error ? e.message : String(e));
      }
    }
    case "postmd_create_documents_from_files": {
      const denied = missingKey(ctx, "documents:write");
      if (denied) return denied;
      if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) {
        return textErr("filePaths is required: one path per document.");
      }
      const form = new FormData();
      try {
        for (const p of a.filePaths) {
          const { buffer, suggestedName } = await readLocalFile(p);
          form.append("files", new Blob([buffer], { type: "text/markdown" }), suggestedName);
        }
      } catch (e) {
        return textErr(e instanceof Error ? e.message : String(e));
      }
      if (a.password != null) form.append("password", String(a.password));
      if (a.shareEndDate != null) form.append("shareEndDate", String(a.shareEndDate));
      if (a.viewerStyle != null) form.append("viewerStyle", String(a.viewerStyle));
      if (a.groupId != null) form.append("groupId", String(a.groupId));
      const r = await apiFetch(ctx, "/documents/bulk", { method: "POST", body: form });
      if (r.json?.resultCode === "200" && Array.isArray(r.json.data?.results)) {
        for (const item of r.json.data.results) addShareUrl(ctx, item);
      }
      return fromEnvelope(r);
    }
    case "postmd_get_document": {
      const r = await apiFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/meta`);
      return fromEnvelope(r);
    }
    case "postmd_get_document_raw": {
      const url = `${ctx.base}/api/v1/documents/${encodeURIComponent(a.docCode)}/raw`;
      const headers = {};
      if (ctx.key) headers.Authorization = `Bearer ${ctx.key}`;
      if (a.password) headers["X-Document-Password"] = String(a.password);
      try {
        const res = await fetch(url, { headers });
        const t = await res.text();
        if (!res.ok) return textErr(`HTTP ${res.status}: ${truncate(t)}`);
        return textOk(t);
      } catch (e) {
        const diag = formatNetworkError(e);
        debugStderr(`fetch ${safeUrlForLog(url)} → ${diag}`);
        return textErr(`Request failed: ${diag}`);
      }
    }
    case "postmd_update_document": {
      const denied = missingKey(ctx, "documents:write");
      if (denied) return denied;
      return await updateDocument(ctx, a, a.markdown ?? null);
    }
    case "postmd_update_document_from_file": {
      const denied = missingKey(ctx, "documents:write");
      if (denied) return denied;
      try {
        const { buffer, suggestedName } = await readLocalFile(a.filePath);
        return await updateDocument(ctx, { ...a, fileName: a.fileName ?? suggestedName }, buffer);
      } catch (e) {
        return textErr(e instanceof Error ? e.message : String(e));
      }
    }
    case "postmd_delete_document": {
      const denied = missingKey(ctx, "documents:write");
      if (denied) return denied;
      const r = await apiFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/delete`, {
        method: "POST",
      });
      return fromEnvelope(r);
    }
    case "postmd_upload_attachment": {
      const denied = missingKey(ctx, "documents:write");
      if (denied) return denied;
      try {
        const { buffer, suggestedName } = await readLocalFile(a.filePath);
        const fileName = a.fileName || suggestedName;
        const ext = path.extname(fileName).slice(1).toLowerCase();
        const mime = ATTACHMENT_MIME[ext] || "application/octet-stream";
        const form = new FormData();
        form.append("file", new Blob([buffer], { type: mime }), fileName);
        const r = await apiFetch(ctx, "/documents/uploads", { method: "POST", body: form });
        return fromEnvelope(r);
      } catch (e) {
        return textErr(e instanceof Error ? e.message : String(e));
      }
    }
    case "postmd_list_groups": {
      const denied = missingKey(ctx, "groups:read");
      if (denied) return denied;
      const r = await apiFetch(ctx, `/groups${query({ page: a.page, size: a.size })}`);
      return fromEnvelope(r);
    }
    case "postmd_list_group_documents": {
      const denied = missingKey(ctx, "groups:read and documents:read");
      if (denied) return denied;
      const qs = query({
        folderId: a.folderId,
        rootOnly: a.rootOnly,
        q: a.q,
        sort: a.sort,
        page: a.page,
        size: a.size,
      });
      const r = await apiFetch(ctx, `/groups/${Number(a.groupId)}/documents${qs}`);
      return fromEnvelope(r);
    }
    case "postmd_move_document_to_group": {
      const denied = missingKey(ctx, "documents:write");
      if (denied) return denied;
      const body = { groupId: a.groupId };
      if (a.folderId != null) body.folderId = a.folderId;
      const r = await apiFetch(ctx, `/documents/${encodeURIComponent(a.docCode)}/group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return fromEnvelope(r);
    }
    case "postmd_create_group": {
      const denied = missingKey(ctx, "groups:write");
      if (denied) return denied;
      const body = { name: a.name };
      if (a.expireDate != null) body.expireDate = a.expireDate;
      const r = await apiFetch(ctx, "/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return fromEnvelope(r);
    }
    case "postmd_update_group": {
      const denied = missingKey(ctx, "groups:write");
      if (denied) return denied;
      const body = {};
      if (a.name != null) body.name = a.name;
      if (a.expireDate != null) body.expireDate = a.expireDate;
      if (a.clearExpireDate === true) body.clearExpireDate = true;
      const r = await apiFetch(ctx, `/groups/${Number(a.groupId)}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return fromEnvelope(r);
    }
    case "postmd_delete_group": {
      const denied = missingKey(ctx, "groups:write");
      if (denied) return denied;
      const r = await apiFetch(ctx, `/groups/${Number(a.groupId)}/delete`, { method: "POST" });
      return fromEnvelope(r);
    }
    default:
      return textErr(`Unknown tool: ${name}`);
  }
}

async function main() {
  const ctx = resolveConfig();
  debugStderr(
    `debug on | base ${ctx.base} | key ${ctx.key ? "set" : "not set (publish/read only)"}`
  );

  const server = new Server(
    { name: "postmd-mcp-server", version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await runTool(ctx, name, args);
    } catch (e) {
      const msg = formatNetworkError(e);
      debugStderr(`tool ${name} threw: ${msg}`);
      return textErr(msg);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
  process.exit(1);
});
