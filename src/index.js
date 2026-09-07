#!/usr/bin/env node
/**
 * stdio 진입점. 쓰는 쪽이 이 프로세스를 직접 띄우는 방식이며 npm 의 bin 이 여기를 가리킨다.
 *
 * 도구와 실행은 `server.js` 에 있다. 여기서는 전송만 고른다 - 원격 진입점(`http.js`)과
 * 같은 도구를 쓰기 위한 분리다.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import process from "node:process";

const server = createMcpServer({ remote: false });

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
  process.exit(1);
});
