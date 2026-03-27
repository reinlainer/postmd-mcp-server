/**
 * PostMD가 떠 있고, POSTMD_BASE_URL · POSTMD_API_KEY 가
 * 환경 또는 프로젝트 루트 .env 에 있는 상태에서 실행.
 */
import "../src/env.js";
import process from "node:process";

function base() {
  const b = (process.env.POSTMD_BASE_URL || "").replace(/\/+$/, "");
  const k = process.env.POSTMD_API_KEY;
  if (!b || !k) {
    console.error("POSTMD_BASE_URL, POSTMD_API_KEY 필요");
    process.exit(1);
  }
  return { b, k };
}

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const t = await res.text();
  let json = null;
  try {
    json = JSON.parse(t);
  } catch {
    /* plain */
  }
  return { res, t, json };
}

async function main() {
  const { b, k } = base();
  const api = `${b}/api/agent/v1`;
  const auth = { Authorization: `Bearer ${k}` };

  const suffix = Date.now();
  const groupCode = `mcp-smoke-${suffix}`;
  const groupName = `MCP smoke ${suffix}`;

  console.log("1) create group (password) …");
  const g1 = await jfetch(`${api}/groups`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: groupName,
      groupCode,
      password: "smoke-group-pass",
    }),
  });
  if (!g1.res.ok || !g1.json || g1.json.resultCode !== "200") {
    console.error("그룹 생성 실패", g1.res.status, g1.t);
    process.exit(1);
  }
  const groupId = g1.json.data?.id;
  if (groupId == null) {
    console.error("응답에 group id 없음", g1.t);
    process.exit(1);
  }

  console.log("2) create document (password) in group …");
  const form = new FormData();
  form.append(
    "file",
    new Blob(["# smoke\n\nhello"], { type: "text/markdown" }),
    "smoke.md"
  );
  form.append("title", "Smoke doc");
  form.append("password", "smoke-doc-pass");
  form.append("groupId", String(groupId));

  const d1 = await jfetch(`${api}/documents`, {
    method: "POST",
    headers: auth,
    body: form,
  });
  if (!d1.res.ok || !d1.json || d1.json.resultCode !== "200") {
    console.error("문서 생성 실패", d1.res.status, d1.t);
    process.exit(1);
  }
  const docCode = d1.json.data?.docCode;
  if (!docCode) {
    console.error("응답에 docCode 없음", d1.t);
    process.exit(1);
  }

  console.log("3) GET raw with X-Document-Password …");
  const r1 = await jfetch(`${api}/documents/${encodeURIComponent(docCode)}/raw`, {
    headers: {
      ...auth,
      "X-Document-Password": "smoke-doc-pass",
    },
  });
  if (!r1.res.ok || !r1.t.includes("hello")) {
    console.error("raw 조회 실패", r1.res.status, r1.t.slice(0, 200));
    process.exit(1);
  }

  console.log("4) delete document …");
  const x1 = await jfetch(
    `${api}/documents/${encodeURIComponent(docCode)}/delete`,
    { method: "POST", headers: auth }
  );
  if (!x1.res.ok || !x1.json || x1.json.resultCode !== "200") {
    console.error("문서 삭제 실패", x1.res.status, x1.t);
    process.exit(1);
  }

  console.log("smoke OK (그룹은 Agent API로 삭제 없음 — 웹에서 필요 시 정리)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
