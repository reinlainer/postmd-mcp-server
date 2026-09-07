#!/usr/bin/env node
/**
 * 원격 진입점. streamable HTTP 로 받는다.
 *
 * 웹에서 도는 클라이언트(ChatGPT, claude.ai)는 로컬 프로세스를 띄우지 못해 stdio 서버에
 * 붙을 수 없다. 그쪽이 요구하는 것은 고정 HTTPS 주소 하나다.
 *
 * 도구는 `server.js` 가 갖고 있고 여기서 여는 것은 그중 자격 증명 없이 되는 다섯 개다
 * (`REMOTE_TOOLS`). 그래서 이 서버에는 인증이 없다.
 *
 * 상태를 두지 않는다(stateless). 요청마다 서버와 전송을 새로 만들고 끝나면 버린다.
 * 도구가 모두 API 한 번 부르고 끝나는 것이라 요청 사이에 이어 둘 것이 없고, 세션을 들면
 * 그때부터 메모리에 남는 것이 생겨 컨테이너를 늘릴 때 붙는 자리가 된다.
 */
import http from "node:http";
import process from "node:process";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, VERSION } from "./server.js";

const PORT = Number(process.env.PORT || process.env.POSTMD_MCP_PORT || 8080);
const MCP_PATH = "/mcp";

/**
 * 본문 상한. 문서 본문이 JSON 안에 실려 오므로 업로드 상한보다 넉넉해야 하지만, 열어
 * 두면 아무나 부르는 자리에서 메모리를 밀어 넣을 수 있다. 실제 문서 크기 판정은 API 가
 * 한다 - 여기는 그 앞의 거친 그물이다.
 */
const MAX_BODY = 8 * 1024 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // 컨테이너와 프록시가 살아 있는지 보는 자리. MCP 와 무관하다.
  if (url.pathname === "/health") {
    return json(res, 200, { status: "ok", version: VERSION });
  }

  if (url.pathname !== MCP_PATH) {
    return json(res, 404, {
      error: `Not found. This server speaks MCP over streamable HTTP at ${MCP_PATH}.`,
    });
  }

  const length = Number(req.headers["content-length"] || 0);
  if (length > MAX_BODY) {
    return json(res, 413, { error: "Request body too large." });
  }

  // 요청 하나에 서버 하나. 끝나면 둘 다 닫아 아무것도 남기지 않는다.
  const server = createMcpServer({ remote: true });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    process.stderr.write(`mcp request failed: ${e instanceof Error ? e.stack : e}\n`);
    if (!res.headersSent) json(res, 500, { error: "Internal error." });
  }
});

httpServer.listen(PORT, () => {
  process.stdout.write(`postmd-mcp-server ${VERSION} — streamable HTTP on :${PORT}${MCP_PATH}\n`);
});
