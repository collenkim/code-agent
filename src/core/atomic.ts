/**
 * 상태 파일을 **완결된 상태로만** 보이게 쓴다.
 *
 * 서버가 여러 요청을 동시에 다루게 되면서 생긴 요구다. `writeFileSync` 는 truncate 후 쓰기라,
 * 쓰는 도중에 읽는 쪽이 절반만 든 JSON 을 본다 — 그러면 `loadSession` 이 파싱에 실패하고,
 * 그 실패는 "세션이 없다"와 구분되지 않아 진행 상태가 통째로 초기화된 것처럼 보인다.
 *
 * 같은 디렉토리에 임시 파일로 쓴 뒤 rename 한다. rename 은 같은 볼륨 안에서 원자적이므로
 * 읽는 쪽은 옛 내용 아니면 새 내용을 보고, 그 사이는 없다. 임시 파일을 같은 디렉토리에 두는
 * 것이 조건이다 — 다른 볼륨으로 건너가면 rename 이 복사가 되어 원자성이 사라진다.
 *
 * 생성물(out/ 의 소스 파일)에는 쓰지 않는다. 그쪽은 한 요청 안에서만 쓰이고 읽히므로
 * 이 비용을 낼 이유가 없다.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

let counter = 0;

/** 같은 디렉토리에 임시로 쓴 뒤 제자리로 옮긴다. 디렉토리는 필요하면 만든다. */
export function writeAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  counter += 1;
  const temp = join(dir, `.${process.pid}-${counter}.tmp`);

  try {
    writeFileSync(temp, content, "utf-8");
    renameSync(temp, path);
  } catch (error) {
    // 임시 파일을 남기면 다음 실행이 그것을 상태 파일로 착각할 이유는 없지만,
    // 쓰레기가 쌓여 디렉토리를 읽는 쪽(list 액션)의 출력이 지저분해진다.
    rmSync(temp, { force: true });
    throw error;
  }
}
