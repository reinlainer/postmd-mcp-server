/**
 * 로컬 미리보기 - 파일을 올리지 않고 뷰어에서 보게 한다.
 *
 * 브라우저는 사용자가 직접 고른 파일만 읽는다. 에이전트가 만든 파일을 사람 손 없이 뷰어에
 * 올리려면 이 프로세스가 그 파일을 이 컴퓨터 안(127.0.0.1)에서 HTTP 로 내주고, 뷰어가
 * `/local-viewer?src=<그 주소>` 로 받아 읽는 길밖에 없다. 파일은 서버에 올라가지 않는다.
 *
 * 크롬은 공개 사이트(postmd)가 이 컴퓨터에 접근할 때 "로컬 네트워크 접근" 을 한 번 묻는다.
 * 사용자가 허용하면 그 뒤로는 묻지 않는다. 사전 요청(preflight)은 오지 않으므로 평범한
 * CORS 헤더만 있으면 된다 - 크롬 153 에서 확인했다.
 *
 * 서버는 이 프로세스가 사는 동안만 산다. 에이전트가 끝나면 함께 사라지고, 뷰어는 마지막으로
 * 받은 내용을 그대로 두고 연결이 끊겼다고 알린다.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawn } from "node:child_process";

/** 내주는 파일. 토큰 → { filePath, name }. 같은 파일은 같은 토큰을 다시 쓴다. */
const served = new Map();
/** 파일 경로 → 토큰. 같은 파일을 두 번 걸어도 주소가 바뀌지 않게 한다. */
const tokenByPath = new Map();

let server = null;
let listening = null;

function corsHeaders(origin, allowedOrigin) {
  // 뷰어의 출처에만 답한다. 다른 사이트가 이 주소를 읽어 가지 못하게 하려는 것이다.
  const allow = origin && origin === allowedOrigin ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since",
    "Access-Control-Expose-Headers": "ETag, Last-Modified",
    Vary: "Origin",
    "Cache-Control": "no-cache",
  };
}

async function handle(req, res, allowedOrigin) {
  const headers = corsHeaders(req.headers.origin, allowedOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, headers);
    return res.end();
  }

  // 주소는 /<토큰>/<파일이름>. 이름은 뷰어가 제목에 쓰라고 붙인 것이라 검사에 쓰지 않는다.
  const [, token] = (req.url || "").split("/");
  const entry = served.get(token);
  if (!entry) {
    res.writeHead(404, headers);
    return res.end();
  }

  let stat;
  try {
    stat = await fs.stat(entry.filePath);
  } catch {
    // 에이전트가 파일을 지웠거나 이름을 바꿨다. 뷰어는 이 상태를 따로 알린다.
    res.writeHead(404, headers);
    return res.end();
  }

  const etag = `"${stat.mtimeMs}-${stat.size}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const body = await fs.readFile(entry.filePath);
  res.writeHead(200, {
    ...headers,
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Length": body.length,
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** 서버를 띄운다. 이미 떠 있으면 그것을 쓴다. 포트는 비어 있는 것을 받는다. */
function ensureServer(allowedOrigin) {
  if (listening) return listening;
  server = http.createServer((req, res) => {
    handle(req, res, allowedOrigin).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // 이 프로세스가 죽으면 서버도 죽는다. 서버 때문에 프로세스가 남아 있어서는 안 된다.
  server.unref();
  listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  return listening;
}

/**
 * 파일을 내주고 그 주소를 돌려준다.
 *
 * @param filePath  이 컴퓨터의 .md 파일
 * @param allowedOrigin  뷰어의 출처. 이 출처의 요청에만 답한다
 * @returns { fileUrl, name }
 */
export async function servePreviewFile(filePath, allowedOrigin) {
  const resolved = path.resolve(String(filePath ?? "").trim());
  if (!resolved) throw new Error("filePath is required");
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${resolved}`);

  const port = await ensureServer(allowedOrigin);
  let token = tokenByPath.get(resolved);
  if (!token) {
    token = crypto.randomBytes(12).toString("hex");
    tokenByPath.set(resolved, token);
  }
  const name = path.basename(resolved);
  served.set(token, { filePath: resolved, name });

  return { fileUrl: `http://127.0.0.1:${port}/${token}/${encodeURIComponent(name)}`, name };
}

/**
 * 기본 브라우저로 연다. 못 열어도 오류로 치지 않는다 - 주소는 어차피 돌려준다.
 *
 * @returns 열기를 시도했으면 true
 */
export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 뷰어 주소. `doc` 을 주면 업로드 버튼이 그 문서의 교체로 시작한다. */
export function viewerUrl(base, fileUrl, docCode) {
  const url = new URL("/local-viewer", base);
  url.searchParams.set("src", fileUrl);
  if (docCode) url.searchParams.set("doc", String(docCode));
  return url.toString();
}
