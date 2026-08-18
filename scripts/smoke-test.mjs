#!/usr/bin/env node
/**
 * 쓰기 경로를 실제 서버에 대고 한 바퀴 돈다. HTTP 로 직접 부른다 — 여기서 확인하려는
 * 것은 MCP 프로토콜이 아니라 API 계약(경로·필드·봉투)이다.
 *
 * 네 스코프(documents:read/write, groups:read/write)를 모두 가진 키가 필요하다.
 * 그룹 하나와 문서 하나를 만들었다가 끝에 모두 지운다.
 */
import "../src/env.js";

const base = (process.env.POSTMD_BASE_URL || "https://postmd.turink.com").replace(/\/+$/, "");
const key = process.env.POSTMD_API_KEY;
if (!key) {
  console.error("smoke: set POSTMD_API_KEY (scopes: documents:read/write, groups:read/write)");
  process.exit(1);
}

const AUTH = { Authorization: `Bearer ${key}` };
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function callJson(pathname, init = {}) {
  const res = await fetch(`${base}/api/v1${pathname}`, {
    ...init,
    headers: { ...AUTH, ...(init.headers || {}) },
  });
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    /* 봉투가 아니면 text 로 판단한다 */
  }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const PASSWORD = `smoke-${stamp}`;
const MARKER = `smoke marker ${stamp}`;

// 1. 그룹 만들기
const created = await callJson("/groups", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: `mcp smoke ${stamp}` }),
});
check("create group", created.json?.resultCode === "200", created.text);
const groupId = created.json?.data?.groupId;

// 2. 비밀번호 걸린 문서를 그 그룹에 올리기
const form = new FormData();
form.append(
  "file",
  new Blob([`# Smoke\n\n${MARKER}\n`], { type: "text/markdown" }),
  "smoke.md"
);
form.append("title", `mcp smoke ${stamp}`);
form.append("password", PASSWORD);
if (groupId != null) form.append("groupId", String(groupId));
const uploaded = await callJson("/documents", { method: "POST", body: form });
check("create document", uploaded.json?.resultCode === "200", uploaded.text);
const docCode = uploaded.json?.data?.docCode;

if (docCode) {
  // 3. 메타 — 비밀번호가 걸렸다고 말해야 한다
  const meta = await callJson(`/documents/${docCode}/meta`);
  check("meta shows password", meta.json?.data?.hasPassword === true, meta.text);

  // 4. 원문 — 비밀번호 헤더로 열리고, 올린 내용 그대로여야 한다
  const raw = await callJson(`/documents/${docCode}/raw`, {
    headers: { "X-Document-Password": PASSWORD },
  });
  check("raw readable with password", raw.status === 200 && raw.text.includes(MARKER));

  // 5. 고치기 — 제목을 바꾸고 비밀번호를 푼다
  const patch = new FormData();
  patch.append("title", `mcp smoke ${stamp} v2`);
  patch.append("clearPassword", "true");
  const updated = await callJson(`/documents/${docCode}/update`, { method: "POST", body: patch });
  check("update document", updated.json?.resultCode === "200", updated.text);

  const meta2 = await callJson(`/documents/${docCode}/meta`);
  check("password cleared", meta2.json?.data?.hasPassword === false, meta2.text);

  // 6. 그룹 목록에 보이는지
  if (groupId != null) {
    const listed = await callJson(`/groups/${groupId}/documents?q=smoke`);
    const found = (listed.json?.data || []).some((d) => d.docCode === docCode);
    check("document listed in group", found, listed.text);
  }

  // 7. 문서 지우기
  const deleted = await callJson(`/documents/${docCode}/delete`, { method: "POST" });
  check("delete document", deleted.json?.resultCode === "200", deleted.text);
}

// 8. 그룹 지우기 — 예전 Agent API 에는 없어서 손으로 지워야 했던 바로 그것
if (groupId != null) {
  const dropped = await callJson(`/groups/${groupId}/delete`, { method: "POST" });
  check("delete group", dropped.json?.resultCode === "200", dropped.text);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
