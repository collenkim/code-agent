import { readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { decide } from "./hook";
import { Stop } from "./stop";

/**
 * 전용 Read 도구가 없는 호스트용 읽기 경로. 셸 표현식은 실행하지 않는다.
 * 출력은 머리 한 줄(경로 · 줄 범위 / 전체 줄 수)과 `줄번호<TAB>본문`(cat -n 꼴)이다 — 줄마다 JSON 객체로 내면 같은 본문이 1.4~2배가 된다.
 * 뒤에 줄이 남으면 이어 읽을 명령을 마지막 줄에 단다.
 */
export function readProjectFile(root: string, file: string, start = 1, count = 200): string {
  if (!file || !Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 400) {
    throw new Stop("사용법: code-agent read <저장소 파일> [시작 줄] [줄 수 1~400]");
  }
  const base = realpathSync(root), target = realpathSync(resolve(base, file));
  const local = relative(base, target);
  if (isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) throw new Stop("저장소 안의 파일만 읽을 수 있습니다.");
  const denied = decide({ cwd: base, tool_name: "Read", tool_input: { file_path: target } }, base);
  if (denied) throw new Stop(denied);
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Stop("1 MB 이하 일반 텍스트 파일만 읽을 수 있습니다.");
  const text = readFileSync(target, "utf8");
  if (text.includes("\0")) throw new Stop("바이너리 파일은 읽을 수 없습니다.");
  const lines = text.split(/\r?\n/);
  const path = local.replace(/\\/g, "/");
  const shown = lines.slice(start - 1, start - 1 + count);
  const end = start + shown.length - 1;
  return [
    `${path} · ${shown.length ? `${start}-${end}` : "범위 밖"} / 전체 ${lines.length}줄`,
    ...shown.map((line, index) => `${start + index}\t${line}`),
    ...(shown.length && end < lines.length ? [`(이어서: code-agent read ${path} ${end + 1})`] : []),
  ].join("\n");
}
