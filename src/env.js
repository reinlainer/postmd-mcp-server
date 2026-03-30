/**
 * 이 패키지 루트(`package.json`과 같은 디렉터리)의 `.env`를 로드한다 (실행 cwd와 무관).
 * 이미 설정된 process.env 값은 덮어쓰지 않는다.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(root, ".env") });
