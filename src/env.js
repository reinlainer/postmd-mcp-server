/**
 * 프로젝트 루트의 .env 를 로드한다 (실행 cwd 와 무관).
 * 이미 설정된 process.env 값은 덮어쓰지 않는다.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(root, ".env") });
