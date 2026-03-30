# postmd-mcp-server

PostMD Agent API (`/api/agent/v1`)를 MCP(stdio)로 노출하는 서버.

**위치:** PostMD 모노레포의 `packages/postmd-mcp-server/`.

- **런타임:** Node.js 20 LTS (package.json `engines` 참고)
- **의존성:** `@modelcontextprotocol/sdk` 1.0.4 (고정)

## 환경 변수

| 변수 | 설명 |
|------|------|
| `POSTMD_BASE_URL` | PostMD 루트 URL (끝 `/` 없음). 예: `http://localhost:8080` |
| `POSTMD_API_KEY` | `/account`에서 발급한 `pmk_...` |

**설정 방법 (둘 중 하나 또는 병행)**

1. **`.env` 파일** — 이 패키지 디렉터리에 `.env.example`을 복사해 `.env`로 두고 값을 채운다. `src/env.js`가 기동 시 로드한다(이미 셸·Cursor `env`에 있는 값은 덮어쓰지 않음).
2. **셸 / Cursor `mcp.json`의 `env`** — export 또는 MCP 설정으로 넣는다.

## 실행

```bash
cd packages/postmd-mcp-server
cp .env.example .env
# .env 편집 후
node src/index.js
```

또는:

```bash
cd packages/postmd-mcp-server
export POSTMD_BASE_URL=http://localhost:8080
export POSTMD_API_KEY=pmk_...
node src/index.js
```

Cursor는 `command`로 `node`와 `.../packages/postmd-mcp-server/src/index.js`를 지정하고, 변수는 **`.env` 또는 `mcp.json`의 `env`** 중 편한 쪽을 쓰면 된다.

### Cursor MCP 설정 위치

| 위치 | 용도 |
|------|------|
| **`~/.cursor/mcp.json`** (전역) | 이 PC에서 여러 워크스페이스에 동일한 MCP를 쓸 때. **로컬 개발 시 권장.** |
| **프로젝트의 `.cursor/mcp.json`** | 그 레포만 다른 설정이 필요할 때. 전역과 **병합**되며, 같은 서버 이름이면 **프로젝트 쪽이 우선**. |

이 레포를 워크스페이스로 열었다면 **`args`와 `envFile`에 `packages/postmd-mcp-server`의 절대 경로**를 넣으면 된다.

전역 예시(`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "PostMD": {
      "type": "stdio",
      "command": "node",
      "args": ["/절대경로/postmd/packages/postmd-mcp-server/src/index.js"],
      "envFile": "/절대경로/postmd/packages/postmd-mcp-server/.env"
    }
  }
}
```

`mcpServers`의 키(`PostMD`)가 Cursor MCP 목록에 보이는 이름이다. `envFile` 대신 `env`에 `POSTMD_BASE_URL`, `POSTMD_API_KEY`를 넣어도 된다. 설정 변경 후에는 Cursor를 완전히 종료했다가 다시 열어야 MCP가 다시 로드되는 경우가 많다.

## 검증 스크립트

PostMD가 떠 있는 상태에서:

```bash
cd packages/postmd-mcp-server
export POSTMD_BASE_URL=...
export POSTMD_API_KEY=...
npm run smoke
```

비밀번호가 있는 그룹·문서를 만들고, raw 조회 후 문서만 삭제한다. (그룹은 Agent API에 삭제 엔드포인트 없음)
