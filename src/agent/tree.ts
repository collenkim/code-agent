import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { sha } from "./docs";

/**
 * 굳혀 둔 기준 커밋과 지금 작업 트리의 차이.
 *
 * P5 의 판정은 전부 이 위에 선다 — 계획 밖 변경 대조 · 증거 묶기 · 인계 커밋 대상. 원시값 하나가
 * 여러 자리를 떠받치므로 `git status` 가 아니라 **기준 커밋과의 차이**로 잡는다. 작업 도중 기준
 * 브랜치가 움직여도 흔들리지 않고, 삭제·이름변경까지 잡힌다.
 *
 * git.ts 와 같은 동기 execFileSync 방식이다 — 판정 경로(hook·next)가 동기라 여기서 비동기가 되면
 * 그 위가 전부 물든다.
 */
function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** ref 하나를 그 순간의 커밋으로 굳힌다. 없는 ref 면 undefined */
export function commitOf(repoRoot: string, ref: string): string | undefined {
  try {
    return git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 두 ref 가 갈라진 자리. 이미 있는 작업 브랜치로 되돌아올 때 굳힐 값이다 —
 * 기준 브랜치의 지금 끝을 굳히면 그 사이 기준이 나아간 만큼이 전부 이 작업의 `[D]` 삭제로 잡힌다.
 */
export function mergeBase(repoRoot: string, a: string, b: string): string | undefined {
  try {
    return git(repoRoot, ["merge-base", a, b]).trim() || undefined;
  } catch {
    return undefined;
  }
}

export type ChangeStatus = "A" | "M" | "D" | "R";

export interface Change {
  status: ChangeStatus;
  /** 저장소 기준, `/` 구분 */
  path: string;
}

/**
 * 기준 커밋 대비 바뀐 경로 전부 — 추적 파일의 추가·수정·삭제·이름변경 + 추적되지 않은 새 파일.
 *
 * `.gitignore` 된 파일은 잡히지 않는다. 울타리에 남는 구멍이고, 알고 남기는 것이다 —
 * 무시하라고 선언한 산출물까지 계획 밖 변경으로 잡으면 빌드 한 번에 모든 검증이 막힌다.
 */
export function changedPaths(repoRoot: string, baseCommit: string): Change[] {
  const changes = new Map<string, Change>();
  const put = (status: ChangeStatus, path: string) => {
    if (path !== "") changes.set(path, { status, path });
  };

  for (const line of git(repoRoot, ["diff", "--name-status", "-M", baseCommit, "--"]).split("\n")) {
    const cells = line.replace(/\r$/, "").split("\t");
    const code = (cells[0] ?? "")[0];
    if (!code) continue;
    if (code === "R") {
      // 이름변경은 두 경로를 건드린 것이다 — 옛 이름이 사라진 것도 변경이다
      put("D", cells[1]);
      put("R", cells[2]);
      continue;
    }
    put(code === "A" ? "A" : code === "D" ? "D" : "M", cells[1]);
  }
  for (const line of git(repoRoot, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    put("A", line.replace(/\r$/, "").trim());
  }
  return [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * 계획이 선언한 파일들만의 **부분** 트리 해시 — 통과를 받아 두고 나중에 단언을 지우는 길을 막는다.
 *
 * 전체 변경 집합이 아니라 계획 파일만 담는 것은 의도다. 검증 명령이 `.gitignore` 되지 않은
 * 산출물을 남기면 전체 해시는 매번 달라져 증거가 늘 무효가 되지만, 계획 파일만 보면 "승인받은 것이
 * 그대로인가" 만 남는다. 계획 밖 변경은 해시가 아니라 `changedPaths` 대조가 따로 막는다.
 *
 * 없는 파일은 빈 내용으로 담는다 — 지워서 통과시키는 길이 해시 변화로 드러나게.
 */
export function partialTreeHash(repoRoot: string, paths: string[]): string {
  const entries = [...paths]
    .sort()
    .map((path) => {
      const full = join(repoRoot, path);
      const content = existsSync(full) ? readFileSync(full, "utf-8") : "";
      return `${path}:${sha(content)}`;
    });
  return sha(entries.join("\n"));
}
